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
import type { CapabilityTrait } from "./errors.ts";
import type {
  DirInput,
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
        sha256: await sha256Hex(await Deno.readFile(full)),
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

/** Resolves inputs against the real filesystem. */
export class LocalInputResolver implements InputResolver {
  /** Hash a file, or walk and hash a directory tree. */
  async resolve(input: Input): Promise<ResolvedInput> {
    if (input.kind === "file") {
      const bytes = await Deno.readFile(input.path);
      return {
        input,
        sha256: await sha256Hex(bytes),
        sizeBytes: bytes.byteLength,
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

/** Every input a step declares, in declaration order. */
export function inputsOf(step: Step): Input[] {
  switch (step.kind) {
    case "partition":
      // Only FAT declares a tree. An ext4 partition is formatted and left
      // empty; it is populated by a `copyIn` step, which declares its own.
      return step.partitions.flatMap((partition) =>
        partition.contents.kind === "fat" ? [partition.contents.from] : []
      );
    case "copyIn":
      return [step.from];
    case "run":
      return [];
  }
}

/** Every input the whole recipe declares. */
export function recipeInputs(recipe: Recipe): Input[] {
  const inputs: Input[] = recipe.base.kind === "image"
    ? [recipe.base.from]
    : [];
  for (const step of recipe.steps) inputs.push(...inputsOf(step));
  return inputs;
}

/**
 * Replace every declared input with its digest. The only I/O before planning.
 */
export async function resolveRecipe(
  recipe: Recipe,
  options: { readonly resolver: InputResolver },
): Promise<ResolvedRecipe> {
  const inputs: Record<string, ResolvedInput> = {};
  for (const input of recipeInputs(recipe)) {
    if (inputs[input.path] === undefined) {
      inputs[input.path] = await options.resolver.resolve(input);
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
