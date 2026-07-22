/**
 * FAT12/16/32 writer: a conformant filesystem in bytes, with no `mkfs.fat`, no
 * loop device and no root.
 *
 * This exists to replace qemu's `vvfat` driver. `vvfat` synthesizes a
 * filesystem whose geometry is **fixed and content-independent** — a directory
 * of one file and a directory of a thousand both yield exactly 528450048 usable
 * bytes at FAT16 — so every ESP built through it was at least 504 MiB whatever
 * it held, and its FAT32 output is a FAT16-shaped BPB that conformant drivers
 * misread. A writer that sizes itself to its content is the only way to build a
 * 33 MiB ESP, and the only way to emit FAT32 at all.
 *
 * Five details here are the difference between a volume that works and one that
 * looks fine until something strict reads it:
 *
 * - **FAT name lookup is case-INSENSITIVE.** Two entries whose paths differ
 *   only in case are two directory entries a reader resolves to one file, so
 *   the second is unreachable and its name serves the first one's contents.
 *   {@linkcode buildFat} refuses that pair rather than writing it — a volume
 *   that mounts holding less than was staged is the exact shape this package
 *   exists to prevent.
 * - **The FAT type is a function of the cluster count, not of the name written
 *   in `BS_FilSysType`.** A reader computes `CountofClusters` from the BPB and
 *   applies the spec's own thresholds — under 4085 is FAT12, under 65525 is
 *   FAT16, otherwise FAT32 — and the eight ASCII bytes saying `FAT16   ` carry
 *   no weight at all. A geometry landing one cluster the wrong side of a
 *   threshold produces a volume whose type every driver disagrees about, which
 *   presents as a filesystem that mounts on one machine and is garbage on the
 *   next. {@linkcode buildFat} re-derives the type from the geometry it just
 *   wrote and throws rather than emit a volume it cannot name.
 * - **Every byte of the window is written explicitly**, including the slack
 *   past the last cluster. On a fresh image assuming zeros is correct; on a
 *   qcow2 OVERLAY it is not, because unwritten clusters read *through* to the
 *   backing file, and stale bytes there surface as phantom directory entries in
 *   the free space a later write would reach.
 * - **FAT32 is not FAT16 with wider entries.** Its root directory is an
 *   ordinary cluster chain rather than a fixed region, `BPB_RootEntCnt`,
 *   `BPB_FATSz16` and `BPB_TotSec16` must all be zero, an FSInfo sector lives at
 *   sector 1, and a backup boot sector at sector 6. That structural difference
 *   is exactly what `vvfat` gets wrong.
 * - **The LFN checksum ties a long-name run to its short entry.** It is
 *   computed over the 11 short-name bytes, and a reader that finds a mismatch
 *   discards the long name and silently falls back to the 8.3 one — so a wrong
 *   checksum is not a mount failure, it is a file that quietly has a different
 *   name than the one staged.
 *
 * Field names follow Microsoft's *FAT32 File System Specification* (the `BPB_`
 * / `BS_` / `DIR_` / `LDIR_` prefixes are its own), which is also the document
 * the UEFI specification incorporates by reference for the EFI System
 * Partition. Where this writer deviates from it, the comment says so and says
 * what was measured instead — see {@linkcode SECTOR_BYTES} and the
 * reserved-sector constant.
 *
 * Validated by `tools/fat_smoke.ts` against three implementations sharing no
 * code with this one: `fsck_msdos -n` exits 0, the Darwin `msdos` driver mounts
 * every volume and hands back each file byte-identical with its long name and
 * nesting intact while `diskutil` independently agrees on the type, and
 * `qemu-img` round-trips through qcow2 with `compare` identical. Volumes were
 * built landing on exactly 4084, 4085, 65524 and 65525 clusters — both sides of
 * both thresholds — and all three agree on the type for all four. Spliced into
 * a qcow2 overlay whose backing file is solid `0xDB`, both onto the whole image
 * and through a `raw` window at a partition offset, the flattened result is
 * byte-identical to the volume and carries not one `0xDB` the volume did not
 * already hold.
 *
 * The result is materialized whole: a 504 MiB partition costs 504 MiB of
 * `Uint8Array`. That is the price of writing every byte of the window, and
 * shrinking the window is the entire point of this module — measured, a
 * realistic ESP tree fits a 2124800-byte FAT16 volume, and the smallest FAT12
 * window holding a 300 KB payload is 330240 bytes.
 *
 * @module
 */

/**
 * Bytes per sector.
 *
 * Fixed at 512. The BPB has a field for it and the spec allows 1024, 2048 and
 * 4096, but neither oracle this writer is validated against — `fsck_msdos` and
 * the Darwin `msdos` driver — was exercised at any other value, so the other
 * three are **unmeasured** and not offered.
 */
export const SECTOR_BYTES = 512;

/** Bytes in one directory entry, short or long. */
export const DIR_ENTRY_BYTES = 32;

/**
 * Cluster-count thresholds that *define* the three FAT types.
 *
 * Straight from the spec's own determination rule: a volume with fewer than
 * `fat16` clusters is FAT12, fewer than `fat32` is FAT16, and anything else is
 * FAT32. These are exact — 4084 clusters is FAT12 and 4085 is FAT16 — and are
 * the only correct way to answer "what type is this volume".
 */
export const CLUSTER_COUNT_THRESHOLDS = {
  /** A volume with at least this many clusters is FAT16, not FAT12. */
  fat16: 4085,
  /** A volume with at least this many clusters is FAT32, not FAT16. */
  fat32: 65525,
} as const;

/**
 * Largest cluster this writer will address on FAT32.
 *
 * The top four bits of a FAT32 entry are reserved, leaving 28, and the values
 * from `0x0FFFFFF7` up are the bad-cluster and end-of-chain markers.
 */
const FAT32_MAX_CLUSTER = 0x0ffffff6;

/** Directory entry attribute bits. */
const ATTR_READ_ONLY = 0x01;
const ATTR_VOLUME_ID = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;
/** `READ_ONLY | HIDDEN | SYSTEM | VOLUME_ID` — the long-name marker. */
const ATTR_LONG_NAME = 0x0f;

/** Set on the long-name entry that carries the *last* chunk of the name. */
const LAST_LONG_ENTRY = 0x40;

/** UTF-16 code units of a long name carried by one LFN entry. */
const LFN_CHARS_PER_ENTRY = 13;

/** Longest long name the format can express: 20 entries of 13 code units. */
const LFN_MAX_CODE_UNITS = 255;

/** Sector-per-cluster values this writer will choose from. */
const SECTORS_PER_CLUSTER_CHOICES = [1, 2, 4, 8, 16, 32, 64] as const;

/** Two FATs: the mirrored pair every real implementation writes. */
const NUM_FATS = 2;

/**
 * `BPB_RsvdSecCnt`, per type.
 *
 * These are the spec's own numbers, quoted rather than chosen: "This field
 * must not be 0. For FAT12 and FAT16 volumes, this value should never be
 * anything other than 1. For FAT32 volumes, this value is typically 32."
 *
 * So FAT12/16 get exactly 1 and nothing is added to it — not even to align the
 * data region on a cluster boundary, which is a performance idea and not a
 * correctness one, and which is meaningless here anyway because the volume
 * itself starts at whatever byte offset the partition does. Measured on macOS
 * 26.5.2, Apple's own `newfs_msdos` agrees in both directions: a 40 MiB FAT16
 * volume comes back `res=1 spc=4 spf=80 rde=512`, whose first data sector is
 * 193 and therefore not cluster-aligned, and a 400 MiB FAT32 one comes back
 * `res=32 spc=8 bspf=799`, first data sector 1630, also unaligned.
 */
const RESERVED_SECTORS = { 12: 1, 16: 1, 32: 32 } as const;

/** Smallest `BPB_RootEntCnt` this writer emits on FAT12/16. */
const MIN_ROOT_ENTRIES = 512;

/** `BPB_RootEntCnt` is a `uint16`, and must fill whole 512-byte sectors. */
const MAX_ROOT_ENTRIES = 65_520;

/** FAT32 keeps its backup boot sector here, and the FSInfo copy right after. */
const BACKUP_BOOT_SECTOR = 6;

/** FSInfo lives at sector 1 on FAT32. */
const FSINFO_SECTOR = 1;

/** Earliest instant a FAT timestamp can express: 1980-01-01T00:00:00Z. */
const FAT_EPOCH_SECONDS = 315_532_800;

/** Latest instant a FAT timestamp can express: 2107-12-31T23:59:59Z. */
const FAT_MAX_SECONDS = 4_354_819_199;

const encoder = new TextEncoder();

/**
 * Characters legal in an 8.3 short name, beyond `A-Z` and `0-9`.
 *
 * The spec permits bytes above `0x7F` here too, but their meaning depends on
 * the OEM code page in force at read time, so this writer keeps short names
 * ASCII and lets the long name carry everything else.
 */
const SHORT_NAME_SPECIALS = "$%'-_@~`!(){}^#&";

/** Characters a long name may not contain, per the spec's own list. */
const LFN_FORBIDDEN = '"*/:<>?\\|';

/**
 * Raised when an entry cannot be represented faithfully on FAT.
 *
 * Every path that reaches this class is one where the alternative was writing a
 * volume that mounts and holds something other than what was staged.
 */
export class FatEntryError extends Error {
  /** The offending entry's path, as the caller supplied it. */
  readonly path: string;

  /** Build the error from the entry path and a message naming the fix. */
  constructor(path: string, message: string) {
    super(`FAT entry ${JSON.stringify(path)} cannot be written: ${message}`);
    this.name = "FatEntryError";
    this.path = path;
  }
}

/**
 * Raised when no valid geometry exists for the requested window and type.
 *
 * Carries {@linkcode requiredBytes} whenever a larger window would have worked,
 * so a caller can put the number in its own refusal rather than making the user
 * guess.
 */
export class FatGeometryError extends Error {
  /** Smallest window that would have succeeded, when one exists. */
  readonly requiredBytes?: number;

  /** Build the error, optionally naming the window size that would work. */
  constructor(message: string, requiredBytes?: number) {
    super(message);
    this.name = "FatGeometryError";
    this.requiredBytes = requiredBytes;
  }
}

/**
 * One member of the volume.
 *
 * Deliberately the same shape as `TarEntry`, minus the members FAT has no way
 * to hold: there are no symlinks, no ownership and no device nodes here, and
 * `mode` survives only as far as the read-only bit.
 */
export interface FatEntry {
  /**
   * Relative, `/`-separated path. No leading `/`, no `.`/`..` segment, no empty
   * segment. Directory entries are named without a trailing slash.
   *
   * Two paths differing only in case are refused, because FAT resolves names
   * case-insensitively and only one of the two could ever be read back.
   */
  readonly path: string;
  /** What kind of member this is. */
  readonly type: "file" | "dir";
  /**
   * Permission bits.
   *
   * FAT stores no POSIX mode. The owner-write bit maps to `ATTR_READ_ONLY` when
   * clear; every other bit is dropped by the format. Omit it and nothing is
   * inferred.
   */
  readonly mode?: number;
  /** Modification time in seconds. Pinned by the caller for determinism. */
  readonly mtime: number;
  /** File content. Only meaningful for `file`. */
  readonly body?: Uint8Array;
}

/**
 * One member of the volume with its LENGTH in place of its bytes.
 *
 * What {@linkcode minimumFatSizeBytes} and {@linkcode fatGeometryFor} need: the
 * layout depends on how long each file is and on nothing else about it, so a
 * planner can answer "does this fit" from a manifest without reading a single
 * body. `plan()` in the recipe tier does exactly that.
 *
 * `sizeBytes` is required rather than optional on purpose. A `FatEntry[]` is
 * then NOT assignable here, so passing one by mistake is a compile error rather
 * than a sizing pass that reads every body as zero-length and returns a window
 * far too small. Convert a real tree with {@linkcode fatEntryShapes}.
 */
export interface FatEntryShape {
  /** Relative, `/`-separated path, as {@linkcode FatEntry.path}. */
  readonly path: string;
  /** What kind of member this is. */
  readonly type: "file" | "dir";
  /** Body length in bytes. `0` for a directory. */
  readonly sizeBytes: number;
}

/** Everything needed to lay down a volume. */
export interface FatOptions {
  /** The partition window, in bytes. Must be a whole number of sectors. */
  readonly sizeBytes: number;
  /**
   * Which FAT type to write.
   *
   * Omit and the writer picks: FAT16 when the window admits it, FAT32 when the
   * window is too large for FAT16, FAT12 when it is too small. FAT16 is
   * preferred in the middle because it is the type with the widest firmware
   * support at ESP sizes.
   */
  readonly fatType?: 12 | 16 | 32;
  /**
   * Volume label, at most 11 bytes.
   *
   * Written to both `BS_VolLab` and a `ATTR_VOLUME_ID` entry in the root, which
   * is where every tool actually reads it from. Space-padded here; pass it
   * unpadded. An empty label becomes the conventional `NO NAME`.
   */
  readonly label: string;
  /**
   * `BS_VolID`, a `uint32`.
   *
   * Derived by the caller from `determinism.fsSeed`, never drawn at random —
   * random here is the difference between a build that reproduces and one that
   * differs in four bytes every run.
   */
  readonly volumeId: number;
  /**
   * Timestamp for anything the entries do not date themselves, in seconds.
   *
   * Never the host clock. FAT stores a bare local wall clock with no zone, so
   * this is packed by its UTC calendar fields: the *bytes* are then identical
   * on every machine, which is what determinism requires.
   *
   * The Unix timestamp a reader derives from those bytes is a different
   * question, and is not invariant. Measured: the Darwin `msdos` driver applies
   * the reader's own UTC offset, so an entry written from epoch `1700000000`
   * (2023-11-14T22:13:20Z) stats back as `1700028800` on a host eight hours
   * behind UTC. Every FAT implementation does some version of this; it is the
   * format having no timezone, not a writer bug.
   */
  readonly sourceDateEpoch: number;
  /**
   * `BPB_HiddSec`: sectors on the disk before this partition. @default 0
   *
   * Nothing on the UEFI path reads it, but a volume spliced into a partition
   * carries its start LBA here by convention, and some DOS-era tooling uses it
   * to find the volume.
   */
  readonly hiddenSectors?: number;
}

/**
 * A volume's on-disk geometry: everything a reader derives from the BPB.
 *
 * {@linkcode describeFat} recovers this from bytes, which is how a test proves
 * the type a driver will infer matches the type that was asked for.
 */
export interface FatGeometry {
  /** The type implied by {@linkcode clusterCount}, per the spec's thresholds. */
  readonly fatType: 12 | 16 | 32;
  /** `BPB_BytsPerSec`. */
  readonly bytesPerSector: number;
  /** `BPB_SecPerClus`. */
  readonly sectorsPerCluster: number;
  /** `BPB_RsvdSecCnt`, including any alignment padding. */
  readonly reservedSectors: number;
  /** `BPB_NumFATs`. */
  readonly numFats: number;
  /** `BPB_RootEntCnt`; zero on FAT32. */
  readonly rootEntryCount: number;
  /** `BPB_FATSz16` or `BPB_FATSz32`, in sectors. */
  readonly fatSectors: number;
  /** `BPB_TotSec16` or `BPB_TotSec32`. */
  readonly totalSectors: number;
  /** Sectors the fixed root directory occupies; zero on FAT32. */
  readonly rootDirSectors: number;
  /** First sector of the data region — cluster 2 begins here. */
  readonly firstDataSector: number;
  /** `CountofClusters`: the number that decides the type. */
  readonly clusterCount: number;
}

/** The FAT type implied by a cluster count, by the spec's own rule. */
function typeForClusterCount(clusterCount: number): 12 | 16 | 32 {
  if (clusterCount < CLUSTER_COUNT_THRESHOLDS.fat16) return 12;
  if (clusterCount < CLUSTER_COUNT_THRESHOLDS.fat32) return 16;
  return 32;
}

/** Sectors needed to hold the FAT for `clusterCount` clusters. */
function fatSectorsFor(clusterCount: number, fatType: 12 | 16 | 32): number {
  // Entries 0 and 1 are reserved and occupy real space in the table.
  const entries = clusterCount + 2;
  const bytes = fatType === 12
    ? Math.ceil((entries * 3) / 2)
    : entries * (fatType === 16 ? 2 : 4);
  return Math.ceil(bytes / SECTOR_BYTES);
}

/**
 * Pack a Unix timestamp into FAT's date and time words.
 *
 * The date is `(year-1980)<<9 | month<<5 | day` and the time is
 * `hour<<11 | minute<<5 | second/2` — two-second granularity, which is why the
 * separate tenths field exists to carry the odd second on creation time.
 */
function packDateTime(
  epochSeconds: number,
  path: string,
): { date: number; time: number; tenth: number } {
  if (!Number.isSafeInteger(epochSeconds)) {
    throw new FatEntryError(
      path,
      `mtime ${epochSeconds} is not an integer number of seconds. Pin it to ` +
        "determinism.sourceDateEpoch.",
    );
  }
  if (epochSeconds < FAT_EPOCH_SECONDS || epochSeconds > FAT_MAX_SECONDS) {
    throw new FatEntryError(
      path,
      `mtime ${epochSeconds} falls outside the range a FAT timestamp can ` +
        `express (${FAT_EPOCH_SECONDS}..${FAT_MAX_SECONDS}, i.e. 1980-01-01 ` +
        "through 2107-12-31 UTC). A value outside it would wrap to a " +
        "different date rather than fail. Pick a timestamp inside it.",
    );
  }
  // UTC getters on purpose: FAT records local time with no zone, so reading
  // the epoch as UTC is what makes two builds on two machines agree.
  const at = new Date(epochSeconds * 1000);
  const date = ((at.getUTCFullYear() - 1980) << 9) |
    ((at.getUTCMonth() + 1) << 5) |
    at.getUTCDate();
  const time = (at.getUTCHours() << 11) |
    (at.getUTCMinutes() << 5) |
    (at.getUTCSeconds() >> 1);
  return { date, time, tenth: (at.getUTCSeconds() & 1) * 100 };
}

/** True when `code` is legal in an 8.3 short name. */
function isShortNameChar(code: number): boolean {
  const char = String.fromCharCode(code);
  if (char >= "A" && char <= "Z") return true;
  if (char >= "0" && char <= "9") return true;
  return SHORT_NAME_SPECIALS.includes(char);
}

/**
 * True when `name` is already a valid 8.3 name that survives the trip
 * unchanged.
 *
 * Lowercase deliberately fails this test. A short entry stores the name
 * uppercased, and the `DIR_NTRes` case flags that would restore it are a
 * Windows extension this writer does not emit — so `grub.cfg` needs a long name
 * to come back as `grub.cfg` rather than `GRUB.CFG`.
 */
function isExactShortName(name: string): boolean {
  if (name.length === 0 || name.length > 12) return false;
  if (name.startsWith(".")) return false;
  const dot = name.indexOf(".");
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? "" : name.slice(dot + 1);
  if (base.length === 0 || base.length > 8) return false;
  if (ext.length > 3) return false;
  if (ext.includes(".")) return false;
  for (const char of base + ext) {
    if (!isShortNameChar(char.charCodeAt(0))) return false;
  }
  return true;
}

/** Render a base/extension pair into the 11 padded bytes of `DIR_Name`. */
function packShortName(base: string, ext: string): Uint8Array {
  const bytes = new Uint8Array(11).fill(0x20);
  for (let index = 0; index < base.length && index < 8; index++) {
    bytes[index] = base.charCodeAt(index);
  }
  for (let index = 0; index < ext.length && index < 3; index++) {
    bytes[8 + index] = ext.charCodeAt(index);
  }
  // 0xE5 in the first byte marks a deleted entry. The spec's escape is 0x05,
  // which reads back as 0xE5. Unreachable from the ASCII short names generated
  // here, and written anyway because the day it becomes reachable it would
  // otherwise delete a file that is present.
  if (bytes[0] === 0xe5) bytes[0] = 0x05;
  return bytes;
}

/** Short names already used in one directory, and where to resume tailing. */
interface ShortNameScope {
  /** The 11 packed bytes of every short name issued here, as a string key. */
  readonly taken: Set<string>;
  /**
   * The next `~N` to try, for the whole directory rather than per basis.
   *
   * Restarting the scan at 1 for every name makes short-name assignment
   * quadratic, because truncation collapses many long names onto the same
   * six-character stem: `file-1000.txt` through `file-19999.txt` all compete
   * for `FILE-1~N`. Measured before this counter existed, on a flat directory
   * of `file-N.txt`: 1000 names 3 ms, 2000 186 ms, 4000 1642 ms, 8000 9827 ms.
   * `plan()` calls this to size a partition, so that curve is a pure function
   * hanging on a large staging tree. With the counter, the same four sizes are
   * 3, 7, 12 and 26 ms.
   *
   * Advancing monotonically can leave a `~1` unused when an unrelated basis
   * had one free. That is legal, deterministic — it is a function of
   * declaration order and nothing else — and invisible, because every name
   * that gets a tail also carries a long-name run holding the real one.
   */
  next: number;
}

/**
 * Choose the 8.3 short name for one long name, unique within its directory.
 *
 * Returns the short name and whether a long-name run is needed to recover the
 * original. The numeric `~N` tail only appears on collision: a plain basis with
 * an LFN beside it is legal, and leaves the short names readable.
 */
function shortNameFor(
  longName: string,
  scope: ShortNameScope,
  path: string,
): { short: Uint8Array; needsLfn: boolean } {
  const taken = scope.taken;
  if (isExactShortName(longName)) {
    const dot = longName.indexOf(".");
    const base = dot < 0 ? longName : longName.slice(0, dot);
    const ext = dot < 0 ? "" : longName.slice(dot + 1);
    const short = packShortName(base, ext);
    const key = String.fromCharCode(...short);
    if (!taken.has(key)) {
      taken.add(key);
      return { short, needsLfn: false };
    }
    // Two entries whose names differ only in ways the short form erases. The
    // generator below gives the second one a tail.
  }

  // The basis: spaces and embedded periods removed, illegal bytes replaced,
  // uppercased. Replacing rather than dropping keeps distinct names distinct.
  const stripped = [...longName].filter((c) => c !== " ");
  const lastDot = stripped.lastIndexOf(".");
  const rawBase = (lastDot <= 0 ? stripped : stripped.slice(0, lastDot))
    .filter((c) => c !== ".");
  const rawExt = lastDot <= 0 ? [] : stripped.slice(lastDot + 1);
  const clean = (chars: string[]) =>
    chars
      .map((char) => {
        const upper = char.toUpperCase();
        return upper.length === 1 && isShortNameChar(upper.charCodeAt(0))
          ? upper
          : "_";
      })
      .join("");
  const base = clean(rawBase) || "_";
  const ext = clean(rawExt).slice(0, 3);

  const plain = packShortName(base.slice(0, 8), ext);
  const plainKey = String.fromCharCode(...plain);
  if (!taken.has(plainKey)) {
    taken.add(plainKey);
    return { short: plain, needsLfn: true };
  }
  for (let n = scope.next; n <= 999_999; n++) {
    const tail = `~${n}`;
    const candidate = packShortName(
      base.slice(0, Math.max(1, 8 - tail.length)) + tail,
      ext,
    );
    const key = String.fromCharCode(...candidate);
    if (!taken.has(key)) {
      taken.add(key);
      scope.next = n + 1;
      return { short: candidate, needsLfn: true };
    }
  }
  throw new FatEntryError(
    path,
    "no unique 8.3 short name is left for this directory — every `~N` tail " +
      "through ~999999 is taken. Shorten the names or split the directory.",
  );
}

/**
 * The checksum binding a long-name run to its short entry.
 *
 * A rotate-right-and-add over the 11 short-name bytes. A reader that finds a
 * mismatch throws the long name away and uses the 8.3 name, so this is the
 * field that decides whether a file has the name it was staged under.
 */
function shortNameChecksum(short: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < 11; index++) {
    sum = (((sum & 1) << 7) + (sum >> 1) + short[index]) & 0xff;
  }
  return sum;
}

/** Long-name entries needed for a name, or 0 when the short entry suffices. */
function lfnEntryCount(needsLfn: boolean, longName: string): number {
  if (!needsLfn) return 0;
  // UTF-16 code units, not code points: an emoji costs two of the thirteen.
  const units = [...longName]
    .reduce((total, char) => total + char.length, 0);
  return Math.ceil(units / LFN_CHARS_PER_ENTRY);
}

/**
 * Either shape a caller can stage an entry as.
 *
 * `buildFat` takes bodies; the sizing entry points take lengths. The layout
 * arithmetic only ever needs the length, so both go through one tree builder
 * and the two can never disagree about how big a volume has to be.
 */
type StagedEntry =
  | (FatEntry & { readonly sizeBytes?: undefined })
  | (FatEntryShape & {
    readonly mtime?: undefined;
    readonly mode?: undefined;
    readonly body?: undefined;
  });

/** One node of the staged tree, with its layout decided. */
interface Node {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "dir";
  readonly mtime: number;
  readonly mode?: number;
  readonly body?: Uint8Array;
  /** Body length. From `body` when there is one, else declared. */
  readonly sizeBytes: number;
  readonly children: Node[];
  short: Uint8Array;
  needsLfn: boolean;
  /** Directory entries this node consumes in its parent, LFN run included. */
  slots: number;
  firstCluster: number;
  clusterCount: number;
  /** Bytes the directory's own entry table occupies. Directories only. */
  dirBytes: number;
}

/** Validate one path component as a long name. */
function checkLongName(name: string, path: string): void {
  if (name.length === 0) {
    throw new FatEntryError(path, "a path component is empty. Name the file.");
  }
  const units = [...name].reduce((total, char) => total + char.length, 0);
  if (units > LFN_MAX_CODE_UNITS) {
    throw new FatEntryError(
      path,
      `the component ${JSON.stringify(name)} is ${units} UTF-16 code units, ` +
        `over the ${LFN_MAX_CODE_UNITS} a long-name run can carry (20 entries ` +
        "of 13). Shorten it.",
    );
  }
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20) {
      throw new FatEntryError(
        path,
        `the component ${JSON.stringify(name)} contains control byte ` +
          `0x${code.toString(16).padStart(2, "0")}, which no FAT name may ` +
          "hold. Rename the file.",
      );
    }
    if (LFN_FORBIDDEN.includes(char)) {
      throw new FatEntryError(
        path,
        `the component ${JSON.stringify(name)} contains ${
          JSON.stringify(char)
        }, which FAT reserves. Rename the file.`,
      );
    }
  }
  if (name.endsWith(" ") || name.endsWith(".")) {
    throw new FatEntryError(
      path,
      `the component ${JSON.stringify(name)} ends in a space or period. FAT ` +
        "readers strip both, so it would arrive under a different name. " +
        "Rename the file.",
    );
  }
}

/**
 * A path folded the way FAT name lookup compares one.
 *
 * Every FAT implementation resolves names case-INSENSITIVELY: the short entry
 * literally stores an uppercased 8.3 name, and a long name is matched through
 * an upcase table. So `EFI/BOOT/grub.cfg` and `EFI/BOOT/GRUB.CFG` are one name
 * to a reader, whatever the two directory entries say.
 *
 * Folded one UTF-16 code unit at a time, and only where the uppercase form is
 * itself one code unit — which is what an upcase table does, and what keeps
 * `ß` from folding onto `SS` and colliding with a file genuinely named that.
 * `toUpperCase` rather than `toLocaleUpperCase`: the locale-aware form maps
 * `i` to `İ` under a Turkish locale, which would make this refusal depend on
 * the machine's settings.
 */
function foldPath(path: string): string {
  let out = "";
  for (let index = 0; index < path.length; index++) {
    const unit = path[index];
    const upper = unit.toUpperCase();
    out += upper.length === 1 ? upper : unit;
  }
  return out;
}

/**
 * Assemble the staged entries into a tree.
 *
 * A file whose parent directory has no entry of its own is refused rather than
 * given a synthesized parent: the directory would carry an invented timestamp,
 * and a typo in a path would silently produce a new directory instead of an
 * error.
 *
 * Two paths that differ only in case are refused for a sharper reason. Both
 * would be written, as two valid directory entries, and a reader resolves both
 * names to whichever came first — so one of the two files staged is
 * unreachable, and its name answers with the other's contents.
 *
 * Measured on macOS 26.5.2 against a volume built with `a.txt`/`A.txt` and
 * `EFI/BOOT/grub.cfg`/`EFI/BOOT/GRUB.CFG`: `fsck_msdos -n` exits 0 and reports
 * "6 files, 8108 KiB free", the Darwin `msdos` driver mounts it, `readdir`
 * lists both names in each directory — and `open()` on either name in a pair
 * returns the FIRST entry's bytes. Nothing anywhere reports a problem; the
 * second file is simply gone. That is a valid artifact holding less than was
 * passed, which is the one thing this package refuses everywhere.
 */
function buildTree(entries: readonly StagedEntry[]): Node {
  const root: Node = {
    path: "",
    name: "",
    type: "dir",
    mtime: 0,
    sizeBytes: 0,
    children: [],
    short: new Uint8Array(11),
    needsLfn: false,
    slots: 0,
    firstCluster: 0,
    clusterCount: 0,
    dirBytes: 0,
  };
  const byPath = new Map<string, Node>([["", root]]);
  // Keyed the way a FAT reader compares names, which is the key that decides
  // whether two entries are the same file. `byPath` stays exact so a parent
  // must be declared under the spelling its children use.
  const byFoldedPath = new Map<string, Node>([["", root]]);

  for (const entry of entries) {
    const path = entry.path;
    if (path.length === 0) {
      throw new FatEntryError(path, "the path is empty. Name the file.");
    }
    if (path.startsWith("/")) {
      throw new FatEntryError(
        path,
        "the path is absolute. Pass it relative to the volume root.",
      );
    }
    if (path.endsWith("/")) {
      throw new FatEntryError(
        path,
        "the path has a trailing `/`. Name a directory without one.",
      );
    }
    const segments = path.split("/");
    for (const segment of segments) {
      if (segment === "") {
        throw new FatEntryError(
          path,
          "the path has an empty segment (a doubled `/`). Pass exactly one " +
            "`/` between segments.",
        );
      }
      if (segment === "." || segment === "..") {
        throw new FatEntryError(
          path,
          `the path has a ${JSON.stringify(segment)} segment. FAT stores ` +
            "those as the directory's own back-references, so an entry named " +
            "for one would collide with them. Pass the resolved path.",
        );
      }
    }
    const name = segments[segments.length - 1];
    checkLongName(name, path);

    const parentPath = segments.slice(0, -1).join("/");
    const parent = byPath.get(parentPath);
    if (parent === undefined) {
      // A parent declared under a different case is a near-miss worth naming:
      // the alternative is a "no entry" message about a directory the caller
      // can see in its own list.
      const nearly = byFoldedPath.get(foldPath(parentPath));
      throw new FatEntryError(
        path,
        `its parent directory ${JSON.stringify(parentPath)} has no entry. ` +
          (nearly === undefined
            ? "Emit a `dir` entry for every parent before its children — a " +
              "synthesized parent would carry an invented mtime, and a " +
              "mistyped path would silently become a new directory."
            : `The tree does declare ${JSON.stringify(nearly.path)}, which ` +
              "differs only in case; spell this path the same way, since FAT " +
              "would put the child inside that one directory either way."),
      );
    }
    if (parent.type !== "dir") {
      throw new FatEntryError(
        path,
        `its parent ${JSON.stringify(parentPath)} is a file, not a directory.`,
      );
    }
    const collision = byFoldedPath.get(foldPath(path));
    if (collision !== undefined) {
      throw new FatEntryError(
        path,
        collision.path === path
          ? "it is declared twice."
          : `it differs from ${JSON.stringify(collision.path)} only in case, ` +
            "and FAT resolves names case-insensitively. Both would be " +
            "written, both would resolve to the same one file, and the other " +
            "would be unreachable under a name that answers with the wrong " +
            "contents. Rename one of the two, or drop it.",
      );
    }
    if (entry.type === "dir" && entry.body !== undefined) {
      throw new FatEntryError(
        path,
        "it is a directory carrying a body. The body would be dropped. Make " +
          'the entry type "file".',
      );
    }
    const declared = entry.sizeBytes;
    if (
      declared !== undefined &&
      (!Number.isSafeInteger(declared) || declared < 0)
    ) {
      throw new FatEntryError(
        path,
        `sizeBytes ${declared} is not a whole number of bytes at or above ` +
          "zero, so no cluster count can be derived from it. Pass the file's " +
          "length.",
      );
    }
    const sizeBytes = entry.type !== "file"
      ? 0
      : entry.body?.byteLength ?? declared ?? 0;

    const node: Node = {
      path,
      name,
      type: entry.type,
      mtime: entry.mtime ?? 0,
      mode: entry.mode,
      body: entry.type === "file" ? entry.body : undefined,
      sizeBytes,
      children: [],
      short: new Uint8Array(11),
      needsLfn: false,
      slots: 0,
      firstCluster: 0,
      clusterCount: 0,
      dirBytes: 0,
    };
    parent.children.push(node);
    byPath.set(path, node);
    byFoldedPath.set(foldPath(path), node);
  }
  return root;
}

/** Assign short names and count the entry slots each directory needs. */
function assignNames(directory: Node): void {
  const scope: ShortNameScope = { taken: new Set<string>(), next: 1 };
  for (const child of directory.children) {
    const { short, needsLfn } = shortNameFor(child.name, scope, child.path);
    child.short = short;
    child.needsLfn = needsLfn;
    child.slots = lfnEntryCount(needsLfn, child.name) + 1;
    if (child.type === "dir") assignNames(child);
  }
}

/**
 * Entry slots a directory's own table holds.
 *
 * The `+ 1` is a free slot kept past the last entry. A directory whose entries
 * exactly fill its clusters is legal — the chain's end terminates the scan —
 * but a `0x00` first byte is what readers look for first, and leaving one
 * costs 32 bytes.
 */
function directorySlots(directory: Node, isRoot: boolean): number {
  const own = isRoot ? 0 : 2; // "." and ".."
  const label = isRoot ? 1 : 0; // the ATTR_VOLUME_ID entry
  const children = directory.children.reduce(
    (total, child) => total + child.slots,
    0,
  );
  return own + label + children + 1;
}

/** Solve for a geometry, or `undefined` when the window cannot hold one. */
function solveGeometry(
  totalSectors: number,
  fatType: 12 | 16 | 32,
  sectorsPerCluster: number,
  rootEntryCount: number,
): FatGeometry | undefined {
  // A FAT12/16 root larger than BPB_RootEntCnt can describe has no geometry at
  // all, whatever the window. Answered here rather than only in
  // resolveGeometry() so defaultFatType() cannot pick FAT16 for such a tree and
  // then write a truncated uint16 into the BPB.
  if (fatType !== 32 && rootEntryCount > MAX_ROOT_ENTRIES) return undefined;

  const rootEntries = fatType === 32 ? 0 : rootEntryCount;
  const rootDirSectors = Math.ceil(
    (rootEntries * DIR_ENTRY_BYTES) / SECTOR_BYTES,
  );
  // Exactly the spec's value, with nothing added. See RESERVED_SECTORS.
  const reserved = RESERVED_SECTORS[fatType];

  const layout = (fatSectors: number) => {
    const firstDataSector = reserved + NUM_FATS * fatSectors + rootDirSectors;
    const clusterCount = firstDataSector >= totalSectors
      ? 0
      : Math.floor((totalSectors - firstDataSector) / sectorsPerCluster);
    return { firstDataSector, clusterCount };
  };

  // Increasing the FAT shrinks the data region, which shrinks the cluster
  // count, which shrinks the FAT needed: monotone, so climbing from 1 until
  // the table is big enough terminates.
  let fatSectors = 1;
  for (let guard = 0; guard < 64; guard++) {
    const { clusterCount } = layout(fatSectors);
    if (clusterCount === 0) return undefined;
    const needed = fatSectorsFor(clusterCount, fatType);
    if (needed <= fatSectors) break;
    fatSectors = needed;
  }
  // Then walk back down to the smallest table that still fits, so the answer is
  // canonical rather than wherever the climb happened to land.
  while (fatSectors > 1) {
    const { clusterCount } = layout(fatSectors - 1);
    if (clusterCount === 0) break;
    if (fatSectorsFor(clusterCount, fatType) > fatSectors - 1) break;
    fatSectors--;
  }

  const { firstDataSector, clusterCount } = layout(fatSectors);
  if (clusterCount === 0) return undefined;
  if (fatSectorsFor(clusterCount, fatType) > fatSectors) return undefined;
  if (fatType === 32 && clusterCount > FAT32_MAX_CLUSTER) return undefined;

  return {
    fatType,
    bytesPerSector: SECTOR_BYTES,
    sectorsPerCluster,
    reservedSectors: reserved,
    numFats: NUM_FATS,
    rootEntryCount: rootEntries,
    fatSectors,
    totalSectors,
    rootDirSectors,
    firstDataSector,
    clusterCount,
  };
}

/** True when a cluster count sits inside the range that *defines* `fatType`. */
function clusterCountMatches(count: number, fatType: 12 | 16 | 32): boolean {
  return typeForClusterCount(count) === fatType;
}

/**
 * Find the geometry for a window, refusing rather than emitting a mismatch.
 *
 * The smallest cluster that lands the count inside the requested type's range
 * wins, because a larger cluster only wastes more of each file's last one.
 */
function chooseGeometry(
  totalSectors: number,
  fatType: 12 | 16 | 32,
  rootEntryCount: number,
): FatGeometry | undefined {
  for (const sectorsPerCluster of SECTORS_PER_CLUSTER_CHOICES) {
    const geometry = solveGeometry(
      totalSectors,
      fatType,
      sectorsPerCluster,
      rootEntryCount,
    );
    if (geometry === undefined) continue;
    if (clusterCountMatches(geometry.clusterCount, fatType)) return geometry;
  }
  return undefined;
}

/** Data clusters a tree needs at a given cluster size. */
function clustersNeeded(root: Node, geometry: FatGeometry): number {
  const clusterBytes = geometry.sectorsPerCluster * SECTOR_BYTES;
  let total = geometry.fatType === 32
    ? Math.ceil(
      (directorySlots(root, true) * DIR_ENTRY_BYTES) / clusterBytes,
    )
    : 0;
  const walk = (directory: Node) => {
    for (const child of directory.children) {
      if (child.type === "dir") {
        total += Math.ceil(
          (directorySlots(child, false) * DIR_ENTRY_BYTES) / clusterBytes,
        );
        walk(child);
      } else {
        // A zero-length file gets no cluster at all: its DIR_FstClus must be 0,
        // and an allocated cluster on a size-0 entry is what fsck flags.
        total += Math.ceil(child.sizeBytes / clusterBytes);
      }
    }
  };
  walk(root);
  return total;
}

/** Root directory slots a tree needs, clamped to what a FAT12/16 BPB holds. */
function rootEntryCountFor(root: Node): number {
  const needed = directorySlots(root, true);
  // Whole sectors: 512 bytes hold exactly 16 entries.
  const rounded = Math.max(
    MIN_ROOT_ENTRIES,
    Math.ceil(needed / (SECTOR_BYTES / DIR_ENTRY_BYTES)) *
      (SECTOR_BYTES / DIR_ENTRY_BYTES),
  );
  return rounded;
}

/** Pick the type for a window when the caller did not name one. */
function defaultFatType(
  totalSectors: number,
  rootEntryCount: number,
): 12 | 16 | 32 | undefined {
  for (const candidate of [16, 32, 12] as const) {
    if (chooseGeometry(totalSectors, candidate, rootEntryCount) !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

/** Resolve options and tree into a geometry, or throw naming the fix. */
function resolveGeometry(
  root: Node,
  options: Pick<FatOptions, "sizeBytes" | "fatType">,
): FatGeometry {
  if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes <= 0) {
    throw new FatGeometryError(
      `sizeBytes ${options.sizeBytes} is not a positive integer.`,
    );
  }
  if (options.sizeBytes % SECTOR_BYTES !== 0) {
    throw new FatGeometryError(
      `sizeBytes ${options.sizeBytes} is not a whole number of ` +
        `${SECTOR_BYTES}-byte sectors. A FAT volume is described in sectors, ` +
        `so the remainder would be unaddressable. Round to ` +
        `${Math.floor(options.sizeBytes / SECTOR_BYTES) * SECTOR_BYTES} or ` +
        `${Math.ceil(options.sizeBytes / SECTOR_BYTES) * SECTOR_BYTES}.`,
    );
  }
  if (
    options.fatType !== undefined && options.fatType !== 12 &&
    options.fatType !== 16 && options.fatType !== 32
  ) {
    throw new FatGeometryError(
      `fatType ${options.fatType} is not one of 12, 16 or 32.`,
    );
  }
  const totalSectors = options.sizeBytes / SECTOR_BYTES;
  const rootEntries = rootEntryCountFor(root);

  // The type is resolved BEFORE the FAT12/16 root ceiling is applied. The
  // ceiling does not exist on FAT32 — its root is an ordinary cluster chain —
  // so checking it first refused an explicit `fatType: 32` with a message
  // telling the caller to pass `fatType: 32`. defaultFatType() sees the same
  // ceiling through solveGeometry(), so an over-ceiling tree resolves to 32 by
  // itself rather than to a FAT16 whose BPB_RootEntCnt would not fit a uint16.
  const fatType = options.fatType ?? defaultFatType(totalSectors, rootEntries);
  if (fatType !== 32 && rootEntries > MAX_ROOT_ENTRIES) {
    throw new FatGeometryError(
      `the root directory needs ${rootEntries} entries, over the ` +
        `${MAX_ROOT_ENTRIES} a FAT12/16 BPB can describe` +
        (fatType === undefined
          ? ", and this window is too small to format FAT32, whose root is " +
            "an ordinary cluster chain with no such limit. Move files into a " +
            "subdirectory, or grow the partition."
          : ". Move files into a subdirectory, or pass `fatType: 32`, whose " +
            "root is an ordinary cluster chain with no such limit."),
    );
  }
  if (fatType === undefined) {
    throw new FatGeometryError(
      `no FAT geometry exists for a ${options.sizeBytes}-byte window: it is ` +
        "too small to hold a boot sector, two FATs and a single cluster. The " +
        `smallest window this writer can format is ${minimumFormattableBytes()}` +
        " bytes.",
    );
  }

  const geometry = chooseGeometry(totalSectors, fatType, rootEntries);
  if (geometry === undefined) {
    throw new FatGeometryError(
      `a ${options.sizeBytes}-byte window cannot be formatted FAT${fatType}: ` +
        "no legal cluster size puts the cluster count inside the range that " +
        `defines FAT${fatType} (${describeRange(fatType)}). ` +
        `${suggestType(totalSectors, rootEntries, fatType)}`,
    );
  }

  const needed = clustersNeeded(root, geometry);
  if (needed > geometry.clusterCount) {
    // `options.fatType`, deliberately, not the `fatType` resolved above. When
    // the caller did not pin a type, the default is a function of the window,
    // so a larger window can resolve to a *different* type — and sizing the
    // answer for the type this window happens to have produces a number that
    // does not build. Letting the type float here means the size in the
    // refusal is the size that works.
    const required = minimumSizeForTree(root, options.fatType);
    throw new FatGeometryError(
      `the staged tree needs ${needed} clusters of ` +
        `${geometry.sectorsPerCluster * SECTOR_BYTES} bytes, but a ` +
        `${options.sizeBytes}-byte FAT${fatType} window has only ` +
        `${geometry.clusterCount}. Grow the partition to at least ` +
        `${required} bytes.`,
      required,
    );
  }
  return geometry;
}

/** Human-readable cluster range for a type, for use in refusals. */
function describeRange(fatType: 12 | 16 | 32): string {
  if (fatType === 12) return `1..${CLUSTER_COUNT_THRESHOLDS.fat16 - 1}`;
  if (fatType === 16) {
    return `${CLUSTER_COUNT_THRESHOLDS.fat16}..${
      CLUSTER_COUNT_THRESHOLDS.fat32 - 1
    }`;
  }
  return `${CLUSTER_COUNT_THRESHOLDS.fat32} or more`;
}

/** Name a type that would work, when one does, for use in refusals. */
function suggestType(
  totalSectors: number,
  rootEntryCount: number,
  refused: 12 | 16 | 32,
): string {
  const workable = ([12, 16, 32] as const).filter(
    (candidate) =>
      candidate !== refused &&
      chooseGeometry(totalSectors, candidate, rootEntryCount) !== undefined,
  );
  if (workable.length === 0) {
    return "No FAT type fits this window; resize the partition.";
  }
  return `Pass \`fatType: ${workable[0]}\`, or resize the partition.`;
}

/** The smallest window any FAT type can be laid out in, in bytes. */
function minimumFormattableBytes(): number {
  for (let sectors = 4; sectors <= 4096; sectors++) {
    if (defaultFatType(sectors, MIN_ROOT_ENTRIES) !== undefined) {
      return sectors * SECTOR_BYTES;
    }
  }
  return MIN_ROOT_ENTRIES * DIR_ENTRY_BYTES;
}

/**
 * Smallest window that holds an already-built tree at `fatType`.
 *
 * Doubling search, then bisection — the geometry is not a closed form, because
 * the FAT size, the root-directory size and the cluster count each depend on
 * the other two. The bisection is *not* assumed sound: the predicate is not
 * monotone at single-sector resolution, because crossing a cluster-size or
 * FAT-type change can make a larger window hold fewer clusters. So the result
 * is confirmed by stepping up one sector at a time until it genuinely fits,
 * which is what makes the number safe to print in a refusal.
 */
function minimumSizeForTree(root: Node, fatType?: 12 | 16 | 32): number {
  const rootEntries = rootEntryCountFor(root);

  const fits = (sizeBytes: number): boolean => {
    const totalSectors = sizeBytes / SECTOR_BYTES;
    const chosen = fatType ?? defaultFatType(totalSectors, rootEntries);
    if (chosen === undefined) return false;
    const geometry = chooseGeometry(totalSectors, chosen, rootEntries);
    if (geometry === undefined) return false;
    return clustersNeeded(root, geometry) <= geometry.clusterCount;
  };

  let high = SECTOR_BYTES * 8;
  for (let guard = 0;; guard++) {
    if (fits(high)) break;
    if (guard >= 48) {
      throw new FatGeometryError(
        `no window up to ${high} bytes holds this tree at the requested type.`,
      );
    }
    high *= 2;
  }
  let low = SECTOR_BYTES;
  while (low < high) {
    const mid = Math.floor((low + high) / (2 * SECTOR_BYTES)) * SECTOR_BYTES;
    if (mid <= low) break;
    if (fits(mid)) high = mid;
    else low = mid;
  }
  while (!fits(high)) high += SECTOR_BYTES;
  return high;
}

/**
 * Smallest window that holds `entries` at the requested type.
 *
 * A caller uses this to state a required size in its own refusal rather than
 * making the user bisect by hand. Omit `fatType` and the answer is the smallest
 * window at whichever type the writer would have picked for it.
 *
 * Takes lengths rather than bodies, so `plan()` can size a partition from a
 * resolver manifest without reading a byte of it. Convert a tree you already
 * hold with {@linkcode fatEntryShapes}.
 *
 * @throws {FatEntryError} if an entry cannot be represented on FAT at all.
 * @throws {FatGeometryError} if no window of any size holds the tree at the
 * requested type — a FAT12 volume caps out at 4084 clusters, so a large enough
 * tree has no FAT12 answer.
 */
export function minimumFatSizeBytes(
  entries: readonly FatEntryShape[],
  options: Pick<FatOptions, "fatType"> = {},
): number {
  const root = buildTree(entries);
  assignNames(root);
  return minimumSizeForTree(root, options.fatType);
}

/**
 * Drop the bodies off a staged tree, keeping what decides the layout.
 *
 * The bridge between {@linkcode buildFat}'s input and the sizing entry points,
 * so a caller holding real bytes never has to restate their lengths by hand and
 * get one wrong.
 */
export function fatEntryShapes(
  entries: readonly FatEntry[],
): FatEntryShape[] {
  return entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
    sizeBytes: entry.type === "file" ? entry.body?.byteLength ?? 0 : 0,
  }));
}

/**
 * The geometry a window would get for a tree, or the reason it cannot have one.
 *
 * This is {@linkcode buildFat}'s own resolution step with the writing left out,
 * exported so a planner can refuse ahead of time using the same arithmetic that
 * will run later. Answering the question twice with two implementations is how
 * a plan that says yes turns into a build that says no.
 *
 * @param entries The tree, as lengths — see {@linkcode fatEntryShapes}.
 * @param options The window and, optionally, the type to pin.
 * @returns The geometry that would be written.
 * @throws {FatEntryError} if an entry cannot be represented on FAT.
 * @throws {FatGeometryError} if the window cannot hold the tree, or cannot be
 * formatted as the requested type. {@linkcode FatGeometryError.requiredBytes}
 * carries the window that would work whenever the tree is what did not fit.
 */
export function fatGeometryFor(
  entries: readonly FatEntryShape[],
  options: Pick<FatOptions, "sizeBytes" | "fatType">,
): FatGeometry {
  const root = buildTree(entries);
  assignNames(root);
  return resolveGeometry(root, options);
}

/** Write a FAT entry, packing 12-bit ones across their byte boundary. */
function setFatEntry(
  fat: Uint8Array,
  index: number,
  value: number,
  fatType: 12 | 16 | 32,
): void {
  if (fatType === 12) {
    const at = index + (index >> 1); // floor(index * 3 / 2)
    if ((index & 1) === 0) {
      fat[at] = value & 0xff;
      fat[at + 1] = (fat[at + 1] & 0xf0) | ((value >> 8) & 0x0f);
    } else {
      fat[at] = (fat[at] & 0x0f) | ((value << 4) & 0xf0);
      fat[at + 1] = (value >> 4) & 0xff;
    }
    return;
  }
  const view = new DataView(fat.buffer, fat.byteOffset, fat.byteLength);
  if (fatType === 16) {
    view.setUint16(index * 2, value & 0xffff, true);
    return;
  }
  // The top four bits of a FAT32 entry are reserved and must be preserved.
  const previous = view.getUint32(index * 4, true);
  view.setUint32(
    index * 4,
    (previous & 0xf0000000) | (value & 0x0fffffff),
    true,
  );
}

/** End-of-chain marker for a type. */
function endOfChain(fatType: 12 | 16 | 32): number {
  return fatType === 12 ? 0xfff : fatType === 16 ? 0xffff : 0x0fffffff;
}

/** Write one 32-byte short directory entry. */
function writeShortEntry(
  out: Uint8Array,
  at: number,
  fields: {
    short: Uint8Array;
    attributes: number;
    firstCluster: number;
    sizeBytes: number;
    date: number;
    time: number;
    tenth: number;
  },
): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out.set(fields.short, at);
  out[at + 11] = fields.attributes;
  // DIR_NTRes: the two Windows case flags live here. Zero, because this writer
  // uses a long name to carry case rather than a flag half the world ignores.
  out[at + 12] = 0;
  out[at + 13] = fields.tenth;
  view.setUint16(at + 14, fields.time, true); // DIR_CrtTime
  view.setUint16(at + 16, fields.date, true); // DIR_CrtDate
  view.setUint16(at + 18, fields.date, true); // DIR_LstAccDate
  view.setUint16(at + 20, (fields.firstCluster >>> 16) & 0xffff, true);
  view.setUint16(at + 22, fields.time, true); // DIR_WrtTime
  view.setUint16(at + 24, fields.date, true); // DIR_WrtDate
  view.setUint16(at + 26, fields.firstCluster & 0xffff, true);
  view.setUint32(at + 28, fields.sizeBytes, true);
}

/**
 * Write the long-name run preceding a short entry.
 *
 * Physically reversed: the chunk holding the *end* of the name is stored first
 * and carries `LAST_LONG_ENTRY`, and ordinal 1 sits immediately before the
 * short entry. Returns the number of entries written.
 */
function writeLongName(
  out: Uint8Array,
  at: number,
  name: string,
  short: Uint8Array,
): number {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const units: number[] = [];
  for (const char of name) {
    for (let index = 0; index < char.length; index++) {
      units.push(char.charCodeAt(index));
    }
  }
  const count = Math.ceil(units.length / LFN_CHARS_PER_ENTRY);
  const checksum = shortNameChecksum(short);
  // Slots within one entry: 5 code units, then 6, then 2.
  const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];

  for (let ordinal = count; ordinal >= 1; ordinal--) {
    const entryAt = at + (count - ordinal) * DIR_ENTRY_BYTES;
    out[entryAt] = ordinal | (ordinal === count ? LAST_LONG_ENTRY : 0);
    out[entryAt + 11] = ATTR_LONG_NAME;
    out[entryAt + 12] = 0; // LDIR_Type: zero means a name component.
    out[entryAt + 13] = checksum;
    // LDIR_FstClusLO must be zero; a non-zero value here is how a reader tells
    // a long-name entry apart from a corrupted short one.
    view.setUint16(entryAt + 26, 0, true);
    for (let slot = 0; slot < LFN_CHARS_PER_ENTRY; slot++) {
      const unitIndex = (ordinal - 1) * LFN_CHARS_PER_ENTRY + slot;
      // Past the end: one NUL terminator, then 0xFFFF padding.
      const value = unitIndex < units.length
        ? units[unitIndex]
        : unitIndex === units.length
        ? 0x0000
        : 0xffff;
      view.setUint16(entryAt + slots[slot], value, true);
    }
  }
  return count;
}

/** Attributes for a node, from its type and the one mode bit FAT can hold. */
function attributesFor(node: Node): number {
  let attributes = node.type === "dir" ? ATTR_DIRECTORY : ATTR_ARCHIVE;
  if (node.mode !== undefined && (node.mode & 0o200) === 0) {
    attributes |= ATTR_READ_ONLY;
  }
  return attributes;
}

/** Validate and pad the volume label to its 11 bytes. */
function packLabel(label: string): Uint8Array {
  const text = label.length === 0 ? "NO NAME" : label;
  const bytes = encoder.encode(text);
  if (bytes.byteLength > 11) {
    throw new FatGeometryError(
      `volume label ${JSON.stringify(label)} is ${bytes.byteLength} bytes, ` +
        "over the 11 a FAT label field holds. Shorten it.",
    );
  }
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code > 0x7f || code < 0x20) {
      throw new FatGeometryError(
        `volume label ${JSON.stringify(label)} contains a non-ASCII or ` +
          "control character. A label is stored in the OEM code page, so it " +
          "would read back differently depending on the reader. Use ASCII.",
      );
    }
    if (char >= "a" && char <= "z") {
      throw new FatGeometryError(
        `volume label ${JSON.stringify(label)} contains lowercase. FAT ` +
          "labels are uppercase, and silently uppercasing it here would mean " +
          `the volume is not named what the recipe says. Pass ` +
          `${JSON.stringify(text.toUpperCase())}.`,
      );
    }
  }
  const out = new Uint8Array(11).fill(0x20);
  out.set(bytes, 0);
  return out;
}

/**
 * Serialize a tree to a complete FAT volume of exactly `sizeBytes`.
 *
 * Deterministic by construction: entries keep the order given, clusters are
 * allocated in a fixed depth-first walk, and every timestamp comes from the
 * caller. Two builds of the same input are byte-identical.
 */
export function buildFat(
  entries: readonly FatEntry[],
  options: FatOptions,
): Uint8Array {
  if (
    !Number.isInteger(options.volumeId) ||
    options.volumeId < 0 ||
    options.volumeId > 0xffffffff
  ) {
    throw new FatGeometryError(
      `volumeId ${options.volumeId} is not a uint32. Derive it from ` +
        "determinism.fsSeed.",
    );
  }
  // Checked rather than coerced, the same way volumeId is. `DataView.setUint32`
  // takes anything: 4294967296 lands as 0, -1 as 0xFFFFFFFF and 1.5 as 1, so an
  // out-of-range value would silently claim a different start LBA than the
  // caller meant instead of being refused.
  if (
    options.hiddenSectors !== undefined &&
    (!Number.isInteger(options.hiddenSectors) || options.hiddenSectors < 0 ||
      options.hiddenSectors > 0xffffffff)
  ) {
    throw new FatGeometryError(
      `hiddenSectors ${options.hiddenSectors} is not a uint32, and BPB_HiddSec ` +
        "is a uint32 field. Pass the partition's start LBA — its byte offset " +
        "divided by the sector size — or omit it for a volume that is not " +
        "inside a partition.",
    );
  }
  const label = packLabel(options.label);
  const root = buildTree(entries);
  assignNames(root);
  const geometry = resolveGeometry(root, options);
  const {
    fatType,
    sectorsPerCluster,
    reservedSectors,
    fatSectors,
    rootEntryCount,
    firstDataSector,
    clusterCount,
    totalSectors,
  } = geometry;
  const clusterBytes = sectorsPerCluster * SECTOR_BYTES;

  // The full window, so nothing is left to read through from a backing file.
  const out = new Uint8Array(options.sizeBytes);

  // --- Cluster allocation -------------------------------------------------
  // Depth-first in declaration order, root's own chain first on FAT32. The
  // order is arbitrary but must be fixed: it is half of what makes two builds
  // byte-identical.
  let nextCluster = 2;
  const allocate = (count: number): number => {
    if (count === 0) return 0;
    const first = nextCluster;
    nextCluster += count;
    return first;
  };

  if (fatType === 32) {
    root.dirBytes = directorySlots(root, true) * DIR_ENTRY_BYTES;
    root.clusterCount = Math.ceil(root.dirBytes / clusterBytes);
    root.firstCluster = allocate(root.clusterCount);
  } else {
    root.dirBytes = rootEntryCount * DIR_ENTRY_BYTES;
    root.firstCluster = 0;
    root.clusterCount = 0;
  }

  const allocateTree = (directory: Node) => {
    for (const child of directory.children) {
      if (child.type === "dir") {
        child.dirBytes = directorySlots(child, false) * DIR_ENTRY_BYTES;
        child.clusterCount = Math.ceil(child.dirBytes / clusterBytes);
        child.firstCluster = allocate(child.clusterCount);
      } else {
        child.clusterCount = Math.ceil(child.sizeBytes / clusterBytes);
        child.firstCluster = allocate(child.clusterCount);
      }
    }
    for (const child of directory.children) {
      if (child.type === "dir") allocateTree(child);
    }
  };
  allocateTree(root);

  const used = nextCluster - 2;
  if (used > clusterCount) {
    // resolveGeometry already checked this against the same arithmetic; a
    // mismatch here means the two disagree, which would silently overrun the
    // data region.
    throw new FatGeometryError(
      `allocation needs ${used} clusters but the geometry has ` +
        `${clusterCount}. This is a bug in this writer, not in the recipe.`,
    );
  }

  // --- File allocation table ---------------------------------------------
  const fat = new Uint8Array(fatSectors * SECTOR_BYTES);
  // Entry 0 is the media byte, sign-extended. Entry 1 is the end-of-chain
  // marker; on FAT16/32 its top bits double as the clean-shutdown and
  // hard-error flags, and all-ones means clean.
  setFatEntry(
    fat,
    0,
    fatType === 12 ? 0xff8 : fatType === 16 ? 0xfff8 : 0x0ffffff8,
    fatType,
  );
  setFatEntry(fat, 1, endOfChain(fatType), fatType);

  const chain = (first: number, count: number) => {
    for (let index = 0; index < count; index++) {
      const cluster = first + index;
      setFatEntry(
        fat,
        cluster,
        index === count - 1 ? endOfChain(fatType) : cluster + 1,
        fatType,
      );
    }
  };
  if (root.clusterCount > 0) chain(root.firstCluster, root.clusterCount);
  const chainTree = (directory: Node) => {
    for (const child of directory.children) {
      if (child.clusterCount > 0) chain(child.firstCluster, child.clusterCount);
      if (child.type === "dir") chainTree(child);
    }
  };
  chainTree(root);

  for (let copy = 0; copy < NUM_FATS; copy++) {
    out.set(fat, (reservedSectors + copy * fatSectors) * SECTOR_BYTES);
  }

  // --- Directories and file bodies ---------------------------------------
  const clusterOffset = (cluster: number) =>
    (firstDataSector + (cluster - 2) * sectorsPerCluster) * SECTOR_BYTES;

  const writeDirectory = (directory: Node, isRoot: boolean, parent: Node) => {
    const at = isRoot && fatType !== 32
      ? (reservedSectors + NUM_FATS * fatSectors) * SECTOR_BYTES
      : clusterOffset(directory.firstCluster);
    let cursor = at;

    if (isRoot) {
      // The volume label lives in the root as an ATTR_VOLUME_ID entry with no
      // cluster and no size. This is where every tool reads the label from;
      // BS_VolLab in the BPB is the copy.
      const stamp = packDateTime(options.sourceDateEpoch, "<volume label>");
      writeShortEntry(out, cursor, {
        short: label,
        attributes: ATTR_VOLUME_ID,
        firstCluster: 0,
        sizeBytes: 0,
        date: stamp.date,
        time: stamp.time,
        tenth: stamp.tenth,
      });
      cursor += DIR_ENTRY_BYTES;
    } else {
      const stamp = packDateTime(directory.mtime, directory.path);
      writeShortEntry(out, cursor, {
        short: packShortName(".", ""),
        attributes: ATTR_DIRECTORY,
        firstCluster: directory.firstCluster,
        sizeBytes: 0,
        date: stamp.date,
        time: stamp.time,
        tenth: stamp.tenth,
      });
      cursor += DIR_ENTRY_BYTES;
      // The spec is explicit: when the parent is the root directory, `..`
      // carries cluster 0 rather than the root's own number — on FAT32 too,
      // where the root does have one.
      const parentCluster = parent === root && fatType === 32
        ? 0
        : parent.firstCluster;
      writeShortEntry(out, cursor, {
        short: packShortName("..", ""),
        attributes: ATTR_DIRECTORY,
        firstCluster: parentCluster,
        sizeBytes: 0,
        date: stamp.date,
        time: stamp.time,
        tenth: stamp.tenth,
      });
      cursor += DIR_ENTRY_BYTES;
    }

    for (const child of directory.children) {
      if (child.needsLfn) {
        cursor += writeLongName(out, cursor, child.name, child.short) *
          DIR_ENTRY_BYTES;
      }
      const stamp = packDateTime(child.mtime, child.path);
      writeShortEntry(out, cursor, {
        short: child.short,
        attributes: attributesFor(child),
        firstCluster: child.firstCluster,
        sizeBytes: child.sizeBytes,
        date: stamp.date,
        time: stamp.time,
        tenth: stamp.tenth,
      });
      cursor += DIR_ENTRY_BYTES;
    }

    for (const child of directory.children) {
      if (child.type === "dir") {
        writeDirectory(child, false, directory);
      } else if (child.body !== undefined && child.body.byteLength > 0) {
        out.set(child.body, clusterOffset(child.firstCluster));
      }
    }
  };
  writeDirectory(root, true, root);

  // --- Boot sector --------------------------------------------------------
  const boot = new Uint8Array(SECTOR_BYTES);
  const bootView = new DataView(boot.buffer);
  // BS_jmpBoot: a short jump over the BPB to where boot code would start.
  boot.set(fatType === 32 ? [0xeb, 0x58, 0x90] : [0xeb, 0x3c, 0x90], 0);
  // BS_OEMName. "MSWIN4.1" is what the spec recommends verbatim, because some
  // drivers are known to check it; it is a compatibility token, not a claim
  // about what wrote the volume.
  boot.set(encoder.encode("MSWIN4.1"), 3);
  bootView.setUint16(11, SECTOR_BYTES, true);
  boot[13] = sectorsPerCluster;
  bootView.setUint16(14, reservedSectors, true);
  boot[16] = NUM_FATS;
  bootView.setUint16(17, fatType === 32 ? 0 : rootEntryCount, true);
  // Exactly one of TotSec16/TotSec32 is non-zero, and on FAT32 it is always
  // TotSec32 whatever the size.
  const smallTotal = fatType !== 32 && totalSectors < 0x10000;
  bootView.setUint16(19, smallTotal ? totalSectors : 0, true);
  boot[21] = 0xf8; // BPB_Media: fixed disk. Must match FAT[0]'s low byte.
  bootView.setUint16(22, fatType === 32 ? 0 : fatSectors, true);
  // Legacy INT 13h geometry. Nothing on the UEFI path reads either, and a zero
  // here is known to upset some DOS-era tooling, so both carry plausible
  // values rather than none.
  bootView.setUint16(24, 32, true); // BPB_SecPerTrk
  bootView.setUint16(26, 64, true); // BPB_NumHeads
  bootView.setUint32(28, options.hiddenSectors ?? 0, true);
  bootView.setUint32(32, smallTotal ? 0 : totalSectors, true);

  if (fatType === 32) {
    bootView.setUint32(36, fatSectors, true); // BPB_FATSz32
    bootView.setUint16(40, 0, true); // BPB_ExtFlags: mirror all FATs
    bootView.setUint16(42, 0, true); // BPB_FSVer 0.0
    bootView.setUint32(44, root.firstCluster, true); // BPB_RootClus
    bootView.setUint16(48, FSINFO_SECTOR, true);
    bootView.setUint16(50, BACKUP_BOOT_SECTOR, true);
    // BPB_Reserved[12] at 52 stays zero, written as part of the sector.
    boot[64] = 0x80; // BS_DrvNum
    boot[65] = 0; // BS_Reserved1
    boot[66] = 0x29; // BS_BootSig: says VolID/VolLab/FilSysType below are real
    bootView.setUint32(67, options.volumeId, true);
    boot.set(label, 71);
    boot.set(encoder.encode("FAT32   "), 82);
  } else {
    boot[36] = 0x80; // BS_DrvNum
    boot[37] = 0; // BS_Reserved1
    boot[38] = 0x29; // BS_BootSig
    bootView.setUint32(39, options.volumeId, true);
    boot.set(label, 43);
    boot.set(encoder.encode(fatType === 12 ? "FAT12   " : "FAT16   "), 54);
  }
  boot[510] = 0x55;
  boot[511] = 0xaa;
  out.set(boot, 0);

  if (fatType === 32) {
    const fsInfo = new Uint8Array(SECTOR_BYTES);
    const fsView = new DataView(fsInfo.buffer);
    fsView.setUint32(0, 0x41615252, true); // FSI_LeadSig  "RRaA"
    fsView.setUint32(484, 0x61417272, true); // FSI_StrucSig "rrAa"
    fsView.setUint32(488, clusterCount - used, true); // FSI_Free_Count
    fsView.setUint32(492, nextCluster, true); // FSI_Nxt_Free
    fsView.setUint32(508, 0xaa550000, true); // FSI_TrailSig
    out.set(fsInfo, FSINFO_SECTOR * SECTOR_BYTES);
    // The backup pair at sector 6, exactly as the primary. A FAT32 volume
    // whose backup is missing is one a repair tool cannot rebuild.
    out.set(boot, BACKUP_BOOT_SECTOR * SECTOR_BYTES);
    out.set(fsInfo, (BACKUP_BOOT_SECTOR + FSINFO_SECTOR) * SECTOR_BYTES);
  }

  return out;
}

/**
 * Recover a volume's geometry from its own BPB, deriving the type the way a
 * driver does.
 *
 * This is the check that matters: {@linkcode FatGeometry.fatType} here comes
 * from the cluster count, not from `BS_FilSysType`, so comparing it against the
 * type that was requested is what proves the two agree.
 */
export function describeFat(bytes: Uint8Array): FatGeometry {
  if (bytes.byteLength < SECTOR_BYTES) {
    throw new FatGeometryError("too short to hold a boot sector.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[510] !== 0x55 || bytes[511] !== 0xaa) {
    throw new FatGeometryError(
      "no 0x55AA signature at offset 510: this is not a FAT boot sector.",
    );
  }
  const bytesPerSector = view.getUint16(11, true);
  const sectorsPerCluster = bytes[13];
  const reservedSectors = view.getUint16(14, true);
  const numFats = bytes[16];
  const rootEntryCount = view.getUint16(17, true);
  const totalSectors16 = view.getUint16(19, true);
  const fatSectors16 = view.getUint16(22, true);
  const totalSectors32 = view.getUint32(32, true);
  const fatSectors32 = view.getUint32(36, true);

  if (bytesPerSector === 0 || sectorsPerCluster === 0) {
    throw new FatGeometryError(
      "BPB_BytsPerSec or BPB_SecPerClus is zero; the volume is not formatted.",
    );
  }
  const fatSectors = fatSectors16 !== 0 ? fatSectors16 : fatSectors32;
  const totalSectors = totalSectors16 !== 0 ? totalSectors16 : totalSectors32;
  const rootDirSectors = Math.ceil(
    (rootEntryCount * DIR_ENTRY_BYTES) / bytesPerSector,
  );
  const firstDataSector = reservedSectors + numFats * fatSectors +
    rootDirSectors;
  const clusterCount = Math.floor(
    (totalSectors - firstDataSector) / sectorsPerCluster,
  );

  return {
    fatType: typeForClusterCount(clusterCount),
    bytesPerSector,
    sectorsPerCluster,
    reservedSectors,
    numFats,
    rootEntryCount,
    fatSectors,
    totalSectors,
    rootDirSectors,
    firstDataSector,
    clusterCount,
  };
}
