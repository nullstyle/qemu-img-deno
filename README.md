# @nullstyle/qemu-img

> **Status: 0.2.1.** Pre-1.0 — breaking changes ride a minor bump. The subpaths
> are not equally settled; see [Stability](#stability).

A typed Deno driver for QEMU's
[`qemu-img`](https://www.qemu.org/docs/master/tools/qemu-img.html) disk-image
tool: every subcommand covered (`amend`, `bench`, `bitmap`, `check`, `commit`,
`compare`, `convert`, `create`, `dd`, `info`, `map`, `measure`, `rebase`,
`resize`, `snapshot`), JSON output parsed into typed results, and all of it
testable without a `qemu-img` binary.

## Quickstart

```ts
import { QemuImg } from "jsr:@nullstyle/qemu-img";

const qemu = new QemuImg();
await qemu.ensureAvailable(); // clear error with an install hint when missing

await qemu.create("/tmp/disk.qcow2", { format: "qcow2", size: "10G" });
const info = await qemu.info("/tmp/disk.qcow2");
console.log(info.format, info.virtualSizeBytes);

await qemu.convert("/tmp/disk.qcow2", "/tmp/disk.compressed.qcow2", {
  format: "qcow2",
  compress: true, // zlib clusters — the universally readable kind
});
```

## What it is (and is not)

| Layer           | Export          | What it does                                                                                                                                                              |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client          | `.` (`QemuImg`) | Drives the `qemu-img` CLI: every subcommand, pinned argv shapes, typed results for the JSON forms (`info`/`check`/`map`/`measure`).                                       |
| Subprocess seam | `./runner`      | The injectable `CommandRunner` everything flows through.                                                                                                                  |
| Builder         | `./recipe`      | `defineRecipe` → `plan()` → `build()`: a disk image as a chain of content-addressed qcow2 overlays. Planning is pure — assertable with no `qemu-img`, no VM, no network.  |
| Byte builders   | `./fs`          | `buildGpt` and `buildTar` as pure functions over bytes. No host tooling, no privileges, nothing spawned.                                                                  |
| Guest tier      | `./system`      | The seam `build()` runs `guest` layers through, plus this repo's own Linux build appliance. See [Producing an appliance](#producing-an-appliance) before depending on it. |
| Test kit        | `./testing`     | `FakeQemuImg`: a recording, stateful in-memory qemu-img. Your tests assert exact argv with no binary installed.                                                           |

It is **not** an installer (bring your own `brew install qemu`) and it does not
reimplement any image format — it drives the real tool. Exit-code contracts are
honored as data where qemu-img defines them: `check` returns a result for exit
`0`/`2`/`3` (clean / corruptions / unrepaired leaks) and `compare` maps exit
`0`/`1` to `identical: true/false`.

Everything shells out through one injectable seam, so any code built on this
package is testable with `FakeQemuImg`:

```ts
import { QemuImg } from "jsr:@nullstyle/qemu-img";
import { FakeQemuImg } from "jsr:@nullstyle/qemu-img/testing";

const fake = new FakeQemuImg();
fake.setImage("/img.qcow2", { virtualSizeBytes: 1024 ** 3 });
const qemu = new QemuImg({ runner: fake });
await qemu.convert("/img.qcow2", "/img.raw", { format: "raw" });
console.log(fake.commandLines());
// ["qemu-img convert -O raw /img.qcow2 /img.raw"]
```

The runner seam is kept field-identical to
[`@nullstyle/lima`](https://jsr.io/@nullstyle/lima)'s on purpose: the two
packages share no dependency, but any runner or fake written for one satisfies
the other via structural typing.

## Permissions

The tasks in this repository run with broad flags because they also drive smokes
and appliance builds. A consumer needs far less. Each row below was measured by
running the case and removing flags until it broke:

| Doing this                                       | Minimum flags                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `.` — the driver                                 | `--allow-run=qemu-img`                                                                            |
| `./fs` — `buildGpt`, `buildTar`                  | none                                                                                              |
| `./testing` — `FakeQemuImg`                      | none                                                                                              |
| `./recipe` — planning only (`plan`, `recipeKey`) | none                                                                                              |
| `./recipe` — `resolveRecipe` + `build()`         | `--allow-run=qemu-img`, `--allow-read=<your inputs>`, `--allow-write=<store>,<output>`            |
| `./system` — booting the appliance               | the above plus `--allow-run=qemu-system-<arch>`, and read/write on the appliance and scratch dirs |

**The driver needs no file permissions at all.** `qemu-img` opens every image
itself as a subprocess, so Deno never touches them: creating and inspecting a
qcow2 was measured working under `--allow-run=qemu-img` alone. The builder does
need file access, because it reads your declared inputs to digest them and
writes the layer store — `resolveRecipe` fails without read, `build()` without
write, and both without run.

`plan()` is worth calling out: it is a pure function of a resolved recipe, so a
test that asserts partition geometry and cache keys needs **no permissions and
no `qemu-img`**.

If you install from JSR and call `readApplianceIdentity()`, it reads the
`appliance.lock.json` published alongside the module. That resolves to the
registry origin rather than a local file, so it needs `--allow-net` for that
origin — or pass `lockPath` to point at your own copy and it needs nothing.

## Sharp edges

`qemu-img` has invocations that fail silently rather than loudly. The rule here:
**an operation that yields a valid image holding less data than the one you
passed needs an explicit acknowledgement.** Only the empty-`backing` rebase is
shaped precisely enough to enforce that way; the rest are legitimate for some
caller and are documented instead. qemu-img behavior verified against 11.0.2;
the `go-qcow2reader` note is about Lima's pure-Go reader.

| Invocation                                            | What actually happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebase(…, { backing: "", unsafe: true })`            | **Refused** (`QemuImgUnsafeOperationError`). Drops the reference without copying the base down, so unwritten clusters read as zeros and `check()` still passes. Use safe mode or `convert()` — both need a readable base. When the base is gone (the usual reason to reach for this), pass `acknowledgeDataLoss`.                                                                                                                                                                               |
| `rebase(…, { backing: <other image>, unsafe: true })` | Equally unrecoverable, and **not** refused: the overlay is reinterpreted against a backing it was never built on. Only the empty spelling is shaped precisely enough to catch without opening the image.                                                                                                                                                                                                                                                                                        |
| `convert({ options: { compression_type: "zstd" } })`  | Valid qcow2, but pure-Go readers (Lima's `go-qcow2reader`) implement DEFLATE only. Use `compress: true`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `convert({ salvage: true })`                          | Read errors become zero-filled regions; still exits `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `convert()` from an `http(s)://` source               | Works, but a server that under-reports the object length truncates the output and still exits `0` (a stall or reset does fail loudly).                                                                                                                                                                                                                                                                                                                                                          |
| `check()`                                             | Validates structure, not completeness — a half-written image, or a copy short by less than one cluster, passes clean (VDI misses truncation entirely; raw has no check at all). Verify content with `compare()`.                                                                                                                                                                                                                                                                                |
| `resize(…, { shrink: true })`                         | Discards everything past the new end, including a GPT's backup header. Repair with `sgdisk -e` afterwards.                                                                                                                                                                                                                                                                                                                                                                                      |
| `resize()` GROWING a partitioned image                | Adds space **no partitioner can use**, and exits `0`. Measured on Alpine's aarch64 cloud image, `+1G`: the primary header at LBA 1 was untouched, so `AlternateLBA` and `LastUsableLBA` still named sector 503807 — the old end — the backup header stayed stranded there mid-disk, and the new final sector was all zeros. Linux still parsed the table and mounted both partitions, because it reads the primary. Repair the backup header at the new tail before treating the space as real. |
| `dd({ input, output })`                               | Overwrites an existing `output` in place, exit `0`, no warning.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Building images

`./recipe` turns a declared recipe into a chain of content-addressed qcow2
overlays. A recipe is a plain value — constructing one runs nothing.
`resolveRecipe()` replaces every declared input with its digest (the only I/O
before planning), `plan()` is then a deterministic function, and `build()`
executes it.

This one needs no VM. It runs anywhere `qemu-img` is installed:

```ts
import { QemuImg } from "jsr:@nullstyle/qemu-img";
import {
  build,
  defineRecipe,
  dir,
  LayerStore,
  LocalInputResolver,
  plan,
  resolveRecipe,
  VVFAT_USABLE_BYTES,
} from "jsr:@nullstyle/qemu-img/recipe";

const recipe = defineRecipe({
  name: "esp-only",
  platform: { arch: "aarch64", machine: "virt-11.0" },
  base: { kind: "blank", sizeBytes: 700 * 1024 * 1024 },
  boot: { kind: "uefi-removable" },
  determinism: { sourceDateEpoch: 1_700_000_000, guidSeed: "v1", fsSeed: "v1" },
  steps: [{
    kind: "partition",
    id: "table",
    partitions: [{
      label: "EFI",
      type: "esp",
      size: VVFAT_USABLE_BYTES[16], // vvfat's usable window, not the raw size
      contents: { kind: "fat", fatType: 16, label: "EFI", from: dir("./esp") },
    }],
  }],
});

const resolved = await resolveRecipe(recipe, {
  resolver: new LocalInputResolver(),
});
const planned = await plan(resolved);
console.log(planned.requiresAppliance); // false — GPT and FAT are host-side

const artifact = await build(planned, resolved, {
  store: new LayerStore("./cache"),
  output: "./disk.qcow2",
  qemu: new QemuImg(),
});
console.log(artifact.path, artifact.layers.length, artifact.cacheHits);
```

Steps run on one of three executors, and which one a step lands on is the whole
story for what you need installed:

| Executor | Used for                                  | Needs                                                             |
| -------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `image`  | the base image, plain `qemu-img` verbs    | `qemu-img`                                                        |
| `bytes`  | GPT tables, FAT filesystems               | `qemu-img` only — FAT comes from qemu's own `vvfat` driver        |
| `guest`  | ext4, `copyIn`, `run` — anything on Linux | a Linux VM. `plan()` reports this as `requiresAppliance === true` |

Check `planned.requiresAppliance` before you build. It is `false` for the recipe
above and for anything else that is only a table plus FAT, and `true` the moment
a recipe declares an ext4 filesystem or a `run` step.

### Producing an appliance

**A `guest` layer needs a Linux VM, and this package does not ship one.** The
appliance this repository builds is a kernel plus initramfs assembled from a
pinned Alpine ISO by `tools/build_appliance.ts` — a repo script, not part of the
published package, and `ApplianceGuestRunner` exists to boot the thing it
produces. Treat both as **repo-internal**. They are exported from `./system`
because `build()` and this repo's own smokes share them, not as an invitation:
the appliance is an untracked build product tied to the exact `/init` and
lockfile digests of one package version, so there is no appliance you can
download and no supported way to make one from the package alone.

The supported extension point is `BuildOptions.guest`, which takes anything
satisfying `GuestRunner` — a single method:

```ts
import type {
  GuestRunner,
  GuestStepRequest,
  GuestStepResult,
} from "jsr:@nullstyle/qemu-img/system";

class MyGuestRunner implements GuestRunner {
  async run(request: GuestStepRequest): Promise<GuestStepResult> {
    // Run `request.script` on a Linux box of your choosing with
    // `request.imagePath` attached, then report what happened.
    return {
      outcome: {
        code: 0,
        stage: "step",
        outputDigest: "",
        umountRc: 0,
        dmesgErrors: 0,
        detail: "",
      },
      console: "",
      elapsedMs: 0,
    };
  }
}

await build(planned, resolved, { store, output, guest: new MyGuestRunner() });
```

Whatever you run it on, the contract `build()` relies on is the one the
guest-tier table below documents: qemu's exit code is not the result, so
`outcome` has to carry the step's real exit code **and** the three independent
soundness signals (`umountRc`, `fsckRc`, `dmesgErrors`). A runner that reports
`code: 0` without checking the filesystem it produced will publish a broken
layer as a cache hit that every descendant trusts. If any signal fires,
`build()` throws `GuestStepFailedError` and the layer is never published.

Omit `guest` entirely and a plan containing a guest layer is **refused** with
`GuestExecutorUnavailableError` rather than skipped — though every layer before
it still builds, publishes and caches.

## Customizing an existing cloud image

`base: { kind: "image" }` starts from someone else's artifact instead of a blank
disk. Both fields are declared rather than probed, and both are checked before
anything is written:

```ts
const recipe = defineRecipe({
  name: "my-alpine",
  platform: { arch: "aarch64", machine: "virt-11.0" },
  base: {
    kind: "image",
    from: file("./generic_alpine-3.21.7-aarch64-uefi-cloudinit-r0.qcow2"),
    format: "qcow2",
    virtualSizeBytes: 257_949_696, // NOT the file's 225_378_304
    rootPartition: 2, // 1 is a 512 KiB FAT ESP
  },
  boot: { kind: "none" },
  determinism: { sourceDateEpoch: 1_700_000_000, guidSeed: "v1", fsSeed: "v1" },
  steps: [
    { kind: "copyIn", id: "app", from: dir("./app"), to: "/opt/app" },
    { kind: "run", id: "cfg", script: 'echo ok > "$QI_ROOT/etc/motd"\n' },
  ],
});
```

`virtualSizeBytes` lays nothing out — an image base is copied in whole, and a
`partition` step over one is refused, because a new GPT would discard the table
`rootPartition` points into. Its job is the assertion `build()` makes against
`qemu-img info`: that the file on disk is still the one the recipe was written
against. The file's own size is 12.6% smaller here, which is close enough to
look right, so a probe would not have been a safe default either.

The room you get is the room the image shipped with. Alpine's aarch64 cloud
image is 246 MiB with its root **89% full — about 35 MiB writable** — which is
enough for configuration and small payloads and not enough to install a runtime.
Growing it is not yet supported: see the `resize()` grow row above for what
actually goes wrong.

`deno task smoke:cloud` builds this end to end against a sha256-pinned image and
checks the property that matters for a customize flow — that the 5507 files it
never touched come through with an identical path set and digests.

### Sharp edges: the guest tier

`./recipe` and `./system` build images by booting a pinned Linux appliance for
the work the host cannot do. Measured against Alpine 3.21.7, kernel
6.12.81-0-virt, e2fsprogs 1.47.1, busybox 1.37.0, apk-tools 2.14.6 and qemu
11.0.2 on macOS-aarch64. Where a row says _unmeasured_, it is.

| Invocation                                                              | What actually happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusting qemu's exit code as the build result                           | A clean poweroff, a guest panic under `-no-reboot`, **and a failed step all exit `0`**. The outcome travels in a framed, fsynced status record instead — `kernel_power_off()` does not sync, so without `conv=fsync` a fast step's record is lost in the page cache.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `mke2fs` with no determinism flags                                      | Draws a random filesystem UUID and a random `dir_index` hash seed, and stamps wall-clock times. Two runs over identical inputs differ, so every descendant's key moves and the store thrashes. **Emitted by construction**: `E2FSPROGS_FAKE_TIME`, `-U` and `-E hash_seed`. Dropping `hash_seed` leaves 100 differing bytes; dropping `-U` leaves 558.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mke2fs` without `-b`                                                   | Picks its block size from **device size** — 1024 bytes on a 64 MiB partition, 4096 on a 1 GiB one — so growing a partition silently relays out the filesystem. `-b 4096` is always emitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mke2fs -E offset=N` on a whole disk                                    | Does not bound the write. A block count off by one yields a filesystem `blkid` calls ext4 and the kernel refuses to mount. **Never emitted**: the partition node is formatted, so the kernel enforces the end.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A read-write mount of an ext4 layer                                     | Stamps `s_mtime`, `s_wtime` and `s_mount_count`, and there is no way back — `tune2fs -C 0 -T` plus `debugfs` still left 111 bytes differing. Such a layer is _content_-reproducible but not _byte_-reproducible, so comparing digests across machines is not a valid check for it. Read-only mounts are byte-neutral.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hashing a guest layer's qcow2 **container**                             | Cluster and refcount ordering follows I/O completion order inside the guest, so two boots that write a byte-identical filesystem still produce different container bytes. Measured on one `mkfs` layer: at least four digests over the same content, same 2424832-byte length, `qemu-img compare --strict` identical on every pair — a byte-equality assertion over it was red on 5 runs in 10. A cache key chained through that rebuilds every descendant at random. **Keys chain `contentDigest()`**; the container digest is the store's tamper check and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `vvfat` over a freshly staged ESP tree                                  | Stamps the **host's** clock into the FAT directory entries, and `determinism.sourceDateEpoch` never reaches vvfat, which takes no time option. Closed in two halves, because one is not reachable from userspace: the staging copy pins mtime and atime, settling `DIR_WrtTime` and `DIR_LstAccDate`, and `normalizeFatTimestamps()` then rewrites `DIR_CrtTimeTenth`, `DIR_CrtTime`, `DIR_CrtDate` and `DIR_LstAccDate` in the finished filesystem — no call sets a birth time, so the creation fields have to be fixed after the convert. Before it, two cold builds seconds apart published **8 differing bytes under one realization key**, every one at offset 14 of a 32-byte directory entry; after it, 0, with a matching `contentSha256`. A FAT-carrying recipe now caches across stagings and across wall-clock time (measured); across **machines** it additionally requires an identical `qemu-img`, since vvfat's geometry and short-name generation are its own — that part is unmeasured. `copyIn` payloads, which this package archives itself, never had this problem. |
| A pipeline in a `run` script                                            | `$?` is the **last** command's status, so `apk add pkg \| tail` reports `0` for a failed install. The generated script sets `set -eu`, which does not cover this; busybox ash's `set -o pipefail` support is **unmeasured** and `set` is a special builtin, so a failed `set -o` would exit the shell even with `\|\| :`. Write `cmd > log 2>&1; rc=$?`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Mixing `-drive if=virtio` with `-device`                                | Every `-device` disk enumerates at a **lower** PCI slot than every `if=virtio` disk regardless of argv order, silently renumbering `vdX`. Measured: the guest read the 1 GiB target as its payload. Roles are resolved from `/sys/block/vd*/serial`, never from a position — and `-drive …,serial=` is a hard error on 11.0.2, so there is no half-migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A stale `.appliance/`                                                   | `/init` is this package's own code, baked into an untracked build product. An appliance predating a contract change would otherwise run the old contract and publish a wrong image under a right-looking key. **Detected**: the identity records the `/init` digest, the lockfile digest and the ABI, and every one is re-verified per build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `udhcpc` in a networked step                                            | There is no `af_packet` module in the initramfs, so DHCP dies in under a second with `Address family not supported by protocol`; slirp's own resolver at `10.0.2.3` never answers on qemu 11.0.2/macOS. Networked steps configure `10.0.2.15/24` statically and take a resolver the host names explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `chroot` into a root without its loader                                 | Fails with `chroot: can't execute '/bin/sh': No such file or directory` — which names a file that is right there, because `execve()` reports `ENOENT` for the missing INTERPRETER. Measured by hiding `/lib/ld-musl-aarch64.so.1` in a complete Alpine rootfs: rc 127, and the identical message for `/bin/busybox`, `/bin/sh` and `/sbin/apk`. **Diagnosed**: `run({ chroot: true })` probes with `sh -c :` first and, only on failure, exits 70 (no `/bin/sh`), 71 (no loader) or 72 (neither), naming the real cause. The probe runs first so a statically linked shell is never refused for lacking a loader it does not need.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `run({ chroot: true })` without a `/dev` bind                           | `apk add nginx` exits **`0`**, prints `OK: 9 MiB in 17 packages`, and leaves a 0-byte **regular file** at `/dev/null` (mode 0644) that a post-install script's `> /dev/null` created — after which every redirect in the shipped image appends to a file instead of discarding. **Always mounted**: `/proc`, `/sys`, and a bind of `/dev`, unmounted again before the step returns. No package in the measured set _failed_ without `/proc` or `/sys`; those two are prudence, the `/dev` bind is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A networked `chroot` step's `/etc/resolv.conf`                          | `/init` writes the resolver into the **initramfs**; a chrooted `apk` reads the **target's**, and Alpine's minirootfs ships no `/etc/resolv.conf` at all. So it has to be copied in — and without a restore the build host's resolver ships inside the image. **Saved and put back** (deleted, in the usual case) around the step, and `smoke:rootfs` asserts the file is absent from the finished artifact. The save tests `-e` **or** `-L`: every Debian and Ubuntu cloud image ships `/etc/resolv.conf` as a symlink into `/run` whose target does not exist until `systemd-resolved` runs, and `-e` alone is false for that — which skipped the save, wrote the host's resolver through the link, and deleted the image's own symlink on restore.                                                                                                                                                                                                                                                                                                                                    |
| `bsdtar --format ustar` for the `copyIn` payload                        | **Silently drops** any path it cannot split into prefix(155)/name(100) and still exits `0`; `--format pax` on macOS emits AppleDouble `._NAME` members that `bsdtar -tf` hides on read and the guest faithfully materializes. **Never used**: the archive is written in TypeScript, which throws where both of those drop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| An `unpack` of an **xz** archive                                        | **Refused** at plan time. busybox's xz reader does not stop at the end of the stream, so it runs into the zero padding qemu adds rounding a data disk up to 512 bytes: `tar -J` extracts every member correctly and _then_ exits `1` with `tar: corrupted data`, which reads as a damaged archive and is not one. Plain tar, gzip, bzip2 and lzma all exit `0` over the same transport (measured end to end); zstd has no applet in the appliance at all. A two-stage `dd` reading exactly `sizeBytes` fixed xz in a probe, so this is a limit of the transport, not of xz.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| An `unpack` without `--numeric-owner`                                   | busybox `tar` resolves each member's `uname`/`gname` against the **appliance's** `/etc/passwd` and `/etc/group` — the target's cannot be consulted, it is a mounted directory and not the running system — so the archive's numeric uid/gid is discarded wherever those names resolve here. The image builds, mounts and boots, wrongly owned. **Always emitted**: measured with an archive carrying uid/gid 123/456 under `uname=root`/`gname=root`, extraction as uid 0 gave `0:0` without the flag and `123:456` with it. Measured honored rather than read off `tar --help`, which in this applet advertises options it does not implement. `copyIn` deliberately does not pass it: `buildTar` writes uid/gid 0 with `uname`/`gname` "root", and both paths agree at `0:0`.                                                                                                                                                                                                                                                                                                         |
| An archive named `.tar.gz` that is really zstd                          | Would reach the guest, attach as a disk, boot a VM and fail on `tar`'s magic. **Refused on the host**: the resolver already reads the leading bytes to sniff them and `plan()` decides from those. The filename is never consulted — it is the one thing about an archive that is free to lie, and a block device has no filename for `tar -a` to read anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `-cpu host` on a native run                                             | Guest-visible CPU features vary with the host machine. `mke2fs` output was measured identical across boots on one host; **cross-host is unmeasured**, and the accelerator is deliberately not in the cache key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `base.rootPartition` naming the wrong partition                         | The image brought its own table, so there is no planned geometry to check it against the way a declared layout is. **Refused** before the mount: the node is waited for (`68`, listing the partitions that do exist), then `blkid` must report ext2/3/4 (`69` nothing recognizable, `70` something else, naming it). Ordering matters — registering the device for `/init`'s `e2fsck` epilogue first meant the checker also ran on Alpine's FAT ESP, reporting `Invalid argument` under twelve lines of superblock advice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `blkid -s TYPE -o value` in a guest script                              | busybox 1.37.0's applet takes `[BLOCKDEV]...` and nothing else. It **accepts both flags silently and prints the whole line anyway**, so the util-linux spelling yields `/dev/vda2: LABEL="/" … TYPE="ext4"` where `ext4` was expected — and a check comparing that against `ext4` rejects a good root. It also exits `0` on a device holding no filesystem, printing nothing, so the empty output is the signal and the status is not. The line is parsed instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `copyIn` into an existing cloud image                                   | Cloud images ship nearly full: Alpine's aarch64 root is **89% used, ~35 MiB writable as root**, on a 1024-byte-block ext4. An oversized tree fails as `tar: write error: No space left on device`. Loud and correct — the layer is never published and `e2fsck` still passes — so this is documented, not guarded: the archive's byte count is not the space it occupies once ext4 rounds each file up to a block, and a size precheck would refuse builds that fit. The script prints `df` beside the failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `base.virtualSizeBytes` declared larger                                 | **Refused** (`BaseImageSizeMismatchError`). A recipe has no other way to spell a grow, and growing is the last row of the table above — `resize()` adds space outside the GPT's usable range. The message says that, rather than reporting a generic mismatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A custom `GuestRunner` reporting its VM's exit status as `outcome.code` | The first row of this table applies to **your** runner too: a clean poweroff, a guest panic and a failed step are not distinguishable by exit status, so a runner that forwards it reports success for all three. `build()` cannot tell — it publishes the layer, and the key it publishes under is the one every descendant chains from. A runner must read the step script's own exit code and, for any filesystem it touched, run `e2fsck -fn` and scan dmesg, because `umountRc`, `fsckRc` and `dmesgErrors` are the three signals that catch a step which "succeeded" onto a filesystem that is not sound.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Stability

Pre-1.0: breaking changes ride a minor bump, and the subpaths are not equally
settled. What that means per export:

| Export          | Stability                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.`, `./runner` | **Settled.** The subcommand surface covers all of `qemu-img` and the argv shapes are pinned by tests; expect additions, not changes.                                                                                                                                                                                                             |
| `./testing`     | **Settled**, and tracks `.` — a new subcommand shows up in `FakeQemuImg` with it.                                                                                                                                                                                                                                                                |
| `./fs`          | **Settled.** Pure functions over bytes with no host dependency.                                                                                                                                                                                                                                                                                  |
| `./recipe`      | **In flux.** The recipe schema and the shape of a `Plan` are the newest surface here and the likeliest to move. Cache keys are explicitly not stable: a key change invalidates a store, it does not corrupt one.                                                                                                                                 |
| `./system`      | **In flux, and partly repo-internal.** `GuestRunner`, `GuestStepRequest`, `GuestStepResult` and `StepOutcome` are the seam and are meant to be implemented by callers. `ApplianceGuestRunner`, `readApplianceIdentity` and the identity record describe this repo's own build appliance — see [Producing an appliance](#producing-an-appliance). |

The guest wire ABI is versioned separately and independently of the package
version: `APPLIANCE_ABI` is checked on both sides of every boot, so a host and
an appliance that disagree refuse each other rather than negotiating.

## Compatibility

**Measured** against two qemu-img versions, on every push: CI runs the
real-binary smokes on `ubuntu-24.04` (qemu-utils, currently 8.2.x) and on
`macos-latest` (Homebrew, currently 11.x), so both ends of the supported range
are exercised by the same argv and the same parsers rather than asserted.

Versions **between** those two are expected to work and are not tested — the
argv shapes this package emits have been stable across the range, but nobody
runs 9.x or 10.x here. If you depend on one of those, run `deno task smoke`
against it; it is the same gate CI uses.

The macOS leg is not redundant with the Linux one. `deno task smoke:recipe`
validates a generated FAT against `/sbin/fsck_msdos` and a generated GPT against
`diskutil` — two parsers with no qemu code in them. On Linux both are skipped,
so that leg alone would be qemu checking qemu. Unit tests run anywhere Deno
runs, with no binary at all.

## License

Apache-2.0
