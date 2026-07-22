/**
 * Build the qemu-img build appliance: a kernel + initramfs that boots under
 * `qemu-system-aarch64`, runs one step script against attached disks, and
 * reports a framed status record back to the host.
 *
 *     deno task appliance
 *
 * Every input is digest-pinned. Nothing here is trusted by URL: each artifact
 * is verified against a sha256 recorded below, which is also what a cache key
 * records, so the fetch is a pure function of its pins.
 *
 * ## Why an appliance at all
 *
 * The host this package targets has the whole qemu suite and *no* Linux image
 * tooling — no `mke2fs`, no `sgdisk`, no loop devices, no root. Partition
 * tables and FAT filesystems are produced host-side (this package writes both
 * as bytes, spliced through `raw` offset/size windows), but ext4 cannot be:
 * it needs a Linux kernel executing target-architecture ELF. So ext4 and
 * package installs happen inside a throwaway guest, and the guest brings its
 * own `e2fsck` — the oracle that makes the result checkable.
 *
 * ## Three things that are non-obvious, and load-bearing
 *
 * 1. **The kernel builds virtio-blk AND ext4 as modules.** A custom initramfs
 *    with no modules sees *no block devices at all*, and before `modprobe
 *    ext4` runs, `/proc/filesystems` carries **zero** block filesystems — every
 *    entry is `nodev`. `mount -t ext4` then fails on a perfect image while
 *    `mke2fs`, being pure userspace, succeeds anyway, putting the failure one
 *    step after its cause. The appliance is layered over Alpine's own
 *    initramfs, which carries both modules, and `/init` loads them explicitly.
 *    (`virtio_pci` is builtin — on `-M virt` the transport is virtio-PCI, not
 *    mmio, so `virtio_mmio` in that list is harmless noise, not a fact.)
 * 2. **Concatenated cpio members: later wins.** The kernel unpacks each
 *    archive in order, so appending our overlay after Alpine's initramfs
 *    replaces its `/init` with ours while inheriting its modules.
 * 3. **`kernel_power_off()` does not sync.** The status record is written with
 *    `conv=fsync` followed by `sync`, or it is lost in the page cache on a
 *    fast step.
 *
 * @module
 */

import { sha256Hex } from "../src/digest.ts";
import { APPLIANCE_ABI } from "../src/system/abi.ts";
import { APPLIANCE_INIT, initDigest } from "../src/system/init.ts";
import {
  type ApplianceArch as SystemArch,
  writeApplianceIdentity,
} from "../src/system/identity.ts";

/** One digest-pinned upstream artifact, as recorded in the lockfile. */
export interface PinnedArtifact {
  /** Filename, relative to the release directory and to the work dir. */
  readonly file: string;
  /** Expected sha256, lowercase hex — what a cache key records, not the URL. */
  readonly sha256: string;
}

/** Everything the lockfile says about one target architecture. */
export interface TargetPins {
  /** Guest console device: `ttyAMA0` on aarch64, `ttyS0` on x86_64. */
  readonly console: string;
  /** Default qemu machine type. */
  readonly machine: string;
  /** The qemu-system binary that runs this target. */
  readonly qemu: string;
  /** The pinned artifacts. */
  readonly artifacts: {
    readonly iso: PinnedArtifact;
    readonly minirootfs: PinnedArtifact;
  };
}

/** The parsed `appliance.lock.json`. */
export interface ApplianceLock {
  readonly lockfileVersion: number;
  readonly alpine: {
    readonly release: string;
    readonly version: string;
    readonly mirror: string;
  };
  /** Package NAMES (not filenames): versions are resolved from the ISO. */
  readonly packages: readonly string[];
  readonly targets: Readonly<Record<string, TargetPins>>;
}

/** Architectures the appliance is built for. */
export type ApplianceArch = "aarch64" | "x86_64";

/** Read and validate the lockfile. */
export async function readLock(path: string): Promise<ApplianceLock> {
  const lock = JSON.parse(await Deno.readTextFile(path)) as ApplianceLock;
  if (lock.lockfileVersion !== 1) {
    throw new Error(
      `${path}: unsupported lockfileVersion ${lock.lockfileVersion}`,
    );
  }
  return lock;
}

/** The release directory a target's artifacts live in. */
export function releaseUrl(lock: ApplianceLock, arch: string): string {
  return `${lock.alpine.mirror}/${lock.alpine.release}/releases/${arch}`;
}

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);

async function run(bin: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${bin} ${args.join(" ")} failed: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout);
}

async function sha256Of(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Fetch unless cached, then verify against the pin. Loud on mismatch. */
async function fetchPinned(
  artifact: PinnedArtifact,
  work: string,
  lock: ApplianceLock,
  arch: string,
): Promise<string> {
  const path = `${work}/${artifact.file}`;
  const cached = await Deno.stat(path).then(() => true).catch(() => false);
  if (!cached) {
    const url = `${releaseUrl(lock, arch)}/${artifact.file}`;
    step(`fetching ${artifact.file}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `fetch ${url}: HTTP ${response.status}. Alpine garbage-collects ` +
          "superseded releases, so a stale pin eventually 404s — refresh " +
          "the lockfile against the published .sha256 sidecars.",
      );
    }
    await Deno.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  }
  const actual = await sha256Of(path);
  if (actual !== artifact.sha256) {
    throw new Error(
      `digest mismatch for ${artifact.file}\n` +
        `  expected ${artifact.sha256}\n  actual   ${actual}\n` +
        "Refusing to build an appliance from an artifact that is not what " +
        "was pinned. Delete it and retry, or update the lockfile deliberately.",
    );
  }
  pass(`${artifact.file} verified (${actual.slice(0, 16)}…)`);
  return path;
}

// The driver runs ONLY as a program. Without this guard, importing anything
// from this module (tools/appliance_run.ts imports `readLock`) would re-run
// the whole appliance build as an import side effect — re-verifying a 76 MiB
// ISO and rebuilding the initramfs, and failing outright under a permission
// set that does not include --allow-net.
if (import.meta.main) {
  const ARCH = (Deno.args.find((a) => a.startsWith("--arch="))?.slice(7) ??
    Deno.build.arch) as ApplianceArch;
  const LOCK_PATH = "appliance.lock.json";
  const lock = await readLock(LOCK_PATH);
  const target = lock.targets[ARCH];
  if (target === undefined) {
    throw new Error(
      `${LOCK_PATH} has no pins for "${ARCH}" — known targets: ${
        Object.keys(lock.targets).join(", ")
      }`,
    );
  }
  /** Per-arch work dir, so both appliances coexist. */
  const WORK = `.appliance/${ARCH}`;

  console.log(`building the ${ARCH} appliance from ${LOCK_PATH}`);
  await Deno.mkdir(WORK, { recursive: true });

  const iso = await fetchPinned(target.artifacts.iso, WORK, lock, ARCH);
  const minirootfs = await fetchPinned(
    target.artifacts.minirootfs,
    WORK,
    lock,
    ARCH,
  );

  step("extracting the kernel and Alpine's module-carrying initramfs");
  // libarchive reads ISO9660, so this needs no mount, no loop device, no root.
  await run("bsdtar", [
    "-xf",
    iso,
    "-C",
    WORK,
    "boot/vmlinuz-virt",
    "boot/initramfs-virt",
  ]);
  pass("boot/vmlinuz-virt + boot/initramfs-virt");

  step("assembling the overlay rootfs");
  const rootfs = `${WORK}/rootfs`;
  await Deno.remove(rootfs, { recursive: true }).catch(() => {});
  await Deno.mkdir(rootfs, { recursive: true });
  await run("bsdtar", ["-xf", minirootfs, "-C", rootfs]);

  // Resolve package FILENAMES from the ISO rather than pinning versions per
  // arch: the two architectures ship the same package set at versions that need
  // not match, and a hardcoded filename would break on the next point release.
  const isoEntries = (await run("bsdtar", ["-tf", iso])).split("\n");
  /** Resolved package filenames — an identity field, not just a log line. */
  const resolvedPackages: string[] = [];
  for (const name of lock.packages) {
    const pattern = new RegExp(`^apks/${ARCH}/(${name}-\\d[^/]*\\.apk)$`);
    const match = isoEntries.map((e) => pattern.exec(e.trim())).find((m) => m);
    if (match === null || match === undefined) {
      throw new Error(
        `no ${name} package in ${target.artifacts.iso.file} — the appliance ` +
          "needs it to create or check ext4 filesystems.",
      );
    }
    const member = `apks/${ARCH}/${match[1]}`;
    resolvedPackages.push(match[1]);
    // Extract straight to disk. Routing the .apk through a string would decode
    // binary as UTF-8 and re-encode it, silently corrupting every package —
    // which presents as `mke2fs: not found` inside the guest, long after here.
    await run("bsdtar", ["-xf", iso, "-C", WORK, member]);
    // The .SIGN/.PKGINFO members are apk metadata, not files in the rootfs.
    await run("bsdtar", [
      "-xf",
      `${WORK}/${member}`,
      "-C",
      rootfs,
      "--exclude",
      ".SIGN.*",
      "--exclude",
      ".PKGINFO",
    ]).catch(() => {});
  }
  await Deno.writeTextFile(`${rootfs}/init`, APPLIANCE_INIT);
  await Deno.chmod(`${rootfs}/init`, 0o755);

  // Fail here rather than inside a guest twenty seconds later.
  const mke2fs = await Deno.stat(`${rootfs}/sbin/mke2fs`).catch(() => null);
  if (mke2fs === null || mke2fs.size === 0) {
    throw new Error(
      "appliance rootfs has no usable /sbin/mke2fs — the ISO package " +
        "extraction produced nothing. Without this the guest reports " +
        "`mke2fs: not found` (exit 127) on every ext4 step.",
    );
  }
  pass(
    `rootfs assembled (${lock.packages.length} packages from the pinned ISO)`,
  );

  step("building the layered initramfs");
  // uid/gid 0 so the appliance is root-owned regardless of who built it.
  await run("bsdtar", [
    "--format",
    "newc",
    "--uid",
    "0",
    "--gid",
    "0",
    "--uname",
    "root",
    "--gname",
    "root",
    "-cf",
    `${WORK}/overlay.cpio`,
    "-C",
    rootfs,
    ".",
  ]);
  await run("sh", [
    "-c",
    `gzip -9 -f -c ${WORK}/overlay.cpio > ${WORK}/overlay.cpio.gz`,
  ]);
  // Concatenated cpio members: the kernel unpacks each in order and later ones
  // win, so our /init replaces Alpine's while its modules survive.
  await run("sh", [
    "-c",
    `cat ${WORK}/boot/initramfs-virt ${WORK}/overlay.cpio.gz > ${WORK}/appliance.cpio.gz`,
  ]);
  const size = (await Deno.stat(`${WORK}/appliance.cpio.gz`)).size;
  pass(`${WORK}/appliance.cpio.gz (${(size / 1024 / 1024).toFixed(1)} MiB)`);

  step("recording the appliance identity");
  // The kernel release comes from Alpine's OWN initramfs member list rather
  // than from `uname -r` in a guest: this runs on the host, and the release is
  // what names the module directory the /init modprobes out of.
  const initramfsEntries = (await run("bsdtar", [
    "-tf",
    `${WORK}/boot/initramfs-virt`,
  ])).split("\n");
  const release = initramfsEntries
    .map((entry) => /^lib\/modules\/([^/]+)\//.exec(entry.trim())?.[1])
    .find((found) => found !== undefined);
  if (release === undefined) {
    throw new Error(
      `no lib/modules/<release>/ in ${WORK}/boot/initramfs-virt — the ` +
        "appliance inherits its virtio and ext4 modules from Alpine's " +
        "initramfs, so an initramfs without one boots to a guest that sees " +
        "no block devices at all.",
    );
  }
  // Nothing about the qemu that will BOOT this is recorded here: the boot host
  // need not be the build host, and a stale copy of its version would defeat
  // the check it exists for. readApplianceIdentity() probes it instead.
  await writeApplianceIdentity(WORK, {
    abi: APPLIANCE_ABI,
    arch: ARCH as SystemArch,
    kernelSha256: await sha256Of(`${WORK}/boot/vmlinuz-virt`),
    initrdSha256: await sha256Of(`${WORK}/appliance.cpio.gz`),
    initSha256: await initDigest(),
    lockSha256: await sha256Hex(await Deno.readFile(LOCK_PATH)),
    kernelRelease: release,
    packages: resolvedPackages,
    machine: target.machine,
  });
  pass(`${WORK}/appliance.json (kernel ${release}, ABI ${APPLIANCE_ABI})`);

  console.log(`
  ${ARCH} appliance ready:
    kernel    ${WORK}/boot/vmlinuz-virt
    initramfs ${WORK}/appliance.cpio.gz

  Run a step script against it with:
    deno task appliance:run --arch=${ARCH} <step.sh>
  `);
}
