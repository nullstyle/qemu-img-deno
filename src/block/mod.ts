/**
 * Block-device repair: reading a GPT back off a disk, saying what is wrong
 * with it, and fixing it in place.
 *
 * `qemu-img resize` moves the end of the disk. A GPT keeps its backup header
 * in the **last sector** and records the disk's last usable LBA in *both*
 * headers, so every resize invalidates the table — silently. The primary
 * header still self-verifies, the image still boots, and `qemu-img check`
 * still says clean. The damage surfaces later, in whatever reads the table
 * strictly.
 *
 * The conventional fix is `sgdisk -e`, which this package's own target host
 * does not have and cannot get: macOS ships no gdisk, no parted, no
 * mkfs.\*, no loop devices. So the repair is here instead, as byte arithmetic
 * over two `raw` windows — no Linux, no root, and nothing materialized.
 *
 * The interesting case is the one that is refused. After a shrink a partition
 * can extend past the new last usable LBA; rewriting the table to fit would
 * produce a perfectly valid GPT describing a filesystem whose tail is gone.
 * {@linkcode repairGpt} refuses that disk and names the exact byte size to
 * grow it back to. `acknowledgeDataLoss` drops the entry outright — it never
 * shortens one, because a clamped entry leaves a superblock claiming blocks
 * the disk no longer has.
 *
 * @example Repair after a grow
 * ```ts
 * import { QemuImg } from "@nullstyle/qemu-img";
 * import { diagnoseGptImage, repairGptImage } from "@nullstyle/qemu-img/block";
 *
 * const qemu = new QemuImg();
 * await qemu.resize("/disk.qcow2", "+2G");
 *
 * const before = await diagnoseGptImage("/disk.qcow2");
 * console.log(before.ok, before.problems.map((p) => p.code));
 * // false [ "backup-stranded", "last-usable-stale", "alternate-lba-stale" ]
 *
 * const { changed, after } = await repairGptImage("/disk.qcow2");
 * console.log(changed, after.backup.header?.myLba);
 * ```
 *
 * @module
 */

export { GptParseError, GptRepairRefusedError } from "./errors.ts";

export {
  diagnoseGpt,
  DiskView,
  encodeGptEntries,
  encodeGptHeader,
  GPT_SIGNATURE,
  type GptDiagnosis,
  type GptEntry,
  type GptHeader,
  type GptProblem,
  type GptProblemCode,
  type GptRepairOptions,
  type GptRepairPlan,
  type GptSide,
  type GptSideStatus,
  type GptWrite,
  HEADER_MIN_BYTES,
  MAX_ENTRY_ARRAY_BYTES,
  type ParsedGpt,
  parseGpt,
  type ParseGptOptions,
  parseGptView,
  planGptRepair,
  repairGpt,
  type SectorSize,
  UNUSED_TYPE_GUID,
} from "./gpt.ts";

export {
  diagnoseGptImage,
  type GptImageOptions,
  type GptRepairResult,
  readGptImage,
  repairGptImage,
  resizeAndRepairGpt,
} from "./image.ts";
