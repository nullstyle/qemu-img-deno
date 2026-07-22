import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { QemuImg } from "../../src/qemu_img.ts";
import { FakeQemuImg } from "../../testing/mod.ts";
import { build } from "../../src/recipe/build.ts";
import { plan, type PlanAppliance } from "../../src/recipe/plan.ts";
import { LayerStore } from "../../src/recipe/store.ts";
import { LocalInputResolver } from "../../src/recipe/resolve.ts";
import {
  BaseImageSizeMismatchError,
  GuestExecutorUnavailableError,
} from "../../src/recipe/errors.ts";
import { GuestStepFailedError } from "../../src/system/errors.ts";
import type {
  GuestRunner,
  GuestStepRequest,
  GuestStepResult,
  StepOutcome,
} from "../../src/system/mod.ts";
import type {
  Recipe,
  ResolvedEntry,
  ResolvedInput,
  ResolvedRecipe,
  Step,
} from "../../src/recipe/types.ts";
import { sha256Hex } from "../../src/digest.ts";
import { describeFat } from "../../src/fs/mod.ts";

/**
 * A scratch directory under the repo, since `deno task test` grants write
 * access to `tests/.tmp` and nowhere else. `makeTempDir` does not create
 * parents, and the directory is gitignored, so the `mkdir` is load-bearing on
 * a fresh clone.
 */
async function scratchDir(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

/** Room for an ESP plus a root partition. */
const DISK_BYTES = 64 * 1024 ** 2;
/**
 * The ESP window these tests declare.
 *
 * Any size that holds the tree will do, which is the point of 0.3.0: through
 * 0.2.1 this had to be exactly `VVFAT_USABLE_BYTES[12]` (32997888), vvfat's
 * fixed FAT12 geometry, and `plan()` refused every other value in both
 * directions.
 */
const FAT12_BYTES = 8 * 1024 ** 2;
const DETERMINISM = {
  sourceDateEpoch: 1_700_000_000,
  guidSeed: "guid-seed",
  fsSeed: "fs-seed",
} as const;
/** Stand-in appliance identity; plan() only ever folds its digest. */
const APPLIANCE: PlanAppliance = {
  digest: "ap".repeat(32),
  // plan() refuses an appliance whose arch disagrees with the recipe's, so
  // the stub has to name one rather than being a bare digest.
  arch: "aarch64",
};
/**
 * A REAL staging tree, resolved by the real resolver.
 *
 * It used to be the fictional path `/staging/esp` with hand-written digests,
 * which was fine while the fake qemu never opened it. It is not fine now:
 * `build()` re-walks a FAT staging tree and re-hashes every file against the
 * digest its cache key names, precisely so a tree edited between resolve and
 * build cannot publish under the old key. A fictional tree cannot exercise
 * that, and would only prove the check can be bypassed by not having a tree.
 */
const ESP_DIR = await (async () => {
  const dir = `${await scratchDir()}/esp`;
  await Deno.mkdir(`${dir}/EFI/BOOT`, { recursive: true });
  await Deno.writeTextFile(`${dir}/EFI/BOOT/BOOTAA64.EFI`, "MZ!\n");
  return dir;
})();

function dirInput(
  path: string,
  entries: readonly ResolvedEntry[],
): ResolvedInput {
  return {
    input: { kind: "dir", path },
    sha256: "e".repeat(64),
    sizeBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries,
    // Empty on purpose: a trait the destination cannot hold is a plan-time
    // refusal, and these tests are about build(), not about that refusal.
    traits: [],
  };
}

/** Resolved by `LocalInputResolver`, so the entries describe what is on disk. */
const ESP_INPUT: ResolvedInput = await new LocalInputResolver().resolve({
  kind: "dir",
  path: ESP_DIR,
});

/** A FAT partition the host writes, and optionally an ext4 one the guest makes. */
function partitionStep(withExt4: boolean): Step {
  return {
    kind: "partition",
    id: "table",
    partitions: [
      {
        label: "esp",
        type: "esp",
        size: FAT12_BYTES,
        contents: {
          kind: "fat",
          fatType: 12,
          label: "EFI",
          from: { kind: "dir", path: ESP_DIR },
        },
      },
      ...(withExt4
        ? [{
          label: "root",
          type: "linux-root" as const,
          size: "rest" as const,
          contents: { kind: "ext4" as const, label: "root" },
        }]
        : []),
    ],
  };
}

function blankRecipe(steps: readonly Step[]): Recipe {
  return {
    name: "fixture",
    platform: { arch: "aarch64" },
    base: { kind: "blank", sizeBytes: DISK_BYTES },
    boot: { kind: "none" },
    steps,
    determinism: DETERMINISM,
  };
}

function resolveOf(
  recipe: Recipe,
  extra: Readonly<Record<string, ResolvedInput>> = {},
): ResolvedRecipe {
  return { recipe, inputs: { [ESP_DIR]: ESP_INPUT, ...extra } };
}

interface Rig {
  readonly fake: FakeQemuImg;
  readonly qemu: QemuImg;
  readonly store: LayerStore;
  readonly root: string;
  readonly scratch: string;
  readonly output: string;
}

/**
 * A fake wired the way `build()` needs: it writes the images it creates,
 * because the store hashes a container file and `contentDigest()` opens a raw
 * one — and it refuses to invent what any of them hold.
 */
function rigOn(root: string, store = `${root}/store`): Rig {
  const fake = new FakeQemuImg();
  fake.materialize = true;
  fake.refuseContentOracles = true;
  // No hook for the FAT any more. Through 0.2.1 the filesystem came out of an
  // option-graph `vvfat` source the fake could not synthesize, so the rig had
  // to hand-write a minimal FAT12 image into the scratch file. build() now
  // produces the volume itself, in TypeScript, from a real staging tree — so
  // the bytes under test are the package's own.
  return {
    fake,
    qemu: new QemuImg({ runner: fake }),
    store: new LayerStore(store, { lockTimeoutMs: 2_000 }),
    root,
    scratch: `${root}/scratch`,
    output: `${root}/out.qcow2`,
  };
}

/** A `GuestRunner` that records its requests and reports what a test dictates. */
class FakeGuest implements GuestRunner {
  readonly requests: GuestStepRequest[] = [];
  readonly #reply: (request: GuestStepRequest) => Partial<StepOutcome>;

  constructor(
    reply: (request: GuestStepRequest) => Partial<StepOutcome> = () => ({}),
  ) {
    this.#reply = reply;
  }

  run(request: GuestStepRequest): Promise<GuestStepResult> {
    this.requests.push(request);
    const outcome: StepOutcome = {
      code: 0,
      stage: "step",
      outputDigest: "0".repeat(64),
      umountRc: 0,
      fsckRc: 0,
      dmesgErrors: 0,
      detail: "",
      ...this.#reply(request),
    };
    return Promise.resolve({
      outcome,
      console: "guest console\n",
      elapsedMs: 1,
    });
  }
}

Deno.test("the layer chain is created with relative backing refs to published parents", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(blankRecipe([partitionStep(false)]));
    const planned = await plan(resolved);
    assertEquals(planned.steps.map((step) => step.id), ["base", "table"]);

    const artifact = await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
    });

    assertEquals(rig.fake.creates.length, 2);
    const [base, child] = rig.fake.creates;
    assertEquals(base.format, "qcow2");
    assertEquals(base.sizeBytes, DISK_BYTES);
    assertEquals(base.backing, undefined, "the base layer backs onto nothing");

    // Relative, and one directory up: a `.partial` sibling and the published
    // directory it is renamed to sit at the same depth, so this one string has
    // to resolve before AND after the rename. An absolute path here would also
    // "work" — right up until the store is moved or copied.
    assertEquals(
      child.backing,
      `../${artifact.layers[0].realizationKey}/image.qcow2`,
    );
    assertEquals(child.backingFormat, "qcow2");
    assert(
      !(child.backing ?? "").includes(root),
      `a store path leaked into the image: ${child.backing}`,
    );
    // …and it resolves to the PUBLISHED parent, not to its `.partial`.
    assertEquals(child.backingPath, artifact.layers[0].path);
    assertEquals(
      child.path,
      `${rig.store.partialDir(artifact.layers[1].realizationKey)}/image.qcow2`,
    );

    assertEquals(artifact.layers.length, 2);
    assertEquals(
      artifact.layers[1].parentRealizationKey,
      artifact.layers[0].realizationKey,
    );
    assertEquals(
      artifact.layers[1].parentContentSha256,
      artifact.layers[0].contentSha256,
    );
    assertEquals(artifact.cacheHits, []);

    // The artifact is FLATTENED out of the store, so it stands alone.
    const last = rig.fake.converts[rig.fake.converts.length - 1];
    assertEquals(last.sources, [artifact.layers[1].path]);
    assertEquals(last.dest, rig.output);
    assertEquals(last.format, "qcow2");
    assertEquals(artifact.path, rig.output);
    assertEquals(
      artifact.realizationKey,
      artifact.layers[1].realizationKey,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the GPT and each FAT window are spliced without touching their neighbours", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(blankRecipe([partitionStep(false)]));
    const planned = await plan(resolved);
    await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
    });

    const windows = rig.fake.converts.filter((c) => c.destIsGraph === true);
    assertEquals(windows.length, 3, "primary GPT, backup GPT, one FAT");
    for (const write of windows) {
      assert(
        write.raw.args.includes("-n"),
        "a window write must be -n: without it qemu-img would CREATE the " +
          `node instead of writing into it — ${write.raw.args.join(" ")}`,
      );
    }
    // The backup header goes at the tail the planner derived, not at offset 0
    // and not off the front of a zero-sector disk.
    const partition = (planned.layout ?? [])[0];
    // The LAST `offset=` in each argv is the destination graph's.
    const offsets = windows.map((write) =>
      [...write.raw.args.join(" ").matchAll(/offset=(\d+)/g)].at(-1)?.[1]
    );
    assertEquals(offsets[0], "0");
    assertEquals(offsets[2], String(partition.offsetBytes));
    assert(
      Number(offsets[1]) > 0 && Number(offsets[1]) < DISK_BYTES,
      `backup GPT offset ${offsets[1]} is not inside the disk`,
    );
    // Nothing reads an option graph any more: through 0.2.1 the FAT came from
    // a `vvfat` source node opened at `offset=32256` to strip vvfat's own MBR,
    // landed in a scratch raw so its timestamps could be rewritten, and only
    // then reached the window. Now the only converts are the base image and
    // three window writes.
    assert(
      rig.fake.converts.every((c) =>
        c.sourceIsGraph !== true || c.destIsGraph === true
      ),
      "no convert reads an option graph: the FAT is bytes, not a driver",
    );
    assert(
      !rig.fake.converts.some((c) => c.raw.args.join(" ").includes("vvfat")),
      "qemu is never asked for vvfat",
    );
    const fatSource = windows[2].sources[0];
    assert(
      typeof fatSource === "string" && fatSource.startsWith(rig.scratch),
      `the FAT window is spliced from a file this package wrote into its own ` +
        `scratch directory (got ${JSON.stringify(fatSource)})`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an empty partition gets a table entry and no filesystem write", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(blankRecipe([{
      kind: "partition",
      id: "table",
      partitions: [
        {
          label: "esp",
          type: "esp",
          size: FAT12_BYTES,
          contents: {
            kind: "fat",
            fatType: 12,
            label: "EFI",
            from: { kind: "dir", path: ESP_DIR },
          },
        },
        {
          label: "reserved",
          type: "linux-generic",
          size: "rest",
          contents: { kind: "empty" },
        },
      ],
    }]));
    const planned = await plan(resolved);
    // Both partitions are the host's, and both are in the table.
    assertEquals(planned.steps[1].partitionIndices, [0, 1]);
    assertEquals((planned.layout ?? [])[1].filesystem, "empty");

    await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
    });

    // Two GPT halves and one FAT — nothing is written into the reserved
    // window. A filesystem synthesized there would overwrite whatever the
    // caller reserved it for.
    const windows = rig.fake.converts.filter((c) => c.destIsGraph === true);
    assertEquals(windows.length, 3);
    const reserved = (planned.layout ?? [])[1];
    for (const write of windows) {
      const dest = write.raw.args[write.raw.args.length - 1];
      assert(
        !dest.includes(`offset=${reserved.offsetBytes}`),
        `something wrote into the reserved partition: ${dest}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an image base is copied in whole, never referenced as a backing file", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const basePath = `${root}/cloud.img`;
    rig.fake.setImage(basePath, {
      format: "raw",
      virtualSizeBytes: DISK_BYTES,
      content: new TextEncoder().encode("cloud image bytes"),
    });
    const recipe: Recipe = {
      ...blankRecipe([]),
      base: {
        kind: "image",
        from: { kind: "file", path: basePath },
        format: "raw",
        virtualSizeBytes: DISK_BYTES,
        rootPartition: 2,
      },
    };
    const resolved = resolveOf(recipe);
    const planned = await plan(resolved);

    const artifact = await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
    });

    assertEquals(rig.fake.creates.length, 0, "an image base is converted in");
    const copy = rig.fake.converts[0];
    assertEquals(copy.sources, [basePath]);
    assertEquals(copy.sourceFormat, "raw");
    assertEquals(copy.format, "qcow2");
    // A backing reference here would bake an absolute host path into a store
    // layer and leave its content at the mercy of a file outside the store.
    for (const flag of ["-b", "-B", "--backing"]) {
      assert(
        !copy.raw.args.includes(flag),
        `the base was referenced with ${flag}: ${copy.raw.args.join(" ")}`,
      );
    }
    assertEquals(
      rig.fake.images.get(artifact.layers[0].path)?.backingFilename,
      undefined,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a step on an image base mounts the partition the recipe names", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const basePath = `${root}/cloud.img`;
    rig.fake.setImage(basePath, {
      format: "qcow2",
      virtualSizeBytes: DISK_BYTES,
      content: new TextEncoder().encode("cloud image bytes"),
    });
    const recipe: Recipe = {
      ...blankRecipe([{ kind: "run", id: "setup", script: "echo hi\n" }]),
      base: {
        kind: "image",
        from: { kind: "file", path: basePath },
        format: "qcow2",
        virtualSizeBytes: DISK_BYTES,
        // Read off the image, not guessed. There is no declared layout to
        // infer it from, and guessing produces something that mounts, is
        // populated, and is the wrong partition.
        rootPartition: 3,
      },
    };
    const resolved = resolveOf(recipe);
    const planned = await plan(resolved, { appliance: APPLIANCE });
    const guest = new FakeGuest();
    await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
      guest,
    });

    assertEquals(guest.requests.length, 1);
    assertStringIncludes(
      guest.requests[0].script,
      'qi_mount_root "${QI_TARGET}3" 3',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a base image's virtual size is checked before anything is converted", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const basePath = `${root}/cloud.img`;
    // What the file actually holds…
    rig.fake.setImage(basePath, {
      format: "raw",
      virtualSizeBytes: DISK_BYTES,
      content: new Uint8Array(),
    });
    const recipe: Recipe = {
      ...blankRecipe([]),
      base: {
        kind: "image",
        from: { kind: "file", path: basePath },
        format: "raw",
        // …against what the recipe was written for.
        virtualSizeBytes: DISK_BYTES * 2,
        rootPartition: 2,
      },
    };
    const resolved = resolveOf(recipe);
    const planned = await plan(resolved);

    const error = await assertRejects(
      () =>
        build(planned, resolved, {
          store: rig.store,
          output: rig.output,
          qemu: rig.qemu,
          scratch: rig.scratch,
        }),
      BaseImageSizeMismatchError,
    );
    assertEquals(error.declaredBytes, DISK_BYTES * 2);
    assertEquals(error.actualBytes, DISK_BYTES);
    assertStringIncludes(error.message, "asks to GROW");

    // The check has to come FIRST. A convert that ran anyway would leave a
    // layer holding a base the recipe's geometry does not describe.
    assertEquals(rig.fake.converts, []);
    assertEquals(rig.fake.commandLines(), [
      `qemu-img info -f raw --output=json ${basePath}`,
    ]);
    assertEquals(await rig.store.list(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a base whose virtual size qemu-img cannot report is refused, not accepted", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const basePath = `${root}/cloud.img`;
    // No virtualSizeBytes: `info` then omits `virtual-size` entirely, which is
    // what a wrong `-f` produces against a real binary.
    rig.fake.setImage(basePath, { format: "raw", content: new Uint8Array() });
    const recipe: Recipe = {
      ...blankRecipe([]),
      base: {
        kind: "image",
        from: { kind: "file", path: basePath },
        format: "raw",
        virtualSizeBytes: DISK_BYTES,
        rootPartition: 2,
      },
    };
    const resolved = resolveOf(recipe);
    const planned = await plan(resolved);

    const error = await assertRejects(
      () =>
        build(planned, resolved, {
          store: rig.store,
          output: rig.output,
          qemu: rig.qemu,
          scratch: rig.scratch,
        }),
      Error,
      "reported no virtual size",
    );
    // "unknown" must not read as "matches" — that is the silent-acceptance
    // shape this package refuses everywhere else.
    assertStringIncludes(error.message, "refused rather than accepted");
    assertEquals(rig.fake.converts, []);
    assertEquals(await rig.store.list(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a second build of the same plan is all cache hits and no work", async () => {
  const root = await scratchDir();
  try {
    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "run",
        id: "setup",
        script: "echo configuring\n",
      }]),
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });
    assertEquals(planned.steps.map((step) => step.id), [
      "base",
      "table",
      "table:mkfs",
      "setup",
    ]);

    const first = rigOn(root);
    const firstGuest = new FakeGuest();
    const before = await build(planned, resolved, {
      store: first.store,
      output: first.output,
      qemu: first.qemu,
      scratch: first.scratch,
      guest: firstGuest,
    });
    assertEquals(before.cacheHits, [], "a cold store hits nothing");
    assertEquals(firstGuest.requests.length, 2);

    // Same store, a fresh fake and a fresh runner: everything must come off
    // disk, which is the point of the store being content-addressed.
    const second = rigOn(root, `${root}/store`);
    const secondGuest = new FakeGuest();
    const after = await build(planned, resolved, {
      store: second.store,
      output: `${root}/out2.qcow2`,
      qemu: second.qemu,
      scratch: `${root}/scratch2`,
      guest: secondGuest,
    });

    // `cacheHits` holds REALIZATION KEYS, not step ids. The distinction is the
    // whole point of the rename: the natural read —
    // `layers.filter((l) => cacheHits.includes(l.realizationKey))` — silently
    // returned [] forever while this field held ids.
    assertEquals(
      after.cacheHits,
      after.layers.map((layer) => layer.realizationKey),
      "every layer was served from cache, by key",
    );
    assertEquals(after.cacheHits.length, planned.steps.length);
    assertEquals(after.realizationKey, before.realizationKey);
    assertEquals(
      after.layers.map((layer) => layer.contentSha256),
      before.layers.map((layer) => layer.contentSha256),
    );
    assertEquals(secondGuest.requests, [], "no VM boots for a cached layer");
    assertEquals(second.fake.creates, []);
    // The only work left is flattening the final layer into the artifact.
    assertEquals(second.fake.commandLines(), [
      `qemu-img convert -m 1 -O qcow2 ${
        after.layers[3].path
      } ${root}/out2.qcow2`,
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("guest steps dispatch to the runner with this layer's own .partial overlay", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "run",
        id: "setup",
        script: "echo configuring\n",
      }]),
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });
    const guest = new FakeGuest();
    const artifact = await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
      guest,
    });

    assertEquals(guest.requests.map((r) => r.stepId), ["table:mkfs", "setup"]);
    const published = new Set(artifact.layers.map((layer) => layer.path));
    for (const [index, request] of guest.requests.entries()) {
      const layer = artifact.layers[index + 2];
      // The layer's OWN in-flight overlay, opened read-write. Handing the
      // guest a published parent would have qemu open that read-write too, and
      // every descendant already cached against it would then read different
      // bytes — with `qemu-img check` still clean.
      assertEquals(
        request.imagePath,
        `${rig.store.partialDir(layer.realizationKey)}/image.qcow2`,
      );
      assertEquals(
        request.scratchDir,
        rig.store.partialDir(layer.realizationKey),
      );
      assert(
        !published.has(request.imagePath),
        `the guest was handed a published layer: ${request.imagePath}`,
      );
      assertEquals(request.nonce.length, 32);
      assertEquals(request.network, undefined);
    }
    assertNotEquals(guest.requests[0].nonce, guest.requests[1].nonce);

    // The root partition is the ext4 one the planner laid out — index 1, so
    // partition 2. Guessing it produces something that mounts and is wrong.
    assertStringIncludes(guest.requests[0].script, "mke2fs -t ext4");
    assertStringIncludes(guest.requests[0].script, "-L 'root'");
    // The guest re-checks the window against the plan's own geometry, in the
    // 512-byte units sysfs always reports — not the 4096 a `sectorSize: 4096`
    // recipe would lay out in.
    const ext4 = (planned.layout ?? [])[1];
    assertStringIncludes(
      guest.requests[0].script,
      `qi_part "\${QI_TARGET}2" "\${QI_NAME}2" ${ext4.firstLba} ${
        ext4.lengthBytes / 512
      }`,
    );
    assertStringIncludes(
      guest.requests[1].script,
      'qi_mount_root "${QI_TARGET}2" 2',
    );
    assertStringIncludes(guest.requests[1].script, "echo configuring");
    assertEquals(guest.requests[1].data, undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** Build the standard 4-layer plan with a guest whose mkfs step reports `bad`. */
async function mkfsReporting(
  root: string,
  bad: Partial<StepOutcome>,
): Promise<{ rig: Rig; error: GuestStepFailedError; failedKey: string }> {
  const rig = rigOn(root);
  const resolved = resolveOf(blankRecipe([partitionStep(true)]));
  const planned = await plan(resolved, { appliance: APPLIANCE });
  const guest = new FakeGuest(() => bad);
  const error = await assertRejects(
    () =>
      build(planned, resolved, {
        store: rig.store,
        output: rig.output,
        qemu: rig.qemu,
        scratch: rig.scratch,
        guest,
      }),
    GuestStepFailedError,
  );
  // The mkfs layer's realization key: everything before it published, so its
  // parent is the last layer in the store.
  const stored = await rig.store.list();
  assertEquals(stored.length, 2, "base and table published before the failure");
  const failed = planned.steps[2];
  assertEquals(failed.id, "table:mkfs");
  const partials = [...Deno.readDirSync(`${rig.store.root}/layers`)]
    .filter((entry) => entry.name.endsWith(".partial"));
  assertEquals(partials, [], "a failed layer leaves no .partial behind");
  return { rig, error, failedKey: failed.recipeKey };
}

Deno.test("a guest step that exits 0 but fails e2fsck fails the layer", async () => {
  const root = await scratchDir();
  try {
    const { error } = await mkfsReporting(root, { code: 0, fsckRc: 4 });
    assertEquals(error.stepId, "table:mkfs");
    assertEquals(error.outcome.code, 0);
    // The dangerous shape, and it has to be named as such: the script
    // succeeded and the filesystem it produced is not sound.
    assertStringIncludes(error.message, "the step script succeeded but");
    assertStringIncludes(error.message, "e2fsck -fn returned 4");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a guest step that exits 0 but fails to unmount fails the layer", async () => {
  const root = await scratchDir();
  try {
    const { error } = await mkfsReporting(root, { code: 0, umountRc: 1 });
    assertEquals(error.outcome.umountRc, 1);
    assertStringIncludes(error.message, "the step script succeeded but");
    assertStringIncludes(error.message, "writeback did not complete");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a guest step that exits 0 over kernel I/O errors fails the layer", async () => {
  const root = await scratchDir();
  try {
    const { error } = await mkfsReporting(root, { code: 0, dmesgErrors: 3 });
    assertEquals(error.outcome.dmesgErrors, 3);
    assertStringIncludes(error.message, "the step script succeeded but");
    assertStringIncludes(error.message, "logged 3 ext4/I/O error lines");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a failed layer publishes nothing and frees the key it was holding", async () => {
  const root = await scratchDir();
  try {
    const { rig } = await mkfsReporting(root, { code: 0, fsckRc: 4 });
    const published = new Set(
      (await rig.store.list()).map((layer) => layer.realizationKey),
    );
    assertEquals(published.size, 2);

    // The lock has to be released too, or the retry every user reaches for
    // next blocks for `lockTimeoutMs` and then reports contention.
    const retry = "retry" as unknown as Parameters<typeof rig.store.begin>[0];
    const dir = await rig.store.begin(retry);
    assertStringIncludes(dir, ".partial");
    await rig.store.abandon(retry);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("build emits no flag that would silently discard or fabricate data", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "run",
        id: "setup",
        script: "echo hi\n",
      }]),
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });
    await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
      guest: new FakeGuest(),
    });

    const argv = rig.fake.calls.flatMap((call) => call.args);
    assert(argv.length > 20, `nothing was recorded to check: ${argv.length}`);
    assertEquals(
      rig.fake.calls.filter((call) => call.args[0] === "create").length,
      4,
      "one create per layer: base, table, table:mkfs, setup",
    );
    for (
      const forbidden of [
        // Would discard the guest's writes, which are the layer.
        "-snapshot",
        // Turns a read error into a zero-filled region, exit 0.
        "--salvage",
        // Skips opening the backing file, so a wrong relative path is accepted.
        "-u",
        "--backing-unsafe",
        // Claims a target already reads as zeros without checking.
        "--target-is-zero",
      ]
    ) {
      assert(
        !argv.includes(forbidden),
        `build() emitted ${forbidden}: ${rig.fake.commandLines().join("\n")}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("layers before an unavailable guest step still build, publish and cache", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const resolved = resolveOf(blankRecipe([partitionStep(true)]));
    const planned = await plan(resolved, { appliance: APPLIANCE });

    const error = await assertRejects(
      () =>
        build(planned, resolved, {
          store: rig.store,
          output: rig.output,
          qemu: rig.qemu,
          scratch: rig.scratch,
        }),
      GuestExecutorUnavailableError,
    );
    assertEquals(error.stepId, "table:mkfs");
    assertStringIncludes(error.message, "needs a Linux kernel");

    // Refused, not skipped — and the two host-side layers are still there, so
    // a machine with no appliance gets a correct partial chain rather than
    // nothing.
    const stored = await rig.store.list();
    assertEquals(stored.length, 2);
    // By predicate, not by index: `list()` walks the store's own directory
    // order, which follows the keys and moves whenever a layer's bytes do.
    assertEquals(
      stored.filter((layer) => layer.parentRealizationKey === undefined).length,
      1,
      "exactly one of the two is the base, and the other backs onto it",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a different guest result rekeys every descendant", async () => {
  const root = await scratchDir();
  try {
    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "run",
        id: "setup",
        script: "echo hi\n",
      }]),
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });

    const run = async (marker: string, name: string) => {
      const rig = rigOn(root, `${root}/${name}`);
      const guest = new FakeGuest((request) => {
        // The guest wrote into its overlay. Declared, not invented: the fake
        // models no filesystem, and this is the test saying what came out.
        if (request.stepId === "table:mkfs") {
          rig.fake.setImage(request.imagePath, {
            content: new TextEncoder().encode(marker),
          });
        }
        return {};
      });
      return await build(planned, resolved, {
        store: rig.store,
        output: `${root}/${name}.qcow2`,
        qemu: rig.qemu,
        scratch: `${root}/${name}-scratch`,
        guest,
      });
    };

    const a = await run("filesystem A", "a");
    const b = await run("filesystem B", "b");

    // Same intention, so the mkfs layer's own key is identical…
    assertEquals(a.layers[2].realizationKey, b.layers[2].realizationKey);
    // …but it realized different content…
    assertNotEquals(a.layers[2].contentSha256, b.layers[2].contentSha256);
    // …so its child must be a different layer. Without the parent's CONTENT
    // in the child's key, `setup` would be a cache hit whose overlay is a
    // block-level delta against clusters that are no longer there: an image
    // that mounts, that `qemu-img check` calls clean, and that is corrupt.
    assertNotEquals(a.layers[3].realizationKey, b.layers[3].realizationKey);
    assertEquals(a.layers[3].parentContentSha256, a.layers[2].contentSha256);
    assertEquals(b.layers[3].parentContentSha256, b.layers[2].contentSha256);
    // The layers below the change are untouched.
    assertEquals(a.layers[1].realizationKey, b.layers[1].realizationKey);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/**
 * Stage a real tree and resolve it, recording each file's digest.
 *
 * A value that starts with `->` declares a symlink to what follows, and one
 * that is `null` declares a directory; neither has bytes on disk, because
 * `tarOf()` reads only regular files.
 */
async function stagedTree(
  path: string,
  files: Readonly<Record<string, string | null>>,
): Promise<ResolvedInput> {
  await Deno.mkdir(path, { recursive: true });
  const entries: ResolvedEntry[] = [];
  for (const [name, body] of Object.entries(files)) {
    if (body === null) {
      await Deno.mkdir(`${path}/${name}`, { recursive: true });
      entries.push({ path: name, type: "dir", mode: 0o755, sizeBytes: 0 });
      continue;
    }
    if (body.startsWith("->")) {
      entries.push({
        path: name,
        type: "symlink",
        mode: 0o777,
        sizeBytes: 0,
        linkTarget: body.slice(2),
      });
      continue;
    }
    const bytes = new TextEncoder().encode(body);
    await Deno.writeFile(`${path}/${name}`, bytes);
    entries.push({
      path: name,
      type: "file",
      mode: 0o644,
      sizeBytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
  }
  return dirInput(path, entries);
}

Deno.test("copyIn delivers the staged tree as a ustar blob on the data disk", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const tree = `${root}/payload`;
    const input = await stagedTree(tree, {
      "hello.txt": "hello world\n",
      "share": null,
      "current": "->hello.txt",
    });
    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "copyIn",
        id: "stage",
        from: { kind: "dir", path: tree },
        to: "/opt/app",
      }]),
      { [tree]: input },
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });
    const guest = new FakeGuest();
    await build(planned, resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
      guest,
    });

    const data = guest.requests[1].data;
    assert(data !== undefined, "copyIn must attach a data disk");
    assertEquals(data.byteLength % 512, 0);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    assertStringIncludes(text, "hello.txt");
    assertStringIncludes(text, "hello world");
    // Directories and symlinks travel too. Dropping them yields an archive
    // that extracts cleanly and is missing structure nobody would look for.
    assertStringIncludes(text, "share/");
    assertStringIncludes(text, "current");
    // ustar magic lives at offset 257 of the header block.
    assertEquals(new TextDecoder().decode(data.subarray(257, 262)), "ustar");
    assertStringIncludes(guest.requests[1].script, "/mnt/root/opt/app");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("copyIn refuses a tree edited between resolving and building", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    const tree = `${root}/payload`;
    const input = await stagedTree(tree, { "hello.txt": "hello world\n" });
    // Edited after the resolver recorded its digest. The layer's key names the
    // RECORDED content, so publishing this would cache the wrong bytes under
    // it — and every later build would serve them.
    await Deno.writeTextFile(`${tree}/hello.txt`, "goodbye world\n");

    const resolved = resolveOf(
      blankRecipe([partitionStep(true), {
        kind: "copyIn",
        id: "stage",
        from: { kind: "dir", path: tree },
        to: "/opt/app",
      }]),
      { [tree]: input },
    );
    const planned = await plan(resolved, { appliance: APPLIANCE });
    const guest = new FakeGuest();

    const error = await assertRejects(
      () =>
        build(planned, resolved, {
          store: rig.store,
          output: rig.output,
          qemu: rig.qemu,
          scratch: rig.scratch,
          guest,
        }),
      Error,
      "changed between resolving this recipe and building it",
    );
    assertStringIncludes(error.message, "hello.txt");
    assertEquals(guest.requests.length, 1, "only the mkfs step ever ran");
    assertEquals((await rig.store.list()).length, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the FAT spliced into the window is a real volume, timestamps pinned", async () => {
  const root = await scratchDir();
  try {
    const rig = rigOn(root);
    // Snapshot the file at the moment build() splices it into the window,
    // before the scratch file is removed.
    let spliced: Uint8Array | undefined;
    rig.fake.onConvert = (convert) => {
      if (convert.destIsGraph === true && convert.sourceIsGraph !== true) {
        const source = convert.sources[0];
        const bytes = Deno.readFileSync(source);
        // The GPT halves go through the same call; the FAT one is the only
        // source the size of the partition.
        if (bytes.byteLength === FAT12_BYTES) spliced = bytes;
      }
      return undefined;
    };
    const resolved = resolveOf(blankRecipe([partitionStep(false)]));
    await build(await plan(resolved, { appliance: APPLIANCE }), resolved, {
      store: rig.store,
      output: rig.output,
      qemu: rig.qemu,
      scratch: rig.scratch,
    });

    assert(spliced !== undefined, "the FAT window was spliced from a file");
    // The WHOLE window, because on a qcow2 overlay an unwritten cluster reads
    // through to the backing file.
    assertEquals(spliced.byteLength, FAT12_BYTES);
    const geometry = describeFat(spliced);
    assertEquals(geometry.fatType, 12, "the type the BPB actually implies");
    assertEquals(geometry.reservedSectors, 1, "the spec's BPB_RsvdSecCnt");

    // Walk the root directory and find the staged file, by the name it was
    // staged under rather than by a fixed offset.
    const rootAt = (geometry.reservedSectors +
      geometry.numFats * geometry.fatSectors) * 512;
    const view = new DataView(spliced.buffer, spliced.byteOffset);
    const decoder = new TextDecoder();
    let efi: number | undefined;
    for (
      let at = rootAt;
      at < rootAt + geometry.rootEntryCount * 32;
      at += 32
    ) {
      if (decoder.decode(spliced.subarray(at, at + 11)) === "EFI        ") {
        efi = at;
        break;
      }
    }
    assert(efi !== undefined, "the EFI directory is in the root");
    // sourceDateEpoch 1700000000 in FAT's packed form, in every time field.
    // Through 0.2.1 the created and written times came from two different
    // places — vvfat read the host's `st_ctime` for one of them, which no
    // userspace call can pin — and closing the gap took a staging copy plus a
    // post-hoc rewrite of the finished filesystem.
    assertEquals(view.getUint16(efi + 14, true), 0xb1aa, "DIR_CrtTime");
    assertEquals(view.getUint16(efi + 16, true), 0x576e, "DIR_CrtDate");
    assertEquals(view.getUint16(efi + 18, true), 0x576e, "DIR_LstAccDate");
    assertEquals(view.getUint16(efi + 22, true), 0xb1aa, "DIR_WrtTime");
    assertEquals(view.getUint16(efi + 24, true), 0x576e, "DIR_WrtDate");
    assertEquals(spliced[efi + 13], 0, "DIR_CrtTimeTenth");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
