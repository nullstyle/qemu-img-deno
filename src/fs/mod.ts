/**
 * Filesystem and partition-table writers: bytes generated in TypeScript and
 * spliced into an image through a `raw` window, so a partition table needs no
 * `sgdisk`, no loop device and no root. The ustar writer is here for the same
 * reason: it is bytes, not a shell-out to a host `tar` that drops what it
 * cannot represent.
 *
 * @module
 */

export {
  buildFat,
  CLUSTER_COUNT_THRESHOLDS,
  describeFat,
  DIR_ENTRY_BYTES,
  type FatEntry,
  FatEntryError,
  type FatEntryShape,
  fatEntryShapes,
  type FatGeometry,
  FatGeometryError,
  fatGeometryFor,
  type FatOptions,
  minimumFatSizeBytes,
  SECTOR_BYTES,
} from "./fat.ts";

export {
  buildGpt,
  bytesToGuid,
  crc32,
  deriveGuid,
  ENTRY_BYTES,
  ENTRY_COUNT,
  type GptImage,
  type GptOptions,
  type GptPartition,
  guidToBytes,
  PARTITION_TYPE_GUIDS,
} from "./gpt.ts";

export {
  buildTar,
  TAR_BLOCK,
  type TarEntry,
  TarEntryError,
  USTAR_MAX_SIZE_BYTES,
} from "./tar.ts";
