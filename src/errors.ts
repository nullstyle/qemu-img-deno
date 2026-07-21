/**
 * Typed errors raised by the library beyond the runner-level
 * {@linkcode import("./runner.ts").CommandError}.
 *
 * @module
 */

/** `qemu-img` is missing or unrunnable on this host. */
export class QemuImgMissingError extends Error {
  /** The binary that was looked for. */
  readonly bin: string;

  /** Build the error for the given binary name. */
  constructor(bin: string = "qemu-img") {
    super(`${bin} not found; install QEMU (e.g. brew install qemu)`);
    this.name = "QemuImgMissingError";
    this.bin = bin;
  }
}

/** `qemu-img` produced output the library could not interpret. */
export class QemuImgOutputError extends Error {
  /** The offending output. */
  readonly output: string;

  /** Build the error; the message embeds a truncated copy of the output. */
  constructor(message: string, output: string) {
    super(`${message}: ${JSON.stringify(truncate(output, 200))}`);
    this.name = "QemuImgOutputError";
    this.output = output;
  }
}

/**
 * A requested argument combination is valid `qemu-img` but destroys data
 * silently, so this library refuses to emit it.
 *
 * Guards judge the options alone — they never open the image — so they also
 * refuse the shapes where the same arguments would be harmless. Every guard
 * therefore has a typed opt-in (see
 * {@linkcode import("./qemu_img.ts").RebaseOptions.acknowledgeDataLoss}), and
 * {@linkcode import("./qemu_img.ts").QemuImg.prototype.raw} passes argv
 * through untouched as the universal escape.
 */
export class QemuImgUnsafeOperationError extends Error {
  /** The subcommand that was refused (e.g. `"rebase"`). */
  readonly operation: string;

  /** Build the error; `detail` explains the hazard and the safe alternatives. */
  constructor(operation: string, detail: string) {
    super(`refusing unsafe ${operation}: ${detail}`);
    this.name = "QemuImgUnsafeOperationError";
    this.operation = operation;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
