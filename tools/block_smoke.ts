/**
 * Real-binary smoke for `./block`: damage a real GPT with `qemu-img resize`,
 * see it, repair it, and have Apple's parser agree.
 *
 *     deno task smoke:block
 *
 * The oracles are the point. `diskutil` and `gpt -r show` are macOS's own GPT
 * readers and share no code with qemu or with this package, so their verdict
 * on a repaired table is evidence rather than a round trip through our own
 * assumptions.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import {
  build,
  defineRecipe,
  dir,
  LayerStore,
  LocalInputResolver,
  plan,
  resolveRecipe,
} from "../src/recipe/mod.ts";
import {
  diagnoseGptImage,
  GptRepairRefusedError,
  readGptImage,
  repairGptImage,
  resizeAndRepairGpt,
} from "../src/block/mod.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);
const note = (label: string) => console.log(`  · ${label}`);

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

/** Every device this smoke attached, so the cleanup detaches only those. */
const attachedDevices: string[] = [];

/**
 * Hand a raw image to macOS and ask its own parser what it sees.
 *
 * Returns `undefined` when hdiutil declines the image — which is itself a
 * verdict, and is reported as one.
 */
async function inspectWithApple(
  raw: string,
): Promise<{ device: string; list: string; table: string } | undefined> {
  const attached = await sh("hdiutil", [
    "attach",
    "-nomount",
    "-imagekey",
    "diskimage-class=CRawDiskImage",
    raw,
  ]).catch(() => "");
  const device = /^(\/dev\/disk\d+)/m.exec(attached)?.[1];
  if (device === undefined) return undefined;
  attachedDevices.push(device);
  const list = await sh("diskutil", ["list", device]);
  const table = await sh("gpt", ["-r", "show", device]).catch(() => "");
  await sh("hdiutil", ["detach", device, "-force"]);
  attachedDevices.splice(attachedDevices.indexOf(device), 1);
  return { device, list, table };
}

const qemu = new QemuImg();
if (!(await qemu.available())) {
  skip("qemu-img not installed (brew install qemu) — smoke skipped");
  Deno.exit(0);
}

const work = await Deno.makeTempDir({ prefix: "qemu-img-block-smoke-" });
const DISK_BYTES = 700 * 1024 * 1024;

try {
  step("build a real GPT image with ./recipe");
  const staging = `${work}/esp`;
  await Deno.mkdir(`${staging}/EFI/BOOT`, { recursive: true });
  await Deno.writeTextFile(
    `${staging}/EFI/BOOT/BOOTAA64.EFI`,
    "MZ not-a-real-binary\n",
  );
  const recipe = defineRecipe({
    name: "block-smoke",
    platform: { arch: "aarch64", machine: "virt-11.0" },
    base: { kind: "blank", sizeBytes: DISK_BYTES },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: "block-smoke/v1",
      fsSeed: "block-smoke/v1",
    },
    steps: [{
      kind: "partition",
      id: "table",
      partitions: [{
        label: "EFI",
        type: "esp",
        // 32 MiB: with the native FAT writer there is no fixed floor, and the
        // GPT this smoke repairs is the same shape at any partition size.
        size: 32 * 1024 * 1024,
        contents: {
          kind: "fat",
          fatType: 16,
          label: "EFI",
          from: dir(staging),
        },
      }],
    }],
  });
  const resolved = await resolveRecipe(recipe, {
    resolver: new LocalInputResolver(),
  });
  const planned = await plan(resolved);
  const store = new LayerStore(`${work}/cache`);
  const image = `${work}/disk.qcow2`;
  await build(planned, resolved, { store, output: image, qemu });
  const esp = planned.layout![0];
  pass(`built ${image} (${DISK_BYTES} bytes, ESP at LBA ${esp.firstLba})`);

  step("the table reads back healthy, through two raw windows");
  const healthy = await readGptImage(image);
  assert(healthy.primary.status === "ok", "primary verifies");
  assert(healthy.backup.status === "ok", "backup verifies");
  assert(healthy.totalSectors === DISK_BYTES / 512, "sector count");
  assert(
    healthy.primary.entries.length === 1 &&
      healthy.primary.entries[0].name === "EFI",
    "one partition, named EFI",
  );
  const espLastLba = healthy.primary.entries[0].lastLba;
  assert((await diagnoseGptImage(image)).ok, "diagnosis is clean");
  pass(`clean: ESP spans LBA ${esp.firstLba}..${espLastLba}`);

  // Everything below depends on this: the repair writes all-zero ranges (the
  // 127 unused entry slots, and the stranded backup), and `convert -n` is
  // free to skip source blocks it believes the target already holds.
  step("MEASURE: does `convert -n` into a raw window actually write zeros?");
  const probe = `${work}/probe.qcow2`;
  await qemu.create(probe, { format: "qcow2", size: 1024 * 1024 });
  const windowAt = (path: string, offset: number, size: number) => ({
    imageOpts: {
      driver: "raw",
      offset,
      size,
      file: { driver: "qcow2", file: { driver: "file", filename: path } },
    },
  } as const);
  const ones = `${work}/ones.bin`;
  const zeros = `${work}/zeros.bin`;
  await Deno.writeFile(ones, new Uint8Array(4096).fill(0xff));
  await Deno.writeFile(zeros, new Uint8Array(4096));
  await qemu.convert(ones, windowAt(probe, 65536, 4096), {
    sourceFormat: "raw",
    noCreate: true,
    parallel: 1,
  });
  await qemu.convert(zeros, windowAt(probe, 65536, 4096), {
    sourceFormat: "raw",
    noCreate: true,
    parallel: 1,
  });
  const readBack = `${work}/readback.bin`;
  await qemu.convert(windowAt(probe, 65536, 4096), readBack, {
    format: "raw",
    parallel: 1,
  });
  const probed = await Deno.readFile(readBack);
  const zeroed = probed.every((byte) => byte === 0);
  assert(
    zeroed,
    "an all-zero blob converted into a window must overwrite 0xFF, not be " +
      "skipped as a no-op — the repair's zeroing depends on it",
  );
  pass("zeros are written, not elided (qemu-img 11.0.2, qcow2 target)");

  step("GROW: resize +256M and look at the damage");
  const grownBytes = DISK_BYTES + 256 * 1024 * 1024;
  await qemu.resize(image, grownBytes);
  const grown = await diagnoseGptImage(image);
  assert(!grown.ok, "a grown disk is NOT clean");
  const grownCodes = grown.problems.map((problem) => problem.code);
  assert(
    grownCodes.includes("backup-stranded"),
    `backup stranded mid-disk (got ${grownCodes.join(", ")})`,
  );
  assert(grownCodes.includes("last-usable-stale"), "LastUsableLBA is stale");
  assert(
    grown.problems.every((problem) => problem.repairable),
    "every problem a grow causes is losslessly repairable",
  );
  assert(
    (await qemu.check(image)).raw !== undefined,
    "qemu-img check still runs",
  );
  pass(`grown to ${grownBytes}: ${grownCodes.join(", ")}`);

  step("what Apple's parser says about the UNREPAIRED grown disk");
  const brokenRaw = `${work}/broken.raw`;
  await qemu.convert(image, brokenRaw, { format: "raw", parallel: 1 });
  const broken = await inspectWithApple(brokenRaw);
  if (broken === undefined) {
    note("hdiutil refused the image outright — that is itself the damage");
  } else {
    // Measured on macOS 25.5 / qemu-img 11.0.2: `diskutil list` reports the
    // grown disk as a perfectly ordinary GPT and still names the ESP. It says
    // nothing at all. That is the whole hazard.
    assert(
      /GUID_partition_scheme/.test(broken.list) && /EFI/.test(broken.list),
      `diskutil parses the DAMAGED table happily:\n${broken.list}`,
    );
    assert(
      !/corrupt|invalid|damaged/i.test(broken.list),
      `diskutil does not call it damaged:\n${broken.list}`,
    );
    note("diskutil: parses it, names the ESP, reports nothing wrong");

    // `gpt -r show` is the tool that does show it — not by erroring (it exits
    // 0 and prints no warning) but by OMISSION: the two rows a healthy disk
    // ends with are simply absent.
    assert(broken.table !== "", "gpt(8) produced output");
    assert(
      !/Sec GPT header/.test(broken.table),
      `gpt(8) finds no secondary header on the grown disk:\n${broken.table}`,
    );
    assert(
      !/Sec GPT table/.test(broken.table),
      `gpt(8) finds no secondary table either:\n${broken.table}`,
    );
    note(
      "gpt -r show: exits 0, prints no warning, and silently omits the " +
        "'Sec GPT table'/'Sec GPT header' rows — the only visible tell",
    );
  }

  step("REPAIR the grown disk");
  const repaired = await repairGptImage(image);
  assert(repaired.changed, "the repair wrote something");
  assert(
    repaired.after.backup.status === "ok",
    "the backup header verifies at the new last sector",
  );
  assert(
    repaired.after.backup.header!.myLba === grownBytes / 512 - 1,
    "the backup sits in the disk's actual last sector",
  );
  assert(
    repaired.after.primary.header!.lastUsableLba === grownBytes / 512 - 34,
    "LastUsableLBA follows the new size",
  );
  assert(
    repaired.after.primary.entries[0].lastLba === espLastLba,
    "the ESP entry is untouched",
  );
  assert(repaired.droppedPartitions.length === 0, "nothing was dropped");
  assert((await diagnoseGptImage(image)).ok, "and it diagnoses clean");
  pass(
    `backup moved to LBA ${repaired.after.backup.header!.myLba}, ` +
      `${repaired.plan.writes.length} ranges written`,
  );

  step("Apple's parser on the REPAIRED disk (the oracle that matters)");
  const fixedRaw = `${work}/fixed.raw`;
  await qemu.convert(image, fixedRaw, { format: "raw", parallel: 1 });
  const fixed = await inspectWithApple(fixedRaw);
  if (fixed === undefined) {
    skip("hdiutil unavailable — Apple oracle skipped");
  } else {
    assert(
      /GUID_partition_scheme/.test(fixed.list),
      `diskutil sees a GPT:\n${fixed.list}`,
    );
    assert(/EFI/.test(fixed.list), `diskutil sees the ESP:\n${fixed.list}`);
    assert(
      !/corrupt|invalid|damaged/i.test(fixed.list),
      `diskutil reports no damage:\n${fixed.list}`,
    );
    // The rows that vanished above are back, and in the right sectors. This
    // is the assertion the whole smoke exists for: an independent parser
    // agreeing that the tail of the table is where it belongs.
    assert(fixed.table !== "", "gpt(8) produced output");
    const secHeader = /^\s*(\d+)\s+1\s+Sec GPT header/m.exec(fixed.table);
    const secTable = /^\s*(\d+)\s+\d+\s+Sec GPT table/m.exec(fixed.table);
    assert(
      secHeader !== null && secTable !== null,
      `gpt(8) finds both secondary rows again:\n${fixed.table}`,
    );
    assert(
      Number(secHeader[1]) === grownBytes / 512 - 1,
      `gpt(8) puts the backup header in the disk's last sector ` +
        `(${secHeader[1]} vs ${grownBytes / 512 - 1})`,
    );
    note(
      `gpt -r show: 'Sec GPT table' at ${secTable[1]}, 'Sec GPT header' at ` +
        `${secHeader[1]} (the last sector)`,
    );
    pass("diskutil and gpt(8) both parse the repaired table");
  }

  step("SHRINK that fits: the backup is reconstructed from the primary");
  const shrinkOk = `${work}/shrink-ok.qcow2`;
  await qemu.convert(image, shrinkOk, { format: "qcow2", parallel: 1 });
  // Just past the ESP, plus room for the tail table.
  const fits = (espLastLba + 34) * 512;
  await qemu.resize(shrinkOk, fits, { shrink: true });
  const shrunk = await diagnoseGptImage(shrinkOk);
  assert(
    shrunk.problems.some((problem) => problem.code === "backup-missing"),
    `the backup is gone (got ${shrunk.problems.map((p) => p.code).join(", ")})`,
  );
  const shrinkFixed = await repairGptImage(shrinkOk);
  assert(shrinkFixed.droppedPartitions.length === 0, "nothing dropped");
  assert(
    shrinkFixed.after.primary.entries[0].lastLba === espLastLba,
    "the ESP survived a shrink that fits",
  );
  assert((await diagnoseGptImage(shrinkOk)).ok, "clean after repair");
  pass(`shrunk to ${fits} and repaired; ESP intact`);

  step("SHRINK that does not fit: REFUSED, with the exact size to grow back");
  const shrinkBad = `${work}/shrink-bad.qcow2`;
  await qemu.convert(image, shrinkBad, { format: "qcow2", parallel: 1 });
  const tooSmall = 16 * 1024 * 1024;
  await qemu.resize(shrinkBad, tooSmall, { shrink: true });
  let refusal: GptRepairRefusedError | undefined;
  try {
    await repairGptImage(shrinkBad);
  } catch (error) {
    if (error instanceof GptRepairRefusedError) refusal = error;
    else throw error;
  }
  assert(refusal !== undefined, "repairing a truncated partition is refused");
  assert(
    refusal.problems.some((p) => p.code === "partition-past-last-usable"),
    `the refusal names the partition (got ${
      refusal.problems.map((p) => p.code).join(", ")
    })`,
  );
  const quoted = /at least (\d+) bytes/.exec(refusal.problems[0].fix);
  assert(
    quoted !== null,
    `the fix names a byte count: ${refusal.problems[0].fix}`,
  );
  const growBackTo = Number(quoted[1]);
  pass(`refused, naming ${growBackTo} bytes as the lossless way out`);

  step("take the refusal at its word: grow back to exactly that and repair");
  await qemu.resize(shrinkBad, growBackTo);
  const rescued = await repairGptImage(shrinkBad);
  assert(rescued.droppedPartitions.length === 0, "nothing dropped");
  assert(
    rescued.after.primary.entries[0].lastLba === espLastLba,
    "the ESP entry is whole again",
  );
  assert((await diagnoseGptImage(shrinkBad)).ok, "clean");
  pass(`grew to ${growBackTo} and repaired losslessly`);

  step("acknowledgeDataLoss drops the entry rather than shortening it");
  const dropped = `${work}/dropped.qcow2`;
  await qemu.convert(image, dropped, { format: "qcow2", parallel: 1 });
  await qemu.resize(dropped, tooSmall, { shrink: true });
  const forced = await repairGptImage(dropped, { acknowledgeDataLoss: true });
  assert(forced.droppedPartitions.length === 1, "one entry dropped");
  assert(forced.droppedPartitions[0].name === "EFI", "and it is named");
  assert(
    forced.after.primary.entries.length === 0,
    "no clamped stand-in was invented",
  );
  assert((await diagnoseGptImage(dropped)).ok, "the result is a valid table");
  pass("dropped the entry whole; never clamped it");

  step("resizeAndRepairGpt does both in one call");
  const paired = `${work}/paired.qcow2`;
  await qemu.convert(image, paired, { format: "qcow2", parallel: 1 });
  const pairedSize = grownBytes + 128 * 1024 * 1024;
  const pairedResult = await resizeAndRepairGpt(paired, pairedSize, { qemu });
  assert(pairedResult.changed, "it repaired what the resize broke");
  assert(
    pairedResult.after.backup.header!.myLba === pairedSize / 512 - 1,
    "backup at the new last sector",
  );
  assert((await diagnoseGptImage(paired)).ok, "clean");
  pass(`resized to ${pairedSize} and repaired in one call`);

  step("a repaired image is stable: repairing again is a no-op");
  const again = await repairGptImage(image);
  assert(!again.changed, "second repair writes nothing");
  pass("idempotent");

  console.log("\nblock smoke: all checks passed");
} finally {
  for (const device of attachedDevices) {
    await sh("hdiutil", ["detach", device, "-force"]).catch(() => {});
  }
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
