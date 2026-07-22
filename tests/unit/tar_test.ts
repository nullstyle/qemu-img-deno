import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildTar,
  TAR_BLOCK,
  type TarEntry,
  TarEntryError,
  USTAR_MAX_SIZE_BYTES,
} from "../../src/fs/tar.ts";

const MTIME = 981_173_106;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Read a NUL/space-terminated string field out of a header block. */
function field(tar: Uint8Array, block: number, offset: number, length: number) {
  const raw = tar.subarray(
    block * TAR_BLOCK + offset,
    block * TAR_BLOCK + offset + length,
  );
  const end = raw.findIndex((byte) => byte === 0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end)).trimEnd();
}

/** Recompute a header's checksum the way a reader does, and read the stored. */
function checksums(tar: Uint8Array, block: number) {
  const header = tar.slice(block * TAR_BLOCK, (block + 1) * TAR_BLOCK);
  const stored = parseInt(field(tar, block, 148, 8), 8);
  header.fill(0x20, 148, 156);
  let computed = 0;
  for (const byte of header) computed += byte;
  return { stored, computed };
}

/** A file entry with the boilerplate filled in. */
function file(path: string, text = ""): TarEntry {
  return {
    path,
    type: "file",
    mode: 0o644,
    mtime: MTIME,
    body: encoder.encode(text),
  };
}

Deno.test("archive is block-aligned and ends in exactly two zero blocks", () => {
  const tar = buildTar([file("a.txt", "hello")]);
  assertEquals(tar.byteLength % TAR_BLOCK, 0);
  // header + one body block + two trailer blocks.
  assertEquals(tar.byteLength, 4 * TAR_BLOCK);
  const trailer = tar.subarray(tar.byteLength - 2 * TAR_BLOCK);
  assert(trailer.every((byte) => byte === 0), "trailer is not all zero");
  // Exactly two: with one, busybox 1.37.0 extracts every file correctly and
  // then exits 1 with "invalid tar magic", which reads as data loss.
  const beforeTrailer = tar.subarray(
    tar.byteLength - 3 * TAR_BLOCK,
    tar.byteLength - 2 * TAR_BLOCK,
  );
  assert(
    !beforeTrailer.every((byte) => byte === 0),
    "a third zero block means the trailer is longer than measured-good",
  );
});

Deno.test("header checksum is computed with the field holding 8 spaces", () => {
  const tar = buildTar([
    file("a.txt", "hello"),
    { path: "d", type: "dir", mode: 0o755, mtime: MTIME },
  ]);
  for (const block of [0, 2]) {
    const { stored, computed } = checksums(tar, block);
    assertEquals(stored, computed, `block ${block} checksum`);
  }
  // The whole point of the spaces: a checksum taken over the field's own
  // zeros differs from the one every reader recomputes.
  const zeroed = tar.slice(0, TAR_BLOCK);
  zeroed.fill(0, 148, 156);
  let overZeros = 0;
  for (const byte of zeroed) overZeros += byte;
  assertEquals(overZeros, checksums(tar, 0).computed - 8 * 0x20);
});

Deno.test("ustar magic, version, and typeflags sit where readers look", () => {
  const tar = buildTar([
    { path: "d", type: "dir", mode: 0o755, mtime: MTIME },
    file("d/f.txt", "x"),
    {
      path: "d/link",
      type: "symlink",
      mode: 0o777,
      mtime: MTIME,
      linkTarget: "f.txt",
    },
  ]);
  const dir = 0, fileBlock = 1, link = 3;
  for (const block of [dir, fileBlock, link]) {
    assertEquals(field(tar, block, 257, 6), "ustar");
    assertEquals(tar[block * TAR_BLOCK + 262], 0, "magic is NUL-terminated");
    assertEquals(field(tar, block, 263, 2), "00");
  }
  assertEquals(tar[dir * TAR_BLOCK + 156], 0x35, "dir typeflag '5'");
  assertEquals(tar[fileBlock * TAR_BLOCK + 156], 0x30, "file typeflag '0'");
  assertEquals(tar[link * TAR_BLOCK + 156], 0x32, "symlink typeflag '2'");

  // Dirs carry a trailing slash and size 0; symlinks carry the target in
  // linkname[100] and no data blocks at all.
  assertEquals(field(tar, dir, 0, 100), "d/");
  assertEquals(field(tar, dir, 124, 12), "00000000000");
  assertEquals(field(tar, link, 157, 100), "f.txt");
  assertEquals(field(tar, link, 124, 12), "00000000000");
  // link header at 3 means the file body took exactly one block at 2. A path
  // that fits 100 bytes goes wholly in `name`; prefix stays empty.
  assertEquals(field(tar, fileBlock, 0, 100), "d/f.txt");
  assertEquals(field(tar, fileBlock, 345, 155), "");
});

Deno.test("ownership is pinned to root, never the host's uid", () => {
  const tar = buildTar([
    file("a.txt", "x"),
    { path: "d", type: "dir", mode: 0o700, mtime: MTIME },
  ]);
  for (const block of [0, 2]) {
    // Measured: without these the host's 501:10 is restored inside the guest,
    // and busybox tar has no --numeric-owner to undo it with.
    assertEquals(field(tar, block, 108, 8), "0000000", "uid");
    assertEquals(field(tar, block, 116, 8), "0000000", "gid");
    assertEquals(field(tar, block, 265, 32), "root", "uname");
    assertEquals(field(tar, block, 297, 32), "root", "gname");
    assertEquals(parseInt(field(tar, block, 136, 12), 8), MTIME, "mtime");
  }
  assertEquals(field(tar, 0, 100, 8), "0000644");
  assertEquals(field(tar, 2, 100, 8), "0000700");
});

Deno.test("a 90/150 split path uses prefix, not a long-name record", () => {
  const prefix = `${"p".repeat(74)}/${"q".repeat(75)}`;
  const name = "n".repeat(90);
  assertEquals(prefix.length, 150);
  const tar = buildTar([file(`${prefix}/${name}`, "x")]);
  assertEquals(tar[156], 0x30, "the first header is the real one");
  assertEquals(field(tar, 0, 0, 100), name);
  assertEquals(field(tar, 0, 345, 155), prefix);
});

Deno.test("a 120-byte final component emits a GNU 'L' record", () => {
  // The case measured working in busybox 1.37.0, and the exact case
  // `bsdtar --format ustar` drops from the archive while exiting 0.
  const long = "z".repeat(120);
  const path = `nest/${long}`;
  const tar = buildTar([file(path, "body")]);
  assertEquals(tar[156], 0x4c, "typeflag 'L' at 156");
  assertEquals(field(tar, 0, 0, 100), "././@LongLink");
  // Size counts the trailing NUL GNU writes after the name.
  assertEquals(parseInt(field(tar, 0, 124, 12), 8), path.length + 1);
  assertEquals(
    decoder.decode(tar.subarray(TAR_BLOCK, TAR_BLOCK + path.length)),
    path,
  );
  assertEquals(tar[TAR_BLOCK + path.length], 0);
  // Then the real header, whose own name field is the GNU-style truncation
  // that readers honoring the 'L' record overwrite.
  assertEquals(tar[2 * TAR_BLOCK + 156], 0x30);
  assertEquals(field(tar, 2, 0, 100), path.slice(0, 100));
  assertEquals(field(tar, 2, 345, 155), "");
  assertEquals(checksums(tar, 0).stored, checksums(tar, 0).computed);
});

Deno.test("UTF-8 name bytes pass through untouched", () => {
  // Measured round-tripping into the guest verbatim.
  const path = "ünïcode dir/naïve.txt";
  const tar = buildTar([file(path, "x")]);
  assertEquals(field(tar, 0, 0, 100), path);
  // 21 characters, 24 bytes: the field is counted in bytes, and the two-byte
  // sequences must survive as themselves.
  assertEquals(encoder.encode(path).byteLength, 24);
  assertEquals(tar.subarray(0, 24), encoder.encode(path));
});

Deno.test("unrepresentable entries throw rather than shortening the archive", () => {
  // Each of these is a case where a host tar exits 0 and writes a short
  // archive. The throw is the feature under test.
  const cases: readonly (readonly [string, TarEntry])[] = [
    ["empty", { ...file(""), path: "" }],
    ["absolute", file("/etc/passwd")],
    ["dotdot", file("a/../b")],
    ["dot", file("./a")],
    ["doubled slash", file("a//b")],
    ["trailing slash", file("a/")],
    ["NUL", file("a\0b")],
    ["negative mtime", { ...file("a"), mtime: -1 }],
    ["fractional mtime", { ...file("a"), mtime: 1.5 }],
    ["huge mtime", { ...file("a"), mtime: USTAR_MAX_SIZE_BYTES + 1 }],
    [
      "long linkTarget",
      {
        path: "l",
        type: "symlink",
        mode: 0o777,
        mtime: MTIME,
        linkTarget: "t".repeat(101),
      },
    ],
    ["symlink with no target", {
      path: "l",
      type: "symlink",
      mode: 0o777,
      mtime: MTIME,
    }],
    ["dir with a body", {
      path: "d",
      type: "dir",
      mode: 0o755,
      mtime: MTIME,
      body: encoder.encode("x"),
    }],
    ["file with a linkTarget", { ...file("f"), linkTarget: "t" }],
    [
      "oversized body",
      {
        // Never allocated: the size check reads byteLength and refuses before
        // any byte is copied, which is what makes the refusal affordable.
        ...file("big"),
        body: { byteLength: USTAR_MAX_SIZE_BYTES + 1 } as unknown as Uint8Array,
      },
    ],
  ];
  for (const [label, entry] of cases) {
    assertThrows(() => buildTar([entry]), TarEntryError, undefined, label);
  }
});

Deno.test("refusal messages name a fix, not just the condition", () => {
  const message = assertThrows(
    () => buildTar([file("/etc/passwd")]),
    TarEntryError,
  ).message;
  assert(message.includes("/etc/passwd"), "names the offending path");
  assert(message.includes("relative"), `no fix named: ${message}`);

  const unmeasured = assertThrows(
    () =>
      buildTar([{
        path: "l",
        type: "symlink",
        mode: 0o777,
        mtime: MTIME,
        linkTarget: "t".repeat(101),
      }]),
    TarEntryError,
  ).message;
  // The 'K' long-link record is unmeasured in this appliance's busybox; the
  // message must say so rather than implying the format cannot carry it.
  assert(unmeasured.includes("unmeasured"), unmeasured);
});

Deno.test("bodies are NUL-padded to a block multiple, entry order preserved", () => {
  const tar = buildTar([
    { path: "d", type: "dir", mode: 0o755, mtime: MTIME },
    file("d/a", "a".repeat(513)),
    file("d/b", ""),
  ]);
  // dir, a's header, two body blocks, b's header, two trailer blocks.
  assertEquals(tar.byteLength, 7 * TAR_BLOCK);
  assertEquals(field(tar, 0, 0, 100), "d/");
  assertEquals(field(tar, 1, 0, 100), "d/a");
  assertEquals(parseInt(field(tar, 1, 124, 12), 8), 513);
  assertEquals(tar[3 * TAR_BLOCK], 0x61);
  assert(
    tar.subarray(3 * TAR_BLOCK + 1, 4 * TAR_BLOCK).every((b) => b === 0),
    "tail of the last body block is not NUL padding",
  );
  assertEquals(field(tar, 4, 0, 100), "d/b");
  assertEquals(parseInt(field(tar, 4, 124, 12), 8), 0);
});

Deno.test("an empty archive is still a valid two-block trailer", () => {
  const tar = buildTar([]);
  assertEquals(tar.byteLength, 2 * TAR_BLOCK);
  assert(tar.every((byte) => byte === 0));
});
