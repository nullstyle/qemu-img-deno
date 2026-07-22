/**
 * Turning declared inputs into digests — the only I/O that happens before
 * planning.
 *
 * The walk is also where a step's capability requirements come from. Traits
 * are DERIVED from the data, never declared: a tree that happens to contain a
 * symlink requires symlink support whether or not its author noticed, and a
 * FAT partition holding it would drop the symlink silently.
 *
 * @module
 */

import { sha256Hex } from "./keys.ts";
import { sha256HexFile } from "../digest.ts";
import { InputResolutionError } from "./errors.ts";
import type { CapabilityTrait } from "./errors.ts";
import type {
  ArchiveCompression,
  DirInput,
  FileInput,
  Input,
  Recipe,
  ResolvedEntry,
  ResolvedInput,
  ResolvedRecipe,
  Step,
} from "./types.ts";

/** The seam that turns declared inputs into digests. Fakeable in tests. */
export interface InputResolver {
  /** Resolve one input to its digest (and tree detail, for a directory). */
  resolve(input: Input): Promise<ResolvedInput>;
}

/** Files at or above this size make `largeFiles` a required trait (4 GiB). */
const LARGE_FILE_BYTES = 4 * 1024 ** 3;

/** Walk a directory in byte-wise path order, hashing every file. */
async function walkTree(root: string): Promise<ResolvedEntry[]> {
  const entries: ResolvedEntry[] = [];
  const visit = async (dirPath: string, prefix: string): Promise<void> => {
    const children: Deno.DirEntry[] = [];
    for await (const child of Deno.readDir(dirPath)) children.push(child);
    // Byte-wise, not locale-aware: a locale-sensitive sort would make the
    // digest depend on the machine's collation settings.
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      const full = `${dirPath}/${child.name}`;
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      const info = await Deno.lstat(full);
      if (info.isSymlink) {
        entries.push({
          path: relative,
          type: "symlink",
          mode: info.mode ?? 0,
          sizeBytes: 0,
          linkTarget: await Deno.readLink(full),
          ...(info.uid === null ? {} : { uid: info.uid }),
          ...(info.gid === null ? {} : { gid: info.gid }),
        });
        continue;
      }
      if (info.isDirectory) {
        entries.push({
          path: relative,
          type: "dir",
          mode: info.mode ?? 0,
          sizeBytes: 0,
          ...(info.uid === null ? {} : { uid: info.uid }),
          ...(info.gid === null ? {} : { gid: info.gid }),
        });
        await visit(full, relative);
        continue;
      }
      entries.push({
        path: relative,
        type: "file",
        mode: info.mode ?? 0,
        sizeBytes: info.size,
        // Streamed, not `sha256Hex(await Deno.readFile(full))`: that held the
        // whole file and `crypto.subtle` copied it again to hash it, so one
        // 2 GiB member of a staging tree peaked at 4.05 GiB of RSS. Same
        // digest, so no key moves — see sha256HexFile.
        sha256: await sha256HexFile(full),
        ...(info.uid === null ? {} : { uid: info.uid }),
        ...(info.gid === null ? {} : { gid: info.gid }),
      });
    }
  };
  await visit(root, "");
  return entries;
}

/**
 * Derive the filesystem capabilities a tree requires.
 *
 * Note what is NOT here: mtime. Hashing mtimes false-misses on every CI
 * checkout, which rewrites them with identical content, and false-hits on an
 * archive restored with mtimes preserved but content changed.
 */
export function traitsOf(entries: readonly ResolvedEntry[]): CapabilityTrait[] {
  const traits = new Set<CapabilityTrait>();
  const owners = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "symlink") traits.add("symlinks");
    // The executable bit and the setuid/setgid/sticky bits are the ones a
    // metadata-less filesystem loses in a way that changes behaviour.
    if ((entry.mode & 0o111) !== 0 && entry.type === "file") {
      traits.add("posixModes");
    }
    if ((entry.mode & 0o7000) !== 0) traits.add("posixModes");
    owners.add(`${entry.uid ?? 0}:${entry.gid ?? 0}`);
    if (entry.sizeBytes >= LARGE_FILE_BYTES) traits.add("largeFiles");
  }
  // Ownership counts as required only when it VARIES within the tree.
  //
  // A staging tree checked out by a normal user is uniformly owned by that
  // user — uid 501 on a Mac — which is an artifact of who ran the build, not
  // an intent about the image. Treating that as required ownership would make
  // every FAT partition unbuildable on any machine where you are not root,
  // which is every machine this package targets. Heterogeneous ownership, on
  // the other hand, is information no metadata-less filesystem can carry.
  if (owners.size > 1) traits.add("posixOwnership");
  return [...traits].sort();
}

/** Leading magic bytes for each compression this package can name. */
const COMPRESSION_MAGIC: readonly {
  readonly compression: ArchiveCompression;
  readonly magic: readonly number[];
}[] = [
  { compression: "gzip", magic: [0x1f, 0x8b] },
  { compression: "bzip2", magic: [0x42, 0x5a, 0x68] },
  { compression: "xz", magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },
  { compression: "zstd", magic: [0x28, 0xb5, 0x2f, 0xfd] },
  // The last entry, because LZMA's "magic" is one plausible properties byte
  // followed by a little-endian dictionary size — a weak signature that would
  // shadow a stronger one if it were tested first.
  { compression: "lzma", magic: [0x5d, 0x00, 0x00] },
];

/** Longest compression magic this package recognizes. */
const MAGIC_BYTES = 8;

/**
 * The first {@linkcode MAGIC_BYTES} of a file, for compression sniffing.
 *
 * A short file yields a short array, which `detectCompression` treats as
 * "none" — the same answer reading the whole thing would give.
 */
async function readMagic(path: string): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(MAGIC_BYTES);
    const read = await file.read(buffer) ?? 0;
    return buffer.subarray(0, read);
  } finally {
    file.close();
  }
}

/**
 * Name a file's compression from its first bytes.
 *
 * Exported because it is the whole basis for the `unpack` refusals, and a
 * refusal whose evidence cannot be unit-tested on its own is a refusal nobody
 * can check. `"none"` means "no compression signature" — for an `unpack` step
 * that is a plain `.tar`, which busybox reads directly.
 */
export function detectCompression(bytes: Uint8Array): ArchiveCompression {
  for (const { compression, magic } of COMPRESSION_MAGIC) {
    if (bytes.byteLength < magic.length) continue;
    if (magic.every((byte, index) => bytes[index] === byte)) return compression;
  }
  return "none";
}

/** Resolves inputs against the real filesystem. */
export class LocalInputResolver implements InputResolver {
  /** Hash a file, or walk and hash a directory tree. */
  async resolve(input: Input): Promise<ResolvedInput> {
    if (input.kind === "file") {
      // A `kind: "image"` base is a declared file input, and cloud images are
      // measured in GiB — Alpine's aarch64 qcow2 is 225378304 bytes on disk
      // and the ones people actually start from are far larger. Reading the
      // whole thing to hash it peaked at twice the file in RSS, and it did so
      // BEFORE plan() had a chance to refuse the recipe for any other reason.
      return {
        input,
        sha256: await sha256HexFile(input.path),
        sizeBytes: (await Deno.stat(input.path)).size,
        // Sniffed from the leading bytes, never from the filename: the guest
        // sees a block device with no name at all. Only the magic is read —
        // the digest above streams, and slurping the file to classify it
        // would put the whole thing back in memory for the sake of 6 bytes.
        compression: detectCompression(await readMagic(input.path)),
      };
    }
    const entries = await walkTree(input.path);
    // The tree's identity is the digest of its canonical walk, so two trees
    // with identical content hash identically wherever they live.
    const manifest = entries
      .map((entry) =>
        [
          entry.path,
          entry.type,
          entry.mode.toString(8),
          String(entry.sizeBytes),
          entry.sha256 ?? "",
          entry.linkTarget ?? "",
          String(entry.uid ?? 0),
          String(entry.gid ?? 0),
        ].join("\t")
      )
      .join("\n");
    return {
      input,
      sha256: await sha256Hex(manifest),
      sizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      entries,
      traits: traitsOf(entries),
    };
  }
}

/**
 * A declared input plus where in the recipe it was declared.
 *
 * Carried so a failure to read it can be reported in the recipe's own
 * coordinates. `recipeInputs()` throws the provenance away, which is why a
 * mistyped path used to surface as a bare errno and a path.
 */
interface InputSite {
  /** The declaration. */
  readonly input: Input;
  /** The declaring step's id, or `"recipe"` for `base.from`. */
  readonly stepId: string;
  /** Where in the recipe it sits, e.g. `steps[0].from`. */
  readonly field: string;
}

/** Every input a step declares, with its position, in declaration order. */
function stepInputSites(step: Step, index: number): InputSite[] {
  const at = `steps[${index}]`;
  switch (step.kind) {
    case "partition":
      // Only FAT declares a tree. An ext4 partition is formatted and left
      // empty; it is populated by a `copyIn` step, which declares its own.
      return step.partitions.flatMap((partition, i) =>
        partition.contents.kind === "fat"
          ? [{
            input: partition.contents.from,
            stepId: step.id,
            field: `${at}.partitions[${i}].contents.from`,
          }]
          : []
      );
    case "copyIn":
      return [{ input: step.from, stepId: step.id, field: `${at}.from` }];
    case "unpack":
      return [{ input: step.from, stepId: step.id, field: `${at}.from` }];
    case "run":
      return [];
  }
}

/** Every input a step declares, in declaration order. */
export function inputsOf(step: Step): Input[] {
  return stepInputSites(step, 0).map((site) => site.input);
}

/** Every input the whole recipe declares, with its position. */
function recipeInputSites(recipe: Recipe): InputSite[] {
  const sites: InputSite[] = recipe.base.kind === "image"
    ? [{ input: recipe.base.from, stepId: "recipe", field: "base.from" }]
    : [];
  for (const [index, step] of recipe.steps.entries()) {
    sites.push(...stepInputSites(step, index));
  }
  return sites;
}

/** Every input the whole recipe declares. */
export function recipeInputs(recipe: Recipe): Input[] {
  return recipeInputSites(recipe).map((site) => site.input);
}

/**
 * Replace every declared input with its digest. The only I/O before planning.
 *
 * A resolver failure is rethrown as {@linkcode InputResolutionError} naming the
 * step and field that declared the path. The raw `Deno.errors.NotFound` it
 * replaces named neither, and every input in a recipe is read here — so with
 * more than one staging tree, the reader was left matching an errno against
 * paths by hand.
 */
export async function resolveRecipe(
  recipe: Recipe,
  options: { readonly resolver: InputResolver },
): Promise<ResolvedRecipe> {
  const inputs: Record<string, ResolvedInput> = {};
  for (const site of recipeInputSites(recipe)) {
    const { input } = site;
    if (inputs[input.path] !== undefined) continue;
    try {
      inputs[input.path] = await options.resolver.resolve(input);
    } catch (cause) {
      // Never double-wrapped: a resolver may already speak this vocabulary,
      // and re-wrapping would bury the field it named under this one.
      if (cause instanceof InputResolutionError) throw cause;
      throw new InputResolutionError(
        site.stepId,
        site.field,
        input.kind,
        input.path,
        cause,
      );
    }
  }
  return { recipe, inputs };
}

/** Look up a resolved directory input, or throw if the resolver missed it. */
export function resolvedDir(
  resolved: ResolvedRecipe,
  input: DirInput,
): ResolvedInput {
  const found = resolved.inputs[input.path];
  if (found === undefined) {
    throw new Error(`input ${input.path} was never resolved`);
  }
  return found;
}

/** Look up a resolved file input, or throw if the resolver missed it. */
export function resolvedFile(
  resolved: ResolvedRecipe,
  input: FileInput,
): ResolvedInput {
  const found = resolved.inputs[input.path];
  if (found === undefined) {
    throw new Error(`input ${input.path} was never resolved`);
  }
  return found;
}
