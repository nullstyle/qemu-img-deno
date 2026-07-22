/**
 * The generated step script: pure string builders, no I/O and no clock.
 *
 * Everything here is POSIX `ash`. The appliance has no `bash`, no coreutils,
 * no GNU `tar`, no `sfdisk`/`partx`/`parted` and no `mkfs.fat` — and none of
 * them are on the pinned ISO either, so "add a package" is not an escape
 * hatch. No arrays, no `[[ ]]`, no process substitution.
 *
 * `/init` prepends `set -eu` to whatever these produce, because without it
 * `$?` is the LAST command's status and `mke2fs …; sync` would report sync's
 * zero over a failed format. That does **not** cover pipelines — see the
 * README's guest-tier hazard table.
 *
 * Exit codes raised by generated scripts, chosen not to collide with `/init`'s
 * own `91`–`101`: `64` a declared partition node never appeared, `65`/`66` its
 * start/size disagree with the plan, `67` a `copyIn` with no data disk, `68`
 * the ROOT partition node never appeared, `69` the root partition holds no
 * filesystem `blkid` recognizes, `70` it holds one that is not ext2/3/4, `71`
 * the `copyIn` payload failed to extract, `73` the `copyIn` destination
 * resolves outside the image root through a symlink the base image shipped.
 *
 * These all arrive at stage `"step"`, because they are raised by the script
 * `/init` runs — so they are indistinguishable from a code the recipe author
 * chose. Keep new ones in this band and away from anything an author is
 * likely to pick.
 *
 * @module
 */

/** One partition the guest must format. */
export interface MkfsPartition {
  /** 1-based GPT partition number; the node is `${target}${number}`. */
  readonly number: number;
  /** Partition start, in 512-byte sysfs sectors: `firstLba * sectorSize / 512`. */
  readonly startSectors512: number;
  /** Partition length, in 512-byte sysfs sectors: `lengthBytes / 512`. */
  readonly sizeSectors512: number;
  /** ext4 volume label (NOT the GPT partition name). */
  readonly fsLabel: string;
  /** Filesystem UUID, derived from `determinism.fsSeed`. */
  readonly uuid: string;
  /** `-E hash_seed=`, derived from `determinism.fsSeed`. */
  readonly hashSeed: string;
}

/** Arguments to {@linkcode mkfsScript}. */
export interface MkfsScriptArgs {
  /**
   * `E2FSPROGS_FAKE_TIME`, in seconds.
   *
   * The only *measured*-working time pin on this e2fsprogs build. Two runs
   * five seconds apart with `-U` and `hash_seed` but no fake time produced
   * different bytes; adding it made two separate boots byte-identical.
   * `SOURCE_DATE_EPOCH` on this build is **unmeasured**.
   */
  readonly fakeTimeEpoch: number;
  /** The partitions to format, in the order they should be formatted. */
  readonly partitions: readonly MkfsPartition[];
}

/** Arguments to {@linkcode copyInScript}. */
export interface CopyInScriptArgs {
  /** 1-based GPT partition number holding the root filesystem. */
  readonly rootPartitionNumber: number;
  /** Destination inside the image: absolute, normalized, `/`-separated. */
  readonly to: string;
}

/** Arguments to {@linkcode runScript}. */
export interface RunScriptArgs {
  /** 1-based GPT partition number holding the root filesystem. */
  readonly rootPartitionNumber: number;
  /** The author's script, emitted verbatim. */
  readonly script: string;
  /**
   * Run the script inside the target root under `chroot`.
   *
   * Requires {@linkcode RunScriptArgs.arch} so the loader diagnosis can name
   * the paths that actually matter for the target.
   */
  readonly chroot?: boolean;
  /**
   * Target architecture, for the chroot loader diagnosis. Required when
   * `chroot` is set.
   */
  readonly arch?: GuestScriptArch;
  /**
   * The step declared `network: true`, so a resolver has to reach inside the
   * chroot. Ignored unless `chroot` is set — a non-chrooted script already
   * sees the appliance's own `/etc/resolv.conf`.
   */
  readonly network?: boolean;
}

/** Architectures the generated scripts know loader paths for. */
export type GuestScriptArch = "aarch64" | "x86_64";

/** Arguments to {@linkcode unpackScript}. */
export interface UnpackScriptArgs {
  /** 1-based GPT partition number holding the root filesystem. */
  readonly rootPartitionNumber: number;
  /** Destination inside the image: absolute, normalized, `/`-separated. */
  readonly to: string;
  /** Which decompressor busybox `tar` must be told to use. */
  readonly compression: TarCompression;
  /** `--strip-components`, or 0. */
  readonly stripComponents?: number;
}

/** The compressions {@linkcode GUEST_TAR_FLAG} maps, plus the ones it does not. */
export type TarCompression =
  | "none"
  | "gzip"
  | "bzip2"
  | "xz"
  | "lzma"
  | "zstd";

/**
 * busybox `tar`'s decompression flag per compression, and the whole basis for
 * the `unpack` compression refusal. `undefined` means refused at plan time.
 *
 * Every entry is **measured end to end** in the appliance, extracting a real
 * archive delivered the way `unpack` delivers one — as a raw block device,
 * which qemu rounds up to a 512-byte multiple and zero-fills. That transport,
 * not the applet list, is what decides this table:
 *
 * | compression | `tar` exit | files extracted |
 * | ----------- | ---------- | --------------- |
 * | none        | 0          | correct         |
 * | gzip        | 0          | correct         |
 * | bzip2       | 0          | correct         |
 * | lzma        | 0          | correct         |
 * | xz          | **1**      | correct         |
 * | zstd        | no applet  | —               |
 *
 * `xz` is the entry worth explaining. busybox's xz reader does not stop at the
 * stream's end, so it runs into the padding and `tar -J` prints `tar:
 * corrupted data` and exits 1 — *after* extracting every member correctly.
 * A build would fail loudly and blame the user's archive. It is a limit of the
 * raw-device transport rather than of xz: reading exactly `sizeBytes` with a
 * two-stage `dd` into a pipe made the identical archive extract at exit 0
 * (measured), so the refusal is a decision not to ship a second transport, not
 * an impossibility. Recompressing is one command.
 *
 * `-a` (decompress by extension) is unusable here for the same reason the
 * table exists: a block device has no filename to read an extension from.
 */
export const GUEST_TAR_FLAG: Readonly<
  Partial<Record<TarCompression, readonly string[]>>
> = {
  none: [],
  gzip: ["-z"],
  bzip2: ["-j"],
  lzma: ["--lzma"],
};

/**
 * Dynamic-loader paths a chroot into the target might need, per architecture.
 *
 * Used **only** to explain a chroot that already failed — never as a
 * precondition. A statically linked `/bin/sh` needs none of these, and
 * refusing that rootfs for lacking a loader would be exactly the kind of guess
 * this package does not make.
 */
export const TARGET_LOADERS: Readonly<
  Record<GuestScriptArch, readonly string[]>
> = {
  aarch64: ["/lib/ld-musl-aarch64.so.1", "/lib/ld-linux-aarch64.so.1"],
  x86_64: ["/lib/ld-musl-x86_64.so.1", "/lib64/ld-linux-x86-64.so.2"],
};

/**
 * Format each partition. Never mounts; never populates.
 *
 * The sysfs start/size cross-check is the load-bearing part. `mke2fs` formats
 * whatever device it is handed, and the kernel's own parse of the GPT the
 * previous layer just wrote is the **one statement of partition location that
 * shares no code with `src/fs/gpt.ts`**. Comparing it before formatting turns
 * a plan/GPT disagreement into exit 65/66 instead of a correct-looking ext4 in
 * the wrong window.
 *
 * Formatting the partition node — never `mke2fs -E offset=` — also makes the
 * kernel enforce the end: a 200 MiB `dd` into a 128 MiB partition stopped at
 * exactly 134217728 bytes. The offset path was measured to produce, on a
 * one-block arithmetic error, a filesystem `blkid` calls ext4 and the kernel
 * then refuses to mount. That is the silent-corruption shape this package
 * refuses.
 */
export function mkfsScript(args: MkfsScriptArgs): string {
  if (args.partitions.length === 0) {
    throw new Error(
      "mkfsScript was given no partitions. An empty mkfs layer would publish " +
        "as a successful format of nothing, and every descendant would mount " +
        "a filesystem that was never created. Emit the layer only when " +
        "there is a kernel filesystem to make.",
    );
  }
  const lines = [
    "# --- generated by src/system/script.ts: mkfs ---",
    ...PART_HELPER,
    "QI_NAME=${QI_TARGET#/dev/}",
  ];
  for (const partition of args.partitions) {
    const node = `"\${QI_TARGET}${partition.number}"`;
    const sysfs = `"\${QI_NAME}${partition.number}"`;
    lines.push(
      "",
      `qi_part ${node} ${sysfs} ${partition.startSectors512} ` +
        `${partition.sizeSectors512}`,
      // All four determinism knobs are load-bearing and measured: dropping
      // `hash_seed` left 100 differing bytes, dropping `-U` left 558. `-b 4096`
      // is mandatory because mke2fs picks its block size from DEVICE SIZE —
      // 1024 on a 64 MiB device, 4096 on a 1 GiB one — so without it growing a
      // partition silently relays out the filesystem.
      `E2FSPROGS_FAKE_TIME=${args.fakeTimeEpoch} mke2fs -t ext4 -F -q -b 4096 \\`,
      `  -L ${shellQuote(partition.fsLabel)} \\`,
      `  -U ${partition.uuid} \\`,
      `  -E hash_seed=${partition.hashSeed},nodiscard,root_owner=0:0 \\`,
      `  ${node}`,
      // /init's epilogue runs `e2fsck -fn` over every device listed here,
      // after every unmount, and its rc rides in the status frame.
      `echo ${node} >> /qi/fsck-devs`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Mount the root partition and extract the data disk's tar under `to`.
 *
 * busybox `tar` reads the raw block device directly. The archive's two
 * all-zero-block trailer is self-delimiting, so there is no `dd |` stage and
 * no length header — a 3 MiB tar on a 1 GiB device extracted in ~0.86 s
 * without scanning the rest.
 */
export function copyInScript(args: CopyInScriptArgs): string {
  const node = `"\${QI_TARGET}${args.rootPartitionNumber}"`;
  const dest = shellQuote(
    args.to === "/" ? "/mnt/root" : `/mnt/root${args.to}`,
  );
  return [
    "# --- generated by src/system/script.ts: copyIn ---",
    ...MOUNT_HELPER,
    // A missing data disk is a host bug, and without this check `tar -xf ""`
    // would fail with an error naming the empty string rather than the cause.
    '[ -n "${QI_DATA:-}" ] || { echo "qi: copyIn with no data disk attached"; ' +
    "exit 67; }",
    `qi_mount_root ${node} ${args.rootPartitionNumber}`,
    `mkdir -p ${dest}`,
    // The destination must still be INSIDE the image after the kernel has
    // resolved it. A base image brings its own symlinks, and an ABSOLUTE one
    // anywhere in the path (Alpine's cloud image ships
    // `/etc/ssl1.1/certs -> /etc/ssl/certs`) resolves against the APPLIANCE's
    // root, not the mounted image — so `tar -x` would write into the
    // initramfs, the tmpfs would evaporate at poweroff, and the build would
    // exit 0 having copied nothing. `cd` + `pwd -P` is the resolution the
    // kernel itself will perform. A blank base has no symlinks to traverse,
    // which is why this only became reachable with `base.kind: "image"`.
    `qi_real=$(cd ${dest} 2>/dev/null && pwd -P) || qi_real=""`,
    `case "$qi_real" in`,
    `  /mnt/root|/mnt/root/*) ;;`,
    `  *) echo "qi: ${dest} resolves to '$qi_real', outside the image root."; ` +
    `echo "qi: a symlink in that path points outside the image; name the ` +
    `resolved destination instead."; exit 73 ;;`,
    `esac`,
    // No -m (mtimes come from the archive, which the writer pins) and no -o
    // (the writer already emits uid/gid 0). No --numeric-owner either, and
    // that is a decision rather than a limitation: busybox 1.37.0 does
    // implement it (measured — see unpackScript), but `buildTar` writes every
    // member as uid/gid 0 with `uname`/`gname` "root", and this appliance
    // resolves "root" to 0, so both paths land 0:0. `unpack` needs the flag
    // because its archive is the caller's; this one is ours. It has no
    // --xattrs at any version.
    //
    // The `df` on failure is diagnosis, never a guard. Running out of room is
    // the likeliest way a copyIn into an EXISTING image fails — Alpine's
    // aarch64 cloud image ships its root 89% full, with about 35 MiB writable
    // as root — and busybox tar reports only `tar: write error: No space left
    // on device`, which does not say which filesystem or how full it was.
    // Measured: the step exits 1, `e2fsck` still passes, and the layer is
    // correctly never published. A *precheck* is deliberately not here: the
    // archive's byte count is not the space it occupies once ext4 rounds every
    // file up to a block, so a size comparison would refuse builds that fit.
    `if ! tar -xf "$QI_DATA" -C ${dest}; then`,
    '  echo "qi: extracting the copyIn payload failed. If the message above ' +
    "is ENOSPC, the image's root filesystem is full:\"",
    "  df -k /mnt/root || true",
    "  exit 71",
    "fi",
    "",
  ].join("\n");
}

/**
 * Mount the root partition and extract the data disk's archive under `to`.
 *
 * The archive is the caller's own file, byte for byte, attached as the data
 * disk. The compression flag comes from {@linkcode GUEST_TAR_FLAG} rather than
 * from busybox's `-a`, which reads an extension off a filename the guest never
 * sees — the payload arrives as `/dev/vdX`.
 *
 * **Measured**: the raw device is the file rounded up to a 512-byte multiple
 * (3850805 → 3851264 for the Alpine minirootfs), and busybox's gzip reader
 * stops at the stream's own end rather than choking on the padding. The whole
 * extraction took 0.05 s. That the padding is harmless is a property of the
 * decompressor, not of the transport — see {@linkcode GUEST_TAR_FLAG}, where it
 * is what rules xz out.
 */
export function unpackScript(args: UnpackScriptArgs): string {
  const flag = GUEST_TAR_FLAG[args.compression];
  if (flag === undefined) {
    throw new Error(
      `unpackScript was asked for ${args.compression}, which the appliance ` +
        "cannot unpack correctly over this transport (see GUEST_TAR_FLAG for " +
        "which of the two reasons applies). plan() refuses this, so reaching " +
        "here means a caller bypassed the planner.",
    );
  }
  const node = `"\${QI_TARGET}${args.rootPartitionNumber}"`;
  const destination = args.to === "/" ? "/mnt/root" : `/mnt/root${args.to}`;
  const strip = args.stripComponents ?? 0;
  return [
    "# --- generated by src/system/script.ts: unpack ---",
    ...MOUNT_HELPER,
    '[ -n "${QI_DATA:-}" ] || { echo "qi: unpack with no data disk attached"; ' +
    "exit 67; }",
    `qi_mount_root ${node} ${args.rootPartitionNumber}`,
    `mkdir -p ${shellQuote(destination)}`,
    // Each flag is its own argv word. Bundling them (`-x-z`) is a silent
    // no-op-then-error, and `--lzma` cannot be bundled at all.
    //
    // No -m and no -o: the archive is the caller's, and its mtimes and its
    // uid/gid are what they asked to install. This is the opposite choice from
    // copyIn, whose archive this package writes and pins itself.
    //
    // `--numeric-owner` is load-bearing for exactly that reason. Without it
    // busybox tar resolves each member's `uname`/`gname` against the
    // APPLIANCE's /etc/passwd and /etc/group — the target's are not consulted
    // and could not be, since the target is a mounted directory and not the
    // running system — so a member's numeric uid/gid is discarded whenever its
    // names happen to resolve here. Measured in this appliance (busybox
    // 1.37.0, extracting as uid 0) with an archive whose members carry
    // uid/gid 123/456 under `uname=root`/`gname=root`: without the flag both
    // the file and the directory landed `0:0`, with it `123:456`. Position in
    // the argv does not matter — after `-C` was measured identical to before
    // `-f`. The flag is measured HONORED and not merely accepted, because
    // `tar --help` in this applet advertises options it does not implement.
    // A rootfs unpacked without it builds, mounts and boots, wrongly owned.
    [
      "tar",
      "-x",
      ...flag,
      "-f",
      '"$QI_DATA"',
      "-C",
      shellQuote(destination),
      "--numeric-owner",
      ...(strip > 0 ? ["--strip-components", String(strip)] : []),
    ].join(" "),
    "",
  ].join("\n");
}

/**
 * Mount the root partition and run the author's script — beside the target, or
 * inside it.
 *
 * Without `chroot` the target is mounted at `$QI_ROOT` and the script runs on
 * the appliance's busybox. With it, `/proc`, `/sys` and a bind of `/dev` go
 * under the root and the script runs as `chroot "$QI_ROOT" /bin/sh -eu -c`.
 *
 * The unmount is `/init`'s epilogue, so it runs even when the script fails.
 *
 * The chroot's interesting part is the failure path. A chroot into a root
 * without its dynamic loader fails with `chroot: can't execute '/bin/sh': No
 * such file or directory` — `execve()` reports `ENOENT` for the missing
 * *interpreter*, so the message names the binary that is right there. Measured
 * 3/3 by hiding `/lib/ld-musl-aarch64.so.1` in an otherwise complete Alpine
 * minirootfs: rc 127, and the same message for `/bin/busybox`, `/bin/sh` and
 * `/sbin/apk` alike. The generated script therefore probes with `sh -c :`
 * first and, only on failure, says which of the two causes it actually was.
 */
export function runScript(args: RunScriptArgs): string {
  const node = `"\${QI_TARGET}${args.rootPartitionNumber}"`;
  if (args.chroot !== true) {
    return [
      "# --- generated by src/system/script.ts: run ---",
      ...MOUNT_HELPER,
      `qi_mount_root ${node} ${args.rootPartitionNumber}`,
      "QI_ROOT=/mnt/root",
      "export QI_ROOT",
      'cd "$QI_ROOT"',
      args.script.replace(/\n+$/, ""),
      "",
    ].join("\n");
  }
  if (args.arch === undefined) {
    throw new Error(
      "runScript({ chroot: true }) needs `arch`. The diagnosis for a failed " +
        "chroot names the loader the target was missing, and there is exactly " +
        "one message worth printing per architecture — a generic one would " +
        "reproduce the misdiagnosis this guard exists to prevent.",
    );
  }
  const network = args.network === true;
  return [
    "# --- generated by src/system/script.ts: run (chroot) ---",
    ...MOUNT_HELPER,
    ...chrootHelper(args.arch),
    ...(network ? RESOLV_HELPER : []),
    `qi_mount_root ${node} ${args.rootPartitionNumber}`,
    "QI_ROOT=/mnt/root",
    "export QI_ROOT",
    'qi_chroot_enter "$QI_ROOT"',
    ...(network ? ['qi_resolv_install "$QI_ROOT"'] : []),
    "QI_RC=0",
    // `|| QI_RC=$?` rather than `; QI_RC=$?`: /init imposes `set -e`, under
    // which the second spelling never reaches the assignment.
    `chroot "$QI_ROOT" /bin/sh -eu -c ${
      shellQuote(args.script.replace(/\n+$/, ""))
    } || QI_RC=$?`,
    ...(network ? ['qi_resolv_restore "$QI_ROOT"'] : []),
    'qi_chroot_leave "$QI_ROOT"',
    '[ "$QI_RC" = 0 ] || exit "$QI_RC"',
    "",
  ].join("\n");
}

/**
 * Wait for a partition node, then check it against the plan before touching it.
 *
 * sysfs `start` and `size` are **always** in 512-byte units regardless of the
 * device's logical block size, which is why the caller converts rather than
 * passing LBAs through.
 */
const PART_HELPER: readonly string[] = [
  "qi_part() {",
  "  # $1 device  $2 sysfs name  $3 start (512B sectors)  $4 size (512B sectors)",
  "  i=0",
  '  while [ ! -b "$1" ] && [ "$i" -lt 50 ]; do mdev -s 2>/dev/null || true; ' +
  "sleep 0.1; i=$((i+1)); done",
  '  [ -b "$1" ] || { echo "qi: $1 never appeared — the kernel did not parse ' +
  'the GPT this build wrote"; exit 64; }',
  '  s=$(cat "/sys/class/block/$2/start"); n=$(cat "/sys/class/block/$2/size")',
  '  [ "$s" = "$3" ] || { echo "qi: $1 starts at sector $s; the plan says $3"; ' +
  "exit 65; }",
  '  [ "$n" = "$4" ] || { echo "qi: $1 is $n sectors; the plan says $4"; ' +
  "exit 66; }",
  "}",
];

/**
 * Mount the target's root filesystem once, idempotently, and register it for
 * the epilogue's `e2fsck`.
 *
 * `-t ext4` is not optional: busybox `mount` cannot autodetect ext4 in this
 * initramfs, and a bare `mount <dev>` fails with "No such file or directory"
 * (rc 255) on a perfectly good filesystem.
 *
 * The two preflight checks exist for `base.kind: "image"`. A recipe that
 * declares its own layout is checked by {@link PART_HELPER}, which compares the
 * kernel's parse of the GPT against the plan — but an existing image's table
 * was written by someone else, so there is no planned geometry to compare
 * against and `rootPartition` is a number the recipe author had to read off the
 * image. Both ways of getting it wrong were measured against Alpine's aarch64
 * cloud image:
 *
 * - A number with no partition (`3`) reached `mount: mounting /dev/vda3 on
 *   /mnt/root failed: No such file or directory`, which never mentions
 *   `rootPartition` nor says which numbers would have worked.
 * - The image's own ESP (`1`) is FAT. Registering the device for the epilogue
 *   *before* attempting the mount meant `e2fsck` ran on it too, so the failure
 *   arrived as `Invalid argument` followed by twelve lines of superblock
 *   recovery advice, with `contains a vfat file system` on the last one.
 *
 * Ordering is therefore load-bearing: `blkid` runs BEFORE `/qi/fsck-devs` is
 * touched, so a non-ext filesystem is never handed to `e2fsck`.
 *
 * `blkid` is PARSED, not queried. busybox 1.37.0's applet takes `[BLOCKDEV]...`
 * and nothing else — it **accepts `-s TYPE -o value` silently and prints the
 * whole line anyway**, so the util-linux spelling yields
 * `/dev/vda2: LABEL="/" UUID="…" TYPE="ext4"` where the caller expected
 * `ext4`, and a case arm matching `ext4` would then reject a perfectly good
 * root. It also exits `0` on a device holding no filesystem, printing nothing,
 * so the empty string is the signal and the exit status is not.
 *
 * `ext2` and `ext3` are accepted because the ext4 driver mounts them: measured
 * here, `mke2fs -t ext2` and `-t ext3` images both mounted under
 * `mount -t ext4` at rc 0 and appear in `/proc/mounts` as `ext4`.
 */
const MOUNT_HELPER: readonly string[] = [
  "qi_mount_root() {",
  "  # $1 device  $2 the recipe's declared 1-based partition number",
  "  i=0",
  '  while [ ! -b "$1" ] && [ "$i" -lt 50 ]; do mdev -s 2>/dev/null || true; ' +
  "sleep 0.1; i=$((i+1)); done",
  '  if [ ! -b "$1" ]; then',
  '    echo "qi: $1 never appeared, so partition $2 is not in this image."',
  '    echo "qi: the target disk offers: $(ls -d ' +
  "/sys/class/block/\${QI_TARGET#/dev/}[0-9]* 2>/dev/null | sed 's|.*/||' | " +
  "tr '\\n' ' ')\"",
  '    echo "qi: base.rootPartition is the 1-based GPT number the image ' +
  'already has, not an index this build chose."',
  "    exit 68",
  "  fi",
  // Greedy `.*` anchors to the LAST ` TYPE="` on the line, which is the
  // filesystem's own; a LABEL that merely contains the text cannot win.
  '  _t=$(blkid "$1" 2>/dev/null | sed -n ' +
  '\'s/.*[[:space:]]TYPE="\\([^"]*\\)".*/\\1/p\')',
  '  case "$_t" in',
  "    ext2|ext3|ext4) ;;",
  '    "")',
  '      echo "qi: blkid finds no filesystem at all on $1 (partition $2)."',
  '      echo "qi: an unformatted or unrecognized partition mounts nowhere; ' +
  'check base.rootPartition."',
  "      exit 69",
  "      ;;",
  "    *)",
  '      echo "qi: $1 (partition $2) holds $_t, not ext4."',
  '      echo "qi: run and copyIn steps mount the image root read-write, and ' +
  'this appliance carries e2fsprogs and no other filesystem tooling."',
  '      echo "qi: point base.rootPartition at the ext4 partition, or drop ' +
  'the step."',
  "      exit 70",
  "      ;;",
  "  esac",
  "  mkdir -p /mnt/root",
  // Safe under `set -e`: a failing left operand of `&&` does not exit the
  // shell. Measured in this appliance — `( set -e; false && echo x; echo y )`
  // printed `y` and returned 0.
  "  mountpoint -q /mnt/root && return 0",
  '  grep -qx "$1" /qi/fsck-devs || echo "$1" >> /qi/fsck-devs',
  '  mount -t ext4 "$1" /mnt/root',
  "}",
];

/**
 * Enter, diagnose and leave a chroot into the mounted target.
 *
 * The three mounts are not interchangeable in importance. `/dev` is
 * **measured** load-bearing: `apk add nginx` inside a chroot without it exits
 * `0`, prints `OK: 9 MiB in 17 packages`, and leaves a 0-byte **regular file**
 * at `/dev/null` (mode 0644) that a post-install script's `> /dev/null`
 * created — after which every redirect in the shipped image appends to a file
 * instead of discarding. `/proc` and `/sys` are mounted because maintainer
 * scripts read them; no package in the measured set *failed* without them,
 * so that half is prudence, not measurement.
 *
 * All three are unmounted before the step returns. `/init`'s epilogue would
 * catch them anyway (it unmounts every `/mnt` path in reverse order), but a
 * mount that outlives its step should be this step's failure, not a number in
 * the next one's status frame.
 */
function chrootHelper(arch: GuestScriptArch): readonly string[] {
  const loaders = TARGET_LOADERS[arch];
  return [
    "qi_chroot_enter() {",
    '  mkdir -p "$1/proc" "$1/sys" "$1/dev"',
    '  mountpoint -q "$1/proc" || mount -t proc none "$1/proc"',
    '  mountpoint -q "$1/sys" || mount -t sysfs none "$1/sys"',
    '  mountpoint -q "$1/dev" || mount -o bind /dev "$1/dev"',
    // The probe, not a precondition: a statically linked /bin/sh passes it
    // with no loader present at all.
    '  chroot "$1" /bin/sh -c : 2>/dev/null && return 0',
    '  qi_chroot_diagnose "$1"',
    "}",
    "qi_chroot_diagnose() {",
    '  [ -e "$1/bin/sh" ] || {',
    '    echo "qi: chroot: the target has no /bin/sh (a dangling symlink ' +
    "counts). An unpack or copyIn step has to put a rootfs in the image " +
    'before a chroot step can run inside it."',
    "    exit 70; }",
    "  _found=",
    ...loaders.map((loader) =>
      `  [ -e "$1${loader}" ] && _found="$_found ${loader}"`
    ),
    '  [ -n "$_found" ] && {',
    '    echo "qi: chroot into the target failed even though /bin/sh and a ' +
    "loader ($_found) are present. Neither of the two usual causes applies; " +
    "the target's /bin/sh is there and so is its interpreter.\"",
    "    exit 72; }",
    '  echo "qi: chroot into the target failed: /bin/sh exists but the ' +
    `dynamic loader it needs does not. None of${
      loaders.map((l) => ` ${l}`).join("")
    } ` +
    "is in the target. chroot's own message names the BINARY (\\\"can't " +
    "execute '/bin/sh': No such file or directory\\\") because execve() " +
    "reports ENOENT for a missing INTERPRETER, not for the file it was " +
    "handed — which is why that message is misread as a missing shell every " +
    'time. Unpack a complete rootfs, or copy the loader in."',
    "  exit 71",
    "}",
    "qi_chroot_leave() {",
    // Failures are swallowed here and left to the epilogue, which retries
    // every /mnt mount and reports the result as umountRc in the status frame.
    // Swallowing them locally would hide nothing: it just moves the signal.
    '  umount "$1/dev" 2>/dev/null || true',
    '  umount "$1/sys" 2>/dev/null || true',
    '  umount "$1/proc" 2>/dev/null || true',
    "}",
  ];
}

/**
 * Lend the appliance's resolver to the chroot for the length of one step.
 *
 * `/init` writes `/etc/resolv.conf` in the *initramfs* when `qi.dns=` is
 * passed; a chrooted `apk` reads the *target's*. Copying it in is the only way
 * the two meet — and removing it again is the only way the build host's
 * resolver does not ship inside the image. Alpine's minirootfs has no
 * `/etc/resolv.conf` at all (measured), so for that case the restore is a
 * delete.
 *
 * The existence test is `-e` **or** `-L`, and the copies are `cp -P`. Three
 * measurements in this appliance force that shape, all against
 * `/etc/resolv.conf -> ../run/systemd/resolve/stub-resolv.conf` — a DANGLING
 * symlink, which is what every Debian and Ubuntu cloud image ships, since the
 * target does not exist until `systemd-resolved` runs:
 *
 * - `[ -e ]` is **false** for it and `[ -L ]` true. With `-e` alone the save
 *   never happens, and the restore then deletes the image's own symlink — a
 *   networked step in one of those images ships an artifact whose resolver
 *   configuration this build removed.
 * - plain `cp` of it fails, `cp: can't stat …: No such file or directory`,
 *   rc 1 — which `/init`'s `set -e` turns into a dead step. So widening the
 *   test without `-P` trades a silent wrong artifact for a broken build.
 * - `cp -P` copies the LINK, rc 0, target preserved.
 *
 * Also measured: busybox `cp` REPLACES a symlink destination rather than
 * writing through it, so installing over the image's link cannot leak the
 * host's resolver to wherever that link pointed.
 */
const RESOLV_HELPER: readonly string[] = [
  "QI_RESOLV_SAVED=0",
  // Whether install actually WROTE. Restore undoes only what install did:
  // install returns early when the APPLIANCE has no resolver of its own, and
  // an unconditional delete in restore would then remove the image's own
  // /etc/resolv.conf — one install never touched. That ships an image which
  // builds, boots, and silently cannot resolve anything.
  "QI_RESOLV_WROTE=0",
  "qi_resolv_install() {",
  "  [ -f /etc/resolv.conf ] || return 0",
  '  mkdir -p "$1/etc"',
  '  if [ -e "$1/etc/resolv.conf" ] || [ -L "$1/etc/resolv.conf" ]; then',
  '    cp -P "$1/etc/resolv.conf" /qi/resolv.saved; QI_RESOLV_SAVED=1',
  "  fi",
  '  cp /etc/resolv.conf "$1/etc/resolv.conf"',
  "  QI_RESOLV_WROTE=1",
  "}",
  "qi_resolv_restore() {",
  '  [ "$QI_RESOLV_WROTE" = 1 ] || return 0',
  // Before the restore, and reached only when install wrote: what install
  // left behind is the BUILD HOST's resolver, and it must not ship inside the
  // image whether or not there was something to put back. `rm -f` then
  // `cp -P` is the measured pair — restore was measured putting a dangling
  '  rm -f "$1/etc/resolv.conf"',
  '  if [ "$QI_RESOLV_SAVED" = 1 ]; then',
  '    cp -P /qi/resolv.saved "$1/etc/resolv.conf"',
  "  fi",
  "}",
];

/** Single-quote a value for `ash`, closing and reopening around each quote. */
function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new Error(
      `${JSON.stringify(value)} holds a NUL byte, which cannot survive an ` +
        "argv. The generated script would silently truncate at it.",
    );
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
