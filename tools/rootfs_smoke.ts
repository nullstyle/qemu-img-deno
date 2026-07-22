/**
 * Real-appliance smoke for `unpack` + `run({ chroot })`: builds a bootable
 * layout, unpacks an Alpine minirootfs into it, installs a package with the
 * distro's own package manager over the network, and then verifies the result
 * from inside a second guest.
 *
 *     deno task smoke:rootfs --dns=<resolver>
 *
 * The resolver is required and has no default. DHCP is impossible in the
 * appliance (no `af_packet` module anywhere in the initramfs) and slirp's own
 * resolver at 10.0.2.3 never answers on qemu 11.0.2/macOS, so the address has
 * to come from the caller — `scutil --dns | grep nameserver` on macOS. Without
 * it the networked half is skipped and the offline half still runs.
 *
 * Skips cleanly when no appliance has been built, the way `smoke:system` does.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import {
  build,
  defineRecipe,
  dir,
  file,
  GuestStepFailedError,
  LayerStore,
  LocalInputResolver,
  plan,
  RecipePlanError,
  resolveRecipe,
  VVFAT_USABLE_BYTES,
} from "../src/recipe/mod.ts";
import {
  ApplianceGuestRunner,
  readApplianceIdentity,
} from "../src/system/mod.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

/** Fail by THROWING, never `Deno.exit` — a pending `finally` must still run. */
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const ARCH = "aarch64";
const DNS = Deno.args.find((a) => a.startsWith("--dns="))?.slice(6);
const ROOTFS = `.appliance/${ARCH}/alpine-minirootfs-3.21.7-${ARCH}.tar.gz`;
/** The published sha256 of the pinned minirootfs, from `appliance.lock.json`. */
const ROOTFS_SHA256 =
  "d1d1a3fae5f4d6146e9742790a47fcb116199622cfb8439f218a4d5fbe5000da";

const qemu = new QemuImg();
if (!(await qemu.available())) {
  skip("qemu-img not installed — smoke skipped");
  Deno.exit(0);
}
if (!(await Deno.stat(`.appliance/${ARCH}/appliance.json`).catch(() => null))) {
  skip(`no ${ARCH} appliance — run: deno task appliance --arch=${ARCH}`);
  Deno.exit(0);
}
if (!(await Deno.stat(ROOTFS).catch(() => null))) {
  skip(`no minirootfs at ${ROOTFS} — run: deno task appliance --arch=${ARCH}`);
  Deno.exit(0);
}

const work = await Deno.makeTempDir({ prefix: "qemu-img-rootfs-smoke-" });
const DISK_BYTES = 4 * 1024 * 1024 * 1024;
const SEED = "smoke/rootfs/v1";
let failed = false;

try {
  const identity = await readApplianceIdentity({ arch: ARCH });
  const resolver = new LocalInputResolver();

  step("the resolver sniffs the archive rather than trusting its name");
  const sniffed = await resolver.resolve(file(ROOTFS));
  assert(
    sniffed.compression === "gzip",
    `detected gzip from the magic bytes (got ${sniffed.compression})`,
  );
  assert(
    sniffed.sha256 === ROOTFS_SHA256,
    `the pinned minirootfs digest matches appliance.lock.json (got ${sniffed.sha256})`,
  );
  pass(`${ROOTFS} is gzip, sha256:${sniffed.sha256.slice(0, 16)}…`);

  step(
    "an unusable compression is refused at plan time, before anything boots",
  );
  // Real frame headers, and nothing decompresses them: the whole point is that
  // the refusal reads four bytes on the HOST. Naming a `.tar.gz` would not
  // save either of these, and neither would booting to find out.
  const refusals: [string, number[], string][] = [
    // No zstd and no unzstd applet in the appliance's busybox.
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x01, 0x00], "no `unzstd`"],
    // Present, and wrong over this transport: extracts every member, exits 1.
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04], "zero padding"],
  ];
  for (const [name, magic, expect] of refusals) {
    const path = `${work}/rootfs.tar.${name}`;
    await Deno.writeFile(path, new Uint8Array(magic));
    let refusal: unknown;
    try {
      await plan(await resolveRecipe(rootfsRecipe(path), { resolver }), {
        appliance: identity,
      });
    } catch (error) {
      refusal = error;
    }
    assert(
      refusal instanceof RecipePlanError && refusal.message.includes(expect),
      `plan() refused ${name} and said "${expect}" (got ${refusal})`,
    );
    pass(`${name}: refused on its magic bytes, no VM involved`);
  }

  step("plan the real recipe");
  const recipe = rootfsRecipe(ROOTFS, DNS !== undefined);
  const resolved = await resolveRecipe(recipe, { resolver });
  const planned = await plan(resolved, { appliance: identity });
  const ids = planned.steps.map((s) => s.id).join(",");
  const expected = DNS === undefined
    ? "base,table,table:mkfs,rootfs"
    : "base,table,table:mkfs,rootfs,pkgs";
  assert(ids === expected, `layers ${expected} (got ${ids})`);
  const pkgs = planned.steps.find((s) => s.id === "pkgs");
  if (pkgs !== undefined) {
    assert(
      !pkgs.cacheable,
      "a networked step is uncacheable — its result is not a function of its " +
        "declared inputs",
    );
  }
  pass(`planned:\n${planned.explain()}`);

  step("build");
  const store = new LayerStore(`${work}/cache`);
  const output = `${work}/alpine.qcow2`;
  const guest = new ApplianceGuestRunner({
    identity,
    ...(DNS === undefined ? {} : { network: { dns: DNS } }),
  });
  if (DNS === undefined) {
    skip("no --dns=<resolver> — the apk step is omitted from this run");
  }
  const started = Date.now();
  const artifact = await build(planned, resolved, {
    store,
    output,
    qemu,
    guest,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  pass(`built ${artifact.layers.length} layers in ${elapsed}s`);

  step("verify from inside a guest, against the built image only");
  // Every check below reads the finished artifact. The oracles are the
  // distro's own metadata (apk's installed database), the kernel's ext4
  // driver, and e2fsck — none of which this package wrote a byte of.
  const checks = [
    'mount -t ext4 -o ro "${QI_TARGET}2" /mnt || exit 20',
    // The rootfs landed, with its symlinks intact (335 of the minirootfs' 521
    // members are symlinks).
    "test -x /mnt/bin/busybox || exit 21",
    "test -e /mnt/lib/ld-musl-aarch64.so.1 || exit 22",
    "test -L /mnt/lib/libc.musl-aarch64.so.1 || exit 23",
    "test -f /mnt/etc/apk/repositories || exit 24",
    // /dev must be EMPTY. A regular file called `null` here is the measured
    // failure mode of chrooting without a /dev bind: apk's post-install
    // scripts redirect to /dev/null, the shell creates it, and every later
    // redirect in the shipped image appends to a file.
    "! test -e /mnt/dev/null || { echo 'FAIL: /dev/null is a regular file'; " +
    "exit 25; }",
    // The build host's resolver must NOT have shipped.
    "! test -e /mnt/etc/resolv.conf || { echo 'FAIL: resolv.conf shipped:'; " +
    "cat /mnt/etc/resolv.conf; exit 26; }",
    "echo 'rootfs: ok'",
  ];
  if (DNS !== undefined) {
    checks.push(
      "test -x /mnt/usr/sbin/nginx || exit 30",
      "test -f /mnt/etc/nginx/nginx.conf || exit 31",
      // apk's own database, not a file list we guessed at.
      "grep -q '^P:nginx$' /mnt/lib/apk/db/installed || exit 32",
      "grep -c '^P:' /mnt/lib/apk/db/installed",
      "echo 'nginx: ok'",
    );
  }
  checks.push("umount /mnt", 'e2fsck -fn "${QI_TARGET}2" || exit 40', "");
  const verify = await guest.run({
    stepId: "verify",
    imagePath: output,
    script: checks.join("\n"),
    nonce: "verify".padEnd(32, "0"),
    scratchDir: work,
  });
  assert(
    verify.outcome.code === 0,
    `in-guest verification passed (rc ${verify.outcome.code}):\n${verify.console}`,
  );
  assert(verify.console.includes("rootfs: ok"), "the rootfs checks ran");
  pass("rootfs present, /dev empty, no resolv.conf leaked, e2fsck clean");
  if (DNS !== undefined) {
    assert(verify.console.includes("nginx: ok"), "the nginx checks ran");
    pass("nginx installed, and apk's own database agrees");
  }

  step("rebuild: the offline layers hit, the networked one does not");
  const again = await build(planned, resolved, {
    store,
    output: `${work}/again.qcow2`,
    qemu,
    guest,
  });
  const cacheable = planned.steps.filter((s) => s.cacheable).length;
  assert(
    again.cacheHits.length === cacheable,
    `${cacheable} cacheable layers hit (got ${again.cacheHits.length})`,
  );
  // `cacheHits` holds RealizationKeys, not step ids, so this has to look the
  // key up. Comparing the list against the string "pkgs" is vacuously true —
  // no key is ever a step id — and would pass with the step served from cache.
  const pkgsIndex = planned.steps.findIndex((s) => s.id === "pkgs");
  if (pkgsIndex >= 0) {
    assert(
      !again.cacheHits.includes(again.layers[pkgsIndex].realizationKey),
      "the networked apk step never comes from cache",
    );
  }
  pass(
    `${again.cacheHits.length} hits; ${
      planned.steps.length - cacheable
    } networked layer(s) rebuilt`,
  );

  step("a rootfs missing its loader is diagnosed, not misreported");
  // The whole reason `chroot` has a guard. chroot's own message for this is
  // `can't execute '/bin/sh': No such file or directory`, which names a file
  // that is right there — execve() reports ENOENT for the missing INTERPRETER.
  // The first four layers are cache hits from the build above: the keys chain
  // identically up to `rootfs`, so this costs two boots, not six.
  const brokenPlan = await plan(
    await resolveRecipe(brokenRecipe(ROOTFS), { resolver }),
    { appliance: identity },
  );
  let broke: unknown;
  try {
    await build(
      brokenPlan,
      await resolveRecipe(brokenRecipe(ROOTFS), {
        resolver,
      }),
      { store, output: `${work}/broken.qcow2`, qemu, guest },
    );
  } catch (error) {
    broke = error;
  }
  assert(
    broke instanceof GuestStepFailedError && broke.stepId === "attempt",
    `the chroot step failed and named itself (got ${broke})`,
  );
  const failure = broke as GuestStepFailedError;
  assert(
    failure.outcome.code === 71,
    `exit 71, the loader-missing code (got ${failure.outcome.code})`,
  );
  assert(
    failure.console.includes("dynamic loader") &&
      failure.console.includes("ld-musl-aarch64.so.1"),
    `the diagnosis names the loader, not the shell:\n${failure.console}`,
  );
  pass("exit 71, and the message names the loader chroot's own message hides");

  console.log("\nrootfs smoke: all green");
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  failed = true;
} finally {
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
if (failed) Deno.exit(1);

/** The same layout, with the target's dynamic loader removed before a chroot. */
function brokenRecipe(archive: string) {
  const good = rootfsRecipe(archive);
  return defineRecipe({
    ...good,
    steps: [
      ...good.steps,
      {
        kind: "run",
        id: "break",
        script: 'rm -f "$QI_ROOT/lib/ld-musl-aarch64.so.1"',
      },
      { kind: "run", id: "attempt", script: "apk --version", chroot: true },
    ],
  });
}

/** The recipe under test: GPT + ESP + ext4 + a rootfs, optionally + apk. */
function rootfsRecipe(archive: string, withPackages = false) {
  const esp = `${work}/esp`;
  Deno.mkdirSync(`${esp}/EFI/BOOT`, { recursive: true });
  Deno.writeTextFileSync(`${esp}/EFI/BOOT/BOOTAA64.EFI`, "MZ not-real\n");
  return defineRecipe({
    name: "web-appliance",
    platform: { arch: ARCH, machine: "virt-11.0" },
    base: { kind: "blank", sizeBytes: DISK_BYTES },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: SEED,
      fsSeed: SEED,
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
      { kind: "unpack", id: "rootfs", from: file(archive), to: "/" },
      ...(withPackages
        ? [{
          kind: "run" as const,
          id: "pkgs",
          script: "apk add --no-cache nginx",
          chroot: true,
          network: true,
        }]
        : []),
    ],
  });
}
