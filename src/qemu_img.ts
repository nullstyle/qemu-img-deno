/**
 * The `qemu-img` client: every subcommand, driven through the runner seam.
 *
 * Argv shapes are fixed and test-pinned. Subcommands with a JSON output form
 * (`info`, `check`, `map`, `measure`) always request `--output=json` and
 * return typed results from `./results.ts`; their runs are uncapped so large
 * parse-feeding output is never head-truncated.
 *
 * @module
 */

import {
  CommandError,
  type CommandResult,
  runChecked,
  type RunOptions,
} from "./runner.ts";
import {
  buildRunOptions,
  type CallOptions,
  type QemuImgOptions,
  type ResolvedOptions,
  resolveOptions,
} from "./options.ts";
import { QemuImgMissingError, QemuImgUnsafeOperationError } from "./errors.ts";
import {
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
} from "./results.ts";
import { parseQemuImgVersion, type QemuImgVersion } from "./version.ts";

/**
 * A disk image format name. An open union: the common formats are typed,
 * every other format qemu-img knows (`vmdk`, `vdi`, `vhdx`, `qed`, `luks`, …)
 * flows through as a plain string.
 */
export type ImageFormat =
  | "qcow2"
  | "raw"
  // deno-lint-ignore ban-types
  | (string & {});

/**
 * Format-specific creation/amend options, rendered to qemu-img's
 * `-o key=value,key2=value2` form with keys sorted for deterministic argv.
 * Booleans render as `on`/`off`.
 */
export type FormatOptions = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * A size argument. Numbers are bytes; strings pass through qemu-img's size
 * grammar (`"10G"`, and for {@linkcode QemuImg.resize} the relative
 * `"+1G"`/`"-512M"` forms).
 */
export type SizeValue = number | string;

/**
 * A qemu block-driver node: a `driver` plus its options, with child nodes
 * nested under their role (`file`, `backing`).
 *
 * Rendered to qemu's `key=value,child.key=value` form with keys sorted, so
 * argv stays deterministic and test-pinnable. Booleans render as `on`/`off`.
 *
 * The `raw` driver's `offset`/`size` pair is the useful one: it exposes a
 * *window* onto a larger image, which is how bytes are written into one
 * partition without touching its neighbours.
 *
 * @example A 512 MiB window starting 1 MiB into a qcow2
 * ```ts
 * const window = {
 *   driver: "raw",
 *   offset: 1048576,
 *   size: 536870912,
 *   file: { driver: "qcow2", file: { driver: "file", filename: "/disk.qcow2" } },
 * };
 * ```
 */
export type BlockNodeSpec = {
  /** The block driver name (`"raw"`, `"qcow2"`, `"file"`, `"vvfat"`, …). */
  readonly driver: string;
  /** Driver options, and child nodes under their role. */
  readonly [key: string]: string | number | boolean | BlockNodeSpec;
};

/**
 * An image operand: a path, or an option graph passed through qemu's
 * `--image-opts`.
 *
 * A plain string behaves exactly as before and emits identical argv. An
 * option graph is mutually exclusive with the format flags (`-f`/`-O`/`-F`) —
 * qemu rejects the combination, and so does this library, earlier and with a
 * typed error.
 */
export type ImageRef = string | {
  /** The block-node graph describing this operand. */
  readonly imageOpts: BlockNodeSpec;
};

/** Options for {@linkcode QemuImg.amend}. */
export interface AmendOptions extends CallOptions {
  /** Format-specific options to apply (`-o`). */
  readonly options: FormatOptions;
  /** Image format (`-f`, skips probing). */
  readonly format?: ImageFormat;
  /** Allow unsafe amendments (`--force`). */
  readonly force?: boolean;
}

/** Options for {@linkcode QemuImg.bench}. */
export interface BenchOptions extends CallOptions {
  /** Number of I/O requests (`-c`). */
  readonly count?: number;
  /** Queue depth (`-d`). */
  readonly depth?: number;
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
  /** Flush after every N requests (`--flush-interval`). */
  readonly flushInterval?: number;
  /** Starting offset (`-o`). */
  readonly offset?: SizeValue;
  /** Write pattern byte (`--pattern`). */
  readonly pattern?: number;
  /** Buffer size per request (`-s`). */
  readonly bufferSize?: SizeValue;
  /** Step between requests (`-S`). */
  readonly stepSize?: SizeValue;
  /** Run a write benchmark instead of reads (`-w`). */
  readonly write?: boolean;
  /** Skip the drain between requests (`--no-drain`). */
  readonly noDrain?: boolean;
}

/** One bitmap action for {@linkcode QemuImg.bitmap}. */
export type BitmapAction =
  | {
    /** Create the bitmap (`--add`). */
    readonly op: "add";
    /** Dirty granularity in bytes (`-g`). */
    readonly granularity?: number;
  }
  | {
    /** Delete, clear, enable, or disable the bitmap. */
    readonly op: "remove" | "clear" | "enable" | "disable";
  }
  | {
    /** Merge another bitmap into this one (`--merge`). */
    readonly op: "merge";
    /** The source bitmap name. */
    readonly source: string;
    /** File holding the source bitmap (`-b`); defaults to the same file. */
    readonly sourceFile?: string;
    /** Source file format (`-F`). */
    readonly sourceFormat?: ImageFormat;
  };

/** Options for {@linkcode QemuImg.bitmap}. */
export interface BitmapOptions extends CallOptions {
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
}

/** Options for {@linkcode QemuImg.check}. */
export interface CheckOptions extends CallOptions {
  /** Repair mode (`-r`): fix `"leaks"` only, or `"all"` errors. */
  readonly repair?: "leaks" | "all";
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
}

/** Options for {@linkcode QemuImg.commit}. */
export interface CommitOptions extends CallOptions {
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
  /** Commit down to this backing file instead of the immediate one (`-b`). */
  readonly base?: string;
  /** Skip emptying the committed image (`-d`). */
  readonly drop?: boolean;
  /** I/O rate limit in bytes/second (`-r`). */
  readonly rate?: SizeValue;
}

/** Options for {@linkcode QemuImg.compare}. */
export interface CompareOptions extends CallOptions {
  /** First image's format (`-f`). */
  readonly format?: ImageFormat;
  /** Second image's format (`-F`). */
  readonly formatB?: ImageFormat;
  /** Strict mode (`-s`): sizes and allocations must match too. */
  readonly strict?: boolean;
}

/** Options for {@linkcode QemuImg.convert}. */
export interface ConvertOptions extends CallOptions {
  /**
   * Output format (`-O`). Required for a path destination; refused for an
   * option-graph destination, which carries its own `driver`.
   */
  readonly format?: ImageFormat;
  /**
   * Number of coroutines running in parallel (`-m`).
   *
   * Pin to `1` whenever the output will be hashed: higher values let writes
   * complete out of order, so the resulting file's cluster layout — though not
   * its guest-visible content — varies between runs. `-W` is never emitted.
   */
  readonly parallel?: number;
  /** Source format (`-f`, skips probing). */
  readonly sourceFormat?: ImageFormat;
  /** Compress output clusters (`-c`; qcow2/qed only). */
  readonly compress?: boolean;
  /** Write into a pre-existing output image (`-n`). */
  readonly noCreate?: boolean;
  /** Create the output backed by this file (`-B`). */
  readonly backing?: string;
  /** Backing file format (`-F`; only meaningful with `backing`). */
  readonly backingFormat?: ImageFormat;
  /**
   * Format-specific output options (`-o`), e.g. `{ cluster_size: "1M" }`.
   *
   * Passed through unvalidated. Note `{ compression_type: "zstd" }`: qemu
   * accepts it, but pure-Go qcow2 readers (notably Lima's `go-qcow2reader`,
   * used on hosts without qemu-img) only implement DEFLATE and will reject
   * the image. Prefer plain {@linkcode ConvertOptions.compress} — zlib — for
   * images other tools must read.
   */
  readonly options?: FormatOptions;
  /** Sparse-detection chunk size (`-S`). */
  readonly sparseSize?: SizeValue;
  /**
   * Continue past source read errors (`--salvage`).
   *
   * Unreadable regions are written as zeros and the conversion still exits
   * `0` — the per-region warnings go to stderr, which this method discards —
   * so a damaged source yields a silently wrong image rather than a failure.
   * Use it only to rescue data from media you already know is failing, and
   * never on a source read over the network.
   */
  readonly salvage?: boolean;
  /** Assume a `noCreate` target already reads as zeros (`--target-is-zero`). */
  readonly targetIsZero?: boolean;
}

/** Options for {@linkcode QemuImg.create}. */
export interface CreateOptions extends CallOptions {
  /** Image format (`-f`). */
  readonly format: ImageFormat;
  /** Virtual size; optional when `backing` supplies one. */
  readonly size?: SizeValue;
  /** Backing file reference (`-b`). */
  readonly backing?: string;
  /** Backing file format (`-F`). */
  readonly backingFormat?: ImageFormat;
  /** Format-specific options (`-o`). */
  readonly options?: FormatOptions;
}

/** Options for {@linkcode QemuImg.dd}. */
export interface DdOptions extends CallOptions {
  /** Input file (`if=`). */
  readonly input: string;
  /** Output file (`of=`). */
  readonly output: string;
  /** Input format (`-f`). */
  readonly format?: ImageFormat;
  /** Output format (`-O`). */
  readonly outputFormat?: ImageFormat;
  /** Block size (`bs=`). */
  readonly blockSize?: SizeValue;
  /** Blocks to copy (`count=`). */
  readonly count?: number;
  /** Input blocks to skip (`skip=`). */
  readonly skip?: number;
}

/** Options for {@linkcode QemuImg.info} and {@linkcode QemuImg.infoChain}. */
export interface InfoOptions extends CallOptions {
  /** Image format (`-f`, skips probing). */
  readonly format?: ImageFormat;
}

/** Options for {@linkcode QemuImg.map}. */
export interface MapOptions extends CallOptions {
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
}

/** Options for {@linkcode QemuImg.measure} — give exactly one of `source`/`size`. */
export interface MeasureOptions extends CallOptions {
  /** Output format the measurement is for (`-O`). */
  readonly outputFormat: ImageFormat;
  /** Measure converting this existing image. */
  readonly source?: ImageRef;
  /** Measure a fresh image of this virtual size (`--size`). */
  readonly size?: SizeValue;
  /** Source format (`-f`; only meaningful with `source`). */
  readonly sourceFormat?: ImageFormat;
  /** Format-specific output options (`-o`). */
  readonly options?: FormatOptions;
}

/** Options for {@linkcode QemuImg.rebase}. */
export interface RebaseOptions extends CallOptions {
  /**
   * New backing file reference (`-b`); `""` removes the backing file.
   *
   * In safe mode (the default) `""` flattens the image: the base's data is
   * copied down first, so guest-visible content is unchanged.
   */
  readonly backing: string;
  /** New backing file format (`-F`). */
  readonly backingFormat?: ImageFormat;
  /**
   * Unsafe mode (`-u`): only rewrite the reference, never read data.
   *
   * Correct when the backing file merely moved or was renamed. Combined with
   * `backing: ""` on an image that still depends on its base it is data loss
   * — the base's clusters are never copied down, so they read back as zeros,
   * and {@linkcode QemuImg.prototype.check} still passes. This library throws
   * {@linkcode QemuImgUnsafeOperationError} on that pair from the options
   * alone, without opening the image, so it also refuses the shapes where the
   * pair is harmless or is the only repair: an image with no backing file (a
   * byte-identical no-op), a fully allocated overlay, or a chain whose base
   * is gone. Set {@linkcode RebaseOptions.acknowledgeDataLoss} for those.
   */
  readonly unsafe?: boolean;
  /**
   * Proceed with `unsafe` + `backing: ""` anyway.
   *
   * The escape hatch for the cases the shape-based guard cannot distinguish —
   * most commonly clearing a dangling reference after the base was deleted,
   * where safe mode and {@linkcode QemuImg.prototype.convert} both fail with
   * `Could not open backing file`. Anything the overlay never wrote will read
   * as zeros afterwards.
   */
  readonly acknowledgeDataLoss?: boolean;
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
}

/** Options for {@linkcode QemuImg.resize}. */
export interface ResizeOptions extends CallOptions {
  /** Image format (`-f`). */
  readonly format?: ImageFormat;
  /**
   * Allow shrinking (`--shrink`).
   *
   * Truncates the virtual size, discarding everything past the new end —
   * including a GPT's backup header, which lives in the last LBA. Shrink only
   * after the guest filesystem and partition table have been reduced from
   * inside the guest, then repair the GPT (`sgdisk -e`): the backup header is
   * lost to the truncation either way, and the primary header's
   * `AlternateLBA`/`LastUsableLBA` are left pointing past the new end.
   */
  readonly shrink?: boolean;
  /** Preallocation mode for grown space (`--preallocation`). */
  readonly preallocation?: "off" | "metadata" | "falloc" | "full";
}

/** Internal-snapshot operations, bound to a {@linkcode QemuImg} client. */
export interface SnapshotOps {
  /** Create snapshot `tag`: `qemu-img snapshot -c <tag> <path>`. */
  create(path: string, tag: string, options?: CallOptions): Promise<void>;
  /** Revert the image to snapshot `tag` (`-a`). */
  apply(path: string, tag: string, options?: CallOptions): Promise<void>;
  /** Delete snapshot `tag` (`-d`). */
  delete(path: string, tag: string, options?: CallOptions): Promise<void>;
  /** List snapshots, via `info --output=json` (richer than `snapshot -l`). */
  list(path: string, options?: InfoOptions): Promise<readonly SnapshotInfo[]>;
}

/** The qemu-img client. */
export class QemuImg {
  readonly #o: ResolvedOptions;

  /** Internal-snapshot operations (`qemu-img snapshot …`). */
  readonly snapshot: SnapshotOps;

  /** Create a client; all options default (real runner, `"qemu-img"`). */
  constructor(options: QemuImgOptions = {}) {
    this.#o = resolveOptions(options);
    this.snapshot = {
      create: (path, tag, call = {}) =>
        this.#checkedVoid(["snapshot", "-c", tag, path], call),
      apply: (path, tag, call = {}) =>
        this.#checkedVoid(["snapshot", "-a", tag, path], call),
      delete: (path, tag, call = {}) =>
        this.#checkedVoid(["snapshot", "-d", tag, path], call),
      list: async (path, call = {}) =>
        (await this.info(path, call)).snapshots ?? [],
    };
  }

  /** The `qemu-img` binary this client drives. */
  get bin(): string {
    return this.#o.bin;
  }

  /** Whether `qemu-img --version` runs successfully (`false` when the binary is missing). */
  async available(options: CallOptions = {}): Promise<boolean> {
    try {
      const result = await this.#o.runner.run(
        this.#o.bin,
        ["--version"],
        buildRunOptions(this.#o, options),
      );
      return result.success;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  /** Throw {@linkcode QemuImgMissingError} unless qemu-img is runnable. */
  async ensureAvailable(options: CallOptions = {}): Promise<void> {
    if (!(await this.available(options))) {
      throw new QemuImgMissingError(this.#o.bin);
    }
  }

  /** The parsed `qemu-img --version`. Throws {@linkcode QemuImgMissingError} when missing. */
  async version(options: CallOptions = {}): Promise<QemuImgVersion> {
    let result: CommandResult;
    try {
      result = await this.#o.runner.run(
        this.#o.bin,
        ["--version"],
        buildRunOptions(this.#o, options),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new QemuImgMissingError(this.#o.bin);
      }
      throw error;
    }
    if (!result.success) throw new QemuImgMissingError(this.#o.bin);
    return parseQemuImgVersion(result.stdout);
  }

  /** Change format-specific options in place: `qemu-img amend -o … <path>`. */
  async amend(path: string, options: AmendOptions): Promise<void> {
    await this.#checkedVoid([
      "amend",
      ...flag("-f", options.format),
      ...(options.force === true ? ["--force"] : []),
      "-o",
      formatOptionsArg(options.options),
      path,
    ], options);
  }

  /** Benchmark image I/O: `qemu-img bench …`. Returns qemu-img's report text. */
  async bench(path: string, options: BenchOptions = {}): Promise<string> {
    const result = await this.#checked([
      "bench",
      ...flag("-c", options.count),
      ...flag("-d", options.depth),
      ...flag("-f", options.format),
      ...(options.flushInterval === undefined
        ? []
        : [`--flush-interval=${options.flushInterval}`]),
      ...flag("-o", options.offset),
      ...(options.pattern === undefined
        ? []
        : [`--pattern=${options.pattern}`]),
      ...flag("-s", options.bufferSize),
      ...flag("-S", options.stepSize),
      ...(options.write === true ? ["-w"] : []),
      ...(options.noDrain === true ? ["--no-drain"] : []),
      path,
    ], options);
    return result.stdout;
  }

  /** Manipulate a persistent dirty bitmap: `qemu-img bitmap … <path> <name>`. */
  async bitmap(
    path: string,
    name: string,
    action: BitmapAction,
    options: BitmapOptions = {},
  ): Promise<void> {
    const actionArgs = action.op === "add"
      ? ["--add", ...flag("-g", action.granularity)]
      : action.op === "merge"
      ? [
        "--merge",
        action.source,
        ...flag("-b", action.sourceFile),
        ...flag("-F", action.sourceFormat),
      ]
      : [`--${action.op}`];
    await this.#checkedVoid([
      "bitmap",
      ...flag("-f", options.format),
      ...actionArgs,
      path,
      name,
    ], options);
  }

  /**
   * Check image consistency: `qemu-img check --output=json <path>`.
   * Exit codes `0`/`2`/`3` (clean / corruptions / unrepaired leaks) all
   * produce a {@linkcode CheckResult} — inspect {@linkcode CheckResult.code};
   * any other exit throws a `CommandError`.
   *
   * This validates the image's internal structure (refcounts, cluster
   * references), not that it holds the data you expect. qcow2 does flag a
   * copy truncated by a full cluster or more — the L2 entries dangle past
   * EOF — but an *incomplete* image passes clean: a half-written convert, or
   * a copy short by less than `cluster_size` (up to 2 MiB with large
   * clusters), reports zero corruptions. VDI misses truncation entirely and
   * raw has no check at all. To verify content, compare against a known-good
   * source with {@linkcode QemuImg.prototype.compare}.
   */
  async check(path: string, options: CheckOptions = {}): Promise<CheckResult> {
    const args = [
      "check",
      ...flag("-f", options.format),
      ...flag("-r", options.repair),
      "--output=json",
      path,
    ];
    const result = await this.#run(args, options, { uncapped: true });
    if (!result.success && result.code !== 2 && result.code !== 3) {
      throw new CommandError(result, this.#o.bin, args);
    }
    return parseCheckResult(result.stdout, result.code);
  }

  /** Commit an overlay into its backing file: `qemu-img commit <path>`. */
  async commit(path: string, options: CommitOptions = {}): Promise<void> {
    await this.#checkedVoid([
      "commit",
      ...flag("-f", options.format),
      ...flag("-b", options.base),
      ...(options.drop === true ? ["-d"] : []),
      ...flag("-r", options.rate),
      path,
    ], options);
  }

  /**
   * Compare two images' guest-visible contents: `qemu-img compare <a> <b>`.
   * Exit `0` → identical, `1` → different; anything else throws a
   * `CommandError`.
   */
  async compare(
    a: ImageRef,
    b: ImageRef,
    options: CompareOptions = {},
  ): Promise<CompareResult> {
    const graph = isOptionGraph(a) || isOptionGraph(b);
    if (graph && !(isOptionGraph(a) && isOptionGraph(b))) {
      throw new TypeError(
        "compare needs both operands as option graphs or neither: " +
          "--image-opts applies to FILE1 and FILE2 together",
      );
    }
    if (
      graph &&
      (options.format !== undefined || options.formatB !== undefined)
    ) {
      throw new TypeError(MUTUALLY_EXCLUSIVE("compare"));
    }
    const args = [
      "compare",
      ...(graph
        ? ["--image-opts"]
        : [...flag("-f", options.format), ...flag("-F", options.formatB)]),
      ...(options.strict === true ? ["-s"] : []),
      refArg(a),
      refArg(b),
    ];
    const result = await this.#run(args, options);
    if (result.code !== 0 && result.code !== 1) {
      throw new CommandError(result, this.#o.bin, args);
    }
    return { identical: result.code === 0, output: result.stdout };
  }

  /**
   * Convert/copy an image: `qemu-img convert … -O <fmt> <source…> <dest>`.
   * Multiple sources concatenate into the output (qemu-img's multi-source
   * form).
   *
   * Sources are spliced into argv verbatim, so qemu's block drivers apply: a
   * `source` may be an `http(s)://`, `ssh://` or `nbd://` URL as well as a
   * path. Converting bulk data straight from a URL is fragile — a stall or
   * reset mid-transfer at least fails loudly (exit `1`, so this throws), but
   * a server that under-reports the object's length leaves a truncated
   * output and still exits `0`, and {@linkcode QemuImg.prototype.check} will
   * call that output clean because it verifies structure, not completeness.
   * Download first, or verify the result with
   * {@linkcode QemuImg.prototype.compare} against a known-good copy.
   */
  async convert(
    source: ImageRef | readonly ImageRef[],
    dest: ImageRef,
    options: ConvertOptions,
  ): Promise<void> {
    const sources: ImageRef[] = Array.isArray(source)
      ? [...(source as readonly ImageRef[])]
      : [source as ImageRef];
    const sourceIsGraph = sources.some(isOptionGraph);
    if (sourceIsGraph && sources.length > 1) {
      throw new TypeError(
        "convert accepts at most one source when it is an option graph: " +
          "--image-opts applies to every source, so paths and graphs cannot " +
          "be mixed",
      );
    }
    if (sourceIsGraph && options.sourceFormat !== undefined) {
      throw new TypeError(
        "convert cannot combine an option-graph source with sourceFormat: " +
          "--image-opts and --format are mutually exclusive (put the format " +
          "in the graph's `driver` instead)",
      );
    }
    const destIsGraph = isOptionGraph(dest);
    if (destIsGraph && options.noCreate !== true) {
      throw new TypeError(
        "convert into an option-graph destination requires noCreate: qemu " +
          "refuses --target-image-opts without -n, because an option graph " +
          "names an existing node rather than a file to create",
      );
    }
    if (destIsGraph && options.format !== undefined) {
      throw new TypeError(
        "convert cannot combine an option-graph destination with format: " +
          "--target-image-opts and -O are mutually exclusive (put the format " +
          "in the graph's `driver` instead)",
      );
    }
    if (!destIsGraph && options.format === undefined) {
      throw new TypeError("convert needs a format for a path destination");
    }
    await this.#checkedVoid([
      "convert",
      ...(sourceIsGraph ? ["--image-opts"] : flag("-f", options.sourceFormat)),
      ...(options.compress === true ? ["-c"] : []),
      ...(options.noCreate === true ? ["-n"] : []),
      // `-B ""` alongside `-F` segfaults qemu-img 11.0.2 (SIGSEGV, 3/3) after
      // writing a partial destination; without `-F` it errors out. An empty
      // `backing` can only mean "no backing file", which is what omitting the
      // flag already does.
      ...(options.backing === "" ? [] : flag("-B", options.backing)),
      ...flag("-F", options.backingFormat),
      ...(options.options === undefined
        ? []
        : ["-o", formatOptionsArg(options.options)]),
      ...flag("-S", options.sparseSize),
      ...flag("-m", options.parallel),
      ...(options.salvage === true ? ["--salvage"] : []),
      ...(options.targetIsZero === true ? ["--target-is-zero"] : []),
      ...(destIsGraph ? ["--target-image-opts"] : ["-O", options.format!]),
      ...sources.map(refArg),
      refArg(dest),
    ], options);
  }

  /** Create an image: `qemu-img create -f <fmt> <path> [size]`. */
  async create(path: string, options: CreateOptions): Promise<void> {
    await this.#checkedVoid([
      "create",
      "-f",
      options.format,
      ...flag("-b", options.backing),
      ...flag("-F", options.backingFormat),
      ...(options.options === undefined
        ? []
        : ["-o", formatOptionsArg(options.options)]),
      path,
      ...(options.size === undefined ? [] : [sizeArg(options.size)]),
    ], options);
  }

  /** dd-style block copy: `qemu-img dd … if=<input> of=<output>`. */
  async dd(options: DdOptions): Promise<void> {
    await this.#checkedVoid([
      "dd",
      ...flag("-f", options.format),
      ...flag("-O", options.outputFormat),
      ...(options.blockSize === undefined
        ? []
        : [`bs=${sizeArg(options.blockSize)}`]),
      ...(options.count === undefined ? [] : [`count=${options.count}`]),
      ...(options.skip === undefined ? [] : [`skip=${options.skip}`]),
      `if=${options.input}`,
      `of=${options.output}`,
    ], options);
  }

  /** Typed `qemu-img info --output=json <path>`. */
  async info(path: ImageRef, options: InfoOptions = {}): Promise<QemuImgInfo> {
    const graph = isOptionGraph(path);
    if (graph && options.format !== undefined) {
      throw new TypeError(MUTUALLY_EXCLUSIVE("info"));
    }
    const result = await this.#checked(
      [
        "info",
        ...(graph ? ["--image-opts"] : flag("-f", options.format)),
        "--output=json",
        refArg(path),
      ],
      options,
      { uncapped: true },
    );
    return parseQemuImgInfo(result.stdout);
  }

  /** The whole backing chain: `qemu-img info --backing-chain --output=json`. */
  async infoChain(
    path: ImageRef,
    options: InfoOptions = {},
  ): Promise<QemuImgInfo[]> {
    const graph = isOptionGraph(path);
    if (graph && options.format !== undefined) {
      throw new TypeError(MUTUALLY_EXCLUSIVE("info"));
    }
    const result = await this.#checked(
      [
        "info",
        ...(graph ? ["--image-opts"] : flag("-f", options.format)),
        "--backing-chain",
        "--output=json",
        refArg(path),
      ],
      options,
      { uncapped: true },
    );
    return parseQemuImgInfoChain(result.stdout);
  }

  /** Allocation map: `qemu-img map --output=json <path>`. */
  async map(path: ImageRef, options: MapOptions = {}): Promise<MapExtent[]> {
    const graph = isOptionGraph(path);
    if (graph && options.format !== undefined) {
      throw new TypeError(MUTUALLY_EXCLUSIVE("map"));
    }
    const result = await this.#checked(
      [
        "map",
        ...(graph ? ["--image-opts"] : flag("-f", options.format)),
        "--output=json",
        refArg(path),
      ],
      options,
      { uncapped: true },
    );
    return parseMapExtents(result.stdout);
  }

  /**
   * Required size for a conversion: `qemu-img measure --output=json …`.
   * Give exactly one of `source` (an existing image) or `size` (a fresh
   * image's virtual size).
   */
  async measure(options: MeasureOptions): Promise<MeasureResult> {
    const hasSource = options.source !== undefined;
    const hasSize = options.size !== undefined;
    if (hasSource === hasSize) {
      throw new TypeError("measure needs exactly one of source or size");
    }
    const sourceIsGraph = hasSource && isOptionGraph(options.source!);
    if (sourceIsGraph && options.sourceFormat !== undefined) {
      throw new TypeError(MUTUALLY_EXCLUSIVE("measure"));
    }
    const result = await this.#checked(
      [
        "measure",
        ...(sourceIsGraph
          ? ["--image-opts"]
          : flag("-f", options.sourceFormat)),
        ...(options.options === undefined
          ? []
          : ["-o", formatOptionsArg(options.options)]),
        "-O",
        options.outputFormat,
        "--output=json",
        ...(hasSize
          ? ["--size", sizeArg(options.size!)]
          : [refArg(options.source!)]),
      ],
      options,
      { uncapped: true },
    );
    return parseMeasureResult(result.stdout);
  }

  /**
   * Change the backing file reference: `qemu-img rebase -b <backing> <path>`.
   *
   * Safe mode (the default) reads the old chain and writes the differences
   * down, so guest-visible content survives. {@linkcode RebaseOptions.unsafe}
   * skips that, and combining it with an empty `backing` throws
   * {@linkcode QemuImgUnsafeOperationError} unless
   * {@linkcode RebaseOptions.acknowledgeDataLoss} is set — see those options.
   */
  async rebase(path: string, options: RebaseOptions): Promise<void> {
    if (
      options.unsafe === true && options.backing === "" &&
      options.acknowledgeDataLoss !== true
    ) {
      throw new QemuImgUnsafeOperationError(
        "rebase",
        "`unsafe` with an empty `backing` drops the backing reference " +
          "without copying the base's data down, so every cluster the " +
          "overlay never wrote reads back as zeros — and check() still " +
          'passes. Flatten with rebase(path, { backing: "" }) (safe mode) ' +
          "or convert() instead; both need a readable base. When the base " +
          "is gone, or the image is self-contained or has no backing file " +
          "at all, this pair is the right call: pass acknowledgeDataLoss.",
      );
    }
    await this.#checkedVoid([
      "rebase",
      ...flag("-f", options.format),
      ...(options.unsafe === true ? ["-u"] : []),
      "-b",
      options.backing,
      ...flag("-F", options.backingFormat),
      path,
    ], options);
  }

  /** Resize an image: `qemu-img resize <path> <size>` (`"+1G"` grows). */
  async resize(
    path: string,
    size: SizeValue,
    options: ResizeOptions = {},
  ): Promise<void> {
    await this.#checkedVoid([
      "resize",
      ...flag("-f", options.format),
      ...(options.preallocation === undefined
        ? []
        : [`--preallocation=${options.preallocation}`]),
      ...(options.shrink === true ? ["--shrink"] : []),
      path,
      sizeArg(size),
    ], options);
  }

  /** Escape hatch: run raw qemu-img argv through the seam (recorded by fakes like everything else). */
  async raw(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    return await this.#o.runner.run(this.#o.bin, args, {
      ...buildRunOptions(this.#o, options, {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.uncapped === undefined
          ? {}
          : { uncapped: options.uncapped }),
      }),
    });
  }

  #run(
    args: readonly string[],
    call: CallOptions,
    extra: Pick<RunOptions, "stdin" | "uncapped"> = {},
  ): Promise<CommandResult> {
    return this.#o.runner.run(
      this.#o.bin,
      args,
      buildRunOptions(this.#o, call, extra),
    );
  }

  #checked(
    args: readonly string[],
    call: CallOptions,
    extra: Pick<RunOptions, "stdin" | "uncapped"> = {},
  ): Promise<CommandResult> {
    return runChecked(
      this.#o.runner,
      this.#o.bin,
      args,
      buildRunOptions(this.#o, call, extra),
    );
  }

  async #checkedVoid(
    args: readonly string[],
    call: CallOptions,
  ): Promise<void> {
    await this.#checked(args, call);
  }
}

function flag(
  name: string,
  value: string | number | undefined,
): string[] {
  return value === undefined ? [] : [name, sizeArg(value)];
}

/** The shared refusal message for an option graph paired with a format flag. */
function MUTUALLY_EXCLUSIVE(verb: string): string {
  return `${verb} cannot combine an option graph with a format flag: ` +
    "qemu rejects --image-opts alongside --format (put the format in the " +
    "graph's `driver` instead)";
}

/** Whether an {@linkcode ImageRef} is an option graph rather than a path. */
function isOptionGraph(
  ref: ImageRef,
): ref is { readonly imageOpts: BlockNodeSpec } {
  return typeof ref !== "string";
}

/** The argv token for an {@linkcode ImageRef}. */
function refArg(ref: ImageRef): string {
  return isOptionGraph(ref) ? renderBlockNode(ref.imageOpts) : ref;
}

/**
 * Render a {@linkcode BlockNodeSpec} to `key=value,child.key=value`, keys
 * sorted so the argv a given graph produces is stable.
 */
export function renderBlockNode(node: BlockNodeSpec): string {
  const flat: Record<string, string> = {};
  const walk = (current: BlockNodeSpec, prefix: string): void => {
    for (const key of Object.keys(current)) {
      const value = current[key];
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (typeof value === "object" && value !== null) {
        walk(value, path);
      } else {
        flat[path] = typeof value === "boolean"
          ? (value ? "on" : "off")
          : String(value);
      }
    }
  };
  walk(node, "");
  return Object.keys(flat)
    .sort()
    .map((key) => `${key}=${flat[key]}`)
    .join(",");
}

function sizeArg(value: SizeValue): string {
  return typeof value === "number" ? String(value) : value;
}

function formatOptionsArg(options: FormatOptions): string {
  return Object.keys(options)
    .sort()
    .map((key) => {
      const value = options[key];
      const rendered = typeof value === "boolean"
        ? (value ? "on" : "off")
        : String(value);
      return `${key}=${rendered}`;
    })
    .join(",");
}
