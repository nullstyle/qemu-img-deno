import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  APPLIANCE_ABI,
  APPLIANCE_INIT,
  type ApplianceIdentityRecord,
  copyInScript,
  DISK_SERIALS,
  diskArgs,
  framePayload,
  initDigest,
  mkfsScript,
  parseStatus,
  readApplianceIdentity,
  runScript,
  SECTOR,
  SERIAL_MAX_BYTES,
  StaleApplianceError,
  stepNonce,
  writeApplianceIdentity,
} from "../../src/system/mod.ts";
import type { CommandResult, CommandRunner } from "../../src/runner.ts";
import { sha256Hex } from "../../src/digest.ts";

const NONCE = "0123456789abcdef0123456789abcdef";

/**
 * A scratch directory under the repo, since `deno task test` grants write
 * access to `tests/.tmp` and nowhere else.
 *
 * `makeTempDir` does not create parents, and `tests/.tmp/` is gitignored and
 * untracked — so without the `mkdir` these tests pass only on a working tree
 * where some earlier run happened to leave the directory behind, and fail on
 * every fresh clone and every CI leg.
 */
async function scratchDir(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

function statusRecord(lines: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set(new TextEncoder().encode(`${lines.join("\n")}\n`));
  return bytes;
}

Deno.test("framePayload and parseStatus round-trip one step", () => {
  const framed = framePayload("echo hi\n", { nonce: NONCE });
  const header = new TextDecoder().decode(framed.subarray(0, SECTOR))
    .replace(/\0+$/, "");
  assertEquals(header, `QIMG2\n8\n${NONCE}\n`);
  // The script starts at byte 512 because a block device read returns whole
  // sectors; the explicit length is what lets the guest find its end.
  assertEquals(
    new TextDecoder().decode(framed.subarray(SECTOR, SECTOR + 8)),
    "echo hi\n",
  );
  assertEquals(framed.byteLength % SECTOR, 0);

  const outcome = parseStatus(
    statusRecord(["QIMG2", NONCE, "0", "step", "ab12", "0", "0", "0", "ok"]),
    { nonce: NONCE },
  );
  assertEquals(outcome, {
    code: 0,
    stage: "step",
    outputDigest: "ab12",
    umountRc: 0,
    fsckRc: 0,
    dmesgErrors: 0,
    detail: "ok",
  });
});

Deno.test("framePayload refuses a nonce that cannot survive the wire", () => {
  // The guest reads the nonce as a whole line of a header sector and compares
  // it to a kernel cmdline token. Neither survives a space.
  assertThrows(
    () => framePayload("x", { nonce: "has space" }),
    Error,
    "whitespace",
  );
  assertThrows(() => framePayload("x", { nonce: "" }), Error, "empty");
});

Deno.test("parseStatus names the rebuild for a QIMG1 record", () => {
  // The whole point of the frame version: a stale appliance is a DIFFERENT
  // failure from a guest that died, and it has a different fix.
  const error = assertThrows(
    () => parseStatus(statusRecord(["QIMG1", "0", "abc"]), { nonce: NONCE }),
    Error,
  );
  assertStringIncludes(error.message, "QIMG1");
  assertStringIncludes(error.message, "deno task appliance --arch=");
});

Deno.test("parseStatus refuses a record with no magic at all", () => {
  const error = assertThrows(
    () => parseStatus(new Uint8Array(4096), { nonce: NONCE }),
    Error,
  );
  assertStringIncludes(error.message, "no status record");
  // Must NOT be confused with the stale-appliance case.
  assert(!error.message.includes("QIMG1"));
});

Deno.test("parseStatus refuses a previous step's record", () => {
  // Shape-valid, fully parseable, and about a different boot. Only the nonce
  // can tell it apart, which is why a reused scratch disk is a hazard.
  const error = assertThrows(
    () =>
      parseStatus(
        statusRecord([
          "QIMG2",
          "deadbeef",
          "0",
          "step",
          "-",
          "0",
          "-",
          "0",
          "ok",
        ]),
        { nonce: NONCE },
      ),
    Error,
  );
  assertStringIncludes(error.message, "PREVIOUS step's answer");
});

Deno.test("parseStatus refuses a malformed exit code", () => {
  assertThrows(
    () =>
      parseStatus(
        statusRecord([
          "QIMG2",
          NONCE,
          "oops",
          "step",
          "-",
          "0",
          "-",
          "0",
          "ok",
        ]),
        { nonce: NONCE },
      ),
    Error,
    "malformed exit code",
  );
});

Deno.test("parseStatus keeps an unchecked filesystem distinct from a clean one", () => {
  // `-` means the step declared no filesystem to check. Flattening it to 0
  // would report "checked and clean" for a layer nothing ever checked.
  const outcome = parseStatus(
    statusRecord(["QIMG2", NONCE, "0", "step", "-", "0", "-", "0", "ok"]),
    { nonce: NONCE },
  );
  assertEquals(outcome.fsckRc, undefined);
  assertEquals(outcome.outputDigest, "");
});

Deno.test("stepNonce is deterministic and per (key, step)", async () => {
  const a = await stepNonce("realization-key", "table:mkfs");
  assertEquals(a, await stepNonce("realization-key", "table:mkfs"));
  assertNotEquals(a, await stepNonce("realization-key", "table"));
  assertNotEquals(a, await stepNonce("other-key", "table:mkfs"));
  assertMatch(a, /^[0-9a-f]{32}$/);
});

Deno.test("diskArgs attaches by identity, never by position", () => {
  const args = diskArgs({
    role: "payload",
    path: "/scratch/payload.raw",
    format: "raw",
  });
  assertEquals(args.filter((a) => a === "-blockdev").length, 2);
  assertEquals(args.filter((a) => a === "-device").length, 1);
  assertStringIncludes(
    args.join(" "),
    "virtio-blk-pci,drive=payload,serial=qimg-payload",
  );
  // Mixing spellings puts every -device disk at a lower PCI slot than every
  // if=virtio disk regardless of argv order — measured, and it made the guest
  // read the 1 GiB target as its payload.
  assert(!args.join(" ").includes("if=virtio"));
  assert(!args.join(" ").includes("-drive"));
  // 512 is the default and must stay silent, or every existing image would
  // acquire a block-size property it was not built with.
  assert(!args.join(" ").includes("logical_block_size"));
});

Deno.test("diskArgs declares a 4096-byte sector on both size fields", () => {
  const args = diskArgs({
    role: "target",
    path: "/scratch/image.qcow2",
    format: "qcow2",
    sectorSize: 4096,
  }).join(" ");
  assertStringIncludes(args, "logical_block_size=4096");
  assertStringIncludes(args, "physical_block_size=4096");
});

Deno.test("every disk serial fits VIRTIO_BLK_ID_BYTES", () => {
  // The guard in diskArgs is unreachable while DISK_SERIALS is what it is;
  // this asserts the property that keeps it unreachable. A truncated serial
  // resolves a role to zero disks, or to the wrong one.
  for (const serial of Object.values(DISK_SERIALS)) {
    assert(
      new TextEncoder().encode(serial).byteLength <= SERIAL_MAX_BYTES,
      `${serial} exceeds ${SERIAL_MAX_BYTES} bytes`,
    );
  }
});

Deno.test("mkfsScript emits every measured determinism flag", () => {
  const script = mkfsScript({
    fakeTimeEpoch: 1700000000,
    partitions: [{
      number: 2,
      startSectors512: 264192,
      sizeSectors512: 1832927,
      fsLabel: "root",
      uuid: "6A1C4E33-9F2B-4C81-A0D7-5E9B12F4A8C0",
      hashSeed: "B27F00A1-3D48-4E6A-9C15-7F82D4E60B39",
    }],
  });
  assertStringIncludes(script, "E2FSPROGS_FAKE_TIME=1700000000");
  assertStringIncludes(script, "-U 6A1C4E33-9F2B-4C81-A0D7-5E9B12F4A8C0");
  assertStringIncludes(
    script,
    "hash_seed=B27F00A1-3D48-4E6A-9C15-7F82D4E60B39",
  );
  assertStringIncludes(script, "-b 4096");
  assertStringIncludes(script, "-F");
  assertStringIncludes(script, "-L 'root'");
  // The sysfs cross-check: the one statement of partition location that
  // shares no code with src/fs/gpt.ts. A "rest" partition genuinely ends on
  // an odd sector count, so nothing may round it.
  assertStringIncludes(
    script,
    'qi_part "${QI_TARGET}2" "${QI_NAME}2" 264192 1832927',
  );
  assertStringIncludes(script, "/sys/class/block/$2/start");
  // Never the offset path: it does not bound the write, and a one-block error
  // there yields a filesystem blkid calls ext4 and the kernel will not mount.
  assert(!script.includes("-E offset="));
  // None of these exist in the appliance, and none are on the pinned ISO.
  for (const absent of ["/sbin/resize2fs", "sfdisk", "partx", "[["]) {
    assert(!script.includes(absent), `${absent} is not available in the guest`);
  }
});

Deno.test("mkfsScript passes 4096-byte-sector geometry through untouched", () => {
  // sysfs start/size are ALWAYS 512-byte units regardless of the logical
  // block size, so the caller converts (firstLba * sectorSize / 512) and this
  // builder must not re-scale. 2048 LBAs at 4096 bytes is 16384 sysfs sectors.
  const script = mkfsScript({
    fakeTimeEpoch: 0,
    partitions: [{
      number: 1,
      startSectors512: 2048 * 4096 / 512,
      sizeSectors512: 262144,
      fsLabel: "data",
      uuid: "A",
      hashSeed: "B",
    }],
  });
  assertStringIncludes(script, "16384 262144");
});

Deno.test("mkfsScript refuses an empty partition list", () => {
  assertThrows(
    () => mkfsScript({ fakeTimeEpoch: 0, partitions: [] }),
    Error,
    "no partitions",
  );
});

Deno.test("copyInScript and runScript mount by identity and by type", () => {
  const copy = copyInScript({ rootPartitionNumber: 2, to: "/opt/app" });
  const run = runScript({ rootPartitionNumber: 2, script: "apk info\n" });
  for (const script of [copy, run]) {
    // busybox mount cannot autodetect ext4 in this initramfs: a bare
    // `mount <dev>` fails with ENOENT (rc 255) on a good filesystem.
    assertStringIncludes(script, 'mount -t ext4 "$1" /mnt/root');
    // Roles come from $QI_TARGET, which /init resolved by serial. A literal
    // /dev/vdX would be a position, and positions move.
    assert(!script.includes("/dev/vd"));
  }
  assertStringIncludes(copy, "tar -xf \"$QI_DATA\" -C '/mnt/root/opt/app'");
  assertStringIncludes(copy, "mkdir -p '/mnt/root/opt/app'");
  assertStringIncludes(run, "export QI_ROOT");
  assertStringIncludes(run, "apk info");
  // run does NOT chroot: the failure names /bin/busybox rather than the
  // missing /lib/ld-musl-<arch>.so.1 that actually caused it.
  assert(!run.includes("chroot"));
});

Deno.test("the root mount is preflighted before the filesystem is touched", () => {
  const copy = copyInScript({ rootPartitionNumber: 2, to: "/opt/app" });
  const run = runScript({ rootPartitionNumber: 2, script: "apk info\n" });
  for (const script of [copy, run]) {
    // Both checks exist for `base.kind: "image"`, where the table came with
    // the image and there is no planned geometry to compare it against.
    assertStringIncludes(script, "exit 68"); // node never appeared
    assertStringIncludes(script, "exit 69"); // no filesystem at all
    assertStringIncludes(script, "exit 70"); // some other filesystem
    // The declared number reaches the message, so a wrong `rootPartition`
    // reads as a recipe mistake rather than as a mount(2) errno.
    assertStringIncludes(script, 'qi_mount_root "${QI_TARGET}2" 2');
    assertStringIncludes(script, "base.rootPartition");

    // busybox blkid takes `[BLOCKDEV]...` and NOTHING else: it accepts
    // `-s TYPE -o value` silently and prints the whole line anyway, so the
    // util-linux spelling would compare a full `dev: LABEL=… TYPE="ext4"`
    // line against `ext4` and reject a perfectly good root.
    assert(!script.includes("-s TYPE"), "no util-linux blkid flags");
    assert(!script.includes("-o value"), "no util-linux blkid flags");
    assertStringIncludes(script, 'blkid "$1"');

    // Ordering is the whole point of the check: registering the device for
    // /init's `e2fsck -fn` epilogue before knowing it is ext also ran the
    // checker over a FAT partition, burying the real cause under twelve lines
    // of superblock recovery advice.
    const typeCheck = script.indexOf('case "$_t" in');
    const register = script.indexOf("/qi/fsck-devs");
    const mount = script.indexOf('mount -t ext4 "$1"');
    assert(typeCheck >= 0 && register >= 0 && mount >= 0);
    assert(typeCheck < register, "blkid runs before fsck-devs is appended");
    assert(register < mount, "and both run before the mount");
  }
  // ext2 and ext3 are accepted because the ext4 driver mounts them — measured
  // in the appliance, both at rc 0, both showing as `ext4` in /proc/mounts.
  assertStringIncludes(copy, "ext2|ext3|ext4)");
});

Deno.test("a failed copyIn extraction reports the filesystem's fullness", () => {
  const copy = copyInScript({ rootPartitionNumber: 2, to: "/opt/app" });
  // busybox tar says only `tar: write error: No space left on device`, which
  // names neither the filesystem nor how full it was. Alpine's aarch64 cloud
  // image ships its root 89% full, so this is the likeliest copyIn failure
  // against an existing base.
  assertStringIncludes(copy, "df -k /mnt/root");
  assertStringIncludes(copy, "exit 71");
  // Diagnosis, never a guard: the archive's byte count is not the space it
  // occupies once ext4 rounds each file up to a block, so a size precheck
  // would refuse builds that fit.
  assert(!copy.includes("QI_TAR_BYTES"), "no size precheck");
});

Deno.test("APPLIANCE_INIT carries the three wire tripwires", async () => {
  // A newer host meeting an older /init is exactly the skew that otherwise
  // builds a wrong image, so an unknown qi.* argument must be fatal.
  assertStringIncludes(APPLIANCE_INIT, 'qi.*)         QI_BAD="$arg"');
  // ext4 is a MODULE in this kernel; before it loads /proc/filesystems holds
  // no block filesystem at all and mount fails on a perfect image.
  assertStringIncludes(APPLIANCE_INIT, "virtio_blk ext4; do modprobe");
  assertStringIncludes(APPLIANCE_INIT, "ext4-not-registered");
  assertStringIncludes(APPLIANCE_INIT, "QIMG2");
  assertStringIncludes(APPLIANCE_INIT, "abi-mismatch:want-2-got-");
  // The status record is fsynced because kernel_power_off() does not sync.
  assertStringIncludes(APPLIANCE_INIT, "conv=fsync");
  // Never `set -o pipefail`: `set` is a special builtin in busybox ash, so a
  // failed `set -o badopt` exits the shell and `|| :` does not save it.
  assert(!APPLIANCE_INIT.includes("pipefail"));
  assertEquals(await initDigest(), await sha256Hex(APPLIANCE_INIT));
});

/** A runner that answers `--version` and nothing else. */
const fakeQemu: CommandRunner = {
  run(): Promise<CommandResult> {
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: "QEMU emulator version 11.0.2\nCopyright…",
      stderr: "",
    });
  },
};

/** Lay down a complete, self-consistent fake appliance under `dir`. */
async function fakeAppliance(dir: string): Promise<ApplianceIdentityRecord> {
  const work = `${dir}/aarch64`;
  await Deno.mkdir(`${work}/boot`, { recursive: true });
  await Deno.writeTextFile(`${work}/boot/vmlinuz-virt`, "kernel");
  await Deno.writeTextFile(`${work}/appliance.cpio.gz`, "initrd");
  await Deno.writeTextFile(`${dir}/lock.json`, "{}");
  const record: ApplianceIdentityRecord = {
    abi: APPLIANCE_ABI,
    arch: "aarch64",
    kernelSha256: await sha256Hex("kernel"),
    initrdSha256: await sha256Hex("initrd"),
    initSha256: await initDigest(),
    lockSha256: await sha256Hex("{}"),
    kernelRelease: "6.12.81-0-virt",
    packages: ["e2fsprogs-1.47.1-r1.apk"],
    machine: "virt",
  };
  await writeApplianceIdentity(work, record);
  return record;
}

Deno.test("readApplianceIdentity verifies and digests a matching appliance", async () => {
  const dir = await scratchDir();
  try {
    await fakeAppliance(dir);
    const identity = await readApplianceIdentity({
      root: dir,
      arch: "aarch64",
      lockPath: `${dir}/lock.json`,
      qemu: fakeQemu,
    });
    // The qemu version is probed, not stored: `machine: "virt"` is an
    // unversioned alias that moves device enumeration across a qemu upgrade.
    assertEquals(identity.qemuSystemVersion, "QEMU emulator version 11.0.2");
    assertMatch(identity.digest, /^[0-9a-f]{64}$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a missing appliance.json is itself staleness", async () => {
  const dir = await scratchDir();
  try {
    const error = await assertRejects(
      () =>
        readApplianceIdentity({ root: dir, arch: "aarch64", qemu: fakeQemu }),
      StaleApplianceError,
    );
    // The signal for an appliance built before identities existed.
    assertEquals(error.field, "missing");
    assertStringIncludes(error.message, "deno task appliance --arch=aarch64");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an edited /init is caught before anything boots", async () => {
  const dir = await scratchDir();
  try {
    const record = await fakeAppliance(dir);
    // Exactly the skew that otherwise builds a wrong image in silence: the
    // source /init moved and nobody rebuilt.
    await writeApplianceIdentity(`${dir}/aarch64`, {
      ...record,
      initSha256: "0".repeat(64),
    });
    const error = await assertRejects(
      () =>
        readApplianceIdentity({
          root: dir,
          arch: "aarch64",
          lockPath: `${dir}/lock.json`,
          qemu: fakeQemu,
        }),
      StaleApplianceError,
    );
    assertEquals(error.field, "init");
    assertEquals(error.expected, await initDigest());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a bumped wire ABI invalidates the appliance", async () => {
  const dir = await scratchDir();
  try {
    const record = await fakeAppliance(dir);
    await writeApplianceIdentity(`${dir}/aarch64`, { ...record, abi: 1 });
    const error = await assertRejects(
      () =>
        readApplianceIdentity({
          root: dir,
          arch: "aarch64",
          lockPath: `${dir}/lock.json`,
          qemu: fakeQemu,
        }),
      StaleApplianceError,
    );
    assertEquals(error.field, "abi");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a truncated kernel is caught, and moves the digest", async () => {
  const dir = await scratchDir();
  try {
    await fakeAppliance(dir);
    await Deno.writeTextFile(`${dir}/aarch64/boot/vmlinuz-virt`, "trunc");
    const error = await assertRejects(
      () =>
        readApplianceIdentity({
          root: dir,
          arch: "aarch64",
          lockPath: `${dir}/lock.json`,
          qemu: fakeQemu,
        }),
      StaleApplianceError,
    );
    assertEquals(error.field, "kernel");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
