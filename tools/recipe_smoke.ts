/**
 * Real-binary smoke for `./recipe`: builds a GPT + FAT ESP image end to end
 * and validates it against implementations that share no code with qemu.
 *
 *     deno task smoke:recipe
 *
 * The oracles matter more than the assertions. A self-round-trip through qemu
 * would confirm only that we can read back what we wrote; macOS's `fsck_msdos`
 * and `diskutil` are independent parsers, so agreement is evidence.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import {
  build,
  contentDigest,
  defineRecipe,
  dir,
  LayerIntegrityError,
  LayerStore,
  LocalInputResolver,
  plan,
  type Recipe,
  resolveRecipe,
  sha256Hex,
} from "../src/recipe/mod.ts";
import { describeFat } from "../src/fs/mod.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${label}`);
    Deno.exit(1);
  }
}

async function sh(bin: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
}

const qemu = new QemuImg();
if (!(await qemu.available())) {
  skip("qemu-img not installed (brew install qemu) — smoke skipped");
  Deno.exit(0);
}

const work = await Deno.makeTempDir({ prefix: "qemu-img-recipe-smoke-" });

/**
 * A 33 MiB ESP on a 48 MiB disk.
 *
 * This is the headline of 0.3.0 and it is worth stating as a number: through
 * 0.2.1 the FAT filesystem came from qemu's `vvfat`, whose geometry is fixed
 * and content-independent, so the smallest ESP this package could build was
 * 528450048 bytes — 504 MiB to carry the 22-byte loader below. `plan()`
 * refused every other size, in both directions.
 */
const ESP_BYTES = 33 * 1024 * 1024;
const DISK_BYTES = 48 * 1024 * 1024;

/** The size vvfat forced on every FAT16 ESP through 0.2.1. */
const OLD_VVFAT_FAT16_BYTES = 528_450_048;

/** The staged ESP contents, by path, so the mount check can compare them. */
const ESP_FILES: Readonly<Record<string, string>> = {
  "EFI/BOOT/BOOTAA64.EFI": "MZ not-a-real-binary\n",
  // Lowercase, so it cannot be an 8.3 name and needs a long-name run to come
  // back spelled the way it was staged. A firmware reading GRUB.CFG instead is
  // a boot that silently uses no configuration.
  "EFI/BOOT/grub.cfg": "set timeout=0\n",
  // Longer than 8.3 can express at all: five long-name entries.
  "a file with a very long name indeed.config": "long name payload\n",
  "README.TXT": "built by @nullstyle/qemu-img\n",
};

/** Stage the ESP tree under `root`. */
async function stageEsp(root: string): Promise<void> {
  for (const [path, body] of Object.entries(ESP_FILES)) {
    const at = `${root}/${path}`;
    const slash = at.lastIndexOf("/");
    await Deno.mkdir(at.slice(0, slash), { recursive: true });
    await Deno.writeTextFile(at, body);
  }
}

/** One ESP recipe, at whatever window size is asked for. */
function espRecipe(
  staging: string,
  espBytes: number,
  diskBytes: number,
  fatType: 12 | 16 | 32,
): Recipe {
  return defineRecipe({
    name: "smoke-appliance",
    platform: { arch: "aarch64", machine: "virt-11.0" },
    base: {
      kind: "blank",
      sizeBytes: diskBytes,
      options: { cluster_size: 65536 },
    },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: "smoke/v1",
      fsSeed: "smoke/v1",
    },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "EFI",
        type: "esp",
        size: espBytes,
        contents: { kind: "fat", fatType, label: "EFI", from: dir(staging) },
      }],
    }],
  });
}

try {
  step("stage an ESP tree with the EFI removable-media fallback");
  const staging = `${work}/esp`;
  await stageEsp(staging);

  const recipe = espRecipe(staging, ESP_BYTES, DISK_BYTES, 16);

  step("plan (pure: no binary, no VM, no clock)");
  const resolved = await resolveRecipe(recipe, {
    resolver: new LocalInputResolver(),
  });
  const planned = await plan(resolved);
  assert(planned.requiresAppliance === false, "GPT + FAT need no appliance");
  assert(planned.layout?.length === 1, "one partition planned");
  const esp = planned.layout![0];
  assert(esp.firstLba === 2048, `ESP at LBA 2048 (got ${esp.firstLba})`);
  pass(`planned: ${planned.outputRecipeKey.slice(0, 16)}…`);

  step("build");
  const store = new LayerStore(`${work}/cache`);
  const output = `${work}/appliance.qcow2`;
  const started = Date.now();
  const artifact = await build(planned, resolved, { store, output, qemu });
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  assert(artifact.cacheHits.length === 0, "cold cache: no hits");
  pass(`built ${output} in ${elapsed}s (${artifact.layers.length} layers)`);

  step("allocation lands exactly where the plan said");
  const extents = (await qemu.map(output)).filter((extent) => extent.data);
  assert(extents.length > 0, "something was written");
  const gptWritten = extents.some((extent) => extent.start === 0);
  const espWritten = extents.some((extent) => extent.start === esp.offsetBytes);
  assert(gptWritten, "the GPT was written at offset 0");
  assert(espWritten, `the ESP was written at ${esp.offsetBytes}`);
  pass(`${extents.length} allocated extents, at the planned offsets`);

  step("the ESP is the size the recipe asked for, not a driver's fixed one");
  assert(
    esp.lengthBytes === ESP_BYTES,
    `ESP is ${ESP_BYTES} bytes (got ${esp.lengthBytes})`,
  );
  assert(
    esp.lengthBytes < OLD_VVFAT_FAT16_BYTES,
    "…and smaller than vvfat's fixed FAT16 window, which is the point",
  );
  const espRaw = `${work}/esp.fat`;
  await qemu.convert(
    {
      imageOpts: {
        driver: "raw",
        offset: esp.offsetBytes,
        size: esp.lengthBytes,
        file: { driver: "qcow2", file: { driver: "file", filename: output } },
      },
    },
    espRaw,
    { format: "raw", parallel: 1 },
  );
  const geometry = describeFat(await Deno.readFile(espRaw));
  assert(
    geometry.fatType === 16,
    `the BPB-derived type is FAT16 (got FAT${geometry.fatType})`,
  );
  pass(
    `${esp.lengthBytes}-byte ESP: FAT${geometry.fatType}, ` +
      `${geometry.clusterCount} clusters of ` +
      `${geometry.sectorsPerCluster * 512} bytes ` +
      `(vvfat would have forced ${OLD_VVFAT_FAT16_BYTES})`,
  );

  step("fsck_msdos validates the FAT (an independent implementation)");
  const fsck = await sh("/sbin/fsck_msdos", ["-n", espRaw]).catch(() => "");
  if (fsck === "") {
    console.log("  · fsck_msdos unavailable (not macOS) — skipped");
  } else {
    assert(fsck.includes("Phase 1"), `fsck_msdos ran:\n${fsck}`);
    assert(!/BOGUS|Invalid|error/i.test(fsck), `fsck_msdos is clean:\n${fsck}`);
    pass("fsck_msdos clean");
  }

  step("Apple's msdos DRIVER mounts it and hands back every file");
  // fsck checks structure; only a mount proves a reader recovers the names and
  // the bytes. Mounting MODIFIES the image (macOS writes .fseventsd into it),
  // so this runs after every byte-level check above and on its own copy.
  const mountable = `${work}/esp-mount.fat`;
  await Deno.copyFile(espRaw, mountable);
  const attachOut = await sh("hdiutil", [
    "attach",
    "-imagekey",
    "diskimage-class=CRawDiskImage",
    "-plist",
    mountable,
  ]).catch(() => "");
  const field = (key: string) => {
    const at = attachOut.indexOf(`<key>${key}</key>`);
    return at < 0
      ? undefined
      : /<string>([^<]*)<\/string>/.exec(attachOut.slice(at))?.[1];
  };
  const espDevice = field("dev-entry");
  const espMount = field("mount-point");
  if (espDevice === undefined || espMount === undefined) {
    console.log("  · hdiutil unavailable — mount check skipped");
  } else {
    try {
      const info = await sh("diskutil", ["info", espDevice]);
      const personality = /File System Personality:\s*(.+)/.exec(info)?.[1]
        .trim();
      assert(
        personality === "MS-DOS FAT16",
        `diskutil calls it MS-DOS FAT16 (it says ${
          JSON.stringify(personality)
        })`,
      );
      const volume = /Volume Name:\s*(.+)/.exec(info)?.[1].trim();
      assert(
        volume === "EFI",
        `the volume label reads back as EFI (${volume})`,
      );
      for (const [path, want] of Object.entries(ESP_FILES)) {
        const got = await Deno.readTextFile(`${espMount}/${path}`);
        assert(
          got === want,
          `${path} reads back byte-identical (got ${JSON.stringify(got)})`,
        );
      }
      // Nesting, and nothing the tree did not declare.
      const boot = [...Deno.readDirSync(`${espMount}/EFI/BOOT`)]
        .map((e) => e.name).sort();
      assert(
        boot.join(",") === "BOOTAA64.EFI,grub.cfg",
        `EFI/BOOT holds exactly what was staged (found ${boot.join(", ")})`,
      );
      pass(
        `mounted at ${espMount}: label, nesting, long names and every body ` +
          "came back intact",
      );
    } finally {
      // Detach ONLY the device this smoke attached.
      await sh("hdiutil", ["detach", espDevice, "-force"]);
    }
  }

  step("diskutil parses the GPT (Apple's parser, no qemu code in it)");
  const raw = `${work}/appliance.raw`;
  await qemu.convert(output, raw, { format: "raw", parallel: 1 });
  const attached = await sh("hdiutil", [
    "attach",
    "-nomount",
    "-imagekey",
    "diskimage-class=CRawDiskImage",
    raw,
  ]).catch(() => "");
  const device = /^(\/dev\/disk\d+)/m.exec(attached)?.[1];
  if (device === undefined) {
    console.log("  · hdiutil unavailable — GPT parser check skipped");
  } else {
    try {
      const list = await sh("diskutil", ["list", device]);
      assert(/EFI/.test(list), `diskutil sees the ESP:\n${list}`);
      assert(
        /GUID_partition_scheme/.test(list),
        `diskutil sees a GPT:\n${list}`,
      );
      pass("diskutil parsed the GPT and named the ESP");
    } finally {
      // Detach ONLY the device this smoke attached.
      await sh("hdiutil", ["detach", device, "-force"]);
    }
  }

  step("two COLD builds of the same recipe produce identical ESP bytes");
  // Determinism where it is hardest to get: the FAT volume itself. Every
  // timestamp comes from `determinism.sourceDateEpoch` and the volume id from
  // `fsSeed`, so a second build from an empty store — no cache hit anywhere,
  // a different wall clock, a different scratch directory — must reproduce the
  // filesystem byte for byte. Through 0.2.1 this needed a whole staging copy
  // to pin mtime/atime plus a post-hoc rewrite of the creation fields, because
  // vvfat read the host clock; before that rewrite, two cold builds seconds
  // apart published 8 differing bytes under ONE realization key.
  const coldStore = new LayerStore(`${work}/cache-cold`);
  const coldOut = `${work}/cold.qcow2`;
  await build(planned, resolved, { store: coldStore, output: coldOut, qemu });
  const coldEsp = `${work}/esp-cold.fat`;
  await qemu.convert(
    {
      imageOpts: {
        driver: "raw",
        offset: esp.offsetBytes,
        size: esp.lengthBytes,
        file: { driver: "qcow2", file: { driver: "file", filename: coldOut } },
      },
    },
    coldEsp,
    { format: "raw", parallel: 1 },
  );
  const firstDigest = await sha256Hex(await Deno.readFile(espRaw));
  const coldDigest = await sha256Hex(await Deno.readFile(coldEsp));
  assert(
    firstDigest === coldDigest,
    `two cold builds produce the same ESP\n  ${firstDigest}\n  ${coldDigest}`,
  );
  pass(`both cold builds: sha256 ${coldDigest.slice(0, 16)}…`);

  step("the window vvfat used to force still builds, and so does FAT32");
  // Nothing special about 528450048 any more — it is just a large partition.
  // Built once each, checked with fsck_msdos, and not mounted: the point is
  // that the size is now a choice rather than a constraint.
  for (
    const [label, espBytes, diskBytes, fatType] of [
      [
        "vvfat's old FAT16 window",
        OLD_VVFAT_FAT16_BYTES,
        700 * 1024 * 1024,
        16,
      ],
      [
        "FAT32, refused outright through 0.2.1",
        64 * 1024 * 1024,
        96 * 1024 * 1024,
        32,
      ],
      ["FAT12, at 8 MiB", 8 * 1024 * 1024, 16 * 1024 * 1024, 12],
    ] as const
  ) {
    const other = espRecipe(staging, espBytes, diskBytes, fatType);
    const otherResolved = await resolveRecipe(other, {
      resolver: new LocalInputResolver(),
    });
    const otherPlanned = await plan(otherResolved);
    const otherOut = `${work}/other-fat${fatType}-${espBytes}.qcow2`;
    await build(otherPlanned, otherResolved, {
      store: new LayerStore(`${work}/cache-fat${fatType}-${espBytes}`),
      output: otherOut,
      qemu,
    });
    const otherEsp = otherPlanned.layout![0];
    const otherRaw = `${work}/other-fat${fatType}-${espBytes}.fat`;
    await qemu.convert(
      {
        imageOpts: {
          driver: "raw",
          offset: otherEsp.offsetBytes,
          size: otherEsp.lengthBytes,
          file: {
            driver: "qcow2",
            file: { driver: "file", filename: otherOut },
          },
        },
      },
      otherRaw,
      { format: "raw", parallel: 1 },
    );
    const derived = describeFat(await Deno.readFile(otherRaw));
    assert(
      derived.fatType === fatType,
      `${label}: the BPB-derived type is FAT${fatType} ` +
        `(got FAT${derived.fatType})`,
    );
    const otherFsck = await sh("/sbin/fsck_msdos", ["-n", otherRaw])
      .catch(() => "");
    if (otherFsck !== "") {
      assert(
        !/BOGUS|Invalid|error/i.test(otherFsck),
        `${label}: fsck_msdos is clean:\n${otherFsck}`,
      );
    }
    await Deno.remove(otherRaw).catch(() => {});
    pass(
      `${label}: ${otherEsp.lengthBytes} bytes, FAT${derived.fatType}, ` +
        `${derived.clusterCount} clusters, fsck clean`,
    );
  }

  step("a second build is a cache hit for every layer");
  const again = await build(planned, resolved, {
    store,
    output: `${work}/again.qcow2`,
    qemu,
  });
  assert(
    again.cacheHits.length === planned.steps.length,
    `all ${planned.steps.length} layers hit (got ${again.cacheHits.length})`,
  );
  assert(
    (await qemu.compare(output, `${work}/again.qcow2`, { strict: true }))
      .identical,
    "a cached rebuild is byte-identical in guest-visible content",
  );
  pass("cache hits, and the rebuild compares identical (strict)");

  // ── content identity vs container bytes ──────────────────────────────────
  // The distinction the cache keys turn on, tested where it can be tested
  // without booting anything: a layer's key folds its parent's CONTENT digest,
  // and the container digest it used to fold moves for reasons that have
  // nothing to do with what the guest reads.
  step("the same content in a different container digests the same");
  const digests = `${work}/digests`;
  await Deno.mkdir(digests, { recursive: true });
  const digestOf = (path: string) =>
    contentDigest(qemu, path, { scratch: digests, format: "qcow2" });
  const containerOf = async (path: string) =>
    await sha256Hex(await Deno.readFile(path));

  // A different cluster size rewrites every L2 table and relocates every data
  // cluster, which is a bigger layout change than two guest boots produce and
  // an exactly content-preserving one.
  const relaid = `${work}/relaid.qcow2`;
  await qemu.convert(output, relaid, {
    format: "qcow2",
    sourceFormat: "qcow2",
    options: { cluster_size: "1M" },
    parallel: 1,
  });
  assert(
    await containerOf(output) !== await containerOf(relaid),
    "the two containers really do differ",
  );
  assert(
    (await qemu.compare(output, relaid)).identical,
    "…while qemu calls their guest-visible content identical",
  );
  // And strict compare does not, because a 1 MiB cluster allocates in 1 MiB
  // units: allocation status is a property of the container, which is why it
  // is not the oracle for "the same filesystem" either.
  assert(
    !(await qemu.compare(output, relaid, { strict: true })).identical,
    "strict compare, meanwhile, reports a difference",
  );
  assert(
    await digestOf(output) === await digestOf(relaid),
    `and so does the content digest:\n  ${await digestOf(
      output,
    )}\n  ${await digestOf(
      relaid,
    )}`,
  );
  pass("container digest moved, content digest did not");

  step("allocation is not content: written zeros digest as absent zeros");
  const SMALL = 64 * 1024 * 1024;
  const hole = `${work}/hole.qcow2`;
  const written = `${work}/written.qcow2`;
  await qemu.create(hole, { format: "qcow2", size: SMALL });
  await qemu.create(written, { format: "qcow2", size: SMALL });
  await Deno.writeFile(`${work}/zeros.bin`, new Uint8Array(1024 * 1024));
  // `-S 0` disables sparse detection, so these zeros are really written and
  // really allocate clusters. This is the case that makes a strict compare —
  // and any digest over the container — report a difference where a guest
  // reads none, and it is why the digest folds blocks of zeros in as nothing.
  await qemu.convert(
    `${work}/zeros.bin`,
    {
      imageOpts: {
        driver: "raw",
        offset: 32 * 1024 * 1024,
        size: 1024 * 1024,
        file: { driver: "qcow2", file: { driver: "file", filename: written } },
      },
    },
    { sourceFormat: "raw", noCreate: true, parallel: 1, sparseSize: 0 },
  );
  assert(
    (await qemu.map(hole, { format: "qcow2" })).every((e) => e.data !== true),
    "nothing is allocated in the untouched image",
  );
  assert(
    (await qemu.map(written, { format: "qcow2" })).some((e) => e.data === true),
    "the written zeros did allocate clusters",
  );
  assert(
    !(await qemu.compare(hole, written, { strict: true })).identical,
    "strict compare calls that a difference",
  );
  assert(
    (await qemu.compare(hole, written)).identical,
    "…though a guest reads the same disk from both",
  );
  assert(
    await digestOf(hole) === await digestOf(written),
    "the content digest agrees with the guest, not with the allocator",
  );
  pass("allocated zeros and unallocated zeros share one digest");

  step("but a single changed byte moves it");
  const poked = `${work}/poked.qcow2`;
  await qemu.convert(hole, poked, {
    format: "qcow2",
    sourceFormat: "qcow2",
    parallel: 1,
  });
  // A whole sector, because a window's size must be a multiple of 512 — but
  // only its first byte is non-zero, so exactly one byte of content moves.
  const poke = new Uint8Array(512);
  poke[0] = 0x5a;
  await Deno.writeFile(`${work}/poke.bin`, poke);
  await qemu.convert(
    `${work}/poke.bin`,
    {
      imageOpts: {
        driver: "raw",
        offset: 32 * 1024 * 1024,
        size: 512,
        file: { driver: "qcow2", file: { driver: "file", filename: poked } },
      },
    },
    { sourceFormat: "raw", noCreate: true, parallel: 1 },
  );
  assert(
    await digestOf(poked) !== await digestOf(hole),
    "one byte in 64 MiB of zeros is a different disk",
  );
  pass("one byte moves the digest — the tamper case still has teeth");

  step("a tampered cached layer is caught, not silently trusted");
  const victim = artifact.layers[artifact.layers.length - 1];
  await Deno.chmod(victim.path, 0o644);
  const bytes = await Deno.readFile(victim.path);
  bytes[bytes.byteLength - 1] ^= 0xff;
  await Deno.writeFile(victim.path, bytes);
  let caught = false;
  try {
    await build(planned, resolved, {
      store,
      output: `${work}/third.qcow2`,
      qemu,
    });
  } catch (error) {
    caught = error instanceof LayerIntegrityError;
  }
  // This is the corruption qemu-img check structurally cannot see: the chain
  // stays perfect, because qcow2 records nothing about a backing file's
  // content. The store's own digest is the only thing standing in the way.
  assert(caught, "a mutated cached layer raises LayerIntegrityError");
  pass("verify-on-hit caught the tamper");

  console.log("\nrecipe smoke: all green");
} finally {
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
