/**
 * Typed refusals raised while planning a recipe, before any binary runs.
 *
 * The house rule from the driver applies here too: an operation that yields a
 * valid image holding less than you asked for needs an explicit
 * acknowledgement, and a guard that can judge the *declaration* alone belongs
 * at plan time rather than in a doc note.
 *
 * @module
 */

/** A filesystem property that a step's input data requires. */
export type CapabilityTrait =
  | "symlinks"
  | "posixModes"
  | "posixOwnership"
  | "deviceNodes"
  | "largeFiles";

/** One staging-tree entry a chosen filesystem cannot represent. */
export interface UnrepresentableEntry {
  /** Path relative to the staging tree root. */
  readonly path: string;
  /** The trait that makes it unrepresentable. */
  readonly reason: CapabilityTrait;
}

/**
 * Why `plan()` refused, as a stable machine-readable token.
 *
 * `RecipePlanError` covers two dozen unrelated causes, and before this existed
 * the only way to tell them apart was to match on `message` — which couples
 * every caller's control flow to prose this package rewrites whenever a
 * measurement improves. These values do not change with the wording; a member
 * is only ever added, or removed in a major bump.
 */
export type RecipePlanErrorCode =
  /** `platform.machine` is an unversioned alias like `"virt"`. */
  | "unversioned-machine"
  /** Two steps share an `id`. */
  | "duplicate-step-id"
  /** A step id contains `:`, which the planner reserves for generated layers. */
  | "reserved-step-id-separator"
  /** Two partitions share a `label`, so their derived GUIDs collide. */
  | "duplicate-partition-label"
  /** A recipe declares more than one `partition` step. */
  | "multiple-partition-tables"
  /** `base.rootPartition` is below 1; GPT partition numbers are 1-based. */
  | "root-partition-out-of-range"
  /** A `partition` step would lay a new GPT over an existing base image. */
  | "partition-over-image-base"
  /** A `run`, `copyIn` or `unpack` step has no unambiguous root filesystem. */
  | "ambiguous-root-filesystem"
  /** `firstPartitionOffset` is negative, fractional, or unaligned. */
  | "invalid-first-partition-offset"
  /** A partition `size` is not a positive whole number of bytes. */
  | "invalid-partition-size"
  /** A partition uses `"rest"` but is not the last one declared. */
  | "rest-not-last"
  /** A partition has no room left on the declared disk. */
  | "partition-no-room"
  /** A partition would overrun the GPT's backup header. */
  | "partition-past-last-usable-lba"
  /** A FAT volume label exceeds 11 bytes. */
  | "fat-label-too-long"
  /** A FAT partition is smaller than vvfat's fixed geometry. */
  | "fat-window-too-small"
  /** A FAT partition is larger than vvfat's fixed geometry. */
  | "fat-window-too-large"
  /** An ext4 partition declares a `from` staging tree it cannot carry. */
  | "ext4-staging-tree"
  /** A `copyIn` destination is not an absolute, normalized path. */
  | "copyin-destination"
  /** A `copyIn` payload holds a file larger than a ustar size field. */
  | "copyin-file-too-large"
  /** An `unpack` destination is not an absolute, normalized path. */
  | "unpack-destination"
  /** An `unpack` `stripComponents` is negative or fractional. */
  | "unpack-strip-components"
  /** The resolver reported no compression for an `unpack` archive. */
  | "unpack-compression-unknown"
  /** The appliance cannot decompress an `unpack` archive. */
  | "unpack-compression-unsupported"
  /** `boot` is `"uefi-removable"` but no partition has type `"esp"`. */
  | "missing-esp"
  /** The ESP holds something other than FAT. */
  | "esp-not-fat"
  /** The ESP staging tree lacks the architecture's EFI fallback binary. */
  | "missing-efi-fallback"
  /** A guest step was planned with no appliance identity. */
  | "appliance-required"
  /** The appliance's architecture disagrees with `platform.arch`. */
  | "appliance-arch-mismatch";

/** A recipe is statically wrong. Thrown by `plan()`, before any I/O. */
export class RecipePlanError extends Error {
  /** The offending step's id, or `"recipe"` for a whole-recipe problem. */
  readonly stepId: string;
  /** Which refusal this is, independent of the message's wording. */
  readonly code: RecipePlanErrorCode;

  /** Build the error; `detail` must name the fix, not just the problem. */
  constructor(stepId: string, code: RecipePlanErrorCode, detail: string) {
    super(`${stepId}: ${detail}`);
    this.name = "RecipePlanError";
    this.stepId = stepId;
    this.code = code;
  }
}

/**
 * A declared input could not be read, named against the recipe that declared it.
 *
 * `resolveRecipe` is the only I/O before planning, and its failures used to
 * surface as whatever `Deno.readFile` or `Deno.readDir` threw: `NotFound: No
 * such file or directory (os error 2): readdir './esp'`. That names an errno
 * and a path, and nothing about which step, which field, or which of the two
 * input kinds was expected — so a `dir("./esp")` typo in a recipe with four
 * staging trees left the reader diffing paths by hand.
 *
 * It stays separate from {@linkcode RecipePlanError} because the two answer
 * different questions: this one means the recipe may be perfectly well-formed
 * and the filesystem does not match it, which is a different fix from a recipe
 * that is statically wrong.
 */
export class InputResolutionError extends Error {
  /** The declaring step's id, or `"recipe"` for `base.from`. */
  readonly stepId: string;
  /** Where in the recipe it was declared, e.g. `steps[0].from`. */
  readonly field: string;
  /** The path as declared, unmodified. */
  readonly path: string;
  /** Which input kind the recipe asked for. */
  readonly inputKind: "file" | "dir";

  /** Build the error, turning the host's failure into recipe coordinates. */
  constructor(
    stepId: string,
    field: string,
    inputKind: "file" | "dir",
    path: string,
    cause: unknown,
  ) {
    const what = inputKind === "dir" ? "directory" : "file";
    const detail = cause instanceof Deno.errors.NotFound
      ? `no such ${what}`
      : cause instanceof Deno.errors.NotADirectory
      ? "that path is a file, and this input is declared as a directory"
      : cause instanceof Deno.errors.IsADirectory
      ? "that path is a directory, and this input is declared as a file"
      : cause instanceof Error
      ? cause.message
      : String(cause);
    super(
      `${stepId}: ${field} declares the ${what} ${JSON.stringify(path)}, ` +
        `which could not be read — ${detail}. Every declared input is hashed ` +
        "into the cache key before anything is built, so this is resolved " +
        `against the process's working directory, not the recipe's file. Fix ` +
        `the path, or create the ${what} it names.`,
      { cause },
    );
    this.name = "InputResolutionError";
    this.stepId = stepId;
    this.field = field;
    this.path = path;
    this.inputKind = inputKind;
  }
}

/**
 * A staging tree carries metadata the chosen filesystem cannot hold.
 *
 * FAT has no symlinks, no mode bits, no ownership and no device nodes. Without
 * this refusal the build produces a perfectly valid filesystem that is
 * silently missing all of them: it mounts, `fsck` passes, and a rootfs built
 * that way is quietly wrong. The staging tree is declared data that the
 * resolver has already walked, so this can be judged without opening an image
 * — which is exactly the condition that makes it a refusal rather than a
 * documented sharp edge.
 */
export class UnrepresentableContentError extends Error {
  /** The offending step's id. */
  readonly stepId: string;
  /** The entries that would have been silently dropped. */
  readonly entries: readonly UnrepresentableEntry[];

  /** Build the error, listing what would have been lost. */
  constructor(
    stepId: string,
    filesystem: string,
    entries: readonly UnrepresentableEntry[],
  ) {
    const shown = entries.slice(0, 5)
      .map((entry) => `  ${entry.path} (${entry.reason})`)
      .join("\n");
    const more = entries.length > 5
      ? `\n  …and ${entries.length - 5} more`
      : "";
    super(
      `${stepId}: ${filesystem} cannot represent ${entries.length} ` +
        `staging entr${entries.length === 1 ? "y" : "ies"}, and would drop ` +
        `them silently:\n${shown}${more}`,
    );
    this.name = "UnrepresentableContentError";
    this.stepId = stepId;
    this.entries = [...entries];
  }
}

/**
 * `base.virtualSizeBytes` does not match what `qemu-img info` reports.
 *
 * Raised by `build()` rather than `plan()` because `plan()` runs no binary: the
 * only size available to it is the FILE's, which for the Alpine aarch64 cloud
 * image is 225378304 bytes against a virtual size of 257949696 — a 12.6%
 * shortfall that looks entirely plausible.
 *
 * The two directions mean different things, so they get different messages.
 * Declaring MORE than the image holds is how a grow request is spelled, since
 * a recipe has no other way to ask for one; declaring less is a plain
 * misreading. Neither is silently accommodated.
 */
export class BaseImageSizeMismatchError extends Error {
  /** The base image's path, as declared. */
  readonly path: string;
  /** What the recipe declared. */
  readonly declaredBytes: number;
  /** What `qemu-img info` reported. */
  readonly actualBytes: number;

  /** Build the error, branching on which way the numbers disagree. */
  constructor(path: string, declaredBytes: number, actualBytes: number) {
    const head = `base image ${path} has a virtual size of ${actualBytes} ` +
      `bytes; the recipe declares ${declaredBytes}`;
    const detail = declaredBytes > actualBytes
      ? ". Declaring more than the image holds is how a recipe asks to GROW " +
        "it, and growing is not supported here yet. `resize()` alone does not " +
        "do it: on this image it left the primary GPT header untouched, so " +
        "`AlternateLBA` and `LastUsableLBA` still named the old final sector, " +
        "the backup header stayed stranded where the disk used to end, and " +
        "the new space fell outside the usable range every partitioner reads " +
        "— measured, adding 1 GiB yielded 1 GiB no partition could occupy. " +
        "Making it work needs the backup header rewritten at the new tail " +
        "(the `repairGpt()` work), so until that lands, grow the image out of " +
        "band, repair its GPT, and declare the size it actually ended up with."
      : ". Declare the size `qemu-img info` reports for the image you are " +
        "actually passing. A base image is copied in whole, so this number " +
        "does not resize anything — it is the assertion that the file on disk " +
        "is still the one this recipe was written against.";
    super(head + detail);
    this.name = "BaseImageSizeMismatchError";
    this.path = path;
    this.declaredBytes = declaredBytes;
    this.actualBytes = actualBytes;
  }
}

/**
 * A step needs the guest appliance, and this build was planned without one.
 *
 * Not a stub and not a silent no-op: the message names what the step wanted
 * and why the host cannot do it.
 */
export class GuestExecutorUnavailableError extends Error {
  /** The offending step's id. */
  readonly stepId: string;
  /** What the step needed that the host cannot provide. */
  readonly requirement: string;

  /** Build the error naming the unmet requirement. */
  constructor(stepId: string, requirement: string) {
    super(
      `${stepId}: needs the build appliance — ${requirement}. Build it with ` +
        "`deno task appliance`, or drop the step.",
    );
    this.name = "GuestExecutorUnavailableError";
    this.stepId = stepId;
    this.requirement = requirement;
  }
}
