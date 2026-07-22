/**
 * `plan()` — a deterministic function from a resolved recipe to a {@linkcode Plan}.
 *
 * No binary runs, no VM boots, no clock is read, no randomness is drawn. Every
 * cache key, every partition LBA and every refusal is decided here, so the
 * highest-value tests in this package need no fake at all.
 *
 * @module
 */

import { type RecipeKey, recipeKey } from "./keys.ts";
import {
  type CapabilityTrait,
  RecipePlanError,
  UnrepresentableContentError,
} from "./errors.ts";
import { resolvedDir } from "./resolve.ts";
import type {
  FilesystemSpec,
  GuestArch,
  PartitionSpec,
  ResolvedRecipe,
  Step,
} from "./types.ts";

/** Where a step's bytes come from. */
export type Executor = "image" | "bytes" | "guest";

/**
 * vvfat's usable byte count per FAT type. The geometry is fixed and
 * content-independent — a directory of one file and a directory of a thousand
 * both yield exactly this — so a partition smaller than it truncates a
 * filesystem whose BPB claims the full size.
 */
export const VVFAT_USABLE_BYTES: Readonly<Record<12 | 16, number>> = {
  12: 33_005_568,
  16: 528_450_048,
};

/** GPT reserves 34 sectors at the head and 33 at the tail. */
const GPT_HEAD_SECTORS = 34;
const GPT_TAIL_SECTORS = 33;

/** The EFI removable-media fallback path, per architecture. */
export const EFI_FALLBACK: Readonly<Record<GuestArch, string>> = {
  aarch64: "EFI/BOOT/BOOTAA64.EFI",
  x86_64: "EFI/BOOT/BOOTX64.EFI",
};

/** What each filesystem can represent. */
const FILESYSTEM_TRAITS: Readonly<Record<string, readonly CapabilityTrait[]>> =
  {
    // FAT carries no permissions, no ownership, no symlinks and no device nodes.
    fat: ["largeFiles"],
    ext4: [
      "symlinks",
      "posixModes",
      "posixOwnership",
      "deviceNodes",
      "largeFiles",
    ],
    empty: [],
  };

/** Resolved geometry for one partition. */
export interface PlannedPartition {
  /** Partition name. */
  readonly label: string;
  /** Partition type. */
  readonly type: string;
  /** First logical block. */
  readonly firstLba: number;
  /** Last logical block, inclusive. */
  readonly lastLba: number;
  /** Byte offset of the partition's first sector. */
  readonly offsetBytes: number;
  /** Partition length in bytes. */
  readonly lengthBytes: number;
  /** What lives in it. */
  readonly filesystem: FilesystemSpec["kind"];
}

/** One step, resolved and keyed. */
export interface PlannedStep {
  /** Position in `Recipe.steps`; `-1` for the base layer. */
  readonly index: number;
  /** The step's declared id, or `"base"`. */
  readonly id: string;
  /** This layer's recipe key. Always computable — planning is pure. */
  readonly recipeKey: RecipeKey;
  /** The previous layer's recipe key; absent for the base. */
  readonly parentRecipeKey?: RecipeKey;
  /** Where it runs. */
  readonly executor: Executor;
  /**
   * Whether this layer may be cached. A step that opts into the network is
   * not a function of its declared inputs, and neither is anything built on
   * top of it.
   */
  readonly cacheable: boolean;
  /** Capability traits derived from the actual staging data. */
  readonly requiredTraits: readonly CapabilityTrait[];
  /** A one-line human description. */
  readonly summary: string;
}

/** The full, pure result of planning. Assert this in tests. */
export interface Plan {
  /** The recipe's name. */
  readonly name: string;
  /** Every layer, base first. */
  readonly steps: readonly PlannedStep[];
  /** The final layer's recipe key. */
  readonly outputRecipeKey: RecipeKey;
  /** `true` when any step needs the guest appliance. */
  readonly requiresAppliance: boolean;
  /** Resolved partition geometry, when the recipe declares a table. */
  readonly layout?: readonly PlannedPartition[];
  /** Human-readable plan, one line per layer. */
  explain(): string;
}

function sectorSizeOf(resolved: ResolvedRecipe): number {
  return resolved.recipe.platform.sectorSize ?? 512;
}

function totalSizeBytes(resolved: ResolvedRecipe): number {
  const base = resolved.recipe.base;
  if (base.kind === "blank") return base.sizeBytes;
  const input = resolved.inputs[base.from.path];
  if (input === undefined) {
    throw new RecipePlanError(
      "recipe",
      `base image ${base.from.path} unresolved`,
    );
  }
  return input.sizeBytes;
}

/** Compute GPT geometry, refusing anything that cannot fit or align. */
function planLayout(
  step: Extract<Step, { kind: "partition" }>,
  resolved: ResolvedRecipe,
): PlannedPartition[] {
  const sector = sectorSizeOf(resolved);
  const total = totalSizeBytes(resolved);
  const totalSectors = Math.floor(total / sector);
  const firstOffset = step.firstPartitionOffset ?? 1024 * 1024;
  if (firstOffset % sector !== 0) {
    throw new RecipePlanError(
      step.id,
      `firstPartitionOffset ${firstOffset} is not a multiple of the ` +
        `${sector}-byte sector size`,
    );
  }
  const firstUsable = Math.max(GPT_HEAD_SECTORS, firstOffset / sector);
  const lastUsable = totalSectors - GPT_TAIL_SECTORS - 1;

  const planned: PlannedPartition[] = [];
  let cursor = firstUsable;
  step.partitions.forEach((partition, index) => {
    const isLast = index === step.partitions.length - 1;
    if (partition.size === "rest" && !isLast) {
      throw new RecipePlanError(
        step.id,
        `partition "${partition.label}" uses "rest" but is not last`,
      );
    }
    let lengthSectors: number;
    if (partition.size === "rest") {
      lengthSectors = lastUsable - cursor + 1;
    } else {
      // Round UP: rounding down would silently hand back a partition smaller
      // than the caller asked for, which is the failure class this refuses.
      lengthSectors = Math.ceil(partition.size / sector);
    }
    if (lengthSectors <= 0) {
      throw new RecipePlanError(
        step.id,
        `partition "${partition.label}" has no room left on a ` +
          `${total}-byte disk`,
      );
    }
    const lastLba = cursor + lengthSectors - 1;
    if (lastLba > lastUsable) {
      const overBytes = (lastLba - lastUsable) * sector;
      throw new RecipePlanError(
        step.id,
        `partition "${partition.label}" runs ${overBytes} bytes past the last ` +
          `usable LBA (${lastUsable}). A GPT reserves the final ` +
          `${GPT_TAIL_SECTORS} sectors for its backup header.`,
      );
    }
    validateContents(step.id, partition, lengthSectors * sector, resolved);
    planned.push({
      label: partition.label,
      type: partition.type,
      firstLba: cursor,
      lastLba,
      offsetBytes: cursor * sector,
      lengthBytes: lengthSectors * sector,
      filesystem: partition.contents.kind,
    });
    cursor = lastLba + 1;
  });
  return planned;
}

/** Refuse partition contents that cannot be produced as declared. */
function validateContents(
  stepId: string,
  partition: PartitionSpec,
  lengthBytes: number,
  resolved: ResolvedRecipe,
): void {
  const contents = partition.contents;
  if (contents.kind === "fat") {
    if (new TextEncoder().encode(contents.label).byteLength > 11) {
      throw new RecipePlanError(
        stepId,
        `FAT label "${contents.label}" exceeds 11 bytes`,
      );
    }
    const required = VVFAT_USABLE_BYTES[contents.fatType];
    if (lengthBytes < required) {
      throw new RecipePlanError(
        stepId,
        `partition "${partition.label}" is ${lengthBytes} bytes, but vvfat's ` +
          `FAT${contents.fatType} geometry is fixed at ${required} bytes ` +
          "regardless of content. A smaller window truncates a filesystem " +
          `whose BPB claims the full size. Grow the partition to ${required} ` +
          "bytes or more.",
      );
    }
  }
  // Traits are derived from the data, so this catches a tree whose author
  // never noticed it had a symlink in it.
  const from = contents.kind === "fat"
    ? contents.from
    : contents.kind === "ext4"
    ? contents.from
    : undefined;
  if (from === undefined) return;
  const input = resolvedDir(resolved, from);
  const supported = FILESYSTEM_TRAITS[contents.kind] ?? [];
  const unsupported = (input.traits ?? []).filter((t) =>
    !supported.includes(t)
  );
  if (unsupported.length === 0) return;
  const offenders = (input.entries ?? [])
    .flatMap((entry) => {
      const reasons: CapabilityTrait[] = [];
      if (entry.type === "symlink" && unsupported.includes("symlinks")) {
        reasons.push("symlinks");
      }
      if (
        unsupported.includes("posixModes") &&
        (((entry.mode & 0o111) !== 0 && entry.type === "file") ||
          (entry.mode & 0o7000) !== 0)
      ) {
        reasons.push("posixModes");
      }
      if (
        unsupported.includes("posixOwnership") &&
        ((entry.uid ?? 0) !== 0 || (entry.gid ?? 0) !== 0)
      ) {
        reasons.push("posixOwnership");
      }
      return reasons.map((reason) => ({ path: entry.path, reason }));
    });
  throw new UnrepresentableContentError(stepId, contents.kind, offenders);
}

/** The executor a step runs on. */
function executorOf(step: Step): Executor {
  switch (step.kind) {
    case "partition":
      // A table plus FAT is pure host-side byte work; ext4 needs a kernel.
      return step.partitions.some((p) => p.contents.kind === "ext4")
        ? "guest"
        : "bytes";
    case "run":
    case "copyIn":
      return "guest";
  }
}

function summarize(step: Step): string {
  switch (step.kind) {
    case "partition":
      return `gpt: ${
        step.partitions.map((p) => `${p.label}/${p.contents.kind}`).join(", ")
      }`;
    case "run":
      return `run: ${step.script.split("\n")[0].slice(0, 48)}`;
    case "copyIn":
      return `copyIn: ${step.from.path} -> ${step.to}`;
  }
}

/** Refuse whole-recipe problems that no individual step owns. */
function validateRecipe(resolved: ResolvedRecipe): void {
  const { recipe } = resolved;
  const machine = recipe.platform.machine;
  if (machine !== undefined && !/-\d+\.\d+$/.test(machine)) {
    throw new RecipePlanError(
      "recipe",
      `machine "${machine}" is an unversioned alias. It resolves to whatever ` +
        "the installed qemu calls current and moves on the next upgrade — " +
        "changing ACPI tables and device enumeration while the cache key, " +
        `which records only this string, stays put. Pin it: "${machine}-11.0".`,
    );
  }
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (ids.has(step.id)) {
      throw new RecipePlanError(step.id, "duplicate step id");
    }
    ids.add(step.id);
  }
  if (recipe.boot.kind === "uefi-removable") {
    const partitionSteps = recipe.steps.filter((s) => s.kind === "partition");
    const esp = partitionSteps
      .flatMap((s) => (s as Extract<Step, { kind: "partition" }>).partitions)
      .find((p) => p.type === "esp");
    if (esp === undefined) {
      throw new RecipePlanError(
        "recipe",
        'boot is "uefi-removable" but no partition has type "esp"',
      );
    }
    if (esp.contents.kind !== "fat") {
      throw new RecipePlanError(
        "recipe",
        `the ESP holds ${esp.contents.kind}; UEFI requires FAT there`,
      );
    }
    const fallback = EFI_FALLBACK[recipe.platform.arch];
    const tree = resolvedDir(resolved, esp.contents.from);
    const has = (tree.entries ?? []).some((entry) => entry.path === fallback);
    if (!has) {
      throw new RecipePlanError(
        "recipe",
        `the ESP staging tree has no ${fallback}. That is the only boot path ` +
          "independent of an NVRAM Boot#### entry — and NVRAM lives in a " +
          "per-run vars file outside the image, so an image that boots only " +
          "because efibootmgr ran is not a reproducible artifact.",
      );
    }
  }
}

/**
 * Plan a resolved recipe. Deterministic: the same inputs always give the same
 * keys, geometry and refusals.
 */
export async function plan(resolved: ResolvedRecipe): Promise<Plan> {
  validateRecipe(resolved);
  const { recipe } = resolved;
  const sector = sectorSizeOf(resolved);

  const steps: PlannedStep[] = [];
  const baseKey = await recipeKey({
    stepKind: "base",
    name: recipe.name,
    base: recipe.base.kind === "blank"
      ? {
        kind: "blank",
        sizeBytes: recipe.base.sizeBytes,
        options: recipe.base.options ?? {},
      }
      : {
        kind: "image",
        format: recipe.base.format,
        sha256: resolved.inputs[recipe.base.from.path]?.sha256 ?? "",
      },
    platform: {
      arch: recipe.platform.arch,
      sectorSize: sector,
      machine: recipe.platform.machine ?? "",
    },
    determinism: recipe.determinism,
  });
  steps.push({
    index: -1,
    id: "base",
    recipeKey: baseKey,
    executor: "image",
    cacheable: true,
    requiredTraits: [],
    summary: recipe.base.kind === "blank"
      ? `create qcow2 ${recipe.base.sizeBytes} bytes`
      : `from ${recipe.base.from.path}`,
  });

  let layout: PlannedPartition[] | undefined;
  let parentKey = baseKey;
  // Uncacheability propagates: once a step is not a function of its declared
  // inputs, nothing built on top of it is either.
  let ancestorUncacheable = false;

  for (const [index, step] of recipe.steps.entries()) {
    if (step.kind === "partition") {
      if (layout !== undefined) {
        throw new RecipePlanError(
          step.id,
          "a recipe declares one partition table",
        );
      }
      layout = planLayout(step, resolved);
    }
    const stepInputs = step.kind === "copyIn"
      ? [resolvedDir(resolved, step.from)]
      : step.kind === "partition"
      ? step.partitions.flatMap((p) => {
        const from = p.contents.kind === "fat"
          ? p.contents.from
          : p.contents.kind === "ext4"
          ? p.contents.from
          : undefined;
        return from === undefined ? [] : [resolvedDir(resolved, from)];
      })
      : [];
    const traits = [
      ...new Set(stepInputs.flatMap((input) => input.traits ?? [])),
    ].sort();
    const usesNetwork = step.kind === "run" && step.network === true;
    if (usesNetwork) ancestorUncacheable = true;

    const key = await recipeKey({
      stepKind: step.kind,
      stepId: step.id,
      parentRecipeKey: parentKey,
      payload: payloadOf(step),
      inputs: stepInputs.map((input) => input.sha256),
      geometry: step.kind === "partition" ? (layout ?? []) : [],
      platform: {
        arch: recipe.platform.arch,
        sectorSize: sector,
        machine: recipe.platform.machine ?? "",
      },
      determinism: recipe.determinism,
      // In the preimage so that uncacheability actually propagates, rather
      // than being asserted in prose and forgotten.
      ancestorUncacheable,
    });
    steps.push({
      index,
      id: step.id,
      recipeKey: key,
      parentRecipeKey: parentKey,
      executor: executorOf(step),
      cacheable: !ancestorUncacheable,
      requiredTraits: traits,
      summary: summarize(step),
    });
    parentKey = key;
  }

  const requiresAppliance = steps.some((s) => s.executor === "guest");
  return {
    name: recipe.name,
    steps,
    outputRecipeKey: parentKey,
    requiresAppliance,
    ...(layout === undefined ? {} : { layout }),
    explain(): string {
      const lines = steps.map((s) =>
        `${s.id.padEnd(10)} ${s.executor.padEnd(6)} ${s.summary.padEnd(44)} ` +
        `${s.recipeKey.slice(0, 12)}${s.cacheable ? "" : "  (uncacheable)"}`
      );
      if (layout !== undefined) {
        lines.push(
          ...layout.map((p) =>
            `  part ${p.label.padEnd(8)} ${p.filesystem.padEnd(6)} ` +
            `LBA ${p.firstLba}..${p.lastLba} (${p.lengthBytes} bytes)`
          ),
        );
      }
      return lines.join("\n");
    },
  };
}

/** The exact declared bytes of a step, unnormalized. */
function payloadOf(step: Step): Record<string, unknown> {
  switch (step.kind) {
    case "partition":
      return {
        firstPartitionOffset: step.firstPartitionOffset ?? 1048576,
        partitions: step.partitions.map((p) => ({
          label: p.label,
          type: p.type,
          size: p.size,
          contents: p.contents.kind === "fat"
            ? {
              kind: "fat",
              fatType: p.contents.fatType,
              label: p.contents.label,
            }
            : p.contents.kind === "ext4"
            ? { kind: "ext4", label: p.contents.label }
            : { kind: "empty" },
        })),
      };
    case "run":
      return { script: step.script, network: step.network === true };
    case "copyIn":
      return { to: step.to };
  }
}
