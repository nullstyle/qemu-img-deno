/**
 * Typed refusals from the guest tier.
 *
 * Each names the fix, because each is raised at a point where the alternative
 * is not a crash but a *plausible* artifact: a stale appliance produces an
 * image built by a toolchain nobody asked for, and a guest step whose
 * filesystem checks failed produces one that mounts.
 *
 * @module
 */

import type { StepOutcome } from "./abi.ts";

/** Which part of the appliance identity disagreed with this source tree. */
export type StaleApplianceField =
  | "missing"
  | "abi"
  | "init"
  | "lock"
  | "kernel"
  | "initrd";

/** The `.appliance/` on disk is not the one this source tree describes. */
export class StaleApplianceError extends Error {
  /** The identity field that disagreed. */
  readonly field: StaleApplianceField;
  /** What this source tree says the field should be. */
  readonly expected: string;
  /** What the built appliance recorded (or `"absent"`). */
  readonly actual: string;

  /** Build the error; `arch` is named so the message can quote the rebuild. */
  constructor(
    field: StaleApplianceField,
    expected: string,
    actual: string,
    arch: string,
  ) {
    super(
      `the ${arch} build appliance does not match this source tree ` +
        `(${field})\n  expected ${expected}\n  actual   ${actual}\n` +
        "A guest layer's bytes are a function of the appliance that produced " +
        "them, and nothing in the recipe declares it — so an appliance built " +
        "from a different /init, lockfile or kernel would publish layers " +
        `under keys that promise this one's. Rebuild it: deno task appliance ` +
        `--arch=${arch}`,
    );
    this.name = "StaleApplianceError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The guest ran the step and it returned nonzero, or its checks failed.
 *
 * Thrown by `build()`, and re-exported from `@nullstyle/qemu-img/recipe`
 * alongside it. `instanceof` is the only honest way to tell this apart from a
 * generic failure — `.name` is a string anyone can set — so there is exactly
 * one class, reachable from both subpaths.
 */
export class GuestStepFailedError extends Error {
  /** The planned step's id. */
  readonly stepId: string;
  /** The full status record the guest wrote. */
  readonly outcome: StepOutcome;
  /** Everything the guest wrote to the serial console. */
  readonly console: string;

  /** Build the error from the guest's own report, naming every failed signal. */
  constructor(stepId: string, outcome: StepOutcome, consoleText: string) {
    // All four signals are independent, so all four are reported. A step that
    // exits nonzero AND leaves a filesystem e2fsck rejects has two separate
    // things wrong with it, and naming only the first reads as the smaller
    // problem — the exit code looks like the whole story, and the corruption
    // gets rediscovered later against an image nobody suspects.
    const checks = [
      outcome.umountRc !== 0
        ? "an unmount under /mnt failed, so its writeback did not complete"
        : "",
      (outcome.fsckRc ?? 0) !== 0
        ? `e2fsck -fn returned ${outcome.fsckRc}`
        : "",
      outcome.dmesgErrors !== 0
        ? `the guest logged ${outcome.dmesgErrors} ext4/I/O error lines`
        : "",
    ].filter((check) => check !== "");
    // Semicolons, not commas: these clauses contain commas of their own.
    //
    // `code: 0` with any of the other three is the dangerous shape, and stays
    // spelled out as such: the script succeeded and the filesystem it produced
    // is not sound, which without this check publishes as a cache hit every
    // descendant trusts.
    const why = outcome.code !== 0
      ? [
        `the step script exited ${outcome.code} at stage ${outcome.stage}`,
        ...checks,
      ].join("; ")
      : checks.length > 0
      ? `the step script succeeded but ${checks.join("; ")}`
      // Unreachable from `build()`, which constructs this only after one of the
      // four fired. Reachable by hand, though, and a dangling "succeeded but"
      // would be worse than saying plainly that nothing explains the failure.
      : "the outcome records no failing signal";
    super(
      `guest step ${stepId} failed: ${why}. ${outcome.detail}\n` +
        "The layer was not published; the console below is the whole record " +
        "of the boot.\n" +
        consoleText.trimEnd(),
    );
    this.name = "GuestStepFailedError";
    this.stepId = stepId;
    this.outcome = outcome;
    this.console = consoleText;
  }
}

/** A step declared `network: true` and the runner has no resolver. */
export class GuestNetworkUnavailableError extends Error {
  /** The planned step's id. */
  readonly stepId: string;

  /** Build the error naming the option that enables the network. */
  constructor(stepId: string) {
    super(
      `step ${stepId} declares network: true and this runner has no ` +
        "resolver configured. A resolver cannot be defaulted honestly: " +
        "slirp's own DNS at 10.0.2.3 never answers on qemu 11.0.2/macOS, and " +
        "DHCP is impossible in this guest (no af_packet module anywhere in " +
        "the initramfs — udhcpc dies in under a second). Running the step " +
        "unplugged would produce an artifact that looks built and is missing " +
        "everything it was supposed to fetch. Pass " +
        '`new ApplianceGuestRunner({ …, network: { dns: "8.8.8.8" } })`.',
    );
    this.name = "GuestNetworkUnavailableError";
    this.stepId = stepId;
  }
}
