/**
 * {@linkcode FakeQemuImg} — a recording, stateful fake of the `qemu-img` CLI
 * implementing the {@linkcode import("../src/runner.ts").CommandRunner} seam.
 *
 * It models a coherent in-memory image store (formats, virtual sizes,
 * backing references, snapshots, bitmaps) and dispatches on the exact argv
 * the client emits, so tests assert both behavior AND the precise command
 * sequence — with no `qemu-img` binary.
 *
 * Image content is **declared, never invented**. A test states what an image
 * holds with {@linkcode FakeQemuImg.setImage}'s `content`, and the fake then
 * keeps `create`, `convert` and `map` consistent with that declaration —
 * flattening the backing chain, and, under
 * {@linkcode FakeQemuImg.materialize}, writing the bytes out as real files.
 * What it will not do is answer a question about content nobody declared;
 * that is what {@linkcode FakeQemuImg.refuseContentOracles} is for.
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

/** One extent, shaped like a `qemu-img map --output=json` entry. */
export interface FakeExtent {
  /** Guest offset in bytes. */
  readonly start: number;
  /** Extent length in bytes. */
  readonly length: number;
  /** Backing-chain depth that allocated it. @default 0 */
  readonly depth?: number;
  /** Whether the extent is allocated in the chain. @default true */
  readonly present?: boolean;
  /** Whether it reads as zeros. @default false */
  readonly zero?: boolean;
  /** Whether it carries stored data. @default the negation of `zero` */
  readonly data?: boolean;
  /** Host file offset, when the mapping is direct. */
  readonly offset?: number;
}

/** Mutable per-image fake state. */
export interface FakeImageState {
  /** Image format (`"qcow2"`, `"raw"`, …). */
  format: string;
  /** Guest-visible size in bytes. */
  virtualSizeBytes?: number;
  /** Backing file reference, when the image is an overlay. */
  backingFilename?: string;
  /**
   * The backing reference resolved against this image's own directory —
   * qcow2 records a path relative to the OVERLAY, and qemu-img resolves it
   * that way before opening it. Lookups follow this; `backingFilename` stays
   * the string as written, which is what `info` reports.
   */
  backingPath?: string;
  /** Backing file format. */
  backingFormat?: string;
  /**
   * The bytes this layer declares, from guest offset 0.
   *
   * The fake never invents this and never derives it from an image on disk:
   * a test states it, and everything downstream — the chain flattening in
   * {@linkcode FakeQemuImg.contentOf}, what `convert` propagates, what `map`
   * reports, what {@linkcode FakeQemuImg.materialize} writes — follows from
   * the declaration. Absent means "nobody said", which is a different answer
   * from "empty" and is why `map` can refuse.
   */
  content?: Uint8Array;
  /**
   * The exact extents `map` should report for this image.
   *
   * Declare these when a test is *about* allocation — that a digest ignores
   * how the same bytes were stored, say. Otherwise leave it out and the
   * extents follow from `content`.
   */
  extents?: readonly FakeExtent[];
  /** Internal snapshots, in creation order. */
  snapshots: { id: string; tag: string }[];
  /** Persistent dirty bitmaps. */
  bitmaps: Set<string>;
}

/** One recorded `create`, decoded. */
export interface FakeCreate {
  /** The image path being created. */
  readonly path: string;
  /** Output format (`-f`). */
  readonly format: string;
  /** The requested virtual size, parsed; absent when the size came from a backing file. */
  readonly sizeBytes?: number;
  /** The backing reference as written on the command line (`-b`). */
  readonly backing?: string;
  /** That reference resolved against the new image's own directory. */
  readonly backingPath?: string;
  /** The backing format (`-F`). */
  readonly backingFormat?: string;
  /** The raw `-o` option string, when given. */
  readonly options?: string;
  /** The raw recorded call. */
  readonly raw: RecordedCall;
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
  /** Whether the source was an `--image-opts` graph rather than a path. */
  readonly sourceIsGraph?: boolean;
  /** Whether the destination was a `--target-image-opts` graph (a window write). */
  readonly destIsGraph?: boolean;
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
  /** Every decoded `create`, in order. */
  readonly creates: FakeCreate[] = [];
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
  /**
   * Hook: observe a `create` before the image is registered, and/or override
   * its result. Return `undefined` for the default behavior.
   *
   * Fires before registration, like {@linkcode FakeQemuImg.onConvert}, so
   * returning a result leaves nothing behind. A hook that declares content
   * with `setImage(create.path, { content })` survives: registration merges
   * over whatever is already there.
   */
  onCreate?: (create: FakeCreate) => CommandResult | undefined | void;
  /**
   * Treat the host filesystem as the image store.
   *
   * With this on, every image `create` or `convert` produces is written out as
   * a real file holding exactly the content its chain declares (nothing, when
   * none is declared — never a guess), a `raw` image is extended sparsely to
   * its virtual size so its unwritten tail reads as the zeros it would on a
   * real one, and a path that already exists on disk is openable even though
   * no test declared it.
   *
   * Off by default: the fake is an in-memory model and reaching the host
   * filesystem from a unit test should be a decision. Turn it on to drive code
   * that opens the images it asks about — a store hashing a container file, a
   * digest reading extents — or code that RENAMES a layer into place, which an
   * in-memory map has no way to observe. @default false
   */
  materialize = false;
  /**
   * Make `compare`, `check` and unanswerable `map`s throw instead of lying.
   *
   * Those three verbs are the fake's content oracles. `compare` reports
   * "Images are identical" whenever both paths exist and `check` hardcodes
   * zero errors — neither has anything to consult, so both are refused
   * outright. `map` is refused only when the image declares neither `extents`
   * nor `content`, because then all it can do is claim one full-length data
   * extent whether or not anything was ever written there. Code whose
   * correctness *depends* on those answers — anything verifying that an image
   * holds the bytes it should — otherwise passes against this fake for the
   * wrong reason. @default false
   */
  refuseContentOracles = false;

  readonly #stubs: Stub[] = [];
  /** Materialized images by `dev:ino`, so a RENAMED file is still itself. */
  readonly #byInode = new Map<string, FakeImageState>();
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
    const subcommand = args[0];
    // Validate flags for every subcommand at one choke point, including the
    // ones whose handlers read only the last positional.
    if (subcommand !== undefined && subcommand in FLAGS) {
      positionalsOf(args.slice(1), FLAGS[subcommand]);
    }
    if (this.refuseContentOracles) {
      const undeclared = subcommand === "map" &&
        this.#declaredMap(lastPositional(args)) === undefined;
      if (subcommand === "compare" || subcommand === "check" || undeclared) {
        throw new Error(
          `fake qemu-img: refusing to answer '${subcommand}' — this fake ` +
            "models no image content beyond what a test declared, so its " +
            "answer would be fiction. Declare it with `setImage(path, { " +
            "content })` or `{ extents }`, assert on the recorded argv, or " +
            "exercise this path against a real qemu-img in a smoke test.",
        );
      }
    }
    switch (subcommand) {
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
        return this.#create(call);
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

  /**
   * The bytes a guest reads through `path`, flattening the backing chain.
   *
   * Each layer's declared content is written over its parent's from offset 0,
   * base first — a qcow2 overlay is a delta in guest address space, so that
   * is the only composition rule that means anything here. `undefined` when
   * no layer in the chain declared any: the fake has nothing to say, rather
   * than an empty image to claim.
   */
  contentOf(path: string): Uint8Array | undefined {
    const chain: FakeImageState[] = [];
    const seen = new Set<string>();
    let current: string | undefined = path;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const state = this.images.get(current);
      if (state === undefined) break;
      chain.push(state);
      current = state.backingPath ?? state.backingFilename;
    }
    let flat: Uint8Array | undefined;
    for (const state of chain.reverse()) {
      if (state.content === undefined) continue;
      if (flat === undefined || state.content.length >= flat.length) {
        flat = state.content.slice();
        continue;
      }
      flat.set(state.content, 0);
    }
    return flat;
  }

  /**
   * The state for a path the fake is being asked to open.
   *
   * Under {@linkcode FakeQemuImg.materialize} a file on disk is openable even
   * though nothing declared it at that path — which is what a layer looks like
   * after code under test RENAMED it into place. It is matched by inode first,
   * so a moved image is still the same image with the same declared size and
   * content; a file the fake never wrote is adopted with neither, because it
   * has no idea what is in it.
   */
  #openable(path: string): FakeImageState | undefined {
    const known = this.images.get(path);
    if (known !== undefined) return known;
    if (!this.materialize) return undefined;
    const identity = inodeOf(path);
    if (identity === undefined) return undefined;
    const moved = this.#byInode.get(identity);
    if (moved !== undefined) {
      // The same object under both names: it is one file, and a `rebase` or
      // `resize` through either path is a change to the same image.
      this.images.set(path, moved);
      return moved;
    }
    this.setImage(path, {});
    return this.images.get(path);
  }

  /** Write an image out as a real file holding what its chain declares. */
  #materialize(path: string): CommandResult | undefined {
    if (!this.materialize) return undefined;
    const state = this.images.get(path);
    if (state === undefined) return undefined;
    const content = this.contentOf(path) ?? new Uint8Array();
    try {
      Deno.writeFileSync(path, content);
      // A raw image IS its guest address space, so its unwritten tail has to
      // read as zeros out to the virtual size. Sparse, so a 64 GiB declaration
      // still costs nothing.
      const size = state.virtualSizeBytes ?? 0;
      if (state.format === "raw" && size > content.length) {
        Deno.truncateSync(path, size);
      }
    } catch (error) {
      this.images.delete(path);
      return failed(
        1,
        `qemu-img: Could not open '${path}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const identity = inodeOf(path);
    if (identity !== undefined) this.#byInode.set(identity, state);
    return undefined;
  }

  #requireImage(
    path: string,
    then: (state: FakeImageState) => CommandResult,
  ): CommandResult {
    const state = this.#openable(path);
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
    const positionals = positionalsOf(args.slice(1), FLAGS.bitmap);
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
    const positionals = positionalsOf(args.slice(1), FLAGS.compare);
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
    // Option-graph operands (`--image-opts` / `--target-image-opts`) are
    // opaque node descriptions, not paths: they are never looked up in the
    // image store, and a graph destination writes INTO an existing node
    // rather than creating one.
    const sourceIsGraph = args.includes("--image-opts");
    const destIsGraph = args.includes("--target-image-opts");
    const format = valueOf(args, "-O", "--target-format") ??
      (destIsGraph ? "raw" : undefined);
    if (format === undefined) {
      return failed(1, "fake qemu-img: convert needs -O");
    }
    const positionals = positionalsOf(args.slice(1), FLAGS.convert);
    if (positionals.length < 2) {
      return failed(1, "fake qemu-img: convert needs SOURCE… DEST");
    }
    const dest = positionals[positionals.length - 1];
    const sources = positionals.slice(0, -1);
    const sourceFormat = valueOf(args, "-f", "--source-format");
    const convert: FakeConvert = {
      sources,
      dest,
      format,
      compress: args.includes("-c"),
      ...(sourceFormat === undefined ? {} : { sourceFormat }),
      ...(sourceIsGraph ? { sourceIsGraph } : {}),
      ...(destIsGraph ? { destIsGraph } : {}),
      raw: call,
    };
    this.converts.push(convert);
    if (!sourceIsGraph) {
      for (const source of sources) {
        if (this.#openable(source) === undefined) {
          return failed(1, `qemu-img: Could not open '${source}'`);
        }
      }
    }
    const hooked = this.onConvert?.(convert);
    if (hooked !== undefined) return hooked;
    // A graph destination targets a node inside an image that already exists;
    // there is nothing to register, and its size is unchanged.
    if (destIsGraph) return ok();
    // Concatenated sources sum their virtual sizes, like real convert.
    let virtualSizeBytes = 0;
    let known = true;
    for (const source of sources) {
      const size = this.images.get(source)?.virtualSizeBytes;
      if (size === undefined) known = false;
      else virtualSizeBytes += size;
    }
    // A conversion reads the source through its whole backing chain, so the
    // destination holds the FLATTENED content. Only for a single source: how
    // qemu pads each operand of a concatenation out to its virtual size is not
    // modeled, and guessing it would put bytes at offsets nobody declared.
    const content = sources.length === 1 && !sourceIsGraph
      ? this.contentOf(sources[0])
      : undefined;
    const backing = valueOf(args, "-B", "-b", "--backing");
    this.setImage(dest, {
      format,
      snapshots: [],
      bitmaps: new Set(),
      ...(known ? { virtualSizeBytes } : {}),
      ...(content === undefined
        ? (this.materialize ? { content: new Uint8Array() } : {})
        : { content }),
      ...(backing === undefined ? {} : {
        backingFilename: backing,
        backingPath: resolveAgainst(dirnameOf(dest), backing),
      }),
    });
    return this.#materialize(dest) ?? ok();
  }

  #create(call: RecordedCall): CommandResult {
    const args = call.args;
    const format = valueOf(args, "-f", "--format");
    if (format === undefined) {
      return failed(1, "fake qemu-img: create needs -f");
    }
    const positionals = positionalsOf(args.slice(1), FLAGS.create);
    const [path, size] = positionals;
    if (path === undefined) {
      return failed(1, "fake qemu-img: create needs PATH");
    }
    const backing = valueOf(args, "-b", "--backing");
    const backingFormat = valueOf(args, "-F", "-B", "--backing-format");
    const options = valueOf(args, "-o", "--options");
    const sizeBytes = size === undefined ? undefined : parseSizeBytes(size);
    // qcow2 stores a backing reference relative to the OVERLAY, and qemu-img
    // resolves it that way before opening it. Keeping the string as written
    // AND its resolution is what lets a test assert the reference is relative
    // while the fake still finds the parent it names.
    const backingPath = backing === undefined || backing === ""
      ? undefined
      : resolveAgainst(dirnameOf(path), backing);
    const create: FakeCreate = {
      path,
      format,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      ...(backing === undefined ? {} : { backing }),
      ...(backingPath === undefined ? {} : { backingPath }),
      ...(backingFormat === undefined ? {} : { backingFormat }),
      ...(options === undefined ? {} : { options }),
      raw: call,
    };
    this.creates.push(create);
    const hooked = this.onCreate?.(create);
    if (hooked !== undefined) return hooked;

    // `-u` is the documented escape from this check, and the only one: without
    // it qemu-img OPENS the backing file, so a chain built on a reference that
    // resolves nowhere fails here rather than producing an overlay that reads
    // as zeros. Accepting it silently is how a test proves a relative backing
    // path is correct when it is not.
    const unsafe = args.includes("-u") || args.includes("--backing-unsafe");
    let parent: FakeImageState | undefined;
    if (backingPath !== undefined && !unsafe) {
      parent = this.#openable(backingPath);
      if (parent === undefined) {
        return failed(
          1,
          `qemu-img: Could not open backing file: Could not open ` +
            `'${backingPath}': No such file or directory`,
        );
      }
    }
    const virtualSizeBytes = sizeBytes ?? parent?.virtualSizeBytes;
    if (size === undefined && backing === undefined) {
      return failed(1, "qemu-img: Image creation needs a size");
    }
    this.setImage(path, {
      format,
      snapshots: [],
      bitmaps: new Set(),
      ...(virtualSizeBytes === undefined ? {} : { virtualSizeBytes }),
      ...(backing === undefined ? {} : { backingFilename: backing }),
      ...(backingPath === undefined ? {} : { backingPath }),
      ...(backingFormat === undefined ? {} : { backingFormat }),
      // A fresh image holds nothing until something writes to it, and under
      // `materialize` that has to be said out loud — otherwise `map` falls
      // back to claiming a full-length data extent over a file that is empty.
      ...(this.materialize && this.images.get(path)?.content === undefined
        ? { content: new Uint8Array() }
        : {}),
    });
    return this.#materialize(path) ?? ok();
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
      // qemu-img reports both: the reference as qcow2 records it, and the one
      // it actually opened after resolving that against this image's own
      // directory. A relative backing makes them different strings.
      ...(state.backingFilename === undefined ? {} : {
        "backing-filename": state.backingFilename,
        "full-backing-filename": state.backingPath ?? state.backingFilename,
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

  /**
   * The extents a test DECLARED for `path`, or `undefined` when it declared
   * none — which is the question {@linkcode FakeQemuImg.refuseContentOracles}
   * turns into a refusal.
   */
  #declaredMap(path: string): FakeExtent[] | undefined {
    const state = this.#openable(path);
    if (state === undefined) return undefined;
    if (state.extents !== undefined) return [...state.extents];
    const content = this.contentOf(path);
    if (content === undefined) return undefined;
    const extents: FakeExtent[] = [];
    if (content.length > 0) {
      extents.push({
        start: 0,
        length: content.length,
        depth: 0,
        present: true,
        zero: false,
        data: true,
        offset: 0,
      });
    }
    // Everything past the declared content reads as zeros. Reporting it —
    // rather than omitting it — is the shape a caller that folds allocation
    // away has to survive, and the two spellings must digest the same.
    const size = state.virtualSizeBytes ?? content.length;
    if (size > content.length) {
      extents.push({
        start: content.length,
        length: size - content.length,
        depth: 0,
        present: true,
        zero: true,
        data: false,
      });
    }
    return extents;
  }

  #map(args: readonly string[]): CommandResult {
    const path = lastPositional(args);
    return this.#requireImage(path, (state) => {
      const declared = this.#declaredMap(path);
      const extents = declared ??
        // Nothing declared: the legacy answer, one full-length data extent.
        // It is a guess, which is why `refuseContentOracles` suppresses it.
        [{
          start: 0,
          length: state.virtualSizeBytes ?? 0,
          depth: 0,
          present: true,
          zero: false,
          data: true,
          offset: 0,
        }];
      return ok(
        JSON.stringify(extents.map((extent) => ({
          "start": extent.start,
          "length": extent.length,
          "depth": extent.depth ?? 0,
          "present": extent.present ?? true,
          "zero": extent.zero ?? false,
          "data": extent.data ?? extent.zero !== true,
          ...(extent.offset === undefined ? {} : { "offset": extent.offset }),
        }))) + "\n",
      );
    });
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
    const backing = valueOf(args, "-b", "--backing");
    if (backing === undefined) {
      return failed(1, "fake qemu-img: rebase needs -b");
    }
    const path = lastPositional(args);
    return this.#requireImage(path, (state) => {
      if (backing === "") {
        delete state.backingFilename;
        delete state.backingPath;
      } else {
        state.backingFilename = backing;
        state.backingPath = resolveAgainst(dirnameOf(path), backing);
      }
      const backingFormat = valueOf(args, "-F", "-B", "--backing-format");
      if (backingFormat !== undefined) state.backingFormat = backingFormat;
      return ok();
    });
  }

  #resize(args: readonly string[]): CommandResult {
    const positionals = positionalsOf(args.slice(1), FLAGS.resize);
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

/** The flags one subcommand accepts, split by whether they consume a value. */
interface FlagSpec {
  /** Flags whose value is the next argv entry (or follows a `=`). */
  readonly value: ReadonlySet<string>;
  /** Flags that stand alone. */
  readonly boolean: ReadonlySet<string>;
}

function spec(value: string[], boolean: string[] = []): FlagSpec {
  return { value: new Set(value), boolean: new Set(boolean) };
}

/**
 * Per-subcommand flag tables, covering both the short spellings the client
 * emits and the long ones qemu-img documents. qemu-img 11.0 renamed the
 * backing flags in opposite directions — `create`'s backing FORMAT moved
 * `-F` → `-B`, while `convert`'s backing FILE moved `-B` → `-b` — so the
 * spellings are listed per subcommand rather than shared.
 */
const FLAGS: Readonly<Record<string, FlagSpec>> = {
  amend: spec(["-f", "--format", "-o", "--options", "-t", "--object"], [
    "-q",
    "--quiet",
    "--force",
  ]),
  bench: spec([
    "-c",
    "-d",
    "-f",
    "--format",
    "-o",
    "-s",
    "-S",
    "-t",
    "--flush-interval",
    "--pattern",
  ], ["-w", "-n", "--no-drain", "-U", "-q", "--image-opts"]),
  bitmap: spec(["-f", "--format", "-g", "-b", "-F", "--merge", "--object"], [
    "--add",
    "--remove",
    "--clear",
    "--enable",
    "--disable",
    "-q",
  ]),
  check: spec(["-f", "--format", "-r", "--repair", "-t", "--output"], [
    "-q",
    "-U",
    "--image-opts",
  ]),
  commit: spec(["-f", "--format", "-b", "--base", "-r", "--rate", "-t"], [
    "-d",
    "-p",
    "-q",
  ]),
  compare: spec(["-f", "-F", "-T", "-t", "--object"], [
    "-s",
    "--strict",
    "-p",
    "-q",
    "-U",
    "--image-opts",
  ]),
  convert: spec([
    "-f",
    "--source-format",
    "-O",
    "--target-format",
    "-o",
    "--options",
    "-B",
    "-b",
    "--backing",
    "-F",
    "--backing-format",
    "-S",
    "--sparse-size",
    "-m",
    "-r",
    "-t",
    "-T",
    "--object",
  ], [
    "-c",
    "-n",
    "-p",
    "-q",
    "-U",
    "-W",
    "-C",
    "--target-is-zero",
    "--salvage",
    "--image-opts",
    "--target-image-opts",
  ]),
  create: spec([
    "-f",
    "--format",
    "-o",
    "--options",
    "-b",
    "--backing",
    "-F",
    "-B",
    "--backing-format",
    "--object",
  ], ["-u", "--backing-unsafe", "-q", "--quiet"]),
  dd: spec(["-f", "-O", "--object"], ["-q", "-U", "--image-opts"]),
  info: spec(["-f", "--format", "--output", "--object"], [
    "--backing-chain",
    "-U",
    "--image-opts",
  ]),
  map: spec(["-f", "--format", "--output", "--object"], [
    "-U",
    "--image-opts",
  ]),
  measure: spec([
    "-f",
    "-O",
    "-o",
    "--size",
    "--output",
    "--object",
  ], ["--image-opts", "-U"]),
  rebase: spec([
    "-f",
    "--format",
    "-b",
    "--backing",
    "-F",
    "-B",
    "--backing-format",
    "-t",
    "-T",
    "--object",
  ], ["-u", "-c", "-p", "-q", "-U", "--image-opts"]),
  resize: spec(["-f", "--format", "--preallocation", "--object"], [
    "--shrink",
    "-q",
    "-p",
  ]),
  snapshot: spec(["-c", "-a", "-d", "--object"], ["-l", "-q", "-U"]),
};

/** The directory part of a path, POSIX-style. */
function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return ".";
  return cut === 0 ? "/" : path.slice(0, cut);
}

/**
 * Resolve `ref` against `dir`, collapsing `.` and `..`.
 *
 * Purely lexical, and deliberately so: this stands in for how qemu-img joins
 * a backing reference to the overlay's own directory, which is a string
 * operation there too — no symlink is followed and no file needs to exist.
 */
function resolveAgainst(dir: string, ref: string): string {
  const joined = ref.startsWith("/") ? ref : `${dir}/${ref}`;
  const absolute = joined.startsWith("/");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last !== "..") out.pop();
    else if (!absolute) out.push("..");
  }
  return (absolute ? "/" : "") + out.join("/");
}

/**
 * `dev:ino` for a real file, or `undefined` when there is none to look at.
 *
 * A missing file and a read permission this test was not granted answer the
 * same way on purpose: either way the fake has no file to open, and reporting
 * that beats throwing out of a `dispatch` the caller expected an exit code
 * from.
 */
function inodeOf(path: string): string | undefined {
  try {
    const stat = Deno.statSync(path);
    if (!stat.isFile || stat.dev === null || stat.ino === null) {
      return undefined;
    }
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/** Split `--flag=value` into its name; a bare flag is its own name. */
function flagName(arg: string): string {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
}

function lastPositional(args: readonly string[]): string {
  return args[args.length - 1] ?? "";
}

/**
 * Extract positionals, **throwing** on any flag the subcommand does not
 * declare.
 *
 * Skipping unknown flags silently is the failure this test kit exists to
 * prevent: `create -f qcow2 --backing base.qcow2 … /out.qcow2` used to yield
 * positionals `["base.qcow2", "qcow2", "/out.qcow2"]`, so the fake registered
 * an image at `base.qcow2`, clobbered the real base's state, never created
 * `/out.qcow2`, and returned exit 0 — every assertion downstream passing
 * against an image that was never built. Loud beats silent, in the test kit
 * as much as in the client.
 */
function positionalsOf(
  args: readonly string[],
  flags: FlagSpec,
): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const name = flagName(arg);
    if (flags.value.has(name)) {
      // `--flag=value` carries its own value; `--flag value` consumes the next.
      if (arg.indexOf("=") === -1) index++;
      continue;
    }
    if (flags.boolean.has(name)) continue;
    throw new Error(
      `fake qemu-img: unrecognized flag ${name} in [${args.join(" ")}]. ` +
        "Add it to this subcommand's FLAGS entry in testing/fake_qemu_img.ts " +
        "— silently skipping it would mis-parse the positionals.",
    );
  }
  return positionals;
}

/** The value of the first spelling present, supporting `--flag=value`. */
function valueOf(
  args: readonly string[],
  ...spellings: readonly string[]
): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!spellings.includes(flagName(arg))) continue;
    const equals = arg.indexOf("=");
    return equals === -1 ? args[index + 1] : arg.slice(equals + 1);
  }
  return undefined;
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
