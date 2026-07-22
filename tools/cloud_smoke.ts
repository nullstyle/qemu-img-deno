/**
 * Real-appliance smoke for `base: { kind: "image" }`: customize a cloud image
 * nobody here built, and prove the parts we did not touch are untouched.
 *
 *     deno task smoke:cloud
 *
 * Every other smoke checks bytes this package wrote. This one checks the
 * opposite property — that 5507 files it never looked at came through a
 * `copyIn` and a `run` unchanged — because that is the whole contract of a
 * customize flow, and it is not a property any amount of writing-side testing
 * can establish.
 *
 * Skips cleanly, exit 0, when qemu-img is missing, when no appliance has been
 * built, or when the pinned image is neither cached nor fetchable.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import {
  BaseImageSizeMismatchError,
  build,
  defineRecipe,
  dir,
  file,
  LayerStore,
  LocalInputResolver,
  plan,
  type Recipe,
  resolveRecipe,
} from "../src/recipe/mod.ts";
import {
  ApplianceGuestRunner,
  GuestStepFailedError,
  type GuestStepResult,
  readApplianceIdentity,
} from "../src/system/mod.ts";

import { ensureCloudImage, readCloudLock } from "./cloud_image.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

/**
 * Fail by THROWING, never by `Deno.exit` — the system smoke learned this the
 * hard way, since `Deno.exit` skips every pending `finally`.
 */
function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

const ARCH = "aarch64";
const qemu = new QemuImg();
if (!(await qemu.available())) {
  skip("qemu-img not installed (brew install qemu) — smoke skipped");
  Deno.exit(0);
}
if (!(await Deno.stat(`.appliance/${ARCH}/appliance.json`).catch(() => null))) {
  skip(`no ${ARCH} appliance — run: deno task appliance --arch=${ARCH}`);
  Deno.exit(0);
}

const lock = await readCloudLock();
const pin = lock.images["alpine-aarch64"];
assert(pin !== undefined, "cloud.lock.json declares alpine-aarch64");
const m = pin.measured;

step(`resolve the pinned base (${pin.file})`);
const image = await ensureCloudImage(pin);
if (!image.ok) {
  if (image.why.reason === "offline") {
    skip(`pinned image unavailable — ${image.why.detail}`);
    Deno.exit(0);
  }
  console.error(`✗ ${image.why.detail}`);
  Deno.exit(1);
}
pass(
  `${image.path} ${image.fetched ? "(fetched)" : "(cached)"}, sha256 verified`,
);

const work = await Deno.makeTempDir({ prefix: "qemu-img-cloud-smoke-" });
let failed = false;

/** Run a verification script against a built image, in the appliance. */
async function inGuest(
  guest: ApplianceGuestRunner,
  imagePath: string,
  id: string,
  script: string,
): Promise<GuestStepResult> {
  const scratch = `${work}/verify-${id}`;
  await Deno.mkdir(scratch, { recursive: true });
  return await guest.run({
    stepId: id,
    imagePath,
    script,
    nonce: id.padEnd(32, "0").slice(0, 32),
    scratchDir: scratch,
  });
}

/**
 * Fingerprint everything in the root filesystem EXCEPT what this build added.
 *
 * The path set plus a content digest over the pinned oracle file is what turns
 * "the copy worked" into "and nothing else moved". `find | sort | sha256sum`
 * is a pipeline, so its status is `sha256sum`'s — fine here because the digest
 * itself is the assertion.
 *
 * No `cut -d" "` anywhere: a `cut -d\" \"` nested inside `"$( … )"` came back
 * empty from busybox ash rather than failing, which cost a smoke run. The
 * guest prints `sha256sum`'s whole line and {@linkcode field} takes the first
 * token, so the parsing that can go wrong happens on the host where it is
 * visible.
 */
const FINGERPRINT = (dev: string) =>
  [
    `mount -t ext4 -o ro ${dev} /mnt || exit 40`,
    "echo \"PATHS $(find /mnt ! -path '/mnt/opt/app*' ! -name qimg-cloud-smoke" +
    ' | sort | sha256sum)"',
    "echo \"FILES $(find /mnt -type f ! -path '/mnt/opt/app*' " +
    '! -name qimg-cloud-smoke | wc -l)"',
    // CONTENT, not just the path list. A path-list digest plus a file count is
    // unchanged by truncating every file in the image: measured, this
    // fingerprint's earlier form passed identically before and after a step
    // that emptied all of /etc and /usr/bin. A customize flow that cannot
    // notice that is not verifying the thing it claims to verify.
    "echo \"CONTENT $(find /mnt -type f ! -path '/mnt/opt/app*' " +
    '! -name qimg-cloud-smoke -exec sha256sum {} + | sort | sha256sum)"',
    'echo "OSREL $(sha256sum /mnt/etc/os-release)"',
    "umount /mnt",
    "",
  ].join("\n");

/** First whitespace-delimited token of a `KEY value…` line in the console. */
function field(result: GuestStepResult, key: string): string {
  const line = result.console.split("\n").find((l) => l.startsWith(`${key} `));
  return line === undefined
    ? ""
    : (line.slice(key.length + 1).trim().split(/\s+/)[0] ?? "");
}

try {
  const identity = await readApplianceIdentity({ arch: ARCH });
  const guest = new ApplianceGuestRunner({ identity });
  pass(
    `appliance ${identity.digest.slice(0, 16)}… (${identity.kernelRelease})`,
  );

  step("qemu-img info agrees with the pin (the FILE's size does not)");
  const info = await qemu.info(image.path, { format: pin.format });
  assert(
    info.virtualSizeBytes === m.virtualSizeBytes,
    `virtual size ${m.virtualSizeBytes} (got ${info.virtualSizeBytes})`,
  );
  const onDisk = (await Deno.stat(image.path)).size;
  assert(
    onDisk === pin.sizeBytes,
    `file size ${pin.sizeBytes} (got ${onDisk})`,
  );
  assert(
    onDisk !== info.virtualSizeBytes,
    "the file's size and the disk's differ — which is why the recipe has to " +
      "declare the virtual one",
  );
  pass(
    `virtual ${info.virtualSizeBytes} vs file ${onDisk} ` +
      `(${(100 - (onDisk / info.virtualSizeBytes) * 100).toFixed(1)}% smaller)`,
  );

  step("fingerprint the pristine base, before anything is built on it");
  const pristine = `${work}/pristine.qcow2`;
  await qemu.convert(image.path, pristine, {
    sourceFormat: pin.format,
    format: "qcow2",
    parallel: 1,
  });
  const before = await inGuest(
    guest,
    pristine,
    "pristine",
    FINGERPRINT(`"\${QI_TARGET}${m.rootPartition}"`),
  );
  assert(
    before.outcome.code === 0,
    `the pristine base mounts (rc ${before.outcome.code}):\n${before.console}`,
  );
  const basePaths = field(before, "PATHS");
  const baseFiles = field(before, "FILES");
  const baseContent = field(before, "CONTENT");
  // A digest that came back empty would make the comparison below `"" === ""`
  // — a vacuous pass that looks exactly like a real one.
  assert(
    /^[0-9a-f]{64}$/.test(baseContent),
    `the content fingerprint produced a real digest (got ${
      JSON.stringify(baseContent)
    })`,
  );
  const baseOsRelease = field(before, "OSREL");
  assert(basePaths !== "", "got a path-set digest from the base");
  assert(
    baseFiles === String(m.regularFileCount),
    `the base holds ${m.regularFileCount} regular files (got ${baseFiles})`,
  );
  assert(
    baseOsRelease === m.osReleaseSha256,
    `/etc/os-release matches the pin (got ${baseOsRelease})`,
  );
  pass(`base: ${baseFiles} files, path set ${basePaths.slice(0, 16)}…`);

  step("stage a tree to copy in, and a script to run");
  const app = `${work}/app`;
  await Deno.mkdir(`${app}/nested`, { recursive: true });
  await Deno.writeTextFile(`${app}/hello.txt`, "hello from the host\n");
  await Deno.writeTextFile(`${app}/nested/deep.txt`, "deep\n");
  await Deno.writeTextFile(`${app}/exe.sh`, "#!/bin/sh\necho hi\n");
  await Deno.chmod(`${app}/exe.sh`, 0o755);

  const determinism = {
    sourceDateEpoch: 1_700_000_000,
    guidSeed: "cloud-smoke/v1",
    fsSeed: "cloud-smoke/v1",
  } as const;

  const recipeWith = (
    virtualSizeBytes: number,
    rootPartition: number,
  ): Recipe =>
    defineRecipe({
      name: "cloud-smoke",
      platform: { arch: ARCH, machine: "virt-11.0" },
      base: {
        kind: "image",
        from: file(image.path),
        format: pin.format,
        virtualSizeBytes,
        rootPartition,
      },
      boot: { kind: "none" },
      determinism,
      steps: [
        { kind: "copyIn", id: "app", from: dir(app), to: "/opt/app" },
        {
          kind: "run",
          id: "cfg",
          script: [
            'echo "built by @nullstyle/qemu-img" > "$QI_ROOT/etc/qimg-cloud-smoke"',
            'test -f "$QI_ROOT/opt/app/hello.txt" || exit 11',
            // The run step sees the copyIn layer beneath it, which is the
            // whole point of chaining overlays rather than rebuilding.
            'grep -q "Alpine" "$QI_ROOT/etc/os-release" || exit 12',
            "",
          ].join("\n"),
        },
      ],
    });

  const recipe = recipeWith(m.virtualSizeBytes, m.rootPartition);
  const resolved = await resolveRecipe(recipe, {
    resolver: new LocalInputResolver(),
  });
  const planned = await plan(resolved, { appliance: identity });
  assert(planned.requiresAppliance, "copyIn and run need the guest");
  assert(
    planned.layout === undefined,
    "an image base declares no layout of its own",
  );
  assert(
    planned.steps.map((s) => s.id).join(",") === "base,app,cfg",
    `three layers (got ${planned.steps.map((s) => s.id).join(",")})`,
  );
  pass(`planned:\n${planned.explain()}`);

  step("build on top of the cloud image");
  const store = new LayerStore(`${work}/cache`);
  const output = `${work}/customized.qcow2`;
  const started = Date.now();
  const artifact = await build(planned, resolved, {
    store,
    output,
    qemu,
    guest,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  assert(artifact.cacheHits.length === 0, "cold cache: no hits");
  pass(`built ${artifact.layers.length} layers in ${elapsed}s`);

  step("the additions arrived, and e2fsck still passes");
  const added = await inGuest(
    guest,
    output,
    "added",
    [
      `mount -t ext4 -o ro "\${QI_TARGET}${m.rootPartition}" /mnt || exit 40`,
      "test -f /mnt/opt/app/hello.txt || exit 41",
      "test -f /mnt/opt/app/nested/deep.txt || exit 42",
      "test -x /mnt/opt/app/exe.sh || exit 43",
      "test -f /mnt/etc/qimg-cloud-smoke || exit 44",
      "cat /mnt/opt/app/hello.txt",
      "umount /mnt",
      `e2fsck -fn "\${QI_TARGET}${m.rootPartition}" || exit 45`,
      "",
    ].join("\n"),
  );
  assert(
    added.outcome.code === 0,
    `every added path is present (rc ${added.outcome.code}):\n${added.console}`,
  );
  assert(
    added.console.includes("hello from the host"),
    "the copied file's content survived",
  );
  pass("copyIn tree, run-step file and mode bits all present; e2fsck clean");

  step("and NOTHING the image already held changed");
  const after = await inGuest(
    guest,
    output,
    "after",
    FINGERPRINT(`"\${QI_TARGET}${m.rootPartition}"`),
  );
  assert(
    after.outcome.code === 0,
    `the customized image mounts (rc ${after.outcome.code})`,
  );
  assert(
    field(after, "PATHS") === basePaths,
    "the pre-existing path set is byte-identical\n" +
      `  before ${basePaths}\n  after  ${field(after, "PATHS")}`,
  );
  assert(
    field(after, "FILES") === baseFiles,
    `still ${baseFiles} pre-existing files (got ${field(after, "FILES")})`,
  );
  assert(
    field(after, "CONTENT") === baseContent,
    "every pre-existing file's CONTENT is untouched:\n" +
      `  before ${baseContent}\n  after  ${field(after, "CONTENT")}`,
  );
  assert(
    field(after, "OSREL") === baseOsRelease,
    "/etc/os-release is untouched",
  );
  pass(
    `${baseFiles} pre-existing files, identical path set ` +
      `(${basePaths.slice(0, 16)}…)`,
  );

  step("a wrong rootPartition is refused by name, not by mount(2) errno");
  // Partition 1 of this image is a FAT ESP — a plausible guess, and the one
  // that used to arrive as `Invalid argument` under twelve lines of e2fsck
  // superblock advice.
  const espRecipe = recipeWith(m.virtualSizeBytes, m.espPartition);
  const espResolved = await resolveRecipe(espRecipe, {
    resolver: new LocalInputResolver(),
  });
  const espPlanned = await plan(espResolved, { appliance: identity });
  const espStore = new LayerStore(`${work}/cache-esp`);
  let espError: unknown;
  try {
    await build(espPlanned, espResolved, {
      store: espStore,
      output: `${work}/esp.qcow2`,
      qemu,
      guest,
    });
  } catch (error) {
    espError = error;
  }
  assert(
    espError instanceof GuestStepFailedError,
    `pointing at the ESP fails the step (got ${espError})`,
  );
  assert(
    espError.outcome.code === 70,
    `with the wrong-filesystem code 70 (got ${espError.outcome.code})`,
  );
  assert(
    /holds vfat, not ext4/.test(espError.console),
    `naming the filesystem it actually found:\n${espError.console.slice(-600)}`,
  );
  assert(
    espError.outcome.fsckRc === undefined || espError.outcome.fsckRc === 0,
    `and e2fsck was never handed the FAT partition (fsck ${espError.outcome.fsckRc})`,
  );
  const espPublished = [...Deno.readDirSync(`${work}/cache-esp/layers`)]
    .filter((e) => e.isDirectory && !e.name.endsWith(".partial"));
  assert(
    espPublished.length === 1,
    `only the base published (got ${espPublished.length})`,
  );
  pass("refused with `holds vfat, not ext4`; no layer published past the base");

  step("a partition number the image does not have is refused too");
  const gonePlanned = await plan(
    await resolveRecipe(recipeWith(m.virtualSizeBytes, 7), {
      resolver: new LocalInputResolver(),
    }),
    { appliance: identity },
  );
  let goneError: unknown;
  try {
    await build(
      gonePlanned,
      await resolveRecipe(recipeWith(m.virtualSizeBytes, 7), {
        resolver: new LocalInputResolver(),
      }),
      {
        store: new LayerStore(`${work}/cache-gone`),
        output: `${work}/gone.qcow2`,
        qemu,
        guest,
      },
    );
  } catch (error) {
    goneError = error;
  }
  assert(
    goneError instanceof GuestStepFailedError && goneError.outcome.code === 68,
    `a missing partition exits 68 (got ${goneError})`,
  );
  assert(
    /the target disk offers: vda1 vda2/.test(goneError.console),
    `listing the numbers that would have worked:\n${
      goneError.console.slice(-400)
    }`,
  );
  pass("refused with the partitions the image actually has");

  step("declaring a bigger disk is read as a grow request, and refused");
  const growRecipe = recipeWith(2 * 1024 ** 3, m.rootPartition);
  const growResolved = await resolveRecipe(growRecipe, {
    resolver: new LocalInputResolver(),
  });
  let growError: unknown;
  try {
    await build(
      await plan(growResolved, { appliance: identity }),
      growResolved,
      {
        store: new LayerStore(`${work}/cache-grow`),
        output: `${work}/grow.qcow2`,
        qemu,
        guest,
      },
    );
  } catch (error) {
    growError = error;
  }
  assert(
    growError instanceof BaseImageSizeMismatchError,
    `refused with BaseImageSizeMismatchError (got ${growError})`,
  );
  assert(
    /asks to GROW/.test(growError.message) &&
      /repairGpt/.test(growError.message),
    `naming the grow and the fix:\n${growError.message}`,
  );
  pass("grow refused, pointing at the backup-GPT repair it needs");

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

  console.log("\ncloud smoke: all green");
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  failed = true;
} finally {
  await Deno.remove(work, { recursive: true }).catch(() => {});
}
if (failed) Deno.exit(1);
