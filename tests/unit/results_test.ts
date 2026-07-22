import { assertEquals, assertThrows } from "@std/assert";
import { QemuImgOutputError } from "../../src/errors.ts";
import {
  parseCheckResult,
  parseMapExtents,
  parseMeasureResult,
  parseQemuImgInfo,
  parseQemuImgInfoChain,
} from "../../src/results.ts";

function fixture(name: string): string {
  return Deno.readTextFileSync(`tests/fixtures/${name}`);
}

Deno.test("parseQemuImgInfo narrows the documented fields and keeps raw", () => {
  const info = parseQemuImgInfo(fixture("info-qcow2.json"));
  assertEquals(info.filename, "/tmp/disk.qcow2");
  assertEquals(info.format, "qcow2");
  assertEquals(info.virtualSizeBytes, 10737418240);
  assertEquals(info.actualSizeBytes, 266240);
  assertEquals(info.clusterSize, 65536);
  assertEquals(info.dirtyFlag, false);
  assertEquals(info.backingFilename, "base.qcow2");
  assertEquals(info.fullBackingFilename, "/tmp/base.qcow2");
  assertEquals(info.backingFormat, "qcow2");
  assertEquals(info.snapshots?.length, 1);
  assertEquals(info.snapshots?.[0].id, "1");
  assertEquals(info.snapshots?.[0].tag, "clean");
  assertEquals(info.snapshots?.[0].vmStateSizeBytes, 0);
  assertEquals(info.snapshots?.[0].dateSec, 1721580000);
  // Unknown fields survive in raw:
  assertEquals(
    (info.raw["format-specific"] as { type: string }).type,
    "qcow2",
  );
});

Deno.test("parseQemuImgInfo without optional fields degrades gracefully", () => {
  const info = parseQemuImgInfo('{"filename": "/x.raw", "format": "raw"}');
  assertEquals(info.format, "raw");
  assertEquals(info.virtualSizeBytes, undefined);
  assertEquals(info.snapshots, undefined);
  assertEquals(info.backingFilename, undefined);
});

Deno.test("parseQemuImgInfo throws on garbage and non-objects", () => {
  assertThrows(() => parseQemuImgInfo("not json"), QemuImgOutputError);
  assertThrows(() => parseQemuImgInfo("[1, 2]"), QemuImgOutputError);
});

Deno.test("parseQemuImgInfoChain returns every chain element", () => {
  const chain = parseQemuImgInfoChain(fixture("info-chain.json"));
  assertEquals(chain.length, 2);
  assertEquals(chain[0].filename, "/tmp/overlay.qcow2");
  assertEquals(chain[0].backingFilename, "base.qcow2");
  assertEquals(chain[1].filename, "/tmp/base.qcow2");
  assertEquals(chain[1].backingFilename, undefined);
});

Deno.test("parseQemuImgInfoChain accepts a bare object as a one-element chain", () => {
  const chain = parseQemuImgInfoChain('{"format": "raw"}');
  assertEquals(chain.length, 1);
  assertEquals(chain[0].format, "raw");
});

Deno.test("parseCheckResult carries the exit code and the counters", () => {
  const check = parseCheckResult(fixture("check-leaks.json"), 3);
  assertEquals(check.code, 3);
  assertEquals(check.filename, "/tmp/leaky.qcow2");
  assertEquals(check.format, "qcow2");
  assertEquals(check.checkErrors, 0);
  assertEquals(check.leaks, 125);
  assertEquals(check.leaksFixed, 0);
  assertEquals(check.corruptions, undefined);
  assertEquals(check.imageEndOffset, 562036736);
  assertEquals(check.totalClusters, 163840);
  assertEquals(check.allocatedClusters, 8570);
  assertEquals(check.fragmentedClusters, 96);
  assertEquals(check.compressedClusters, 3399);
});

Deno.test("parseCheckResult throws on non-object output", () => {
  assertThrows(() => parseCheckResult("nope", 0), QemuImgOutputError);
});

Deno.test("parseMapExtents narrows extents and keeps raw", () => {
  const extents = parseMapExtents(fixture("map.json"));
  assertEquals(extents.length, 2);
  assertEquals(extents[0], {
    start: 0,
    length: 327680,
    depth: 0,
    present: true,
    zero: false,
    data: true,
    offset: 327680,
    compressed: false,
    raw: extents[0].raw,
  });
  assertEquals(extents[1].zero, true);
  assertEquals(extents[1].offset, undefined);
});

Deno.test("parseMapExtents throws on non-arrays and start/length-less entries", () => {
  assertThrows(() => parseMapExtents("{}"), QemuImgOutputError);
  assertThrows(
    () => parseMapExtents('[{"depth": 0}]'),
    QemuImgOutputError,
    "lacks start/length",
  );
});

Deno.test("parseMeasureResult reads required and fully-allocated", () => {
  const measure = parseMeasureResult(
    '{"required": 393216, "fully-allocated": 1074135040}',
  );
  assertEquals(measure.requiredBytes, 393216);
  assertEquals(measure.fullyAllocatedBytes, 1074135040);
  assertEquals(measure.bitmapsBytes, undefined);
});

Deno.test("parseMeasureResult throws when required is missing", () => {
  assertThrows(
    () => parseMeasureResult('{"fully-allocated": 1}'),
    QemuImgOutputError,
    "lacks required",
  );
});

Deno.test("an unreadable check counter throws instead of reading as clean", () => {
  // qemu-img omits a zero counter entirely, so `undefined` means ZERO here,
  // not "not reported". Degrading a mistyped value the way every other field
  // does would make a corrupt image parse byte-identically to a clean one.
  const clean = parseCheckResult('{"check-errors": 0}', 0);
  assertEquals(clean.corruptions, undefined);
  assertEquals(clean.leaks, undefined);

  for (const bad of ['"7"', "null", "[]", '{"n":7}', "true"]) {
    assertThrows(
      () => parseCheckResult(`{"corruptions": ${bad}}`, 2),
      QemuImgOutputError,
      "non-numeric",
    );
  }
  // Every verdict counter is covered, not just corruptions.
  for (
    const key of ["leaks", "check-errors", "corruptions-fixed", "leaks-fixed"]
  ) {
    assertThrows(
      () => parseCheckResult(`{"${key}": "1"}`, 0),
      QemuImgOutputError,
      "non-numeric",
    );
  }
  // The refusal names the field and points at the escape hatch.
  assertThrows(
    () => parseCheckResult('{"leaks": "125"}', 3),
    QemuImgOutputError,
    "`raw`",
  );
});

Deno.test("descriptive check fields still degrade rather than throw", () => {
  // Only the verdict counters are strict; a mistyped label is not a safety
  // question, so the module-wide degrade-to-undefined policy still holds.
  const result = parseCheckResult(
    '{"filename": 7, "format": null, "total-clusters": "64"}',
    0,
  );
  assertEquals(result.filename, undefined);
  assertEquals(result.format, undefined);
  assertEquals(result.totalClusters, undefined);
  assertEquals(result.code, 0);
});

Deno.test("captured qemu-img 11.0.2 output parses as documented", () => {
  // Real stdout, captured from the binary named in version.txt. Asserting the
  // provenance keeps a later recapture from quietly re-pointing these
  // fixtures at a different qemu.
  assertEquals(fixture("v11/version.txt").trim(), "qemu-img version 11.0.2");

  const clean = parseCheckResult(fixture("v11/check-clean.json"), 0);
  assertEquals(clean.format, "qcow2");
  assertEquals(clean.checkErrors, 0);
  assertEquals(clean.totalClusters, 64);
  // The clean report carries no `corruptions`/`leaks` keys at all.
  assertEquals(clean.corruptions, undefined);
  assertEquals(clean.leaks, undefined);
  assertEquals("corruptions" in clean.raw, false);

  const corrupt = parseCheckResult(fixture("v11/check-corrupt.json"), 2);
  assertEquals(corrupt.code, 2);
  assertEquals(corrupt.corruptions, 3);
  assertEquals(corrupt.checkErrors, 0);

  // `info` on a node graph nests the protocol layer under `children`, a
  // shape the narrowing must pass through untouched.
  const info = parseQemuImgInfo(fixture("v11/info-image-opts.json"));
  assertEquals(info.format, "raw");
  assertEquals(info.virtualSizeBytes, 1048576);
  assertEquals(Array.isArray(info.raw.children), true);

  const measured = parseMeasureResult(fixture("v11/measure-qcow2.json"));
  assertEquals(measured.requiredBytes, 393216);
  assertEquals(measured.bitmapsBytes, 0);

  const extents = parseMapExtents(fixture("v11/map-sparse.json"));
  assertEquals(extents.length, 2);
  assertEquals(extents[0].start, 0);
  assertEquals(extents[0].data, true);
  assertEquals(extents[1].zero, true);
  assertEquals(extents[1].data, false);
});
