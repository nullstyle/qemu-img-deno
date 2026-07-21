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

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
