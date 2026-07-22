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
  ApplianceGuestRunner,
  type ApplianceIdentity,
  type ApplianceIdentityRecord,
  copyInScript,
  DISK_SERIALS,
  diskArgs,
  framePayload,
  fsckVerdict,
  GuestBootError,
  GuestStatusError,
  GuestStepFailedError,
  GuestTimeoutError,
  initDigest,
  InvalidGuestDnsError,
  mkfsScript,
  parseStatus,
  PayloadFrameError,
  readApplianceIdentity,
  runScript,
  SECTOR,
  SERIAL_MAX_BYTES,
  StaleApplianceError,
  stepNonce,
  type StepOutcome,
  writeApplianceIdentity,
} from "../../src/system/mod.ts";
import {
  CommandAbortedError,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
} from "../../src/runner.ts";
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
    PayloadFrameError,
    "whitespace",
  );
  assertThrows(
    () => framePayload("x", { nonce: "" }),
    PayloadFrameError,
    "empty",
  );
  // A glob metacharacter is refused for a second reason: /init parses the
  // cmdline with `for arg in $(cat /proc/cmdline)`, an unquoted expansion, so
  // the token is matched against the guest's root before it is ever compared.
  for (const nonce of ["ab*", "a?b", "a[bc]"]) {
    const error = assertThrows(
      () => framePayload("x", { nonce }),
      PayloadFrameError,
    );
    assertEquals(error.fault, "nonce");
  }
});

Deno.test("payload framing faults are typed, not just worded", () => {
  // `instanceof` is the only honest way to tell a framing refusal — raised
  // before anything boots — from a guest that ran and failed.
  const tooBig = assertThrows(
    () => framePayload("x".repeat(600), { nonce: NONCE, sizeBytes: SECTOR }),
    PayloadFrameError,
  );
  assertEquals(tooBig.fault, "script");
  const wideNonce = assertThrows(
    () => framePayload("x", { nonce: "n".repeat(SECTOR) }),
    PayloadFrameError,
  );
  assertEquals(wideNonce.fault, "header");
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

/** A clean, fully-populated outcome to vary one field at a time. */
const CLEAN: StepOutcome = {
  code: 0,
  stage: "step",
  outputDigest: "ab12",
  umountRc: 0,
  fsckRc: 0,
  dmesgErrors: 0,
  detail: "ok",
};

Deno.test("fsckVerdict gives the unchecked case its own answer", () => {
  // The parse has always been right — `fsckRc` is `undefined` for `fsck=-`.
  // It is the CONSUMPTION that failed open: `(outcome.fsckRc ?? 0) !== 0`
  // reads "nobody looked" as "looked and it was clean", so a guest that
  // registered no device publishes as verified. Routing the decision through
  // a three-valued verdict is what makes that unspellable by accident.
  assertEquals(fsckVerdict(CLEAN), "clean");
  assertEquals(fsckVerdict({ ...CLEAN, fsckRc: 4 }), "failed");
  const { fsckRc: _dropped, ...unchecked } = CLEAN;
  assertEquals(fsckVerdict(unchecked), "unchecked");
  // Measured, not hypothetical: a trivial `run` step that never mounts the
  // target comes back `fsck=-` from the real appliance.
  assertEquals(
    fsckVerdict(
      parseStatus(
        statusRecord(["QIMG2", NONCE, "0", "step", "-", "0", "-", "0", "ok"]),
        { nonce: NONCE },
      ),
    ),
    "unchecked",
  );
});

Deno.test("GuestStepFailedError names an unchecked filesystem as its own fault", () => {
  const { fsckRc: _dropped, ...unchecked } = CLEAN;
  const error = new GuestStepFailedError("app", unchecked, "console text");
  // Never "e2fsck -fn returned 0" — that claims a check that never ran.
  assert(!error.message.includes("e2fsck -fn returned"));
  assertStringIncludes(error.message, "no filesystem was ever checked");
  assertStringIncludes(error.message, "console text");
  // And a real failure still reads exactly as it did before.
  const failed = new GuestStepFailedError("app", { ...CLEAN, fsckRc: 4 }, "");
  assertStringIncludes(failed.message, "e2fsck -fn returned 4");
  assert(!failed.message.includes("no filesystem was ever checked"));
});

Deno.test("every parseStatus refusal is typed and carries the console", () => {
  // The console is the ONLY diagnostic when the record says nothing — and one
  // of these faults cannot produce a record at all, since an /init that
  // resolves its status role to zero disks has nowhere to write one.
  const consoleText = "appliance: status role 'qimg-status' resolved to zero";
  const cases: readonly [string, readonly string[]][] = [
    ["legacy", ["QIMG1", "0", "abc"]],
    ["absent", ["nothing here"]],
    ["nonce", ["QIMG2", "deadbeef", "0", "step", "-", "0", "-", "0", "ok"]],
    ["code", ["QIMG2", NONCE, "oops", "step", "-", "0", "-", "0", "ok"]],
    ["stage", ["QIMG2", NONCE, "0", "nowhere", "-", "0", "-", "0", "ok"]],
    ["field", ["QIMG2", NONCE, "0", "step", "-", "x", "-", "0", "ok"]],
  ];
  for (const [fault, lines] of cases) {
    const error = assertThrows(
      () =>
        parseStatus(statusRecord(lines), {
          nonce: NONCE,
          console: consoleText,
          consolePath: "/kept/console.log",
        }),
      GuestStatusError,
    );
    assertEquals(error.fault, fault);
    // Attached, not discarded: this is the whole point.
    assertEquals(error.console, consoleText);
    assertStringIncludes(error.message, consoleText);
    assertStringIncludes(error.message, "/kept/console.log");
    // `reason` is the message WITHOUT the console, so a caller that only
    // obtains the console after catching can rebuild rather than wrap.
    assert(!error.reason.includes(consoleText));
  }
  const field = assertThrows(
    () =>
      parseStatus(
        statusRecord(["QIMG2", NONCE, "0", "step", "-", "0", "-", "z", "ok"]),
        { nonce: NONCE },
      ),
    GuestStatusError,
  );
  assertEquals(field.field, "dmesgErrors");
  // Absent console must not leave a dangling header.
  assert(!field.message.includes("console below"));
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

Deno.test("only the step script reports stage 'step', so its codes stay its own", () => {
  // The 90–101 band is documented as colliding with a user script's own exit
  // codes and being disambiguated by `stage`. That claim is only true while
  // `finish "$RC" step` is the ONLY call reporting that stage — assert the
  // property rather than trusting the comment that describes it.
  const calls = [
    ...APPLIANCE_INIT.matchAll(/^\s*.*?finish ("\$RC"|\d+) (\w+)/gm),
  ]
    .map((m) => ({ code: m[1], stage: m[2] }));
  assert(calls.length >= 11, `found ${calls.length} finish calls`);
  const atStep = calls.filter((c) => c.stage === "step");
  assertEquals(atStep.length, 1, "exactly one call reports stage 'step'");
  assertEquals(atStep[0].code, '"$RC"', "and it carries the script's own rc");
  for (const call of calls) {
    if (call.code === '"$RC"') continue;
    const code = Number(call.code);
    assert(code >= 91 && code <= 101, `${code} is inside the reserved band`);
    assert(
      call.stage !== "step",
      `finish ${code} must not report stage step, or it collides`,
    );
  }
  // 90 was documented as "payload device never appeared" and never emitted;
  // that case is 98 roles, like every other role that will not bind.
  assert(!calls.some((c) => c.code === "90"), "90 is not emitted");
  assertStringIncludes(APPLIANCE_INIT, "payload-unresolved:");
});

Deno.test("APPLIANCE_INIT does not fail open on the two unchecked writes", () => {
  // Both were reachable and silent. A step that runs unplugged, or one whose
  // script never reached the shell, exited 0 and published a layer.
  //
  // The network is a role the HOST declared, so a failure to bind it is fatal
  // at the same stage as a disk role — nothing here runs under `set -e`.
  for (const fatal of ["link-up", "addr-add", "route-add", "resolv-conf"]) {
    assertStringIncludes(
      APPLIANCE_INIT,
      `finish 91 roles - "network-unconfigured:${fatal}"`,
    );
  }
  // Bound before the payload read, so the reported stage never goes backwards.
  assert(
    APPLIANCE_INIT.indexOf("network-unconfigured") <
      APPLIANCE_INIT.indexOf("bad-payload-magic"),
    "the network role binds with the other roles",
  );
  // /qi/run.sh is length-checked the same way the payload read is: a tmpfs
  // that is full makes the redirection fail, and a truncated run.sh runs,
  // exits 0, and publishes a layer for a step that never executed.
  assertStringIncludes(APPLIANCE_INIT, "run-script-truncated:");
  assertStringIncludes(APPLIANCE_INIT, "WANT=$((PRE + LEN))");
  // Derived from the prefix on disk, never a hardcoded 8, so editing
  // `set -eu` cannot leave the check silently comparing the wrong number.
  assertStringIncludes(APPLIANCE_INIT, "PRE=$(wc -c < /qi/prefix.sh)");
});

/**
 * Whether this process may boot a real x86_64 guest.
 *
 * `deno task test` grants `--allow-run=echo,cat,false,sleep,sh` and reads only
 * `tests`, so these skip there and run under `deno test -A`, which is how the
 * cross-arch appliance gets exercised at all — it has no smoke of its own.
 */
const CAN_BOOT_X86 = await (async () => {
  const run = await Deno.permissions.query({
    name: "run",
    command: "qemu-system-x86_64",
  });
  const read = await Deno.permissions.query({ name: "read", path: "." });
  const write = await Deno.permissions.query({ name: "write", path: "." });
  if (run.state !== "granted" || read.state !== "granted") return false;
  if (write.state !== "granted") return false;
  return await Deno.stat(".appliance/x86_64/appliance.json")
    .then(() => true).catch(() => false);
})();

Deno.test({
  name: "the x86_64 appliance boots and answers on the same wire",
  ignore: !CAN_BOOT_X86,
  fn: async () => {
    // The cross-arch appliance had no automated coverage at all. It runs under
    // TCG — measured 2.7s for a trivial step against 254ms on aarch64, about
    // 10x — so one boot is affordable and nothing more is attempted here.
    const identity = await readApplianceIdentity({ arch: "x86_64" });
    assertEquals(identity.arch, "x86_64");
    // q35, not virt: the console device differs with it, and a wrong console
    // yields an empty log rather than a failure.
    assertEquals(identity.machine, "q35");
    const dir = await scratchDir();
    try {
      const guest = new ApplianceGuestRunner({
        identity,
        consoleDir: `${dir}/kept`,
      });
      const image = `${dir}/image.qcow2`;
      await new Deno.Command("qemu-img", {
        args: ["create", "-f", "qcow2", image, "64M"],
        stdout: "null",
        stderr: "null",
      }).output();
      const result = await guest.run({
        stepId: "x86-smoke",
        imagePath: image,
        script: 'echo "MARK $(uname -m)"\ntest -b "$QI_TARGET"\n',
        nonce: await stepNonce("x86-smoke", "trivial"),
        scratchDir: dir,
      });
      assertEquals(result.outcome.code, 0, result.console);
      assertEquals(result.outcome.stage, "step");
      // The target resolved by SERIAL on a machine whose disk enumeration is
      // nothing like virt's — the property the whole devices.ts design exists
      // for, and it had never been exercised on q35.
      assertStringIncludes(result.console, "MARK x86_64");
      assertEquals(result.outcome.umountRc, 0);
      assertEquals(result.outcome.dmesgErrors, 0);
      // A step that mounts nothing registers no device, so it is genuinely
      // unchecked rather than checked-and-clean.
      assertEquals(fsckVerdict(result.outcome), "unchecked");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** An identity good enough to construct a runner; nothing here boots it. */
const FAKE_IDENTITY: ApplianceIdentity = {
  abi: APPLIANCE_ABI,
  arch: "aarch64",
  kernelSha256: "0".repeat(64),
  initrdSha256: "0".repeat(64),
  initSha256: "0".repeat(64),
  lockSha256: "0".repeat(64),
  kernelRelease: "6.12.81-0-virt",
  packages: [],
  machine: "virt",
  qemuSystemVersion: "QEMU emulator version 11.0.2",
  digest: "0".repeat(64),
};

/** The `-serial file:PATH` the runner emitted, so a fake can write to it. */
function serialPath(args: readonly string[]): string {
  const at = args.indexOf("-serial");
  return args[at + 1]?.replace(/^file:/, "") ?? "";
}

Deno.test("a guest step's deadline is settable per step", async () => {
  // A 200ms mkfs and an apk install over slirp cannot share one number: set
  // it for the slow step and a hung fast one burns the whole deadline first.
  const seen: number[] = [];
  const runner: CommandRunner = {
    run(_bin, args, options?: RunOptions): Promise<CommandResult> {
      seen.push(options?.timeoutMs ?? -1);
      return Promise.reject(new CommandAbortedError("qemu", args));
    },
  };
  const dir = await scratchDir();
  const guest = new ApplianceGuestRunner({
    identity: FAKE_IDENTITY,
    runner,
    timeoutMs: 111,
    consoleDir: `${dir}/kept`,
  });
  try {
    const request = {
      stepId: "table:mkfs",
      imagePath: `${dir}/image.qcow2`,
      script: "echo hi\n",
      nonce: NONCE,
      scratchDir: dir,
    };
    await assertRejects(() => guest.run(request), GuestTimeoutError);
    await assertRejects(
      () => guest.run({ ...request, timeoutMs: 999 }),
      GuestTimeoutError,
    );
    assertEquals(seen, [111, 999]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the deadline message states what is known, and no more", async () => {
  const runner: CommandRunner = {
    run(_bin, args): Promise<CommandResult> {
      return Promise.reject(new CommandAbortedError("qemu", args));
    },
  };
  const dir = await scratchDir();
  try {
    const guest = new ApplianceGuestRunner({
      identity: FAKE_IDENTITY,
      runner,
      timeoutMs: 250,
      consoleDir: `${dir}/kept`,
    });
    const error = await assertRejects(
      () =>
        guest.run({
          stepId: "slow",
          imagePath: `${dir}/image.qcow2`,
          script: "echo hi\n",
          nonce: NONCE,
          scratchDir: dir,
        }),
      GuestTimeoutError,
    );
    assertEquals(error.timeoutMs, 250);
    assertStringIncludes(error.message, "did not power off within 250ms");
    // It asserted "it hung" before, which the host cannot possibly know: a
    // panic before the epilogue and work that was merely slow look identical.
    assert(!error.message.includes("it hung"));
    assertStringIncludes(error.message, "a hang, a panic");
    assertStringIncludes(error.message, "timeoutMs");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the console outlives the scratch dir the error used to point into", async () => {
  // appliance.ts wrote the console into the layer's `.partial`, and `build()`
  // calls `store.abandon()` on failure — which removes that directory. So the
  // error named a file that was already gone by the time anyone read it.
  const dir = await scratchDir();
  try {
    const scratch = `${dir}/partial`;
    await Deno.mkdir(scratch);
    const runner: CommandRunner = {
      async run(_bin, args): Promise<CommandResult> {
        await Deno.writeTextFile(
          serialPath(args),
          "appliance: running 8-byte step script\nBUG: kernel NULL deref\n",
        );
        throw new CommandAbortedError("qemu", args);
      },
    };
    const guest = new ApplianceGuestRunner({
      identity: FAKE_IDENTITY,
      runner,
      timeoutMs: 10,
      consoleDir: `${dir}/kept`,
    });
    const error = await assertRejects(
      () =>
        guest.run({
          stepId: "table:mkfs",
          imagePath: `${scratch}/image.qcow2`,
          script: "echo hi\n",
          nonce: NONCE,
          scratchDir: scratch,
        }),
      GuestTimeoutError,
    );
    // What build() does next, and the whole reason this test exists.
    await Deno.remove(scratch, { recursive: true });

    assert(error.consolePath !== undefined, "a copy was kept");
    assertStringIncludes(error.message, error.consolePath);
    assertEquals(
      await Deno.readTextFile(error.consolePath),
      "appliance: running 8-byte step script\nBUG: kernel NULL deref\n",
    );
    // The `:` in a step id has to survive reaching a filename.
    assertStringIncludes(error.consolePath, "table_mkfs");
    // And the text is in the message too, so a log with no filesystem still
    // carries the diagnosis.
    assertStringIncludes(error.message, "BUG: kernel NULL deref");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a status-record failure keeps the console it used to discard", async () => {
  // The console was read one line before parseStatus and then dropped exactly
  // where it was the only account of the boot — an /init that cannot resolve
  // its status disk writes no record at all and says why here and nowhere else.
  const dir = await scratchDir();
  try {
    const scratch = `${dir}/partial`;
    await Deno.mkdir(scratch);
    const runner: CommandRunner = {
      async run(_bin, args): Promise<CommandResult> {
        await Deno.writeTextFile(
          serialPath(args),
          "appliance: status role 'qimg-status' resolved to zero or many disks\n",
        );
        return { success: true, code: 0, stdout: "", stderr: "" };
      },
    };
    const guest = new ApplianceGuestRunner({
      identity: FAKE_IDENTITY,
      runner,
      consoleDir: `${dir}/kept`,
    });
    const error = await assertRejects(
      () =>
        guest.run({
          stepId: "app",
          imagePath: `${scratch}/image.qcow2`,
          script: "echo hi\n",
          nonce: NONCE,
          scratchDir: scratch,
        }),
      GuestStatusError,
    );
    await Deno.remove(scratch, { recursive: true });
    assertEquals(error.fault, "absent");
    assertStringIncludes(error.message, "the guest wrote no status record");
    assertStringIncludes(error.message, "resolved to zero or many disks");
    assert(error.consolePath !== undefined, "a copy was kept");
    assertStringIncludes(
      await Deno.readTextFile(error.consolePath),
      "resolved to zero or many disks",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a qemu that never booted is its own typed failure", async () => {
  const dir = await scratchDir();
  try {
    const runner: CommandRunner = {
      run(): Promise<CommandResult> {
        return Promise.resolve({
          success: false,
          code: 1,
          stdout: "",
          stderr: "qemu-system-aarch64: -M virt-99: unsupported machine type",
        });
      },
    };
    const guest = new ApplianceGuestRunner({ identity: FAKE_IDENTITY, runner });
    const error = await assertRejects(
      () =>
        guest.run({
          stepId: "app",
          imagePath: `${dir}/image.qcow2`,
          script: "echo hi\n",
          nonce: NONCE,
          scratchDir: dir,
        }),
      GuestBootError,
    );
    assertEquals(error.code, 1);
    // Not a step failure, and not a hang: the one case where qemu's own exit
    // code IS the answer, and its stderr is the only place that says why.
    assertStringIncludes(error.message, "the VM never started");
    assertStringIncludes(error.message, "unsupported machine type");
    assertStringIncludes(error.stderr, "unsupported machine type");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("network.dns is validated before it can reach a cmdline", () => {
  // It rides the kernel cmdline beside the nonce, which has always been
  // validated. A value with a space does not fail — it silently changes the
  // arguments the guest parses.
  for (
    const dns of [
      "8.8.8.8 qi.abi=99",
      "",
      "not-an-ip",
      "8.8.8",
      "8.8.8.8.8",
      "256.1.1.1",
      "010.1.1.1",
      "2001:4860:4860::8888",
      "8.8.8.8\n",
    ]
  ) {
    const error = assertThrows(
      () =>
        new ApplianceGuestRunner({
          identity: FAKE_IDENTITY,
          network: { dns },
        }),
      InvalidGuestDnsError,
    );
    assertEquals(error.dns, dns);
  }
  // And the shapes that do reach a guest are accepted.
  for (const dns of ["8.8.8.8", "1.1.1.1", "10.0.2.3", "0.0.0.0"]) {
    new ApplianceGuestRunner({ identity: FAKE_IDENTITY, network: { dns } });
  }
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
