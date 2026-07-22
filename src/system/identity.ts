/**
 * What a guest layer's bytes depend on besides the recipe.
 *
 * A recipe declares partitions, labels and scripts. It does not declare the
 * kernel that parses its GPT, the e2fsprogs build that writes its superblocks,
 * or the `/init` that resolves its disks — and all three are in the output.
 * Without an identity folded into the cache key, bumping `appliance.lock.json`
 * leaves every guest layer a cache **hit** on bytes the new appliance would
 * never produce, and two developers rsyncing a store hand each other layers
 * built by different toolchains under identical keys.
 *
 * This is the same argument `keys.ts` makes for a container's digest, applied
 * to the executor.
 *
 * @module
 */

import { canonicalJson, sha256Hex } from "../digest.ts";
import { type CommandRunner, DenoCommandRunner } from "../runner.ts";
import { APPLIANCE_ABI } from "./abi.ts";
import { initDigest } from "./init.ts";
import { StaleApplianceError } from "./errors.ts";

/** Architectures the appliance is built for. */
export type ApplianceArch = "aarch64" | "x86_64";

/** Everything a guest layer's bytes depend on besides the recipe. */
export interface ApplianceIdentity {
  /** The wire ABI the appliance was built to speak. */
  readonly abi: number;
  /** The guest architecture. */
  readonly arch: ApplianceArch;
  /** sha256 of `boot/vmlinuz-virt`. */
  readonly kernelSha256: string;
  /** sha256 of `appliance.cpio.gz`. */
  readonly initrdSha256: string;
  /** sha256 of `APPLIANCE_INIT` as the appliance was BUILT from. */
  readonly initSha256: string;
  /** sha256 of `appliance.lock.json`. */
  readonly lockSha256: string;
  /** `6.12.81-0-virt` — read from the initramfs' `lib/modules/<X>/`. */
  readonly kernelRelease: string;
  /** Resolved package filenames, e.g. `e2fsprogs-1.47.1-r1.apk`. */
  readonly packages: readonly string[];
  /** The qemu machine the appliance boots on. Unversioned aliases move. */
  readonly machine: string;
  /**
   * `qemu-system-* --version`, probed at read time.
   *
   * In the digest because `appliance.lock.json` boots on `"machine": "virt"`
   * — an unversioned alias that resolves to whatever the installed qemu calls
   * current, moving ACPI and device enumeration across a `brew upgrade`. An
   * alias that moved shows up here, so keying on it gives recipes the same
   * guarantee `validateRecipe` gives them without dropping qemu 8.x support.
   */
  readonly qemuSystemVersion: string;
  /** sha256 over `canonicalJson` of every field above. Folded into guest keys. */
  readonly digest: string;
}

/** The fields `tools/build_appliance.ts` records; the rest are derived. */
export type ApplianceIdentityRecord = Omit<
  ApplianceIdentity,
  "digest" | "qemuSystemVersion"
>;

/** Options for {@linkcode readApplianceIdentity}. */
export interface ReadApplianceIdentityOptions {
  /** Root holding `<arch>/`. @default ".appliance" */
  readonly root?: string;
  /** Which appliance to read. */
  readonly arch: ApplianceArch;
  /** Path to the lockfile to verify against. @default "appliance.lock.json" */
  readonly lockPath?: string;
  /** Subprocess seam used to probe the qemu version. @default a real runner */
  readonly qemu?: CommandRunner;
}

/** The identity file's name inside `<root>/<arch>/`. */
export const IDENTITY_FILE = "appliance.json";

/**
 * Write `<work>/appliance.json`. Called by `tools/build_appliance.ts`.
 *
 * Only the fields the *builder* knows are stored. `qemuSystemVersion` and
 * `digest` are deliberately derived at read time instead: the qemu that boots
 * the appliance is a property of the machine running the build, not of the
 * artifacts, and storing a stale copy would defeat the check it exists for.
 */
export async function writeApplianceIdentity(
  work: string,
  fields: ApplianceIdentityRecord,
): Promise<void> {
  await Deno.writeTextFile(
    `${work}/${IDENTITY_FILE}`,
    `${JSON.stringify(fields, null, 2)}\n`,
  );
}

/**
 * Read the identity, re-verify it against the current source tree, and probe
 * the qemu version.
 *
 * Every check runs on every call, because each one is the difference between a
 * loud failure here and a wrong image later. A **missing** `appliance.json` is
 * itself a {@linkcode StaleApplianceError} — that is the signal for an
 * appliance built by a tree from before identities existed.
 *
 * Cost is one sha256 over ~14 MiB of kernel plus initramfs, memoized by path,
 * size and mtime so a build that plans many guest layers pays it once.
 */
export async function readApplianceIdentity(
  options: ReadApplianceIdentityOptions,
): Promise<ApplianceIdentity> {
  const arch = options.arch;
  const work = `${options.root ?? ".appliance"}/${arch}`;
  const lockPath = options.lockPath ?? "appliance.lock.json";
  const identityPath = `${work}/${IDENTITY_FILE}`;

  const text = await Deno.readTextFile(identityPath).catch(() => undefined);
  if (text === undefined) {
    throw new StaleApplianceError(
      "missing",
      identityPath,
      "absent",
      arch,
    );
  }
  const record = JSON.parse(text) as ApplianceIdentityRecord;

  if (record.abi !== APPLIANCE_ABI) {
    throw new StaleApplianceError(
      "abi",
      String(APPLIANCE_ABI),
      String(record.abi),
      arch,
    );
  }
  // The /init check first among the digests: it is the one that changes on an
  // ordinary source edit, and the one whose skew is otherwise invisible.
  const expectedInit = await initDigest();
  if (record.initSha256 !== expectedInit) {
    throw new StaleApplianceError(
      "init",
      expectedInit,
      record.initSha256,
      arch,
    );
  }
  const expectedLock = await sha256Hex(await Deno.readFile(lockPath));
  if (record.lockSha256 !== expectedLock) {
    throw new StaleApplianceError(
      "lock",
      expectedLock,
      record.lockSha256,
      arch,
    );
  }
  const kernel = await fileDigest(`${work}/boot/vmlinuz-virt`);
  if (record.kernelSha256 !== kernel) {
    throw new StaleApplianceError("kernel", kernel, record.kernelSha256, arch);
  }
  const initrd = await fileDigest(`${work}/appliance.cpio.gz`);
  if (record.initrdSha256 !== initrd) {
    throw new StaleApplianceError("initrd", initrd, record.initrdSha256, arch);
  }

  const qemuSystemVersion = await probeQemuVersion(
    arch,
    options.qemu ?? new DenoCommandRunner(),
  );
  const fields: ApplianceIdentityRecord & { qemuSystemVersion: string } = {
    abi: record.abi,
    arch: record.arch,
    kernelSha256: record.kernelSha256,
    initrdSha256: record.initrdSha256,
    initSha256: record.initSha256,
    lockSha256: record.lockSha256,
    kernelRelease: record.kernelRelease,
    packages: [...record.packages],
    machine: record.machine,
    qemuSystemVersion,
  };
  return { ...fields, digest: await sha256Hex(canonicalJson(fields)) };
}

/**
 * Digests of large build artifacts, keyed by path, size and mtime.
 *
 * A plan with several guest layers reads the identity once per layer, and the
 * kernel plus initramfs are ~14 MiB — measured at roughly 30 ms per pass.
 */
const DIGEST_CACHE = new Map<string, string>();

async function fileDigest(path: string): Promise<string> {
  const stat = await Deno.stat(path).catch(() => undefined);
  if (stat === undefined) return "absent";
  const token = `${path}:${stat.size}:${stat.mtime?.getTime() ?? 0}`;
  const cached = DIGEST_CACHE.get(token);
  if (cached !== undefined) return cached;
  const digest = await sha256Hex(await Deno.readFile(path));
  DIGEST_CACHE.set(token, digest);
  return digest;
}

/**
 * `qemu-system-<arch> --version`, reduced to its first line.
 *
 * A probe failure is not fatal here: the version is a cache-key input, and
 * refusing to plan because the binary is absent would break the host that
 * builds `bytes` layers and never boots anything. The recorded value says so
 * plainly rather than pretending to a version.
 */
async function probeQemuVersion(
  arch: ApplianceArch,
  runner: CommandRunner,
): Promise<string> {
  const bin = `qemu-system-${arch}`;
  const result = await runner.run(bin, ["--version"]).catch(() => undefined);
  if (result === undefined || !result.success) return "unavailable";
  return result.stdout.split("\n")[0]?.trim() ?? "unavailable";
}
