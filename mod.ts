/**
 * `@nullstyle/qemu-img` — a typed driver for QEMU's `qemu-img` disk-image
 * tool, for Deno.
 *
 * Every subcommand is covered (`amend`, `bench`, `bitmap`, `check`, `commit`,
 * `compare`, `convert`, `create`, `dd`, `info`, `map`, `measure`, `rebase`,
 * `resize`, `snapshot`), driven through an injectable subprocess seam
 * ({@linkcode CommandRunner}) so downstream code is testable with the
 * stateful fake on the `./testing` subpath — no `qemu-img` binary needed.
 * Subcommands with a JSON form return typed, hand-narrowed results.
 *
 * The runner seam is kept field-identical to `@nullstyle/lima`'s: any runner
 * or fake written for one package satisfies the other via structural typing.
 *
 * @example Create, inspect, and convert an image
 * ```ts
 * import { QemuImg } from "@nullstyle/qemu-img";
 *
 * const qemu = new QemuImg();
 * await qemu.ensureAvailable();
 * await qemu.create("/tmp/disk.qcow2", { format: "qcow2", size: "1G" });
 * const info = await qemu.info("/tmp/disk.qcow2");
 * console.log(info.format, info.virtualSizeBytes);
 * await qemu.convert("/tmp/disk.qcow2", "/tmp/disk.raw", { format: "raw" });
 * ```
 *
 * @module
 */

// The subprocess seam:
export {
  CommandAbortedError,
  CommandError,
  type CommandResult,
  type CommandRunner,
  DenoCommandRunner,
  type DenoCommandRunnerOptions,
  MAX_CAPTURE_BYTES,
  runChecked,
  type RunOptions,
} from "./src/runner.ts";

// Options:
export { type CallOptions, type QemuImgOptions } from "./src/options.ts";

// Errors:
export {
  QemuImgMissingError,
  QemuImgOutputError,
  QemuImgUnsafeOperationError,
} from "./src/errors.ts";

// Version:
export { parseQemuImgVersion, type QemuImgVersion } from "./src/version.ts";

// Typed results & parsers:
export {
  type CheckResult,
  type CompareResult,
  type MapExtent,
  type MeasureResult,
  parseCheckResult,
  parseMapExtents,
  parseMeasureResult,
  parseQemuImgInfo,
  parseQemuImgInfoChain,
  type QemuImgInfo,
  type SnapshotInfo,
} from "./src/results.ts";

// The client:
export {
  type AmendOptions,
  type BenchOptions,
  type BitmapAction,
  type BitmapOptions,
  type BlockNodeSpec,
  type CheckOptions,
  type CommitOptions,
  type CompareOptions,
  type ConvertOptions,
  type CreateOptions,
  type DdOptions,
  type FormatOptions,
  type ImageFormat,
  type ImageRef,
  type InfoOptions,
  type MapOptions,
  type MeasureOptions,
  QemuImg,
  type RebaseOptions,
  renderBlockNode,
  type ResizeOptions,
  type SizeValue,
  type SnapshotOps,
} from "./src/qemu_img.ts";
