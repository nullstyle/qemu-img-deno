/**
 * The injectable subprocess seam every external command flows through.
 *
 * The real implementation is {@linkcode DenoCommandRunner} (backed by
 * `Deno.Command`); tests inject a recording fake — see the `./testing`
 * subpath's `FakeQemuImg` — and assert the exact argv sequence WITHOUT a
 * `qemu-img` binary on PATH.
 *
 * A runner never throws on a nonzero exit: some subcommands (`check`,
 * `compare`) report through exit codes. Callers that require success use
 * {@linkcode runChecked}, which throws a typed {@linkcode CommandError}.
 *
 * This interface is kept field-identical to `@nullstyle/lima`'s runner seam
 * on purpose: the two packages share no dependency, but any runner (or fake)
 * written for one satisfies the other via structural typing.
 *
 * @example Run a command and capture its output
 * ```ts
 * import { DenoCommandRunner, runChecked } from "@nullstyle/qemu-img/runner";
 *
 * const runner = new DenoCommandRunner();
 * const result = await runChecked(runner, "qemu-img", ["--version"]);
 * console.log(result.stdout.trim());
 * ```
 *
 * @module
 */

/** Result of running one command (stdout/stderr captured, bounded). */
export interface CommandResult {
  /** `true` iff the process exited with code 0. */
  readonly success: boolean;
  /** The process exit code. */
  readonly code: number;
  /** Captured stdout, decoded as UTF-8 (bounded by the capture cap). */
  readonly stdout: string;
  /** Captured stderr, decoded as UTF-8 (bounded by the capture cap). */
  readonly stderr: string;
}

/** Per-run options. `signal`/`timeoutMs` are additive — fakes may ignore them. */
export interface RunOptions {
  /** Bytes piped to the child's stdin. */
  readonly stdin?: string;
  /**
   * Skip the {@linkcode MAX_CAPTURE_BYTES} cap on captured output. The cap
   * defends against unbounded output; a few commands legitimately produce
   * large output that must be captured whole (e.g. `map` on a fragmented
   * image). @default false
   */
  readonly uncapped?: boolean;
  /** Abort the run: the child is killed and {@linkcode CommandAbortedError} is thrown. */
  readonly signal?: AbortSignal;
  /** Deadline sugar: composed with `signal` via `AbortSignal.any`. */
  readonly timeoutMs?: number;
}

/** The seam: run one command, capture its result. */
export interface CommandRunner {
  /** Run one command to completion and capture its result. */
  run(
    bin: string,
    args: readonly string[],
    options?: RunOptions,
  ): Promise<CommandResult>;
}

/** Raised when a command that must succeed does not. */
export class CommandError extends Error {
  /** The binary that ran. */
  readonly bin: string;
  /** The argv it ran with. */
  readonly args: readonly string[];
  /** The nonzero exit code. */
  readonly code: number;
  /** Captured stderr (bounded). */
  readonly stderr: string;

  /** Build the error from a failed {@linkcode CommandResult}. */
  constructor(result: CommandResult, bin: string, args: readonly string[]) {
    super(
      `command failed (exit ${result.code}): ${bin} ${args.join(" ")}${
        result.stderr.length > 0 ? `\n${result.stderr.trim()}` : ""
      }`,
    );
    this.name = "CommandError";
    this.bin = bin;
    this.args = [...args];
    this.code = result.code;
    this.stderr = result.stderr;
  }
}

/** Raised when a run is aborted (signal or `timeoutMs`) before the child exits. */
export class CommandAbortedError extends Error {
  /** The binary that was running (or about to run). */
  readonly bin: string;
  /** The argv it ran with. */
  readonly args: readonly string[];

  /** Build the error; `reason` becomes the `cause`. */
  constructor(bin: string, args: readonly string[], reason?: unknown) {
    super(`command aborted: ${bin} ${args.join(" ")}`, { cause: reason });
    this.name = "CommandAbortedError";
    this.bin = bin;
    this.args = [...args];
  }
}

/** Default stdout/stderr capture cap in bytes (64 KiB). */
export const MAX_CAPTURE_BYTES = 64 * 1024;

/** Options for {@linkcode DenoCommandRunner}. */
export interface DenoCommandRunnerOptions {
  /** Capture cap in bytes when a run is not `uncapped`. @default MAX_CAPTURE_BYTES */
  readonly captureLimit?: number;
}

/**
 * Default runner backed by `Deno.Command`. Captures stdout/stderr (bounded,
 * byte-accurate — a capped capture may end with a replacement character when
 * the cut falls inside a UTF-8 sequence), pipes `stdin` when provided, kills
 * the child when the composed abort signal fires, and never throws on a
 * nonzero exit — the caller decides whether a nonzero code is fatal.
 */
export class DenoCommandRunner implements CommandRunner {
  readonly #captureLimit: number;

  /** Create a runner, optionally overriding the capture cap. */
  constructor(options: DenoCommandRunnerOptions = {}) {
    this.#captureLimit = options.captureLimit ?? MAX_CAPTURE_BYTES;
  }

  /** Run one command via `Deno.Command` and capture its result. */
  async run(
    bin: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const signal = composeSignal(options);
    if (signal?.aborted) {
      throw new CommandAbortedError(bin, args, signal.reason);
    }
    const command = new Deno.Command(bin, {
      args: [...args],
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    });
    const child = command.spawn();
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
      } catch {
        // The child exited (or was aborted) mid-write — e.g. a broken pipe.
        // Never rethrow here: the exit status below (or the post-output abort
        // check) is authoritative, and bailing out would leak a live child.
      }
    }
    const { success, code, stdout, stderr } = await child.output();
    if (signal?.aborted) {
      throw new CommandAbortedError(bin, args, signal.reason);
    }
    const decoder = new TextDecoder();
    const cap = (bytes: Uint8Array): string =>
      options.uncapped === true
        ? decoder.decode(bytes)
        : decoder.decode(bytes.slice(0, this.#captureLimit));
    return { success, code, stdout: cap(stdout), stderr: cap(stderr) };
  }
}

function composeSignal(options: RunOptions): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (options.signal !== undefined) signals.push(options.signal);
  if (options.timeoutMs !== undefined) {
    signals.push(AbortSignal.timeout(options.timeoutMs));
  }
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

/** Run a command and throw {@linkcode CommandError} on a nonzero exit. */
export async function runChecked(
  runner: CommandRunner,
  bin: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<CommandResult> {
  const result = await runner.run(bin, args, options);
  if (!result.success) throw new CommandError(result, bin, args);
  return result;
}
