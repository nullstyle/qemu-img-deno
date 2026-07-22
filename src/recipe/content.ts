/**
 * Content identity: a digest over what a layer's guest READS, not over how
 * qcow2 chose to store it.
 *
 * The store already hashes the container file, and that digest is the right
 * tamper check — it is the bytes on disk, so nothing can change them without
 * moving it. It is the wrong *identity*. A qcow2 written by a booted guest
 * records cluster and refcount ordering that follows I/O completion order, so
 * two boots that produce a byte-identical filesystem still produce different
 * container bytes. Measured on the system smoke's `table:mkfs` layer: at least
 * four distinct container digests, all of them the same 2424832-byte file,
 * `qemu-img compare --strict` identical on every pair — and the assertion that
 * compared them red on 5 runs in 10.
 *
 * Chaining a cache key through the container digest therefore invalidates
 * every descendant of a guest layer at random. Chaining it through this digest
 * does not, and gives up nothing: a qcow2 overlay is a delta in GUEST address
 * space, so the only property of a parent a child can be silently wrong about
 * is what the guest reads through it.
 *
 * @module
 */

import type { ImageFormat, QemuImg } from "../qemu_img.ts";
import { sha256Hex } from "../digest.ts";

/**
 * Domain tag and scheme version, folded into every preimage.
 *
 * Bumping it changes every content digest, and so every realization key
 * downstream of one — which is exactly the invalidation a scheme change needs.
 */
const CONTENT_ALGORITHM = "qemu-img-content@1";

/**
 * The block the digest folds over.
 *
 * Fixed and aligned to offset 0, so identical content always lands on
 * identical block boundaries however the image was written.
 */
const BLOCK_BYTES = 1024 * 1024;

/** Options for {@linkcode contentDigest}. */
export interface ContentDigestOptions {
  /**
   * Directory for the transient raw materialization.
   *
   * The file is sparse — only the image's data extents ever get written — and
   * it is removed before this returns, including on failure. A process KILLED
   * mid-digest is the one case that leaves one behind; `LayerStore.gc()`
   * reclaims what is left in the store's own `scratch/`.
   */
  readonly scratch: string;
  /** The image's format (`-f`), so qemu does not probe it. */
  readonly format?: ImageFormat;
}

/**
 * Digest an image's guest-visible content, ignoring how it is stored.
 *
 * Two images digest the same iff a guest reads the same bytes at the same
 * offsets from both. Cluster layout, chain depth, allocation status and the
 * difference between an unallocated region and an explicitly-zeroed one are
 * all invisible here, and every one of them can differ between two runs that
 * built the same filesystem.
 *
 * `image` is read through its whole backing chain, because that is what a
 * guest reads: a layer's content includes every byte it inherits.
 */
export async function contentDigest(
  qemu: QemuImg,
  image: string,
  options: ContentDigestOptions,
): Promise<string> {
  // A unique name: two builds can share one store's scratch directory, and a
  // collision here would digest another build's image.
  const raw = `${options.scratch}/content-${crypto.randomUUID()}.raw`;
  try {
    // Flatten to raw first. Only qemu can read a qcow2 chain, and reading it
    // one extent at a time would be one subprocess per extent; a raw file is
    // seekable from here for free. The output is sparse, so this writes only
    // the allocated bytes. Measured end to end on a 2 GiB image: 20 ms holding
    // 4 MiB, 49 ms holding 64 MiB, 152 ms holding 256 MiB.
    await qemu.convert(image, raw, {
      format: "raw",
      ...(options.format === undefined ? {} : { sourceFormat: options.format }),
      parallel: 1,
    });
    return await digestRawFile(qemu, raw);
  } finally {
    await Deno.remove(raw).catch(() => {});
  }
}

/** Fold a raw file into a digest, reading only the blocks that hold data. */
async function digestRawFile(qemu: QemuImg, raw: string): Promise<string> {
  const sizeBytes = (await Deno.stat(raw)).size;
  // The virtual size is in the preimage: a filesystem followed by a terabyte
  // of zeros is not the same disk as the filesystem alone, and every LBA in
  // the plan below it was derived from that number.
  const lines = [`${CONTENT_ALGORITHM} ${sizeBytes}`];

  // `map` on a raw file is lseek(SEEK_HOLE) — it names the regions worth
  // reading. Skipping only the extents qemu positively reports as zeros keeps
  // this correct on a filesystem (or a qemu) that reports no holes at all:
  // then every block is read, and the zero check below drops them anyway.
  const extents = (await qemu.map(raw, { format: "raw" }))
    .filter((extent) => extent.zero !== true && extent.length > 0)
    .sort((a, b) => a.start - b.start);

  // Every offset below is derived from `sizeBytes`, and an extent reaching
  // past it turns the block length into a negative number that `subarray`
  // silently reinterprets as "all but the last n bytes" — a digest over a
  // block nothing else would ever produce. Measured on qemu-img 11.0.2, a
  // `convert -O raw` output is always its full virtual length even when the
  // tail is one hole (512 MiB virtual, 16 KiB allocated, `stat().size` =
  // 536870912), so this fires only if the materialization was truncated.
  for (const extent of extents) {
    const end = extent.start + extent.length;
    if (end > sizeBytes) {
      throw new Error(
        `content digest: qemu-img map reports data out to ${end} in a ` +
          `${sizeBytes}-byte materialization of this image. Folding in what ` +
          "is actually there would name the content with a digest no " +
          "complete image can reproduce, so it is refused instead. Check " +
          `whether ${raw} was truncated — a full scratch filesystem is the ` +
          "likeliest cause.",
      );
    }
  }

  const file = await Deno.open(raw, { read: true });
  try {
    const block = new Uint8Array(BLOCK_BYTES);
    let next = 0;
    for (const extent of extents) {
      const last = Math.floor((extent.start + extent.length - 1) / BLOCK_BYTES);
      const first = Math.max(Math.floor(extent.start / BLOCK_BYTES), next);
      for (let index = first; index <= last; index++) {
        const offset = index * BLOCK_BYTES;
        const bytes = block.subarray(
          0,
          Math.min(BLOCK_BYTES, sizeBytes - offset),
        );
        await readExact(file, offset, bytes);
        // The whole point: a block of zeros is content, not allocation, so a
        // region one image stores as a written-out zero cluster and another
        // leaves unallocated folds in identically — by not folding in at all.
        if (isZero(bytes)) continue;
        lines.push(`${index} ${await sha256Hex(bytes)}`);
      }
      next = last + 1;
    }
  } finally {
    file.close();
  }
  return await sha256Hex(lines.join("\n"));
}

/** Fill `into` from `offset`, refusing a short read rather than digesting it. */
async function readExact(
  file: Deno.FsFile,
  offset: number,
  into: Uint8Array,
): Promise<void> {
  await file.seek(offset, Deno.SeekMode.Start);
  let filled = 0;
  while (filled < into.length) {
    const read = await file.read(into.subarray(filled));
    if (read === null) {
      throw new Error(
        `content digest: end of file ${filled} bytes into the block at ` +
          `${offset}. Hashing a short read would name this content with a ` +
          "digest no complete image can ever produce.",
      );
    }
    filled += read;
  }
}

/** Whether every byte is zero, a word at a time. */
function isZero(bytes: Uint8Array): boolean {
  const whole = bytes.length >>> 2;
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, whole);
  for (let i = 0; i < whole; i++) if (words[i] !== 0) return false;
  for (let i = whole << 2; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}
