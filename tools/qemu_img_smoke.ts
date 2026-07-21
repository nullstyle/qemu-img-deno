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

  step("rebase overlay onto '' in safe mode (flatten, data preserved)");
  await qemu.rebase(overlay, { backing: "" });
  const rebased = await qemu.info(overlay);
  assert(rebased.backingFilename === undefined, "backing removed");
  // Safe mode copies the base's clusters down, so contents still match.
  const flattened = await qemu.compare(base, overlay);
  assert(flattened.identical, "safe flatten preserves guest-visible data");
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

  // Prove the refusal is warranted: force it through raw() and the image
  // reads back as zeros instead of the base's data — while `check` calls it
  // clean, which is exactly why this fails silently in the wild.
  await qemu.raw(["rebase", "-u", "-b", "", guarded]);
  const forced = await qemu.check(guarded);
  assert(forced.code === 0, "the gutted image still checks clean");
  assert(
    !(await qemu.compare(dataBase, guarded)).identical,
    "unsafe flatten silently lost the base's data",
  );
  pass("guard refuses; raw() reproduces the silent data loss it prevents");

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

  console.log("\nqemu-img smoke: all green");
} finally {
  await Deno.remove(dir, { recursive: true });
}
