import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DIR_ENTRY_BYTES,
  FatLayoutError,
  normalizeFatTimestamps,
} from "../../src/fs/fat.ts";

/**
 * Scratch under `tests/.tmp`, the only path `deno task test` may write.
 * `makeTempDir` does not create parents, so the directory is made first.
 */
async function scratch(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

const SECTOR = 512;
const ROOT_ENTRIES = 16;
/** 2023-11-14T22:13:20Z — the system smoke's own `sourceDateEpoch`. */
const EPOCH = 1_700_000_000;
/** What that epoch encodes to, measured against the bytes vvfat writes. */
const WANT_DATE = 0x576e;
const WANT_TIME = 0xb1aa;

const ATTR_DIR = 0x10;
const ATTR_ARCHIVE = 0x20;
const ATTR_VOLUME_ID = 0x08;
const ATTR_LFN = 0x0f;

/** A distinctive non-pinned time, so a field left alone is visible. */
const STALE_TIME = 0x1234;
const STALE_DATE = 0x5cf6;

/** Build one 8.3 directory entry with deliberately stale creation fields. */
function entry(
  name: string,
  attr: number,
  cluster = 0,
  wrtTime = 0x9999,
  wrtDate = 0x8888,
): Uint8Array {
  const out = new Uint8Array(DIR_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  out.fill(0x20, 0, 11);
  for (let i = 0; i < name.length && i < 11; i++) {
    out[i] = name.charCodeAt(i);
  }
  out[11] = attr;
  out[13] = 0x63; // CrtTimeTenth, stale
  view.setUint16(14, STALE_TIME, true); // CrtTime
  view.setUint16(16, STALE_DATE, true); // CrtDate
  view.setUint16(18, STALE_DATE, true); // LstAccDate
  view.setUint16(20, (cluster >>> 16) & 0xffff, true); // FstClusHI
  view.setUint16(22, wrtTime, true);
  view.setUint16(24, wrtDate, true);
  view.setUint16(26, cluster & 0xffff, true); // FstClusLO
  return out;
}

/**
 * Build one long-file-name fragment.
 *
 * Byte 14 is the low byte of the 6th name character — exactly the offset
 * `DIR_CrtTime` occupies in a real entry, which is what makes this the one
 * entry kind a timestamp walk must not touch.
 */
function lfnEntry(seq: number, chars: string, last: boolean): Uint8Array {
  const out = new Uint8Array(DIR_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  out[0] = last ? seq | 0x40 : seq;
  out[11] = ATTR_LFN;
  out[12] = 0;
  out[13] = 0x54; // checksum
  const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  for (let i = 0; i < slots.length; i++) {
    const code = i < chars.length ? chars.charCodeAt(i) : 0xffff;
    view.setUint16(slots[i], code, true);
  }
  return out;
}

/** How many FAT sectors a cluster count needs at the given width. */
function fatSectorsFor(type: 12 | 16, clusters: number): number {
  const bytes = type === 12
    ? Math.ceil((clusters + 2) * 3 / 2)
    : (clusters + 2) * 2;
  return Math.ceil(bytes / SECTOR);
}

/** Write one allocation-table entry at the right width. */
function setFat(
  fat: Uint8Array,
  type: 12 | 16,
  cluster: number,
  value: number,
): void {
  if (type === 16) {
    fat[cluster * 2] = value & 0xff;
    fat[cluster * 2 + 1] = (value >> 8) & 0xff;
    return;
  }
  const at = cluster + (cluster >> 1);
  const pair = fat[at] | (fat[at + 1] << 8);
  const next = (cluster & 1) !== 0
    ? (pair & 0x000f) | ((value & 0xfff) << 4)
    : (pair & 0xf000) | (value & 0xfff);
  fat[at] = next & 0xff;
  fat[at + 1] = (next >> 8) & 0xff;
}

/** A complete FAT12 or FAT16 image, laid out one sector per cluster. */
function fatImage(options: {
  type: 12 | 16;
  clusters: number;
  root: readonly Uint8Array[];
  /** Cluster number to the entries stored in it. */
  data?: ReadonlyMap<number, readonly Uint8Array[]>;
  /** Cluster number to the next cluster in its chain. */
  chain?: ReadonlyMap<number, number>;
}): Uint8Array {
  const { type, clusters } = options;
  const fatSectors = fatSectorsFor(type, clusters);
  const rootSectors = ROOT_ENTRIES * DIR_ENTRY_BYTES / SECTOR;
  const firstDataSector = 1 + 2 * fatSectors + rootSectors;
  const totalSectors = firstDataSector + clusters;
  const image = new Uint8Array(totalSectors * SECTOR);
  const view = new DataView(image.buffer);

  image[0] = 0xeb;
  image[1] = 0x3e;
  image[2] = 0x90;
  image.set(new TextEncoder().encode("MSWIN4.1"), 3);
  view.setUint16(11, SECTOR, true); // BytsPerSec
  image[13] = 1; // SecPerClus
  view.setUint16(14, 1, true); // RsvdSecCnt
  image[16] = 2; // NumFATs
  view.setUint16(17, ROOT_ENTRIES, true); // RootEntCnt
  view.setUint16(19, 0, true); // TotSec16
  image[21] = 0xf8; // Media
  view.setUint16(22, fatSectors, true); // FATSz16
  view.setUint32(32, totalSectors, true); // TotSec32

  const fat = new Uint8Array(fatSectors * SECTOR);
  setFat(fat, type, 0, type === 12 ? 0xff8 : 0xfff8);
  setFat(fat, type, 1, type === 12 ? 0xfff : 0xffff);
  const eoc = type === 12 ? 0xfff : 0xffff;
  for (let c = 2; c < clusters + 2; c++) {
    setFat(fat, type, c, options.chain?.get(c) ?? eoc);
  }
  image.set(fat, 1 * SECTOR);
  image.set(fat, (1 + fatSectors) * SECTOR);

  const rootAt = (1 + 2 * fatSectors) * SECTOR;
  options.root.forEach((e, i) => image.set(e, rootAt + i * DIR_ENTRY_BYTES));

  const data: ReadonlyMap<number, readonly Uint8Array[]> = options.data ??
    new Map();
  for (const [cluster, entries] of data) {
    const at = (firstDataSector + (cluster - 2)) * SECTOR;
    entries.forEach((e, i) => image.set(e, at + i * DIR_ENTRY_BYTES));
  }
  return image;
}

/** Offsets of the root directory region and of each data cluster. */
function geometry(type: 12 | 16, clusters: number) {
  const fatSectors = fatSectorsFor(type, clusters);
  const rootSectors = ROOT_ENTRIES * DIR_ENTRY_BYTES / SECTOR;
  const rootAt = (1 + 2 * fatSectors) * SECTOR;
  const firstDataSector = 1 + 2 * fatSectors + rootSectors;
  return {
    rootAt,
    clusterAt: (c: number) => (firstDataSector + (c - 2)) * SECTOR,
  };
}

/** Write the image, normalize it, and read it back. */
async function roundTrip(image: Uint8Array, epoch = EPOCH) {
  const dir = await scratch();
  try {
    const path = `${dir}/fat.img`;
    await Deno.writeFile(path, image);
    const report = await normalizeFatTimestamps(path, { epochSeconds: epoch });
    return { report, after: await Deno.readFile(path) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The five fields at a given entry offset. */
function fieldsAt(image: Uint8Array, at: number) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  return {
    crtTenth: image[at + 13],
    crtTime: view.getUint16(at + 14, true),
    crtDate: view.getUint16(at + 16, true),
    lstAccDate: view.getUint16(at + 18, true),
    wrtTime: view.getUint16(at + 22, true),
    wrtDate: view.getUint16(at + 24, true),
  };
}

Deno.test("a long-name fragment is left byte-for-byte alone", async () => {
  // The exact shape the smoke's ESP produces: an LFN chain then its 8.3
  // entry. Byte 14 of the fragment is the `A` of `AA64`, at the offset
  // DIR_CrtTime occupies in a real entry.
  const lfn = lfnEntry(1, "BOOTAA64.EFI", true);
  assertEquals(lfn[14], "A".charCodeAt(0), "byte 14 is name data, not a time");
  const short = entry("BOOTAA64EFI", ATTR_ARCHIVE);
  const image = fatImage({ type: 16, clusters: 5000, root: [lfn, short] });
  const { report, after } = await roundTrip(image);
  const { rootAt } = geometry(16, 5000);

  assertEquals(
    after.slice(rootAt, rootAt + DIR_ENTRY_BYTES),
    lfn,
    "the long-name fragment must be untouched",
  );
  assertEquals(report.longNameEntriesSkipped, 1);
  const stamped = fieldsAt(after, rootAt + DIR_ENTRY_BYTES);
  assertEquals(stamped.crtTime, WANT_TIME);
  assertEquals(stamped.crtDate, WANT_DATE);
  assertEquals(stamped.lstAccDate, WANT_DATE);
  assertEquals(stamped.crtTenth, 0);
});

Deno.test("write times are not touched, so mtime pinning stays tested", async () => {
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [entry("FILE    TXT", ATTR_ARCHIVE, 0, 0x9999, 0x8888)],
  });
  const { after } = await roundTrip(image);
  const { rootAt } = geometry(16, 5000);
  const f = fieldsAt(after, rootAt);
  assertEquals(f.wrtTime, 0x9999);
  assertEquals(f.wrtDate, 0x8888);
  assertEquals(f.crtTime, WANT_TIME);
});

Deno.test("the volume label keeps its zeroed time fields", async () => {
  const label = entry("EFI        ", ATTR_VOLUME_ID | ATTR_ARCHIVE);
  const image = fatImage({ type: 16, clusters: 5000, root: [label] });
  const { report, after } = await roundTrip(image);
  const { rootAt } = geometry(16, 5000);
  assertEquals(after.slice(rootAt, rootAt + DIR_ENTRY_BYTES), label);
  assertEquals(report.entriesStamped, 0);
});

Deno.test("`.` and `..` in a subdirectory are stamped, and not followed", async () => {
  const sub = entry("SUB        ", ATTR_DIR, 2);
  const dot = entry(".          ", ATTR_DIR, 2);
  const dotdot = entry("..         ", ATTR_DIR, 0);
  const file = entry("INNER   TXT", ATTR_ARCHIVE, 3);
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [sub],
    data: new Map([[2, [dot, dotdot, file]]]),
  });
  const { report, after } = await roundTrip(image);
  const { clusterAt } = geometry(16, 5000);
  const at = clusterAt(2);
  for (const i of [0, 1, 2]) {
    const f = fieldsAt(after, at + i * DIR_ENTRY_BYTES);
    assertEquals(f.crtTime, WANT_TIME, `entry ${i} creation time`);
    assertEquals(f.crtDate, WANT_DATE, `entry ${i} creation date`);
  }
  // root + SUB, and no runaway walk through `.` or `..`.
  assertEquals(report.directories, 2);
  assertEquals(report.entriesStamped, 4);
});

Deno.test("a directory spanning two clusters is walked to the end", async () => {
  const sub = entry("SUB        ", ATTR_DIR, 2);
  // 16 entries fill cluster 2 exactly; the 17th lives in cluster 3.
  const first = [
    entry(".          ", ATTR_DIR, 2),
    entry("..         ", ATTR_DIR, 0),
    ...Array.from(
      { length: 14 },
      (_, i) => entry(`F${String(i).padStart(7, "0")}TXT`, ATTR_ARCHIVE),
    ),
  ];
  const second = [entry("SPILLED TXT", ATTR_ARCHIVE)];
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [sub],
    data: new Map([[2, first], [3, second]]),
    chain: new Map([[2, 3]]),
  });
  const { report, after } = await roundTrip(image);
  const { clusterAt } = geometry(16, 5000);
  const spilled = fieldsAt(after, clusterAt(3));
  assertEquals(
    spilled.crtTime,
    WANT_TIME,
    "the entry past the first cluster must be stamped too",
  );
  assertEquals(report.entriesStamped, 1 + 16 + 1);
});

Deno.test("deleted and free entries are skipped", async () => {
  const deleted = entry("GONE    TXT", ATTR_ARCHIVE);
  deleted[0] = 0xe5;
  const live = entry("LIVE    TXT", ATTR_ARCHIVE);
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [deleted, live],
  });
  const { report, after } = await roundTrip(image);
  const { rootAt } = geometry(16, 5000);
  assertEquals(
    after.slice(rootAt, rootAt + DIR_ENTRY_BYTES),
    deleted,
    "a deleted entry is not resurrected with new timestamps",
  );
  assertEquals(report.entriesStamped, 1);
  // Everything past the last live entry is free, and stays zero.
  const tail = after.slice(rootAt + 2 * DIR_ENTRY_BYTES, rootAt + 512);
  assert(tail.every((b) => b === 0), "free entries stay zeroed");
});

Deno.test("FAT12 chains are followed at the narrower entry width", async () => {
  const sub = entry("SUB        ", ATTR_DIR, 2);
  const image = fatImage({
    type: 12,
    clusters: 100,
    root: [sub],
    data: new Map([
      [2, [entry(".          ", ATTR_DIR, 2), entry("..         ", ATTR_DIR)]],
      [3, [entry("SPILLED TXT", ATTR_ARCHIVE)]],
    ]),
    // Cluster 2 is even and cluster 3 odd, so this exercises both halves of
    // the packed 12-bit entry.
    chain: new Map([[2, 3]]),
  });
  const { report, after } = await roundTrip(image);
  assertEquals(report.fatType, 12);
  const { clusterAt } = geometry(12, 100);
  assertEquals(fieldsAt(after, clusterAt(3)).crtTime, WANT_TIME);
  assertEquals(report.entriesStamped, 4);
});

Deno.test("an entry after a free slot is still reached", async () => {
  // A conformant directory ends at the first 0x00, so a walk may stop there.
  // This one does not stop: an entry stranded past a hole would otherwise
  // keep the unpinned creation time that makes the layer non-reproducible,
  // and nothing downstream would report it.
  const stranded = entry("AFTERGAPTXT", ATTR_ARCHIVE);
  const root = [entry("FIRST   TXT", ATTR_ARCHIVE)];
  const image = fatImage({ type: 16, clusters: 5000, root });
  const { rootAt } = geometry(16, 5000);
  // Slot 1 stays free; the stranded entry goes in slot 2.
  image.set(stranded, rootAt + 2 * DIR_ENTRY_BYTES);

  const { report, after } = await roundTrip(image);
  assertEquals(
    fieldsAt(after, rootAt + 2 * DIR_ENTRY_BYTES).crtTime,
    WANT_TIME,
  );
  assertEquals(report.entriesStamped, 2);
  const gap = after.slice(
    rootAt + DIR_ENTRY_BYTES,
    rootAt + 2 * DIR_ENTRY_BYTES,
  );
  assert(gap.every((b) => b === 0), "the free slot itself stays zeroed");
});

Deno.test("normalizing is idempotent, which is the whole point", async () => {
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [
      lfnEntry(1, "BOOTAA64.EFI", true),
      entry("BOOTAA64EFI", ATTR_ARCHIVE),
      entry("SUB        ", ATTR_DIR, 2),
    ],
    data: new Map([[2, [
      entry(".          ", ATTR_DIR, 2),
      entry("..         ", ATTR_DIR),
    ]]]),
  });
  const dir = await scratch();
  try {
    const path = `${dir}/fat.img`;
    await Deno.writeFile(path, image);
    await normalizeFatTimestamps(path, { epochSeconds: EPOCH });
    const once = await Deno.readFile(path);
    await normalizeFatTimestamps(path, { epochSeconds: EPOCH });
    assertEquals(await Deno.readFile(path), once);
    // And a second image built the same way lands on the same bytes.
    const other = `${dir}/other.img`;
    await Deno.writeFile(other, image);
    await normalizeFatTimestamps(other, { epochSeconds: EPOCH });
    assertEquals(await Deno.readFile(other), once);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a year outside FAT's range is refused, not wrapped", async () => {
  const image = fatImage({
    type: 16,
    clusters: 5000,
    root: [entry("FILE    TXT", ATTR_ARCHIVE)],
  });
  const dir = await scratch();
  try {
    const path = `${dir}/fat.img`;
    await Deno.writeFile(path, image);
    // 1970: before FAT's 1980 epoch, so the 7-bit year would wrap.
    const error = await assertRejects(
      () => normalizeFatTimestamps(path, { epochSeconds: 0 }),
      FatLayoutError,
    );
    assert(
      error.message.includes("1970") && error.message.includes("1980"),
      `names the year and the range: ${error.message}`,
    );
    assertEquals(
      await Deno.readFile(path),
      image,
      "a refused normalization writes nothing",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an image that is not FAT is refused rather than stamped", async () => {
  const dir = await scratch();
  try {
    const path = `${dir}/not-fat.img`;
    await Deno.writeFile(path, new Uint8Array(64 * 1024));
    await assertRejects(
      () => normalizeFatTimestamps(path, { epochSeconds: EPOCH }),
      FatLayoutError,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
