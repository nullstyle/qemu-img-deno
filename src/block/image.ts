/**
 * Reading and repairing a GPT **in place**, through `raw` offset/size windows.
 *
 * A GPT lives in two small ranges at opposite ends of the disk, so none of
 * this materializes the image: the same `driver=raw,offset=,size=` mechanism
 * the recipe tier uses to splice a partition table in is used here to read one
 * back out and to write the repaired one over it. Repairing a 40 GiB qcow2
 * moves a few tens of kilobytes.
 *
 * @module
 */

import { QemuImg } from "../qemu_img.ts";
import type { BlockNodeSpec, ImageFormat } from "../qemu_img.ts";
import {
  diagnoseGpt,
  DiskView,
  type GptDiagnosis,
  type GptEntry,
  type GptRepairOptions,
  type GptRepairPlan,
  type GptWrite,
  type ParsedGpt,
  parseGptView,
  planGptRepair,
  type SectorSize,
} from "./gpt.ts";
import { GptParseError } from "./errors.ts";

/** How much of each end of the disk is fetched to find a GPT. */
const WINDOW_SECTORS = 64;

/** Options shared by every image-level entry point here. */
export interface GptImageOptions {
  /** The driver. @default a new QemuImg */
  readonly qemu?: QemuImg;
  /** Container format (`-f`). Probed with `info` when omitted. */
  readonly format?: ImageFormat;
  /** Logical sector size. Probed from the table when omitted. */
  readonly sectorSize?: SectorSize;
  /**
   * Directory for the window blobs this shuttles through.
   * @default a fresh directory under the system temp dir, removed afterwards
   */
  readonly scratch?: string;
}

/** A `raw` window onto part of an image, as a block-node graph. */
function window(
  path: string,
  format: ImageFormat,
  offset: number,
  size: number,
): { readonly imageOpts: BlockNodeSpec } {
  const file: BlockNodeSpec = { driver: "file", filename: path };
  return {
    imageOpts: {
      driver: "raw",
      offset,
      size,
      file: format === "raw" ? file : { driver: format, file },
    },
  };
}

async function resolve(
  path: string,
  options: GptImageOptions,
): Promise<{ qemu: QemuImg; format: ImageFormat; diskSizeBytes: number }> {
  const qemu = options.qemu ?? new QemuImg();
  const info = await qemu.info(
    path,
    options.format === undefined ? {} : { format: options.format },
  );
  const format = options.format ?? (info.format as ImageFormat);
  if (info.virtualSizeBytes === undefined) {
    throw new GptParseError(
      `qemu-img info reported no virtual size for ${path}; every LBA in a ` +
        "GPT is relative to it, so there is nothing to check the table against",
    );
  }
  return { qemu, format, diskSizeBytes: info.virtualSizeBytes };
}

async function withScratch<T>(
  options: GptImageOptions,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  if (options.scratch !== undefined) {
    await Deno.mkdir(options.scratch, { recursive: true });
    return await body(options.scratch);
  }
  const dir = await Deno.makeTempDir({ prefix: "qimg-gpt-" });
  try {
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Pull one byte range out of the image into memory. */
async function readWindow(
  qemu: QemuImg,
  path: string,
  format: ImageFormat,
  dir: string,
  offset: number,
  size: number,
  tag: string,
): Promise<Uint8Array> {
  const out = `${dir}/read-${tag}.bin`;
  await qemu.convert(window(path, format, offset, size), out, {
    format: "raw",
    parallel: 1,
  });
  const bytes = await Deno.readFile(out);
  await Deno.remove(out).catch(() => {});
  return bytes;
}

/** Push one byte range back into the image, in place. */
async function writeWindow(
  qemu: QemuImg,
  path: string,
  format: ImageFormat,
  dir: string,
  write: GptWrite,
  tag: string,
): Promise<void> {
  const blob = `${dir}/write-${tag}.bin`;
  await Deno.writeFile(blob, write.bytes);
  await qemu.convert(
    blob,
    window(path, format, write.offsetBytes, write.bytes.byteLength),
    { sourceFormat: "raw", noCreate: true, parallel: 1 },
  );
  await Deno.remove(blob).catch(() => {});
}

/**
 * Read both ends of the image and parse the GPT it carries.
 *
 * Two `convert` reads of {@linkcode WINDOW_SECTORS} sectors each, plus a third
 * when the primary points at a backup stranded mid-disk. Nothing between the
 * two ends is touched.
 */
export async function readGptImage(
  path: string,
  options: GptImageOptions = {},
): Promise<ParsedGpt> {
  const { qemu, format, diskSizeBytes } = await resolve(path, options);
  return await withScratch(options, async (dir) => {
    // The window is sized in bytes before the sector size is known, so it is
    // taken at the larger candidate: 64 sectors of 4096 covers 64 sectors of
    // 512 as well, and one read serves both probes.
    const span = WINDOW_SECTORS * 4096;
    const head = await readWindow(
      qemu,
      path,
      format,
      dir,
      0,
      Math.min(span, diskSizeBytes),
      "head",
    );
    const tailLength = Math.min(span, diskSizeBytes);
    const tailOffset = diskSizeBytes - tailLength;
    const tail = await readWindow(
      qemu,
      path,
      format,
      dir,
      tailOffset,
      tailLength,
      "tail",
    );

    const fragments = [
      { offsetBytes: 0, bytes: head },
      { offsetBytes: tailOffset, bytes: tail },
    ];
    let parsed = parseGptView(
      new DiskView(diskSizeBytes, fragments),
      options.sectorSize === undefined
        ? {}
        : { sectorSize: options.sectorSize },
    );

    // A stranded backup sits wherever the disk used to end, which is neither
    // window. Fetch it only once the primary has said where to look.
    const pointsAt = parsed.primary.header?.alternateLba;
    if (
      parsed.primary.status === "ok" && pointsAt !== undefined &&
      pointsAt !== parsed.totalSectors - 1
    ) {
      const sectorSize = parsed.sectorSize;
      // Back far enough to include the stranded header's own entry array.
      const from = Math.max(0, (pointsAt + 1) * sectorSize - span);
      const length = Math.min(span, diskSizeBytes - from);
      if (length > 0 && from >= 0) {
        const strandedBytes = await readWindow(
          qemu,
          path,
          format,
          dir,
          from,
          length,
          "stranded",
        );
        fragments.push({ offsetBytes: from, bytes: strandedBytes });
        parsed = parseGptView(
          new DiskView(diskSizeBytes, fragments),
          { sectorSize },
        );
      }
    }
    return parsed;
  });
}

/** Read the image and report what is wrong with its table. */
export async function diagnoseGptImage(
  path: string,
  options: GptImageOptions = {},
): Promise<GptDiagnosis> {
  return diagnoseGpt(await readGptImage(path, options));
}

/** What {@linkcode repairGptImage} did. */
export interface GptRepairResult {
  /** False when the table already matched the disk and nothing was written. */
  readonly changed: boolean;
  /** The plan that was applied. */
  readonly plan: GptRepairPlan;
  /** Entries dropped under `acknowledgeDataLoss`. */
  readonly droppedPartitions: readonly GptEntry[];
  /** The table as it read back after the repair. */
  readonly after: ParsedGpt;
}

/**
 * Repair a GPT in place, through `raw` windows.
 *
 * Refuses — before writing anything — when the repair would lose data: see
 * {@linkcode planGptRepair}. On success the table is read back and diagnosed
 * again, so a repair that did not take is an error here rather than a surprise
 * later.
 */
export async function repairGptImage(
  path: string,
  options: GptImageOptions & GptRepairOptions = {},
): Promise<GptRepairResult> {
  const parsed = await readGptImage(path, options);
  const plan = planGptRepair(parsed, options);
  if (!plan.changed) {
    return {
      changed: false,
      plan,
      droppedPartitions: [],
      after: parsed,
    };
  }

  const { qemu, format } = await resolve(path, options);
  await withScratch(options, async (dir) => {
    for (const [index, write] of plan.writes.entries()) {
      await writeWindow(qemu, path, format, dir, write, String(index));
    }
  });

  const after = await readGptImage(path, options);
  const check = diagnoseGpt(after);
  if (!check.ok) {
    throw new GptParseError(
      `the repair was written but ${path} still diagnoses as damaged:\n` +
        check.problems.map((p) => `  - ${p.detail}`).join("\n"),
    );
  }
  return {
    changed: true,
    plan,
    droppedPartitions: plan.droppedPartitions,
    after,
  };
}

/**
 * Resize an image and repair its GPT in the same breath.
 *
 * `resize()` alone leaves a GPT describing the old disk — see the hazard table
 * in the README. This is the paired operation: resize, then move the backup
 * header to the new last sector and restate both headers. A shrink that would
 * cut into a partition is refused by the repair, *after* the resize has
 * happened, so the image is left grown-back-able rather than silently wrong —
 * the refusal names the exact byte size to grow back to.
 */
export async function resizeAndRepairGpt(
  path: string,
  size: number | string,
  options: GptImageOptions & GptRepairOptions & { shrink?: boolean } = {},
): Promise<GptRepairResult> {
  const qemu = options.qemu ?? new QemuImg();
  await qemu.resize(path, size, {
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.shrink === true ? { shrink: true } : {}),
  });
  return await repairGptImage(path, { ...options, qemu });
}
