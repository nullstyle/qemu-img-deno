# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, breaking
changes ride a minor bump.

## [0.1.0] — Unreleased

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
