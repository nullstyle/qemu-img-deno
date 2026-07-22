/**
 * The host/guest wire ABI: how a step script reaches the guest and how its
 * result comes back.
 *
 * Both directions travel on raw block devices rather than a console, a shared
 * folder or a pipe, because a block device is the one channel whose delivery
 * the guest can *verify*: reads are whole sectors, so the frame carries an
 * explicit byte length, and the record is fsynced before `poweroff -f`
 * (`kernel_power_off()` does not sync).
 *
 * The status record exists at all because **qemu's exit code cannot carry the
 * answer** — a clean poweroff, a guest panic under `-no-reboot`, and a step
 * that failed and powered off all exit 0.
 *
 * @module
 */

import { sha256Hex } from "../digest.ts";
import {
  GuestStatusError,
  type GuestStatusFault,
  PayloadFrameError,
} from "./errors.ts";

/** Appliance wire ABI. Bumping this invalidates every appliance identity. */
export const APPLIANCE_ABI = 2;

/** Frame magic. Sector 0 of the payload disk; line 1 of the status record. */
export const FRAME_MAGIC = "QIMG2";

/** The previous frame magic, recognized only so it can be refused by name. */
const LEGACY_FRAME_MAGIC = "QIMG1";

/** Payload framing block size. Block devices reject unaligned reads. */
export const SECTOR = 512;

/** Bytes of the status disk the guest writes and the host reads back. */
export const STATUS_BYTES = 4096;

/** Where the guest was when it stopped. */
export type GuestStage = "abi" | "roles" | "payload" | "ext4" | "step";

/** The stages a guest may report, in the order it passes through them. */
const GUEST_STAGES: readonly GuestStage[] = [
  "abi",
  "roles",
  "payload",
  "ext4",
  "step",
];

/** What the guest reported, parsed from the status disk. */
export interface StepOutcome {
  /** The step script's exit code. */
  readonly code: number;
  /** The stage the guest reached. `"step"` means the script actually ran. */
  readonly stage: GuestStage;
  /** sha256 of everything the step wrote to stdout/stderr; `""` before `"step"`. */
  readonly outputDigest: string;
  /** Nonzero when any unmount under `/mnt` failed — a writeback error. */
  readonly umountRc: number;
  /**
   * `e2fsck -fn` exit code over every filesystem the step declared.
   *
   * `undefined` means **no device was ever declared to check**, which is not
   * rc 0 and must not be read as it. Classify with {@linkcode fsckVerdict}
   * rather than with `?? 0`.
   */
  readonly fsckRc?: number;
  /** Count of `EXT4-fs error` / `I/O error` lines in the guest's dmesg. */
  readonly dmesgErrors: number;
  /** Free-text detail from the guest. */
  readonly detail: string;
}

/** Framing options for {@linkcode framePayload}. */
export interface FramePayloadOptions {
  /** Ties this payload to one boot; the guest refuses a nonce it was not booted with. */
  readonly nonce: string;
  /** Disk size. @default the exact sector-rounded fit */
  readonly sizeBytes?: number;
}

/** What {@linkcode parseStatus} checks the record against. */
export interface ParseStatusExpectation {
  /** The nonce this boot was launched with. */
  readonly nonce: string;
  /**
   * The guest console, attached to any {@linkcode GuestStatusError} raised.
   *
   * Diagnostics only — nothing is validated against it. It is here because
   * every throw below is a case where the record says nothing, so the console
   * is the only evidence left, and the caller has already read it.
   */
  readonly console?: string;
  /** A copy of the console that outlives a failed build, if one was kept. */
  readonly consolePath?: string;
}

/**
 * How a step's filesystem check came out.
 *
 * `"unchecked"` is a third answer, not a synonym for `"clean"`: the guest
 * writes `fsck=-` when the step registered no device at all, and collapsing
 * that into rc 0 reports a filesystem nobody looked at as one that passed.
 */
export type FsckVerdict = "clean" | "failed" | "unchecked";

/**
 * Frame a step script onto the payload disk. Pure.
 *
 * The length is explicit because a block-device read returns whole sectors:
 * without it the guest cannot tell the script's trailing bytes from the NUL
 * padding, and a truncated read would look like a shorter script that
 * succeeded. The nonce is explicit because the status and payload disks are
 * scratch files the caller may reuse — see {@linkcode parseStatus}.
 */
export function framePayload(
  script: string,
  options: FramePayloadOptions,
): Uint8Array {
  const nonce = options.nonce;
  // Whitespace and NUL split the two channels the nonce crosses. The glob
  // metacharacters are here because `/init` parses the cmdline with
  // `for arg in $(cat /proc/cmdline)`, an unquoted expansion that undergoes
  // PATHNAME expansion as well as word splitting — so a nonce carrying `*`
  // is matched against the guest's root directory before it is ever compared.
  if (nonce.length === 0 || /[\s\0*?[\]]/.test(nonce)) {
    throw new PayloadFrameError(
      "nonce",
      `payload nonce ${JSON.stringify(nonce)} is empty or holds whitespace ` +
        "or a glob metacharacter. The guest parses it as a whole line of a " +
        "header sector and compares it to a kernel cmdline token, and " +
        "neither survives a space — while the cmdline is parsed by an " +
        "unquoted expansion, so `*` is expanded against the guest's root " +
        "before the comparison. Derive it with stepNonce().",
    );
  }
  const body = new TextEncoder().encode(script);
  const header = new TextEncoder().encode(
    `${FRAME_MAGIC}\n${body.byteLength}\n${nonce}\n`,
  );
  if (header.byteLength > SECTOR) {
    throw new PayloadFrameError(
      "header",
      `payload header is ${header.byteLength} bytes and sector 0 holds ` +
        `${SECTOR}`,
    );
  }
  // The default is the exact fit so a caller that does not care about disk
  // size never pays for a megabyte of zeros per step.
  const sizeBytes = options.sizeBytes ??
    SECTOR + Math.ceil(body.byteLength / SECTOR) * SECTOR;
  if (SECTOR + body.byteLength > sizeBytes) {
    throw new PayloadFrameError(
      "script",
      `step script is ${body.byteLength} bytes, too large for a ` +
        `${sizeBytes}-byte payload disk`,
    );
  }
  const payload = new Uint8Array(sizeBytes);
  payload.set(header, 0);
  payload.set(body, SECTOR);
  return payload;
}

/**
 * Parse the guest's status record. Throws when absent, malformed, or stale.
 *
 * Every throw here is a case where returning *something* would be worse than
 * failing: an absent record means the guest never reached its epilogue, and a
 * record whose nonce disagrees is a **previous** step's answer sitting on a
 * reused scratch disk. Shape validation alone cannot tell those from a fresh
 * success, which is the whole reason the frame carries a nonce.
 */
export function parseStatus(
  bytes: Uint8Array,
  expect: ParseStatusExpectation,
): StepOutcome {
  // Every throw below hands the console to the error. It is the only evidence
  // that survives a record which says nothing — and in the worst case here,
  // an `/init` that could not resolve its status disk, it is the ONLY
  // evidence there ever was: that path cannot write a record at all.
  const fail = (fault: GuestStatusFault, message: string, field?: string) =>
    new GuestStatusError(fault, message, {
      ...(field === undefined ? {} : { field }),
      ...(expect.console === undefined ? {} : { console: expect.console }),
      ...(expect.consolePath === undefined
        ? {}
        : { consolePath: expect.consolePath }),
    });

  const text = new TextDecoder().decode(bytes).replace(/\0+$/, "");
  const lines = text.split("\n");
  const magic = lines[0];
  if (magic === LEGACY_FRAME_MAGIC) {
    throw fail(
      "legacy",
      "the guest wrote a QIMG1 status record, but this host speaks QIMG2. " +
        "The appliance on disk was built by an older source tree, so its " +
        "/init does not know about the roles, nonce or filesystem checks " +
        "this build depends on — and every layer it produced would be " +
        "published under a key that promises them. Rebuild it: " +
        "deno task appliance --arch=<arch>",
    );
  }
  if (magic !== FRAME_MAGIC) {
    throw fail(
      "absent",
      "the guest wrote no status record (found " +
        `${JSON.stringify(text.slice(0, 40))}). It panicked, hung, or was ` +
        "killed before its epilogue — qemu's own exit code cannot tell you " +
        "which, which is why this record exists.",
    );
  }
  const [, nonce, code, stage, digest, umount, fsck, dmesg, ...rest] = lines;
  if (nonce !== expect.nonce) {
    throw fail(
      "nonce",
      `status record is for nonce ${JSON.stringify(nonce ?? "")}, not ` +
        `${JSON.stringify(expect.nonce)}. This is a PREVIOUS step's answer ` +
        "left on a reused status disk — its shape is perfectly valid, which " +
        "is exactly why the nonce exists. Give each step its own scratch dir.",
    );
  }
  if (!/^\d+$/.test(code ?? "")) {
    throw fail("code", `status record has a malformed exit code: ${code}`);
  }
  if (!GUEST_STAGES.includes(stage as GuestStage)) {
    throw fail(
      "stage",
      `status record names an unknown stage ${JSON.stringify(stage ?? "")}; ` +
        `this host knows ${GUEST_STAGES.join(", ")}. Rebuild the appliance.`,
    );
  }
  return {
    code: Number(code),
    stage: stage as GuestStage,
    outputDigest: digest === "-" ? "" : digest ?? "",
    umountRc: strictField(umount, "umountRc", fail),
    // `-` is "no filesystem was declared", which is not the same as rc 0 and
    // must not be flattened into it: a step that never named a device to
    // check is unchecked, not checked-and-clean.
    ...(fsck === "-" ? {} : { fsckRc: strictField(fsck, "fsckRc", fail) }),
    dmesgErrors: strictField(dmesg, "dmesgErrors", fail),
    detail: (rest[0] ?? "").trim(),
  };
}

/**
 * Read one numeric status field, refusing anything that is not a number.
 *
 * These three fields exist solely to report that the guest's own script
 * returned 0 while the filesystem underneath it did not, so defaulting a
 * missing or garbled one to the clean value would fail open in exactly the
 * case they were added to catch — a record truncated by a poweroff racing its
 * `dd conv=fsync` would read as a successful, fsck-clean step, and `build()`
 * would publish the layer for every descendant to cache against. `rc` and
 * `stage` are already strict; there is no reason for these to be laxer.
 */
function strictField(
  field: string | undefined,
  name: string,
  fail: (
    fault: GuestStatusFault,
    message: string,
    field?: string,
  ) => GuestStatusError,
): number {
  if (!/^\d+$/.test(field ?? "")) {
    throw fail(
      "field",
      `status record has a malformed ${name}: ${JSON.stringify(field ?? "")}` +
        ". The record is incomplete or corrupt, which is not the same as a " +
        "step that ran and reported clean — and must never be read as one. " +
        "The guest was cut off mid-epilogue; check the console log.",
      name,
    );
  }
  return Number(field);
}

/**
 * Classify a step's filesystem check into its three real answers.
 *
 * Exists so the `-` spelling cannot be flattened by accident. `outcome.fsckRc`
 * is `undefined` for "no device was ever declared to check", and the natural
 * reading of that — `(outcome.fsckRc ?? 0) !== 0` — treats it as a clean
 * check, which fails **open** in exactly the case the field was added to
 * catch: a guest that never registered a filesystem publishes as verified.
 * Route the decision through here instead, and the third answer has to be
 * handled to compile.
 */
export function fsckVerdict(outcome: StepOutcome): FsckVerdict {
  if (outcome.fsckRc === undefined) return "unchecked";
  return outcome.fsckRc === 0 ? "clean" : "failed";
}

/**
 * Derive a boot nonce for one step.
 *
 * Deterministic on purpose: a random nonce would make {@linkcode framePayload}
 * untestable without an RNG seam, and same-step reuse is not a hazard because
 * the layer's `.partial` directory — which holds every scratch file — is wiped
 * before the step runs.
 */
export async function stepNonce(
  realizationKey: string,
  stepId: string,
): Promise<string> {
  const digest = await sha256Hex(`qimg-nonce ${realizationKey} ${stepId}`);
  return digest.slice(0, 32);
}
