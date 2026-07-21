/**
 * {@linkcode FakeQemuImg} — a recording, stateful fake of the `qemu-img` CLI
 * implementing the {@linkcode import("../src/runner.ts").CommandRunner} seam.
 *
 * It models a coherent in-memory image store (formats, virtual sizes,
 * backing references, snapshots, bitmaps) and dispatches on the exact argv
 * the client emits, so tests assert both behavior AND the precise command
 * sequence — with no `qemu-img` binary. Image *contents* are not modeled:
 * `convert`/`dd` track metadata only; use {@linkcode FakeQemuImg.onConvert}
 * to produce real bytes when a test needs them.
 *
 * The seam is structurally identical to `@nullstyle/lima`'s, so this fake
 * also serves as that library's runner in cross-package tests.
 *
 * @module
 */

import type {
  CommandResult,
  CommandRunner,
  RunOptions,
} from "../src/runner.ts";

/** One recorded invocation. */
export interface RecordedCall {
  /** The binary invoked. */
  readonly bin: string;
  /** The argv it was invoked with. */
  readonly args: readonly string[];
  /** Bytes piped to stdin, when any. */
  readonly stdin?: string;
}

/** Mutable per-image fake state. */
export interface FakeImageState {
  /** Image format (`"qcow2"`, `"raw"`, …). */
  format: string;
  /** Guest-visible size in bytes. */
  virtualSizeBytes?: number;
  /** Backing file reference, when the image is an overlay. */
  backingFilename?: string;
  /** Backing file format. */
  backingFormat?: string;
  /** Internal snapshots, in creation order. */
  snapshots: { id: string; tag: string }[];
  /** Persistent dirty bitmaps. */
  bitmaps: Set<string>;
}

/** One recorded `convert`, decoded. */
export interface FakeConvert {
  /** Source image path(s), in argv order. */
  readonly sources: readonly string[];
  /** Destination image path. */
  readonly dest: string;
  /** Output format (`-O`). */
  readonly format: string;
  /** Whether `-c` compression was requested. */
  readonly compress: boolean;
  /** The `-f` source format, when given. */
  readonly sourceFormat?: string;
  /** The raw recorded call. */
  readonly raw: RecordedCall;
}

/** Success-result helper for stubbing and hook implementations. */
export function ok(stdout = ""): CommandResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

/** Failure-result helper for stubbing and hook implementations. */
export function failed(code = 1, stderr = ""): CommandResult {
  return { success: false, code, stdout: "", stderr };
}

/** A scripted response override, checked before the state machine. */
interface Stub {
  readonly match: (call: RecordedCall) => boolean;
  readonly result: CommandResult;
  used: boolean;
}

/** The recording fake. See the module doc. */
export class FakeQemuImg implements CommandRunner {
  /** Every recorded invocation, in order. */
  readonly calls: RecordedCall[] = [];
  /** The fake host's images, path → state. Seed inputs here. */
  readonly images: Map<string, FakeImageState> = new Map();
  /** Every decoded `convert`, in order. */
  readonly converts: FakeConvert[] = [];
  /**
   * When `false`, {@linkcode FakeQemuImg.run} rejects with
   * `Deno.errors.NotFound` — the missing-binary simulation.
   */
  available = true;
  /** `qemu-img --version` stdout. */
  versionOutput = "qemu-img version 10.0.2";
  /** `bench` stdout. */
  benchOutput = "Sending 75000 requests, 4096 bytes each\n";
  /**
   * Hook: observe a `convert` for side effects (e.g. writing the dest file
   * so digests are real) and/or override its result. Return `undefined` for
   * the default success; on success the dest is registered in
   * {@linkcode FakeQemuImg.images}.
   */
  onConvert?: (convert: FakeConvert) => CommandResult | undefined | void;

  readonly #stubs: Stub[] = [];
  #nextSnapshotId = 1;

  /** Add (or update) an image; format defaults to `"qcow2"`. */
  setImage(path: string, state: Partial<FakeImageState> = {}): void {
    const existing = this.images.get(path);
    this.images.set(path, {
      format: "qcow2",
      snapshots: [],
      bitmaps: new Set(),
      ...existing,
      ...state,
    });
  }

  /** Every call flattened to `"bin arg arg…"` — the assertion convenience. */
  commandLines(): string[] {
    return this.calls.map((call) => [call.bin, ...call.args].join(" "));
  }

  /**
   * Scripted override checked before the state machine — failure injection
   * without subclassing. Each stub fires once.
   */
  stub(match: (call: RecordedCall) => boolean, result: CommandResult): void {
    this.#stubs.push({ match, result, used: false });
  }

  /** Record the call, gate availability, apply stubs, then dispatch. */
  run(
    bin: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    if (!this.available) {
      return Promise.reject(
        new Deno.errors.NotFound(
          `No such file or directory (os error 2): ${bin}`,
        ),
      );
    }
    const call: RecordedCall = {
      bin,
      args: [...args],
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    };
    this.calls.push(call);
    for (const stub of this.#stubs) {
      if (!stub.used && stub.match(call)) {
        stub.used = true;
        return Promise.resolve(stub.result);
      }
    }
    return Promise.resolve(this.dispatch(call));
  }

  /**
   * The qemu-img argv state machine, dispatching a pre-recorded call.
   * Public so composite fakes (e.g. a Lima host fake) can delegate
   * `qemu-img` calls here without re-recording.
   */
  dispatch(call: RecordedCall): CommandResult {
    const args = call.args;
    switch (args[0]) {
      case "--version":
        return ok(`${this.versionOutput}\n`);
      case "amend":
        return this.#amend(args);
      case "bench":
        return this.#requireImage(
          lastPositional(args),
          () => ok(this.benchOutput),
        );
      case "bitmap":
        return this.#bitmap(args);
      case "check":
        return this.#check(args);
      case "commit":
        return this.#commit(args);
      case "compare":
        return this.#compare(args);
      case "convert":
        return this.#convert(call);
      case "create":
        return this.#create(args);
      case "dd":
        return this.#dd(args);
      case "info":
        return this.#info(args);
      case "map":
        return this.#map(args);
      case "measure":
        return this.#measure(args);
      case "rebase":
        return this.#rebase(args);
      case "resize":
        return this.#resize(args);
      case "snapshot":
        return this.#snapshot(args);
      default:
        return failed(
          1,
          `fake qemu-img: unhandled subcommand ${args[0] ?? "(none)"}`,
        );
    }
  }

  #requireImage(
    path: string,
    then: (state: FakeImageState) => CommandResult,
  ): CommandResult {
    const state = this.images.get(path);
    if (state === undefined) {
      return failed(1, `qemu-img: Could not open '${path}'`);
    }
    return then(state);
  }

  #amend(args: readonly string[]): CommandResult {
    return this.#requireImage(lastPositional(args), () => ok());
  }

  #bitmap(args: readonly string[]): CommandResult {
    // bitmap [-f F] <action…> PATH NAME — the last two positionals.
    const positionals = positionalsOf(args.slice(1), BITMAP_VALUE_FLAGS);
    const name = positionals[positionals.length - 1];
    const path = positionals[positionals.length - 2];
    if (name === undefined || path === undefined) {
      return failed(1, "fake qemu-img: bitmap needs FILENAME BITMAP");
    }
    return this.#requireImage(path, (state) => {
      if (args.includes("--add")) state.bitmaps.add(name);
      else if (args.includes("--remove")) state.bitmaps.delete(name);
      else if (args.includes("--merge")) state.bitmaps.add(name);
      else if (
        !args.includes("--clear") && !args.includes("--enable") &&
        !args.includes("--disable")
      ) {
        return failed(1, "fake qemu-img: bitmap needs an action");
      }
      return ok();
    });
  }

  #check(args: readonly string[]): CommandResult {
    const path = lastPositional(args);
    return this.#requireImage(path, (state) =>
      ok(
        JSON.stringify({
          "filename": path,
          "format": state.format,
          "check-errors": 0,
          "corruptions": 0,
          "leaks": 0,
          "image-end-offset": 262144,
          "total-clusters": 16384,
          "allocated-clusters": 4,
          "fragmented-clusters": 0,
          "compressed-clusters": 0,
        }) + "\n",
      ));
  }

  #commit(args: readonly string[]): CommandResult {
    return this.#requireImage(lastPositional(args), (state) => {
      if (state.backingFilename === undefined) {
        return failed(1, "qemu-img: Image does not have a backing file");
      }
      return ok("Image committed.\n");
    });
  }

  #compare(args: readonly string[]): CommandResult {
    const positionals = positionalsOf(args.slice(1), COMPARE_VALUE_FLAGS);
    const [a, b] = positionals.slice(-2);
    if (a === undefined || b === undefined) {
      return failed(2, "fake qemu-img: compare needs two images");
    }
    const stateA = this.images.get(a);
    const stateB = this.images.get(b);
    if (stateA === undefined || stateB === undefined) {
      return failed(
        2,
        `qemu-img: Could not open '${stateA === undefined ? a : b}'`,
      );
    }
    // Contents are not modeled, so every image "reads" the same (zeros).
    // That matches real non-strict semantics for empty images — a size
    // mismatch with an all-zero tail is identical. Strict mode (-s) fails
    // on differing virtual sizes, exit 1, like the real tool.
    if (
      args.includes("-s") &&
      stateA.virtualSizeBytes !== stateB.virtualSizeBytes
    ) {
      return failed(1, "");
    }
    return ok("Images are identical.\n");
  }

  #convert(call: RecordedCall): CommandResult {
    const args = call.args;
    const format = valueOf(args, "-O");
    if (format === undefined) {
      return failed(1, "fake qemu-img: convert needs -O");
    }
    const positionals = positionalsOf(args.slice(1), CONVERT_VALUE_FLAGS);
    if (positionals.length < 2) {
      return failed(1, "fake qemu-img: convert needs SOURCE… DEST");
    }
    const dest = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const sourceFormat = valueOf(args, "-f");
    const convert: FakeConvert = {
      sources,
      dest,
      format,
      compress: args.includes("-c"),
      ...(sourceFormat === undefined ? {} : { sourceFormat }),
      raw: call,
    };
    this.converts.push(convert);
    for (const source of sources) {
      if (!this.images.has(source)) {
        return failed(1, `qemu-img: Could not open '${source}'`);
      }
    }
    const hooked = this.onConvert?.(convert);
    if (hooked !== undefined) return hooked;
    // Concatenated sources sum their virtual sizes, like real convert.
    let virtualSizeBytes = 0;
    let known = true;
    for (const source of sources) {
      const size = this.images.get(source)?.virtualSizeBytes;
      if (size === undefined) known = false;
      else virtualSizeBytes += size;
    }
    const backing = valueOf(args, "-B");
    this.setImage(dest, {
      format,
      snapshots: [],
      bitmaps: new Set(),
      ...(known ? { virtualSizeBytes } : {}),
      ...(backing === undefined ? {} : { backingFilename: backing }),
    });
    return ok();
  }

  #create(args: readonly string[]): CommandResult {
    const format = valueOf(args, "-f");
    if (format === undefined) {
      return failed(1, "fake qemu-img: create needs -f");
    }
    const positionals = positionalsOf(args.slice(1), CREATE_VALUE_FLAGS);
    const [path, size] = positionals;
    if (path === undefined) {
      return failed(1, "fake qemu-img: create needs PATH");
    }
    const backing = valueOf(args, "-b");
    const backingFormat = valueOf(args, "-F");
    const virtualSizeBytes = size !== undefined
      ? parseSizeBytes(size)
      : backing !== undefined
      ? this.images.get(backing)?.virtualSizeBytes
      : undefined;
    if (size === undefined && backing === undefined) {
      return failed(1, "qemu-img: Image creation needs a size");
    }
    this.setImage(path, {
      format,
      snapshots: [],
      bitmaps: new Set(),
      ...(virtualSizeBytes === undefined ? {} : { virtualSizeBytes }),
      ...(backing === undefined ? {} : { backingFilename: backing }),
      ...(backingFormat === undefined ? {} : { backingFormat }),
    });
    return ok();
  }

  #dd(args: readonly string[]): CommandResult {
    const input = args.find((arg) => arg.startsWith("if="))?.slice(3);
    const output = args.find((arg) => arg.startsWith("of="))?.slice(3);
    if (input === undefined || output === undefined) {
      return failed(1, "fake qemu-img: dd needs if= and of=");
    }
    return this.#requireImage(input, (state) => {
      this.setImage(output, {
        format: valueOf(args, "-O") ?? state.format,
        snapshots: [],
        bitmaps: new Set(),
        ...(state.virtualSizeBytes === undefined
          ? {}
          : { virtualSizeBytes: state.virtualSizeBytes }),
      });
      return ok();
    });
  }

  #info(args: readonly string[]): CommandResult {
    const path = lastPositional(args);
    return this.#requireImage(path, (state) => {
      const chain = args.includes("--backing-chain");
      if (!chain) return ok(JSON.stringify(this.#infoJson(path, state)) + "\n");
      const entries: Record<string, unknown>[] = [];
      let currentPath: string | undefined = path;
      while (currentPath !== undefined) {
        const current = this.images.get(currentPath);
        if (current === undefined) break;
        entries.push(this.#infoJson(currentPath, current));
        currentPath = current.backingFilename;
      }
      return ok(JSON.stringify(entries) + "\n");
    });
  }

  #infoJson(path: string, state: FakeImageState): Record<string, unknown> {
    return {
      "filename": path,
      "format": state.format,
      ...(state.virtualSizeBytes === undefined
        ? {}
        : { "virtual-size": state.virtualSizeBytes }),
      "actual-size": 0,
      ...(state.backingFilename === undefined ? {} : {
        "backing-filename": state.backingFilename,
        "full-backing-filename": state.backingFilename,
      }),
      ...(state.backingFormat === undefined
        ? {}
        : { "backing-filename-format": state.backingFormat }),
      ...(state.snapshots.length === 0 ? {} : {
        "snapshots": state.snapshots.map((snapshot, index) => ({
          "id": snapshot.id,
          "name": snapshot.tag,
          "vm-state-size": 0,
          "date-sec": 1700000000 + index,
          "date-nsec": 0,
        })),
      }),
    };
  }

  #map(args: readonly string[]): CommandResult {
    const path = lastPositional(args);
    return this.#requireImage(path, (state) =>
      ok(
        JSON.stringify([{
          "start": 0,
          "length": state.virtualSizeBytes ?? 0,
          "depth": 0,
          "present": true,
          "zero": false,
          "data": true,
          "offset": 0,
        }]) + "\n",
      ));
  }

  #measure(args: readonly string[]): CommandResult {
    const size = valueOf(args, "--size");
    if (size !== undefined) {
      const bytes = parseSizeBytes(size) ?? 0;
      return ok(
        JSON.stringify({ "required": bytes, "fully-allocated": bytes }) + "\n",
      );
    }
    const path = lastPositional(args);
    return this.#requireImage(path, (state) => {
      const bytes = state.virtualSizeBytes ?? 0;
      return ok(
        JSON.stringify({ "required": bytes, "fully-allocated": bytes }) + "\n",
      );
    });
  }

  #rebase(args: readonly string[]): CommandResult {
    const backing = valueOf(args, "-b");
    if (backing === undefined) {
      return failed(1, "fake qemu-img: rebase needs -b");
    }
    return this.#requireImage(lastPositional(args), (state) => {
      if (backing === "") delete state.backingFilename;
      else state.backingFilename = backing;
      const backingFormat = valueOf(args, "-F");
      if (backingFormat !== undefined) state.backingFormat = backingFormat;
      return ok();
    });
  }

  #resize(args: readonly string[]): CommandResult {
    const positionals = positionalsOf(args.slice(1), RESIZE_VALUE_FLAGS);
    const [path, size] = positionals.slice(-2);
    if (path === undefined || size === undefined) {
      return failed(1, "fake qemu-img: resize needs PATH SIZE");
    }
    return this.#requireImage(path, (state) => {
      const current = state.virtualSizeBytes ?? 0;
      let next: number | undefined;
      if (size.startsWith("+") || size.startsWith("-")) {
        const delta = parseSizeBytes(size.slice(1));
        if (delta !== undefined) {
          next = size.startsWith("+") ? current + delta : current - delta;
        }
      } else {
        next = parseSizeBytes(size);
      }
      if (next === undefined) {
        return failed(1, `qemu-img: Invalid image size specified: ${size}`);
      }
      if (next < current && !args.includes("--shrink")) {
        return failed(
          1,
          "qemu-img: Use the --shrink option to perform a shrink operation.",
        );
      }
      state.virtualSizeBytes = next;
      return ok();
    });
  }

  #snapshot(args: readonly string[]): CommandResult {
    const op = args[1];
    const tag = args[2];
    const path = args[3];
    if (op === undefined || tag === undefined || path === undefined) {
      return failed(1, "fake qemu-img: snapshot needs -c|-a|-d TAG PATH");
    }
    return this.#requireImage(path, (state) => {
      switch (op) {
        case "-c":
          state.snapshots.push({ id: String(this.#nextSnapshotId++), tag });
          return ok();
        case "-a":
          if (!state.snapshots.some((snapshot) => snapshot.tag === tag)) {
            return failed(1, `qemu-img: Can't find the snapshot: ${tag}`);
          }
          return ok();
        case "-d": {
          const index = state.snapshots.findIndex(
            (snapshot) => snapshot.tag === tag,
          );
          if (index === -1) {
            return failed(1, `qemu-img: Can't find the snapshot: ${tag}`);
          }
          state.snapshots.splice(index, 1);
          return ok();
        }
        default:
          return failed(1, `fake qemu-img: unhandled snapshot op ${op}`);
      }
    });
  }
}

// Flags whose next argv entry is a value (per subcommand), for positional
// extraction. Kept in sync with the argv shapes the client emits.
const BITMAP_VALUE_FLAGS = new Set(["-f", "-g", "-b", "-F", "--merge"]);
const COMPARE_VALUE_FLAGS = new Set(["-f", "-F"]);
const CONVERT_VALUE_FLAGS = new Set(["-f", "-B", "-F", "-o", "-S", "-O"]);
const CREATE_VALUE_FLAGS = new Set(["-f", "-b", "-F", "-o"]);
const RESIZE_VALUE_FLAGS = new Set(["-f"]);

function lastPositional(args: readonly string[]): string {
  return args[args.length - 1] ?? "";
}

function positionalsOf(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valueFlags.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

function valueOf(
  args: readonly string[],
  flag: string,
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)(?:([kKmMgGtTpP])i?)?[bB]?$/;
const SIZE_MULTIPLIERS: Record<string, number> = {
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
  p: 1024 ** 5,
};

function parseSizeBytes(value: string): number | undefined {
  const match = SIZE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, digits, suffix] = match;
  const multiplier = suffix === undefined
    ? 1
    : SIZE_MULTIPLIERS[suffix.toLowerCase()];
  return Math.round(Number(digits) * multiplier);
}
