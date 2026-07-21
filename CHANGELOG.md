# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, breaking
changes ride a minor bump.

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
