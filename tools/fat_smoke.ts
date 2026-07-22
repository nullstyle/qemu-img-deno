/**
 * Real-oracle smoke for the FAT writer. Run manually before tagging a release:
 *
 *     deno task smoke:fat
 *
 * Nothing here is a self-round-trip. Every volume this builds is judged by
 * implementations that share no code with it:
 *
 * - **`/sbin/fsck_msdos -n`** — Apple's FAT checker. Structural verdict.
 * - **`hdiutil attach` + reading the mount** — Apple's FAT *driver*, plus
 *   `diskutil`'s own independent determination of the volume's type, which is
 *   the check that matters at a cluster-count boundary.
 * - **`qemu-img`** — converts the volume to qcow2 and back, and splices it into
 *   an overlay whose backing file is entirely non-zero, which is the only way
 *   to prove nothing was left unwritten.
 *
 * macOS only: `fsck_msdos` and `hdiutil` are Darwin. Loud-skips (exit 0)
 * elsewhere.
 *
 * ## A measured blind spot in the mount oracle
 *
 * The Darwin `msdos` driver derives a file's `st_ino` from where its directory
 * entry sits, and on FAT12/16 the ROOT directory gets a special-cased id space
 * that **overlaps the one used for files in subdirectories**. On a volume with
 * a large root directory *and* a populated subdirectory the two collide, and
 * because the VFS name cache is keyed on that id, opening one file by name
 * hands back the other file's contents.
 *
 * Measured on macOS 26.5.2, FAT16, 400 root files plus 400 files in one
 * subdirectory: exactly 80 pairs share an `st_ino`, and exactly those 80 files
 * read back as their collision partner. `readdir` is unaffected — all 801 names
 * enumerate correctly — and `fsck_msdos` calls the volume clean. FAT32 is
 * immune, because its root is an ordinary cluster chain whose entries live in
 * the same id space as everything else, and the same tree at FAT32 reads back
 * perfectly.
 *
 * So: **this is the oracle miscounting, not the writer misplacing bytes.** The
 * image is verified correct by walking it directly — `tests/unit/fat_test.ts`
 * does exactly that with a reader written against the spec. The big-directory
 * case below therefore uses `fsck_msdos` and not the mount, and the mounted
 * comparisons are kept to trees small enough that no collision is possible.
 *
 * @module
 */

import {
  buildFat,
  describeFat,
  type FatEntry,
  fatEntryShapes,
  type FatOptions,
  minimumFatSizeBytes,
  SECTOR_BYTES,
} from "../src/fs/fat.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

let failures = 0;
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) {
    console.error(`✗ ${label}`);
    failures++;
  }
}

/** Run a command, capturing both streams. */
async function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const result = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: result.code,
    out: new TextDecoder().decode(result.stdout),
    err: new TextDecoder().decode(result.stderr),
  };
}

/** Pull one `<string>` value out of an hdiutil plist by its key. */
function plistField(plist: string, key: string): string | undefined {
  const at = plist.indexOf(`<key>${key}</key>`);
  if (at < 0) return undefined;
  return /<string>([^<]*)<\/string>/.exec(plist.slice(at))?.[1];
}

if (Deno.build.os !== "darwin") {
  skip(`fsck_msdos and hdiutil are Darwin-only (this is ${Deno.build.os})`);
  Deno.exit(0);
}

const EPOCH = 1_700_000_000; // 2023-11-14T22:13:20Z
const encoder = new TextEncoder();

/** Deterministic filler, so a content mismatch is reproducible. */
function filler(byteLength: number, seed: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < byteLength; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[index] = (state >>> 24) & 0xff;
  }
  return out;
}

/**
 * A realistic ESP: an 8.3-clean loader, a lowercase config, a name no 8.3
 * short form can hold, a zero-length file, and a body spanning many clusters.
 */
const TREE: FatEntry[] = [
  { path: "EFI", type: "dir", mtime: EPOCH },
  { path: "EFI/BOOT", type: "dir", mtime: EPOCH },
  {
    path: "EFI/BOOT/BOOTAA64.EFI",
    type: "file",
    mtime: EPOCH,
    body: filler(9137, 1),
  },
  {
    path: "EFI/BOOT/grub.cfg",
    type: "file",
    mtime: EPOCH,
    body: encoder.encode("set timeout=0\nlinux /vmlinuz root=/dev/vda2\n"),
  },
  {
    path: "a file with a very long name indeed.config",
    type: "file",
    mtime: EPOCH,
    body: encoder.encode("long name payload\n"),
  },
  { path: "empty.txt", type: "file", mtime: EPOCH, body: new Uint8Array(0) },
  {
    path: "spans-many-clusters.bin",
    type: "file",
    mtime: EPOCH,
    body: filler(300_000, 2),
  },
];

const BASE: Omit<FatOptions, "sizeBytes" | "fatType"> = {
  label: "ESP",
  volumeId: 0x12345678,
  sourceDateEpoch: EPOCH,
};

const dir = await Deno.makeTempDir({ prefix: "fat-smoke-" });
/** Devices attached by this run, detached individually in `finally`. */
const attached: string[] = [];

/**
 * Attach a raw image, hand the mount point to `body`, then detach *that*
 * device — never a sweep over every attached disk.
 */
async function withMount(
  image: string,
  body: (mount: string, device: string) => Promise<void>,
): Promise<boolean> {
  const attach = await run("hdiutil", [
    "attach",
    "-imagekey",
    "diskimage-class=CRawDiskImage",
    "-plist",
    image,
  ]);
  if (attach.code !== 0) {
    assert(false, `hdiutil attach failed: ${attach.err.trim()}`);
    return false;
  }
  const device = plistField(attach.out, "dev-entry");
  const mount = plistField(attach.out, "mount-point");
  if (device === undefined || mount === undefined) {
    assert(false, "hdiutil attach reported no device or mount point");
    return false;
  }
  attached.push(device);
  try {
    await body(mount, device);
  } finally {
    const detach = await run("hdiutil", ["detach", device]);
    if (detach.code === 0) {
      attached.splice(attached.indexOf(device), 1);
    } else {
      console.error(`✗ hdiutil detach ${device} failed: ${detach.err.trim()}`);
      failures++;
    }
  }
  return true;
}

/** Build, then put the result in front of all three oracles. */
async function verify(
  label: string,
  sizeBytes: number,
  fatType: 12 | 16 | 32 | undefined,
  expectClusters?: number,
): Promise<void> {
  step(`${label} — ${sizeBytes} bytes, fatType ${fatType ?? "(default)"}`);
  const bytes = buildFat(TREE, { ...BASE, sizeBytes, fatType });
  const geometry = describeFat(bytes);

  assert(
    bytes.byteLength === sizeBytes,
    `the whole ${sizeBytes}-byte window is returned`,
  );
  if (fatType !== undefined) {
    assert(
      geometry.fatType === fatType,
      `BPB-derived type is FAT${fatType} (got FAT${geometry.fatType})`,
    );
  }
  if (expectClusters !== undefined) {
    assert(
      geometry.clusterCount === expectClusters,
      `cluster count is exactly ${expectClusters} (got ${geometry.clusterCount})`,
    );
  }
  console.log(
    `  FAT${geometry.fatType} clusters=${geometry.clusterCount} ` +
      `spc=${geometry.sectorsPerCluster} rsvd=${geometry.reservedSectors} ` +
      `fatSectors=${geometry.fatSectors} rootEnt=${geometry.rootEntryCount}`,
  );

  const image = `${dir}/${label.replace(/[^a-z0-9]+/gi, "-")}.img`;
  await Deno.writeFile(image, bytes);

  // --- Oracle 1: Apple's checker ----------------------------------------
  const fsck = await run("/sbin/fsck_msdos", ["-n", image]);
  assert(
    fsck.code === 0,
    `fsck_msdos -n exits 0 (got ${fsck.code})\n${fsck.out}${fsck.err}`,
  );

  // --- Oracle 2: Apple's driver -----------------------------------------
  await withMount(image, async (mount, device) => {
    const info = await run("diskutil", ["info", device]);
    const personality = /File System Personality:\s*(.+)/.exec(info.out)?.[1]
      .trim();
    assert(
      personality === `MS-DOS FAT${geometry.fatType}`,
      `diskutil agrees the volume is FAT${geometry.fatType} ` +
        `(it says ${JSON.stringify(personality)})`,
    );
    const name = /Volume Name:\s*(.+)/.exec(info.out)?.[1].trim();
    assert(name === "ESP", `volume label reads back as ESP (got ${name})`);

    for (const entry of TREE) {
      const at = `${mount}/${entry.path}`;
      const stat = await Deno.stat(at).catch(() => undefined);
      if (stat === undefined) {
        assert(false, `${entry.path} is present`);
        continue;
      }
      if (entry.type === "dir") {
        assert(stat.isDirectory, `${entry.path} is a directory`);
        continue;
      }
      const got = await Deno.readFile(at);
      const want = entry.body ?? new Uint8Array(0);
      assert(
        got.byteLength === want.byteLength &&
          got.every((byte, index) => byte === want[index]),
        `${entry.path} reads back byte-identical ` +
          `(${got.byteLength} vs ${want.byteLength} bytes)`,
      );
    }
    // Nothing the tree did not declare — a stray entry means the free space
    // held something a reader could see.
    const listed = new Set(
      [...Deno.readDirSync(mount)]
        .map((e) => e.name)
        .filter((n) => n !== ".fseventsd" && n !== ".Spotlight-V100"),
    );
    const declared = new Set(
      TREE.filter((e) => !e.path.includes("/")).map((e) => e.path),
    );
    assert(
      listed.size === declared.size &&
        [...listed].every((n) => declared.has(n)),
      `the root holds exactly what was staged (found ${
        [...listed].join(", ")
      })`,
    );
  });
}

try {
  // --- The point of the exercise: a small ESP ---------------------------
  // vvfat's FAT16 geometry is fixed at 528450048 bytes whatever it holds, so
  // none of these three could exist before.
  await verify("esp-16MiB-fat12", 16 * 1024 * 1024, 12);
  await verify("esp-33MiB-fat16", 33 * 1024 * 1024, 16);
  await verify("esp-64MiB-fat32", 64 * 1024 * 1024, 32);

  // The size vvfat forced on every ESP, for comparison.
  await verify("esp-504MiB-fat16", 528_482_304, 16);

  // Whatever the writer picks unprompted must also satisfy every oracle.
  await verify("esp-48MiB-default", 48 * 1024 * 1024, undefined);

  // --- Both sides of both cluster-count boundaries -----------------------
  // A volume one cluster the wrong side of a threshold is one whose type
  // readers disagree about, so each of these is put to diskutil, which
  // determines the type from the BPB by itself.
  step("cluster-count boundaries: 4084/4085 and 65524/65525");
  await verify("boundary-fat12-max", 4141 * SECTOR_BYTES, 12, 4084);
  await verify("boundary-fat16-min", 4150 * SECTOR_BYTES, 16, 4085);
  await verify("boundary-fat16-max", 66_069 * SECTOR_BYTES, 16, 65_524);
  await verify("boundary-fat32-min", 66_581 * SECTOR_BYTES, 32, 65_525);

  // --- The smallest window that holds this tree --------------------------
  step("minimumFatSizeBytes names a size that builds");
  for (const fatType of [12, 16, 32] as const) {
    const size = minimumFatSizeBytes(fatEntryShapes(TREE), { fatType });
    const built = buildFat(TREE, { ...BASE, sizeBytes: size, fatType });
    assert(
      describeFat(built).fatType === fatType,
      `minimum FAT${fatType} window (${size} bytes) is FAT${fatType}`,
    );
    let refused = false;
    try {
      buildFat(TREE, { ...BASE, sizeBytes: size - SECTOR_BYTES, fatType });
    } catch {
      refused = true;
    }
    assert(refused, `one sector below the FAT${fatType} minimum is refused`);
    const image = `${dir}/min-fat${fatType}.img`;
    await Deno.writeFile(image, built);
    const fsck = await run("/sbin/fsck_msdos", ["-n", image]);
    assert(
      fsck.code === 0,
      `the minimum FAT${fatType} volume passes fsck_msdos ` +
        `(exit ${fsck.code})\n${fsck.out}`,
    );
    console.log(`  FAT${fatType} minimum: ${size} bytes`);
  }

  // --- Directories big enough to change the geometry ---------------------
  // A subdirectory outgrowing one cluster, and a FAT12/16 root outgrowing the
  // conventional 512 entries. Checked with fsck_msdos, which walks every
  // directory and every chain; not through a mount, for the fileid reason in
  // this module's header.
  step("directories that span multiple clusters");
  const many: FatEntry[] = [{ path: "deep", type: "dir", mtime: EPOCH }];
  for (let index = 0; index < 400; index++) {
    many.push({
      path: `a rather long file name number ${index}.config`,
      type: "file",
      mtime: EPOCH,
      body: encoder.encode(`root ${index}\n`),
    });
    many.push({
      path: `deep/another quite long name ${index}.data`,
      type: "file",
      mtime: EPOCH,
      body: encoder.encode(`deep ${index}\n`),
    });
  }
  for (const fatType of [12, 16, 32] as const) {
    const built = buildFat(many, {
      ...BASE,
      sizeBytes: 64 * 1024 * 1024,
      fatType,
    });
    const geometry = describeFat(built);
    if (fatType !== 32) {
      assert(
        geometry.rootEntryCount > 512,
        `FAT${fatType} root grew past 512 entries ` +
          `(got ${geometry.rootEntryCount})`,
      );
    }
    const image = `${dir}/many-fat${fatType}.img`;
    await Deno.writeFile(image, built);
    const fsck = await run("/sbin/fsck_msdos", ["-n", image]);
    assert(
      fsck.code === 0,
      `FAT${fatType} with 801 entries passes fsck_msdos ` +
        `(exit ${fsck.code})\n${fsck.out}${fsck.err}`,
    );
    console.log(
      `  FAT${fatType} rootEnt=${geometry.rootEntryCount} ` +
        `spc=${geometry.sectorsPerCluster} — fsck clean`,
    );
  }

  // --- Determinism -------------------------------------------------------
  step("two builds of the same input are byte-identical");
  for (const fatType of [12, 16, 32] as const) {
    const options = { ...BASE, sizeBytes: 64 * 1024 * 1024, fatType };
    const first = buildFat(TREE, options);
    const second = buildFat(TREE, options);
    assert(
      first.byteLength === second.byteLength &&
        first.every((byte, index) => byte === second[index]),
      `FAT${fatType} reproduces byte-for-byte`,
    );
  }

  // --- Oracle 3: qemu-img ------------------------------------------------
  step("qemu-img converts the volume to qcow2 and back unchanged");
  const raw = `${dir}/esp-33MiB-fat16.img`;
  const qcow = `${dir}/esp.qcow2`;
  const back = `${dir}/back.img`;
  assert(
    (await run("qemu-img", ["convert", "-O", "qcow2", raw, qcow])).code === 0,
    "qemu-img convert raw -> qcow2",
  );
  assert(
    (await run("qemu-img", ["convert", "-O", "raw", qcow, back])).code === 0,
    "qemu-img convert qcow2 -> raw",
  );
  const compare = await run("qemu-img", ["compare", raw, back]);
  assert(
    compare.code === 0,
    `qemu-img compare says identical (exit ${compare.code}: ${compare.out})`,
  );

  // --- The overlay hazard ------------------------------------------------
  // On a qcow2 overlay an unwritten cluster reads THROUGH to the backing file,
  // so a backing file of solid 0xDB makes any byte this writer left alone
  // visible.
  //
  // The reference volume is built fresh here rather than reusing one of the
  // images above. Measured: mounting a volume with `hdiutil` MODIFIES the
  // image file — macOS creates `.fseventsd` inside it — so an image that has
  // been attached is no longer this writer's output and cannot serve as a
  // byte-level reference.
  step("nothing reads through from a non-zero backing file");
  const junk = `${dir}/junk-backing.img`;
  const original = buildFat(TREE, {
    ...BASE,
    sizeBytes: 33 * 1024 * 1024,
    fatType: 16,
  });
  const pristine = `${dir}/pristine.img`;
  await Deno.writeFile(pristine, original);
  await Deno.writeFile(junk, new Uint8Array(original.byteLength).fill(0xdb));
  const overlay = `${dir}/overlay.qcow2`;
  assert(
    (await run("qemu-img", [
      "create",
      "-f",
      "qcow2",
      "-b",
      junk,
      "-F",
      "raw",
      overlay,
    ])).code === 0,
    "create an overlay over the 0xDB backing file",
  );
  // `-O qcow2` is load-bearing: without it qemu-img treats the destination as
  // raw, reads the qcow2 file's on-disk length as its virtual size, and fails
  // with "output file is smaller than input file".
  assert(
    (await run("qemu-img", [
      "convert",
      "-f",
      "raw",
      "-O",
      "qcow2",
      "-n",
      pristine,
      overlay,
    ])).code === 0,
    "splice the volume into the overlay",
  );
  const flat = `${dir}/flattened.img`;
  assert(
    (await run("qemu-img", ["convert", "-O", "raw", overlay, flat])).code === 0,
    "flatten the overlay",
  );
  const flattened = await Deno.readFile(flat);
  assert(
    flattened.byteLength === original.byteLength &&
      flattened.every((byte, index) => byte === original[index]),
    "the flattened overlay is the exact volume",
  );
  // A byte-count comparison rather than "zero 0xDB bytes": the file bodies are
  // pseudo-random, so roughly one byte in 256 of them is legitimately 0xDB.
  // Any read-through would push the flattened count ABOVE the source's.
  const count = (bytes: Uint8Array) =>
    bytes.reduce((total, byte) => total + (byte === 0xdb ? 1 : 0), 0);
  const before = count(original);
  const after = count(flattened);
  assert(
    after === before,
    `the volume's own 0xDB bytes are all that appear ` +
      `(${before} in the source, ${after} after flattening)`,
  );
  const fsckFlat = await run("/sbin/fsck_msdos", ["-n", flat]);
  assert(
    fsckFlat.code === 0,
    `the flattened overlay still passes fsck_msdos (exit ${fsckFlat.code})`,
  );

  // --- The overlay hazard, through the window build() actually uses ---------
  // The check above splices onto the whole overlay. `build()` splices through
  // a `raw` node with an offset and a size, which is a different qemu code
  // path and the one that ships — so it is checked separately, at a partition
  // offset, over a backing file whose every byte is 0xDB.
  step("…and through a `raw` window at a partition offset, as build() does");
  const PARTITION_AT = 1024 * 1024;
  const diskBytes = PARTITION_AT + original.byteLength + 1024 * 1024;
  const diskJunk = `${dir}/disk-junk.img`;
  await Deno.writeFile(diskJunk, new Uint8Array(diskBytes).fill(0xdb));
  const diskOverlay = `${dir}/disk-overlay.qcow2`;
  assert(
    (await run("qemu-img", [
      "create",
      "-f",
      "qcow2",
      "-b",
      diskJunk,
      "-F",
      "raw",
      diskOverlay,
    ])).code === 0,
    "create a disk-sized overlay over the 0xDB backing file",
  );
  const windowGraph = `driver=raw,offset=${PARTITION_AT},` +
    `size=${original.byteLength},file.driver=qcow2,` +
    `file.file.driver=file,file.file.filename=${diskOverlay}`;
  assert(
    (await run("qemu-img", [
      "convert",
      "-f",
      "raw",
      "-n",
      "-m",
      "1",
      "--target-image-opts",
      pristine,
      windowGraph,
    ])).code === 0,
    "splice the volume through the window",
  );
  const diskFlat = `${dir}/disk-flat.img`;
  assert(
    (await run("qemu-img", ["convert", "-O", "raw", diskOverlay, diskFlat]))
      .code === 0,
    "flatten the disk overlay",
  );
  const diskBytesOut = await Deno.readFile(diskFlat);
  const inWindow = diskBytesOut.subarray(
    PARTITION_AT,
    PARTITION_AT + original.byteLength,
  );
  assert(
    inWindow.byteLength === original.byteLength &&
      inWindow.every((byte, index) => byte === original[index]),
    "every byte of the window is the volume, with nothing read through",
  );
  // The window's zeros are the part at risk: qemu-img skips a zero run when it
  // believes the destination already reads as zero, and on an overlay it does
  // not. Counted explicitly rather than inferred from the compare above.
  const junkInWindow = inWindow.reduce(
    (total, byte, index) =>
      total + (byte === 0xdb && original[index] !== 0xdb ? 1 : 0),
    0,
  );
  assert(
    junkInWindow === 0,
    `no backing byte survives inside the window (found ${junkInWindow})`,
  );
  // And nothing outside the window was touched: a splice that overran would
  // have replaced the neighbouring 0xDB with the volume's bytes.
  assert(
    diskBytesOut.subarray(0, PARTITION_AT).every((byte) => byte === 0xdb) &&
      diskBytesOut.subarray(PARTITION_AT + original.byteLength)
        .every((byte) => byte === 0xdb),
    "the splice stayed inside the window",
  );
} finally {
  for (const device of attached) {
    console.error(`! detaching leaked device ${device}`);
    await run("hdiutil", ["detach", "-force", device]);
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  Deno.exit(1);
}
pass("every volume satisfied fsck_msdos, the Darwin driver and qemu-img");
