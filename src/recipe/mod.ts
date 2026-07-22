/**
 * Recipes for building disk images from scratch.
 *
 * A {@linkcode Recipe} is a plain value — constructing one runs nothing.
 * {@linkcode resolveRecipe} replaces every declared input with its digest (the
 * only I/O before planning), and {@linkcode plan} is then a deterministic
 * function producing a {@linkcode Plan} that names every layer's key, its
 * executor and its partition geometry — assertable in a unit test with no
 * `qemu-img`, no VM and no network.
 *
 * Steps run on one of three executors. `image` is a plain `qemu-img` verb.
 * `bytes` is host-side generation spliced into a partition window with
 * `convert -n --target-image-opts driver=raw,offset=,size=`, plus FAT
 * synthesized by qemu's `vvfat` driver — no VM, and no `mkfs.fat` on the host.
 * `guest` is the build appliance, needed for ext4 and for anything that
 * executes target-architecture ELF.
 *
 * @example Plan a UEFI appliance image without running anything
 * ```ts
 * import {
 *   defineRecipe, dir, LocalInputResolver, plan, resolveRecipe,
 * } from "@nullstyle/qemu-img/recipe";
 *
 * const recipe = defineRecipe({
 *   name: "appliance",
 *   platform: { arch: "aarch64" },
 *   base: { kind: "blank", sizeBytes: 1024 ** 3 },
 *   boot: { kind: "uefi-removable" },
 *   determinism: { sourceDateEpoch: 1700000000, guidSeed: "v1", fsSeed: "v1" },
 *   steps: [{
 *     kind: "partition",
 *     id: "table",
 *     partitions: [{
 *       label: "EFI",
 *       type: "esp",
 *       size: 528450048,
 *       contents: { kind: "fat", fatType: 16, label: "EFI", from: dir("./esp") },
 *     }],
 *   }],
 * });
 *
 * const resolved = await resolveRecipe(recipe, {
 *   resolver: new LocalInputResolver(),
 * });
 * const planned = await plan(resolved);
 * console.log(planned.requiresAppliance, planned.explain());
 * ```
 *
 * @module
 */

export {
  BaseImageSizeMismatchError,
  type CapabilityTrait,
  GuestExecutorUnavailableError,
  InputResolutionError,
  RecipePlanError,
  type RecipePlanErrorCode,
  UnrepresentableContentError,
  type UnrepresentableEntry,
} from "./errors.ts";

export {
  canonicalJson,
  type ParentRealization,
  type RealizationKey,
  realizationKey,
  type RecipeKey,
  recipeKey,
  sha256Hex,
} from "./keys.ts";

export { contentDigest, type ContentDigestOptions } from "./content.ts";

export {
  type BaseSpec,
  type BootSpec,
  defineRecipe,
  type DeterminismPolicy,
  dir,
  type DirInput,
  file,
  type FileInput,
  type FilesystemSpec,
  type GuestArch,
  type Input,
  type PartitionSpec,
  type PartitionType,
  type Platform,
  type Recipe,
  type ResolvedEntry,
  type ResolvedInput,
  type ResolvedRecipe,
  type Step,
} from "./types.ts";

export {
  type InputResolver,
  inputsOf,
  LocalInputResolver,
  recipeInputs,
  resolveRecipe,
  traitsOf,
} from "./resolve.ts";

export { type Artifact, build, type BuildOptions } from "./build.ts";

// `build()` is the only thing that throws it, so it has to be catchable from
// the subpath `build()` lives on — but it is declared in the guest tier,
// because nothing under `src/system/` may import `src/recipe/`. Same class
// either way: `instanceof` matches whichever subpath the caller imported from.
export { GuestStepFailedError } from "../system/errors.ts";

export {
  LayerBusyError,
  LayerIntegrityError,
  LayerStore,
  type StoredLayer,
} from "./store.ts";

export {
  EFI_FALLBACK,
  type Executor,
  type Plan,
  plan,
  type PlanAppliance,
  type PlannedPartition,
  type PlannedStep,
  type PlanOptions,
  TAR_TRANSPORT_TRAITS,
  totalSizeBytes,
  VVFAT_USABLE_BYTES,
} from "./plan.ts";
