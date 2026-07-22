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
 * tables and FAT filesystems can be produced host-side (qemu's `vvfat` driver
 * plus `raw` offset/size windows, see `qemu_img_smoke.ts`), but ext4 cannot:
 * it needs a Linux kernel executing target-architecture ELF. So ext4 and
 * package installs happen inside a throwaway guest, and the guest brings its
 * own `e2fsck` — the oracle that makes the result checkable.
 *
 * ## Three things that are non-obvious, and load-bearing
 *
 * 1. **The kernel builds virtio as modules.** `CONFIG_VIRTIO_BLK=m` and
 *    `CONFIG_VIRTIO_MMIO=m` (verified against the published
 *    `config-6.12.81-0-virt`). A custom initramfs with no modules therefore
 *    sees *no block devices at all* — and a step script that never loads then
 *    "succeeds" against an empty file. The appliance is layered over Alpine's
 *    own initramfs, which carries `virtio_blk.ko`, and the init loads it
 *    explicitly.
 * 2. **Concatenated cpio members: later wins.** The kernel unpacks each
 *    archive in order, so appending our overlay after Alpine's initramfs
 *    replaces its `/init` with ours while inheriting its modules.
 * 3. **`kernel_power_off()` does not sync.** The status record is written with
 *    `conv=fsync` followed by `sync`, or it is lost in the page cache on a
 *    fast step.
 *
 * @module
 */

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

/**
 * The appliance init. No getty, no login, no shell prompt: feeding a script
 * into a login prompt over serial races the getty and buffers its output, so
 * a build must not depend on prompt timing.
 *
 * Every exit path writes a framed status record, because qemu's own exit code
 * cannot carry the answer — a clean poweroff, a guest panic, and a failed
 * step all exit 0.
 */
const INIT = `#!/bin/sh
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null

# CONFIG_VIRTIO_BLK=m: with no driver loaded there are no block devices at
# all, and an unloadable step script would look like a step that passed.
KVER=$(uname -r)
for m in virtio_mmio virtio_blk; do
  modprobe "$m" 2>/dev/null || \\
    insmod "/lib/modules/$KVER/kernel/drivers/block/$m.ko" 2>/dev/null || true
done
mdev -s 2>/dev/null || true

PAYLOAD=""; STATUS=""
for arg in $(cat /proc/cmdline); do
  case "$arg" in
    qi.payload=*) PAYLOAD="\${arg#qi.payload=}" ;;
    qi.status=*)  STATUS="\${arg#qi.status=}" ;;
  esac
done

# Called on every exit path, so the host can always distinguish "the step
# failed" from "the guest never got that far". kernel_power_off() does not
# sync, so the record is fsynced before the reboot syscall.
finish() {
  printf 'QIMG1\\n%s\\n%s\\n' "$1" "$2" > /status.bin
  [ -n "$STATUS" ] && dd if=/status.bin of="$STATUS" conv=fsync 2>/dev/null
  sync
  echo "appliance: status rc=$1 ($2)"
  poweroff -f
}

[ -n "$PAYLOAD" ] || finish 91 "no-payload-device"
[ -n "$STATUS" ]  || { echo "appliance: no status device"; poweroff -f; }

i=0
while [ ! -b "$PAYLOAD" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
[ -b "$PAYLOAD" ] || finish 90 "payload-device-never-appeared:$PAYLOAD"

# Sector-aligned framing, because block devices reject unaligned reads:
# sector 0 is "QIMG1\\n<byte-length>\\n", the script starts at byte 512.
HDR=$(dd if="$PAYLOAD" bs=512 count=1 2>/dev/null | tr -d '\\0')
MAGIC=$(echo "$HDR" | sed -n 1p)
LEN=$(echo "$HDR" | sed -n 2p)
[ "$MAGIC" = "QIMG1" ] || finish 92 "bad-payload-magic:$MAGIC"
case "$LEN" in ''|*[!0-9]*) finish 93 "bad-payload-length:$LEN" ;; esac
[ "$LEN" -gt 0 ] || finish 94 "empty-step-script"

dd if="$PAYLOAD" bs=512 skip=1 2>/dev/null | dd bs=1 count="$LEN" 2>/dev/null > /step.sh
GOT=$(wc -c < /step.sh)
[ "$GOT" = "$LEN" ] || finish 95 "short-read:$GOT-of-$LEN"
echo "appliance: running $LEN-byte step script"

sh /step.sh > /out.log 2>&1
RC=$?
cat /out.log
finish "$RC" "$(sha256sum /out.log | cut -d' ' -f1)"
`;

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
  await Deno.writeTextFile(`${rootfs}/init`, INIT);
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

  console.log(`
  ${ARCH} appliance ready:
    kernel    ${WORK}/boot/vmlinuz-virt
    initramfs ${WORK}/appliance.cpio.gz

  Run a step script against it with:
    deno task appliance:run --arch=${ARCH} <step.sh>
  `);
}
