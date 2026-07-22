import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildFat,
  CLUSTER_COUNT_THRESHOLDS,
  describeFat,
  DIR_ENTRY_BYTES,
  type FatEntry,
  FatEntryError,
  type FatEntryShape,
  fatEntryShapes,
  FatGeometryError,
  fatGeometryFor,
  type FatOptions,
  minimumFatSizeBytes,
  SECTOR_BYTES,
} from "../../src/fs/fat.ts";

const EPOCH = 1_700_000_000; // 2023-11-14T22:13:20Z
const encoder = new TextEncoder();

const BASE: Omit<FatOptions, "sizeBytes"> = {
  label: "ESP",
  volumeId: 0x12345678,
  sourceDateEpoch: EPOCH,
};

/** A small, realistic ESP tree. */
function esp(): FatEntry[] {
  return [
    { path: "EFI", type: "dir", mtime: EPOCH },
    { path: "EFI/BOOT", type: "dir", mtime: EPOCH },
    {
      path: "EFI/BOOT/BOOTAA64.EFI",
      type: "file",
      mtime: EPOCH,
      body: encoder.encode("boot payload\n"),
    },
  ];
}

/** Byte offset of the root directory's first entry. */
function rootDirOffset(bytes: Uint8Array): number {
  const geometry = describeFat(bytes);
  if (geometry.fatType !== 32) {
    return (geometry.reservedSectors +
      geometry.numFats * geometry.fatSectors) * SECTOR_BYTES;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rootCluster = view.getUint32(44, true);
  return (geometry.firstDataSector +
    (rootCluster - 2) * geometry.sectorsPerCluster) * SECTOR_BYTES;
}

/** Read `count` 32-byte directory entries starting at `at`. */
function dirEntries(
  bytes: Uint8Array,
  at: number,
  count: number,
): Uint8Array[] {
  return Array.from(
    { length: count },
    (_, index) =>
      bytes.subarray(
        at + index * DIR_ENTRY_BYTES,
        at + (index + 1) * DIR_ENTRY_BYTES,
      ),
  );
}

/** The spec's short-name checksum, written independently of the writer's. */
function checksum(short: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < 11; index++) {
    sum = (((sum & 1) << 7) + (sum >> 1) + short[index]) & 0xff;
  }
  return sum;
}

const name = (entry: Uint8Array) =>
  new TextDecoder().decode(entry.subarray(0, 11));

/**
 * Smallest window that formats as `fatType`, found by bisection.
 *
 * The writer refuses a geometry whose cluster count falls outside the range
 * that *defines* the requested type, so the smallest accepted window is exactly
 * the one sitting on the type's lower boundary.
 */
function smallestFor(fatType: 12 | 16 | 32, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    let ok = false;
    try {
      buildFat(esp(), { ...BASE, sizeBytes: mid * SECTOR_BYTES, fatType });
      ok = true;
    } catch { /* too small for this type */ }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Largest window still using one sector per cluster: the upper boundary. */
function largestAtSpc1(fatType: 12 | 16, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    let spc = 0;
    try {
      spc = describeFat(
        buildFat(esp(), { ...BASE, sizeBytes: mid * SECTOR_BYTES, fatType }),
      ).sectorsPerCluster;
    } catch { /* no geometry at this size */ }
    if (spc === 1) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One file or directory recovered by walking a built volume. */
interface WalkedEntry {
  name: string;
  cluster: number;
  size: number;
  isDir: boolean;
}

/**
 * Read a directory out of a built volume, following its cluster chain and
 * reassembling long names.
 *
 * Written against the spec rather than against the writer: it is the reader
 * half of the round trip, and it must not share code with what produced the
 * bytes.
 */
function walkDirectory(
  bytes: Uint8Array,
  startCluster: number | "root",
): WalkedEntry[] {
  const geometry = describeFat(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const clusterBytes = geometry.sectorsPerCluster * SECTOR_BYTES;
  const fatAt = geometry.reservedSectors * SECTOR_BYTES;

  const readFat = (cluster: number): number => {
    if (geometry.fatType === 12) {
      const at = fatAt + cluster + (cluster >> 1);
      return (cluster & 1) === 0
        ? bytes[at] | ((bytes[at + 1] & 0x0f) << 8)
        : (bytes[at] >> 4) | (bytes[at + 1] << 4);
    }
    return geometry.fatType === 16
      ? view.getUint16(fatAt + cluster * 2, true)
      : view.getUint32(fatAt + cluster * 4, true) & 0x0fffffff;
  };
  const endMark = geometry.fatType === 12
    ? 0xff8
    : geometry.fatType === 16
    ? 0xfff8
    : 0x0ffffff8;

  // The regions the directory occupies, in order.
  const spans: Array<[number, number]> = [];
  if (startCluster === "root" && geometry.fatType !== 32) {
    const at = (geometry.reservedSectors +
      geometry.numFats * geometry.fatSectors) * SECTOR_BYTES;
    spans.push([at, geometry.rootDirSectors * SECTOR_BYTES]);
  } else {
    let cluster = startCluster === "root"
      ? view.getUint32(44, true)
      : startCluster;
    const seen = new Set<number>();
    while (cluster >= 2 && cluster < endMark) {
      assert(!seen.has(cluster), `cluster chain loops at ${cluster}`);
      seen.add(cluster);
      spans.push([
        (geometry.firstDataSector +
          (cluster - 2) * geometry.sectorsPerCluster) * SECTOR_BYTES,
        clusterBytes,
      ]);
      cluster = readFat(cluster);
    }
  }

  const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  const out: WalkedEntry[] = [];
  let pending: string[] = [];
  for (const [at, length] of spans) {
    for (let off = at; off < at + length; off += DIR_ENTRY_BYTES) {
      const entry = bytes.subarray(off, off + DIR_ENTRY_BYTES);
      if (entry[0] === 0x00) return out; // end of directory
      if (entry[0] === 0xe5) continue; // deleted
      const entryView = new DataView(entry.buffer, entry.byteOffset);
      if (entry[11] === 0x0f) {
        const units = slots
          .map((slot) => entryView.getUint16(slot, true))
          .filter((unit) => unit !== 0x0000 && unit !== 0xffff);
        // Long entries run backwards, so each chunk goes in front.
        pending.unshift(String.fromCharCode(...units));
        continue;
      }
      if (entry[11] === 0x08) { // volume label
        pending = [];
        continue;
      }
      const short = new TextDecoder().decode(entry.subarray(0, 11));
      const eight = short.slice(0, 8).trimEnd();
      const three = short.slice(8).trimEnd();
      out.push({
        name: pending.length > 0
          ? pending.join("")
          : three === ""
          ? eight
          : `${eight}.${three}`,
        cluster: (entryView.getUint16(20, true) << 16) |
          entryView.getUint16(26, true),
        size: entryView.getUint32(28, true),
        isDir: (entry[11] & 0x10) !== 0,
      });
      pending = [];
    }
  }
  return out;
}

Deno.test("a directory spanning many clusters round-trips through the bytes", () => {
  // The failure this pins: a directory whose entries outgrow one cluster, and
  // a FAT12/16 root that outgrows the conventional 512 entries. Both change
  // the geometry, and getting either wrong overruns the region that follows.
  const count = 400;
  const entries: FatEntry[] = [{ path: "deep", type: "dir", mtime: EPOCH }];
  for (let index = 0; index < count; index++) {
    entries.push({
      path: `a rather long file name number ${index}.config`,
      type: "file",
      mtime: EPOCH,
      body: encoder.encode(`root ${index}\n`),
    });
    entries.push({
      path: `deep/another quite long name ${index}.data`,
      type: "file",
      mtime: EPOCH,
      body: encoder.encode(`deep ${index}\n`),
    });
  }

  for (const fatType of [12, 16, 32] as const) {
    const bytes = buildFat(entries, {
      ...BASE,
      sizeBytes: 64 * 1024 * 1024,
      fatType,
    });
    const geometry = describeFat(bytes);
    assertEquals(geometry.fatType, fatType);
    if (fatType !== 32) {
      assert(
        geometry.rootEntryCount > 512,
        `the root must grow past 512 entries (got ${geometry.rootEntryCount})`,
      );
    }

    const root = walkDirectory(bytes, "root");
    assertEquals(root.length, count + 1, `FAT${fatType} root entry count`);
    const deep = root.find((e) => e.name === "deep")!;
    assert(deep !== undefined && deep.isDir, "deep is a directory");
    const inner = walkDirectory(bytes, deep.cluster);
    // "." and ".." lead every subdirectory.
    assertEquals(inner[0].name, ".");
    assertEquals(inner[1].name, "..");
    assertEquals(inner.length, count + 2, `FAT${fatType} deep entry count`);

    // Every first cluster is distinct: an overlap is the shape where two files
    // share bytes and one of them silently wins.
    const clusters = [...root, ...inner]
      .filter((e) => e.name !== "." && e.name !== ".." && e.cluster !== 0)
      .map((e) => e.cluster);
    assertEquals(
      new Set(clusters).size,
      clusters.length,
      `FAT${fatType} allocated a cluster twice`,
    );

    // And every body is where its entry says it is.
    const check = (found: WalkedEntry[], prefix: string) => {
      for (const entry of found) {
        if (entry.isDir) continue;
        const index = Number(/(\d+)\./.exec(entry.name)?.[1]);
        const want = encoder.encode(`${prefix} ${index}\n`);
        assertEquals(entry.size, want.byteLength, `${entry.name} size`);
        const at = (geometry.firstDataSector +
          (entry.cluster - 2) * geometry.sectorsPerCluster) * SECTOR_BYTES;
        assertEquals(
          bytes.subarray(at, at + want.byteLength),
          want,
          `FAT${fatType} ${entry.name} body`,
        );
      }
    };
    check(root.filter((e) => !e.isDir), "root");
    check(inner.filter((e) => !e.isDir), "deep");
  }
});

Deno.test("cluster count decides the type at the FAT12/FAT16 boundary", () => {
  // 4084 clusters is the last FAT12 volume; 4085 is the first FAT16 one. A
  // writer that lands one cluster the wrong side produces a filesystem whose
  // type readers disagree about, so both sides are pinned here.
  const twelve = buildFat(esp(), {
    ...BASE,
    sizeBytes: largestAtSpc1(12, 1000, 8000) * SECTOR_BYTES,
    fatType: 12,
  });
  const sixteen = buildFat(esp(), {
    ...BASE,
    sizeBytes: smallestFor(16, 1000, 8000) * SECTOR_BYTES,
    fatType: 16,
  });
  assertEquals(describeFat(twelve).clusterCount, 4084);
  assertEquals(describeFat(twelve).fatType, 12);
  assertEquals(describeFat(sixteen).clusterCount, 4085);
  assertEquals(describeFat(sixteen).fatType, 16);
  assertEquals(CLUSTER_COUNT_THRESHOLDS.fat16, 4085);
});

Deno.test("cluster count decides the type at the FAT16/FAT32 boundary", () => {
  const sixteen = buildFat(esp(), {
    ...BASE,
    sizeBytes: largestAtSpc1(16, 4000, 90_000) * SECTOR_BYTES,
    fatType: 16,
  });
  const thirtyTwo = buildFat(esp(), {
    ...BASE,
    sizeBytes: smallestFor(32, 1000, 200_000) * SECTOR_BYTES,
    fatType: 32,
  });
  assertEquals(describeFat(sixteen).clusterCount, 65_524);
  assertEquals(describeFat(sixteen).fatType, 16);
  assertEquals(describeFat(thirtyTwo).clusterCount, 65_525);
  assertEquals(describeFat(thirtyTwo).fatType, 32);
  assertEquals(CLUSTER_COUNT_THRESHOLDS.fat32, 65_525);
});

Deno.test("the derived type always matches the requested one", () => {
  for (
    const [fatType, sizeBytes] of [
      [12, 8 * 1024 * 1024],
      [16, 33 * 1024 * 1024],
      [32, 64 * 1024 * 1024],
      [16, 528_482_304],
    ] as const
  ) {
    const bytes = buildFat(esp(), { ...BASE, sizeBytes, fatType });
    assertEquals(describeFat(bytes).fatType, fatType);
    assertEquals(bytes.byteLength, sizeBytes);
  }
});

Deno.test("the whole window is returned, so nothing reads through", () => {
  // On a qcow2 overlay an unwritten byte is not a zero byte — it is whatever
  // the backing file holds there.
  const sizeBytes = 33 * 1024 * 1024;
  const bytes = buildFat(esp(), { ...BASE, sizeBytes });
  assertEquals(bytes.byteLength, sizeBytes);
});

Deno.test("FAT32 has the structural fields FAT16 does not", () => {
  const bytes = buildFat(esp(), {
    ...BASE,
    sizeBytes: 64 * 1024 * 1024,
    fatType: 32,
  });
  const view = new DataView(bytes.buffer);
  assertEquals(view.getUint16(17, true), 0, "BPB_RootEntCnt must be 0");
  assertEquals(view.getUint16(22, true), 0, "BPB_FATSz16 must be 0");
  assertEquals(view.getUint16(19, true), 0, "BPB_TotSec16 must be 0");
  assert(view.getUint32(36, true) > 0, "BPB_FATSz32 must be set");
  assertEquals(view.getUint32(44, true), 2, "BPB_RootClus");
  assertEquals(view.getUint16(48, true), 1, "BPB_FSInfo");
  assertEquals(view.getUint16(50, true), 6, "BPB_BkBootSec");

  // FSInfo at sector 1: the three signatures the spec names.
  assertEquals(view.getUint32(SECTOR_BYTES + 0, true), 0x41615252);
  assertEquals(view.getUint32(SECTOR_BYTES + 484, true), 0x61417272);
  assertEquals(view.getUint32(SECTOR_BYTES + 508, true), 0xaa550000);

  // The backup pair at sector 6 is a real copy, not an empty reservation.
  const primary = bytes.subarray(0, SECTOR_BYTES);
  const backup = bytes.subarray(6 * SECTOR_BYTES, 7 * SECTOR_BYTES);
  assertEquals(backup, primary);
  const fsInfo = bytes.subarray(SECTOR_BYTES, 2 * SECTOR_BYTES);
  assertEquals(bytes.subarray(7 * SECTOR_BYTES, 8 * SECTOR_BYTES), fsInfo);
});

Deno.test("FAT12/16 keep the fixed root region and no FSInfo", () => {
  for (const fatType of [12, 16] as const) {
    const bytes = buildFat(esp(), {
      ...BASE,
      sizeBytes: 8 * 1024 * 1024,
      fatType,
    });
    const view = new DataView(bytes.buffer);
    assert(view.getUint16(17, true) >= 512, "BPB_RootEntCnt must be set");
    assert(view.getUint16(22, true) > 0, "BPB_FATSz16 must be set");
    // The FAT12/16 extended boot signature sits at 38, not 66 as on FAT32.
    assertEquals(bytes[38], 0x29, "BS_BootSig");
    assertEquals(view.getUint32(39, true), BASE.volumeId, "BS_VolID");
    assertEquals(
      new TextDecoder().decode(bytes.subarray(54, 62)),
      fatType === 12 ? "FAT12   " : "FAT16   ",
    );
    // There is no FSInfo and no backup boot sector on FAT12/16: sector 1 is
    // the first FAT, not a second signature block.
    assertEquals(view.getUint16(14, true), geometryReserved(bytes));
  }
});

/** `BPB_RsvdSecCnt` as the volume itself reports it. */
function geometryReserved(bytes: Uint8Array): number {
  return describeFat(bytes).reservedSectors;
}

Deno.test("an 8.3-clean name gets no long-name entries", () => {
  const bytes = buildFat(esp(), { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const at = rootDirOffset(bytes);
  const entries = dirEntries(bytes, at, 4);
  // [0] is the volume label, [1] is EFI — both plain short entries.
  assertEquals(entries[0][11], 0x08, "volume label attribute");
  assertEquals(name(entries[0]), "ESP        ");
  assertEquals(name(entries[1]), "EFI        ");
  assertEquals(entries[1][11], 0x10, "EFI is a plain directory entry");
  assertEquals(entries[2][0], 0x00, "and the root ends right after it");
});

Deno.test("a name needing a long entry gets one, with a valid checksum", () => {
  const bytes = buildFat([
    {
      path: "a rather long name.config",
      type: "file",
      mtime: EPOCH,
      body: encoder.encode("x"),
    },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const at = rootDirOffset(bytes);
  // [0] volume label, then the LFN run, then the short entry.
  const entries = dirEntries(bytes, at, 6);
  const lfn = entries.filter((e) => e[11] === 0x0f);
  assertEquals(lfn.length, 2, "25 code units needs two 13-unit entries");

  const short = entries.find((e) => e[11] !== 0x0f && e[11] !== 0x08)!;
  const want = checksum(short.subarray(0, 11));
  for (const entry of lfn) {
    assertEquals(entry[13], want, "LDIR_Chksum must bind to the short entry");
    assertEquals(
      new DataView(entry.buffer, entry.byteOffset).getUint16(26, true),
      0,
      "LDIR_FstClusLO must be zero",
    );
  }
  // Stored in reverse: the highest ordinal, flagged LAST_LONG_ENTRY, first.
  assertEquals(lfn[0][0], 0x40 | 2);
  assertEquals(lfn[1][0], 1);

  // And the name reassembles.
  const units: number[] = [];
  for (const entry of [lfn[1], lfn[0]]) {
    const view = new DataView(entry.buffer, entry.byteOffset);
    for (const slot of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) {
      const unit = view.getUint16(slot, true);
      if (unit === 0 || unit === 0xffff) continue;
      units.push(unit);
    }
  }
  assertEquals(String.fromCharCode(...units), "a rather long name.config");
});

Deno.test("lowercase forces a long name, because the short one is uppercase", () => {
  const bytes = buildFat([
    {
      path: "grub.cfg",
      type: "file",
      mtime: EPOCH,
      body: encoder.encode("set timeout=0\n"),
    },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const entries = dirEntries(bytes, rootDirOffset(bytes), 4);
  const lfn = entries.filter((e) => e[11] === 0x0f);
  assertEquals(lfn.length, 1);
  const short = entries.find((e) => e[11] === 0x20)!;
  assertEquals(name(short), "GRUB    CFG");
  assertEquals(lfn[0][13], checksum(short.subarray(0, 11)));
});

Deno.test("a zero-length file gets no cluster", () => {
  const bytes = buildFat([
    { path: "EMPTY.TXT", type: "file", mtime: EPOCH, body: new Uint8Array(0) },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const entries = dirEntries(bytes, rootDirOffset(bytes), 3);
  const short = entries.find((e) => e[11] === 0x20)!;
  const view = new DataView(short.buffer, short.byteOffset);
  assertEquals(name(short), "EMPTY   TXT");
  assertEquals(view.getUint32(28, true), 0, "DIR_FileSize");
  assertEquals(view.getUint16(20, true), 0, "DIR_FstClusHI");
  assertEquals(view.getUint16(26, true), 0, "DIR_FstClusLO");
});

Deno.test("the FAT's reserved entries carry the media byte and EOC", () => {
  for (
    const [fatType, sizeBytes, media, eoc] of [
      [12, 8 * 1024 * 1024, 0xff8, 0xfff],
      [16, 33 * 1024 * 1024, 0xfff8, 0xffff],
      [32, 64 * 1024 * 1024, 0x0ffffff8, 0x0fffffff],
    ] as const
  ) {
    const bytes = buildFat(esp(), { ...BASE, sizeBytes, fatType });
    const geometry = describeFat(bytes);
    const at = geometry.reservedSectors * SECTOR_BYTES;
    const view = new DataView(bytes.buffer);
    if (fatType === 12) {
      const zero = bytes[at] | ((bytes[at + 1] & 0x0f) << 8);
      const one = (bytes[at + 1] >> 4) | (bytes[at + 2] << 4);
      assertEquals(zero, media);
      assertEquals(one, eoc);
    } else if (fatType === 16) {
      assertEquals(view.getUint16(at, true), media);
      assertEquals(view.getUint16(at + 2, true), eoc);
    } else {
      assertEquals(view.getUint32(at, true), media);
      assertEquals(view.getUint32(at + 4, true), eoc);
    }
    // BPB_Media must equal the FAT[0] low byte.
    assertEquals(bytes[21], media & 0xff);
    // Both FAT copies are identical.
    const first = bytes.subarray(at, at + geometry.fatSectors * SECTOR_BYTES);
    const second = bytes.subarray(
      at + geometry.fatSectors * SECTOR_BYTES,
      at + 2 * geometry.fatSectors * SECTOR_BYTES,
    );
    assertEquals(first, second, `FAT${fatType} copies must mirror`);
  }
});

Deno.test("a multi-cluster file chains through the FAT and ends at EOC", () => {
  const size = 300_000;
  const body = new Uint8Array(size).fill(0xa5);
  const bytes = buildFat([
    { path: "BIG.BIN", type: "file", mtime: EPOCH, body },
  ], { ...BASE, sizeBytes: 33 * 1024 * 1024, fatType: 16 });
  const geometry = describeFat(bytes);
  const clusterBytes = geometry.sectorsPerCluster * SECTOR_BYTES;
  const expected = Math.ceil(size / clusterBytes);

  const short = dirEntries(bytes, rootDirOffset(bytes), 3)
    .find((e) => e[11] === 0x20)!;
  const view = new DataView(bytes.buffer);
  const first = new DataView(short.buffer, short.byteOffset)
    .getUint16(26, true);
  const fatAt = geometry.reservedSectors * SECTOR_BYTES;

  let cluster = first;
  let walked = 0;
  while (cluster < 0xfff8) {
    walked++;
    cluster = view.getUint16(fatAt + cluster * 2, true);
    assert(walked <= expected, "chain ran past the file's length");
  }
  assertEquals(walked, expected);
  assertEquals(cluster, 0xffff, "chain must end at EOC");

  // And the body landed where the entry says it did.
  const at = (geometry.firstDataSector +
    (first - 2) * geometry.sectorsPerCluster) * SECTOR_BYTES;
  assertEquals(bytes.subarray(at, at + size), body);
});

Deno.test("a FAT12 chain packs correctly across both nibble parities", () => {
  // Every other FAT12 entry straddles a byte boundary, so a chain long enough
  // to cover both parities is the only thing that exercises the packing. A
  // writer that gets the odd case wrong still produces a mountable volume —
  // with files whose tails come from somewhere else.
  const clusterBytes = 512; // spc=1 at this size
  const clusters = 37;
  const body = new Uint8Array(clusterBytes * clusters);
  for (let index = 0; index < body.length; index++) body[index] = index & 0xff;
  const bytes = buildFat([
    { path: "CHAIN.BIN", type: "file", mtime: EPOCH, body },
  ], { ...BASE, sizeBytes: 2_120_192, fatType: 12 });

  const geometry = describeFat(bytes);
  assertEquals(geometry.fatType, 12);
  assertEquals(geometry.sectorsPerCluster, 1);
  const fatAt = geometry.reservedSectors * SECTOR_BYTES;
  const read12 = (index: number) => {
    const at = fatAt + index + (index >> 1);
    return (index & 1) === 0
      ? bytes[at] | ((bytes[at + 1] & 0x0f) << 8)
      : (bytes[at] >> 4) | (bytes[at + 1] << 4);
  };

  const short = dirEntries(bytes, rootDirOffset(bytes), 3)
    .find((e) => e[11] === 0x20)!;
  const first = new DataView(short.buffer, short.byteOffset)
    .getUint16(26, true);

  const visited: number[] = [];
  let cluster = first;
  while (cluster < 0xff8) {
    visited.push(cluster);
    cluster = read12(cluster);
    assert(visited.length <= clusters, "chain ran past the file's length");
  }
  assertEquals(visited.length, clusters);
  assertEquals(cluster, 0xfff, "chain must end at EOC");
  // Contiguous, and covering both an even and an odd starting entry.
  assertEquals(visited, visited.map((_, i) => first + i));
  assert(
    visited.some((c) => (c & 1) === 0) && visited.some((c) => (c & 1) === 1),
    "the chain must span both nibble parities to be a real test",
  );

  const at = (geometry.firstDataSector + (first - 2)) * SECTOR_BYTES;
  assertEquals(bytes.subarray(at, at + body.length), body);
});

Deno.test("a subdirectory starts with dot and dotdot", () => {
  const bytes = buildFat(esp(), {
    ...BASE,
    sizeBytes: 8 * 1024 * 1024,
    fatType: 16,
  });
  const geometry = describeFat(bytes);
  const efi = dirEntries(bytes, rootDirOffset(bytes), 3)
    .find((e) => e[11] === 0x10)!;
  const cluster = new DataView(efi.buffer, efi.byteOffset).getUint16(26, true);
  const at = (geometry.firstDataSector +
    (cluster - 2) * geometry.sectorsPerCluster) * SECTOR_BYTES;
  const entries = dirEntries(bytes, at, 3);
  assertEquals(name(entries[0]), ".          ");
  assertEquals(name(entries[1]), "..         ");
  assertEquals(entries[0][11], 0x10);
  assertEquals(entries[1][11], 0x10);
  const dot = new DataView(entries[0].buffer, entries[0].byteOffset);
  const dotdot = new DataView(entries[1].buffer, entries[1].byteOffset);
  assertEquals(dot.getUint16(26, true), cluster, "`.` points at itself");
  // The parent is the root of a FAT16 volume, which has no cluster number.
  assertEquals(dotdot.getUint16(26, true), 0, "`..` to root is cluster 0");
});

Deno.test("timestamps come from the entry, packed in FAT's own format", () => {
  const bytes = buildFat([
    { path: "A.TXT", type: "file", mtime: EPOCH, body: encoder.encode("x") },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const short = dirEntries(bytes, rootDirOffset(bytes), 3)
    .find((e) => e[11] === 0x20)!;
  const view = new DataView(short.buffer, short.byteOffset);
  // 2023-11-14T22:13:20Z
  const date = view.getUint16(24, true);
  const time = view.getUint16(22, true);
  assertEquals((date >> 9) + 1980, 2023);
  assertEquals((date >> 5) & 0x0f, 11);
  assertEquals(date & 0x1f, 14);
  assertEquals(time >> 11, 22);
  assertEquals((time >> 5) & 0x3f, 13);
  assertEquals((time & 0x1f) * 2, 20);
});

Deno.test("a timestamp FAT cannot express is refused, not wrapped", () => {
  for (const mtime of [0, 315_532_799, 4_354_819_200]) {
    assertThrows(
      () =>
        buildFat([{ path: "A.TXT", type: "file", mtime }], {
          ...BASE,
          sizeBytes: 8 * 1024 * 1024,
        }),
      FatEntryError,
      "outside the range",
    );
  }
});

Deno.test("two builds of the same input are byte-identical", () => {
  for (const fatType of [12, 16, 32] as const) {
    const options = { ...BASE, sizeBytes: 64 * 1024 * 1024, fatType };
    assertEquals(buildFat(esp(), options), buildFat(esp(), options));
  }
});

Deno.test("a tree that does not fit is refused with the size that would", () => {
  const body = new Uint8Array(4 * 1024 * 1024).fill(1);
  const entries: FatEntry[] = [
    { path: "BIG.BIN", type: "file", mtime: EPOCH, body },
  ];
  const error = assertThrows(
    () => buildFat(entries, { ...BASE, sizeBytes: 2 * 1024 * 1024 }),
    FatGeometryError,
  ) as FatGeometryError;
  assert(
    error.message.includes("Grow the partition to at least"),
    `message must name the fix, got: ${error.message}`,
  );
  assert(error.requiredBytes !== undefined, "requiredBytes must be carried");
  // The number in the refusal is the number that works.
  const bytes = buildFat(entries, {
    ...BASE,
    sizeBytes: error.requiredBytes!,
  });
  assertEquals(bytes.byteLength, error.requiredBytes);
  // And one sector less does not.
  assertThrows(
    () =>
      buildFat(entries, {
        ...BASE,
        sizeBytes: error.requiredBytes! - SECTOR_BYTES,
      }),
    FatGeometryError,
  );
});

Deno.test("minimumFatSizeBytes returns a size that actually builds", () => {
  const entries = esp();
  for (const fatType of [12, 16, 32] as const) {
    const size = minimumFatSizeBytes(fatEntryShapes(entries), { fatType });
    const bytes = buildFat(entries, { ...BASE, sizeBytes: size, fatType });
    assertEquals(describeFat(bytes).fatType, fatType);
    assertThrows(
      () =>
        buildFat(entries, {
          ...BASE,
          sizeBytes: size - SECTOR_BYTES,
          fatType,
        }),
      FatGeometryError,
    );
  }
});

Deno.test("a window too small for the requested type names one that fits", () => {
  const error = assertThrows(
    () => buildFat(esp(), { ...BASE, sizeBytes: 1024 * 1024, fatType: 32 }),
    FatGeometryError,
  ) as FatGeometryError;
  assert(
    error.message.includes("fatType: 12"),
    `should suggest a workable type, got: ${error.message}`,
  );
});

Deno.test("a missing parent directory is refused, never invented", () => {
  assertThrows(
    () =>
      buildFat([{
        path: "EFI/BOOT/BOOTAA64.EFI",
        type: "file",
        mtime: EPOCH,
      }], { ...BASE, sizeBytes: 8 * 1024 * 1024 }),
    FatEntryError,
    "has no entry",
  );
});

Deno.test("malformed paths are refused", () => {
  const cases: Array<[string, string]> = [
    ["/EFI", "absolute"],
    ["EFI/", "trailing"],
    ["EFI//BOOT", "empty segment"],
    ["EFI/../x", '".."'],
    ["a:b", "reserves"],
    ["trailing ", "space or period"],
  ];
  for (const [path, needle] of cases) {
    assertThrows(
      () =>
        buildFat([{ path, type: "dir", mtime: EPOCH }], {
          ...BASE,
          sizeBytes: 8 * 1024 * 1024,
        }),
      FatEntryError,
      needle,
      `path ${JSON.stringify(path)} should be refused`,
    );
  }
});

Deno.test("a duplicate path is refused", () => {
  assertThrows(
    () =>
      buildFat([
        { path: "A.TXT", type: "file", mtime: EPOCH },
        { path: "A.TXT", type: "file", mtime: EPOCH },
      ], { ...BASE, sizeBytes: 8 * 1024 * 1024 }),
    FatEntryError,
    "declared twice",
  );
});

Deno.test("two paths differing only in case are refused, not both written", () => {
  // Measured against the pre-fix writer on macOS 26.5.2: this exact pair built
  // a volume `fsck_msdos -n` called clean, which mounted, whose readdir listed
  // both names, and where opening EITHER name returned the FIRST entry's bytes.
  // A valid image holding less than was staged is the failure this refuses.
  const error = assertThrows(
    () =>
      buildFat([
        {
          path: "a.txt",
          type: "file",
          mtime: EPOCH,
          body: encoder.encode("1"),
        },
        {
          path: "A.txt",
          type: "file",
          mtime: EPOCH,
          body: encoder.encode("2"),
        },
      ], { ...BASE, sizeBytes: 8 * 1024 * 1024 }),
    FatEntryError,
    "differs from",
  ) as FatEntryError;
  assert(
    error.message.includes("case-insensitively"),
    `the message must say why, got: ${error.message}`,
  );
  assertEquals(error.path, "A.txt");

  // Deeper than the root, and through a directory rather than a file.
  assertThrows(
    () =>
      buildFat([
        { path: "EFI", type: "dir", mtime: EPOCH },
        { path: "EFI/BOOT", type: "dir", mtime: EPOCH },
        { path: "EFI/boot", type: "dir", mtime: EPOCH },
      ], { ...BASE, sizeBytes: 8 * 1024 * 1024 }),
    FatEntryError,
    "differs from",
  );

  // A parent spelled differently by its child is named as such, rather than
  // reported as a directory that is right there in the caller's own list.
  assertThrows(
    () =>
      buildFat([
        { path: "EFI", type: "dir", mtime: EPOCH },
        { path: "efi/BOOTAA64.EFI", type: "file", mtime: EPOCH },
      ], { ...BASE, sizeBytes: 8 * 1024 * 1024 }),
    FatEntryError,
    "differs only in case",
  );
});

Deno.test("case folding is per code unit, so distinct names stay distinct", () => {
  // `"ß".toUpperCase()` is "SS", two code units. Folding through that would
  // refuse this pair as a collision, and they are two different names to every
  // FAT implementation, whose upcase tables map one code unit to one.
  const bytes = buildFat([
    { path: "straße.txt", type: "file", mtime: EPOCH },
    { path: "STRASSE.txt", type: "file", mtime: EPOCH },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  assertEquals(describeFat(bytes).clusterCount > 0, true);
});

Deno.test("colliding short names get distinct numeric tails", () => {
  const bytes = buildFat([
    { path: "a long name one.txt", type: "file", mtime: EPOCH },
    { path: "a long name two.txt", type: "file", mtime: EPOCH },
    { path: "a long name three.txt", type: "file", mtime: EPOCH },
  ], { ...BASE, sizeBytes: 8 * 1024 * 1024 });
  const shorts = dirEntries(bytes, rootDirOffset(bytes), 24)
    .filter((e) => e[11] === 0x20)
    .map((e) => name(e));
  assertEquals(shorts.length, 3);
  assertEquals(new Set(shorts).size, 3, `short names collided: ${shorts}`);
  assert(shorts.some((s) => s.includes("~")), `expected a tail: ${shorts}`);
});

/** A root directory too big for `BPB_RootEntCnt`, which is a uint16. */
function hugeRoot(count: number): FatEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `file-${index}.txt`,
    type: "file" as const,
    mtime: EPOCH,
  }));
}

Deno.test("an explicit fatType: 32 is not refused by the FAT12/16 root ceiling", () => {
  // The ceiling was applied before options.fatType was consulted, so this
  // refused `fatType: 32` with a message telling the caller to pass
  // `fatType: 32`. FAT32's root is an ordinary cluster chain and has no such
  // limit, so the only correct answer here is a volume.
  const entries = hugeRoot(40_000);
  const bytes = buildFat(entries, {
    ...BASE,
    sizeBytes: 256 * 1024 * 1024,
    fatType: 32,
  });
  const geometry = describeFat(bytes);
  assertEquals(geometry.fatType, 32);
  assertEquals(geometry.rootEntryCount, 0);

  // FAT16 for the same tree is still refused, and says how to proceed.
  const error = assertThrows(
    () =>
      buildFat(entries, {
        ...BASE,
        sizeBytes: 256 * 1024 * 1024,
        fatType: 16,
      }),
    FatGeometryError,
    "a FAT12/16 BPB can describe",
  ) as FatGeometryError;
  assert(
    error.message.includes("fatType: 32"),
    `the FAT16 refusal must name the fix, got: ${error.message}`,
  );

  // And with no type pinned, the default resolves to 32 by itself rather than
  // picking FAT16 and truncating BPB_RootEntCnt into a uint16.
  assertEquals(
    describeFat(buildFat(entries, { ...BASE, sizeBytes: 256 * 1024 * 1024 }))
      .fatType,
    32,
  );
});

Deno.test("BPB_RsvdSecCnt is the spec's value: 1 on FAT12/16, 32 on FAT32", () => {
  // "For FAT12 and FAT16 volumes, this value should never be anything other
  // than 1. For FAT32 volumes, this value is typically 32." Apple's own
  // newfs_msdos agrees: measured on macOS 26.5.2, a 40 MiB FAT16 volume comes
  // back res=1 spc=4, and a 400 MiB FAT32 one res=32 spc=8.
  let sawMultiSectorCluster = false;
  for (
    const [fatType, sizeBytes, want] of [
      // Sizes chosen to land on several different cluster sizes, because
      // padding the reserved region for cluster alignment is exactly what
      // would push this above the spec's number, and it can only do so when a
      // cluster is more than one sector.
      [12, 1024 * 1024, 1],
      [12, 8 * 1024 * 1024, 1],
      [12, 64 * 1024 * 1024, 1],
      [16, 4 * 1024 * 1024, 1],
      [16, 33 * 1024 * 1024, 1],
      [16, 200 * 1024 * 1024, 1],
      [32, 64 * 1024 * 1024, 32],
      [32, 128 * 1024 * 1024, 32],
    ] as const
  ) {
    const geometry = describeFat(
      buildFat(esp(), { ...BASE, sizeBytes, fatType }),
    );
    assertEquals(
      geometry.reservedSectors,
      want,
      `FAT${fatType} at ${sizeBytes} bytes (spc ${geometry.sectorsPerCluster})`,
    );
    if (fatType !== 32 && geometry.sectorsPerCluster > 1) {
      sawMultiSectorCluster = true;
      // The first data sector is deliberately NOT cluster-aligned. Apple's
      // newfs_msdos leaves it unaligned too (193 on the measured FAT16).
      assert(
        geometry.firstDataSector % geometry.sectorsPerCluster !== 0,
        "expected an unpadded reserved region, so the data region starts " +
          `wherever the FATs end (${geometry.firstDataSector})`,
      );
    }
  }
  assert(
    sawMultiSectorCluster,
    "the FAT12/16 cases must include a multi-sector cluster, or this test " +
      "cannot see alignment padding come back",
  );
});

Deno.test("hiddenSectors is checked, not coerced into a wrong uint32", () => {
  const size = 8 * 1024 * 1024;
  // Every one of these reaches DataView.setUint32 as a DIFFERENT number:
  // 2^32 lands as 0, -1 as 0xFFFFFFFF, 1.5 as 1, NaN as 0.
  for (const hiddenSectors of [0x1_0000_0000, -1, 1.5, NaN, Infinity]) {
    assertThrows(
      () => buildFat([], { ...BASE, sizeBytes: size, hiddenSectors }),
      FatGeometryError,
      "is not a uint32",
      `hiddenSectors ${hiddenSectors} should be refused`,
    );
  }
  // The legal extremes still write, and land in BPB_HiddSec little-endian.
  for (const hiddenSectors of [0, 2048, 0xffffffff]) {
    const bytes = buildFat([], { ...BASE, sizeBytes: size, hiddenSectors });
    assertEquals(
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(28, true),
      hiddenSectors,
    );
  }
});

Deno.test("fatGeometryFor answers from lengths what buildFat answers from bytes", () => {
  const entries = esp();
  const shapes = fatEntryShapes(entries);
  assertEquals(shapes, [
    { path: "EFI", type: "dir", sizeBytes: 0 },
    { path: "EFI/BOOT", type: "dir", sizeBytes: 0 },
    { path: "EFI/BOOT/BOOTAA64.EFI", type: "file", sizeBytes: 13 },
  ]);
  for (const fatType of [12, 16, 32] as const) {
    const sizeBytes = 33 * 1024 * 1024;
    assertEquals(
      fatGeometryFor(shapes, { sizeBytes, fatType }),
      describeFat(buildFat(entries, { ...BASE, sizeBytes, fatType })),
    );
  }
  // And it refuses exactly where buildFat would, carrying the same number.
  const big: FatEntryShape[] = [
    { path: "BIG.BIN", type: "file", sizeBytes: 4 * 1024 * 1024 },
  ];
  const error = assertThrows(
    () => fatGeometryFor(big, { sizeBytes: 2 * 1024 * 1024 }),
    FatGeometryError,
  ) as FatGeometryError;
  assertEquals(
    error.requiredBytes,
    minimumFatSizeBytes(big),
  );
  assertThrows(
    () =>
      buildFat([{
        path: "BIG.BIN",
        type: "file",
        mtime: EPOCH,
        body: new Uint8Array(4 * 1024 * 1024),
      }], { ...BASE, sizeBytes: 2 * 1024 * 1024 }),
    FatGeometryError,
  );
});

Deno.test("bad options are refused", () => {
  const size = 8 * 1024 * 1024;
  assertThrows(
    () => buildFat([], { ...BASE, sizeBytes: size + 1 }),
    FatGeometryError,
    "whole number of",
  );
  assertThrows(
    () => buildFat([], { ...BASE, sizeBytes: size, volumeId: -1 }),
    FatGeometryError,
    "uint32",
  );
  assertThrows(
    () =>
      buildFat([], {
        ...BASE,
        sizeBytes: size,
        // Reachable only from untyped JavaScript, and worth a named refusal
        // rather than a geometry search that happens to fail.
        fatType: 24 as unknown as 12,
      }),
    FatGeometryError,
    "not one of 12, 16 or 32",
  );
  assertThrows(
    () => buildFat([], { ...BASE, sizeBytes: size, label: "esp" }),
    FatGeometryError,
    "lowercase",
  );
  assertThrows(
    () => buildFat([], { ...BASE, sizeBytes: size, label: "TWELVE CHARS" }),
    FatGeometryError,
    "over the 11",
  );
});

Deno.test("an empty label becomes the conventional NO NAME", () => {
  const bytes = buildFat([], {
    ...BASE,
    sizeBytes: 8 * 1024 * 1024,
    label: "",
  });
  assertEquals(
    name(dirEntries(bytes, rootDirOffset(bytes), 1)[0]),
    "NO NAME    ",
  );
});

Deno.test("describeFat rejects bytes that are not a boot sector", () => {
  assertThrows(
    () => describeFat(new Uint8Array(SECTOR_BYTES)),
    FatGeometryError,
    "0x55AA",
  );
  assertThrows(
    () => describeFat(new Uint8Array(16)),
    FatGeometryError,
    "too short",
  );
});
