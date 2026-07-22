/**
 * Real-qemu-img smoke: exercises the whole client surface against a real
 * `qemu-img` in a scratch directory, asserting every parser against real
 * output. Run manually before tagging a release:
 *
 *     deno task smoke
 *
 * Loud-skips (exit 0) when qemu-img is not installed (`brew install qemu`).
 * This is the ground truth for the JSON fixture shapes the unit tests pin.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import { QemuImgUnsafeOperationError } from "../src/errors.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${label}`);
    Deno.exit(1);
  }
}

const qemu = new QemuImg();

if (!(await qemu.available())) {
  skip("qemu-img not installed (brew install qemu) — smoke skipped");
  Deno.exit(0);
}

const version = await qemu.version();
pass(`qemu-img ${version.raw}`);

const dir = await Deno.makeTempDir({ prefix: "qemu-img-smoke-" });
const base = `${dir}/base.qcow2`;
const overlay = `${dir}/overlay.qcow2`;
const rawOut = `${dir}/out.raw`;
const ddOut = `${dir}/dd.raw`;
const GiB = 1024 ** 3;

try {
  step("create a 1G qcow2 with explicit cluster_size");
  await qemu.create(base, {
    format: "qcow2",
    size: "1G",
    options: { "cluster_size": 65536 },
  });

  step("info: format, sizes, cluster size");
  const info = await qemu.info(base);
  assert(info.format === "qcow2", `info.format qcow2 (got ${info.format})`);
  assert(info.virtualSizeBytes === GiB, "info virtual size is 1 GiB");
  assert(info.clusterSize === 65536, "info cluster size is 65536");
  pass("info parses");

  step("check: clean image");
  const check = await qemu.check(base);
  assert(check.code === 0, "check exit 0");
  assert(check.checkErrors === 0, "check-errors 0");
  pass("check parses");

  step("measure: --size and source forms");
  const measureSize = await qemu.measure({ outputFormat: "qcow2", size: "1G" });
  assert(measureSize.requiredBytes > 0, "measure --size required > 0");
  const measureSource = await qemu.measure({
    outputFormat: "raw",
    source: base,
  });
  assert(
    measureSource.fullyAllocatedBytes === GiB,
    "measure source fully-allocated is 1 GiB",
  );
  pass("measure parses");

  step("map: extents cover the virtual size");
  const extents = await qemu.map(base);
  const covered = extents.reduce((sum, extent) => sum + extent.length, 0);
  assert(covered === GiB, `map extents cover 1 GiB (got ${covered})`);
  pass("map parses");

  step("snapshot: create, list, apply, delete");
  await qemu.snapshot.create(base, "clean");
  const snapshots = await qemu.snapshot.list(base);
  assert(
    snapshots.length === 1 && snapshots[0].tag === "clean",
    "snapshot listed via info",
  );
  await qemu.snapshot.apply(base, "clean");
  await qemu.snapshot.delete(base, "clean");
  assert(
    (await qemu.snapshot.list(base)).length === 0,
    "snapshot deleted",
  );
  pass("snapshot lifecycle");

  step("bitmap: add, disable, enable, remove");
  await qemu.bitmap(base, "dirty", { op: "add", granularity: 65536 });
  await qemu.bitmap(base, "dirty", { op: "disable" });
  await qemu.bitmap(base, "dirty", { op: "enable" });
  await qemu.bitmap(base, "dirty", { op: "remove" });
  pass("bitmap lifecycle");

  step("amend: bump compat");
  await qemu.amend(base, { options: { "compat": "1.1" } });
  pass("amend");

  step("create an overlay backed by base; infoChain walks the chain");
  await qemu.create(overlay, {
    format: "qcow2",
    backing: base,
    backingFormat: "qcow2",
  });
  const chain = await qemu.infoChain(overlay);
  assert(chain.length === 2, `chain length 2 (got ${chain.length})`);
  assert(chain[0].backingFormat === "qcow2", "chain[0] backing format");
  pass("infoChain parses");

  step("rebase overlay onto '' in safe mode");
  await qemu.rebase(overlay, { backing: "" });
  const rebased = await qemu.info(overlay);
  assert(rebased.backingFilename === undefined, "backing removed");
  // No data assertion here on purpose: `base` is empty, so comparing it to
  // the flattened overlay passes whether or not the flatten preserved
  // anything. The data-bearing proof is the next section.
  pass("rebase (safe flatten)");

  step("the unsafe+empty-backing guard, and why it exists");
  // A base that actually holds data — an empty image would make "lost the
  // data" indistinguishable from "read back as zeros".
  const dataRaw = `${dir}/data.raw`;
  const dataBase = `${dir}/data-base.qcow2`;
  await Deno.writeFile(dataRaw, new Uint8Array(1024 * 1024).fill(0xab));
  await qemu.convert(dataRaw, dataBase, {
    sourceFormat: "raw",
    format: "qcow2",
  });

  // Safe mode copies those clusters down: content survives the flatten.
  const safeFlat = `${dir}/safe-flat.qcow2`;
  await qemu.create(safeFlat, {
    format: "qcow2",
    backing: dataBase,
    backingFormat: "qcow2",
  });
  await qemu.rebase(safeFlat, { backing: "" });
  assert(
    (await qemu.compare(dataBase, safeFlat)).identical,
    "safe flatten preserves the base's data",
  );

  const guarded = `${dir}/guarded.qcow2`;
  await qemu.create(guarded, {
    format: "qcow2",
    backing: dataBase,
    backingFormat: "qcow2",
  });
  let refused = false;
  try {
    await qemu.rebase(guarded, { backing: "", unsafe: true });
  } catch (error) {
    refused = error instanceof QemuImgUnsafeOperationError;
  }
  assert(refused, "rebase refuses unsafe + empty backing");

  // Prove the refusal is warranted by opting back in: the image then reads
  // as zeros instead of the base's data. raw() would do the same; the typed
  // opt-in is what a caller with a dangling base actually reaches for.
  await qemu.rebase(guarded, {
    backing: "",
    unsafe: true,
    acknowledgeDataLoss: true,
  });
  assert(
    !(await qemu.compare(dataBase, guarded)).identical,
    "unsafe flatten silently lost the base's data",
  );
  // Not asserted: a stricter future qemu-img flagging this would be an
  // upstream improvement, and should not fail our release gate.
  const forced = await qemu.check(guarded);
  console.log(
    `  · qemu-img check on the gutted image: ${
      forced.code === 0 ? "clean (silent loss)" : `code ${forced.code}`
    }`,
  );
  pass("guard refuses; the opt-in reproduces the loss it prevents");

  step("re-point overlay at base, write nothing, commit");
  await qemu.rebase(overlay, {
    backing: base,
    backingFormat: "qcow2",
    unsafe: true,
  });
  await qemu.commit(overlay);
  pass("commit");

  step("convert base to compressed qcow2 and to raw");
  const compressed = `${dir}/compressed.qcow2`;
  await qemu.convert(base, compressed, { format: "qcow2", compress: true });
  await qemu.convert(base, rawOut, { format: "raw", sourceFormat: "qcow2" });
  const rawInfo = await qemu.info(rawOut);
  assert(rawInfo.format === "raw", "converted raw format");
  assert(rawInfo.virtualSizeBytes === GiB, "converted raw size");
  pass("convert both ways");

  step("compare: identical and (strictly) different");
  const same = await qemu.compare(base, rawOut);
  assert(same.identical, "base and its raw conversion are identical");
  const two = `${dir}/two.qcow2`;
  await qemu.create(two, { format: "qcow2", size: "2G" });
  // Non-strict compare treats a size mismatch with an all-zero tail as
  // identical; only strict mode fails on differing sizes.
  const lax = await qemu.compare(base, two);
  assert(lax.identical, "zero-tail size mismatch is identical non-strictly");
  const different = await qemu.compare(base, two, { strict: true });
  assert(!different.identical, "different sizes fail strict compare");
  pass("compare exit-code contract (incl. strict)");

  step("resize: grow, then shrink with --shrink");
  await qemu.resize(rawOut, "+1G");
  assert(
    (await qemu.info(rawOut)).virtualSizeBytes === 2 * GiB,
    "grew to 2 GiB",
  );
  await qemu.resize(rawOut, `${GiB}`, { shrink: true });
  assert(
    (await qemu.info(rawOut)).virtualSizeBytes === GiB,
    "shrank back to 1 GiB",
  );
  pass("resize");

  step("dd: copy the first MiB");
  await qemu.dd({
    input: rawOut,
    output: ddOut,
    format: "raw",
    outputFormat: "raw",
    blockSize: "1M",
    count: 1,
  });
  const ddInfo = await qemu.info(ddOut);
  assert(ddInfo.virtualSizeBytes === 1024 ** 2, "dd copied one MiB");
  pass("dd");

  step("bench: tiny read benchmark");
  const report = await qemu.bench(base, { count: 16, bufferSize: "4k" });
  assert(report.length > 0, "bench produced a report");
  pass("bench");

  step("convert with a backing file (the layer-cache argv path)");
  // Previously unexercised here: every convert in this smoke was backing-less,
  // so the flag spelling a backing chain depends on was never validated.
  const backed = `${dir}/backed.qcow2`;
  await qemu.convert(dataBase, backed, {
    format: "qcow2",
    backing: base,
    backingFormat: "qcow2",
  });
  assert(
    (await qemu.info(backed)).backingFilename === base,
    "convert -B recorded the backing reference",
  );
  pass("convert with backing");

  step("option-graph window write: bytes land in the window and nowhere else");
  // The mechanism the whole from-scratch build path rests on. A `raw` node
  // with offset/size is a WINDOW onto a larger image, so a filesystem can be
  // written into one partition without touching its neighbours.
  const windowTarget = `${dir}/window.raw`;
  const patternFile = `${dir}/pattern.bin`;
  const WINDOW_OFFSET = 1024 * 1024;
  const WINDOW_SIZE = 64 * 1024;
  await Deno.writeFile(windowTarget, new Uint8Array(8 * 1024 * 1024));
  await Deno.writeFile(patternFile, new Uint8Array(WINDOW_SIZE).fill(0xab));
  await qemu.convert(patternFile, {
    imageOpts: {
      driver: "raw",
      offset: WINDOW_OFFSET,
      size: WINDOW_SIZE,
      file: { driver: "file", filename: windowTarget },
    },
  }, { sourceFormat: "raw", noCreate: true, parallel: 1 });
  const written = await Deno.readFile(windowTarget);
  assert(
    written.slice(WINDOW_OFFSET, WINDOW_OFFSET + WINDOW_SIZE)
      .every((byte) => byte === 0xab),
    "the window holds the pattern",
  );
  assert(
    written.slice(0, WINDOW_OFFSET).every((byte) => byte === 0) &&
      written.slice(WINDOW_OFFSET + WINDOW_SIZE).every((byte) => byte === 0),
    "nothing outside the window was touched",
  );
  pass("option-graph window write");

  step("vvfat: a FAT filesystem with no mkfs.fat on the host");
  // qemu's vvfat driver synthesizes FAT from a host directory. Wrapped in a
  // `raw` window at 32256 its own MBR is stripped, leaving the bare
  // filesystem — the only way to produce an ESP on a host with no mkfs.fat.
  const VVFAT_MBR_BYTES = 32256;
  const VVFAT_FAT16_BYTES = 528450048;
  const staging = `${dir}/staging`;
  await Deno.mkdir(`${staging}/EFI/BOOT`, { recursive: true });
  await Deno.writeTextFile(`${staging}/EFI/BOOT/README.TXT`, "built by qemu\n");
  const espDisk = `${dir}/esp.qcow2`;
  await qemu.create(espDisk, { format: "qcow2", size: "600M" });
  await qemu.convert({
    imageOpts: {
      driver: "raw",
      offset: VVFAT_MBR_BYTES,
      size: VVFAT_FAT16_BYTES,
      file: { driver: "vvfat", dir: staging, "fat-type": 16, label: "EFI" },
    },
  }, {
    imageOpts: {
      driver: "raw",
      offset: 1024 * 1024,
      size: VVFAT_FAT16_BYTES,
      file: {
        driver: "qcow2",
        file: { driver: "file", filename: espDisk },
      },
    },
  }, { noCreate: true, parallel: 1 });
  const extracted = `${dir}/extracted.fat`;
  await qemu.convert(
    {
      imageOpts: {
        driver: "raw",
        offset: 1024 * 1024,
        size: VVFAT_FAT16_BYTES,
        file: {
          driver: "qcow2",
          file: { driver: "file", filename: espDisk },
        },
      },
    },
    extracted,
    { format: "raw", parallel: 1 },
  );
  // Validate against an INDEPENDENT FAT implementation where one exists;
  // a self-round-trip through qemu would not catch a shared misreading.
  let fsckRan = false;
  try {
    const fsck = new Deno.Command("/sbin/fsck_msdos", {
      args: ["-n", extracted],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await fsck.output();
    fsckRan = true;
    assert(result.code === 0, "fsck_msdos accepts the generated filesystem");
  } catch {
    // Not macOS; the extraction above is still the meaningful assertion.
  }
  console.log(
    `  · independent FAT check: ${
      fsckRan ? "fsck_msdos clean" : "skipped (no /sbin/fsck_msdos)"
    }`,
  );
  pass("vvfat ESP built without mkfs.fat");

  console.log("\nqemu-img smoke: all green");
} finally {
  await Deno.remove(dir, { recursive: true });
}
