/**
 * GPT reader, diagnosis and repair — the other direction from
 * {@linkcode ../fs/gpt.ts | buildGpt}, which only ever writes.
 *
 * `qemu-img resize` moves the end of the disk, and a GPT stores its backup
 * header **in the last sector**. Growing strands that backup mid-disk and
 * leaves both headers claiming a `LastUsableLBA` from the old size; shrinking
 * discards it outright. Nothing raises an error: the primary header still
 * self-verifies, so the image boots and `qemu-img check` is clean. The damage
 * is in the tail bytes — the backup header is no longer in the disk's last
 * sector, where the 1.0 spec requires it. Independent parsers do not shout
 * about it: measured on macOS 25.5 (`deno task smoke:block`), `diskutil list`
 * parses a grown table and names its partitions without complaint, and
 * `gpt -r show` exits 0 with no warning, betraying the damage only by omitting
 * the `Sec GPT header`/`Sec GPT table` rows a healthy disk ends with. This
 * module is what reads those tail bytes back and says what is wrong.
 *
 * (cloud-utils' `growpart` is sometimes cast as a victim of this; it is the
 * opposite. Its sgdisk/sfdisk providers RELOCATE a stale secondary header to
 * the disk end *before* growing a partition, so growpart repairs this rather
 * than tripping over it. That is reasoned from cloud-utils' documented
 * behavior, unmeasured here: growpart is Linux-only and this package never
 * runs it.)
 *
 * Repairing that needs no `sgdisk` and no Linux — it is a few hundred bytes of
 * header arithmetic over two windows at either end of the disk. What it does
 * need is a refusal: after a shrink, a partition can extend past the new last
 * usable LBA, and rewriting the table to fit would produce a valid GPT
 * describing a filesystem whose tail is gone. That is
 * {@linkcode ./errors.ts | GptRepairRefusedError}, and it is the point of this
 * module.
 *
 * Everything here is pure byte arithmetic over a {@linkcode DiskView}, so the
 * same code serves an in-memory image and a 40 GiB qcow2 read through two
 * `raw` windows — see {@linkcode ./image.ts | repairGptImage}.
 *
 * @module
 */

import { bytesToGuid, crc32, guidToBytes } from "../fs/gpt.ts";
import { GptParseError, GptRepairRefusedError } from "./errors.ts";

/** The GPT header signature, at the start of the header sector. */
export const GPT_SIGNATURE = "EFI PART";

/** Bytes of header the 1.0 spec defines; `HeaderSize` may be larger. */
export const HEADER_MIN_BYTES = 92;

/** The all-zero type GUID, which marks an entry slot as unused. */
export const UNUSED_TYPE_GUID = "00000000-0000-0000-0000-000000000000";

/**
 * Largest entry array this reader will allocate for, in bytes.
 *
 * `NumberOfPartitionEntries` and `SizeOfPartitionEntry` are attacker- (or
 * corruption-) controlled u32s straight off the disk, and their product is
 * what a naive reader allocates. A conventional table is 16 KiB; 4 MiB is
 * generous and finite.
 */
export const MAX_ENTRY_ARRAY_BYTES = 4 * 1024 * 1024;

/** A logical sector size this reader supports. */
export type SectorSize = 512 | 4096;

/** One GPT header, as read off the disk. */
export interface GptHeader {
  /** Revision, packed as on disk (`0x00010000` is 1.0). */
  readonly revision: number;
  /** `HeaderSize`: bytes the header CRC covers. */
  readonly headerSizeBytes: number;
  /** The `HeaderCRC32` field's recorded value. */
  readonly headerCrc32: number;
  /** `MyLBA`: the sector this header claims to live in. */
  readonly myLba: number;
  /** `AlternateLBA`: where this header claims its counterpart lives. */
  readonly alternateLba: number;
  /** First LBA a partition may use. */
  readonly firstUsableLba: number;
  /** Last LBA a partition may use. */
  readonly lastUsableLba: number;
  /** Disk GUID, canonical string form. */
  readonly diskGuid: string;
  /** `PartitionEntryLBA`: where this header's entry array starts. */
  readonly entryArrayLba: number;
  /** `NumberOfPartitionEntries`. */
  readonly entryCount: number;
  /** `SizeOfPartitionEntry`. */
  readonly entrySizeBytes: number;
  /** The `PartitionEntryArrayCRC32` field's recorded value. */
  readonly entriesCrc32: number;
}

/** One partition entry read back from a table. */
export interface GptEntry {
  /** Slot number in the entry array, zero-based. */
  readonly index: number;
  /** Partition type GUID, canonical string form. */
  readonly typeGuid: string;
  /** Unique partition GUID, canonical string form. */
  readonly uniqueGuid: string;
  /** First logical block, inclusive. */
  readonly firstLba: number;
  /** Last logical block, inclusive. */
  readonly lastLba: number;
  /** Attribute flags. */
  readonly attributes: bigint;
  /** Partition name, decoded from UTF-16LE. */
  readonly name: string;
}

/** How well one side of the table read back. */
export type GptSideStatus =
  /** Header and entry array both verified. */
  | "ok"
  /** A header is there, but its own CRC does not check out. */
  | "bad-header-crc"
  /** The header verifies; the entry array it points at does not. */
  | "bad-entries-crc"
  /** No `EFI PART` at this sector. */
  | "no-signature"
  /** These bytes were never fetched (a windowed read that did not cover them). */
  | "unread"
  /** A header shaped in a way this reader will not follow. */
  | "unsupported";

/** One side of the table — primary, backup, or a stranded leftover. */
export interface GptSide {
  /** The sector this side was read from. */
  readonly lba: number;
  /** How well it read back. */
  readonly status: GptSideStatus;
  /** The header, when one was found (even if its CRC failed). */
  readonly header?: GptHeader;
  /** Used entry slots only, in slot order. */
  readonly entries: readonly GptEntry[];
  /** The entry array exactly as stored, when it was read. */
  readonly entryBytes?: Uint8Array;
  /** Why the status is not `ok`, when that needs saying. */
  readonly note?: string;
}

/** A whole disk's partition table, both sides, as found. */
export interface ParsedGpt {
  /** Logical sector size the table was read at. */
  readonly sectorSize: SectorSize;
  /** The disk's current size in bytes. */
  readonly diskSizeBytes: number;
  /** Sectors the disk currently holds. */
  readonly totalSectors: number;
  /** Whether LBA 0 carries a 0xEE protective MBR. */
  readonly protectiveMbr: boolean;
  /** The primary side, always read from LBA 1. */
  readonly primary: GptSide;
  /** The backup side, read from the disk's last sector. */
  readonly backup: GptSide;
  /**
   * A backup header found where the primary points, when that is *not* the
   * last sector — the signature of a grow. Absent otherwise.
   */
  readonly stranded?: GptSide;
}

/**
 * The bytes of a disk, which need not all be present.
 *
 * A GPT occupies two small ranges at opposite ends of the disk, so repairing
 * a 40 GiB qcow2 does not mean reading 40 GiB. A view built from fragments
 * answers reads inside them and reports every other range as absent, which is
 * what lets one parser serve both an in-memory image and a windowed one.
 */
export class DiskView {
  /** The disk's size in bytes, whether or not the bytes are all here. */
  readonly diskSizeBytes: number;
  readonly #fragments: readonly { offsetBytes: number; bytes: Uint8Array }[];

  /** Build a view over a set of byte ranges. */
  constructor(
    diskSizeBytes: number,
    fragments: readonly { offsetBytes: number; bytes: Uint8Array }[],
  ) {
    this.diskSizeBytes = diskSizeBytes;
    this.#fragments = fragments;
  }

  /** A view over an image held whole in memory. */
  static ofImage(bytes: Uint8Array): DiskView {
    return new DiskView(bytes.byteLength, [{ offsetBytes: 0, bytes }]);
  }

  /**
   * Bytes `[offsetBytes, offsetBytes + length)`, or `undefined` when no
   * fragment covers the whole range.
   */
  slice(offsetBytes: number, length: number): Uint8Array | undefined {
    if (offsetBytes < 0 || length < 0) return undefined;
    for (const fragment of this.#fragments) {
      const start = offsetBytes - fragment.offsetBytes;
      if (start < 0) continue;
      if (start + length > fragment.bytes.byteLength) continue;
      return fragment.bytes.subarray(start, start + length);
    }
    return undefined;
  }
}

function decodeName(bytes: Uint8Array): string {
  let end = 0;
  while (end + 1 < bytes.byteLength) {
    if (bytes[end] === 0 && bytes[end + 1] === 0) break;
    end += 2;
  }
  return new TextDecoder("utf-16le").decode(bytes.subarray(0, end));
}

/** Read a header out of one sector, without judging it. */
function decodeHeader(sector: Uint8Array): GptHeader | undefined {
  if (sector.byteLength < HEADER_MIN_BYTES) return undefined;
  if (
    new TextDecoder().decode(sector.subarray(0, 8)) !== GPT_SIGNATURE
  ) {
    return undefined;
  }
  const view = new DataView(
    sector.buffer,
    sector.byteOffset,
    sector.byteLength,
  );
  // u64 LBAs are read as Numbers: a disk large enough to overflow 2^53
  // sectors is 4 ZiB at 512 bytes, and every arithmetic path here would need
  // to be BigInt to serve it. Values past the safe range are refused below
  // rather than silently truncated.
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  return {
    revision: view.getUint32(8, true),
    headerSizeBytes: view.getUint32(12, true),
    headerCrc32: view.getUint32(16, true),
    myLba: u64(24),
    alternateLba: u64(32),
    firstUsableLba: u64(40),
    lastUsableLba: u64(48),
    diskGuid: bytesToGuid(sector.subarray(56, 72)),
    entryArrayLba: u64(72),
    entryCount: view.getUint32(80, true),
    entrySizeBytes: view.getUint32(84, true),
    entriesCrc32: view.getUint32(88, true),
  };
}

/** Serialize a header back into a full sector, CRC recomputed. */
export function encodeGptHeader(
  header: GptHeader,
  sectorSize: SectorSize,
): Uint8Array {
  const size = header.headerSizeBytes;
  if (size < HEADER_MIN_BYTES || size > sectorSize) {
    throw new GptParseError(
      `HeaderSize ${size} is outside ${HEADER_MIN_BYTES}..${sectorSize}; ` +
        "this reader will not rewrite a header whose CRC would cover bytes " +
        "outside its own sector",
    );
  }
  const bytes = new Uint8Array(sectorSize);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(GPT_SIGNATURE), 0);
  view.setUint32(8, header.revision, true);
  view.setUint32(12, size, true);
  view.setUint32(16, 0, true); // CRC field zeroed while it is computed
  view.setUint32(20, 0, true); // reserved
  view.setBigUint64(24, BigInt(header.myLba), true);
  view.setBigUint64(32, BigInt(header.alternateLba), true);
  view.setBigUint64(40, BigInt(header.firstUsableLba), true);
  view.setBigUint64(48, BigInt(header.lastUsableLba), true);
  bytes.set(guidToBytes(header.diskGuid), 56);
  view.setBigUint64(72, BigInt(header.entryArrayLba), true);
  view.setUint32(80, header.entryCount, true);
  view.setUint32(84, header.entrySizeBytes, true);
  view.setUint32(88, header.entriesCrc32, true);
  view.setUint32(16, crc32(bytes.subarray(0, size)), true);
  return bytes;
}

/** Serialize entries back into an array of `entryCount` slots. */
export function encodeGptEntries(
  entries: readonly GptEntry[],
  entryCount: number,
  entrySizeBytes: number,
): Uint8Array {
  const bytes = new Uint8Array(entryCount * entrySizeBytes);
  const view = new DataView(bytes.buffer);
  for (const entry of entries) {
    if (entry.index < 0 || entry.index >= entryCount) {
      throw new GptParseError(
        `entry slot ${entry.index} is outside the array's ${entryCount} slots`,
      );
    }
    const at = entry.index * entrySizeBytes;
    bytes.set(guidToBytes(entry.typeGuid), at);
    bytes.set(guidToBytes(entry.uniqueGuid), at + 16);
    view.setBigUint64(at + 32, BigInt(entry.firstLba), true);
    view.setBigUint64(at + 40, BigInt(entry.lastLba), true);
    view.setBigUint64(at + 48, entry.attributes, true);
    // The name field is UTF-16LE and holds a fixed number of code UNITS
    // ((entrySizeBytes - 56) / 2). Iterate by code unit, not code point: a JS
    // string is already UTF-16, so `name.length` is the code-unit count and
    // `name.charCodeAt(i)` yields each unit — including both halves of a
    // surrogate pair. Spreading with `[...name]` would step by code POINT, so
    // an astral character would be written as its high surrogate alone and its
    // low surrogate dropped, and the length would be checked against the wrong
    // unit (36 astral points is 72 units, twice what the field holds).
    const maxCodeUnits = Math.floor((entrySizeBytes - 56) / 2);
    if (entry.name.length > maxCodeUnits) {
      throw new GptParseError(
        `partition name "${entry.name}" is ${entry.name.length} UTF-16 code ` +
          `units, over the ${maxCodeUnits} a ${entrySizeBytes}-byte entry holds`,
      );
    }
    for (let unit = 0; unit < entry.name.length; unit++) {
      view.setUint16(at + 56 + unit * 2, entry.name.charCodeAt(unit), true);
    }
  }
  return bytes;
}

function readSide(
  view: DiskView,
  lba: number,
  sectorSize: SectorSize,
): GptSide {
  const sector = view.slice(lba * sectorSize, sectorSize);
  if (sector === undefined) return { lba, status: "unread", entries: [] };
  const header = decodeHeader(sector);
  if (header === undefined) return { lba, status: "no-signature", entries: [] };

  const check = new Uint8Array(sector.subarray(0, sector.byteLength));
  if (
    header.headerSizeBytes < HEADER_MIN_BYTES ||
    header.headerSizeBytes > sectorSize
  ) {
    return {
      lba,
      status: "unsupported",
      header,
      entries: [],
      note: `HeaderSize ${header.headerSizeBytes} is outside ` +
        `${HEADER_MIN_BYTES}..${sectorSize}`,
    };
  }
  new DataView(check.buffer).setUint32(16, 0, true);
  const headerCrc = crc32(check.subarray(0, header.headerSizeBytes));
  if (headerCrc !== header.headerCrc32) {
    return {
      lba,
      status: "bad-header-crc",
      header,
      entries: [],
      note: `HeaderCRC32 records ${hex(header.headerCrc32)}, the bytes hash ` +
        `to ${hex(headerCrc)}`,
    };
  }

  // Only now, with a header whose own CRC checks out, are entryCount and
  // entrySizeBytes worth trusting enough to size an allocation with.
  const arrayBytes = header.entryCount * header.entrySizeBytes;
  if (
    header.entrySizeBytes < 128 || header.entrySizeBytes % 8 !== 0 ||
    header.entryCount === 0 || arrayBytes > MAX_ENTRY_ARRAY_BYTES
  ) {
    return {
      lba,
      status: "unsupported",
      header,
      entries: [],
      note: `${header.entryCount} entries of ${header.entrySizeBytes} bytes ` +
        `is not a table this reader will follow (cap ` +
        `${MAX_ENTRY_ARRAY_BYTES} bytes, entry size a multiple of 8, >= 128)`,
    };
  }

  const stored = view.slice(header.entryArrayLba * sectorSize, arrayBytes);
  if (stored === undefined) {
    return {
      lba,
      status: "unread",
      header,
      entries: [],
      note: `the entry array at LBA ${header.entryArrayLba} was not fetched`,
    };
  }
  const entryBytes = new Uint8Array(stored);
  const entriesCrc = crc32(entryBytes);
  const entries: GptEntry[] = [];
  for (let index = 0; index < header.entryCount; index++) {
    const at = index * header.entrySizeBytes;
    const typeGuid = bytesToGuid(entryBytes.subarray(at, at + 16));
    if (typeGuid === UNUSED_TYPE_GUID) continue;
    const entryView = new DataView(
      entryBytes.buffer,
      at,
      header.entrySizeBytes,
    );
    entries.push({
      index,
      typeGuid,
      uniqueGuid: bytesToGuid(entryBytes.subarray(at + 16, at + 32)),
      firstLba: Number(entryView.getBigUint64(32, true)),
      lastLba: Number(entryView.getBigUint64(40, true)),
      attributes: entryView.getBigUint64(48, true),
      name: decodeName(
        entryBytes.subarray(at + 56, at + header.entrySizeBytes),
      ),
    });
  }
  if (entriesCrc !== header.entriesCrc32) {
    return {
      lba,
      status: "bad-entries-crc",
      header,
      entries,
      entryBytes,
      note: `PartitionEntryArrayCRC32 records ${hex(header.entriesCrc32)}, ` +
        `the array hashes to ${hex(entriesCrc)}`,
    };
  }
  return { lba, status: "ok", header, entries, entryBytes };
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

/** Options for {@linkcode parseGpt}. */
export interface ParseGptOptions {
  /** Logical sector size. Probed from the signature's position when omitted. */
  readonly sectorSize?: SectorSize;
}

/**
 * Parse a GPT from a whole disk image held in memory, validating both headers.
 *
 * Never throws for a damaged table — damage is what the result describes.
 * {@linkcode GptParseError} is reserved for bytes too short to hold a GPT at
 * all.
 */
export function parseGpt(
  bytes: Uint8Array,
  options: ParseGptOptions = {},
): ParsedGpt {
  return parseGptView(DiskView.ofImage(bytes), options);
}

/**
 * Parse a GPT from a {@linkcode DiskView}, which may hold only the two ends of
 * the disk.
 *
 * This is what {@linkcode ./image.ts | readGptImage} calls after fetching its
 * windows; {@linkcode parseGpt} is the same thing over a whole image.
 */
export function parseGptView(
  view: DiskView,
  options: ParseGptOptions = {},
): ParsedGpt {
  const sectorSize = options.sectorSize ?? probeSectorSize(view);
  const diskSizeBytes = view.diskSizeBytes;
  const totalSectors = Math.floor(diskSizeBytes / sectorSize);
  if (totalSectors < 3) {
    throw new GptParseError(
      `a ${diskSizeBytes}-byte disk holds ${totalSectors} sectors of ` +
        `${sectorSize}; a GPT needs at least a protective MBR, a header and ` +
        "an entry array",
    );
  }

  const mbr = view.slice(0, sectorSize);
  const protectiveMbr = mbr !== undefined && mbr[446 + 4] === 0xee &&
    mbr[510] === 0x55 && mbr[511] === 0xaa;

  const primary = readSide(view, 1, sectorSize);
  const backup = readSide(view, totalSectors - 1, sectorSize);

  // A grow leaves the old backup where the primary still points. Reading it is
  // how the difference between "grown" and "backup destroyed" gets measured
  // rather than guessed.
  let stranded: GptSide | undefined;
  const pointsAt = primary.header?.alternateLba;
  if (
    primary.status === "ok" && pointsAt !== undefined &&
    pointsAt !== totalSectors - 1 && pointsAt > 1 && pointsAt < totalSectors
  ) {
    const side = readSide(view, pointsAt, sectorSize);
    if (side.status !== "no-signature") stranded = side;
  }

  return {
    sectorSize,
    diskSizeBytes,
    totalSectors,
    protectiveMbr,
    primary,
    backup,
    ...(stranded === undefined ? {} : { stranded }),
  };
}

function probeSectorSize(view: DiskView): SectorSize {
  for (const candidate of [512, 4096] as const) {
    const sector = view.slice(candidate, 8);
    if (
      sector !== undefined &&
      new TextDecoder().decode(sector) === GPT_SIGNATURE
    ) {
      return candidate;
    }
  }
  // No primary to probe with. 512 is the qemu default and the only size the
  // recipe tier emits unless asked otherwise; a 4096-byte disk whose primary
  // is destroyed must be parsed with an explicit sectorSize.
  return 512;
}

/** What is wrong with a disk's partition table. */
export type GptProblemCode =
  /** Neither side holds a table this reader can use. */
  | "no-gpt"
  /**
   * A side's bytes were not all fetched — a windowed view too small for this
   * table. A limit of the read, not damage to the disk; the fix is a wider
   * window, never recreating the table.
   */
  | "table-unread"
  /**
   * A stale backup header sits mid-disk but its own CRC does not verify, so
   * the extent it occupies cannot be trusted enough to zero over.
   */
  | "stranded-backup-unverifiable"
  /** The primary header or its entry array does not verify. */
  | "primary-corrupt"
  /** The last sector holds no usable backup header. */
  | "backup-missing"
  /** A backup header is there, but it does not verify. */
  | "backup-corrupt"
  /** The backup sits mid-disk: the disk grew under it. */
  | "backup-stranded"
  /** `LastUsableLBA` does not match the disk's current size. */
  | "last-usable-stale"
  /** `AlternateLBA` does not point at the disk's last sector. */
  | "alternate-lba-stale"
  /** Both sides verify and describe different tables. */
  | "headers-disagree"
  /** A partition ends past the last LBA the current disk can hold. */
  | "partition-past-last-usable"
  /** A partition starts inside the table's own reserved head. */
  | "partition-before-first-usable"
  /** LBA 0 carries no 0xEE protective MBR. */
  | "protective-mbr-missing";

/** One thing that is wrong, and what to do about it. */
export interface GptProblem {
  /** Machine-readable kind. */
  readonly code: GptProblemCode;
  /** What is wrong, with the numbers that were measured. */
  readonly detail: string;
  /** What to do about it. */
  readonly fix: string;
  /** Whether {@linkcode planGptRepair} fixes this without being asked twice. */
  readonly repairable: boolean;
}

/** A whole disk's diagnosis. */
export interface GptDiagnosis {
  /** True when nothing is wrong. */
  readonly ok: boolean;
  /** Everything wrong, most structural first. */
  readonly problems: readonly GptProblem[];
  /** Which side a repair would rebuild from, or `"none"`. */
  readonly source: "primary" | "backup" | "stranded" | "none";
  /** The `LastUsableLBA` this disk's size implies. */
  readonly expectedLastUsableLba: number;
  /** The sector a backup header belongs in. */
  readonly expectedBackupLba: number;
}

/** Canonical tail geometry for a disk of this size and this table's shape. */
function geometryFor(
  totalSectors: number,
  header: GptHeader,
  sectorSize: SectorSize,
): {
  arraySectors: number;
  backupHeaderLba: number;
  backupArrayLba: number;
  lastUsableLba: number;
} {
  const arraySectors = Math.ceil(
    header.entryCount * header.entrySizeBytes / sectorSize,
  );
  return {
    arraySectors,
    backupHeaderLba: totalSectors - 1,
    backupArrayLba: totalSectors - arraySectors - 1,
    lastUsableLba: totalSectors - arraySectors - 2,
  };
}

/**
 * Disk-defining header fields on which two sides disagree, as printable
 * `field X vs Y` strings — empty when the two describe the same disk.
 *
 * `MyLBA`, `AlternateLBA`, `PartitionEntryLBA` and the header CRC that covers
 * them are DELIBERATELY different between a primary and its backup — a backup
 * is not a byte copy of the primary — so they are not compared: a table where
 * only those differ is one table, correctly mirrored. Everything else here
 * describes the disk itself, `LastUsableLBA` included; a difference in any of
 * it means the two headers describe *different disks*, which is the case this
 * whole comparison exists to catch. Omitting `LastUsableLBA` let two headers
 * that put the usable end in different places read back as "the same table".
 */
function tableDisagreements(a: GptHeader, b: GptHeader): readonly string[] {
  const diffs: string[] = [];
  if (a.revision !== b.revision) {
    diffs.push(`revision ${hex(a.revision)} vs ${hex(b.revision)}`);
  }
  if (a.headerSizeBytes !== b.headerSizeBytes) {
    diffs.push(`HeaderSize ${a.headerSizeBytes} vs ${b.headerSizeBytes}`);
  }
  if (a.firstUsableLba !== b.firstUsableLba) {
    diffs.push(`FirstUsableLBA ${a.firstUsableLba} vs ${b.firstUsableLba}`);
  }
  if (a.lastUsableLba !== b.lastUsableLba) {
    diffs.push(`LastUsableLBA ${a.lastUsableLba} vs ${b.lastUsableLba}`);
  }
  if (a.diskGuid !== b.diskGuid) {
    diffs.push(`disk GUID ${a.diskGuid} vs ${b.diskGuid}`);
  }
  if (a.entryCount !== b.entryCount) {
    diffs.push(`NumberOfPartitionEntries ${a.entryCount} vs ${b.entryCount}`);
  }
  if (a.entrySizeBytes !== b.entrySizeBytes) {
    diffs.push(
      `SizeOfPartitionEntry ${a.entrySizeBytes} vs ${b.entrySizeBytes}`,
    );
  }
  if (a.entriesCrc32 !== b.entriesCrc32) {
    diffs.push(
      `entry-array CRC ${hex(a.entriesCrc32)} vs ${hex(b.entriesCrc32)}`,
    );
  }
  return diffs;
}

function sameTable(a: GptSide, b: GptSide): boolean {
  if (a.header === undefined || b.header === undefined) return false;
  return tableDisagreements(a.header, b.header).length === 0;
}

/** Pick the side a repair should rebuild from. */
function trustedSide(
  parsed: ParsedGpt,
): { side: GptSide; from: GptDiagnosis["source"] } | undefined {
  if (parsed.primary.status === "ok") {
    return { side: parsed.primary, from: "primary" };
  }
  if (parsed.backup.status === "ok") {
    return { side: parsed.backup, from: "backup" };
  }
  if (parsed.stranded?.status === "ok") {
    return { side: parsed.stranded, from: "stranded" };
  }
  return undefined;
}

/**
 * Diagnose a parsed table against the disk it actually sits on.
 *
 * Reports; never repairs and never throws. A disk that grew and one whose
 * backup was destroyed produce different problems, because the repairs differ
 * and one of them can be refused.
 */
export function diagnoseGpt(parsed: ParsedGpt): GptDiagnosis {
  const problems: GptProblem[] = [];
  const trusted = trustedSide(parsed);
  const expectedBackupLba = parsed.totalSectors - 1;
  const geometry = trusted === undefined
    ? undefined
    : geometryFor(parsed.totalSectors, trusted.side.header!, parsed.sectorSize);
  const expectedLastUsableLba = geometry?.lastUsableLba ?? -1;

  // A side read back "unread" when a windowed view did not fetch the bytes it
  // needed — the header sector, or the entry array a good header points at
  // (readGptImage takes the first and last 256 KiB, so a table whose array is
  // larger, or placed further in, falls outside). That is a limit of THIS
  // read, not damage to the disk. Folding it into "no-gpt" would tell a caller
  // to recreate a table that is very likely perfectly sound, and treating an
  // unread side as "corrupt" would rewrite one this reader simply did not see.
  // Surface it on its own and refuse to judge or repair until the bytes are in
  // hand; the fix is a wider window, never recreating the table.
  const unreadSides = [parsed.primary, parsed.backup].filter((side) =>
    side.status === "unread"
  );
  if (unreadSides.length > 0) {
    for (const side of unreadSides) {
      const which = side.lba === 1
        ? "the primary (LBA 1)"
        : `the backup (LBA ${side.lba})`;
      problems.push({
        code: "table-unread",
        detail: `${which} side was not fully read` +
          `${side.note === undefined ? "" : `: ${side.note}`}` +
          " — this view does not cover the whole table",
        fix: "read more of the disk and diagnose again: widen the window " +
          "(readGptImage fetches only the first and last 256 KiB) or parse a " +
          "fuller image. This is a limit of the read, not damage — leave the " +
          "table in place",
        repairable: false,
      });
    }
    return {
      ok: false,
      problems,
      source: "none",
      expectedLastUsableLba,
      expectedBackupLba,
    };
  }

  if (trusted === undefined) {
    problems.push({
      code: "no-gpt",
      detail: `neither LBA 1 (${parsed.primary.status}` +
        `${
          parsed.primary.note === undefined ? "" : `: ${parsed.primary.note}`
        }` +
        `) nor LBA ${expectedBackupLba} (${parsed.backup.status}` +
        `${parsed.backup.note === undefined ? "" : `: ${parsed.backup.note}`}` +
        ") holds a usable GPT",
      fix: "there is nothing to repair from; recreate the table with " +
        "buildGpt() from @nullstyle/qemu-img/fs",
      repairable: false,
    });
    return {
      ok: false,
      problems,
      source: "none",
      expectedLastUsableLba,
      expectedBackupLba,
    };
  }

  const header = trusted.side.header!;

  if (parsed.primary.status !== "ok") {
    problems.push({
      code: "primary-corrupt",
      detail: `LBA 1: ${parsed.primary.status}` +
        `${
          parsed.primary.note === undefined ? "" : ` (${parsed.primary.note})`
        }`,
      fix: "repairGpt() rewrites the primary from the backup",
      repairable: true,
    });
  }

  if (parsed.backup.status !== "ok") {
    const grew = parsed.stranded?.status === "ok";
    problems.push({
      code: grew ? "backup-stranded" : "backup-missing",
      detail: grew
        ? `the backup header is at LBA ${parsed.stranded!.lba}, not ` +
          `${expectedBackupLba}: the disk grew by ` +
          `${(expectedBackupLba - parsed.stranded!.lba) * parsed.sectorSize} ` +
          "bytes under it"
        : `LBA ${expectedBackupLba} holds no usable backup header ` +
          `(${parsed.backup.status})`,
      fix: grew
        ? "repairGpt() moves it to the last sector and restates both headers"
        : "repairGpt() reconstructs it from the primary",
      repairable: true,
    });
  } else if (
    parsed.primary.status === "ok" && !sameTable(parsed.primary, parsed.backup)
  ) {
    const diffs = tableDisagreements(
      parsed.primary.header!,
      parsed.backup.header!,
    );
    problems.push({
      code: "headers-disagree",
      detail: `LBA 1 and LBA ${expectedBackupLba} both verify but describe ` +
        `different disks (${diffs.join("; ")})`,
      fix: "refused on purpose — picking a side silently discards whichever " +
        "table was right. Inspect both with parseGpt() and rewrite the one " +
        "you want with buildGpt()",
      repairable: false,
    });
  }

  if (header.lastUsableLba !== expectedLastUsableLba) {
    problems.push({
      code: "last-usable-stale",
      detail: `LastUsableLBA is ${header.lastUsableLba}; a ` +
        `${parsed.diskSizeBytes}-byte disk puts it at ${expectedLastUsableLba}` +
        ` (${
          Math.abs(header.lastUsableLba - expectedLastUsableLba) *
          parsed.sectorSize
        } bytes ` +
        `${
          header.lastUsableLba > expectedLastUsableLba
            ? "past the end"
            : "short"
        })`,
      fix: "repairGpt() restates it from the disk's current size",
      repairable: true,
    });
  }

  if (header.alternateLba !== expectedBackupLba) {
    problems.push({
      code: "alternate-lba-stale",
      detail: `AlternateLBA is ${header.alternateLba}; the disk's last ` +
        `sector is ${expectedBackupLba}`,
      fix: "repairGpt() restates it from the disk's current size",
      repairable: true,
    });
  }

  for (const entry of trusted.side.entries) {
    if (entry.lastLba > expectedLastUsableLba) {
      const shortfall = (entry.lastLba - expectedLastUsableLba) *
        parsed.sectorSize;
      problems.push({
        code: "partition-past-last-usable",
        detail: `partition ${entry.index + 1} ("${entry.name}") ends at LBA ` +
          `${entry.lastLba}, past the last usable LBA ` +
          `${expectedLastUsableLba} — ${shortfall} bytes of it are off the ` +
          "end of this disk",
        fix:
          `grow the image back to at least ${
            (entry.lastLba + geometry!.arraySectors + 2) * parsed.sectorSize
          } ` +
          "bytes and repair, which loses nothing. repairGpt() refuses this " +
          "disk otherwise; acknowledgeDataLoss drops the entry, and never " +
          "shortens it — a clamped entry would leave a filesystem whose " +
          "superblock claims blocks the disk no longer has",
        repairable: false,
      });
    }
    if (entry.firstLba < header.firstUsableLba) {
      problems.push({
        code: "partition-before-first-usable",
        detail: `partition ${entry.index + 1} ("${entry.name}") starts at ` +
          `LBA ${entry.firstLba}, inside the ${header.firstUsableLba} sectors ` +
          "the table reserves for itself",
        fix: "not a resize artifact — the table was built wrong. Rebuild it " +
          "with buildGpt(), which range-checks every partition",
        repairable: false,
      });
    }
  }

  if (!parsed.protectiveMbr) {
    problems.push({
      code: "protective-mbr-missing",
      detail: "LBA 0 holds no 0xEE protective MBR",
      fix: "repairGpt() writes one covering the whole disk",
      repairable: true,
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    source: trusted.from,
    expectedLastUsableLba,
    expectedBackupLba,
  };
}

/** Options for {@linkcode planGptRepair} and {@linkcode repairGpt}. */
export interface GptRepairOptions extends ParseGptOptions {
  /**
   * Drop partition entries that no longer fit, instead of refusing.
   *
   * The dropped entries are reported. Their bytes are *not* touched and the
   * entries are never shortened to fit: a clamped entry describes a
   * filesystem whose superblock still claims the blocks past the new end,
   * which is a corrupt disk that parses.
   */
  readonly acknowledgeDataLoss?: boolean;
  /**
   * Zero the stale backup header a grow stranded mid-disk. @default true
   *
   * Skipped automatically when a retained partition covers those sectors, so
   * this can never overwrite partition content.
   */
  readonly zeroStrandedBackup?: boolean;
}

/** One byte range a repair writes, ready for a `raw` window. */
export interface GptWrite {
  /** Byte offset into the disk. */
  readonly offsetBytes: number;
  /** The bytes to put there. */
  readonly bytes: Uint8Array;
  /** What this range is, for logging. */
  readonly what: string;
}

/** Everything a repair would do, without doing any of it. */
export interface GptRepairPlan {
  /** False when the table already matches the disk. */
  readonly changed: boolean;
  /** The byte ranges to write, in ascending offset order. */
  readonly writes: readonly GptWrite[];
  /** Entries dropped under `acknowledgeDataLoss`. */
  readonly droppedPartitions: readonly GptEntry[];
  /** The diagnosis the plan was built from. */
  readonly diagnosis: GptDiagnosis;
  /** `FirstUsableLBA` the repaired headers carry (never changed). */
  readonly firstUsableLba: number;
  /** `LastUsableLBA` the repaired headers carry. */
  readonly lastUsableLba: number;
}

function protectiveMbr(totalSectors: number, sectorSize: number): Uint8Array {
  const bytes = new Uint8Array(sectorSize);
  const view = new DataView(bytes.buffer);
  const at = 446;
  bytes[at + 1] = 0x00;
  bytes[at + 2] = 0x02;
  bytes[at + 4] = 0xee;
  bytes[at + 5] = 0xff;
  bytes[at + 6] = 0xff;
  bytes[at + 7] = 0xff;
  view.setUint32(at + 8, 1, true);
  view.setUint32(at + 12, Math.min(totalSectors - 1, 0xffffffff), true);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

/**
 * Work out the repair, without performing it.
 *
 * Refuses with {@linkcode GptRepairRefusedError} when the table cannot be
 * brought into agreement with the disk without losing something: two intact
 * headers that disagree, a partition hanging off the end (unless
 * `acknowledgeDataLoss`), or no usable header at all.
 */
export function planGptRepair(
  parsed: ParsedGpt,
  options: GptRepairOptions = {},
): GptRepairPlan {
  const diagnosis = diagnoseGpt(parsed);
  const blocking = diagnosis.problems.filter((problem) =>
    !problem.repairable &&
    !(problem.code === "partition-past-last-usable" &&
      options.acknowledgeDataLoss === true)
  );
  if (blocking.length > 0) {
    throw new GptRepairRefusedError(
      `this GPT cannot be repaired without losing data:\n` +
        blocking.map((p) => `  - ${p.detail}\n    fix: ${p.fix}`).join("\n"),
      blocking,
    );
  }

  const trusted = trustedSide(parsed)!;
  const header = trusted.side.header!;
  const { sectorSize, totalSectors } = parsed;
  const geometry = geometryFor(totalSectors, header, sectorSize);

  const kept: GptEntry[] = [];
  const dropped: GptEntry[] = [];
  for (const entry of trusted.side.entries) {
    if (entry.lastLba > geometry.lastUsableLba) dropped.push(entry);
    else kept.push(entry);
  }

  const entryBytes = dropped.length === 0
    ? trusted.side.entryBytes!
    : encodeGptEntries(kept, header.entryCount, header.entrySizeBytes);
  const entriesCrc32 = crc32(entryBytes);

  const common = {
    revision: header.revision,
    headerSizeBytes: header.headerSizeBytes,
    headerCrc32: 0,
    firstUsableLba: header.firstUsableLba,
    lastUsableLba: geometry.lastUsableLba,
    diskGuid: header.diskGuid,
    entryCount: header.entryCount,
    entrySizeBytes: header.entrySizeBytes,
    entriesCrc32,
  };
  // The primary's array stays at LBA 2, which is where every writer this
  // package has ever produced puts it and where a rebuilt-from-backup primary
  // must go: the backup's own PartitionEntryLBA points at the tail.
  const primaryArrayLba = trusted.from === "primary" ? header.entryArrayLba : 2;

  const primaryHeader = encodeGptHeader({
    ...common,
    myLba: 1,
    alternateLba: geometry.backupHeaderLba,
    entryArrayLba: primaryArrayLba,
  }, sectorSize);
  // Not a copy of the primary: MyLBA and AlternateLBA are swapped and the
  // array lives at the tail, so the header CRC differs too.
  const backupHeader = encodeGptHeader({
    ...common,
    myLba: geometry.backupHeaderLba,
    alternateLba: 1,
    entryArrayLba: geometry.backupArrayLba,
  }, sectorSize);

  const writes: GptWrite[] = [
    {
      offsetBytes: 0,
      bytes: protectiveMbr(totalSectors, sectorSize),
      what: "protective MBR",
    },
    { offsetBytes: sectorSize, bytes: primaryHeader, what: "primary header" },
    {
      offsetBytes: primaryArrayLba * sectorSize,
      bytes: entryBytes,
      what: "primary entry array",
    },
    {
      offsetBytes: geometry.backupArrayLba * sectorSize,
      bytes: entryBytes,
      what: "backup entry array",
    },
    {
      offsetBytes: geometry.backupHeaderLba * sectorSize,
      bytes: backupHeader,
      what: "backup header",
    },
  ];

  // A grow leaves an intact "EFI PART" mid-disk. Nothing in the repaired table
  // points at it, but it is a valid header that a scanning tool can find, so
  // it is overwritten unless a partition we are keeping sits on top of it.
  const stranded = parsed.stranded;
  if (
    stranded !== undefined && options.zeroStrandedBackup !== false &&
    stranded.header !== undefined && stranded.lba !== geometry.backupHeaderLba
  ) {
    // The extent to zero is [entryArrayLba .. strandedHeaderLba], and
    // entryArrayLba is a u64 read straight off the stranded header. `parseGpt`
    // populates `stranded` for a header whose CRC FAILED too — readSide returns
    // the decoded struct alongside every status but "no-signature" — so a
    // stranded header whose own CRC did not verify carries an unverified
    // entryArrayLba, and sizing a write from it would compute a `RangeError:
    // Invalid typed array length` when it reads back past its own LBA, or wipe
    // an arbitrary span of live data when it does not. Refuse that rather than
    // guess an extent. "bad-entries-crc" and "unread" are NOT refused: readSide
    // reaches those only after the HEADER CRC has passed, so their
    // entryArrayLba is trustworthy even though the array bytes are not — and a
    // disk whose real primary/backup are repairable must not be refused over a
    // leftover, per GptRepairRefusedError's contract.
    if (
      stranded.status === "bad-header-crc" || stranded.status === "unsupported"
    ) {
      const problem: GptProblem = {
        code: "stranded-backup-unverifiable",
        detail: `a stale "EFI PART" header sits at LBA ${stranded.lba}, but ` +
          `it did not verify cleanly (${stranded.status}` +
          `${stranded.note === undefined ? "" : `: ${stranded.note}`}), so ` +
          "the disk extent it occupies cannot be derived from its fields",
        fix:
          "its PartitionEntryLBA is untrustworthy, so it is not zeroed from " +
          "an unverified header. Inspect the sector with parseGpt(); once you " +
          "know what is there, pass zeroStrandedBackup: false to repair the " +
          "table and leave the stale header in place, or clear that sector " +
          "yourself",
        repairable: false,
      };
      throw new GptRepairRefusedError(
        "this GPT's repair cannot safely finish:\n" +
          `  - ${problem.detail}\n    fix: ${problem.fix}`,
        [problem],
      );
    }
    const first = stranded.header.entryArrayLba;
    const last = stranded.lba;
    // Bound the span even with a verified header: the array must sit at or
    // before the header it precedes (`first <= last`) and inside the disk.
    if (first > 1 && first <= last && last < totalSectors) {
      const covered = kept.some((entry) =>
        entry.firstLba <= last && entry.lastLba >= first
      );
      if (!covered) {
        writes.push({
          offsetBytes: first * sectorSize,
          bytes: new Uint8Array((last - first + 1) * sectorSize),
          what: `stranded backup (LBA ${first}..${last})`,
        });
      }
    }
  }

  writes.sort((a, b) => a.offsetBytes - b.offsetBytes);
  return {
    changed: !diagnosis.ok,
    writes,
    droppedPartitions: dropped,
    diagnosis,
    firstUsableLba: header.firstUsableLba,
    lastUsableLba: geometry.lastUsableLba,
  };
}

/**
 * Repair a whole disk image held in memory, returning the repaired bytes.
 *
 * The input is not modified. For anything big enough that holding it in memory
 * is a bad idea, use {@linkcode ./image.ts | repairGptImage}, which applies the
 * same plan through two `raw` windows.
 */
export function repairGpt(
  bytes: Uint8Array,
  options: GptRepairOptions = {},
): Uint8Array {
  const plan = planGptRepair(parseGpt(bytes, options), options);
  const out = new Uint8Array(bytes);
  for (const write of plan.writes) out.set(write.bytes, write.offsetBytes);
  return out;
}
