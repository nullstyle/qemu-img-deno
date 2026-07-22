/**
 * Typed refusals for GPT repair.
 *
 * Every one of these names the fix in its message. A repair that cannot be
 * done losslessly is refused rather than approximated, because a partition
 * table that parses but describes less than it used to is precisely the
 * failure mode this package exists to make loud.
 *
 * @module
 */

import type { GptProblem } from "./gpt.ts";

/** The bytes handed in are not a GPT this reader can work with. */
export class GptParseError extends Error {
  /** Build the error. */
  constructor(message: string) {
    super(message);
    this.name = "GptParseError";
  }
}

/**
 * A repair was refused because carrying it out would lose data, or because
 * the two headers disagree about what the disk holds.
 *
 * Never thrown for damage that can be repaired losslessly — a stranded backup
 * header, a stale `LastUsableLBA`, a corrupt side that the other side can
 * rebuild are all repaired without asking.
 */
export class GptRepairRefusedError extends Error {
  /** The problems that made the repair unsafe. */
  readonly problems: readonly GptProblem[];

  /** Build the error from the problems that blocked the repair. */
  constructor(message: string, problems: readonly GptProblem[]) {
    super(message);
    this.name = "GptRepairRefusedError";
    this.problems = problems;
  }
}
