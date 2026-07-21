# @nullstyle/qemu-img

> **Status: 0.1.0.** Pre-1.0 — breaking changes ride a minor bump.

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

## Compatibility

Exercised against qemu-img 8.x–11.x (the release smoke last ran against 11.0.2);
the argv shapes it emits are stable across that range. The real-binary smoke
(`deno task smoke`, with qemu installed) validates every parser against real
output and is the release gate; unit tests run anywhere Deno runs.

## License

Apache-2.0
