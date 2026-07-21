/**
 * Typed results parsed from qemu-img's `--output=json` forms.
 *
 * Every parser hand-narrows: a mistyped known field degrades to `undefined`,
 * unknown fields survive in the result's `raw`, and unparseable output throws
 * {@linkcode import("./errors.ts").QemuImgOutputError} (loud beats silent).
 * Field names are camelCase mirrors of qemu-img's kebab-case JSON keys.
 *
 * @module
 */

import { QemuImgOutputError } from "./errors.ts";

/** One internal snapshot, from `info --output=json`'s `snapshots` array. */
export interface SnapshotInfo {
  /** The snapshot id. */
  readonly id: string;
  /** The snapshot tag (qemu-img calls it `name`). */
  readonly tag: string;
  /** VM state size in bytes (0 for disk-only snapshots). */
  readonly vmStateSizeBytes?: number;
  /** Creation time, seconds component (unix epoch). */
  readonly dateSec?: number;
  /** Creation time, nanoseconds component. */
  readonly dateNsec?: number;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Parsed `qemu-img info --output=json`. */
export interface QemuImgInfo {
  /** The file the info describes. */
  readonly filename?: string;
  /** Image format (`"qcow2"`, `"raw"`, …). */
  readonly format?: string;
  /** Guest-visible size in bytes (`virtual-size`). */
  readonly virtualSizeBytes?: number;
  /** Host bytes actually allocated (`actual-size`). */
  readonly actualSizeBytes?: number;
  /** Cluster size in bytes, for cluster-based formats. */
  readonly clusterSize?: number;
  /** Whether the image was not cleanly closed (`dirty-flag`). */
  readonly dirtyFlag?: boolean;
  /** Backing file reference, as stored in the image. */
  readonly backingFilename?: string;
  /** Backing file reference resolved to a path (`full-backing-filename`). */
  readonly fullBackingFilename?: string;
  /** Backing file format (`backing-filename-format`). */
  readonly backingFormat?: string;
  /** Internal snapshots, when present. */
  readonly snapshots?: readonly SnapshotInfo[];
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Parsed `qemu-img check --output=json` (plus the process exit code). */
export interface CheckResult {
  /**
   * The `check` exit code: `0` clean, `2` corruptions found, `3` leaks found
   * but not repaired. (Codes `1`/`63` mean the check itself failed and raise
   * a `CommandError` instead of producing a result.)
   */
  readonly code: number;
  /** The file that was checked. */
  readonly filename?: string;
  /** Image format. */
  readonly format?: string;
  /** Errors encountered while checking (`check-errors`). */
  readonly checkErrors?: number;
  /** Corruptions found. */
  readonly corruptions?: number;
  /** Leaked clusters found. */
  readonly leaks?: number;
  /** Corruptions repaired (with `repair`). */
  readonly corruptionsFixed?: number;
  /** Leaks repaired (with `repair`). */
  readonly leaksFixed?: number;
  /** Offset after the last used cluster (`image-end-offset`). */
  readonly imageEndOffset?: number;
  /** Total guest clusters. */
  readonly totalClusters?: number;
  /** Allocated guest clusters. */
  readonly allocatedClusters?: number;
  /** Fragmented guest clusters. */
  readonly fragmentedClusters?: number;
  /** Compressed guest clusters. */
  readonly compressedClusters?: number;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** One allocation extent from `qemu-img map --output=json`. */
export interface MapExtent {
  /** Guest offset in bytes. */
  readonly start: number;
  /** Extent length in bytes. */
  readonly length: number;
  /** Backing-chain depth that allocated the extent. */
  readonly depth?: number;
  /** Whether the extent is allocated in the chain (`present`). */
  readonly present?: boolean;
  /** Whether the extent reads as zeros. */
  readonly zero?: boolean;
  /** Whether the extent carries stored data. */
  readonly data?: boolean;
  /** Host file offset, when the mapping is direct. */
  readonly offset?: number;
  /** Whether the extent is stored compressed. */
  readonly compressed?: boolean;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Parsed `qemu-img measure --output=json`. */
export interface MeasureResult {
  /** Bytes required for the conversion (`required`). */
  readonly requiredBytes: number;
  /** Bytes required if fully allocated (`fully-allocated`). */
  readonly fullyAllocatedBytes?: number;
  /** Extra bytes needed for bitmap migration, when reported. */
  readonly bitmapsBytes?: number;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * Result of `qemu-img compare`, derived from its exit-code contract.
 * Note the non-strict semantics: images of different sizes still compare
 * identical when the larger one's tail reads as zeros — pass `strict` to
 * also fail on size mismatches.
 */
export interface CompareResult {
  /** `true` iff qemu-img reported the images identical (exit 0). */
  readonly identical: boolean;
  /** qemu-img's own report (first mismatch offset, etc.). */
  readonly output: string;
}

/** Parse `qemu-img info --output=json` stdout (a single JSON object). */
export function parseQemuImgInfo(stdout: string): QemuImgInfo {
  const parsed = parseJson(stdout, "qemu-img info");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QemuImgOutputError(
      "qemu-img info output is not an object",
      stdout,
    );
  }
  return narrowInfo(parsed as Record<string, unknown>, stdout);
}

/**
 * Parse `qemu-img info --backing-chain --output=json` stdout. qemu-img emits
 * a JSON array (one entry per chain element); a bare object is accepted and
 * treated as a one-element chain.
 */
export function parseQemuImgInfoChain(stdout: string): QemuImgInfo[] {
  const parsed = parseJson(stdout, "qemu-img info --backing-chain");
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new QemuImgOutputError(
        "qemu-img info chain entry is not an object",
        stdout,
      );
    }
    return narrowInfo(entry as Record<string, unknown>, stdout);
  });
}

/** Parse `qemu-img check --output=json` stdout plus the check's exit code. */
export function parseCheckResult(stdout: string, code: number): CheckResult {
  const parsed = parseJson(stdout, "qemu-img check");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QemuImgOutputError(
      "qemu-img check output is not an object",
      stdout,
    );
  }
  const raw = parsed as Record<string, unknown>;
  return {
    code,
    ...optional("filename", asString(raw.filename)),
    ...optional("format", asString(raw.format)),
    ...optional("checkErrors", asNumber(raw["check-errors"])),
    ...optional("corruptions", asNumber(raw.corruptions)),
    ...optional("leaks", asNumber(raw.leaks)),
    ...optional("corruptionsFixed", asNumber(raw["corruptions-fixed"])),
    ...optional("leaksFixed", asNumber(raw["leaks-fixed"])),
    ...optional("imageEndOffset", asNumber(raw["image-end-offset"])),
    ...optional("totalClusters", asNumber(raw["total-clusters"])),
    ...optional("allocatedClusters", asNumber(raw["allocated-clusters"])),
    ...optional("fragmentedClusters", asNumber(raw["fragmented-clusters"])),
    ...optional("compressedClusters", asNumber(raw["compressed-clusters"])),
    raw,
  };
}

/** Parse `qemu-img map --output=json` stdout (a JSON array of extents). */
export function parseMapExtents(stdout: string): MapExtent[] {
  const parsed = parseJson(stdout, "qemu-img map");
  if (!Array.isArray(parsed)) {
    throw new QemuImgOutputError("qemu-img map output is not an array", stdout);
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new QemuImgOutputError(
        "qemu-img map entry is not an object",
        stdout,
      );
    }
    const raw = entry as Record<string, unknown>;
    const start = asNumber(raw.start);
    const length = asNumber(raw.length);
    if (start === undefined || length === undefined) {
      throw new QemuImgOutputError(
        "qemu-img map entry lacks start/length",
        stdout,
      );
    }
    return {
      start,
      length,
      ...optional("depth", asNumber(raw.depth)),
      ...optional("present", asBoolean(raw.present)),
      ...optional("zero", asBoolean(raw.zero)),
      ...optional("data", asBoolean(raw.data)),
      ...optional("offset", asNumber(raw.offset)),
      ...optional("compressed", asBoolean(raw.compressed)),
      raw,
    };
  });
}

/** Parse `qemu-img measure --output=json` stdout. */
export function parseMeasureResult(stdout: string): MeasureResult {
  const parsed = parseJson(stdout, "qemu-img measure");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new QemuImgOutputError(
      "qemu-img measure output is not an object",
      stdout,
    );
  }
  const raw = parsed as Record<string, unknown>;
  const requiredBytes = asNumber(raw.required);
  if (requiredBytes === undefined) {
    throw new QemuImgOutputError(
      "qemu-img measure output lacks required",
      stdout,
    );
  }
  return {
    requiredBytes,
    ...optional("fullyAllocatedBytes", asNumber(raw["fully-allocated"])),
    ...optional("bitmapsBytes", asNumber(raw.bitmaps)),
    raw,
  };
}

function narrowInfo(
  raw: Record<string, unknown>,
  stdout: string,
): QemuImgInfo {
  return {
    ...optional("filename", asString(raw.filename)),
    ...optional("format", asString(raw.format)),
    ...optional("virtualSizeBytes", asNumber(raw["virtual-size"])),
    ...optional("actualSizeBytes", asNumber(raw["actual-size"])),
    ...optional("clusterSize", asNumber(raw["cluster-size"])),
    ...optional("dirtyFlag", asBoolean(raw["dirty-flag"])),
    ...optional("backingFilename", asString(raw["backing-filename"])),
    ...optional(
      "fullBackingFilename",
      asString(raw["full-backing-filename"]),
    ),
    ...optional("backingFormat", asString(raw["backing-filename-format"])),
    ...optional("snapshots", narrowSnapshots(raw.snapshots, stdout)),
    raw,
  };
}

function narrowSnapshots(
  value: unknown,
  stdout: string,
): readonly SnapshotInfo[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new QemuImgOutputError(
      "qemu-img info snapshots is not an array",
      stdout,
    );
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new QemuImgOutputError(
        "qemu-img info snapshot entry is not an object",
        stdout,
      );
    }
    const raw = entry as Record<string, unknown>;
    const id = asString(raw.id) ?? asStringFromNumber(raw.id);
    const tag = asString(raw.name);
    if (id === undefined || tag === undefined) {
      throw new QemuImgOutputError(
        "qemu-img info snapshot entry lacks id/name",
        stdout,
      );
    }
    return {
      id,
      tag,
      ...optional("vmStateSizeBytes", asNumber(raw["vm-state-size"])),
      ...optional("dateSec", asNumber(raw["date-sec"])),
      ...optional("dateNsec", asNumber(raw["date-nsec"])),
      raw,
    };
  });
}

function parseJson(stdout: string, what: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new QemuImgOutputError(`unparseable ${what} output`, stdout);
  }
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringFromNumber(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
