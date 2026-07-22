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
import { USTAR_MAX_SIZE_BYTES } from "../fs/tar.ts";
import type {
  FilesystemSpec,
  GuestArch,
  PartitionSpec,
  Recipe,
  ResolvedInput,
  ResolvedRecipe,
  Step,
} from "./types.ts";

/** Where a step's bytes come from. */
export type Executor = "image" | "bytes" | "guest";

/**
 * vvfat's usable byte count per FAT type — the size a FAT partition must be,
 * exactly.
 *
 * The geometry is fixed and content-independent: a tree of one 4-byte file and
 * a tree of 200 64 KiB files both yield the same numbers, measured on qemu-img
 * 11.0.2. vvfat presents a whole disk with its own MBR, and `build()` splices
 * the window past it (LBA 63, 32256 bytes), so these are the device size less
 * that offset — and they are also exactly what the synthesized BPB's
 * `totalSectors` claims:
 *
 * | fatType | vvfat device | MBR partition entry     | BPB totalSectors |
 * | ------- | ------------ | ----------------------- | ---------------- |
 * | 12      | 33030144     | LBA 63, 64449 sectors   | 64449            |
 * | 16      | 528482304    | LBA 63, 1032129 sectors | 1032129          |
 *
 * BOTH directions are refused, and the reasons differ. A SMALLER partition
 * truncates a filesystem whose BPB claims the full size. A LARGER one does not
 * merely waste the tail: `build()` opens the source as
 * `raw,offset=32256,size=<partition length>` over the vvfat node, and qemu-img
 * refuses to open that at all — "The sum of offset (32256) and size (…) has to
 * be smaller or equal to the actual size of the containing file (…)".
 *
 * BREAKING: `12` was `33005568` through 0.2.1, which is the device size less
 * 24576 rather than less 32256 — 7680 bytes too many. A recipe that sized a
 * FAT12 partition with this very constant therefore passed `plan()` and then
 * failed in `build()` with that raw qemu error, which is the failure this
 * refusal exists to prevent. No working cache entry moves: every recipe the old
 * value admitted and the new one rejects was unbuildable.
 */
export const VVFAT_USABLE_BYTES: Readonly<Record<12 | 16, number>> = {
  12: 32_997_888,
  16: 528_450_048,
};

/**
 * Why a guest step cannot be planned without an appliance identity.
 *
 * Shared by both places that can raise it, so the two never drift apart.
 */
const APPLIANCE_REQUIRED =
  "a guest step's result depends on the appliance that produced it — the " +
  "kernel, the e2fsprogs build and the /init — none of which this recipe " +
  "declares. Plan with `plan(resolved, { appliance: await " +
  "readApplianceIdentity({ arch }) })`, or the store will serve layers built " +
  "by a different toolchain under a key that claims they match.";

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

/**
 * What the ustar transport used by `copyIn` can carry.
 *
 * Deliberately narrower than ext4's own capabilities. The archive records uid
 * and gid as 0 by construction, so a tree whose ownership varies would arrive
 * flattened — valid, mountable, and not what was staged. A `copyIn`
 * destination is checked against the intersection of this and the target
 * filesystem's traits, so the narrower of the two always wins.
 */
export const TAR_TRANSPORT_TRAITS: readonly CapabilityTrait[] = [
  "symlinks",
  "posixModes",
  "largeFiles",
];

/** One step, resolved and keyed. */
export interface PlannedStep {
  /**
   * Position in `Recipe.steps`; `-1` for the base layer.
   *
   * NOT unique. A declared `partition` step carrying a kernel filesystem plans
   * as two layers that share this index — they are two mechanisms realizing
   * one declaration. Tell them apart by `id`; `index` stays a lookup into
   * `recipe.steps`, which both of them need.
   */
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
  /**
   * Indices into {@linkcode Plan.layout} whose CONTENTS this layer produces.
   * Present only on partition layers.
   *
   * The two split layers divide the index set between them, so no executor
   * ever re-decides which side of the host/guest boundary a filesystem falls
   * on — the planner decided once, and both halves read the same answer.
   */
  readonly partitionIndices?: readonly number[];
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
  /**
   * `true` when any step needs the guest appliance.
   *
   * Every layer BEFORE the first guest one still builds and caches without
   * it — which only became true once partition steps stopped being classified
   * wholesale. A machine with no appliance now gets a correct, cached partial
   * chain and a typed refusal at the first layer that genuinely needs Linux.
   */
  readonly requiresAppliance: boolean;
  /** Resolved partition geometry, when the recipe declares a table. */
  readonly layout?: readonly PlannedPartition[];
  /** Human-readable plan, one line per layer. */
  explain(): string;
}

/**
 * The appliance identity {@linkcode plan} needs for a guest step.
 *
 * `ApplianceIdentity` from `./system` satisfies this structurally, which is the
 * point: the planner reads only these two fields, so it does not import the
 * guest tier and the tier stays substitutable.
 */
export interface PlanAppliance {
  /** Digest over every field of the appliance's identity. */
  readonly digest: string;
  /**
   * The architecture the appliance executes.
   *
   * Required, and checked against `platform.arch`. Without it a plan accepts
   * an x86_64 appliance for an aarch64 recipe and runs every guest step on the
   * wrong architecture — `mke2fs` still writes a filesystem, `run` scripts
   * still exit 0, and the artifact is a plausible image whose ELF the target
   * machine cannot execute.
   */
  readonly arch: GuestArch;
}

/** Options for {@linkcode plan}. */
export interface PlanOptions {
  /**
   * The appliance any `guest` step will run on.
   *
   * Required as soon as the plan contains one. A guest layer's bytes are a
   * function of the kernel, the `e2fsprogs` build and the `/init` that
   * produced them, and the recipe declares none of those — so leaving the
   * appliance out of the key would let a store hand back layers built by a
   * different toolchain under a key that claims they match. Obtain it with
   * `readApplianceIdentity()` from `./system`.
   */
  readonly appliance?: PlanAppliance;
}

/**
 * The appliance a guest step will run on, refusing the two ways it can be wrong.
 *
 * Both refusals live here rather than at the call sites so the `<id>` and
 * `<id>:mkfs` layers of one declared step cannot end up judging the appliance
 * differently.
 */
function requireAppliance(
  stepId: string,
  arch: GuestArch,
  options: PlanOptions,
): PlanAppliance {
  const appliance = options.appliance;
  if (appliance === undefined) {
    throw new RecipePlanError(stepId, "appliance-required", APPLIANCE_REQUIRED);
  }
  if (appliance.arch !== arch) {
    throw new RecipePlanError(
      stepId,
      "appliance-arch-mismatch",
      `this step runs in the build appliance, which is ${appliance.arch}, ` +
        `but the recipe targets ${arch}. The appliance executes the step's ` +
        `binaries, so the layer would be built by ${appliance.arch} tools for ` +
        `an ${arch} image — and nothing downstream notices: mke2fs writes a ` +
        "valid filesystem either way, and a `run` script exits 0. Plan with " +
        `\`readApplianceIdentity({ arch: "${arch}" })\`, or change ` +
        "`platform.arch` to match the appliance you have.",
    );
  }
  return appliance;
}

function sectorSizeOf(resolved: ResolvedRecipe): number {
  return resolved.recipe.platform.sectorSize ?? 512;
}

/**
 * The target disk's virtual size.
 *
 * Exported because `build()` needs the identical number when it writes the
 * GPT: the backup header's position is derived from it, and two definitions
 * that disagree put the backup somewhere the plan did not intend.
 */
export function totalSizeBytes(resolved: ResolvedRecipe): number {
  const base = resolved.recipe.base;
  if (base.kind === "blank") return base.sizeBytes;
  // NOT the resolver's sizeBytes, which is the FILE's size. A 600 MiB sparse
  // qcow2 describing a 20 GiB disk would put every partition, and the backup
  // GPT, in the wrong place — while looking entirely reasonable.
  return base.virtualSizeBytes;
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
  // `% sector` alone let `-1048576` through: it leaves `-0`, which is not
  // `!== 0`, and `Math.max` below then quietly used LBA 34 instead.
  if (
    !Number.isSafeInteger(firstOffset) || firstOffset < 0 ||
    firstOffset % sector !== 0
  ) {
    throw new RecipePlanError(
      step.id,
      "invalid-first-partition-offset",
      `firstPartitionOffset is ${firstOffset}; it must be a non-negative ` +
        `whole number of bytes and a multiple of the ${sector}-byte sector ` +
        "size. Round it to a sector boundary — 1048576 is the 1 MiB alignment " +
        "every modern producer emits.",
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
        "rest-not-last",
        `partition "${partition.label}" uses "rest" but is not last. Only the ` +
          "final partition can take the remaining space; move it last, or " +
          "give it a byte count.",
      );
    }
    let lengthSectors: number;
    if (partition.size === "rest") {
      lengthSectors = lastUsable - cursor + 1;
    } else {
      // Every guard below is arithmetic on this number, and NaN or Infinity
      // passes all of them: `Math.ceil(NaN)` is NaN, `NaN <= 0` is false, and
      // `NaN > lastUsable` is false. The value reached `canonicalJson`, which
      // threw `TypeError: canonicalJson: non-finite number at $.payload…` —
      // an internal detail of the key scheme naming nothing the caller wrote.
      if (!Number.isSafeInteger(partition.size) || partition.size <= 0) {
        throw new RecipePlanError(
          step.id,
          "invalid-partition-size",
          `partition "${partition.label}" declares size ${partition.size}; a ` +
            "partition size must be a positive whole number of bytes below " +
            `2^53, or the string "rest" to fill what is left. Give it a byte ` +
            "count — a computed size that came out NaN usually means a unit " +
            "multiplication with an undefined operand.",
        );
      }
      // Round UP: rounding down would silently hand back a partition smaller
      // than the caller asked for, which is the failure class this refuses.
      lengthSectors = Math.ceil(partition.size / sector);
    }
    if (lengthSectors <= 0) {
      throw new RecipePlanError(
        step.id,
        "partition-no-room",
        `partition "${partition.label}" has no room left on a ` +
          `${total}-byte disk. Grow \`base.sizeBytes\`, or shrink the ` +
          "partitions declared ahead of it.",
      );
    }
    const lastLba = cursor + lengthSectors - 1;
    if (lastLba > lastUsable) {
      const overBytes = (lastLba - lastUsable) * sector;
      throw new RecipePlanError(
        step.id,
        "partition-past-last-usable-lba",
        `partition "${partition.label}" runs ${overBytes} bytes past the last ` +
          `usable LBA (${lastUsable}). A GPT reserves the final ` +
          `${GPT_TAIL_SECTORS} sectors for its backup header. Shrink it by ` +
          `${overBytes} bytes, or grow the disk by at least that much.`,
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
  const sectorSize = sectorSizeOf(resolved);
  const contents = partition.contents;
  if (contents.kind === "fat") {
    if (new TextEncoder().encode(contents.label).byteLength > 11) {
      throw new RecipePlanError(
        stepId,
        "fat-label-too-long",
        `FAT label "${contents.label}" exceeds 11 bytes, which is the whole ` +
          "volume-label field in a FAT boot sector. Shorten it to 11 bytes.",
      );
    }
    const required = VVFAT_USABLE_BYTES[contents.fatType];
    const fixed = `vvfat's FAT${contents.fatType} geometry is fixed at ` +
      `${required} bytes regardless of content`;
    if (lengthBytes < required) {
      throw new RecipePlanError(
        stepId,
        "fat-window-too-small",
        `partition "${partition.label}" is ${lengthBytes} bytes, but ${fixed}. ` +
          "A smaller window truncates a filesystem whose BPB claims the full " +
          `size. Grow the partition to exactly ${required} bytes.`,
      );
    }
    if (lengthBytes > required) {
      // The other side was never a refusal, so it landed in build() as
      // qemu-img's own words about a `raw` node it could not open: "The sum of
      // offset (32256) and size (…) has to be smaller or equal to the actual
      // size of the containing file (…)" — three numbers, none of them the
      // partition the recipe declared.
      const sectorNote = required % sectorSize === 0
        ? `Shrink the partition to exactly ${required} bytes.`
        : `And ${required} is not a multiple of this recipe's ` +
          `${sectorSize}-byte sector size, so no \`size\` can land on it: a ` +
          `vvfat FAT${contents.fatType} filesystem cannot be laid out on a ` +
          `${sectorSize}-byte-sector disk at all. Use \`sectorSize: 512\`, or ` +
          "build this partition's filesystem some other way.";
      throw new RecipePlanError(
        stepId,
        "fat-window-too-large",
        `partition "${partition.label}" is ${lengthBytes} bytes, ` +
          `${lengthBytes - required} more than ${fixed}. build() splices the ` +
          "filesystem through a `raw` window of exactly the partition's " +
          "length over the vvfat node, and qemu-img refuses to open a window " +
          `past the end of what vvfat synthesized. ${sectorNote}`,
      );
    }
  }
  if (contents.kind === "ext4") {
    // The type has no `from`, but untyped JavaScript can still pass one, and
    // ignoring it would build exactly the empty-but-valid filesystem the type
    // comment warns about.
    if ("from" in contents) {
      throw new RecipePlanError(
        stepId,
        "ext4-staging-tree",
        `partition "${partition.label}" declares ext4 contents with a ` +
          "`from` tree, but the layer that creates an ext4 filesystem formats " +
          "it and nothing else. The tree would be dropped, leaving a " +
          "filesystem that mounts and passes e2fsck holding none of it. " +
          "Stage it with a separate `copyIn` step.",
      );
    }
    return;
  }
  // Traits are derived from the data, so this catches a tree whose author
  // never noticed it had a symlink in it.
  if (contents.kind !== "fat") return;
  const input = resolvedDir(resolved, contents.from);
  refuseUnrepresentable(
    stepId,
    contents.kind,
    input,
    FILESYSTEM_TRAITS[contents.kind] ?? [],
  );
}

/**
 * Refuse a staging tree carrying metadata the destination cannot hold, naming
 * the entries that would have been dropped.
 */
function refuseUnrepresentable(
  stepId: string,
  destination: string,
  input: ResolvedInput,
  supported: readonly CapabilityTrait[],
): void {
  const unsupported = (input.traits ?? []).filter((trait) =>
    !supported.includes(trait)
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
  throw new UnrepresentableContentError(stepId, destination, offenders);
}

/** The executor a step runs on. */
function executorOf(step: Step): Executor {
  switch (step.kind) {
    case "partition":
      // Always the host. The table and every FAT filesystem are host-side by
      // construction — the appliance ships e2fsprogs and nothing else, no
      // sgdisk, no parted, no mkfs.fat — so a partition step can never run
      // wholesale in the guest. Only its kernel filesystems leave the host,
      // as a second layer.
      return "bytes";
    case "run":
    case "copyIn":
      return "guest";
  }
}

/** Indices of partitions whose filesystem only a Linux kernel can create. */
function guestFilesystems(
  step: Extract<Step, { kind: "partition" }>,
): number[] {
  return step.partitions.flatMap((partition, index) =>
    partition.contents.kind === "ext4" ? [index] : []
  );
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

/**
 * Refuse a `copyIn` whose destination or payload cannot survive the transport.
 *
 * The tree is checked against the INTERSECTION of what the destination
 * filesystem can hold and what the ustar transport can carry — a check that
 * did not exist before, so the one step kind whose whole job is moving a host
 * tree into an image was the one kind with nothing verifying it arrived whole.
 */
function validateCopyIn(
  step: Extract<Step, { kind: "copyIn" }>,
  resolved: ResolvedRecipe,
): void {
  const to = step.to;
  const bad = !to.startsWith("/") ||
    to.includes("//") ||
    to.includes("\0") ||
    to.split("/").some((segment) => segment === "." || segment === "..");
  if (bad) {
    throw new RecipePlanError(
      step.id,
      "copyin-destination",
      `copyIn "to" must be an absolute, normalized path inside the image's ` +
        `root filesystem (got ${JSON.stringify(to)}). A relative or ` +
        "`..`-bearing path would resolve against whatever the guest's working " +
        "directory happened to be, which is not something this recipe states.",
    );
  }
  const input = resolvedDir(resolved, step.from);
  const destination = FILESYSTEM_TRAITS.ext4 ?? [];
  refuseUnrepresentable(
    step.id,
    "the ustar transport into ext4",
    input,
    destination.filter((trait) => TAR_TRANSPORT_TRAITS.includes(trait)),
  );
  const huge = (input.entries ?? []).find((entry) =>
    entry.sizeBytes > USTAR_MAX_SIZE_BYTES
  );
  if (huge !== undefined) {
    throw new RecipePlanError(
      step.id,
      "copyin-file-too-large",
      `${huge.path} is ${huge.sizeBytes} bytes; a ustar size field holds at ` +
        `most ${USTAR_MAX_SIZE_BYTES}. Split the file, or deliver it out of ` +
        "band and reference it from a `run` step.",
    );
  }
}

/**
 * Refuse two partitions sharing a `label`.
 *
 * The label is not decoration: every identity a partition gets is derived from
 * it by hashing, so two that share one are not merely confusing, they are
 * indistinguishable. `build()` computes the GPT `uniqueGuid` as
 * `deriveGuid(guidSeed, "partition:" + label)`, and an ext4 window's volume
 * UUID and hash seed as `deriveGuid(fsSeed, "fs:" + label)` and
 * `"hash:" + label`. A duplicate therefore mints one PARTUUID for two
 * partitions — so `/dev/disk/by-partuuid` and a `root=PARTUUID=` kernel
 * argument resolve to whichever the kernel enumerated last — and, for two ext4
 * windows, one filesystem UUID as well, which `blkid` and `/etc/fstab` cannot
 * tell apart either. Nothing downstream fails: the image builds, mounts and
 * boots, from an arbitrary one of the two.
 */
function refuseDuplicatePartitionLabels(recipe: Recipe): void {
  for (const step of recipe.steps) {
    if (step.kind !== "partition") continue;
    const seen = new Set<string>();
    for (const partition of step.partitions) {
      if (!seen.has(partition.label)) {
        seen.add(partition.label);
        continue;
      }
      throw new RecipePlanError(
        step.id,
        "duplicate-partition-label",
        `two partitions are labelled "${partition.label}". Every identity a ` +
          "partition gets is derived from that label by hashing — its GPT " +
          "PARTUUID, and for ext4 its volume UUID and hash seed — so both " +
          "would be minted identical, and `/dev/disk/by-partuuid`, `blkid` " +
          "and a `root=PARTUUID=` argument would each resolve to whichever " +
          "the kernel enumerated last. The image would still build, mount " +
          "and boot, from an arbitrary one of the two. Give them distinct " +
          "labels; a partition label may be up to 36 UTF-16 code units.",
      );
    }
  }
}

/** Refuse whole-recipe problems that no individual step owns. */
function validateRecipe(resolved: ResolvedRecipe): void {
  const { recipe } = resolved;
  const machine = recipe.platform.machine;
  if (machine !== undefined && !/-\d+\.\d+$/.test(machine)) {
    throw new RecipePlanError(
      "recipe",
      "unversioned-machine",
      `machine "${machine}" is an unversioned alias. It resolves to whatever ` +
        "the installed qemu calls current and moves on the next upgrade — " +
        "changing ACPI tables and device enumeration while the cache key, " +
        `which records only this string, stays put. Pin it: "${machine}-11.0".`,
    );
  }
  const ids = new Set<string>();
  for (const step of recipe.steps) {
    if (ids.has(step.id)) {
      throw new RecipePlanError(
        step.id,
        "duplicate-step-id",
        "duplicate step id. Step ids name layers, so two steps sharing one " +
          "cannot be told apart in a plan, a store or a build log. Rename one.",
      );
    }
    ids.add(step.id);
    if (step.id.includes(":")) {
      throw new RecipePlanError(
        step.id,
        "reserved-step-id-separator",
        "`:` is reserved in step ids — the planner uses it to name layers it " +
          "generates, so a partition step carrying ext4 plans as `<id>` plus " +
          "`<id>:mkfs`. Rename the step.",
      );
    }
  }
  refuseDuplicatePartitionLabels(recipe);

  const ext4Count = recipe.steps
    .filter((step) => step.kind === "partition")
    .flatMap((step) =>
      (step as Extract<Step, { kind: "partition" }>).partitions
    )
    .filter((partition) => partition.contents.kind === "ext4").length;

  if (recipe.base.kind === "image") {
    if (recipe.base.rootPartition < 1) {
      throw new RecipePlanError(
        "recipe",
        "root-partition-out-of-range",
        `base.rootPartition is ${recipe.base.rootPartition}; GPT partition ` +
          "numbers are 1-based, and /dev/vda0 does not exist. Read the number " +
          "off the image and declare that.",
      );
    }
    const laying = recipe.steps.find((step) => step.kind === "partition");
    if (laying !== undefined) {
      throw new RecipePlanError(
        laying.id,
        "partition-over-image-base",
        "a partition step on an existing base image lays a new GPT over the " +
          "one the image already has, discarding every partition in it. Start " +
          'from `base: { kind: "blank" }` to own the layout, or drop this ' +
          "step and address the existing table through `base.rootPartition`.",
      );
    }
  }

  for (const step of recipe.steps) {
    if (step.kind !== "copyIn" && step.kind !== "run") continue;
    // Both mount the image's root filesystem, so there has to be exactly one
    // thing that unambiguously IS the root filesystem.
    if (recipe.base.kind === "blank" && ext4Count !== 1) {
      throw new RecipePlanError(
        step.id,
        "ambiguous-root-filesystem",
        `a ${step.kind} step mounts the recipe's root filesystem, and this ` +
          `recipe declares ${ext4Count} ext4 partitions. Declare exactly one, ` +
          'or start from `base: { kind: "image", rootPartition }` to name the ' +
          "one already in the image.",
      );
    }
    if (step.kind !== "copyIn") continue;
    validateCopyIn(step, resolved);
  }
  if (recipe.boot.kind === "uefi-removable") {
    const partitionSteps = recipe.steps.filter((s) => s.kind === "partition");
    const esp = partitionSteps
      .flatMap((s) => (s as Extract<Step, { kind: "partition" }>).partitions)
      .find((p) => p.type === "esp");
    if (esp === undefined) {
      throw new RecipePlanError(
        "recipe",
        "missing-esp",
        'boot is "uefi-removable" but no partition has type "esp". Declare ' +
          'one, or set `boot: { kind: "none" }` if this is a data disk.',
      );
    }
    if (esp.contents.kind !== "fat") {
      throw new RecipePlanError(
        "recipe",
        "esp-not-fat",
        `the ESP holds ${esp.contents.kind}; UEFI firmware reads FAT and ` +
          'nothing else there. Give it `contents: { kind: "fat", … }`.',
      );
    }
    const fallback = EFI_FALLBACK[recipe.platform.arch];
    const tree = resolvedDir(resolved, esp.contents.from);
    const has = (tree.entries ?? []).some((entry) => entry.path === fallback);
    if (!has) {
      throw new RecipePlanError(
        "recipe",
        "missing-efi-fallback",
        `the ESP staging tree has no ${fallback}. That is the only boot path ` +
          "independent of an NVRAM Boot#### entry — and NVRAM lives in a " +
          "per-run vars file outside the image, so an image that boots only " +
          `because efibootmgr ran is not a reproducible artifact. Stage the ` +
          `bootloader at ${fallback}.`,
      );
    }
  }
}

/**
 * Plan a resolved recipe. Deterministic: the same inputs always give the same
 * keys, geometry and refusals.
 */
export async function plan(
  resolved: ResolvedRecipe,
  options: PlanOptions = {},
): Promise<Plan> {
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
        virtualSizeBytes: recipe.base.virtualSizeBytes,
        rootPartition: recipe.base.rootPartition,
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
          "multiple-partition-tables",
          "a recipe declares one partition table, and this is the second " +
            "`partition` step. The later one would overwrite the earlier " +
            "one's GPT. Merge their partitions into a single step.",
        );
      }
      layout = planLayout(step, resolved);
    }
    const stepInputs = step.kind === "copyIn"
      ? [resolvedDir(resolved, step.from)]
      : step.kind === "partition"
      ? step.partitions.flatMap((p) =>
        p.contents.kind === "fat"
          ? [resolvedDir(resolved, p.contents.from)]
          : []
      )
      : [];
    const traits = [
      ...new Set(stepInputs.flatMap((input) => input.traits ?? [])),
    ].sort();
    const usesNetwork = step.kind === "run" && step.network === true;
    if (usesNetwork) ancestorUncacheable = true;

    const guestIndices = step.kind === "partition"
      ? guestFilesystems(step)
      : [];
    const executor = executorOf(step);
    const stepAppliance = executor === "guest"
      ? requireAppliance(step.id, recipe.platform.arch, options)
      : undefined;

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
      // Only guest layers carry it: their bytes depend on the appliance, and
      // folding it into a host-side layer's key would invalidate every cached
      // GPT and FAT for a toolchain they never touch.
      ...(stepAppliance === undefined
        ? {}
        : { appliance: stepAppliance.digest }),
      // In the preimage so that uncacheability actually propagates, rather
      // than being asserted in prose and forgotten.
      ancestorUncacheable,
    });
    steps.push({
      index,
      id: step.id,
      recipeKey: key,
      parentRecipeKey: parentKey,
      executor,
      cacheable: !ancestorUncacheable,
      requiredTraits: traits,
      ...(step.kind === "partition"
        ? {
          partitionIndices: step.partitions
            .map((_, i) => i)
            .filter((i) => !guestIndices.includes(i)),
        }
        : {}),
      summary: summarize(step),
    });
    parentKey = key;

    // A partition step carrying a kernel filesystem plans as a SECOND layer.
    // The table and any FAT came from the host above; only the mkfs crosses
    // into the guest, and it does so with a digest boundary in front of it —
    // so its realization key folds in the actual bytes of the GPT whose
    // partitions its kernel is about to parse.
    if (guestIndices.length === 0) continue;
    const mkfsAppliance = requireAppliance(
      `${step.id}:mkfs`,
      recipe.platform.arch,
      options,
    );
    const partitionStep = step as Extract<Step, { kind: "partition" }>;
    const mkfsKey = await recipeKey({
      stepKind: "partition:mkfs",
      stepId: step.id,
      parentRecipeKey: parentKey,
      payload: {
        partitions: guestIndices.map((i) => ({
          index: i,
          fsLabel:
            (partitionStep.partitions[i].contents as { label: string }).label,
        })),
      },
      inputs: [],
      // A moved partition must rekey the format: the same mke2fs run against a
      // different window is a different filesystem in a different place.
      geometry: layout ?? [],
      platform: {
        arch: recipe.platform.arch,
        sectorSize: sector,
        machine: recipe.platform.machine ?? "",
      },
      determinism: recipe.determinism,
      appliance: mkfsAppliance.digest,
      ancestorUncacheable,
    });
    steps.push({
      index,
      id: `${step.id}:mkfs`,
      recipeKey: mkfsKey,
      parentRecipeKey: parentKey,
      executor: "guest",
      cacheable: !ancestorUncacheable,
      requiredTraits: [],
      partitionIndices: guestIndices,
      summary: `mkfs: ${
        guestIndices
          .map((i) => `${partitionStep.partitions[i].label}/ext4`)
          .join(", ")
      }`,
    });
    parentKey = mkfsKey;
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
        `${s.id.padEnd(16)} ${s.executor.padEnd(6)} ${s.summary.padEnd(44)} ` +
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
