import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  canonicalJson,
  defineRecipe,
  dir,
  file,
  GuestStepFailedError,
  type Input,
  type InputResolver,
  plan,
  type PlanOptions,
  realizationKey,
  type Recipe,
  type RecipeKey,
  RecipePlanError,
  type ResolvedEntry,
  type ResolvedInput,
  resolveRecipe,
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
 * the planner only ever reads its digest — so the tests need no appliance on
 * disk, and the digest's effect on keys stays directly assertable.
 */
const STUB_APPLIANCE = { digest: "stub-appliance-digest" };

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
    appliance: { digest: "appliance-a" },
  });
  const withB = await planOf(ext4Recipe(), {}, {
    appliance: { digest: "appliance-b" },
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
