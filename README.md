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

| Invocation                                            | What actually happens                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebase(…, { backing: "", unsafe: true })`            | **Refused** (`QemuImgUnsafeOperationError`). Drops the reference without copying the base down, so unwritten clusters read as zeros and `check()` still passes. Use safe mode or `convert()` — both need a readable base. When the base is gone (the usual reason to reach for this), pass `acknowledgeDataLoss`. |
| `rebase(…, { backing: <other image>, unsafe: true })` | Equally unrecoverable, and **not** refused: the overlay is reinterpreted against a backing it was never built on. Only the empty spelling is shaped precisely enough to catch without opening the image.                                                                                                          |
| `convert({ options: { compression_type: "zstd" } })`  | Valid qcow2, but pure-Go readers (Lima's `go-qcow2reader`) implement DEFLATE only. Use `compress: true`.                                                                                                                                                                                                          |
| `convert({ salvage: true })`                          | Read errors become zero-filled regions; still exits `0`.                                                                                                                                                                                                                                                          |
| `convert()` from an `http(s)://` source               | Works, but a server that under-reports the object length truncates the output and still exits `0` (a stall or reset does fail loudly).                                                                                                                                                                            |
| `check()`                                             | Validates structure, not completeness — a half-written image, or a copy short by less than one cluster, passes clean (VDI misses truncation entirely; raw has no check at all). Verify content with `compare()`.                                                                                                  |
| `resize(…, { shrink: true })`                         | Discards everything past the new end, including a GPT's backup header. Repair with `sgdisk -e` afterwards.                                                                                                                                                                                                        |
| `dd({ input, output })`                               | Overwrites an existing `output` in place, exit `0`, no warning.                                                                                                                                                                                                                                                   |

## Compatibility

Exercised against qemu-img 8.x–11.x (the release smoke last ran against 11.0.2);
the argv shapes it emits are stable across that range. The real-binary smoke
(`deno task smoke`, with qemu installed) validates every parser against real
output and is the release gate; unit tests run anywhere Deno runs.

## License

Apache-2.0
