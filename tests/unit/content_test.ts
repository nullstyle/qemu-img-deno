import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { QemuImg } from "../../src/qemu_img.ts";
import { type FakeExtent, FakeQemuImg } from "../../testing/mod.ts";
import { contentDigest } from "../../src/recipe/content.ts";
import { sha256Hex } from "../../src/digest.ts";

/**
 * A scratch directory under the repo, since `deno task test` grants write
 * access to `tests/.tmp` and nowhere else. `makeTempDir` does not create
 * parents, and the directory is gitignored.
 */
async function scratchDir(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

const MIB = 1024 * 1024;

/** A block-sized run of a repeating byte pattern, never all zeros. */
function pattern(seed: number, length = MIB): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = ((i * 31 + seed) % 251) + 1;
  return bytes;
}

/** Concatenate declared runs into one guest-visible image content. */
function concat(...runs: readonly Uint8Array[]): Uint8Array {
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const run of runs) {
    out.set(run, at);
    at += run.length;
  }
  return out;
}

let counter = 0;

/**
 * Digest one declared image.
 *
 * The bytes are the test's to state and so is the allocation map: the fake
 * models no qcow2 allocator, and the entire claim under test is that the
 * digest does not depend on one. `extents` therefore stands in for what
 * `qemu-img map` would report about the raw materialization — the one input
 * to `contentDigest()` that a real run varies for reasons that mean nothing.
 */
async function digestOf(
  scratch: string,
  content: Uint8Array,
  options: {
    readonly virtualSizeBytes?: number;
    readonly extents?: readonly FakeExtent[];
  } = {},
): Promise<string> {
  const fake = new FakeQemuImg();
  fake.materialize = true;
  fake.refuseContentOracles = true;
  const source = `${scratch}/declared-${counter++}.qcow2`;
  fake.setImage(source, {
    format: "qcow2",
    virtualSizeBytes: options.virtualSizeBytes ?? content.byteLength,
    content,
  });
  const extents = options.extents;
  if (extents !== undefined) {
    fake.onConvert = (convert) => {
      fake.setImage(convert.dest, { extents });
    };
  }
  const qemu = new QemuImg({ runner: fake });
  return await contentDigest(qemu, source, { scratch, format: "qcow2" });
}

Deno.test("identical content digests the same however the image says it is allocated", async () => {
  const scratch = await scratchDir();
  try {
    // Block 0 holds data, block 1 is all zeros, block 2 holds data, and a
    // fourth zero block follows the declared content.
    const content = concat(pattern(1), new Uint8Array(MIB), pattern(2));
    const size = 4 * MIB;

    // The "no holes at all" answer — a filesystem, or a qemu, that reports one
    // full-length data extent. Every block is read and the zero check drops
    // the empty ones.
    const flat = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [{ start: 0, length: size, data: true }],
    });
    // Holes reported as explicit zero extents — a written-out zero cluster.
    const zeroed = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [
        { start: 0, length: MIB, data: true },
        { start: MIB, length: MIB, zero: true },
        { start: 2 * MIB, length: MIB, data: true },
        { start: 3 * MIB, length: MIB, zero: true },
      ],
    });
    // Holes omitted from the map entirely — the unallocated spelling. This is
    // the pair the whole module exists for: the same guest content stored two
    // ways, which a container digest would call two different layers.
    const sparse = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [
        { start: 0, length: MIB, data: true },
        { start: 2 * MIB, length: MIB, data: true },
      ],
    });
    // Same again, reported out of order. qemu-img emits extents in offset
    // order; the sort is what keeps the block cursor monotonic if it ever
    // does not.
    const shuffled = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [
        { start: 2 * MIB, length: MIB, data: true },
        { start: 0, length: MIB, data: true },
      ],
    });

    assertEquals(flat, zeroed);
    assertEquals(flat, sparse);
    assertEquals(flat, shuffled);
    // Not an accident of everything being empty: the digest of this content
    // differs from the digest of a disk of the same size holding nothing.
    const empty = await digestOf(scratch, new Uint8Array(), {
      virtualSizeBytes: size,
      extents: [{ start: 0, length: size, data: true }],
    });
    assertNotEquals(flat, empty);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("one changed byte changes the digest", async () => {
  const scratch = await scratchDir();
  try {
    const before = concat(pattern(1), new Uint8Array(MIB), pattern(2));
    const after = before.slice();
    // Last byte of the last block, so it is also the least likely offset for a
    // truncated read to reach.
    after[after.length - 1] ^= 0x01;
    const map = [{ start: 0, length: 3 * MIB, data: true }];

    assertNotEquals(
      await digestOf(scratch, before, { extents: map }),
      await digestOf(scratch, after, { extents: map }),
    );
    // …and a byte inside a region the map calls a hole still counts, because
    // the map is advice about where to look, not about what is there.
    const inHole = before.slice();
    inHole[MIB + 5] = 0x7f;
    assertNotEquals(
      await digestOf(scratch, before, { extents: map }),
      await digestOf(scratch, inHole, { extents: map }),
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("the virtual size is part of the digest, not just the data in it", async () => {
  const scratch = await scratchDir();
  try {
    const content = pattern(3);
    // A filesystem followed by a terabyte of zeros is not the same disk as the
    // filesystem alone: every LBA the plan derived came from this number.
    const small = await digestOf(scratch, content, {
      virtualSizeBytes: 2 * MIB,
      extents: [{ start: 0, length: MIB, data: true }],
    });
    const large = await digestOf(scratch, content, {
      virtualSizeBytes: 8 * MIB,
      extents: [{ start: 0, length: MIB, data: true }],
    });
    assertNotEquals(small, large);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("a block two extents share is folded exactly once", async () => {
  const scratch = await scratchDir();
  try {
    const content = concat(pattern(4), pattern(5));
    const size = 2 * MIB;
    const single = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [{ start: 0, length: 4096, data: true }],
    });
    // Two extents that both land inside block 0. Folding it twice would put
    // the same `<index> <hash>` line in the preimage twice — a digest that
    // depends on how finely qemu happened to split its extent list.
    const split = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [
        { start: 0, length: 2048, data: true },
        { start: 2048, length: 2048, data: true },
      ],
    });
    assertEquals(single, split);
    // A zero-LENGTH extent between them must not rewind the cursor and let the
    // block be folded a second time.
    const degenerate = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [
        { start: 0, length: 2048, data: true },
        { start: 0, length: 0, data: true },
        { start: 2048, length: 2048, data: true },
      ],
    });
    assertEquals(single, degenerate);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("an extent's end is exclusive, so it never pulls in the next block", async () => {
  const scratch = await scratchDir();
  try {
    const content = concat(pattern(6), pattern(7));
    const size = 2 * MIB;
    // Exactly one block, ending on the boundary.
    const oneBlock = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [{ start: 0, length: MIB, data: true }],
    });
    const twoBlocks = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [{ start: 0, length: 2 * MIB, data: true }],
    });
    // Off-by-one in the last-block arithmetic — `(start + length) / BLOCK`
    // rather than `(start + length - 1) / BLOCK` — makes these equal, and
    // reads a block past every extent in every image.
    assertNotEquals(oneBlock, twoBlocks);
    // Sixteen bytes across the boundary reach into both blocks, and the digest
    // folds both in whole — the block, not the extent, is the unit.
    const straddling = await digestOf(scratch, content, {
      virtualSizeBytes: size,
      extents: [{ start: MIB - 8, length: 16, data: true }],
    });
    assertNotEquals(straddling, oneBlock);
    assertEquals(straddling, twoBlocks);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("the digest is exactly the documented preimage", async () => {
  const scratch = await scratchDir();
  try {
    // Block 0 all zeros, block 1 a seven-byte tail that is NOT word-aligned —
    // so the zero check's trailing loop, not just its 32-bit fast path, has to
    // see the one non-zero byte in it.
    const tail = new Uint8Array(7);
    tail[5] = 0x2a;
    const content = concat(new Uint8Array(MIB), tail);
    const digest = await digestOf(scratch, content, {
      // No `extents`: the map then follows from the declared content, which
      // exercises the derived path rather than a stated one.
      virtualSizeBytes: content.byteLength,
    });

    // Built from the module's documented shape rather than from its code: the
    // algorithm tag and scheme version, the raw materialization's size, then
    // one `<block index> <sha256 of the block>` line per NON-ZERO block, joined
    // with newlines and hashed. Block 0 is absent because it is zeros.
    const expected = await sha256Hex(
      [
        `qemu-img-content@1 ${content.byteLength}`,
        `1 ${await sha256Hex(tail)}`,
      ].join("\n"),
    );
    assertEquals(digest, expected);

    // A zero block is content, not allocation: adding one changes only the
    // size in the header, never a block line.
    const padded = await digestOf(scratch, concat(content, new Uint8Array(9)), {
      virtualSizeBytes: content.byteLength + 9,
    });
    assertEquals(
      padded,
      await sha256Hex(
        [
          `qemu-img-content@1 ${content.byteLength + 9}`,
          `1 ${await sha256Hex(concat(tail, new Uint8Array(9)))}`,
        ].join("\n"),
      ),
    );
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

/** Every `.raw` still sitting in a scratch directory. */
function strayRaw(scratch: string): string[] {
  return [...Deno.readDirSync(scratch)]
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".raw"));
}

Deno.test("the transient raw materialization is removed, success or not", async () => {
  const scratch = await scratchDir();
  try {
    // A digest coming back at all proves the raw file was there: it is
    // `Deno.stat`ed and then read block by block. So the only open question is
    // whether it was cleaned up afterwards.
    await digestOf(scratch, pattern(8));
    assertEquals(strayRaw(scratch), []);

    // Now fail AFTER the materialization, which is what the `finally` is
    // actually for. Leaving these behind puts one full-size raw file per
    // failed layer in the store's scratch directory.
    const fake = new FakeQemuImg();
    fake.materialize = true;
    const source = `${scratch}/broken.qcow2`;
    fake.setImage(source, {
      format: "qcow2",
      virtualSizeBytes: MIB,
      content: pattern(9),
    });
    let existedDuringTheFailure = false;
    fake.stub((call) => {
      if (call.args[0] !== "map") return false;
      // Read from the matcher because this is the only moment the file is
      // meant to be on disk: after the convert wrote it, before the `finally`
      // takes it away.
      existedDuringTheFailure = strayRaw(scratch).length === 1;
      return true;
    }, { success: false, code: 1, stdout: "", stderr: "qemu-img: injected" });

    let threw = false;
    try {
      await contentDigest(new QemuImg({ runner: fake }), source, {
        scratch,
        format: "qcow2",
      });
    } catch {
      threw = true;
    }
    assert(threw, "the failed map should have propagated");
    assert(existedDuringTheFailure, "the raw file was never materialized");
    assertEquals(strayRaw(scratch), []);
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

/**
 * Whether this process may actually run `qemu-img`.
 *
 * `deno task test` grants `--allow-run` for a fixed list that does not include
 * it, so the real-binary leg below is skipped there and runs under `deno test
 * -A` (and in the smokes, which have the binary as a hard requirement). It is
 * a separate leg because the property it checks — that two REAL qcow2 files
 * holding the same bytes in different clusters digest the same — is precisely
 * the one no fake can establish.
 */
function qemuAvailable(): boolean {
  if (
    Deno.permissions.querySync({ name: "run", command: "qemu-img" }).state !==
      "granted"
  ) {
    return false;
  }
  try {
    return new Deno.Command("qemu-img", { args: ["--version"] }).outputSync()
      .success;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "real qcow2 images holding the same bytes digest the same [needs qemu-img]",
  ignore: !qemuAvailable(),
  fn: async () => {
    const scratch = await scratchDir();
    try {
      const qemu = new QemuImg();
      const content = concat(pattern(11), new Uint8Array(MIB), pattern(12));
      const raw = `${scratch}/source.raw`;
      await Deno.writeFile(raw, content);
      await Deno.truncate(raw, 8 * MIB);

      // Three real images over identical guest content, allocated three ways:
      // default clusters with the hole left unallocated, 1 MiB clusters, and
      // sparse detection off so every zero is written out.
      const sparse = `${scratch}/sparse.qcow2`;
      const clustered = `${scratch}/clustered.qcow2`;
      const dense = `${scratch}/dense.qcow2`;
      await qemu.convert(raw, sparse, { sourceFormat: "raw", format: "qcow2" });
      await qemu.convert(raw, clustered, {
        sourceFormat: "raw",
        format: "qcow2",
        options: { cluster_size: 1048576 },
      });
      await qemu.convert(raw, dense, {
        sourceFormat: "raw",
        format: "qcow2",
        sparseSize: 0,
      });

      // The images really are stored differently, or the comparison below
      // proves nothing.
      const sizes = await Promise.all(
        [sparse, clustered, dense].map((path) =>
          Deno.stat(path).then((stat) => stat.size)
        ),
      );
      assertNotEquals(sizes[0], sizes[2], "sparse and dense are the same size");
      const maps = await Promise.all(
        [sparse, clustered, dense].map((path) =>
          qemu.map(path, { format: "qcow2" })
        ),
      );
      assertNotEquals(
        JSON.stringify(maps[0].map((e) => [e.start, e.length, e.zero])),
        JSON.stringify(maps[2].map((e) => [e.start, e.length, e.zero])),
        "sparse and dense report the same allocation map",
      );

      const digests = await Promise.all(
        [sparse, clustered, dense].map((path) =>
          contentDigest(qemu, path, { scratch, format: "qcow2" })
        ),
      );
      assertEquals(digests[0], digests[1]);
      assertEquals(digests[0], digests[2]);

      // One flipped byte in the middle of a data region.
      const edited = content.slice();
      edited[MIB * 2 + 17] ^= 0xff;
      const editedRaw = `${scratch}/edited.raw`;
      await Deno.writeFile(editedRaw, edited);
      await Deno.truncate(editedRaw, 8 * MIB);
      const editedImage = `${scratch}/edited.qcow2`;
      await qemu.convert(editedRaw, editedImage, {
        sourceFormat: "raw",
        format: "qcow2",
      });
      assertNotEquals(
        digests[0],
        await contentDigest(qemu, editedImage, { scratch, format: "qcow2" }),
      );

      // An overlay reads through its backing chain, so an untouched overlay
      // holds exactly its parent's content.
      const overlay = `${scratch}/overlay.qcow2`;
      await qemu.create(overlay, {
        format: "qcow2",
        // Relative to the OVERLAY's own directory, which is how qemu-img
        // resolves a backing reference — the same rule `build()` relies on to
        // keep the layer store relocatable.
        backing: "sparse.qcow2",
        backingFormat: "qcow2",
      });
      assertEquals(
        digests[0],
        await contentDigest(qemu, overlay, { scratch, format: "qcow2" }),
      );
    } finally {
      await Deno.remove(scratch, { recursive: true });
    }
  },
});
