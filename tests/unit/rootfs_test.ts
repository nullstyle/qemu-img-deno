/**
 * The pure tier of `unpack` and `run({ chroot })`: what the planner refuses,
 * what the generated scripts say, and which declarations move a cache key.
 *
 * Nothing here boots a VM. Every claim these tests make about the guest is
 * pinned in a comment to the measurement it came from, and the end-to-end
 * proof lives in `tools/rootfs_smoke.ts`.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type ArchiveCompression,
  defineRecipe,
  detectCompression,
  dir,
  file,
  type Input,
  type InputResolver,
  plan,
  type Recipe,
  RecipePlanError,
  type ResolvedEntry,
  type ResolvedInput,
  resolveRecipe,
  type Step,
} from "../../src/recipe/mod.ts";
import {
  copyInScript,
  GUEST_TAR_FLAG,
  runScript,
  TARGET_LOADERS,
  unpackScript,
} from "../../src/system/mod.ts";

/** `arch` must match `recipeWith`'s `platform.arch`, or plan() refuses first. */
const APPLIANCE = { digest: "appliance-digest", arch: "aarch64" as const };

/** An ESP tree with the removable-media fallback `plan()` insists on. */
const ESP_TREE: ResolvedEntry[] = [
  { path: "EFI", type: "dir", mode: 0o755, sizeBytes: 0 },
  { path: "EFI/BOOT", type: "dir", mode: 0o755, sizeBytes: 0 },
  {
    path: "EFI/BOOT/BOOTAA64.EFI",
    type: "file",
    mode: 0o644,
    sizeBytes: 4096,
    sha256: "a".repeat(64),
  },
];

/**
 * A resolver with no filesystem behind it. Archives are declared as
 * `(digest, compression)` pairs, which is exactly what the real resolver
 * reduces a file to.
 */
class StubResolver implements InputResolver {
  constructor(
    private readonly archives: Record<
      string,
      { sha256: string; compression?: ArchiveCompression }
    > = {},
  ) {}
  resolve(input: Input): Promise<ResolvedInput> {
    if (input.kind === "file") {
      const archive = this.archives[input.path] ??
        { sha256: `stub-${input.path}`, compression: "gzip" as const };
      return Promise.resolve({
        input,
        sha256: archive.sha256,
        sizeBytes: 1024,
        ...(archive.compression === undefined
          ? {}
          : { compression: archive.compression }),
      });
    }
    return Promise.resolve({
      input,
      sha256: `stub-${input.path}`,
      sizeBytes: 0,
      entries: ESP_TREE,
      traits: [],
    });
  }
}

/** A buildable recipe with one ext4 root, plus whatever steps a test adds. */
function recipeWith(...steps: Step[]): Recipe {
  return defineRecipe({
    name: "rootfs",
    platform: { arch: "aarch64" },
    base: { kind: "blank", sizeBytes: 4 * 1024 ** 3 },
    boot: { kind: "uefi-removable" },
    determinism: {
      sourceDateEpoch: 1_700_000_000,
      guidSeed: "seed",
      fsSeed: "seed",
    },
    steps: [
      {
        kind: "partition",
        id: "table",
        partitions: [
          {
            label: "EFI",
            type: "esp",
            size: 33 * 1024 * 1024,
            contents: {
              kind: "fat",
              fatType: 16,
              label: "EFI",
              from: dir("./esp"),
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
      ...steps,
    ],
  });
}

async function planOf(
  recipe: Recipe,
  resolver: InputResolver = new StubResolver(),
) {
  return await plan(await resolveRecipe(recipe, { resolver }), {
    appliance: APPLIANCE,
  });
}

// --- the sniff -------------------------------------------------------------

Deno.test("detectCompression reads magic bytes, never a filename", () => {
  const cases: [ArchiveCompression, number[]][] = [
    ["gzip", [0x1f, 0x8b, 0x08, 0x00]],
    ["bzip2", [0x42, 0x5a, 0x68, 0x39]],
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd, 0x00]],
    ["lzma", [0x5d, 0x00, 0x00, 0x80]],
  ];
  for (const [expected, bytes] of cases) {
    assertEquals(detectCompression(new Uint8Array(bytes)), expected);
  }
  // A plain ustar header starts with the archive member's name.
  assertEquals(
    detectCompression(new TextEncoder().encode("./usr/bin/env\0\0\0")),
    "none",
  );
  // Too short to carry any signature at all: still answerable, never a throw.
  assertEquals(detectCompression(new Uint8Array([0x1f])), "none");
});

Deno.test("a zstd frame is not mistaken for lzma", () => {
  // 0x5d is a plausible LZMA properties byte and zstd's frame header contains
  // no 0x5d prefix, but the ordering in the table is what guarantees this: a
  // three-byte weak signature must never be tested before a four-byte one.
  assertEquals(
    detectCompression(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x5d, 0x00])),
    "zstd",
  );
});

// --- the refusals ----------------------------------------------------------

Deno.test("plan() refuses a zstd archive, naming the fix", async () => {
  const resolver = new StubResolver({
    "./rootfs.tar": { sha256: "z".repeat(64), compression: "zstd" },
  });
  const error = await assertRejects(
    () =>
      planOf(
        recipeWith({
          kind: "unpack",
          id: "rootfs",
          from: file("./rootfs.tar"),
          to: "/",
        }),
        resolver,
      ),
    RecipePlanError,
  );
  // The appliance's busybox 1.37.0 applet list has no `zstd` and no `unzstd`
  // (measured), so this cannot be a runtime failure inside a booted VM.
  assertStringIncludes(error.message, "no `zstd` and no `unzstd` applet");
  assertStringIncludes(error.message, "gzip, bzip2 or lzma");
});

Deno.test("plan() refuses xz for the transport, and says so", async () => {
  const resolver = new StubResolver({
    "./rootfs.tar": { sha256: "x".repeat(64), compression: "xz" },
  });
  const error = await assertRejects(
    () =>
      planOf(
        recipeWith({
          kind: "unpack",
          id: "rootfs",
          from: file("./rootfs.tar"),
          to: "/",
        }),
        resolver,
      ),
    RecipePlanError,
  );
  // Measured: `tar -J` off the padded raw device extracts every member and
  // THEN exits 1. The refusal must not read as "xz is unsupported", because a
  // reader who believes that will not think to recompress.
  assertStringIncludes(error.message, "zero padding");
  assertStringIncludes(error.message, "corrupted data");
  assertStringIncludes(error.message, "xz -dc rootfs.tar.xz | gzip");
});

Deno.test("plan() refuses an archive the resolver never sniffed", async () => {
  const resolver = new StubResolver({
    "./rootfs.tar.gz": { sha256: "a".repeat(64), compression: undefined },
  });
  const error = await assertRejects(
    () =>
      planOf(
        recipeWith({
          kind: "unpack",
          id: "rootfs",
          from: file("./rootfs.tar.gz"),
          to: "/",
        }),
        resolver,
      ),
    RecipePlanError,
  );
  // Falling back to the extension is the one thing this must not do: the
  // archive reaches the guest as a raw block device with no name on it.
  assertStringIncludes(error.message, "raw block device");
  assertStringIncludes(error.message, "detectCompression");
});

Deno.test("plan() refuses an unpack destination that is not normalized", async () => {
  for (const to of ["opt/app", "/opt//app", "/opt/../etc", "/opt/./app"]) {
    const error = await assertRejects(
      () =>
        planOf(recipeWith({
          kind: "unpack",
          id: "rootfs",
          from: file("./rootfs.tar.gz"),
          to,
        })),
      RecipePlanError,
      undefined,
      `expected ${to} to be refused`,
    );
    assertStringIncludes(error.message, "absolute, normalized path");
  }
});

Deno.test("plan() refuses a fractional or negative stripComponents", async () => {
  for (const stripComponents of [-1, 1.5]) {
    const error = await assertRejects(
      () =>
        planOf(recipeWith({
          kind: "unpack",
          id: "rootfs",
          from: file("./rootfs.tar.gz"),
          to: "/",
          stripComponents,
        })),
      RecipePlanError,
    );
    // busybox takes the value as a count and reads both of these as 0, which
    // would extract the archive unstripped under a recipe that says otherwise.
    assertStringIncludes(error.message, "non-negative integer");
  }
});

Deno.test("an unpack step needs exactly one ext4 root to unpack into", async () => {
  const noRoot = defineRecipe({
    ...recipeWith(),
    boot: { kind: "none" },
    steps: [
      {
        kind: "partition",
        id: "table",
        partitions: [{
          label: "data",
          type: "linux-generic",
          size: "rest",
          contents: { kind: "empty" },
        }],
      },
      { kind: "unpack", id: "rootfs", from: file("./rootfs.tar.gz"), to: "/" },
    ],
  });
  const error = await assertRejects(() => planOf(noRoot), RecipePlanError);
  assertStringIncludes(error.message, "0 ext4 partitions");
});

Deno.test("an unpack step is a guest step, and needs an appliance to plan", async () => {
  const resolved = await resolveRecipe(
    recipeWith({
      kind: "unpack",
      id: "rootfs",
      from: file("./rootfs.tar.gz"),
      to: "/",
    }),
    { resolver: new StubResolver() },
  );
  const error = await assertRejects(() => plan(resolved), RecipePlanError);
  assertStringIncludes(error.message, "readApplianceIdentity");
});

// --- key sensitivity -------------------------------------------------------

Deno.test("the unpack layer rekeys on the archive, the destination and the strip", async () => {
  const keyOf = async (
    step: Extract<Step, { kind: "unpack" }>,
    resolver?: InputResolver,
  ) => {
    const planned = await planOf(recipeWith(step), resolver);
    return planned.steps.find((s) => s.id === "rootfs")!.recipeKey;
  };
  const baseline = await keyOf({
    kind: "unpack",
    id: "rootfs",
    from: file("./rootfs.tar.gz"),
    to: "/",
  });
  assertNotEquals(
    baseline,
    await keyOf({
      kind: "unpack",
      id: "rootfs",
      from: file("./rootfs.tar.gz"),
      to: "/opt",
    }),
    "a different destination is a different layer",
  );
  assertNotEquals(
    baseline,
    await keyOf({
      kind: "unpack",
      id: "rootfs",
      from: file("./rootfs.tar.gz"),
      to: "/",
      stripComponents: 1,
    }),
    "stripping a leading component is a different layer",
  );
  assertNotEquals(
    baseline,
    await keyOf(
      { kind: "unpack", id: "rootfs", from: file("./rootfs.tar.gz"), to: "/" },
      new StubResolver({
        "./rootfs.tar.gz": { sha256: "b".repeat(64), compression: "gzip" },
      }),
    ),
    "a different archive is a different layer",
  );
  assertEquals(
    baseline,
    await keyOf({
      kind: "unpack",
      id: "rootfs",
      from: file("./rootfs.tar.gz"),
      to: "/",
      stripComponents: 0,
    }),
    "an explicit 0 strip is the default, and must not rekey",
  );
});

Deno.test("chroot is in the key: the same script is a different program", async () => {
  const keyOf = async (chroot: boolean) => {
    const planned = await planOf(recipeWith(
      { kind: "unpack", id: "rootfs", from: file("./rootfs.tar.gz"), to: "/" },
      { kind: "run", id: "pkgs", script: "apk add nginx", chroot },
    ));
    return planned.steps.find((s) => s.id === "pkgs")!.recipeKey;
  };
  // Without chroot, `apk add nginx` installs into the APPLIANCE and vanishes
  // at poweroff; with it, the same string installs into the image. Sharing a
  // cache entry between the two would serve one as the other.
  assertNotEquals(await keyOf(true), await keyOf(false));
});

Deno.test("a networked chroot step and everything after it stays uncacheable", async () => {
  const planned = await planOf(recipeWith(
    { kind: "unpack", id: "rootfs", from: file("./rootfs.tar.gz"), to: "/" },
    {
      kind: "run",
      id: "pkgs",
      script: "apk add nginx",
      chroot: true,
      network: true,
    },
    { kind: "run", id: "after", script: "true", chroot: true },
  ));
  const byId = new Map(planned.steps.map((s) => [s.id, s]));
  assert(byId.get("rootfs")!.cacheable, "the offline unpack still caches");
  assert(!byId.get("pkgs")!.cacheable, "the networked step does not");
  assert(!byId.get("after")!.cacheable, "and neither does its descendant");
});

// --- the generated scripts -------------------------------------------------

Deno.test("unpackScript passes each tar flag as its own argv word", () => {
  // `-x-z` is what bundling produces, and busybox reads it as an unknown
  // option; `--lzma` cannot be bundled at any price.
  const gzip = unpackScript({
    rootPartitionNumber: 2,
    to: "/",
    compression: "gzip",
  });
  assertStringIncludes(gzip, `tar -x -z -f "$QI_DATA" -C '/mnt/root'`);
  const lzma = unpackScript({
    rootPartitionNumber: 2,
    to: "/",
    compression: "lzma",
  });
  assertStringIncludes(lzma, `tar -x --lzma -f "$QI_DATA" -C '/mnt/root'`);
  const plain = unpackScript({
    rootPartitionNumber: 2,
    to: "/opt/app",
    compression: "none",
  });
  assertStringIncludes(plain, `tar -x -f "$QI_DATA" -C '/mnt/root/opt/app'`);
  assertStringIncludes(plain, `mkdir -p '/mnt/root/opt/app'`);
  const stripped = unpackScript({
    rootPartitionNumber: 2,
    to: "/",
    compression: "bzip2",
    stripComponents: 2,
  });
  assertStringIncludes(stripped, `tar -x -j -f "$QI_DATA"`);
  assertStringIncludes(stripped, "--strip-components 2");
});

Deno.test("unpack extracts with --numeric-owner, always", () => {
  // Measured in the appliance (busybox 1.37.0, extracting as uid 0) with an
  // archive whose members carry uid/gid 123/456 under uname/gname "root":
  // without the flag both members landed `0:0`, with it `123:456`. busybox
  // resolves the NAMES against the appliance's own /etc/passwd and
  // /etc/group — the target's cannot be consulted, it is a mounted directory
  // and not the running system — so a rootfs unpacked without this is owned
  // by whatever those names mean inside the build appliance. It builds,
  // mounts and boots that way, which is why the flag is not optional.
  //
  // The flag is measured HONORED, not merely accepted: `tar --help` in this
  // applet advertises options it does not implement, so the help text is not
  // evidence. Argv position was measured not to matter.
  for (const compression of ["none", "gzip", "bzip2", "lzma"] as const) {
    const script = unpackScript({
      rootPartitionNumber: 2,
      to: "/",
      compression,
    });
    assertStringIncludes(script, "--numeric-owner");
  }
  const stripped = unpackScript({
    rootPartitionNumber: 2,
    to: "/",
    compression: "gzip",
    stripComponents: 1,
  });
  assertStringIncludes(
    stripped,
    `tar -x -z -f "$QI_DATA" -C '/mnt/root' --numeric-owner ` +
      `--strip-components 1`,
  );
});

Deno.test("copyIn does NOT pass --numeric-owner, and that is deliberate", () => {
  // Not a limitation: busybox 1.37.0 implements the flag (measured above).
  // `buildTar` writes every member as uid/gid 0 with uname/gname "root", and
  // the appliance resolves "root" to 0, so the numeric and name paths agree
  // at 0:0. `unpack` needs the flag because its archive is the CALLER's.
  const script = copyInScript({ rootPartitionNumber: 2, to: "/" });
  assert(
    !script.includes("--numeric-owner"),
    "copyIn's payload is written by this package with uid/gid 0",
  );
});

Deno.test("unpackScript mounts by number and refuses a missing data disk", () => {
  const script = unpackScript({
    rootPartitionNumber: 3,
    to: "/",
    compression: "gzip",
  });
  assertStringIncludes(script, 'qi_mount_root "${QI_TARGET}3"');
  // `-t ext4` is not optional: busybox mount cannot autodetect ext4 in this
  // initramfs and fails with "No such file or directory" on a good filesystem.
  assertStringIncludes(script, 'mount -t ext4 "$1" /mnt/root');
  assertStringIncludes(script, "unpack with no data disk attached");
});

Deno.test("unpackScript refuses a compression the guest cannot unpack", () => {
  for (const compression of ["zstd", "xz"] as const) {
    const error = assertThrows(
      () => unpackScript({ rootPartitionNumber: 2, to: "/", compression }),
      Error,
    );
    assertStringIncludes(error.message, "bypassed the planner");
  }
});

Deno.test("GUEST_TAR_FLAG is the measured set, not the advertised one", () => {
  // `busybox tar --help` advertises -J for xz, and the applet list has unxz —
  // but the measurement that decides this table is an end-to-end extraction
  // over the padded raw-device transport `unpack` actually uses. There, xz
  // extracts correctly and exits 1; the other four exit 0.
  assertEquals(GUEST_TAR_FLAG.none, []);
  assertEquals(GUEST_TAR_FLAG.gzip, ["-z"]);
  assertEquals(GUEST_TAR_FLAG.bzip2, ["-j"]);
  assertEquals(GUEST_TAR_FLAG.lzma, ["--lzma"]);
  assertEquals(GUEST_TAR_FLAG.xz, undefined);
  assertEquals(GUEST_TAR_FLAG.zstd, undefined);
});

Deno.test("runScript without chroot is unchanged: the target is beside you", () => {
  const script = runScript({ rootPartitionNumber: 2, script: "echo hi" });
  assertStringIncludes(script, "QI_ROOT=/mnt/root");
  assertStringIncludes(script, 'cd "$QI_ROOT"');
  assert(!script.includes("chroot"), "no chroot machinery leaks into it");
});

Deno.test("a chroot run mounts /proc, /sys and a bind of /dev", () => {
  const script = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    script: "apk add nginx",
  });
  assertStringIncludes(script, 'mount -t proc none "$1/proc"');
  assertStringIncludes(script, 'mount -t sysfs none "$1/sys"');
  // The measured one: without this bind, `apk add nginx` exits 0 and leaves a
  // 0-byte REGULAR FILE at /dev/null that a post-install redirect created.
  assertStringIncludes(script, 'mount -o bind /dev "$1/dev"');
  assertStringIncludes(script, 'umount "$1/dev"');
});

Deno.test("a chroot run carries set -e and set -u into the chroot", () => {
  const script = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    script: "false\necho unreachable",
  });
  // /init's `set -eu` is the OUTER shell's. Measured in busybox ash 1.37.0:
  // `sh -eu -c 'false\necho X'` returns 1 and never prints X.
  assertStringIncludes(script, `chroot "$QI_ROOT" /bin/sh -eu -c`);
  assertStringIncludes(script, "|| QI_RC=$?");
  assertStringIncludes(script, '[ "$QI_RC" = 0 ] || exit "$QI_RC"');
});

Deno.test("the chroot diagnosis names the loader, not the binary", () => {
  const script = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    script: "true",
  });
  // The probe runs FIRST and only a failure reaches the diagnosis, so a
  // statically linked /bin/sh with no loader at all is never refused.
  assertStringIncludes(script, 'chroot "$1" /bin/sh -c : 2>/dev/null');
  for (const loader of TARGET_LOADERS.aarch64) {
    assertStringIncludes(script, loader);
  }
  assertStringIncludes(script, "the target has no /bin/sh");
  assertStringIncludes(script, "dynamic loader it needs does not");
  assertStringIncludes(script, "ENOENT for a missing INTERPRETER");
  assertStringIncludes(script, "exit 70");
  assertStringIncludes(script, "exit 71");
  assertStringIncludes(script, "exit 72");
});

Deno.test("x86_64 gets its own loader paths, not aarch64's", () => {
  const script = runScript({
    rootPartitionNumber: 2,
    arch: "x86_64",
    chroot: true,
    script: "true",
  });
  assertStringIncludes(script, "/lib64/ld-linux-x86-64.so.2");
  assert(
    !script.includes("aarch64"),
    "an aarch64 path in an x86_64 diagnosis is worse than no diagnosis",
  );
});

Deno.test("runScript refuses chroot without an arch to diagnose against", () => {
  const error = assertThrows(
    () => runScript({ rootPartitionNumber: 2, chroot: true, script: "true" }),
    Error,
  );
  assertStringIncludes(error.message, "needs `arch`");
});

Deno.test("only a networked chroot lends the resolver, and takes it back", () => {
  const offline = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    script: "true",
  });
  assert(
    !offline.includes("resolv.conf"),
    "an offline chroot never touches the target's resolver config",
  );
  const online = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    network: true,
    script: "apk add nginx",
  });
  assertStringIncludes(online, 'qi_resolv_install "$QI_ROOT"');
  assertStringIncludes(online, 'qi_resolv_restore "$QI_ROOT"');
  // Alpine's minirootfs ships no /etc/resolv.conf (measured), so the restore
  // is a delete — and without it the build host's resolver ships in the image.
  assertStringIncludes(online, 'rm -f "$1/etc/resolv.conf"');
  // The restore must come BEFORE the unmounts, or it would write into the
  // appliance's own /dev-bound tree rather than the target.
  assert(
    online.indexOf('qi_resolv_restore "$QI_ROOT"') <
      online.indexOf('qi_chroot_leave "$QI_ROOT"'),
    "the resolver is taken back before the chroot's mounts go away",
  );
});

Deno.test("the resolver save survives a DANGLING /etc/resolv.conf symlink", () => {
  const online = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    network: true,
    script: "apk add nginx",
  });
  // Every Debian and Ubuntu cloud image ships `/etc/resolv.conf` as a symlink
  // into `/run` whose target does not exist until systemd-resolved runs.
  // Measured in the appliance: `[ -e ]` is FALSE for that and `[ -L ]` true —
  // so with `-e` alone the save is skipped and the restore deletes the image's
  // own symlink, leaving a networked step in such an image with no resolver
  // configuration at all. The artifact still builds, mounts and boots.
  assertStringIncludes(
    online,
    '[ -e "$1/etc/resolv.conf" ] || [ -L "$1/etc/resolv.conf" ]',
  );
  // And `-P`, because plain `cp` of a dangling symlink was measured failing
  // `cp: can't stat …: No such file or directory` at rc 1 — under /init's
  // `set -e` that is a dead step, trading a wrong artifact for a broken build.
  assertStringIncludes(online, 'cp -P "$1/etc/resolv.conf" /qi/resolv.saved');
  assertStringIncludes(online, 'cp -P /qi/resolv.saved "$1/etc/resolv.conf"');
  // The delete is unconditional: what install left is the BUILD HOST's
  // resolver, so it goes whether or not there is something to put back.
  const restore = online.slice(online.indexOf("qi_resolv_restore() {"));
  assert(
    restore.indexOf('rm -f "$1/etc/resolv.conf"') <
      restore.indexOf("cp -P /qi/resolv.saved"),
    "the host's resolver is removed before anything is restored over it",
  );
});

Deno.test("a chroot script with quotes survives the argv it is quoted into", () => {
  const script = runScript({
    rootPartitionNumber: 2,
    arch: "aarch64",
    chroot: true,
    script: `echo 'it''s' "$HOME" >/tmp/x`,
  });
  // Single-quote closing/reopening is the only escape ash offers, and getting
  // it wrong ends the chroot's -c argument early — which would run the tail of
  // the author's script in the APPLIANCE's shell instead of the target's.
  assertStringIncludes(script, `'echo '\\''it'\\''`);
});
