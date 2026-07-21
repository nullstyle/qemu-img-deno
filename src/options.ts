/**
 * Shared client option types and the run-option composition helper.
 *
 * @module
 */

import {
  type CommandRunner,
  DenoCommandRunner,
  type RunOptions,
} from "./runner.ts";

/** Options for {@linkcode import("./qemu_img.ts").QemuImg}. */
export interface QemuImgOptions {
  /** The subprocess seam. @default new DenoCommandRunner() */
  readonly runner?: CommandRunner;
  /** `qemu-img` binary. @default "qemu-img" */
  readonly bin?: string;
  /** Default abort signal composed into every run. */
  readonly signal?: AbortSignal;
  /** Default per-command timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Per-call cancellation overrides accepted by every verb. */
export interface CallOptions {
  /** Abort this call (composed with the client-default signal). */
  readonly signal?: AbortSignal;
  /** Deadline for this call; overrides the client default. */
  readonly timeoutMs?: number;
}

/** {@linkcode QemuImgOptions} with defaults applied. */
export interface ResolvedOptions {
  readonly runner: CommandRunner;
  readonly bin: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Apply defaults to a {@linkcode QemuImgOptions}. */
export function resolveOptions(options: QemuImgOptions = {}): ResolvedOptions {
  return {
    runner: options.runner ?? new DenoCommandRunner(),
    bin: options.bin ?? "qemu-img",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

/**
 * Compose client-default and per-call cancellation into {@linkcode RunOptions}.
 * Both signals abort the run when either fires; a per-call timeout overrides
 * the client default.
 */
export function buildRunOptions(
  defaults: ResolvedOptions,
  call: CallOptions = {},
  extra: Pick<RunOptions, "stdin" | "uncapped"> = {},
): RunOptions {
  const signals = [defaults.signal, call.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1
    ? signals[0]
    : AbortSignal.any(signals);
  const timeoutMs = call.timeoutMs ?? defaults.timeoutMs;
  return {
    ...extra,
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
