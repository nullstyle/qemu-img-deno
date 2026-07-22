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
