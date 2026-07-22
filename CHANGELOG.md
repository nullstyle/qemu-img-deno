# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, breaking
changes ride a minor bump.

## [0.3.0] — Unreleased

Groundwork for building disk images from scratch. The mechanism that makes it
possible on a host with no Linux image tooling: qemu's own block drivers. A
`raw` node with `offset`/`size` is a **window** onto a larger image, so bytes
can be written into one partition without touching its neighbours — and the
filesystems that go into those windows are written here, in TypeScript, so an
ESP gets built on a machine with no `mkfs.fat` and no root.

### A native FAT12/16/32 writer replaces qemu's `vvfat`

`src/fs/fat.ts` is a conformant FAT writer, and it removes three constraints
that were not really about FAT at all — they were about `vvfat`, whose geometry
is **fixed and content-independent**.

- **An ESP is now whatever size you ask for.** `vvfat` yielded exactly 528450048
  usable bytes at FAT16 and 32997888 at FAT12 whatever it held, so `plan()`
  refused every other size in both directions and a recipe wanting a 33 MiB ESP
  could not have one. The geometry now follows the content: measured, the
  smallest FAT12 window holding a 300 KB payload is **330240 bytes**, and a
  realistic ESP tree fits a **2124800-byte** FAT16 volume.
- **FAT32 builds.** It was refused outright, because `vvfat`'s FAT32 output is a
  FAT16-shaped BPB with a doubled allocation table that conformant drivers
  misread.
- **The timestamp workaround is gone, both halves of it.** `vvfat` stamped the
  host's clock into every directory entry and took no time option, so 0.2.1
  copied the whole staging tree to pin mtime and atime, and then rewrote the
  creation fields in the finished filesystem because `st_ctime` cannot be pinned
  from userspace at all. `stageFatTree()`, `normalizeFatTimestamps()` and the
  sparse-raw round-trip that existed to give the normalizer something seekable
  are all deleted. Every timestamp now comes from `determinism.sourceDateEpoch`
  by construction, and two **cold** builds of one recipe produce byte-identical
  ESP bytes — asserted in `smoke:recipe` by content digest.

Validated against implementations sharing no code with this one: `fsck_msdos`
exits 0, the Darwin `msdos` driver mounts every volume and hands back each file
byte-identical with its long name intact, `diskutil` independently agrees on the
FAT type, and `qemu-img` round-trips through qcow2 with `compare` identical.
Volumes were built landing on exactly **4084, 4085, 65524 and 65525** clusters —
both sides of both thresholds that _define_ the three types — and all three
oracles agree on the type for all four.

#### BREAKING

- `VVFAT_USABLE_BYTES` is **removed** from `./recipe`. It named a constraint
  that no longer exists, and a deprecated-but-exported constant is the shape
  that would keep recipes pinned to 504 MiB ESPs forever. Replace
  `size: VVFAT_USABLE_BYTES[16]` with the size you actually want; `plan()` now
  refuses only a window that genuinely cannot hold the tree, and names the byte
  count that would.
- `FilesystemSpec`'s `fat` arm accepts `fatType: 32`.
- `RecipePlanErrorCode`: `fat-window-too-large` is replaced by
  `fat-window-not-formattable` (no geometry of the requested type exists for
  this window), and `fat-window-too-small` now means "cannot hold the staged
  tree" rather than "is not exactly vvfat's fixed size". Two codes are added:
  `fat-unrepresentable-entry` and `fat-tree-unresolved`.
- `./fs` no longer exports `normalizeFatTimestamps`, `FatLayoutError`,
  `FatTimestampOptions` or `FatTimestampReport`. The normalizer repaired
  `vvfat`'s output and has no caller left; keeping it would ship a second FAT
  layout parser with its own assumptions and no path through the build that
  exercises it. `DIR_ENTRY_BYTES` survives unchanged. New: `buildFat`,
  `describeFat`, `fatGeometryFor`, `minimumFatSizeBytes`, `fatEntryShapes`,
  `SECTOR_BYTES`, `CLUSTER_COUNT_THRESHOLDS`, `FatEntry`, `FatEntryShape`,
  `FatOptions`, `FatGeometry`, `FatEntryError`, `FatGeometryError`.

#### Refusals this writer adds

- **Two paths differing only in case.** FAT lookup is case-insensitive, so both
  entries get written and both names resolve to whichever came first. Measured
  on macOS 26.5.2: such a volume passes `fsck_msdos -n`, mounts, lists both
  names in `readdir`, and returns the FIRST entry's bytes for either name. A
  valid image holding less than was staged, with nothing anywhere reporting a
  problem.
- **A `BPB_HiddSec` that is not a uint32.** It was written through
  `DataView.setUint32` unvalidated, so `2**32` landed as `0`, `-1` as
  `0xFFFFFFFF` and `1.5` as `1` — a wrong start LBA rather than a refusal.
- **A geometry whose cluster count does not match the type asked for.** The FAT
  type is `CountofClusters`, never the `FAT16` string in the BPB; a volume one
  cluster the wrong side of a threshold is one whose type every driver disagrees
  about.

#### Also corrected here

- `BPB_RsvdSecCnt` is now the spec's own value — 1 on FAT12/16, 32 on FAT32 —
  with no padding added to align the data region. The spec says "For FAT12 and
  FAT16 volumes, this value should never be anything other than 1", where a
  comment in the writer had claimed the reverse; Apple's `newfs_msdos` agrees,
  emitting `res=1` for a 40 MiB FAT16 volume (first data sector 193, not
  cluster-aligned) and `res=32` for a 400 MiB FAT32 one.
- An explicit `fatType: 32` is no longer refused by the FAT12/16 root-entry
  ceiling, which does not apply to it — the refusal used to tell the caller to
  pass `fatType: 32`.
- Short-name `~N` generation was quadratic: 1000 names 3 ms, 2000 186 ms, 4000
  1642 ms, 8000 9827 ms, because truncation collapses many long names onto one
  six-character stem. `plan()` calls this to size a partition, so it was a pure
  function hanging on a large staging tree. With a per-directory counter the
  same four sizes are 3, 7, 12 and 26 ms.

### Added

- `BlockNodeSpec` / `ImageRef` / `renderBlockNode` — block-driver option graphs,
  accepted by `convert`, `info`, `infoChain`, `map`, `measure` and `compare` in
  place of a path, and rendered to qemu's `key=value,child.key=value` form with
  keys sorted for stable argv. A plain string still emits identical argv. Guards
  refuse, with a `TypeError` naming the fix, the combinations qemu rejects
  later: an option graph alongside a format flag, a `--target-image-opts`
  destination without `noCreate`, one graph operand and one path on `compare`,
  and mixing graphs with multi-source `convert`.
- `ConvertOptions.parallel` (`-m`). Pin to `1` when the output will be hashed;
  `-W` is never emitted.
- `CommandAbortedError.stdout`/`.stderr` — the output the child had already
  produced when the abort fired. A timed-out command is exactly where its last
  line matters most.
- `RunOptions.stdout`/`.stderr` disposition (`"piped"`/`"inherit"`/`"null"`),
  and `DenoCommandRunnerOptions.killGraceMs`.
- `FakeQemuImg.refuseContentOracles` — makes `compare`/`check`/`map` throw
  instead of answering. The fake models no image content, so those three verbs
  are fiction; code whose correctness depends on them should say so rather than
  pass for the wrong reason.
- Smoke coverage for `convert` **with a backing file** (every convert in the
  smoke was previously backing-less, leaving the argv path a backing chain
  depends on unexercised), for option-graph window writes, and for building a
  FAT filesystem via `vvfat` — validated against `/sbin/fsck_msdos`, an
  implementation with no shared code with qemu. (The `vvfat` demo stays in
  `smoke:qemu-img`, where it exercises the driver; the recipe tier no longer
  uses it. `smoke:fat` is the new one, putting this package's own writer in
  front of `fsck_msdos`, the Darwin driver and `qemu-img`.)

- **`./recipe`** — the recipe vocabulary and a deterministic `plan()`.
  `resolveRecipe` replaces every declared input with its digest (the only I/O
  before planning); `plan()` then computes every cache key, partition LBA and
  refusal with no binary, no VM and no clock, so the highest-value tests need no
  fake at all.

  Two keys, never conflated. `RecipeKey` is pure and chains parent _intentions_.
  `RealizationKey` names a layer's directory and folds in the parent's
  **actual** content digest — which is what makes a changed parent a cache miss
  by construction. Without it, changing an early step rebuilds it while
  descendants stay hits, and since a qcow2 overlay is a block-level delta the
  image becomes `merge(parent_now, child_written_against_parent_then)` at
  cluster granularity: it mounts, and `qemu-img check` passes, because qcow2
  records no size, digest or generation counter for a backing file. The digest
  it folds is the parent's **guest-visible content**, not its container bytes:
  an overlay's delta is addressed in guest space, so content is the one thing a
  cached child can be silently wrong about — and container bytes move on their
  own (see _Fixed_).

  Plan-time refusals, each naming its fix: a FAT partition too small for the
  tree staged into it (naming the byte count that fits), an over-long FAT label,
  `uefi-removable` with no `BOOTAA64.EFI`/`BOOTX64.EFI` in the ESP tree, an
  unversioned machine alias, a partition running into the GPT's backup header,
  and staging content a chosen filesystem would silently drop. Capability traits
  are DERIVED from the walked tree, so a symlink nobody noticed still refuses a
  FAT partition.

- **`./fs`** — a GPT writer: protective MBR, header, entry array and the backup
  at the tail, with CRC-32 and mixed-endian GUID serialization. Two details are
  load-bearing. Every byte of the footprint is written explicitly, including the
  127 unused entry slots: on a fresh image assuming zeros is fine, but on a
  qcow2 OVERLAY unwritten clusters read _through_ to the backing file, and stale
  bytes there surface as phantom partition entries. And the backup header is not
  a copy — `MyLBA`/`AlternateLBA` are swapped and its CRC differs, so a
  byte-for-byte duplicate of the primary is invalid in a way some tools accept
  and others reject.
- **`LayerStore` and `build()`** — layers are qcow2 overlays chained by RELATIVE
  backing references, published by renaming a same-depth `<key>.partial`
  sibling. The same-depth part is required, not stylistic: `qemu-img create`
  resolves a backing reference against the target's own directory and opens it
  before creating anything, so a `tmp/<uuid>/` staging dir can never resolve
  `../<parent>/image.qcow2`. Layers are `chmod 0444` and re-verified against
  their recorded **container** digest on every cache hit.
- **`contentDigest()`** — a digest over an image's guest-visible content, read
  through its whole backing chain. Cluster layout, chain depth, allocation
  status and the difference between an unallocated region and a written-out zero
  cluster are all invisible to it; one changed byte is not. It is a layer's
  identity in the store (`StoredLayer.contentSha256`) and what every
  descendant's key chains through, while the container digest keeps the
  tamper-check job it is actually right for. Cost is the image's _allocated_
  bytes, not its virtual size: it flattens to a sparse raw file, then reads only
  the extents `qemu-img map` reports as data. Measured on a 2 GiB image: 20 ms
  holding 4 MiB, 49 ms holding 64 MiB, 152 ms holding 256 MiB.

- **`./system`** — the guest tier, and the `build()` executor that dispatches
  through it. `ApplianceGuestRunner` boots the pinned appliance with the layer's
  own overlay attached, a framed payload carrying the step script, and a status
  disk carrying the answer. `readApplianceIdentity()` records what a guest
  layer's bytes actually depend on — the ABI, the kernel, the initramfs, the
  `/init` digest, the lockfile digest and the qemu version — and re-verifies all
  of it per build; that digest is folded into every guest layer's cache key, so
  bumping Alpine cannot leave a stale layer looking like a hit. Disks are
  addressed by **identity**, not position: roles ride the kernel cmdline as
  serial tokens and the guest resolves them from `/sys/block/vd*/serial`.
  `GuestStepFailedError` — what `build()` throws when a guest step's exit code,
  unmount, `e2fsck` or dmesg scan says the layer must not be published — is
  exported from **both** `./system` and `./recipe`, since `build()` lives on the
  latter. One class, so `instanceof` matches whichever subpath a caller reached
  for; `.name` alone cannot distinguish it from a generic failure.
- **`buildTar` in `./fs`** — a ustar writer, because both host tars lose data
  while exiting `0` (see the guest-tier hazard table). It throws where they
  drop, and emits a GNU `'L'` record for names with no prefix/name split.
- A declared `partition` step carrying an ext4 window now plans as **two**
  layers: `<id>` on the host for the table and any FAT, `<id>:mkfs` in the guest
  for the kernel filesystems. The boundary is a fact about the toolchain — the
  appliance ships `e2fsprogs` and no partitioning tools at all — so a mixed
  ESP-plus-root recipe was previously classified `guest` in its entirety and
  could not be built. Every layer before the first guest one now builds and
  caches without an appliance present.
- Building from an existing base image (`base.kind: "image"`), which now
  requires a declared `virtualSizeBytes` and `rootPartition`. The virtual size
  is declared rather than probed because `plan()` runs no binary, and the only
  size available to it is the _file's_ — which for a sparse qcow2 is nowhere
  near the disk's. `build()` checks it against `qemu-img info` and refuses a
  mismatch.
- **Customizing an existing cloud image, exercised end to end.** The
  `base.kind: "image"` path had never been run against a real one. It is now,
  against a sha256-pinned Alpine aarch64 cloud image (`cloud.lock.json`,
  `deno task smoke:cloud`), and the measured facts about that image are in the
  lockfile rather than in prose: 257949696 bytes virtual against 225378304 on
  disk, root on partition 2 as ext4 with 1024-byte blocks, partition 1 a 512 KiB
  FAT ESP, 5507 files, **89% full with ~35 MiB writable**. The build itself
  needed no change — a `copyIn` and a `run` landed and `e2fsck` stayed clean on
  the first try. What needed changing was every way of getting it wrong.

  A `run`/`copyIn` step now **preflights the root partition** before touching
  it. A declared layout is cross-checked against the kernel's own parse of the
  GPT; an existing image has no planned geometry to check against, so
  `rootPartition` was a number nothing verified. Pointing it at Alpine's FAT ESP
  used to arrive as `mount: … Invalid argument` followed by twelve lines of
  e2fsck superblock-recovery advice — because the device was registered for
  `/init`'s `e2fsck` epilogue _before_ the mount was attempted, so the checker
  ran on FAT too. The node is now waited for (exit `68`, listing the partitions
  that do exist) and `blkid` must report ext2/3/4 (`69` unrecognizable, `70`
  something else, named) **before** anything is registered or mounted.

  `blkid` is parsed, not queried. busybox 1.37.0's applet takes `[BLOCKDEV]...`
  and nothing else: it accepts `-s TYPE -o value` silently and prints the whole
  line anyway, so the util-linux spelling compares
  `/dev/vda2: LABEL="/" … TYPE="ext4"` against `ext4` and rejects a good root.
  It also exits `0` on a device with no filesystem, so the empty output is the
  signal and the status is not. `ext2` and `ext3` are accepted because the ext4
  driver mounts them — measured, both at rc 0, both reported as `ext4` in
  `/proc/mounts`.

- `BaseImageSizeMismatchError`, replacing a bare `Error` — and splitting by
  direction, because the two disagreements mean different things. Declaring
  **more** than the image holds is the only way a recipe can spell a grow, and
  growing is refused with the reason: `resize()` on this image left the primary
  GPT header untouched, so `AlternateLBA` and `LastUsableLBA` still named the
  old final sector, the backup header stayed stranded where the disk used to
  end, and `+1G` yielded 1 GiB outside every partitioner's usable range. Linux
  parsed the table and mounted it anyway, since it reads the primary — which is
  why this is refused rather than left to be discovered later. Declaring
  **less** is a plain misreading and says so. An absent `virtual-size` from
  `qemu-img info` is also refused now rather than treated as a match.
- A failed `copyIn` extraction prints `df` for the target root. Cloud images
  ship nearly full, so ENOSPC is the likeliest failure, and busybox tar reports
  only `tar: write error: No space left on device` — naming neither the
  filesystem nor how full it was. Deliberately diagnosis and not a guard: the
  archive's byte count is not the space it occupies after ext4 rounds every file
  up to a block, so a precheck would refuse builds that fit. Measured, the step
  exits `71`, `e2fsck` still passes, and only the base layer publishes.
- Plan-time refusals for the guest tier: a step id containing `:` (reserved for
  generated layers), a `run`/`copyIn` step with no unambiguous root filesystem,
  a non-absolute or non-normalized `copyIn` destination, a `copyIn` tree the
  ustar transport would flatten, a file too large for a ustar size field, a
  partition step laid over an existing base image, and a guest step planned with
  no appliance identity.

- `LayerStore` concurrency and garbage collection. `begin()` now takes an
  exclusive advisory lock on the key and holds it until `publish()` or the new
  `abandon()`; without it two builds that miss the same key both do the work —
  for a guest layer, two VM boots for one result — and a reader can briefly see
  the loser's bytes under the winner's key. `gc({ keep })` deletes every layer
  not reachable from the given roots, following the backing chain so that
  keeping a leaf keeps every ancestor it reads through; deleting a parent would
  leave a child reading someone else's clusters. A contended layer is skipped,
  never waited on, so a collection can never deadlock against a build. Manifests
  gained `parentRealizationKey` to make that walk possible without opening every
  image.

- **A `unpack` step and `run({ chroot: true })`** — a distro rootfs installed by
  its own package manager, which is the use case the recipe tier existed for and
  could not do. `unpack` is a step rather than a base because layer 0 is the
  DISK: a rootfs goes into a partition that does not exist until the table and
  the mkfs layer have run. The archive is handed to the guest as the data disk
  exactly as `copyIn`'s generated ustar is, and the host never decompresses.
  Measured end to end on aarch64: GPT + FAT ESP + ext4 + the 3.8 MiB Alpine
  3.21.7 minirootfs + `apk add --no-cache nginx` over the network is **five
  layers in 2.3 s**, two guest boots included.

  The compression is **sniffed from the archive's leading bytes**, never read
  off its name — the resolver reads only the first 8, and a filename is the one
  thing about an archive that is free to lie. `plan()` then refuses what the
  guest cannot unpack, for two different measured reasons: zstd has no applet in
  the appliance at all, and **xz** extracts every member correctly and then
  exits `1` with `tar: corrupted data`, because busybox's xz reader does not
  stop at the end of the stream and runs into the zero padding qemu adds
  rounding a data disk up to 512 bytes. Plain tar, gzip, bzip2 and lzma were
  each measured extracting at exit `0` over that same transport.

  The extraction passes **`--numeric-owner`**. Without it busybox `tar` resolves
  each member's `uname`/`gname` against the **appliance's** `/etc/passwd` and
  `/etc/group` — the target's cannot be consulted, it is a mounted directory and
  not the running system — so a rootfs lands owned by whatever those names mean
  inside the build appliance, and the image builds, mounts and boots that way.
  Measured in the appliance rather than read off `tar --help`, which in this
  applet advertises options it does not implement: extracting an archive whose
  members carry uid/gid **123/456** under `uname=root`/`gname=root`, as uid 0,
  gave `0:0` for both the file and the directory without the flag and `123:456`
  with it. Argv position was measured not to matter.

  `run({ chroot: true })` mounts `/proc`, `/sys` and a **bind of `/dev`** under
  the target before entering it. The `/dev` bind is not hygiene: without it
  `apk add nginx` exits `0`, reports `OK: 9 MiB in 17 packages`, and leaves a
  0-byte **regular file** at `/dev/null` that a post-install script's
  `> /dev/null` created — after which every redirect in the shipped image
  appends to a file. With `network`, the resolver is lent to the target for the
  step and taken back afterwards, so the build host's `/etc/resolv.conf` does
  not ship inside the image.

  The chroot's failure path is the part worth stating plainly. A chroot into a
  root without its dynamic loader fails with
  `chroot: can't execute '/bin/sh': No such file or directory` — naming a file
  that is right there, because `execve()` reports `ENOENT` for the missing
  INTERPRETER. Measured by hiding `/lib/ld-musl-aarch64.so.1` in an otherwise
  complete Alpine rootfs: rc 127, and the identical message for `/bin/busybox`,
  `/bin/sh` and `/sbin/apk` alike. The generated script therefore **probes**
  with `sh -c :` first and only on failure diagnoses, exiting 70 (no `/bin/sh`),
  71 (no loader, naming the paths it looked for) or 72 (neither explains it).
  Probing rather than pre-checking is deliberate: a statically linked shell
  needs no loader, and refusing that rootfs would be a guess.

  `chroot` is in the cache key — the same script beside the target and inside it
  are different programs against different roots — and a networked step and its
  descendants stay uncacheable, unchanged.

### Fixed

- **A guest layer's container bytes are not reproducible, and every descendant's
  cache key was chained through them.** A qcow2 written by a booted guest
  records cluster and refcount ordering that follows I/O completion order, so
  two boots that produce a byte-identical filesystem still produce different
  container digests: measured on the system smoke's `table:mkfs` layer, at least
  four distinct digests — same 2424832-byte length, same content,
  `qemu-img compare --strict` identical on every pair. Because
  `realizationKey()` folded the parent's `containerSha256`, a rebuilt guest
  layer renamed every directory beneath it and forced a full downstream rebuild
  for no semantic reason — including another VM boot per guest layer. Keys now
  chain through `contentDigest()`. The on-disk tamper check is unchanged and
  still container-based: it is the bytes on disk, which is exactly right for
  catching a layer edited in place, and strictly stronger than content equality.
  Preimage bumped to `qemu-img-realization@2`, so keys minted under the old
  scheme are unreachable rather than merely unlikely to hit.
- **`smoke:system` asserted byte-identical containers where it meant an
  identical filesystem**, and so failed on the above — 5 runs in 10, flaky in
  the worst direction: red while the property it meant to test held. It now
  digests the ext4 partition's guest-visible bytes through a `raw` window on the
  **mkfs layer** — never the finished artifact, whose `copyIn` layer mounts the
  filesystem read-write and stamps `s_mtime`/`s_wtime`/`s_mount_count` with no
  way back — then cross-checks the whole layer with `qemu-img compare` and with
  the content digest a key folds, and asserts that two cold stores agree on
  every realization key. The container and `--strict` comparisons are printed as
  observations rather than asserted: `--strict` compares allocation status,
  which is the same class of container property (`smoke:recipe` now demonstrates
  it calling a content-identical image different).
- **A networked `chroot` step silently had no resolver in every Debian and
  Ubuntu cloud image.** The save guard tested `[ -e "$1/etc/resolv.conf" ]`,
  which is **false for a dangling symlink** — and that is exactly the shape
  those images ship (`/etc/resolv.conf -> ../run/systemd/resolve/stub-…`, whose
  target does not exist until `systemd-resolved` runs). So nothing was saved,
  and the restore then deleted the image's own symlink: the step ran against a
  resolver that was not there, and the artifact shipped with its resolver
  configuration removed. The test is now `-e` **or** `-L`, and both copies are
  `cp -P` — measured, plain `cp` of a dangling symlink fails
  `cp: can't stat …: No such file or directory` at rc 1, which `/init`'s
  `set -e` turns into a dead step, so widening the test alone would have traded
  a wrong artifact for a broken build. The delete is now unconditional and runs
  before the restore, since what the install left behind is the build host's
  resolver either way.
- **`qi_mount_root` was called with one argument from three of its four call
  sites**, so its diagnostics printed `partition` with nothing after it. The
  helper takes the device _and_ the recipe's declared 1-based partition number,
  and the number is the whole point of messages like
  `$1 never appeared, so partition $2 is not in this image` — which exist to
  send a reader to `base.rootPartition`.
- **`LayerStore.publish()` could never re-publish a key.** `rename` onto a
  non-empty directory is `ENOTEMPTY`, and an uncacheable layer skips the cache
  lookup and so reaches `publish()` on _every_ run — meaning any recipe with a
  `network: true` step failed on its second build with a raw Deno error.
- **A layer manifest recorded an absolute path**, which broke the relocatability
  the store's own module doc promises. A _moved_ store threw `ENOENT`; worse, a
  **copied** store verified clean and handed back the original's bytes, because
  both the digest and the path it checked still described the file left behind.
  The manifest is now root-relative.
- `plan()` derived an image base's disk size from the resolver's **file** size,
  and `build()` hardcoded `0` for the same case — so a GPT over an image base
  would have been laid out for the wrong disk, or for a zero-sector one.
- `UnrepresentableContentError` never fired for `copyIn`: the check ran only
  from `planLayout`, leaving the one step kind whose entire job is moving a host
  tree into an image as the one kind with nothing verifying it arrived whole.
- `timeoutMs` was not a wall-clock deadline. The abort raced the child's
  _captured output_, and a pipe stays readable while any grandchild holds its
  write end — so `sh -c 'echo x; sleep 5'` with a 500 ms timeout blocked for the
  full 5 s (measured: 5010 ms). It now races the exit status and escalates
  `SIGTERM` → grace → `SIGKILL`, guaranteeing the child is reaped. The existing
  test used bare `sleep 5`, which has no children, so the suite never saw it.
- `CommandAbortedError` discarded output the runner already held.
- **A `timeoutMs` deadline kept the process alive after the command finished.**
  `AbortSignal.timeout()` uses a _referenced_ timer, so a run with
  `timeoutMs: 120_000` that completed in 300 ms still held the event loop open
  for the remaining two minutes. The deadline is now an owned timer cleared on
  every exit path. The existing tests could not see it: they use short timeouts
  that simply fire.
- **`FakeQemuImg` silently mis-parsed long flags.** `positionalsOf` skipped any
  unrecognized `--flag` and treated its value as a positional, so
  `create -f qcow2 --backing base.qcow2 --backing-format qcow2 /out.qcow2`
  registered an image at path `base.qcow2`, clobbered the real base's state,
  never created `/out.qcow2`, and returned exit 0 — every assertion downstream
  passing against an image that was never built. Unrecognized flags now throw,
  and each subcommand's flag table covers both the short spellings and the long
  ones, including the backing flags qemu-img 11.0 renamed in opposite directions
  (`create`'s backing _format_ `-F` → `-B`; `convert`'s backing _file_ `-B` →
  `-b`). Both spellings still parse on 11.0.2, so the client's emission is
  unchanged.

### Tooling (not published)

- `deno task appliance [--arch=aarch64|x86_64]` builds the guest-tier build
  appliance — a kernel plus an initramfs that runs one step script against
  attached disks and reports a framed status record. Inputs are pinned in
  `appliance.lock.json` and verified by sha256; Alpine publishes `.sha256`,
  `.sha512` and a GPG `.asc` for both. Three things it has to get right: the
  kernel builds virtio as **modules** (`CONFIG_VIRTIO_BLK=m` on both arches), so
  the appliance layers over Alpine's module-carrying initramfs and relies on
  concatenated cpio members resolving later-wins; block devices reject unaligned
  reads, so the payload is sector-framed with an explicit length; and
  `kernel_power_off()` does not sync, so the status record is fsynced.
- `deno task smoke:cloud` customizes a pinned cloud image and checks the one
  property a customize flow lives or dies by: that everything it did **not**
  touch is untouched. It fingerprints the pristine base in the guest (path-set
  digest, file count, `/etc/os-release` sha256), builds a `copyIn` and a `run`
  on top, and re-fingerprints — plus refusal coverage for a FAT `rootPartition`,
  a partition number the image lacks, and a declared grow. Skips cleanly, exit
  0, with no qemu, no appliance, or no cached image and no network.
  `cloud.lock.json` is separate from `appliance.lock.json` on purpose: the
  latter's digest is folded into every guest layer's cache key, so adding a
  section to it would invalidate every built appliance and cached layer for an
  image the appliance never touches. Alpine publishes `.sha512` but no `.sha256`
  sidecar for these, so the lockfile records the published sha512 and the sha256
  over those same verified bytes.
- `deno task appliance:run [--arch=…] [--target=…] <step.sh>` runs a step inside
  it. Measured: **0.3 s** on aarch64 under `hvf`, **5.6 s** for x86_64 under TCG
  emulation on Apple Silicon. Guests run with `-nic none`.

### Changed

- **Breaking (`./testing`):** `FakeQemuImg` now throws on an argv flag the
  subcommand does not declare, rather than skipping it. A downstream test
  driving an undeclared flag through `raw()` will start failing — which is the
  point.
- `ConvertOptions.format` is now optional, required only for a path destination.
  An option-graph destination carries its own `driver`.

## [0.2.1] — Unreleased

An adversarial re-review of 0.2.0 found a crash reachable from the typed API and
several hazard notes that were wrong on the facts.

### Fixed

- `convert({ backing: "" })` emitted `-B ""`. Combined with a `backingFormat`,
  that **segfaults** qemu-img 11.0.2 (SIGSEGV, reproduced 3/3) after writing a
  partial destination; without one it errors out. The flag is now omitted for an
  empty `backing`, which is what it meant anyway.
- `check`'s note claimed a truncated copy with intact metadata passes clean. It
  does not: qcow2 flags a copy short by a full cluster or more (exit `2`,
  dangling L2 entries). The real blind spots — now documented — are an
  incomplete-but-consistent image, a shortfall under one `cluster_size`, VDI
  (misses truncation entirely), and raw (no check at all).
- `convert`'s URL note blamed stalls, which actually fail loudly (exit `1`). The
  silent exit-`0` truncation comes from a server under-reporting the object's
  length.
- `salvage`'s note claimed it matters for truncated sources. It does not — a
  truncated source zero-fills past EOF with the flag off — so the note now
  covers damaged reads only, and mentions that the per-region warnings go to
  discarded stderr.
- `shrink`'s note prescribed shrinking the guest filesystem first, which does
  not save the backup GPT header; a post-shrink `sgdisk -e` is required.
- The `rebase` guard's message pointed at safe mode and `convert()`, both of
  which need a readable base — impossible in the case that most often reaches
  the guard, a base that was moved or deleted.

### Added

- `RebaseOptions.acknowledgeDataLoss` — opts back in to the guarded pair. The
  guard judges options alone and never opens the image, so it also refuses the
  shapes where the pair is harmless (no backing file at all, a fully allocated
  overlay) or is the only repair (a missing base). Keeping that inside the typed
  API beats dropping to `raw()`.
- README rows for two unguarded neighbors: unsafe rebase onto a _wrong but
  openable_ backing (equally destructive, not shaped precisely enough to catch),
  and `dd` overwriting an existing output.

## [0.2.0] — 2026-07-21

### Added

- `QemuImgUnsafeOperationError`, for argv combinations that are valid `qemu-img`
  but destroy data silently. Guards are always escapable — `raw()` still passes
  argv through untouched.

### Changed

- **Breaking:** `rebase` now throws `QemuImgUnsafeOperationError` when `unsafe`
  is combined with an empty `backing`. That pair rewrites the backing reference
  without copying the base's clusters down, so everything the overlay never
  wrote reads back as zeros — and consumers that validate images (Lima among
  them) accept the result happily. Flatten with `rebase(path, { backing: "" })`
  in safe mode, or with `convert()`.

Hazards found by auditing what this package makes reachable, documented rather
than refused since each is legitimate for some caller. **Several of these notes
turned out to be wrong on the facts — see 0.2.1**, which corrects the `check`,
URL, `salvage` and `shrink` entries:

- `ConvertOptions.options` — `{ compression_type: "zstd" }` is accepted by qemu
  but unreadable by pure-Go qcow2 readers (Lima's `go-qcow2reader` implements
  DEFLATE only). Prefer `compress: true` (zlib) for portable images.
- `ConvertOptions.salvage` — turns source read errors into zero-filled regions
  and still exits `0`, silently producing a wrong image.
- `convert` — sources are spliced into argv verbatim, so `http(s)://`, `ssh://`
  and `nbd://` URLs work; a stalled transfer can leave a truncated output that
  exits `0`, which `check` will then call clean.
- `check` — validates internal structure, not completeness; a truncated copy
  with intact metadata passes. Use `compare` to verify content.
- `ResizeOptions.shrink` — discards everything past the new end, including a
  GPT's backup header in the final sectors.

## [0.1.0] — 2026-07-21

### Added

- `QemuImg` client covering every `qemu-img` subcommand — `amend`, `bench`,
  `bitmap`, `check`, `commit`, `compare`, `convert` (multi-source), `create`,
  `dd`, `info`/`infoChain`, `map`, `measure`, `rebase`, `resize`, and a
  `snapshot` ops namespace — plus `available`/`ensureAvailable`/`version` and a
  `raw()` argv escape hatch. Argv shapes are fixed and test-pinned.
- Typed results hand-narrowed from the JSON output forms: `QemuImgInfo` (with
  snapshots and backing-chain support), `CheckResult` (exit codes `0`/`2`/`3` as
  data), `MapExtent`, `MeasureResult`, `CompareResult` (exit-code contract),
  `SnapshotInfo` — unknown fields always survive in `raw`.
- The injectable subprocess seam (`./runner`): `CommandRunner`,
  `DenoCommandRunner` (bounded capture, `uncapped` escape hatch,
  AbortSignal/timeout composition), `runChecked`, `CommandError`,
  `CommandAbortedError`. Field-identical to `@nullstyle/lima`'s seam so runners
  and fakes interoperate structurally.
- The test kit (`./testing`): `FakeQemuImg`, a recording, stateful in-memory
  qemu-img (images with formats/sizes/backing/snapshots/bitmaps, full argv
  dispatch, `onConvert` hook, one-shot `stub` failure injection,
  `commandLines()` assertions).
- Typed errors: `QemuImgMissingError` (with install hint), `QemuImgOutputError`.
- Real-binary smoke (`deno task smoke`) exercising the whole surface and
  validating every parser against real qemu-img output.
