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
  defineRecipe,
  dir,
  LayerIntegrityError,
  LayerStore,
  LocalInputResolver,
  plan,
  resolveRecipe,
  VVFAT_USABLE_BYTES,
} from "../src/recipe/mod.ts";

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
const DISK_BYTES = 700 * 1024 * 1024;

try {
  step("stage an ESP tree with the EFI removable-media fallback");
  const staging = `${work}/esp`;
  await Deno.mkdir(`${staging}/EFI/BOOT`, { recursive: true });
  await Deno.writeTextFile(
    `${staging}/EFI/BOOT/BOOTAA64.EFI`,
    "MZ not-a-real-binary\n",
  );
  await Deno.writeTextFile(
    `${staging}/README.TXT`,
    "built by @nullstyle/qemu-img\n",
  );

  const recipe = defineRecipe({
    name: "smoke-appliance",
    platform: { arch: "aarch64", machine: "virt-11.0" },
    base: {
      kind: "blank",
      sizeBytes: DISK_BYTES,
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
        size: VVFAT_USABLE_BYTES[16],
        contents: {
          kind: "fat",
          fatType: 16,
          label: "EFI",
          from: dir(staging),
        },
      }],
    }],
  });

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

  step("fsck_msdos validates the FAT (an independent implementation)");
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
  const fsck = await sh("/sbin/fsck_msdos", ["-n", espRaw]).catch(() => "");
  if (fsck === "") {
    console.log("  · fsck_msdos unavailable (not macOS) — skipped");
  } else {
    assert(fsck.includes("Phase 1"), `fsck_msdos ran:\n${fsck}`);
    assert(!/BOGUS|Invalid|error/i.test(fsck), `fsck_msdos is clean:\n${fsck}`);
    pass("fsck_msdos clean");
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
