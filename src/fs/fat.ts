/**
 * FAT directory timestamp normalizer: rewrites the creation and last-access
 * fields of every real directory entry to a pinned epoch, in a filesystem
 * qemu's `vvfat` driver has already produced.
 *
 * It exists because `Deno.utime()` cannot close the loop. vvfat reads each
 * staged file's `st_mtime`, `st_atime` and `st_ctime` and packs them into the
 * entry's write, access and creation fields; pinning the first two settles
 * `DIR_WrtTime` and `DIR_LstAccDate`, but no userspace call can pin `st_ctime` —
 * `utimes()` bumps it to now as a side effect of setting the other two,
 * so `DIR_CrtTime` records the wall clock at which the staging copy was made.
 * Measured on qemu 11.0.2 over the system smoke's ESP, two builds three
 * seconds apart: 8 bytes differed, every one at offset 14 of a 32-byte
 * directory entry — `DIR_CrtTime`'s low byte, whose bottom 5 bits are
 * seconds/2 — under an identical realization key. Same key, different bytes is
 * cache poisoning, not cosmetics.
 *
 * Three details here are the difference between a normalized filesystem and a
 * quietly corrupt one:
 *
 * - **Long-file-name entries carry no timestamps.** An entry whose attribute
 *   byte is `0x0F` is a name fragment, and its byte 14 is a UTF-16 character,
 *   not a time. Measured in the smoke's own ESP: byte 14 of the LFN entry
 *   preceding `BOOTAA64.EFI` is `0x41`, the `A` of `AA64`. Writing a
 *   timestamp there renames the bootloader, which nothing notices until
 *   firmware fails to find it.
 * - **`.` and `..` are real entries** and do carry times, so a walk that
 *   skipped them would leave two live timestamps per subdirectory moving.
 * - **The volume label is skipped.** vvfat leaves its time fields zeroed;
 *   stamping them would change bytes this defect never moved.
 *
 * The FAT type is decided by the cluster count, the way the spec defines it,
 * never by the `FAT16   ` string in the BPB — that field is advisory, and
 * trusting it on a FAT12 image would walk the allocation table with the wrong
 * entry width and follow chains into nonsense.
 *
 * @module
 */

/** Bytes in one FAT directory entry. */
export const DIR_ENTRY_BYTES = 32;

/** Attribute value marking a long-file-name fragment rather than a file. */
const ATTR_LONG_NAME = 0x0f;
/** The attribute bits an LFN test compares; the top two are reserved. */
const ATTR_LONG_NAME_MASK = 0x3f;
/** Attribute bit marking the volume-label entry. */
const ATTR_VOLUME_ID = 0x08;
/** Attribute bit marking a subdirectory. */
const ATTR_DIRECTORY = 0x10;

/** `DIR_Name[0]` value meaning this entry and every one after it is free. */
const NAME_FREE = 0x00;
/** `DIR_Name[0]` value meaning this entry was deleted. */
const NAME_DELETED = 0xe5;

/** Byte offset of `DIR_CrtTimeTenth` within an entry. */
const OFF_CRT_TIME_TENTH = 13;
/** Byte offset of `DIR_CrtTime` within an entry. */
const OFF_CRT_TIME = 14;
/** Byte offset of `DIR_CrtDate` within an entry. */
const OFF_CRT_DATE = 16;
/** Byte offset of `DIR_LstAccDate` within an entry. */
const OFF_LST_ACC_DATE = 18;
/** Byte offset of `DIR_FstClusHI` within an entry. */
const OFF_FST_CLUS_HI = 20;
/** Byte offset of `DIR_FstClusLO` within an entry. */
const OFF_FST_CLUS_LO = 26;
/** Byte offset of `DIR_Attr` within an entry. */
const OFF_ATTR = 11;

/** The earliest calendar year a FAT date field can encode. */
const FAT_EPOCH_YEAR = 1980;
/** The latest calendar year a FAT date field can encode (1980 + 127). */
const FAT_MAX_YEAR = 2107;

/**
 * Raised when an image is not a FAT filesystem this walker can normalize.
 *
 * Always a refusal, never a fallback: a FAT32 image walked with FAT16 rules
 * reads the allocation table at the wrong entry width and would stamp
 * timestamps over file data.
 */
export class FatLayoutError extends Error {
  /** Always `"FatLayoutError"`. */
  override readonly name = "FatLayoutError";
  /**
   * Build the error.
   *
   * @param message What was wrong, why it matters, and the fix.
   */
  constructor(message: string) {
    super(message);
  }
}

/** The BIOS Parameter Block fields this walker needs. */
interface Bpb {
  readonly bytesPerSector: number;
  readonly sectorsPerCluster: number;
  readonly reservedSectors: number;
  readonly numFats: number;
  readonly rootEntryCount: number;
  readonly fatSectors: number;
  readonly totalSectors: number;
  readonly rootCluster: number;
}

/** A contiguous byte range holding directory entries. */
interface Extent {
  readonly offset: number;
  readonly length: number;
}

/** What {@linkcode normalizeFatTimestamps} changed. */
export interface FatTimestampReport {
  /** The FAT width, decided by cluster count. */
  readonly fatType: 12 | 16 | 32;
  /** Directories walked, including the root. */
  readonly directories: number;
  /** Real entries whose creation and access fields were rewritten. */
  readonly entriesStamped: number;
  /** Long-name fragments left untouched, whose byte 14 is name data. */
  readonly longNameEntriesSkipped: number;
  /** Bytes actually written back. */
  readonly bytesRewritten: number;
}

/** Options for {@linkcode normalizeFatTimestamps}. */
export interface FatTimestampOptions {
  /**
   * The instant every creation and access field is pinned to, in seconds
   * since the Unix epoch, read as UTC.
   *
   * UTC rather than local time on purpose, and it is what makes the created
   * and written times agree. FAT stores a wall-clock calendar with no zone
   * field, and vvfat renders the host mtime through `localtime_r` before
   * packing it — so the recipe's mtime pinning, which pre-shifts by the host's
   * UTC offset, lands `sourceDateEpoch`'s UTC calendar fields in
   * `DIR_WrtTime`. Deriving the creation fields the same way reproduces those
   * bytes exactly: measured against qemu 11.0.2, epoch 1700000000 yields
   * `DIR_CrtDate` 0x576E and `DIR_CrtTime` 0xB1AA, byte for byte the
   * `DIR_WrtDate`/`DIR_WrtTime` vvfat wrote.
   */
  readonly epochSeconds: number;
}

/** A FAT date field: year since 1980 in bits 15-9, month 8-5, day 4-0. */
function fatDate(when: Date): number {
  return ((when.getUTCFullYear() - FAT_EPOCH_YEAR) << 9) |
    ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
}

/** A FAT time field: hours in bits 15-11, minutes 10-5, two-second units 4-0. */
function fatTime(when: Date): number {
  return (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) |
    (when.getUTCSeconds() >> 1);
}

/**
 * The tenths-of-a-second field, which carries the odd second the 5-bit
 * two-second time field cannot.
 */
function fatTimeTenth(when: Date): number {
  return (when.getUTCSeconds() % 2) * 100;
}

/** Read exactly `length` bytes at `offset`, or throw. */
async function readAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let done = 0;
  await file.seek(offset, Deno.SeekMode.Start);
  while (done < length) {
    const read = await file.read(out.subarray(done));
    if (read === null) {
      throw new FatLayoutError(
        `the image ends at byte ${offset + done}, but its BPB describes a ` +
          `filesystem reaching byte ${offset + length}. The partition window ` +
          "is smaller than the filesystem laid into it, so a directory would " +
          "be walked off the end of the image. Size the partition to at " +
          "least the filesystem's own total-sector count.",
      );
    }
    done += read;
  }
  return out;
}

/** Write every byte of `bytes` at `offset`. */
async function writeAt(
  file: Deno.FsFile,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  let done = 0;
  await file.seek(offset, Deno.SeekMode.Start);
  while (done < bytes.length) {
    done += await file.write(bytes.subarray(done));
  }
}

/** Parse and sanity-check the BPB, refusing anything that is not FAT. */
function parseBpb(sector: Uint8Array): Bpb {
  const view = new DataView(
    sector.buffer,
    sector.byteOffset,
    sector.byteLength,
  );
  const bytesPerSector = view.getUint16(11, true);
  const sectorsPerCluster = sector[13];
  const reservedSectors = view.getUint16(14, true);
  const numFats = sector[16];
  const rootEntryCount = view.getUint16(17, true);
  const totalSectors16 = view.getUint16(19, true);
  const fatSectors16 = view.getUint16(22, true);
  const totalSectors32 = view.getUint32(32, true);
  const fatSectors32 = view.getUint32(36, true);
  const rootCluster = view.getUint32(44, true);

  const refuse = (what: string): never => {
    throw new FatLayoutError(
      `this image is not a FAT filesystem this walker can normalize: ${what}. ` +
        "Creation timestamps are left as vvfat wrote them rather than " +
        "rewritten blind, because stamping a misparsed layout would overwrite " +
        "file data. Confirm the window really is the FAT partition and that " +
        "its first sector is the boot sector.",
    );
  };

  if (![512, 1024, 2048, 4096].includes(bytesPerSector)) {
    refuse(`BPB_BytsPerSec is ${bytesPerSector}, not 512, 1024, 2048 or 4096`);
  }
  if (
    sectorsPerCluster === 0 ||
    (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0
  ) {
    refuse(`BPB_SecPerClus is ${sectorsPerCluster}, not a power of two`);
  }
  if (reservedSectors === 0) refuse("BPB_RsvdSecCnt is 0");
  if (numFats === 0) refuse("BPB_NumFATs is 0");

  const fatSectors = fatSectors16 !== 0 ? fatSectors16 : fatSectors32;
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;
  if (fatSectors === 0) refuse("both BPB_FATSz16 and BPB_FATSz32 are 0");
  if (totalSectors === 0) refuse("both BPB_TotSec16 and BPB_TotSec32 are 0");

  return {
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntryCount,
    fatSectors,
    totalSectors,
    rootCluster,
  };
}

/**
 * The FAT width, from the cluster count.
 *
 * The spec's only correct determination, and deliberately not the `FAT16   `
 * string at offset 0x36: that field is advisory, and mkfs implementations
 * disagree about it.
 */
function fatTypeOf(bpb: Bpb): { type: 12 | 16 | 32; clusters: number } {
  const rootDirSectors = Math.ceil(
    bpb.rootEntryCount * DIR_ENTRY_BYTES / bpb.bytesPerSector,
  );
  const firstDataSector = bpb.reservedSectors + bpb.numFats * bpb.fatSectors +
    rootDirSectors;
  const clusters = Math.floor(
    (bpb.totalSectors - firstDataSector) / bpb.sectorsPerCluster,
  );
  const type = clusters < 4085 ? 12 : clusters < 65525 ? 16 : 32;
  return { type, clusters };
}

/** Follow one link of the allocation chain. */
function nextCluster(
  fat: Uint8Array,
  cluster: number,
  type: 12 | 16 | 32,
): number {
  if (type === 12) {
    const at = cluster + (cluster >> 1);
    const pair = fat[at] | (fat[at + 1] << 8);
    // The 12-bit entry straddles a byte: the odd cluster takes the high
    // nibbles, the even one the low.
    return (cluster & 1) !== 0 ? pair >> 4 : pair & 0x0fff;
  }
  if (type === 16) return fat[cluster * 2] | (fat[cluster * 2 + 1] << 8);
  return (fat[cluster * 4] | (fat[cluster * 4 + 1] << 8) |
    (fat[cluster * 4 + 2] << 16) | (fat[cluster * 4 + 3] << 24)) & 0x0fffffff;
}

/** The end-of-chain threshold for each width. */
function endOfChain(type: 12 | 16 | 32): number {
  return type === 12 ? 0xff8 : type === 16 ? 0xfff8 : 0x0ffffff8;
}

/**
 * Pin every creation and last-access timestamp in a FAT filesystem to a fixed
 * instant, in place.
 *
 * `path` must name a **raw** image of the filesystem alone — the partition
 * window, not a disk with a partition table in front of it, and not a qcow2.
 * Splice the result back through a `raw` window afterwards: on a qcow2 overlay
 * an unwritten cluster reads *through* to the backing file, so a range that is
 * only rewritten here has to be written there explicitly.
 *
 * Write times are deliberately untouched. They are already pinned, by the
 * staging copy's `Deno.utime()`, and rewriting them here would hide a
 * regression in that pinning behind this function.
 *
 * @param path Raw image of one FAT filesystem, opened read-write.
 * @param options The instant to pin to.
 * @returns What was walked and rewritten.
 * @throws {FatLayoutError} if the image is not a FAT this walker can parse, or
 * the epoch falls outside the 1980-2107 range a FAT date can encode.
 */
export async function normalizeFatTimestamps(
  path: string,
  options: FatTimestampOptions,
): Promise<FatTimestampReport> {
  const when = new Date(options.epochSeconds * 1000);
  const year = when.getUTCFullYear();
  if (!Number.isFinite(options.epochSeconds) || Number.isNaN(year)) {
    throw new FatLayoutError(
      `epochSeconds ${options.epochSeconds} is not a finite instant, so no ` +
        "FAT date can be derived from it. Pass the recipe's " +
        "determinism.sourceDateEpoch, in seconds since 1970.",
    );
  }
  if (year < FAT_EPOCH_YEAR || year > FAT_MAX_YEAR) {
    throw new FatLayoutError(
      `epochSeconds ${options.epochSeconds} falls in ${year}, and a FAT date ` +
        `field encodes only ${FAT_EPOCH_YEAR}-${FAT_MAX_YEAR} — the year is ` +
        "stored as 7 bits counted from 1980. Stamping it would silently wrap " +
        "to a different year, so it is refused. Choose a " +
        "determinism.sourceDateEpoch inside that range.",
    );
  }

  const crtDate = fatDate(when);
  const crtTime = fatTime(when);
  const crtTenth = fatTimeTenth(when);

  const file = await Deno.open(path, { read: true, write: true });
  try {
    const bpb = parseBpb(await readAt(file, 0, 512));
    const { type, clusters } = fatTypeOf(bpb);
    if (type === 32 && bpb.rootCluster < 2) {
      throw new FatLayoutError(
        `this filesystem has ${clusters} clusters, which makes it FAT32, but ` +
          `its BPB_RootClus is ${bpb.rootCluster} rather than a valid ` +
          "cluster number. Without a root directory to start from no entry " +
          "can be reached, so nothing is stamped. Re-create the filesystem.",
      );
    }

    const clusterBytes = bpb.sectorsPerCluster * bpb.bytesPerSector;
    const rootDirSectors = Math.ceil(
      bpb.rootEntryCount * DIR_ENTRY_BYTES / bpb.bytesPerSector,
    );
    const firstDataSector = bpb.reservedSectors + bpb.numFats * bpb.fatSectors +
      rootDirSectors;
    const fat = await readAt(
      file,
      bpb.reservedSectors * bpb.bytesPerSector,
      bpb.fatSectors * bpb.bytesPerSector,
    );
    const clusterOffset = (cluster: number) =>
      (firstDataSector + (cluster - 2) * bpb.sectorsPerCluster) *
      bpb.bytesPerSector;

    /** Every byte range one directory occupies, following its chain. */
    const chainExtents = (first: number): Extent[] => {
      const out: Extent[] = [];
      const seen = new Set<number>();
      let cluster = first;
      while (cluster >= 2 && cluster < endOfChain(type) && !seen.has(cluster)) {
        seen.add(cluster);
        // A cluster number past the volume's own count means the chain has
        // walked into garbage; stopping keeps the walk inside the image.
        if (cluster - 2 >= clusters) break;
        out.push({ offset: clusterOffset(cluster), length: clusterBytes });
        cluster = nextCluster(fat, cluster, type);
      }
      return out;
    };

    // FAT12 and FAT16 keep the root in a fixed region between the last FAT and
    // the data area; FAT32 makes it an ordinary cluster chain.
    const rootExtents: Extent[] = type === 32
      ? chainExtents(bpb.rootCluster)
      : [{
        offset: (bpb.reservedSectors + bpb.numFats * bpb.fatSectors) *
          bpb.bytesPerSector,
        length: bpb.rootEntryCount * DIR_ENTRY_BYTES,
      }];

    let directories = 0;
    let entriesStamped = 0;
    let longNameEntriesSkipped = 0;
    let bytesRewritten = 0;

    // Breadth-first over an explicit queue, with a visited set: a corrupt
    // chain that points a subdirectory at an ancestor would otherwise walk
    // forever.
    const queue: Extent[][] = [rootExtents];
    // Seeded with the FAT32 root so a subdirectory whose chain points back at
    // it is not walked a second time.
    const visited = new Set<number>(type === 32 ? [bpb.rootCluster] : []);
    while (queue.length > 0) {
      const extents = queue.shift()!;
      directories++;
      for (const extent of extents) {
        const block = await readAt(file, extent.offset, extent.length);
        let dirty = false;
        for (let at = 0; at + DIR_ENTRY_BYTES <= block.length; at += 32) {
          const entry = block.subarray(at, at + DIR_ENTRY_BYTES);
          // A free entry ends the directory per the spec, but this scans the
          // whole allocated extent instead of stopping. Skipping costs one
          // pass over bytes already read and cannot write to a free slot,
          // whereas stopping would leave every entry after a non-conformant
          // hole carrying an unpinned creation time — the same silent
          // shortfall this walker exists to remove, reintroduced quietly.
          if (entry[0] === NAME_FREE || entry[0] === NAME_DELETED) continue;
          const attr = entry[OFF_ATTR];
          if ((attr & ATTR_LONG_NAME_MASK) === ATTR_LONG_NAME) {
            // Byte 14 of a long-name fragment is a UTF-16 character of the
            // filename. Measured in the smoke's ESP: 0x41, the `A` of
            // `BOOTAA64.EFI`. Stamping it renames the file.
            longNameEntriesSkipped++;
            continue;
          }
          // Checked after the long-name test, which shares this bit.
          if ((attr & ATTR_VOLUME_ID) !== 0) continue;

          const view = new DataView(
            entry.buffer,
            entry.byteOffset,
            entry.byteLength,
          );
          entry[OFF_CRT_TIME_TENTH] = crtTenth;
          view.setUint16(OFF_CRT_TIME, crtTime, true);
          view.setUint16(OFF_CRT_DATE, crtDate, true);
          view.setUint16(OFF_LST_ACC_DATE, crtDate, true);
          entriesStamped++;
          dirty = true;

          // `.` and `..` are stamped like any other entry but never followed:
          // an 8.3 name may not otherwise begin with a dot, so this is the
          // whole of the self-and-parent case, and recursing into it would
          // revisit the directory and its parent forever.
          const isDotEntry = entry[0] === 0x2e;
          if ((attr & ATTR_DIRECTORY) !== 0 && !isDotEntry) {
            const first = (view.getUint16(OFF_FST_CLUS_HI, true) << 16) |
              view.getUint16(OFF_FST_CLUS_LO, true);
            if (first >= 2 && !visited.has(first)) {
              visited.add(first);
              queue.push(chainExtents(first));
            }
          }
        }
        if (dirty) {
          await writeAt(file, extent.offset, block);
          bytesRewritten += block.length;
        }
      }
    }

    return {
      fatType: type,
      directories,
      entriesStamped,
      longNameEntriesSkipped,
      bytesRewritten,
    };
  } finally {
    file.close();
  }
}
