/**
 * Real-appliance smoke for `./system`: builds a GPT + FAT ESP + ext4 root
 * image end to end, through both executors, and checks it with oracles that
 * share no code with this package.
 *
 *     deno task smoke:system
 *
 * Skips cleanly when no appliance has been built, the way `smoke:recipe` does.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import {
  build,
  defineRecipe,
  dir,
  LayerStore,
  LocalInputResolver,
  plan,
  resolveRecipe,
  VVFAT_USABLE_BYTES,
} from "../src/recipe/mod.ts";
import {
  ApplianceGuestRunner,
  readApplianceIdentity,
  StaleApplianceError,
} from "../src/system/mod.ts";
import { GuestExecutorUnavailableError } from "../src/recipe/errors.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

/**
 * Fail the smoke by THROWING, never by `Deno.exit`.
 *
 * `Deno.exit` skips every pending `finally`, so a failed assertion between
 * `hdiutil attach` and its detach would leave the device attached — which is
 * exactly what happened the first time this smoke failed.
 */
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const ARCH = "aarch64";
const qemu = new QemuImg();
if (!(await qemu.available())) {
  skip("qemu-img not installed — smoke skipped");
  Deno.exit(0);
}
if (!(await Deno.stat(`.appliance/${ARCH}/appliance.json`).catch(() => null))) {
  skip(`no ${ARCH} appliance — run: deno task appliance --arch=${ARCH}`);
  Deno.exit(0);
}

const work = await Deno.makeTempDir({ prefix: "qemu-img-system-smoke-" });
const DISK_BYTES = 2 * 1024 * 1024 * 1024;
const FS_SEED = "smoke/system/v1";
let failed = false;

try {
  step("read and verify the appliance identity");
  const identity = await readApplianceIdentity({ arch: ARCH });
  assert(identity.abi === 2, `ABI 2 (got ${identity.abi})`);
  pass(
    `appliance ${identity.digest.slice(0, 16)}… (${identity.kernelRelease})`,
  );

  step("a tampered appliance.json is refused, not trusted");
  const identityPath = `.appliance/${ARCH}/appliance.json`;
  const original = await Deno.readTextFile(identityPath);
  await Deno.writeTextFile(
    identityPath,
    original.replace(/"initSha256": "./, '"initSha256": "0'),
  );
  let staleCaught = false;
  try {
    await readApplianceIdentity({ arch: ARCH });
  } catch (error) {
    staleCaught = error instanceof StaleApplianceError;
  }
  await Deno.writeTextFile(identityPath, original);
  assert(staleCaught, "an edited /init digest raises StaleApplianceError");
  pass("staleness tripwire caught the edit");

  step("stage an ESP tree and a copyIn tree with awkward-but-legal content");
  const esp = `${work}/esp`;
  await Deno.mkdir(`${esp}/EFI/BOOT`, { recursive: true });
  await Deno.writeTextFile(`${esp}/EFI/BOOT/BOOTAA64.EFI`, "MZ not-real\n");

  const app = `${work}/app`;
  await Deno.mkdir(`${app}/a/b/c/d`, { recursive: true });
  await Deno.writeTextFile(`${app}/a/b/c/d/deep.txt`, "deep\n");
  await Deno.writeTextFile(`${app}/has space.txt`, "spaced\n");
  await Deno.writeTextFile(`${app}/exe.sh`, "#!/bin/sh\necho hi\n");
  await Deno.chmod(`${app}/exe.sh`, 0o755);
  // The 120-character final component: the one path in the ustar writer that
  // takes the GNU 'L' branch, and the one combination the probes never ran in
  // the guest (busybox was measured against a GNU-magic archive; ours is
  // POSIX-magic). If this survives, that caveat is retired.
  const longName = `${"z".repeat(120)}.txt`;
  await Deno.writeTextFile(`${app}/${longName}`, "long\n");
  const big = new Uint8Array(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  await Deno.writeFile(`${app}/big3m.bin`, big);

  const recipe = defineRecipe({
    name: "system-smoke",
    platform: { arch: ARCH, machine: "virt-11.0" },
    base: { kind: "blank", sizeBytes: DISK_BYTES },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: FS_SEED,
      fsSeed: FS_SEED,
    },
    steps: [
      {
        kind: "partition",
        id: "table",
        partitions: [
          {
            label: "EFI",
            type: "esp",
            size: VVFAT_USABLE_BYTES[16],
            contents: {
              kind: "fat",
              fatType: 16,
              label: "EFI",
              from: dir(esp),
            },
          },
          {
            label: "root",
            type: "linux-root",
            size: "rest",
            contents: { kind: "ext4", label: "root" },
          },
        ],
      },
      { kind: "copyIn", id: "app", from: dir(app), to: "/opt/app" },
    ],
  });

  const resolved = await resolveRecipe(recipe, {
    resolver: new LocalInputResolver(),
  });
  const planned = await plan(resolved, { appliance: identity });
  assert(planned.requiresAppliance, "this recipe needs the guest");
  assert(
    planned.steps.map((s) => s.id).join(",") ===
      "base,table,table:mkfs,app",
    `four layers, split at the boundary (got ${
      planned.steps.map((s) => s.id).join(",")
    })`,
  );
  pass(`planned:\n${planned.explain()}`);

  step("without a guest runner, the host-side layers still build and publish");
  const coldStore = new LayerStore(`${work}/cache-partial`);
  let refused: unknown;
  try {
    await build(planned, resolved, {
      store: coldStore,
      output: `${work}/partial.qcow2`,
      qemu,
    });
  } catch (error) {
    refused = error;
  }
  assert(
    refused instanceof GuestExecutorUnavailableError,
    `refused at the mkfs layer (got ${refused})`,
  );
  const publishedCold = [...Deno.readDirSync(`${work}/cache-partial/layers`)]
    .filter((e) => e.isDirectory && !e.name.endsWith(".partial"));
  assert(
    publishedCold.length === 2,
    `base and table survived the refusal (got ${publishedCold.length})`,
  );
  pass("the partial chain is cached; only the guest layer is refused");

  step("build for real, through the appliance");
  const store = new LayerStore(`${work}/cache`);
  const output = `${work}/appliance.qcow2`;
  const guest = new ApplianceGuestRunner({ identity });
  const started = Date.now();
  const artifact = await build(planned, resolved, {
    store,
    output,
    qemu,
    guest,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  pass(`built ${artifact.layers.length} layers in ${elapsed}s`);

  step("the ext4 root is real: independent parsers agree");
  const raw = `${work}/appliance.raw`;
  await qemu.convert(output, raw, { format: "raw", parallel: 1 });
  const attach = await new Deno.Command("hdiutil", {
    args: [
      "attach",
      "-nomount",
      "-imagekey",
      "diskimage-class=CRawDiskImage",
      raw,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const attached = new TextDecoder().decode(attach.stdout);
  const device = /^(\/dev\/disk\d+)/m.exec(attached)?.[1];
  if (device === undefined) {
    console.log("  · hdiutil unavailable — parser cross-check skipped");
  } else {
    try {
      const list = await new Deno.Command("diskutil", {
        args: ["list", device],
        stdout: "piped",
      }).output();
      const text = new TextDecoder().decode(list.stdout);
      assert(/EFI/.test(text), `diskutil sees the ESP:\n${text}`);
      // diskutil has no friendly name for the aarch64 root type, so it prints
      // the GUID — which is a stricter check than a name would have been.
      assert(
        /B921B045-1DF0-41C3-AF44-4C6F280D3FAE/i.test(text),
        `diskutil reports the aarch64 root type GUID:\n${text}`,
      );
      pass("diskutil parsed the GPT and typed both partitions");
    } finally {
      await new Deno.Command("hdiutil", {
        args: ["detach", device, "-force"],
        stdout: "null",
        stderr: "null",
      }).output();
    }
  }

  step("verify the artifact from inside a guest: e2fsck, then the tree");
  // The oracle is e2fsprogs' own checker over a filesystem this package never
  // wrote a byte of, and busybox tar's view of an archive this package wrote
  // every byte of. The 120-character name is the one that exercises the GNU
  // 'L' record under POSIX ustar magic — the single combination the probes
  // never ran in the guest.
  const verify = await guest.run({
    stepId: "verify",
    imagePath: output,
    script: [
      'mount -t ext4 -o ro "${QI_TARGET}2" /mnt || exit 20',
      "ls /mnt/opt/app/ || exit 21",
      "test -x /mnt/opt/app/exe.sh || exit 22",
      'test -f "/mnt/opt/app/has space.txt" || exit 23',
      "test -f /mnt/opt/app/a/b/c/d/deep.txt || exit 24",
      `test -f /mnt/opt/app/${longName} || exit 25`,
      "sha256sum /mnt/opt/app/big3m.bin",
      "umount /mnt",
      'e2fsck -fn "${QI_TARGET}2" || exit 26',
      "",
    ].join("\n"),
    nonce: "verify".padEnd(32, "0"),
    scratchDir: work,
  });
  assert(
    verify.outcome.code === 0,
    `in-guest verification passed (rc ${verify.outcome.code}):\n${verify.console}`,
  );
  const bigDigest = await crypto.subtle.digest("SHA-256", big)
    .then((d) =>
      Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
  assert(
    verify.console.includes(bigDigest),
    `the 3 MiB file survived byte-for-byte (expected ${bigDigest}):\n` +
      verify.console.split("\n").slice(-12).join("\n"),
  );
  pass("e2fsck clean, every staged path present, 3 MiB file byte-identical");
  pass("  including the 120-char name — the GNU 'L' record reads in busybox");

  step("a second build is a cache hit for every layer");
  const again = await build(planned, resolved, {
    store,
    output: `${work}/again.qcow2`,
    qemu,
    guest,
  });
  assert(
    again.cacheHits.length === planned.steps.length,
    `all ${planned.steps.length} layers hit (got ${again.cacheHits.length})`,
  );
  pass("no VM booted on the rebuild");

  step("mke2fs is reproducible: a cold rebuild lands on the same bytes");
  const fresh = new LayerStore(`${work}/cache-cold`);
  const rebuilt = await build(planned, resolved, {
    store: fresh,
    output: `${work}/cold.qcow2`,
    qemu,
    guest,
  });
  const mkfsIndex = planned.steps.findIndex((s) => s.id === "table:mkfs");
  // This is what turns the mke2fs determinism flags from a claim into a
  // tested property. Without E2FSPROGS_FAKE_TIME, -U and -E hash_seed the two
  // filesystems differ, every descendant's key moves, and the store thrashes.
  assert(
    artifact.layers[mkfsIndex].containerSha256 ===
      rebuilt.layers[mkfsIndex].containerSha256,
    "two independent boots produced byte-identical ext4:\n" +
      `  first  ${artifact.layers[mkfsIndex].containerSha256}\n` +
      `  second ${rebuilt.layers[mkfsIndex].containerSha256}`,
  );
  pass(
    `ext4 layer is byte-identical across boots (${
      artifact.layers[mkfsIndex].containerSha256.slice(0, 16)
    }…)`,
  );

  console.log("\nsystem smoke: all green");
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  failed = true;
} finally {
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
if (failed) Deno.exit(1);
