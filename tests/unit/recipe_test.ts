import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  BaseImageSizeMismatchError,
  canonicalJson,
  defineRecipe,
  dir,
  file,
  GuestStepFailedError,
  type Input,
  InputResolutionError,
  type InputResolver,
  LocalInputResolver,
  plan,
  type PlanAppliance,
  type PlanOptions,
  realizationKey,
  type Recipe,
  type RecipeKey,
  RecipePlanError,
  type ResolvedEntry,
  type ResolvedInput,
  resolveRecipe,
  sha256Hex,
  type Step,
  traitsOf,
  UnrepresentableContentError,
  VVFAT_USABLE_BYTES,
} from "../../src/recipe/mod.ts";
// Imported under a second name so the test can assert the two public subpaths
// hand back the same class, rather than two that merely agree on `.name`.
import {
  GuestStepFailedError as SystemGuestStepFailedError,
  type StepOutcome,
} from "../../src/system/mod.ts";

/**
 * A resolver with no filesystem behind it: tests declare exactly what a tree
 * contains. `plan()` does no I/O, so the whole planner is testable this way.
 */
class StubResolver implements InputResolver {
  constructor(private readonly trees: Record<string, ResolvedEntry[]> = {}) {}
  resolve(input: Input): Promise<ResolvedInput> {
    const entries = this.trees[input.path] ?? [];
    return Promise.resolve({
      input,
      sha256: `stub-${input.path}-${entries.length}`,
      sizeBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
      entries,
      traits: traitsOf(entries),
    });
  }
}

const ESP_TREE: ResolvedEntry[] = [
  { path: "EFI", type: "dir", mode: 0o755, sizeBytes: 0 },
  { path: "EFI/BOOT", type: "dir", mode: 0o755, sizeBytes: 0 },
  {
    path: "EFI/BOOT/BOOTAA64.EFI",
    type: "file",
    mode: 0o644,
    sizeBytes: 4096,
    sha256: "a".repeat(64),
  },
];

function baseRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return defineRecipe({
    name: "appliance",
    platform: { arch: "aarch64" },
    base: { kind: "blank", sizeBytes: 1024 ** 3 },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: "seed",
      fsSeed: "seed",
    },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "EFI",
        type: "esp",
        size: VVFAT_USABLE_BYTES[16],
        contents: {
          kind: "fat",
          fatType: 16,
          label: "EFI",
          from: dir("./esp"),
        },
      }],
    }],
    ...overrides,
  });
}

/**
 * A stand-in appliance identity. Guest steps refuse to plan without one, and
 * the planner only ever reads two fields — so the tests need no appliance on
 * disk, and the digest's effect on keys stays directly assertable.
 */
const STUB_APPLIANCE: PlanAppliance = {
  digest: "stub-appliance-digest",
  arch: "aarch64",
};

async function planOf(
  recipe: Recipe,
  trees: Record<string, ResolvedEntry[]> = { "./esp": ESP_TREE },
  options: PlanOptions = { appliance: STUB_APPLIANCE },
) {
  return await plan(
    await resolveRecipe(recipe, {
      resolver: new StubResolver(trees),
    }),
    options,
  );
}

Deno.test("canonicalJson sorts keys at every depth and refuses lossy values", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
  );
  // A key input that silently vanishes is a cache-poisoning bug.
  assertThrows(
    () => canonicalJson({ a: undefined }),
    TypeError,
    "would vanish",
  );
  assertThrows(() => canonicalJson({ a: NaN }), TypeError, "non-finite");
  assertThrows(() => canonicalJson({ a: () => {} }), TypeError, "unsupported");
});

Deno.test("plan geometry: 1 MiB alignment, GPT tail reserved", async () => {
  const planned = await planOf(baseRecipe());
  const esp = planned.layout?.[0];
  assertEquals(esp?.firstLba, 2048, "1 MiB / 512 = LBA 2048, never LBA 63");
  assertEquals(esp?.offsetBytes, 1048576);
  assertEquals(esp?.lengthBytes, VVFAT_USABLE_BYTES[16]);
  // A GPT's backup header lives in the last 33 sectors; nothing may reach it.
  const lastUsable = 1024 ** 3 / 512 - 33 - 1;
  assert((esp?.lastLba ?? 0) <= lastUsable);
  assertEquals(planned.requiresAppliance, false, "FAT + GPT need no VM");
  assertEquals(planned.steps.map((s) => s.executor), ["image", "bytes"]);
});

/** A recipe whose one partition needs a kernel filesystem. */
function ext4Recipe(): Recipe {
  return baseRecipe({
    boot: { kind: "none" },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "root",
        type: "linux-root",
        size: "rest",
        contents: { kind: "ext4", label: "root" },
      }],
    }],
  });
}

/**
 * A recipe with a real root filesystem, for the step kinds that mount one.
 * `run` and `copyIn` are refused without exactly one, so they cannot be
 * exercised against a recipe that declares no partitions at all.
 */
function rootedRecipe(steps: readonly Step[]): Recipe {
  return baseRecipe({
    boot: { kind: "none" },
    steps: [
      {
        kind: "partition",
        id: "table",
        partitions: [{
          label: "root",
          type: "linux-root",
          size: "rest",
          contents: { kind: "ext4", label: "root" },
        }],
      },
      ...steps,
    ],
  });
}

Deno.test("one declared partition step with ext4 plans as two layers", async () => {
  const planned = await planOf(ext4Recipe(), {});
  // The table is host-side ALWAYS: the appliance has e2fsprogs and nothing
  // else, so a guest could not write a GPT even if we asked it to.
  assertEquals(
    planned.steps.map((s) => [s.id, s.executor]),
    [["base", "image"], ["table", "bytes"], ["table:mkfs", "guest"]],
  );
  assertEquals(planned.requiresAppliance, true);
  // Both layers point at the same declaration, and split the partitions.
  assertEquals(planned.steps[1].index, planned.steps[2].index);
  assertEquals(planned.steps[1].partitionIndices, []);
  assertEquals(planned.steps[2].partitionIndices, [0]);
});

Deno.test("a mixed ESP + ext4 table splits the partitions between the layers", async () => {
  const mixed = baseRecipe({
    base: { kind: "blank", sizeBytes: 4 * 1024 ** 3 },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [
        {
          label: "EFI",
          type: "esp",
          size: VVFAT_USABLE_BYTES[16],
          contents: {
            kind: "fat",
            fatType: 16,
            label: "EFI",
            from: dir("./esp"),
          },
        },
        {
          label: "root",
          type: "linux-root",
          size: "rest",
          contents: { kind: "ext4", label: "root" },
        },
      ],
    }],
  });
  const planned = await planOf(mixed);
  assertEquals(planned.steps.length, 3);
  // The FAT stays with the host layer; only the ext4 window crosses over.
  assertEquals(planned.steps[1].partitionIndices, [0]);
  assertEquals(planned.steps[2].partitionIndices, [1]);
});

Deno.test("FAT alone never reaches the guest", async () => {
  const planned = await planOf(baseRecipe());
  assertEquals(planned.steps.map((s) => s.executor), ["image", "bytes"]);
  assertEquals(planned.requiresAppliance, false);
});

Deno.test("a guest step refuses to plan without an appliance identity", async () => {
  const error = await assertRejects(
    () => planOf(ext4Recipe(), {}, {}),
    RecipePlanError,
  );
  // The message has to name the consequence, not just the missing argument:
  // a key that omits the toolchain is a key that lies about what it names.
  assert(error.message.includes("readApplianceIdentity"), error.message);
  assert(error.message.includes("different toolchain"), error.message);
});

Deno.test("the appliance digest is part of a guest layer's key, and only a guest layer's", async () => {
  const withA = await planOf(ext4Recipe(), {}, {
    appliance: { digest: "appliance-a", arch: "aarch64" },
  });
  const withB = await planOf(ext4Recipe(), {}, {
    appliance: { digest: "appliance-b", arch: "aarch64" },
  });
  // Rebuilding the appliance on a new Alpine must not leave every guest layer
  // a cache hit on bytes the new toolchain would never have produced.
  assert(
    withA.steps[2].recipeKey !== withB.steps[2].recipeKey,
    "the mkfs layer's key must move with the appliance",
  );
  // …but the host-side table below it is untouched by the toolchain, and
  // rekeying it would throw away a correct cached layer for nothing.
  assertEquals(
    withA.steps[1].recipeKey,
    withB.steps[1].recipeKey,
    "the host-side table layer must NOT move with the appliance",
  );
});

// ─────────────────────────────────────────────── the key-sensitivity matrix ──
// One test per key input class. A cache-key omission is otherwise detectable
// only by rebuilding and comparing — which is the work the cache exists to
// avoid — so this is the cheapest test for the most expensive bug.

/** The image arm of {@linkcode BaseSpec}, for spreading in mutations. */
type ImageBase = Extract<Recipe["base"], { kind: "image" }>;

/** A recipe starting from an existing image, which declares no table. */
function imageBaseRecipe(): Recipe {
  return baseRecipe({
    boot: { kind: "none" },
    base: {
      kind: "image",
      from: file("./cloud.qcow2"),
      format: "qcow2",
      virtualSizeBytes: 4 * 1024 ** 3,
      rootPartition: 1,
    },
    steps: [{ kind: "run", id: "configure", script: "true" }],
  });
}

const MUTATIONS: Array<
  {
    name: string;
    mutate: (r: Recipe) => Recipe;
    baseline?: () => Recipe;
    trees?: Record<string, ResolvedEntry[]>;
  }
> = [
  {
    name: "recipe name",
    mutate: (r) => ({ ...r, name: "other" }),
  },
  {
    name: "architecture",
    // Needs a baseline that plans on both arches: a `uefi-removable` recipe
    // is arch-specific by construction, since the EFI fallback filename
    // differs, so switching arch under it is a refusal rather than a rekey.
    baseline: () => baseRecipe({ boot: { kind: "none" } }),
    mutate: (r) => ({ ...r, platform: { ...r.platform, arch: "x86_64" } }),
  },
  {
    name: "sector size",
    // Needs a baseline with no FAT in it. vvfat's filesystem is a whole number
    // of 512-byte sectors and not of 4096-byte ones, so a FAT partition on a
    // 4096-sector disk is now a refusal rather than a rekey — see the test
    // below this matrix.
    baseline: ext4Recipe,
    mutate: (r) => ({ ...r, platform: { ...r.platform, sectorSize: 4096 } }),
  },
  {
    name: "base size",
    mutate: (r) => ({
      ...r,
      base: { kind: "blank", sizeBytes: 2 * 1024 ** 3 },
    }),
  },
  {
    name: "cluster_size",
    mutate: (r) => ({
      ...r,
      base: {
        kind: "blank",
        sizeBytes: 1024 ** 3,
        options: { cluster_size: 4096 },
      },
    }),
  },
  {
    name: "sourceDateEpoch",
    mutate: (r) => ({
      ...r,
      determinism: { ...r.determinism, sourceDateEpoch: 1 },
    }),
  },
  {
    name: "guidSeed",
    mutate: (r) => ({ ...r, determinism: { ...r.determinism, guidSeed: "x" } }),
  },
  {
    name: "fsSeed",
    mutate: (r) => ({ ...r, determinism: { ...r.determinism, fsSeed: "x" } }),
  },
  {
    name: "partition label",
    mutate: (r) => ({
      ...r,
      steps: [{
        kind: "partition",
        id: "table",
        partitions: [{
          label: "ESP2",
          type: "esp",
          size: VVFAT_USABLE_BYTES[16],
          contents: {
            kind: "fat",
            fatType: 16,
            label: "EFI",
            from: dir("./esp"),
          },
        }],
      }],
    }),
  },
  {
    name: "FAT volume label",
    mutate: (r) => ({
      ...r,
      steps: [{
        kind: "partition",
        id: "table",
        partitions: [{
          label: "EFI",
          type: "esp",
          size: VVFAT_USABLE_BYTES[16],
          contents: {
            kind: "fat",
            fatType: 16,
            label: "BOOT",
            from: dir("./esp"),
          },
        }],
      }],
    }),
  },
  {
    name: "step id",
    mutate: (r) => ({
      ...r,
      steps: [{
        ...(r.steps[0] as Extract<Step, { kind: "partition" }>),
        id: "renamed",
      }],
    }),
  },
  {
    name: "copyIn destination",
    baseline: () =>
      rootedRecipe([
        { kind: "copyIn", id: "app", from: dir("./app"), to: "/opt/app" },
      ]),
    trees: { "./esp": ESP_TREE, "./app": [] },
    mutate: (r) => ({
      ...r,
      steps: [r.steps[0], {
        kind: "copyIn",
        id: "app",
        from: dir("./app"),
        to: "/srv/app",
      }],
    }),
  },
  {
    // The declared virtual size decides every partition LBA and where the
    // backup GPT goes, so it cannot be a free-floating annotation.
    name: "base image virtual size",
    baseline: imageBaseRecipe,
    trees: {},
    mutate: (r) => ({
      ...r,
      base: { ...(r.base as ImageBase), virtualSizeBytes: 8 * 1024 ** 3 },
    }),
  },
  {
    name: "base image root partition",
    baseline: imageBaseRecipe,
    trees: {},
    mutate: (r) => ({
      ...r,
      base: { ...(r.base as ImageBase), rootPartition: 2 },
    }),
  },
];

for (
  const {
    name,
    mutate,
    baseline = baseRecipe,
    trees = { "./esp": ESP_TREE },
  } of MUTATIONS
) {
  Deno.test(`key sensitivity: ${name} changes the output key`, async () => {
    const before = await planOf(baseline(), trees);
    const after = await planOf(mutate(baseline()), trees);
    assert(
      before.outputRecipeKey !== after.outputRecipeKey,
      `changing the ${name} must move the key, or a stale layer is served`,
    );
  });
}

Deno.test("key stability: the keys themselves are pinned to these literals", async () => {
  // The matrix above proves keys MOVE when they should. Nothing proved they
  // STAY when they should — two plans built by the same code agree even if the
  // scheme shifted under both. These literals were captured from the committed
  // tree and are the whole cache's identity: if one changes, every cached
  // layer in every user's store is dead, silently, at the next build. That may
  // be the right call, but it has to be a decision rather than a side effect.
  assertEquals(
    (await planOf(baseRecipe())).outputRecipeKey,
    "0a90c7bfe639f2c0c334fa04e7619cc188092ca034bf21217f39bec602b834c5",
    "FAT16 ESP over a blank base",
  );
  // Includes the generated `table:mkfs` layer, whose key folds the appliance
  // digest — the one key input that is not in the recipe.
  assertEquals(
    (await planOf(ext4Recipe(), {})).outputRecipeKey,
    "fc2ea7de49a8c3eaa31ba1a334ffbfa1af5d418dcb0fa280ddea4e38ee4a20d0",
    "ext4 root over a blank base",
  );
});

Deno.test("key stability: irrelevant changes do not move the key", async () => {
  const a = await planOf(baseRecipe());
  // A structurally identical recipe built from a different object graph, with
  // its keys written in a different order.
  const b = await planOf(defineRecipe({
    determinism: {
      fsSeed: "seed",
      guidSeed: "seed",
      sourceDateEpoch: 1_700_000_000,
    },
    steps: [{
      partitions: [{
        contents: {
          label: "EFI",
          from: dir("./esp"),
          fatType: 16,
          kind: "fat",
        },
        size: VVFAT_USABLE_BYTES[16],
        type: "esp",
        label: "EFI",
      }],
      id: "table",
      kind: "partition",
    }],
    boot: { kind: "uefi-removable" },
    base: { sizeBytes: 1024 ** 3, kind: "blank" },
    platform: { arch: "aarch64" },
    name: "appliance",
  }));
  assertEquals(a.outputRecipeKey, b.outputRecipeKey);
});

Deno.test("a step's key changes when its input tree's content changes", async () => {
  const before = await planOf(baseRecipe());
  const after = await planOf(baseRecipe(), {
    "./esp": [...ESP_TREE, {
      path: "EFI/BOOT/extra.txt",
      type: "file",
      mode: 0o644,
      sizeBytes: 10,
      sha256: "b".repeat(64),
    }],
  });
  assert(before.outputRecipeKey !== after.outputRecipeKey);
});

// ────────────────────────────────────────── the realization-key requirement ──

Deno.test("realization keys chain through the parent's ACTUAL content", async () => {
  const key = "k".repeat(64) as RecipeKey;
  const root = await realizationKey(key);
  const childA = await realizationKey(key, {
    realizationKey: root,
    contentSha256: "a".repeat(64),
  });
  const childB = await realizationKey(key, {
    realizationKey: root,
    contentSha256: "b".repeat(64),
  });
  // This is the guard against the worst failure the design can have: a parent
  // whose content changed while its recipe key did not. If these collided, the
  // child would be a cache HIT whose overlay carries clusters written against
  // the parent's OLD layout — structural corruption that `qemu-img check`
  // cannot see, because qcow2 records nothing about a backing file's content.
  assert(childA !== childB, "a changed parent must be a miss by construction");
  assertEquals(await realizationKey(key), root, "and it stays deterministic");
});

// ─────────────────────────────────────────────────────────────── refusals ──

Deno.test("refuses a FAT partition below vvfat's fixed geometry", async () => {
  const error = await assertRejects(
    () =>
      planOf(baseRecipe({
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [{
            label: "EFI",
            type: "esp",
            size: 64 * 1024 * 1024,
            contents: {
              kind: "fat",
              fatType: 16,
              label: "EFI",
              from: dir("./esp"),
            },
          }],
        }],
      })),
    RecipePlanError,
  );
  // The message must carry the exact figure, since it is not negotiable.
  assert(error.message.includes(String(VVFAT_USABLE_BYTES[16])));
  assert(error.message.includes("Grow the partition"), "name the fix");
  assertEquals(error.code, "fat-window-too-small");
});

/** A one-partition FAT recipe, for exercising the vvfat window's two edges. */
function fatRecipe(size: number | "rest", fatType: 12 | 16 = 16): Recipe {
  return baseRecipe({
    base: { kind: "blank", sizeBytes: 4 * 1024 ** 3 },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "EFI",
        type: "esp",
        size,
        contents: { kind: "fat", fatType, label: "EFI", from: dir("./esp") },
      }],
    }],
  });
}

Deno.test("refuses a FAT partition ABOVE vvfat's fixed geometry too", async () => {
  // The too-small side was refused from the start; this side reached build()
  // and came back as qemu-img's own words about a `raw` node it could not
  // open — "The sum of offset (32256) and size (…) has to be smaller or equal
  // to the actual size of the containing file (…)" — three numbers, none of
  // them the partition the recipe declared.
  const error = await assertRejects(
    () => planOf(fatRecipe(VVFAT_USABLE_BYTES[16] + 1024 * 1024)),
    RecipePlanError,
  );
  assertEquals(error.code, "fat-window-too-large");
  assert(
    error.message.includes(String(VVFAT_USABLE_BYTES[16])),
    `names the only size that works:\n${error.message}`,
  );
  assertStringIncludes(error.message, "Shrink the partition to exactly");
  // "rest" is the usual way to land here by accident: it takes everything left
  // on the disk, which is never vvfat's fixed window.
  const rest = await assertRejects(
    () => planOf(fatRecipe("rest")),
    RecipePlanError,
  );
  assertEquals(rest.code, "fat-window-too-large");
});

Deno.test("vvfat's FAT12 window is the size qemu will actually open", async () => {
  // Measured on qemu-img 11.0.2: the vvfat device is 33030144 bytes and its
  // MBR entry puts the filesystem at LBA 63 for 64449 sectors, so the window
  // build() opens at offset 32256 is 32997888 bytes. Through 0.2.1 this
  // constant was 33005568 — 7680 bytes too many — so a recipe sized with the
  // package's own constant planned clean and then failed in build().
  assertEquals(VVFAT_USABLE_BYTES[12], 32_997_888);
  assertEquals(VVFAT_USABLE_BYTES[16], 528_450_048);
  const planned = await planOf(fatRecipe(VVFAT_USABLE_BYTES[12], 12));
  assertEquals(planned.layout?.[0].lengthBytes, VVFAT_USABLE_BYTES[12]);
});

Deno.test("refuses vvfat FAT on a 4096-byte-sector disk, and says why", async () => {
  // Neither vvfat window is a multiple of 4096, so no `size` can land on one:
  // the partition is always rounded up past it. Before this refusal the
  // recipe planned, keyed and then died in build().
  const error = await assertRejects(
    () =>
      planOf(
        baseRecipe({
          platform: { arch: "aarch64", sectorSize: 4096 },
          base: { kind: "blank", sizeBytes: 4 * 1024 ** 3 },
          steps: [{
            kind: "partition",
            id: "table",
            partitions: [{
              label: "EFI",
              type: "esp",
              size: VVFAT_USABLE_BYTES[16],
              contents: {
                kind: "fat",
                fatType: 16,
                label: "EFI",
                from: dir("./esp"),
              },
            }],
          }],
        }),
      ),
    RecipePlanError,
  );
  assertEquals(error.code, "fat-window-too-large");
  // Telling this caller to "shrink to 528450048" would be advice they cannot
  // take, so the message has to name the sector size as the actual cause.
  assert(
    !error.message.includes("Shrink the partition to exactly"),
    `must not name an unreachable fix:\n${error.message}`,
  );
  assertStringIncludes(error.message, "not a multiple");
  assertStringIncludes(error.message, "`sectorSize: 512`");
});

Deno.test("refuses two partitions sharing a label", async () => {
  // build() derives the GPT PARTUUID as deriveGuid(guidSeed, "partition:" +
  // label), and an ext4 window's volume UUID and hash seed from the same
  // string. Two partitions with one label get one of each.
  const error = await assertRejects(
    () =>
      planOf(baseRecipe({
        boot: { kind: "none" },
        base: { kind: "blank", sizeBytes: 4 * 1024 ** 3 },
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [
            {
              label: "data",
              type: "linux-generic",
              size: 64 * 1024 * 1024,
              contents: { kind: "empty" },
            },
            {
              label: "data",
              type: "linux-generic",
              size: "rest",
              contents: { kind: "empty" },
            },
          ],
        }],
      })),
    RecipePlanError,
  );
  assertEquals(error.code, "duplicate-partition-label");
  assertStringIncludes(error.message, "PARTUUID");
  assertStringIncludes(error.message, "Give them distinct labels");
  // The point is that nothing downstream would have complained.
  assertStringIncludes(error.message, "would still build, mount");
});

Deno.test("refuses an appliance whose arch disagrees with the recipe", async () => {
  // mke2fs writes a valid filesystem on either architecture and a `run`
  // script exits 0, so the wrong appliance produces a plausible image whose
  // ELF the target cannot execute. Nothing downstream catches it.
  const error = await assertRejects(
    () =>
      planOf(ext4Recipe(), {}, {
        appliance: { digest: "x86-appliance", arch: "x86_64" },
      }),
    RecipePlanError,
  );
  assertEquals(error.code, "appliance-arch-mismatch");
  assertStringIncludes(error.message, "x86_64");
  assertStringIncludes(error.message, "aarch64");
  assertStringIncludes(
    error.message,
    'readApplianceIdentity({ arch: "aarch64" })',
  );
  // A matching appliance still plans, so the guard is about the mismatch and
  // not about guest steps in general.
  const ok = await planOf(ext4Recipe(), {}, {
    appliance: { digest: "arm-appliance", arch: "aarch64" },
  });
  assertEquals(ok.requiresAppliance, true);
});

Deno.test("the arch check covers the generated :mkfs layer too", async () => {
  // A declared partition step plans as `<id>` on the host plus `<id>:mkfs` in
  // the guest. Only the second is a guest layer, so a recipe whose ONLY guest
  // work is the mkfs must still be refused — by the layer that actually runs.
  const error = await assertRejects(
    () =>
      planOf(ext4Recipe(), {}, {
        appliance: { digest: "x86-appliance", arch: "x86_64" },
      }),
    RecipePlanError,
  );
  assertEquals(error.stepId, "table:mkfs");
});

Deno.test("refuses a partition size that is not a positive whole number", async () => {
  // Each of these passed every geometry guard — `Math.ceil(NaN)` is NaN, and
  // `NaN <= 0` and `NaN > lastUsable` are both false — and surfaced from
  // canonicalJson as `TypeError: non-finite number at $.payload…`, an internal
  // detail of the key scheme naming nothing the caller wrote.
  for (const size of [NaN, Infinity, -Infinity, 1.5, -1, 0, 2 ** 53]) {
    const error = await assertRejects(
      () =>
        planOf(baseRecipe({
          boot: { kind: "none" },
          steps: [{
            kind: "partition",
            id: "table",
            partitions: [{
              label: "data",
              type: "linux-generic",
              size,
              contents: { kind: "empty" },
            }],
          }],
        })),
      RecipePlanError,
      "positive whole number of bytes",
      `size ${size} must be refused`,
    );
    assertEquals(error.code, "invalid-partition-size");
    assertEquals(error.stepId, "table");
  }
});

Deno.test("refuses a negative firstPartitionOffset", async () => {
  // `-1048576 % 512` is `-0`, which is not `!== 0`, so the alignment check
  // passed it and Math.max then quietly used LBA 34 instead.
  const error = await assertRejects(
    () =>
      planOf(baseRecipe({
        boot: { kind: "none" },
        steps: [{
          kind: "partition",
          id: "table",
          firstPartitionOffset: -1048576,
          partitions: [{
            label: "data",
            type: "linux-generic",
            size: "rest",
            contents: { kind: "empty" },
          }],
        }],
      })),
    RecipePlanError,
  );
  assertEquals(error.code, "invalid-first-partition-offset");
  assertStringIncludes(error.message, "non-negative");
});

Deno.test("refuses an over-long FAT label", async () => {
  await assertRejects(
    () =>
      planOf(baseRecipe({
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [{
            label: "EFI",
            type: "esp",
            size: VVFAT_USABLE_BYTES[16],
            contents: {
              kind: "fat",
              fatType: 16,
              label: "THIS-IS-TOO-LONG",
              from: dir("./esp"),
            },
          }],
        }],
      })),
    RecipePlanError,
    "exceeds 11 bytes",
  );
});

Deno.test("refuses uefi-removable without the arch's EFI fallback binary", async () => {
  // The tree is a valid ESP — it just has no BOOTAA64.EFI.
  await assertRejects(
    () =>
      planOf(baseRecipe(), {
        "./esp": [{
          path: "EFI/BOOT/grubaa64.efi",
          type: "file",
          mode: 0o644,
          sizeBytes: 10,
          sha256: "c".repeat(64),
        }],
      }),
    RecipePlanError,
    "BOOTAA64.EFI",
  );
  // x86_64 wants the other spelling, and the same tree must fail there too.
  await assertRejects(
    () =>
      planOf(
        baseRecipe({ platform: { arch: "x86_64" } }),
        { "./esp": ESP_TREE },
      ),
    RecipePlanError,
    "BOOTX64.EFI",
  );
});

Deno.test("refuses an unversioned machine alias", async () => {
  await assertRejects(
    () =>
      planOf(baseRecipe({ platform: { arch: "aarch64", machine: "virt" } })),
    RecipePlanError,
    "unversioned alias",
  );
  // A versioned one is accepted.
  const planned = await planOf(
    baseRecipe({ platform: { arch: "aarch64", machine: "virt-11.0" } }),
  );
  assert(planned.outputRecipeKey.length === 64);
});

Deno.test("refuses a partition that runs past the last usable LBA", async () => {
  await assertRejects(
    () =>
      planOf(baseRecipe({
        base: { kind: "blank", sizeBytes: 600 * 1024 * 1024 },
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [{
            label: "EFI",
            type: "esp",
            size: 599 * 1024 * 1024,
            contents: {
              kind: "fat",
              fatType: 16,
              label: "EFI",
              from: dir("./esp"),
            },
          }],
        }],
      })),
    RecipePlanError,
    "backup header",
  );
});

Deno.test("refuses staging content FAT cannot represent", async () => {
  const error = await assertRejects(
    () =>
      planOf(baseRecipe(), {
        "./esp": [
          ...ESP_TREE,
          {
            path: "EFI/BOOT/link",
            type: "symlink",
            mode: 0o777,
            sizeBytes: 0,
            linkTarget: "BOOTAA64.EFI",
          },
          {
            path: "EFI/BOOT/run.sh",
            type: "file",
            mode: 0o755,
            sizeBytes: 5,
            sha256: "d".repeat(64),
          },
        ],
      }),
    UnrepresentableContentError,
  );
  // Naming the offending paths is the point: vvfat would produce a valid
  // filesystem that mounts, fsck's clean, and is quietly missing all of it.
  assert(error.entries.some((e) => e.reason === "symlinks"));
  assert(error.entries.some((e) => e.reason === "posixModes"));
  assert(error.message.includes("EFI/BOOT/link"));
});

Deno.test("uniform ownership is not a required trait; varying ownership is", () => {
  const uniform: ResolvedEntry[] = [
    { path: "a", type: "file", mode: 0o644, sizeBytes: 1, uid: 501, gid: 20 },
    { path: "b", type: "file", mode: 0o644, sizeBytes: 1, uid: 501, gid: 20 },
  ];
  // A tree checked out by a normal user is uniformly owned by that user. That
  // says nothing about the image, and treating it as intent would make FAT
  // unbuildable on every machine where you are not root.
  assertEquals(traitsOf(uniform), []);
  assertEquals(
    traitsOf([
      ...uniform,
      { path: "c", type: "file", mode: 0o644, sizeBytes: 1, uid: 0, gid: 0 },
    ]),
    ["posixOwnership"],
  );
});

Deno.test("refuses duplicate step ids and a second partition table", async () => {
  await assertRejects(
    () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [
            { kind: "run", id: "same", script: "true" },
            { kind: "run", id: "same", script: "true" },
          ],
        }),
        {},
      ),
    RecipePlanError,
    "duplicate step id",
  );
});

Deno.test("refuses a step id containing the separator the planner reserves", async () => {
  await assertRejects(
    () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [{ kind: "run", id: "build:app", script: "true" }],
        }),
        {},
      ),
    RecipePlanError,
    "`:` is reserved in step ids",
  );
});

Deno.test("refuses a run or copyIn step with no unambiguous root filesystem", async () => {
  // Both mount "the root filesystem". With none declared there is nothing to
  // mount; with two there is no answer to which one.
  const error = await assertRejects(
    () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [{ kind: "run", id: "configure", script: "true" }],
        }),
        {},
      ),
    RecipePlanError,
    "mounts the recipe's root filesystem",
  );
  assert(error.message.includes("declares 0 ext4"), error.message);
});

Deno.test("refuses a copyIn destination that is not absolute and normalized", async () => {
  for (const to of ["opt/app", "/opt/../etc", "/opt//app", "/opt/./app"]) {
    await assertRejects(
      () =>
        planOf(
          rootedRecipe([
            { kind: "copyIn", id: "app", from: dir("./app"), to },
          ]),
          { "./esp": ESP_TREE, "./app": [] },
        ),
      RecipePlanError,
      "absolute, normalized path",
      `"${to}" must be refused`,
    );
  }
});

Deno.test("refuses a copyIn tree the ustar transport would flatten", async () => {
  // ext4 holds ownership perfectly well — but the archive that carries the
  // tree there writes uid/gid 0, so varying ownership arrives flattened. The
  // narrower of the two capabilities is the one that governs.
  const owned: ResolvedEntry[] = [
    { path: "a", type: "file", mode: 0o644, sizeBytes: 1, uid: 0, gid: 0 },
    { path: "b", type: "file", mode: 0o644, sizeBytes: 1, uid: 501, gid: 20 },
  ];
  const error = await assertRejects(
    () =>
      planOf(
        rootedRecipe([
          { kind: "copyIn", id: "app", from: dir("./app"), to: "/opt/app" },
        ]),
        { "./esp": ESP_TREE, "./app": owned },
      ),
    UnrepresentableContentError,
    "ustar transport",
  );
  assert(error.message.includes("posixOwnership"), error.message);
});

Deno.test("refuses an ext4 partition carrying a staging tree", async () => {
  // The type has no `from`; this is the untyped-JavaScript escape hatch, and
  // ignoring it would build an empty filesystem that mounts and fscks clean.
  const smuggled = baseRecipe({
    boot: { kind: "none" },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "root",
        type: "linux-root",
        size: "rest",
        contents: {
          kind: "ext4",
          label: "root",
          from: dir("./app"),
        } as unknown as Extract<Step, { kind: "partition" }>["partitions"][
          number
        ]["contents"],
      }],
    }],
  });
  await assertRejects(
    () => planOf(smuggled, { "./app": [] }),
    RecipePlanError,
    "formats it and nothing else",
  );
});

Deno.test("refuses laying a new partition table over an existing base image", async () => {
  await assertRejects(
    () =>
      planOf(baseRecipe({
        base: {
          kind: "image",
          from: file("./cloud.qcow2"),
          format: "qcow2",
          virtualSizeBytes: 4 * 1024 ** 3,
          rootPartition: 1,
        },
      })),
    RecipePlanError,
    "discarding every partition in it",
  );
});

// ──────────────────────────────────────────── machine-readable refusal codes ──

Deno.test("every refusal carries a code a caller can branch on", async () => {
  // `RecipePlanError` covers two dozen unrelated causes. Without a
  // discriminant the only way to tell them apart was to match on `message`,
  // which couples a caller's control flow to prose this package rewrites
  // whenever a measurement improves. These pairs are the pre-existing causes:
  // if a throw site were missed while adding codes, its entry here is the one
  // that fails.
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      "unversioned-machine",
      () =>
        planOf(baseRecipe({ platform: { arch: "aarch64", machine: "virt" } })),
    ],
    ["duplicate-step-id", () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [
            { kind: "run", id: "same", script: "true" },
            { kind: "run", id: "same", script: "true" },
          ],
        }),
        {},
      )],
    ["reserved-step-id-separator", () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [{ kind: "run", id: "build:app", script: "true" }],
        }),
        {},
      )],
    ["ambiguous-root-filesystem", () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          steps: [{ kind: "run", id: "configure", script: "true" }],
        }),
        {},
      )],
    ["partition-past-last-usable-lba", () =>
      planOf(baseRecipe({
        base: { kind: "blank", sizeBytes: 600 * 1024 * 1024 },
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [{
            label: "EFI",
            type: "esp",
            size: 599 * 1024 * 1024,
            contents: {
              kind: "fat",
              fatType: 16,
              label: "EFI",
              from: dir("./esp"),
            },
          }],
        }],
      }))],
    ["fat-label-too-long", () =>
      planOf(baseRecipe({
        steps: [{
          kind: "partition",
          id: "table",
          partitions: [{
            label: "EFI",
            type: "esp",
            size: VVFAT_USABLE_BYTES[16],
            contents: {
              kind: "fat",
              fatType: 16,
              label: "THIS-IS-TOO-LONG",
              from: dir("./esp"),
            },
          }],
        }],
      }))],
    ["missing-efi-fallback", () => planOf(baseRecipe(), { "./esp": [] })],
    ["appliance-required", () => planOf(ext4Recipe(), {}, {})],
    ["partition-over-image-base", () =>
      planOf(baseRecipe({
        base: {
          kind: "image",
          from: file("./cloud.qcow2"),
          format: "qcow2",
          virtualSizeBytes: 4 * 1024 ** 3,
          rootPartition: 1,
        },
      }))],
    ["root-partition-out-of-range", () =>
      planOf(
        baseRecipe({
          boot: { kind: "none" },
          base: {
            kind: "image",
            from: file("./cloud.qcow2"),
            format: "qcow2",
            virtualSizeBytes: 4 * 1024 ** 3,
            rootPartition: 0,
          },
          steps: [],
        }),
        {},
      )],
  ];
  for (const [code, run] of cases) {
    const error = await assertRejects(run, RecipePlanError);
    assertEquals(error.code, code, `wrong code for ${code}: ${error.message}`);
  }
});

Deno.test("a refusal code is stable while its wording is not", async () => {
  const error = await assertRejects(
    () => planOf(ext4Recipe(), {}, {}),
    RecipePlanError,
  );
  // The contract is the code plus `stepId`. Everything else is prose.
  assertEquals(error.code, "appliance-required");
  assertEquals(error.stepId, "table:mkfs");
  assertEquals(error.name, "RecipePlanError");
});

// ─────────────────────────────────────────── resolving inputs off the disk ──

Deno.test("a mistyped input path names its step and field, not an errno", async () => {
  // It used to arrive as `NotFound: No such file or directory (os error 2):
  // readdir './esp'` — an errno and a path, and nothing about which of a
  // recipe's inputs it was.
  const recipe = rootedRecipe([{
    kind: "copyIn",
    id: "app",
    from: dir("tests/no-such-staging-tree"),
    to: "/opt/app",
  }]);
  const error = await assertRejects(
    () => resolveRecipe(recipe, { resolver: new LocalInputResolver() }),
    InputResolutionError,
  );
  assertEquals(error.stepId, "app");
  assertEquals(error.field, "steps[1].from");
  assertEquals(error.inputKind, "dir");
  assertEquals(error.path, "tests/no-such-staging-tree");
  assertStringIncludes(error.message, "no such directory");
  assertStringIncludes(error.message, "Fix the path");
  // The host's own error is kept, because it is the only thing that knows
  // whether this was a typo or a permission problem.
  assert(error.cause instanceof Deno.errors.NotFound, String(error.cause));
});

Deno.test("a dir() pointing at a file says so, rather than repeating an errno", async () => {
  const recipe = rootedRecipe([{
    kind: "copyIn",
    id: "app",
    from: dir("tests/unit/recipe_test.ts"),
    to: "/opt/app",
  }]);
  const error = await assertRejects(
    () => resolveRecipe(recipe, { resolver: new LocalInputResolver() }),
    InputResolutionError,
  );
  assertStringIncludes(error.message, "declared as a directory");
});

Deno.test("a base image that is not there names base.from", async () => {
  const recipe = defineRecipe({
    name: "cloud",
    platform: { arch: "aarch64" },
    base: {
      kind: "image",
      from: file("tests/no-such-cloud-image.qcow2"),
      format: "qcow2",
      virtualSizeBytes: 4 * 1024 ** 3,
      rootPartition: 2,
    },
    boot: { kind: "none" },
    determinism: { sourceDateEpoch: 1, guidSeed: "g", fsSeed: "f" },
    steps: [],
  });
  const error = await assertRejects(
    () => resolveRecipe(recipe, { resolver: new LocalInputResolver() }),
    InputResolutionError,
  );
  assertEquals(error.stepId, "recipe");
  assertEquals(error.field, "base.from");
  assertEquals(error.inputKind, "file");
});

Deno.test("streaming a file input's digest does not move its key", async () => {
  // `LocalInputResolver` now folds a file one 1 MiB block at a time instead of
  // reading it whole — a `kind: "image"` base is measured in GiB, and the old
  // path peaked at twice the file. The digest is the cache key's input, so a
  // value that moved would invalidate every cached layer in every store.
  await Deno.mkdir("tests/.tmp", { recursive: true });
  const dirPath = await Deno.makeTempDir({ dir: "tests/.tmp" });
  const path = `${dirPath}/base.img`;
  // Larger than the 1 MiB block, and deliberately not a multiple of it, so the
  // final short read is exercised rather than assumed.
  const bytes = new Uint8Array(1024 * 1024 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  await Deno.writeFile(path, bytes);
  try {
    const resolved = await new LocalInputResolver().resolve(file(path));
    assertEquals(resolved.sha256, await sha256Hex(bytes));
    assertEquals(resolved.sizeBytes, bytes.byteLength);
  } finally {
    await Deno.remove(dirPath, { recursive: true });
  }
});

// ──────────────────────────────────────────────────────── purity semantics ──

Deno.test("a network step is uncacheable, and so is everything after it", async () => {
  const planned = await planOf(
    rootedRecipe([
      { kind: "run", id: "offline", script: "echo a" },
      { kind: "run", id: "online", script: "apk add x", network: true },
      { kind: "run", id: "after", script: "echo b" },
    ]),
  );
  assertEquals(
    planned.steps.map((s) => [s.id, s.cacheable]),
    [
      ["base", true],
      ["table", true],
      ["table:mkfs", true],
      ["offline", true],
      // Declaring the network means the step is not a function of its declared
      // inputs — and neither is anything built on top of it.
      ["online", false],
      ["after", false],
    ],
  );
});

Deno.test("plan is deterministic: same input, same keys and geometry", async () => {
  const a = await planOf(baseRecipe());
  const b = await planOf(baseRecipe());
  assertEquals(a.outputRecipeKey, b.outputRecipeKey);
  assertEquals(a.layout, b.layout);
  assertEquals(a.explain(), b.explain());
});

Deno.test("the guest failure `build()` throws is catchable from both subpaths", () => {
  // Regression: there were once TWO classes named `GuestStepFailedError` — the
  // one `build()` threw, unexported, and one on `./system` that nothing ever
  // constructed. A consumer catching the exported one silently never matched,
  // and fell through to whatever generic handler followed. `.name` is equal on
  // any impostor, so `instanceof` against the real class is the only check.
  const outcome: StepOutcome = {
    code: 0,
    stage: "step",
    outputDigest: "",
    umountRc: 0,
    fsckRc: 1,
    dmesgErrors: 0,
    detail: "the root filesystem was left dirty",
  };
  const error = new GuestStepFailedError("root:mkfs", outcome, "boot log\n");

  assertStrictEquals(GuestStepFailedError, SystemGuestStepFailedError);
  assert(error instanceof SystemGuestStepFailedError);
  assertEquals(error.stepId, "root:mkfs");
  assertStrictEquals(error.outcome, outcome);
  // The dangerous shape: exit 0 over a filesystem that failed its checks. The
  // message has to say which of the four signals fired, or it reads as a pass.
  assert(
    error.message.includes("the step script succeeded but"),
    `spells out that the exit code alone looked fine:\n${error.message}`,
  );
  assert(
    error.message.includes("e2fsck -fn returned 1"),
    `names the signal that actually failed:\n${error.message}`,
  );
});

Deno.test("a guest failure names every signal that fired, not just the first", () => {
  // The four signals are independent, so a step can trip several at once. A
  // message that stops at the exit code makes the corruption underneath it
  // invisible until something downstream rediscovers it.
  const error = new GuestStepFailedError("root:mkfs", {
    code: 32,
    stage: "step",
    outputDigest: "",
    umountRc: 1,
    fsckRc: 4,
    dmesgErrors: 7,
    detail: "mkfs died mid-write",
  }, "boot log\n");
  for (
    const signal of [
      "exited 32",
      "an unmount under /mnt failed",
      "e2fsck -fn returned 4",
      "7 ext4/I/O error lines",
    ]
  ) {
    assert(
      error.message.includes(signal),
      `all four signals are reported, missing "${signal}":\n${error.message}`,
    );
  }
});

Deno.test("declaring a bigger base image reads as a grow, and says so", () => {
  // A recipe has no other way to ask for a grow, so this direction is the
  // request rather than a typo — and the message has to name what actually
  // stops it, which is the GPT and not qemu.
  const error = new BaseImageSizeMismatchError(
    "./alpine.qcow2",
    2 * 1024 ** 3,
    257_949_696,
  );
  assertStringIncludes(error.message, "asks to GROW");
  // `resize()` alone leaves the primary header naming the old final sector,
  // so the space it adds is outside every partitioner's usable range.
  assertStringIncludes(error.message, "repairGpt");
  assertStringIncludes(error.message, "LastUsableLBA");
  assertEquals(error.name, "BaseImageSizeMismatchError");
  assertEquals(error.declaredBytes, 2 * 1024 ** 3);
  assertEquals(error.actualBytes, 257_949_696);
});

Deno.test("declaring a smaller base image is a plain misreading", () => {
  const error = new BaseImageSizeMismatchError(
    "./alpine.qcow2",
    134_217_728,
    257_949_696,
  );
  // The other direction must NOT talk about growing, or the fix it names is
  // the wrong one.
  assert(!error.message.includes("GROW"));
  assertStringIncludes(error.message, "qemu-img info");
  // An image base is copied in whole and a partition step over one is
  // refused, so this number lays nothing out; it is purely the assertion.
  assertStringIncludes(error.message, "does not resize anything");
});

Deno.test("an image base carries no layout of its own", async () => {
  const recipe = defineRecipe({
    name: "cloud",
    platform: { arch: "aarch64", machine: "virt-11.0" },
    base: {
      kind: "image",
      from: file("./alpine.qcow2"),
      format: "qcow2",
      virtualSizeBytes: 257_949_696,
      rootPartition: 2,
    },
    boot: { kind: "none" },
    determinism: { sourceDateEpoch: 1, guidSeed: "g", fsSeed: "f" },
    steps: [{ kind: "copyIn", id: "app", from: dir("./app"), to: "/opt/app" }],
  });
  const resolved = await resolveRecipe(recipe, {
    resolver: new StubResolver({ "./app": [] }),
  });
  const planned = await plan(resolved, {
    appliance: { digest: "appliance", arch: "aarch64" },
  });
  assertEquals(planned.layout, undefined);
  assertEquals(planned.steps.map((s) => s.id), ["base", "app"]);
  assert(planned.requiresAppliance);
});

Deno.test("a partition step over an image base is refused", async () => {
  const recipe = defineRecipe({
    name: "cloud",
    platform: { arch: "aarch64", machine: "virt-11.0" },
    base: {
      kind: "image",
      from: file("./alpine.qcow2"),
      format: "qcow2",
      virtualSizeBytes: 257_949_696,
      rootPartition: 2,
    },
    boot: { kind: "none" },
    determinism: { sourceDateEpoch: 1, guidSeed: "g", fsSeed: "f" },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "root",
        type: "linux-root",
        size: "rest",
        contents: { kind: "ext4", label: "root" },
      }],
    }],
  });
  const resolved = await resolveRecipe(recipe, {
    resolver: new StubResolver(),
  });
  const error = await assertRejects(
    () =>
      plan(resolved, { appliance: { digest: "appliance", arch: "aarch64" } }),
    RecipePlanError,
  );
  // Laying a new GPT over the image's own would discard every partition in
  // it — including the one `rootPartition` names.
  assertStringIncludes(error.message, "discarding every partition");
});
