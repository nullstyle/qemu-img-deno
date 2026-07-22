/**
 * GPT writer: protective MBR, primary header, entry array, and the backup at
 * the tail — generated as bytes, with no `sgdisk` and no root.
 *
 * Two details here are the difference between an image that boots and one that
 * looks fine until something strict reads it:
 *
 * - **Every byte of the footprint is written explicitly**, including the unused
 *   entry slots and the header's reserved padding. On a fresh image assuming
 *   zeros is correct; on a qcow2 OVERLAY it is not, because unwritten clusters
 *   read *through* to the backing file, and stale bytes there surface as
 *   phantom partition entries.
 * - **The backup header is not a copy.** Its `MyLBA` and `AlternateLBA` are
 *   swapped and its own CRC differs, so a byte-for-byte copy of the primary is
 *   invalid — which some tools accept and others reject, making it the classic
 *   intermittent-looking GPT bug.
 *
 * @module
 */

/** Bytes in one GPT partition entry. */
export const ENTRY_BYTES = 128;
/** Number of entries in a conventional GPT array. */
export const ENTRY_COUNT = 128;
/**
 * Sectors the entry array occupies, rounded up to a whole sector.
 *
 * A function of the sector size rather than a constant: at 4096 the array is 4
 * sectors, not the 32 a 512-byte disk needs. Every place that sizes or places
 * the array goes through here, so the head layout and the buffer holding it
 * cannot disagree.
 */
function arraySectorsFor(sectorSize: number): number {
  return Math.ceil(ENTRY_BYTES * ENTRY_COUNT / sectorSize);
}

/** Well-known partition type GUIDs. */
export const PARTITION_TYPE_GUIDS = {
  /** EFI System Partition. */
  esp: "C12A7328-F81F-11D2-BA4B-00A0C93EC93B",
  /** Linux root, aarch64 (discoverable-partitions spec). */
  "linux-root-aarch64": "B921B045-1DF0-41C3-AF44-4C6F280D3FAE",
  /** Linux root, x86_64. */
  "linux-root-x86_64": "4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709",
  /** Generic Linux filesystem data. */
  "linux-generic": "0FC63DAF-8483-4772-8E79-3D69D8477DE4",
} as const;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as GPT headers and entry arrays use. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Serialize a canonical GUID string to its on-disk form.
 *
 * GPT stores GUIDs **mixed-endian**: the first three fields little-endian and
 * the last two big-endian. `C12A7328-F81F-11D2-BA4B-00A0C93EC93B` becomes
 * `28 73 2A C1 1F F8 D2 11 BA 4B 00 A0 C9 3E C9 3B`. Getting this wrong
 * produces a table that parses but whose partition types are unrecognizable.
 */
export function guidToBytes(guid: string): Uint8Array {
  const hex = guid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError(`not a GUID: ${guid}`);
  }
  const raw = new Uint8Array(16);
  for (let index = 0; index < 16; index++) {
    raw[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const out = new Uint8Array(16);
  out[0] = raw[3];
  out[1] = raw[2];
  out[2] = raw[1];
  out[3] = raw[0];
  out[4] = raw[5];
  out[5] = raw[4];
  out[6] = raw[7];
  out[7] = raw[6];
  out.set(raw.subarray(8), 8);
  return out;
}

/** Render on-disk GUID bytes back to the canonical string form. */
export function bytesToGuid(bytes: Uint8Array): string {
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  const digits = order.map((index) => hex(bytes[index]));
  return [
    digits.slice(0, 4).join(""),
    digits.slice(4, 6).join(""),
    digits.slice(6, 8).join(""),
    digits.slice(8, 10).join(""),
    digits.slice(10).join(""),
  ].join("-").toUpperCase();
}

/**
 * Derive a stable RFC-4122 v4-shaped GUID by hashing a seed with a label.
 *
 * Deterministic on purpose: a randomly generated disk GUID would make an
 * otherwise byte-identical build differ every run, so the recipe's `guidSeed`
 * is the only entropy in the whole image.
 */
export async function deriveGuid(seed: string, label: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${seed}\x00${label}`),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  // Version 4, variant RFC 4122 — so the value is a well-formed UUID rather
  // than 16 arbitrary bytes that some parsers will reject.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-").toUpperCase();
}

/** One partition to place in the table. */
export interface GptPartition {
  /** Partition type GUID, canonical string form. */
  readonly typeGuid: string;
  /** Unique partition GUID, canonical string form. */
  readonly uniqueGuid: string;
  /** First logical block, inclusive. */
  readonly firstLba: number;
  /** Last logical block, inclusive. */
  readonly lastLba: number;
  /** Partition name; stored UTF-16LE, at most 36 code units. */
  readonly name: string;
  /** Attribute flags. @default 0 */
  readonly attributes?: bigint;
}

/** Everything needed to lay down a table. */
export interface GptOptions {
  /** Disk size in bytes. */
  readonly diskSizeBytes: number;
  /** Logical sector size. @default 512 */
  readonly sectorSize?: number;
  /** Disk GUID, canonical string form. */
  readonly diskGuid: string;
  /** The partitions, in slot order. */
  readonly partitions: readonly GptPartition[];
}

/** The two byte ranges a GPT occupies, ready to splice into an image. */
export interface GptImage {
  /** Protective MBR + primary header + entry array, written at offset 0. */
  readonly primary: Uint8Array;
  /** Backup entry array + backup header. */
  readonly backup: Uint8Array;
  /** Byte offset the backup is written at. */
  readonly backupOffsetBytes: number;
  /** First LBA usable by a partition. */
  readonly firstUsableLba: number;
  /** Last LBA usable by a partition. */
  readonly lastUsableLba: number;
}

function writeEntries(
  partitions: readonly GptPartition[],
  sectorSize: number,
): Uint8Array {
  // Sized for the full array, so the unused slots are explicitly zeroed
  // rather than left to read through from a backing file.
  const bytes = new Uint8Array(arraySectorsFor(sectorSize) * sectorSize);
  const view = new DataView(bytes.buffer);
  partitions.forEach((partition, index) => {
    const at = index * ENTRY_BYTES;
    bytes.set(guidToBytes(partition.typeGuid), at);
    bytes.set(guidToBytes(partition.uniqueGuid), at + 16);
    view.setBigUint64(at + 32, BigInt(partition.firstLba), true);
    view.setBigUint64(at + 40, BigInt(partition.lastLba), true);
    view.setBigUint64(at + 48, partition.attributes ?? 0n, true);
    // UTF-16LE, at most 36 code UNITS. A JS string is already UTF-16, so
    // `name.length` counts units and `name.charCodeAt(i)` yields each unit,
    // both halves of a surrogate pair included. Stepping by code POINT with
    // `[...name]` would write an astral character's high surrogate alone and
    // drop the low one, and would miscount the limit (36 astral points is 72
    // units). The reader in ../block/gpt.ts encodes names the same way.
    const name = partition.name;
    if (name.length > 36) {
      throw new TypeError(
        `partition name "${name}" exceeds 36 UTF-16 code units`,
      );
    }
    for (let unit = 0; unit < name.length; unit++) {
      view.setUint16(at + 56 + unit * 2, name.charCodeAt(unit), true);
    }
  });
  return bytes;
}

function writeHeader(options: {
  myLba: number;
  alternateLba: number;
  firstUsableLba: number;
  lastUsableLba: number;
  diskGuid: string;
  entryArrayLba: number;
  entriesCrc: number;
  sectorSize: number;
}): Uint8Array {
  const bytes = new Uint8Array(options.sectorSize);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("EFI PART"), 0);
  view.setUint32(8, 0x00010000, true); // revision 1.0
  view.setUint32(12, 92, true); // header size
  view.setUint32(16, 0, true); // CRC placeholder, computed below
  view.setUint32(20, 0, true); // reserved
  view.setBigUint64(24, BigInt(options.myLba), true);
  view.setBigUint64(32, BigInt(options.alternateLba), true);
  view.setBigUint64(40, BigInt(options.firstUsableLba), true);
  view.setBigUint64(48, BigInt(options.lastUsableLba), true);
  bytes.set(guidToBytes(options.diskGuid), 56);
  view.setBigUint64(72, BigInt(options.entryArrayLba), true);
  view.setUint32(80, ENTRY_COUNT, true);
  view.setUint32(84, ENTRY_BYTES, true);
  view.setUint32(88, options.entriesCrc, true);
  // The header CRC covers exactly headerSize bytes with the CRC field zeroed.
  view.setUint32(16, crc32(bytes.subarray(0, 92)), true);
  return bytes;
}

function protectiveMbr(totalSectors: number, sectorSize: number): Uint8Array {
  const bytes = new Uint8Array(sectorSize);
  const view = new DataView(bytes.buffer);
  const at = 446;
  bytes[at] = 0x00; // not bootable
  bytes[at + 1] = 0x00; // CHS start head
  bytes[at + 2] = 0x02; // CHS start sector 2
  bytes[at + 3] = 0x00;
  bytes[at + 4] = 0xee; // GPT protective
  bytes[at + 5] = 0xff; // CHS end, saturated
  bytes[at + 6] = 0xff;
  bytes[at + 7] = 0xff;
  view.setUint32(at + 8, 1, true); // starts at LBA 1
  // Saturate rather than wrap: a disk larger than 2 TiB cannot be described
  // here, and the spec's answer is 0xFFFFFFFF.
  view.setUint32(at + 12, Math.min(totalSectors - 1, 0xffffffff), true);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

/** Build a complete GPT for a disk of the given size. */
export function buildGpt(options: GptOptions): GptImage {
  const sectorSize = options.sectorSize ?? 512;
  const totalSectors = Math.floor(options.diskSizeBytes / sectorSize);
  const arraySectors = arraySectorsFor(sectorSize);
  const firstUsableLba = 2 + arraySectors;
  const lastUsableLba = totalSectors - arraySectors - 2;
  const backupHeaderLba = totalSectors - 1;
  const backupArrayLba = totalSectors - arraySectors - 1;

  for (const partition of options.partitions) {
    if (
      partition.firstLba < firstUsableLba || partition.lastLba > lastUsableLba
    ) {
      throw new RangeError(
        `partition "${partition.name}" (LBA ${partition.firstLba}..` +
          `${partition.lastLba}) falls outside the usable range ` +
          `${firstUsableLba}..${lastUsableLba}`,
      );
    }
  }

  const entries = writeEntries(options.partitions, sectorSize);
  const entriesCrc = crc32(entries.subarray(0, ENTRY_BYTES * ENTRY_COUNT));

  const primaryHeader = writeHeader({
    myLba: 1,
    alternateLba: backupHeaderLba,
    firstUsableLba,
    lastUsableLba,
    diskGuid: options.diskGuid,
    entryArrayLba: 2,
    entriesCrc,
    sectorSize,
  });
  // Not a copy: MyLBA and AlternateLBA are swapped, the entry array lives at
  // the tail, and the header CRC differs accordingly.
  const backupHeader = writeHeader({
    myLba: backupHeaderLba,
    alternateLba: 1,
    firstUsableLba,
    lastUsableLba,
    diskGuid: options.diskGuid,
    entryArrayLba: backupArrayLba,
    entriesCrc,
    sectorSize,
  });

  const primary = new Uint8Array((2 + arraySectors) * sectorSize);
  primary.set(protectiveMbr(totalSectors, sectorSize), 0);
  primary.set(primaryHeader, sectorSize);
  primary.set(entries, 2 * sectorSize);

  const backup = new Uint8Array((arraySectors + 1) * sectorSize);
  backup.set(entries, 0);
  backup.set(backupHeader, arraySectors * sectorSize);

  return {
    primary,
    backup,
    backupOffsetBytes: backupArrayLba * sectorSize,
    firstUsableLba,
    lastUsableLba,
  };
}
