# @nullstyle/qemu-img

> **Status: 0.2.1.** Pre-1.0 — breaking changes ride a minor bump.

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

| Layer           | Export          | What it does                                                                                                                        |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Client          | `.` (`QemuImg`) | Drives the `qemu-img` CLI: every subcommand, pinned argv shapes, typed results for the JSON forms (`info`/`check`/`map`/`measure`). |
| Subprocess seam | `./runner`      | The injectable `CommandRunner` everything flows through.                                                                            |
| Test kit        | `./testing`     | `FakeQemuImg`: a recording, stateful in-memory qemu-img. Your tests assert exact argv with no binary installed.                     |

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
6.12.81-0-virt, e2fsprogs 1.47.1, busybox 1.37.0 and qemu 11.0.2 on
macOS-aarch64. Where a row says _unmeasured_, it is.

| Invocation                                       | What actually happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusting qemu's exit code as the build result    | A clean poweroff, a guest panic under `-no-reboot`, **and a failed step all exit `0`**. The outcome travels in a framed, fsynced status record instead — `kernel_power_off()` does not sync, so without `conv=fsync` a fast step's record is lost in the page cache.                                                                                                                                                                                                                                                                                                       |
| `mke2fs` with no determinism flags               | Draws a random filesystem UUID and a random `dir_index` hash seed, and stamps wall-clock times. Two runs over identical inputs differ, so every descendant's key moves and the store thrashes. **Emitted by construction**: `E2FSPROGS_FAKE_TIME`, `-U` and `-E hash_seed`. Dropping `hash_seed` leaves 100 differing bytes; dropping `-U` leaves 558.                                                                                                                                                                                                                     |
| `mke2fs` without `-b`                            | Picks its block size from **device size** — 1024 bytes on a 64 MiB partition, 4096 on a 1 GiB one — so growing a partition silently relays out the filesystem. `-b 4096` is always emitted.                                                                                                                                                                                                                                                                                                                                                                                |
| `mke2fs -E offset=N` on a whole disk             | Does not bound the write. A block count off by one yields a filesystem `blkid` calls ext4 and the kernel refuses to mount. **Never emitted**: the partition node is formatted, so the kernel enforces the end.                                                                                                                                                                                                                                                                                                                                                             |
| A read-write mount of an ext4 layer              | Stamps `s_mtime`, `s_wtime` and `s_mount_count`, and there is no way back — `tune2fs -C 0 -T` plus `debugfs` still left 111 bytes differing. Such a layer is _content_-reproducible but not _byte_-reproducible, so comparing digests across machines is not a valid check for it. Read-only mounts are byte-neutral.                                                                                                                                                                                                                                                      |
| Hashing a guest layer's qcow2 **container**      | Cluster and refcount ordering follows I/O completion order inside the guest, so two boots that write a byte-identical filesystem still produce different container bytes. Measured on one `mkfs` layer: at least four digests over the same content, same 2424832-byte length, `qemu-img compare --strict` identical on every pair — a byte-equality assertion over it was red on 5 runs in 10. A cache key chained through that rebuilds every descendant at random. **Keys chain `contentDigest()`**; the container digest is the store's tamper check and nothing else. |
| `vvfat` over a freshly staged ESP tree           | Stamps the **host's** mtimes into the FAT directory entries — re-staging identical content moves the layer's content (measured: 6 bytes), and every key above it. `determinism.sourceDateEpoch` does not reach vvfat, which takes no time option. A FAT-carrying recipe therefore caches within one staging, **not** across machines; `copyIn` payloads, which this package archives itself, do not have this problem.                                                                                                                                                     |
| A pipeline in a `run` script                     | `$?` is the **last** command's status, so `apk add pkg \| tail` reports `0` for a failed install. The generated script sets `set -eu`, which does not cover this; busybox ash's `set -o pipefail` support is **unmeasured** and `set` is a special builtin, so a failed `set -o` would exit the shell even with `\|\| :`. Write `cmd > log 2>&1; rc=$?`.                                                                                                                                                                                                                   |
| Mixing `-drive if=virtio` with `-device`         | Every `-device` disk enumerates at a **lower** PCI slot than every `if=virtio` disk regardless of argv order, silently renumbering `vdX`. Measured: the guest read the 1 GiB target as its payload. Roles are resolved from `/sys/block/vd*/serial`, never from a position — and `-drive …,serial=` is a hard error on 11.0.2, so there is no half-migration.                                                                                                                                                                                                              |
| A stale `.appliance/`                            | `/init` is this package's own code, baked into an untracked build product. An appliance predating a contract change would otherwise run the old contract and publish a wrong image under a right-looking key. **Detected**: the identity records the `/init` digest, the lockfile digest and the ABI, and every one is re-verified per build.                                                                                                                                                                                                                              |
| `udhcpc` in a networked step                     | There is no `af_packet` module in the initramfs, so DHCP dies in under a second with `Address family not supported by protocol`; slirp's own resolver at `10.0.2.3` never answers on qemu 11.0.2/macOS. Networked steps configure `10.0.2.15/24` statically and take a resolver the host names explicitly.                                                                                                                                                                                                                                                                 |
| `chroot` into a freshly built root               | Fails with `chroot: can't execute '/bin/busybox': No such file or directory` — which names the binary, not the missing `/lib/ld-musl-*.so.1` that actually caused it. `run` steps therefore do not chroot; the target is mounted at `$QI_ROOT`.                                                                                                                                                                                                                                                                                                                            |
| `bsdtar --format ustar` for the `copyIn` payload | **Silently drops** any path it cannot split into prefix(155)/name(100) and still exits `0`; `--format pax` on macOS emits AppleDouble `._NAME` members that `bsdtar -tf` hides on read and the guest faithfully materializes. **Never used**: the archive is written in TypeScript, which throws where both of those drop.                                                                                                                                                                                                                                                 |
| `-cpu host` on a native run                      | Guest-visible CPU features vary with the host machine. `mke2fs` output was measured identical across boots on one host; **cross-host is unmeasured**, and the accelerator is deliberately not in the cache key.                                                                                                                                                                                                                                                                                                                                                            |
| `base.rootPartition` naming the wrong partition  | The image brought its own table, so there is no planned geometry to check it against the way a declared layout is. **Refused** before the mount: the node is waited for (`68`, listing the partitions that do exist), then `blkid` must report ext2/3/4 (`69` nothing recognizable, `70` something else, naming it). Ordering matters — registering the device for `/init`'s `e2fsck` epilogue first meant the checker also ran on Alpine's FAT ESP, reporting `Invalid argument` under twelve lines of superblock advice. |
| `blkid -s TYPE -o value` in a guest script       | busybox 1.37.0's applet takes `[BLOCKDEV]...` and nothing else. It **accepts both flags silently and prints the whole line anyway**, so the util-linux spelling yields `/dev/vda2: LABEL="/" … TYPE="ext4"` where `ext4` was expected — and a check comparing that against `ext4` rejects a good root. It also exits `0` on a device holding no filesystem, printing nothing, so the empty output is the signal and the status is not. The line is parsed instead.                                                         |
| `copyIn` into an existing cloud image            | Cloud images ship nearly full: Alpine's aarch64 root is **89% used, ~35 MiB writable as root**, on a 1024-byte-block ext4. An oversized tree fails as `tar: write error: No space left on device`. Loud and correct — the layer is never published and `e2fsck` still passes — so this is documented, not guarded: the archive's byte count is not the space it occupies once ext4 rounds each file up to a block, and a size precheck would refuse builds that fit. The script prints `df` beside the failure.            |
| `base.virtualSizeBytes` declared larger          | **Refused** (`BaseImageSizeMismatchError`). A recipe has no other way to spell a grow, and growing is the last row of the table above — `resize()` adds space outside the GPT's usable range. The message says that, rather than reporting a generic mismatch.                                                                                                                                                                                                                                                             |

## Compatibility

Exercised against qemu-img 8.x–11.x (the release smoke last ran against 11.0.2);
the argv shapes it emits are stable across that range. The real-binary smoke
(`deno task smoke`, with qemu installed) validates every parser against real
output and is the release gate; unit tests run anywhere Deno runs.

## License

Apache-2.0
