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
can be written into one partition without touching its neighbours, and the
`vvfat` driver synthesizes a FAT filesystem from a host directory — which is how
an ESP gets built on a machine with no `mkfs.fat`.

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
  implementation with no shared code with qemu.

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
  records no size, digest or generation counter for a backing file.

  Plan-time refusals, each naming its fix: a FAT partition below vvfat's fixed
  geometry (528450048 bytes at FAT16, regardless of content), an over-long FAT
  label, `uefi-removable` with no `BOOTAA64.EFI`/`BOOTX64.EFI` in the ESP tree,
  an unversioned machine alias, a partition running into the GPT's backup
  header, and staging content a chosen filesystem would silently drop.
  Capability traits are DERIVED from the walked tree, so a symlink nobody
  noticed still refuses a FAT partition.

### Fixed

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
