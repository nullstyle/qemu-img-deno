# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, breaking
changes ride a minor bump.

## [0.2.0] — Unreleased

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

### Documented

Hazards found by auditing what this package makes reachable. All are real
`qemu-img` behaviors, verified against 11.0.2; each is legitimate for some
caller, so the fix is documentation rather than refusal:

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
