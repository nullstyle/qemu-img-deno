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
