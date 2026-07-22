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

/** A recipe is statically wrong. Thrown by `plan()`, before any I/O. */
export class RecipePlanError extends Error {
  /** The offending step's id, or `"recipe"` for a whole-recipe problem. */
  readonly stepId: string;

  /** Build the error; `detail` must name the fix, not just the problem. */
  constructor(stepId: string, detail: string) {
    super(`${stepId}: ${detail}`);
    this.name = "RecipePlanError";
    this.stepId = stepId;
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
