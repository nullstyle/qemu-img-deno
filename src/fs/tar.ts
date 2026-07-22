/**
 * ustar writer: the `copyIn` transport, generated in TypeScript because both
 * host tars lie in ways that survive a passing build.
 *
 * Measured on macOS, and the reason this file exists rather than a shell-out:
 *
 * - `bsdtar --format ustar` **silently drops** any path it cannot split into
 *   prefix(155)/name(100). It prints `: Pathname too long` on stderr and still
 *   exits 0, so the archive is short and nothing in the pipeline knows.
 * - `bsdtar --format pax` emits AppleDouble `._NAME` members. `bsdtar -tf`
 *   re-merges them on read, so the host listing looks clean while the guest
 *   materializes every one of them into the image.
 *
 * Both are the silent-corruption shape this package refuses, so this writer
 * throws where they would drop. The constants below are observations rather
 * than preferences: every construct emitted here — plain and prefix-split
 * entries, directories, symlinks, bodies, and the GNU `'L'` long-name record
 * under POSIX magic — was verified against busybox tar 1.37.0 reading the
 * archive straight off a raw virtio block device.
 *
 * @module
 */

/** ustar block size, in bytes. Every header and body is padded to this. */
export const TAR_BLOCK = 512;

/**
 * Largest size an octal ustar size field can hold: `0o77777777777`.
 *
 * Eleven octal digits plus a NUL terminator. Beyond this a writer has to pick
 * a base-256 or pax extension, and neither is measured in busybox — so
 * `buildTar` throws instead.
 */
export const USTAR_MAX_SIZE_BYTES = 8_589_934_591;

/** Longest `name` field a ustar header has room for. */
const NAME_MAX = 100;
/** Longest `prefix` field a ustar header has room for. */
const PREFIX_MAX = 155;
/** Longest `linkname` field a ustar header has room for. */
const LINKNAME_MAX = 100;

/** One member of the archive. */
export interface TarEntry {
  /**
   * Relative, `/`-separated path. No leading `/`, no `.`/`..` segment, no
   * empty segment, no NUL. Directory entries are named without a trailing
   * slash — the writer appends the one ustar requires.
   */
  readonly path: string;
  /** What kind of member this is. */
  readonly type: "file" | "dir" | "symlink";
  /** Permission bits. Masked with `0o7777`; the type bits come from `type`. */
  readonly mode: number;
  /** Modification time in seconds. Pinned by the caller for determinism. */
  readonly mtime: number;
  /** Target of a symlink. Required for `symlink`, refused above 100 bytes. */
  readonly linkTarget?: string;
  /** File content. Only meaningful for `file`. */
  readonly body?: Uint8Array;
}

/**
 * Raised when an entry cannot be represented faithfully in ustar.
 *
 * Every path that reaches this class is one where a host `tar` would have
 * written a short archive and exited 0, so the throw is the feature.
 */
export class TarEntryError extends Error {
  /** The offending entry's path, as the caller supplied it. */
  readonly path: string;

  /** Build the error from the entry path and a message naming the fix. */
  constructor(path: string, message: string) {
    super(`tar entry ${JSON.stringify(path)} cannot be archived: ${message}`);
    this.name = "TarEntryError";
    this.path = path;
  }
}

const encoder = new TextEncoder();

/** ASCII bytes for the GNU long-name pseudo-entry's own header name. */
const LONG_NAME_MARKER = "././@LongLink";

/**
 * Write `text` into `block` at `offset`, refusing to spill past `length`.
 *
 * The refusal is not defensive dressing: a silent truncation here is exactly
 * the `bsdtar --format ustar` failure this module exists to prevent.
 */
function writeText(
  block: Uint8Array,
  offset: number,
  length: number,
  text: string,
): void {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > length) {
    throw new RangeError(
      `internal: ${bytes.byteLength} bytes do not fit a ${length}-byte field`,
    );
  }
  block.set(bytes, offset);
}

/**
 * Write a NUL-terminated octal field, zero-padded to fill `length - 1` digits.
 *
 * ustar permits either a NUL or a space terminator and every reader accepts
 * both. GNU tar and busybox write NUL, so that is what this writes. Note that
 * the bsdtar on this machine does NOT — it writes six digits plus a space and
 * a NUL for `mode`, and eleven digits plus a space for `size` and `mtime` — so
 * a byte-for-byte diff against a bsdtar-produced reference will differ in
 * these fields and be correct anyway.
 */
function writeOctal(
  block: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new RangeError(
      `internal: ${value} does not fit a ${length}-byte octal field`,
    );
  }
  writeText(block, offset, length - 1, digits.padStart(length - 1, "0"));
  block[offset + length - 1] = 0;
}

/**
 * Fill in a header's checksum field.
 *
 * The sum is taken over the whole 512-byte header with the checksum field
 * itself holding **eight spaces** — a header checksummed over its own zeros
 * verifies against nothing. The stored form is six octal digits, a NUL, then a
 * space, which is the layout every reader in the wild accepts.
 */
function finishChecksum(block: Uint8Array): void {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeOctal(block, 148, 7, sum);
  block[155] = 0x20;
}

/** Build a zeroed 512-byte header with the fields every entry shares. */
function baseHeader(
  typeflag: number,
  mode: number,
  size: number,
  mtime: number,
): Uint8Array {
  const block = new Uint8Array(TAR_BLOCK);
  writeOctal(block, 100, 8, mode & 0o7777);
  // uid/gid 0 and uname/gname "root", always. Measured: without these the
  // host's own 501:10 is restored verbatim inside the guest, because busybox
  // tar has no --numeric-owner and no --no-same-owner to undo it with.
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, mtime);
  block[156] = typeflag;
  writeText(block, 257, 6, "ustar\0");
  writeText(block, 263, 2, "00");
  writeText(block, 265, 32, "root");
  writeText(block, 297, 32, "root");
  return block;
}

/**
 * Split an archive path into ustar's `prefix`/`name` pair, or report that no
 * split exists.
 *
 * The split must land on a `/`, `prefix` must fit 155 bytes and `name` 100,
 * and `name` must be non-empty. Returning `undefined` is the signal to emit a
 * GNU `'L'` record — never to truncate.
 */
function splitPath(
  bytes: Uint8Array,
): { readonly prefix: string; readonly name: string } | undefined {
  const decoder = new TextDecoder();
  if (bytes.byteLength <= NAME_MAX) {
    return { prefix: "", name: decoder.decode(bytes) };
  }
  // Walk the separators from the right: the longest prefix that still fits
  // leaves the shortest name, which is the split most likely to succeed.
  for (
    let index = Math.min(PREFIX_MAX, bytes.byteLength - 1);
    index > 0;
    index--
  ) {
    if (bytes[index] !== 0x2f) continue;
    const nameLength = bytes.byteLength - index - 1;
    if (nameLength === 0 || nameLength > NAME_MAX) continue;
    return {
      prefix: decoder.decode(bytes.subarray(0, index)),
      name: decoder.decode(bytes.subarray(index + 1)),
    };
  }
  return undefined;
}

/** Validate one entry, returning the archive path its header should carry. */
function archivePath(entry: TarEntry): string {
  const path = entry.path;
  if (path.length === 0) {
    throw new TarEntryError(path, "the path is empty. Name the file.");
  }
  if (path.includes("\0")) {
    throw new TarEntryError(
      path,
      "the path contains a NUL byte, which terminates every ustar string " +
        "field — the guest would extract a different, shorter name. Rename " +
        "the file.",
    );
  }
  if (path.startsWith("/")) {
    throw new TarEntryError(
      path,
      "the path is absolute. Extraction is `tar -xf <disk> -C <dest>`, so an " +
        "absolute path would escape the destination. Pass it relative to the " +
        "tree root.",
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "") {
      throw new TarEntryError(
        path,
        "the path has an empty segment (a doubled or trailing `/`). Different " +
          "tars normalize that differently. Pass exactly one `/` between " +
          "segments and no trailing slash — dir entries get theirs here.",
      );
    }
    if (segment === "." || segment === "..") {
      throw new TarEntryError(
        path,
        `the path has a ${JSON.stringify(segment)} segment. It would resolve ` +
          "against the destination at extraction time, not here, so the file " +
          "could land outside the tree. Pass the resolved path.",
      );
    }
  }
  if (!Number.isSafeInteger(entry.mtime) || entry.mtime < 0) {
    throw new TarEntryError(
      path,
      `mtime ${entry.mtime} is not a non-negative integer number of seconds. ` +
        "Pin it to determinism.sourceDateEpoch.",
    );
  }
  if (entry.mtime > USTAR_MAX_SIZE_BYTES) {
    throw new TarEntryError(
      path,
      `mtime ${entry.mtime} exceeds the 11 octal digits a ustar mtime field ` +
        `holds (max ${USTAR_MAX_SIZE_BYTES}). Pin it to a real timestamp.`,
    );
  }
  return entry.type === "dir" ? `${path}/` : path;
}

/** Check body/linkTarget against the entry's own type, refusing a drop. */
function validatePayload(entry: TarEntry): void {
  const path = entry.path;
  if (entry.type === "symlink") {
    if (entry.linkTarget === undefined) {
      throw new TarEntryError(
        path,
        "it is a symlink with no linkTarget. A symlink header with an empty " +
          "linkname extracts as a dangling link. Set linkTarget.",
      );
    }
    const targetBytes = encoder.encode(entry.linkTarget).byteLength;
    if (targetBytes > LINKNAME_MAX) {
      // A GNU 'K' long-link record is the format's answer here, but it is
      // UNMEASURED in busybox 1.37.0 — only 'L' was verified. Emitting an
      // untested record risks the guest writing a truncated target, which
      // looks like a working build until something follows the link.
      throw new TarEntryError(
        path,
        `its symlink target is ${targetBytes} bytes, over the 100 a ustar ` +
          "linkname field holds. The GNU 'K' long-link record that would " +
          "carry it is unmeasured in this appliance's busybox, so it is not " +
          "emitted. Shorten the target, or copy the file instead of linking.",
      );
    }
    if (entry.body !== undefined) {
      throw new TarEntryError(
        path,
        "it is a symlink carrying a body. A symlink header has no data " +
          "blocks, so the body would be dropped. Drop it here, or make the " +
          'entry type "file".',
      );
    }
    return;
  }
  if (entry.linkTarget !== undefined) {
    throw new TarEntryError(
      path,
      `it is a ${entry.type} carrying a linkTarget. Only a symlink header has ` +
        'a linkname field. Set type to "symlink", or drop linkTarget.',
    );
  }
  if (entry.type === "dir" && entry.body !== undefined) {
    throw new TarEntryError(
      path,
      "it is a directory carrying a body. A dir header has size 0 and no data " +
        'blocks, so the body would be dropped. Make the entry type "file".',
    );
  }
  const size = entry.body?.byteLength ?? 0;
  if (size > USTAR_MAX_SIZE_BYTES) {
    throw new TarEntryError(
      path,
      `its body is ${size} bytes, over the ${USTAR_MAX_SIZE_BYTES} an octal ` +
        "ustar size field can express. Only base-256 or pax headers carry " +
        "more, and neither is measured in this appliance's busybox. Split " +
        "the file, or build it inside the guest.",
    );
  }
}

/**
 * Serialize entries to a ustar archive, ready to attach as a raw disk.
 *
 * Callers must emit a parent directory before its children — the writer
 * preserves the given order, and busybox tar creates missing parents with
 * default modes rather than the ones a later entry asks for.
 *
 * The result always ends in **exactly two** all-zero blocks. Measured: with
 * one, busybox extracts every file correctly and *then* prints
 * `tar: invalid tar magic` and exits 1 — a run that reads as data loss when
 * there is none. With none it does the same. Two is not a convention here.
 */
export function buildTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    validatePayload(entry);
    const path = archivePath(entry);
    const pathBytes = encoder.encode(path);
    const size = entry.type === "file" ? entry.body?.byteLength ?? 0 : 0;

    const split = splitPath(pathBytes);
    if (split === undefined) {
      // No prefix/name split exists. Emit a GNU 'L' record: a pseudo-entry
      // whose body is the real name. This is precisely the case where
      // `bsdtar --format ustar` drops the file and exits 0.
      //
      // Note the pairing: an 'L' record under POSIX `ustar\0` + `00` magic,
      // not GNU's `ustar  \0`. busybox dispatches on the typeflag before it
      // reads the magic, so it accepts the combination — measured, with a
      // 120-character component written by THIS writer and extracted intact
      // in the appliance by `deno task smoke:system`.
      const nameBlock = baseHeader(0x4c, 0, pathBytes.byteLength + 1, 0);
      writeText(nameBlock, 0, NAME_MAX, LONG_NAME_MARKER);
      finishChecksum(nameBlock);
      chunks.push(nameBlock);
      chunks.push(padToBlock(pathBytes, pathBytes.byteLength + 1));
    }

    const typeflag = entry.type === "file"
      ? 0x30
      : entry.type === "dir"
      ? 0x35
      : 0x32;
    const header = baseHeader(typeflag, entry.mode, size, entry.mtime);
    if (split === undefined) {
      // GNU's convention: the real header still carries a truncated name, so
      // a reader that ignores 'L' records at least reports something. Readers
      // that honor 'L' — busybox and bsdtar both do — overwrite it.
      header.set(pathBytes.subarray(0, NAME_MAX), 0);
    } else {
      writeText(header, 0, NAME_MAX, split.name);
      writeText(header, 345, PREFIX_MAX, split.prefix);
    }
    if (entry.type === "symlink") {
      writeText(header, 157, LINKNAME_MAX, entry.linkTarget ?? "");
    }
    finishChecksum(header);
    chunks.push(header);

    if (size > 0 && entry.body !== undefined) {
      chunks.push(padToBlock(entry.body, size));
    }
  }
  // Two zero blocks, then nothing. The trailer is self-delimiting, so the tar
  // needs no length header even when it is written to a much larger disk.
  chunks.push(new Uint8Array(TAR_BLOCK * 2));
  return concat(chunks);
}

/** Copy `bytes` into a fresh buffer NUL-padded up to a `TAR_BLOCK` multiple. */
function padToBlock(bytes: Uint8Array, length: number): Uint8Array {
  const padded = new Uint8Array(Math.ceil(length / TAR_BLOCK) * TAR_BLOCK);
  padded.set(bytes.subarray(0, length));
  return padded;
}

/** Join block-aligned chunks into one buffer. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
