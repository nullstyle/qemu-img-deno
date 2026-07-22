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
  /**
   * Disposition of the child's stdout. `"piped"` captures it into
   * {@linkcode CommandResult.stdout}; `"inherit"` lets it reach this process's
   * own stdout; `"null"` discards it.
   *
   * Prefer `"null"` or `"inherit"` for a child that spawns long-lived
   * grandchildren: a captured pipe stays open as long as *any* descendant holds
   * its write end, so a command whose grandchild outlives it cannot report
   * completion through captured output alone. @default "piped"
   */
  readonly stdout?: "piped" | "inherit" | "null";
  /** Disposition of the child's stderr; see {@linkcode RunOptions.stdout}. @default "piped" */
  readonly stderr?: "piped" | "inherit" | "null";
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
  /**
   * Whatever the child had already written to stdout when the abort fired
   * (bounded by the capture cap). Empty when it produced none, when the run
   * was aborted before spawning, or when stdout was not `"piped"`.
   *
   * A timed-out command is exactly the case where its output matters most —
   * the last line before a hang usually names the thing that hung.
   */
  readonly stdout: string;
  /** Error output captured before the abort; see {@linkcode CommandAbortedError.stdout}. */
  readonly stderr: string;

  /** Build the error; `reason` becomes the `cause`. */
  constructor(
    bin: string,
    args: readonly string[],
    reason?: unknown,
    stdout: string = "",
    stderr: string = "",
  ) {
    super(`command aborted: ${bin} ${args.join(" ")}`, { cause: reason });
    this.name = "CommandAbortedError";
    this.bin = bin;
    this.args = [...args];
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Default stdout/stderr capture cap in bytes (64 KiB). */
export const MAX_CAPTURE_BYTES = 64 * 1024;

/** Options for {@linkcode DenoCommandRunner}. */
export interface DenoCommandRunnerOptions {
  /** Capture cap in bytes when a run is not `uncapped`. @default MAX_CAPTURE_BYTES */
  readonly captureLimit?: number;
  /**
   * Grace period between `SIGTERM` and `SIGKILL` when a run is aborted.
   * @default 5000
   */
  readonly killGraceMs?: number;
}

/**
 * Default runner backed by `Deno.Command`. Captures stdout/stderr (bounded,
 * byte-accurate — a capped capture may end with a replacement character when
 * the cut falls inside a UTF-8 sequence), pipes `stdin` when provided, kills
 * the child when the composed abort signal fires, and never throws on a
 * nonzero exit — the caller decides whether a nonzero code is fatal.
 *
 * An abort races the child's *exit status*, never its captured output, and
 * escalates `SIGTERM` → grace → `SIGKILL`. Waiting on output would not be a
 * deadline at all: a pipe stays readable while any grandchild holds its write
 * end, so `sh -c 'echo x; sleep 5'` with a 500 ms timeout would block for the
 * full 5 s even though the shell died on schedule.
 */
export class DenoCommandRunner implements CommandRunner {
  readonly #captureLimit: number;
  readonly #killGraceMs: number;

  /** Create a runner, optionally overriding the capture cap and kill grace. */
  constructor(options: DenoCommandRunnerOptions = {}) {
    this.#captureLimit = options.captureLimit ?? MAX_CAPTURE_BYTES;
    this.#killGraceMs = options.killGraceMs ?? 5_000;
  }

  /** Run one command via `Deno.Command` and capture its result. */
  async run(
    bin: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const { signal, dispose } = composeSignal(options);
    try {
      return await this.#runWith(bin, args, options, signal);
    } finally {
      // Release the deadline timer on every path, or it holds the process
      // open for the remainder of the timeout after the command is done.
      dispose();
    }
  }

  async #runWith(
    bin: string,
    args: readonly string[],
    options: RunOptions,
    signal: AbortSignal | undefined,
  ): Promise<CommandResult> {
    if (signal?.aborted) {
      throw new CommandAbortedError(bin, args, signal.reason);
    }
    const limit = options.uncapped === true ? Infinity : this.#captureLimit;
    const stdoutMode = options.stdout ?? "piped";
    const stderrMode = options.stderr ?? "piped";
    // `signal` is deliberately NOT handed to Deno.Command: it kills the child
    // but leaves us awaiting output that a surviving grandchild still holds.
    const command = new Deno.Command(bin, {
      args: [...args],
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: stdoutMode,
      stderr: stderrMode,
    });
    const child = command.spawn();
    if (options.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
      } catch {
        // The child exited (or was aborted) mid-write — e.g. a broken pipe.
        // Never rethrow here: the exit status below is authoritative, and
        // bailing out would leak a live child.
      }
    }
    const outSink = stdoutMode === "piped"
      ? drain(child.stdout, limit)
      : undefined;
    const errSink = stderrMode === "piped"
      ? drain(child.stderr, limit)
      : undefined;

    const status = signal === undefined
      ? await child.status
      : await Promise.race([child.status, abortSignalled(signal)]);

    if (status === ABORTED) {
      await this.#terminate(child);
      // Report what the child had already produced rather than discarding it;
      // the streams are cancelled instead of drained because a grandchild may
      // hold them open indefinitely.
      const [captured, capturedErr] = await Promise.all([
        outSink?.cancel() ?? Promise.resolve(""),
        errSink?.cancel() ?? Promise.resolve(""),
      ]);
      throw new CommandAbortedError(
        bin,
        args,
        signal?.reason,
        captured,
        capturedErr,
      );
    }

    const stdout = await (outSink?.collected() ?? Promise.resolve(""));
    const stderr = await (errSink?.collected() ?? Promise.resolve(""));
    return { success: status.success, code: status.code, stdout, stderr };
  }

  /** `SIGTERM`, then `SIGKILL` after the grace period. Always reaps. */
  async #terminate(child: Deno.ChildProcess): Promise<void> {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited between the race resolving and this call.
    }
    const grace = new AbortController();
    const exited = await Promise.race([
      child.status.then(() => true),
      sleep(this.#killGraceMs, grace.signal).then(() => false),
    ]);
    grace.abort();
    if (exited) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Raced us to the exit; the await below still reaps it.
    }
    await child.status;
  }
}

/** Sentinel distinguishing "the abort won the race" from a real exit status. */
const ABORTED = Symbol("aborted");

function abortSignalled(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** A stream being accumulated, capped, and readable even before it ends. */
interface Sink {
  /** Resolve when the stream ends, with everything captured. */
  collected(): Promise<string>;
  /** Stop reading now and return whatever arrived so far. */
  cancel(): Promise<string>;
}

function drain(stream: ReadableStream<Uint8Array>, limit: number): Sink {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Keep reading past the cap so the child never blocks on a full pipe,
        // but stop retaining once the cap is reached.
        if (total < limit) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
    } catch {
      // Cancelled, or the pipe broke; whatever arrived is still reportable.
    }
  })();
  const decode = (): string => {
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const bounded = Number.isFinite(limit) ? joined.slice(0, limit) : joined;
    return new TextDecoder().decode(bounded);
  };
  return {
    collected: async () => {
      await pump;
      return decode();
    },
    cancel: async () => {
      await reader.cancel().catch(() => {});
      return decode();
    },
  };
}

/** A composed signal plus the cleanup that releases its timer. */
interface ComposedSignal {
  readonly signal: AbortSignal | undefined;
  /** Cancel the deadline timer. Must be called on every exit path. */
  readonly dispose: () => void;
}

function composeSignal(options: RunOptions): ComposedSignal {
  const signals: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.signal !== undefined) signals.push(options.signal);
  if (options.timeoutMs !== undefined) {
    // Deliberately NOT `AbortSignal.timeout()`: its timer is referenced, so it
    // keeps the process alive until the deadline elapses even when the command
    // finished long before. A `timeoutMs: 120_000` run that completes in 300 ms
    // would still hang the program for two minutes.
    const controller = new AbortController();
    timer = setTimeout(
      () => controller.abort(new DOMException("timed out", "TimeoutError")),
      options.timeoutMs,
    );
    signals.push(controller.signal);
  }
  const dispose = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  if (signals.length === 0) return { signal: undefined, dispose };
  return {
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    dispose,
  };
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
