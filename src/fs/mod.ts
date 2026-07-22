/**
 * Filesystem and partition-table writers: bytes generated in TypeScript and
 * spliced into an image through a `raw` window, so a partition table needs no
 * `sgdisk`, no loop device and no root.
 *
 * @module
 */

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
