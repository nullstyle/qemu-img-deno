/**
 * Typed refusals from the guest tier.
 *
 * Each names the fix, because each is raised at a point where the alternative
 * is not a crash but a *plausible* artifact: a stale appliance produces an
 * image built by a toolchain nobody asked for, and a guest step whose
 * filesystem checks failed produces one that mounts.
 *
 * @module
 */

import { fsckVerdict, type StepOutcome } from "./abi.ts";

/**
 * Append the guest console to a message, when there is one.
 *
 * Every error in this module is raised at a point where the console is either
 * the only diagnostic or the best one, and it is written into the layer's
 * `.partial` scratch dir — which `build()` removes on failure. Embedding it
 * here is what makes it survive; a path alone does not.
 */
function withConsole(
  message: string,
  consoleText: string | undefined,
  consolePath?: string,
): string {
  const text = consoleText?.trimEnd() ?? "";
  const where = consolePath === undefined
    ? ""
    : `\nConsole retained at ${consolePath}`;
  if (text === "") return `${message}${where}`;
  return `${message}${where}\n` +
    `The guest console below is the record of this boot.\n${text}`;
}

/** Which part of the appliance identity disagreed with this source tree. */
export type StaleApplianceField =
  | "missing"
  | "abi"
  | "init"
  | "lock"
  | "kernel"
  | "initrd";

/** The `.appliance/` on disk is not the one this source tree describes. */
export class StaleApplianceError extends Error {
  /** The identity field that disagreed. */
  readonly field: StaleApplianceField;
  /** What this source tree says the field should be. */
  readonly expected: string;
  /** What the built appliance recorded (or `"absent"`). */
  readonly actual: string;

  /** Build the error; `arch` is named so the message can quote the rebuild. */
  constructor(
    field: StaleApplianceField,
    expected: string,
    actual: string,
    arch: string,
  ) {
    super(
      `the ${arch} build appliance does not match this source tree ` +
        `(${field})\n  expected ${expected}\n  actual   ${actual}\n` +
        "A guest layer's bytes are a function of the appliance that produced " +
        "them, and nothing in the recipe declares it — so an appliance built " +
        "from a different /init, lockfile or kernel would publish layers " +
        `under keys that promise this one's. Rebuild it: deno task appliance ` +
        `--arch=${arch}`,
    );
    this.name = "StaleApplianceError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The guest ran the step and it returned nonzero, or its checks failed.
 *
 * Thrown by `build()`, and re-exported from `@nullstyle/qemu-img/recipe`
 * alongside it. `instanceof` is the only honest way to tell this apart from a
 * generic failure — `.name` is a string anyone can set — so there is exactly
 * one class, reachable from both subpaths.
 */
export class GuestStepFailedError extends Error {
  /** The planned step's id. */
  readonly stepId: string;
  /** The full status record the guest wrote. */
  readonly outcome: StepOutcome;
  /** Everything the guest wrote to the serial console. */
  readonly console: string;

  /** Build the error from the guest's own report, naming every failed signal. */
  constructor(stepId: string, outcome: StepOutcome, consoleText: string) {
    // All four signals are independent, so all four are reported. A step that
    // exits nonzero AND leaves a filesystem e2fsck rejects has two separate
    // things wrong with it, and naming only the first reads as the smaller
    // problem — the exit code looks like the whole story, and the corruption
    // gets rediscovered later against an image nobody suspects.
    const verdict = fsckVerdict(outcome);
    const checks = [
      outcome.umountRc !== 0
        ? "an unmount under /mnt failed, so its writeback did not complete"
        : "",
      verdict === "failed" ? `e2fsck -fn returned ${outcome.fsckRc}` : "",
      // "Never checked" is its own clause, never folded into the one above.
      // The guest writes `fsck=-` when the step registered no device, and the
      // whole reason that spelling exists is that it is NOT rc 0: reporting it
      // as "e2fsck returned 0" would claim a check that never ran.
      verdict === "unchecked"
        ? "no filesystem was ever checked — the step registered no device for " +
          "the guest's e2fsck epilogue, so nothing verified what it wrote"
        : "",
      outcome.dmesgErrors !== 0
        ? `the guest logged ${outcome.dmesgErrors} ext4/I/O error lines`
        : "",
    ].filter((check) => check !== "");
    // Semicolons, not commas: these clauses contain commas of their own.
    //
    // `code: 0` with any of the other three is the dangerous shape, and stays
    // spelled out as such: the script succeeded and the filesystem it produced
    // is not sound, which without this check publishes as a cache hit every
    // descendant trusts.
    const why = outcome.code !== 0
      ? [
        `the step script exited ${outcome.code} at stage ${outcome.stage}`,
        ...checks,
      ].join("; ")
      : checks.length > 0
      ? `the step script succeeded but ${checks.join("; ")}`
      // Unreachable from `build()`, which constructs this only after one of the
      // four fired. Reachable by hand, though, and a dangling "succeeded but"
      // would be worse than saying plainly that nothing explains the failure.
      : "the outcome records no failing signal";
    super(
      `guest step ${stepId} failed: ${why}. ${outcome.detail}\n` +
        "The layer was not published; the console below is the whole record " +
        "of the boot.\n" +
        consoleText.trimEnd(),
    );
    this.name = "GuestStepFailedError";
    this.stepId = stepId;
    this.outcome = outcome;
    this.console = consoleText;
  }
}

/** A step declared `network: true` and the runner has no resolver. */
export class GuestNetworkUnavailableError extends Error {
  /** The planned step's id. */
  readonly stepId: string;

  /** Build the error naming the option that enables the network. */
  constructor(stepId: string) {
    super(
      `step ${stepId} declares network: true and this runner has no ` +
        "resolver configured. A resolver cannot be defaulted honestly: " +
        "slirp's own DNS at 10.0.2.3 never answers on qemu 11.0.2/macOS, and " +
        "DHCP is impossible in this guest (no af_packet module anywhere in " +
        "the initramfs — udhcpc dies in under a second). Running the step " +
        "unplugged would produce an artifact that looks built and is missing " +
        "everything it was supposed to fetch. Pass " +
        '`new ApplianceGuestRunner({ …, network: { dns: "8.8.8.8" } })`.',
    );
    this.name = "GuestNetworkUnavailableError";
    this.stepId = stepId;
  }
}

/** Which part of a payload disk `framePayload` refused to build. */
export type PayloadFrameFault = "nonce" | "header" | "script";

/**
 * A step script could not be framed onto a payload disk.
 *
 * Separate from every other class here because it is raised **before** any
 * boot: nothing has run, no disk has been written, and the fix is always in
 * the caller's arguments rather than in the appliance.
 */
export class PayloadFrameError extends Error {
  /** Which argument the frame could not accept. */
  readonly fault: PayloadFrameFault;

  /** Build the error; the message is the caller-facing wording, unchanged. */
  constructor(fault: PayloadFrameFault, message: string) {
    super(message);
    this.name = "PayloadFrameError";
    this.fault = fault;
  }
}

/** Why a status record could not be read as *this* boot's answer. */
export type GuestStatusFault =
  | "legacy"
  | "absent"
  | "nonce"
  | "code"
  | "stage"
  | "field";

/** Extra context for a {@linkcode GuestStatusError}. */
export interface GuestStatusErrorOptions {
  /** The malformed field's name, for `fault: "field"`. */
  readonly field?: string;
  /** Everything the guest wrote to the serial console. */
  readonly console?: string;
  /** A copy of the console that outlives the failed build. */
  readonly consolePath?: string;
}

/**
 * The guest's status record is absent, malformed, or from a different boot.
 *
 * Every one of these means the host has **no** trustworthy answer, which is a
 * different thing from a step that ran and failed ({@linkcode
 * GuestStepFailedError} is that one). In most of them the console is the only
 * surviving evidence — an `/init` that could not resolve its status disk
 * cannot write a record *at all*, and says why on the console and nowhere
 * else — so it is carried here rather than discarded.
 */
export class GuestStatusError extends Error {
  /** Which way the record was unusable. */
  readonly fault: GuestStatusFault;
  /** The malformed field's name, for `fault: "field"`. */
  readonly field: string | undefined;
  /** Everything the guest wrote to the serial console. */
  readonly console: string;
  /** A copy of the console that outlives the failed build, when one was kept. */
  readonly consolePath: string | undefined;
  /**
   * The message without the console appended.
   *
   * Kept so a caller that only obtains the console *after* catching — which
   * is the normal case, since retaining it is work nobody should do on a
   * successful boot — can rebuild this error with it rather than mutating
   * `message` or wrapping one error in another.
   */
  readonly reason: string;

  /** Build the error; `reason` is the caller-facing wording, unchanged. */
  constructor(
    fault: GuestStatusFault,
    reason: string,
    options: GuestStatusErrorOptions = {},
  ) {
    super(withConsole(reason, options.console, options.consolePath));
    this.name = "GuestStatusError";
    this.fault = fault;
    this.reason = reason;
    this.field = options.field;
    this.console = options.console ?? "";
    this.consolePath = options.consolePath;
  }
}

/**
 * qemu exited nonzero without ever booting the guest.
 *
 * The one case where qemu's exit code IS the answer, and the only failure here
 * whose evidence is on qemu's *stderr* rather than on the guest console — the
 * guest never got far enough to write one.
 */
export class GuestBootError extends Error {
  /** The planned step's id. */
  readonly stepId: string;
  /** qemu's own exit code. */
  readonly code: number;
  /** qemu's stderr, which is the whole diagnosis. */
  readonly stderr: string;

  /** Build the error; `message` is the caller-facing wording, unchanged. */
  constructor(stepId: string, code: number, stderr: string, message: string) {
    super(message);
    this.name = "GuestBootError";
    this.stepId = stepId;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * A guest step did not power off before its deadline, so qemu was killed.
 *
 * Deliberately does **not** claim the guest hung. Three things produce this
 * and nothing here can separate them: a genuine hang, a panic before the
 * epilogue, and work that was simply slower than the deadline allowed. The
 * message says that rather than picking one.
 */
export class GuestTimeoutError extends Error {
  /** The planned step's id. */
  readonly stepId: string;
  /** The deadline this step actually ran under. */
  readonly timeoutMs: number;
  /** Everything the guest wrote to the serial console before it was killed. */
  readonly console: string;
  /** A copy of the console that outlives the failed build, when one was kept. */
  readonly consolePath: string | undefined;

  /** Build the error from the deadline and whatever console survived. */
  constructor(
    stepId: string,
    timeoutMs: number,
    consoleText: string,
    consolePath: string | undefined,
    cause: unknown,
  ) {
    super(
      withConsole(
        `guest step ${stepId} did not power off within ${timeoutMs}ms, so ` +
          "qemu was killed. That is all this establishes: a hang, a panic " +
          "before the epilogue, and work that was simply slower than the " +
          "deadline all look identical from here, and qemu's exit code " +
          "cannot separate them either — it exits 0 for a panic under " +
          "-no-reboot just as it does for a clean poweroff. If the work was " +
          "legitimately slower, give this step its own deadline: " +
          "`run({ …, timeoutMs })`, since a 200ms mkfs and a package " +
          "install over slirp do not belong under one number.",
        consoleText,
        consolePath,
      ),
      { cause },
    );
    this.name = "GuestTimeoutError";
    this.stepId = stepId;
    this.timeoutMs = timeoutMs;
    this.console = consoleText;
    this.consolePath = consolePath;
  }
}

/**
 * `network.dns` is not an address the guest could put in `/etc/resolv.conf`.
 *
 * Raised when the runner is constructed rather than when a step runs, because
 * the value is interpolated into the kernel cmdline — a space in it does not
 * fail, it silently changes what the guest is told. The nonce beside it on
 * that cmdline has always been validated; this closes the other half.
 */
export class InvalidGuestDnsError extends Error {
  /** The rejected value, exactly as it was passed. */
  readonly dns: string;

  /** Build the error naming what the value has to be. */
  constructor(dns: string) {
    super(
      `network.dns ${JSON.stringify(dns)} is not an IPv4 address. It is ` +
        "interpolated into the guest's kernel cmdline, which is split on " +
        "whitespace — so a value carrying a space does not fail, it changes " +
        "the arguments the guest parses and then writes the remainder into " +
        "/etc/resolv.conf, where a resolver that never answers looks exactly " +
        "like a network that is down. IPv6 is refused too: the guest is " +
        "configured 10.0.2.15/24 with an IPv4 default route and has no IPv6 " +
        'address to reach one from. Pass dotted-quad IPv4, e.g. "8.8.8.8".',
    );
    this.name = "InvalidGuestDnsError";
    this.dns = dns;
  }
}
