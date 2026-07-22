import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  CommandResult,
  CommandRunner,
  RunOptions,
} from "../../src/runner.ts";
import { CommandError } from "../../src/runner.ts";
import {
  QemuImgMissingError,
  QemuImgUnsafeOperationError,
} from "../../src/errors.ts";
import { QemuImg, renderBlockNode } from "../../src/qemu_img.ts";
import { failed, FakeQemuImg, ok } from "../../testing/mod.ts";

function client(): { qemu: QemuImg; fake: FakeQemuImg } {
  const fake = new FakeQemuImg();
  return { qemu: new QemuImg({ runner: fake }), fake };
}

/**
 * A runner that records the {@linkcode RunOptions} it was handed. The kit's
 * `RecordedCall` keeps only `stdin`, so the stream dispositions need their own
 * seam to be observable.
 */
class OptionRecordingRunner implements CommandRunner {
  readonly seen: RunOptions[] = [];

  run(
    _bin: string,
    _args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    this.seen.push(options);
    return Promise.resolve(ok("recorded"));
  }
}

/** A runner whose spawn always fails the way `Deno.Command` would. */
class UnspawnableRunner implements CommandRunner {
  constructor(private readonly error: Error) {}

  run(): Promise<CommandResult> {
    return Promise.reject(this.error);
  }
}

/** Argv for one call, with the fake short-circuited so only the shape matters. */
async function argvOf(
  drive: (qemu: QemuImg) => Promise<unknown>,
): Promise<string> {
  const fake = new FakeQemuImg();
  fake.stub(() => true, ok("{}"));
  await drive(new QemuImg({ runner: fake })).catch(() => {});
  return fake.commandLines()[0] ?? "";
}

Deno.test("available/ensureAvailable reflect the binary's presence", async () => {
  const { qemu, fake } = client();
  assertEquals(await qemu.available(), true);
  await qemu.ensureAvailable();
  fake.available = false;
  assertEquals(await qemu.available(), false);
  const error = await assertRejects(
    () => qemu.ensureAvailable(),
    QemuImgMissingError,
    "brew install qemu",
  );
  assertEquals(error.bin, "qemu-img");
});

Deno.test("version parses the fake's version output", async () => {
  const { qemu, fake } = client();
  fake.versionOutput = "qemu-img version 9.2.1";
  const version = await qemu.version();
  assertEquals(version, { raw: "9.2.1", major: 9, minor: 2, patch: 1 });
  assertEquals(fake.commandLines(), ["qemu-img --version"]);
});

Deno.test("version throws QemuImgMissingError when the binary is absent", async () => {
  const { qemu, fake } = client();
  fake.available = false;
  await assertRejects(() => qemu.version(), QemuImgMissingError);
});

Deno.test("a custom bin is used in every invocation", async () => {
  const fake = new FakeQemuImg();
  const qemu = new QemuImg({ runner: fake, bin: "/opt/qemu/bin/qemu-img" });
  assertEquals(qemu.bin, "/opt/qemu/bin/qemu-img");
  await qemu.available();
  assertEquals(fake.commandLines(), ["/opt/qemu/bin/qemu-img --version"]);
});

Deno.test("amend pins argv with sorted -o options and on/off booleans", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2");
  await qemu.amend("/img.qcow2", {
    format: "qcow2",
    force: true,
    options: { "lazy_refcounts": true, "compat": "1.1" },
  });
  assertEquals(fake.commandLines(), [
    "qemu-img amend -f qcow2 --force -o compat=1.1,lazy_refcounts=on /img.qcow2",
  ]);
});

Deno.test("bench pins argv and returns the report text", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.raw", { format: "raw" });
  const report = await qemu.bench("/img.raw", {
    count: 1000,
    depth: 4,
    format: "raw",
    offset: 4096,
    pattern: 0xcd,
    bufferSize: "64k",
    write: true,
    noDrain: true,
  });
  assertEquals(report, fake.benchOutput);
  assertEquals(fake.commandLines(), [
    "qemu-img bench -c 1000 -d 4 -f raw -o 4096 --pattern=205 -s 64k -w --no-drain /img.raw",
  ]);
});

Deno.test("bitmap add/remove/merge pin their argv shapes", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2");
  await qemu.bitmap("/img.qcow2", "dirty", {
    op: "add",
    granularity: 65536,
  });
  await qemu.bitmap("/img.qcow2", "dirty", { op: "disable" });
  await qemu.bitmap("/img.qcow2", "dirty", {
    op: "merge",
    source: "other",
    sourceFile: "/src.qcow2",
    sourceFormat: "qcow2",
  });
  await qemu.bitmap("/img.qcow2", "dirty", { op: "remove" }, {
    format: "qcow2",
  });
  assertEquals(fake.commandLines(), [
    "qemu-img bitmap --add -g 65536 /img.qcow2 dirty",
    "qemu-img bitmap --disable /img.qcow2 dirty",
    "qemu-img bitmap --merge other -b /src.qcow2 -F qcow2 /img.qcow2 dirty",
    "qemu-img bitmap -f qcow2 --remove /img.qcow2 dirty",
  ]);
});

Deno.test("check pins argv and returns a typed result", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2");
  const check = await qemu.check("/img.qcow2", {
    format: "qcow2",
    repair: "leaks",
  });
  assertEquals(check.code, 0);
  assertEquals(check.checkErrors, 0);
  assertEquals(fake.commandLines(), [
    "qemu-img check -f qcow2 -r leaks --output=json /img.qcow2",
  ]);
});

Deno.test("check treats exit 2/3 as data, other failures as errors", async () => {
  const { qemu, fake } = client();
  fake.stub(
    (call) => call.args[0] === "check",
    {
      success: false,
      code: 3,
      stdout: '{"leaks": 5, "check-errors": 0}',
      stderr: "",
    },
  );
  const leaky = await qemu.check("/img.qcow2");
  assertEquals(leaky.code, 3);
  assertEquals(leaky.leaks, 5);

  fake.stub((call) => call.args[0] === "check", failed(1, "cannot check"));
  await assertRejects(() => qemu.check("/img.qcow2"), CommandError);
});

Deno.test("commit pins argv and requires a backing file", async () => {
  const { qemu, fake } = client();
  fake.setImage("/overlay.qcow2", { backingFilename: "/base.qcow2" });
  await qemu.commit("/overlay.qcow2", {
    format: "qcow2",
    base: "/base.qcow2",
    drop: true,
    rate: 1048576,
  });
  assertEquals(fake.commandLines(), [
    "qemu-img commit -f qcow2 -b /base.qcow2 -d -r 1048576 /overlay.qcow2",
  ]);
  fake.setImage("/flat.qcow2");
  await assertRejects(
    () => qemu.commit("/flat.qcow2"),
    CommandError,
    "does not have a backing file",
  );
});

Deno.test("compare maps exit codes to identical/different and errors", async () => {
  const { qemu, fake } = client();
  fake.setImage("/a.raw", { format: "raw", virtualSizeBytes: 1024 });
  fake.setImage("/b.raw", { format: "raw", virtualSizeBytes: 1024 });
  fake.setImage("/c.raw", { format: "raw", virtualSizeBytes: 2048 });
  const same = await qemu.compare("/a.raw", "/b.raw", {
    format: "raw",
    formatB: "raw",
    strict: true,
  });
  assertEquals(same.identical, true);
  // Non-strict: a size mismatch with an all-zero tail is identical (real
  // qemu-img semantics; the fake models contentless images as zeros).
  const lax = await qemu.compare("/a.raw", "/c.raw");
  assertEquals(lax.identical, true);
  const different = await qemu.compare("/a.raw", "/c.raw", { strict: true });
  assertEquals(different.identical, false);
  await assertRejects(
    () => qemu.compare("/a.raw", "/missing.raw"),
    CommandError,
    "Could not open",
  );
  assertEquals(
    fake.commandLines()[0],
    "qemu-img compare -f raw -F raw -s /a.raw /b.raw",
  );
});

Deno.test("convert pins the full argv shape", async () => {
  const { qemu, fake } = client();
  fake.setImage("/src.raw", { format: "raw", virtualSizeBytes: 4096 });
  await qemu.convert("/src.raw", "/dst.qcow2", {
    sourceFormat: "raw",
    compress: true,
    format: "qcow2",
    options: { "cluster_size": 65536 },
    sparseSize: "4k",
  });
  assertEquals(fake.commandLines(), [
    "qemu-img convert -f raw -c -o cluster_size=65536 -S 4k -O qcow2 /src.raw /dst.qcow2",
  ]);
  assertEquals(fake.images.get("/dst.qcow2")?.format, "qcow2");
  assertEquals(fake.images.get("/dst.qcow2")?.virtualSizeBytes, 4096);
  assertEquals(fake.converts[0].compress, true);
});

Deno.test("convert accepts multiple sources (concatenation)", async () => {
  const { qemu, fake } = client();
  fake.setImage("/a.raw", { format: "raw", virtualSizeBytes: 100 });
  fake.setImage("/b.raw", { format: "raw", virtualSizeBytes: 200 });
  await qemu.convert(["/a.raw", "/b.raw"], "/joined.raw", { format: "raw" });
  assertEquals(fake.commandLines(), [
    "qemu-img convert -O raw /a.raw /b.raw /joined.raw",
  ]);
  assertEquals(fake.converts[0].sources, ["/a.raw", "/b.raw"]);
  assertEquals(fake.images.get("/joined.raw")?.virtualSizeBytes, 300);
});

Deno.test("convert -c is caller-controlled, never inferred", async () => {
  const { qemu, fake } = client();
  fake.setImage("/src.raw", { format: "raw" });
  await qemu.convert("/src.raw", "/dst.raw", { format: "raw" });
  assertEquals(fake.commandLines(), [
    "qemu-img convert -O raw /src.raw /dst.raw",
  ]);
});

Deno.test("create pins argv with backing, options, and size forms", async () => {
  const { qemu, fake } = client();
  await qemu.create("/new.qcow2", {
    format: "qcow2",
    size: "10G",
    options: { "cluster_size": 65536 },
  });
  await qemu.create("/overlay.qcow2", {
    format: "qcow2",
    backing: "/new.qcow2",
    backingFormat: "qcow2",
  });
  await qemu.create("/bytes.raw", { format: "raw", size: 1048576 });
  assertEquals(fake.commandLines(), [
    "qemu-img create -f qcow2 -o cluster_size=65536 /new.qcow2 10G",
    "qemu-img create -f qcow2 -b /new.qcow2 -F qcow2 /overlay.qcow2",
    "qemu-img create -f raw /bytes.raw 1048576",
  ]);
  assertEquals(fake.images.get("/new.qcow2")?.virtualSizeBytes, 10 * 1024 ** 3);
  assertEquals(
    fake.images.get("/overlay.qcow2")?.backingFilename,
    "/new.qcow2",
  );
});

Deno.test("dd pins argv and registers the output image", async () => {
  const { qemu, fake } = client();
  fake.setImage("/in.raw", { format: "raw", virtualSizeBytes: 512 });
  await qemu.dd({
    input: "/in.raw",
    output: "/out.qcow2",
    format: "raw",
    outputFormat: "qcow2",
    blockSize: "1M",
    count: 10,
    skip: 2,
  });
  assertEquals(fake.commandLines(), [
    "qemu-img dd -f raw -O qcow2 bs=1M count=10 skip=2 if=/in.raw of=/out.qcow2",
  ]);
  assertEquals(fake.images.get("/out.qcow2")?.format, "qcow2");
});

Deno.test("info pins argv and returns typed data", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2", { virtualSizeBytes: 2048 });
  const info = await qemu.info("/img.qcow2");
  assertEquals(info.format, "qcow2");
  assertEquals(info.virtualSizeBytes, 2048);
  assertEquals(fake.commandLines(), [
    "qemu-img info --output=json /img.qcow2",
  ]);
});

Deno.test("infoChain walks the backing chain", async () => {
  const { qemu, fake } = client();
  fake.setImage("/base.qcow2", { virtualSizeBytes: 1024 });
  fake.setImage("/overlay.qcow2", {
    virtualSizeBytes: 1024,
    backingFilename: "/base.qcow2",
  });
  const chain = await qemu.infoChain("/overlay.qcow2", { format: "qcow2" });
  assertEquals(chain.length, 2);
  assertEquals(chain[0].filename, "/overlay.qcow2");
  assertEquals(chain[1].filename, "/base.qcow2");
  assertEquals(fake.commandLines(), [
    "qemu-img info -f qcow2 --backing-chain --output=json /overlay.qcow2",
  ]);
});

Deno.test("map pins argv and returns extents", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.raw", { format: "raw", virtualSizeBytes: 4096 });
  const extents = await qemu.map("/img.raw", { format: "raw" });
  assertEquals(extents.length, 1);
  assertEquals(extents[0].length, 4096);
  assertEquals(fake.commandLines(), [
    "qemu-img map -f raw --output=json /img.raw",
  ]);
});

Deno.test("measure supports the --size and source forms, exactly one", async () => {
  const { qemu, fake } = client();
  const bySize = await qemu.measure({ outputFormat: "qcow2", size: "1G" });
  assertEquals(bySize.requiredBytes, 1024 ** 3);
  fake.setImage("/src.raw", { format: "raw", virtualSizeBytes: 555 });
  const bySource = await qemu.measure({
    outputFormat: "qcow2",
    source: "/src.raw",
    sourceFormat: "raw",
  });
  assertEquals(bySource.requiredBytes, 555);
  assertEquals(fake.commandLines(), [
    "qemu-img measure -O qcow2 --output=json --size 1G",
    "qemu-img measure -f raw -O qcow2 --output=json /src.raw",
  ]);
  await assertRejects(
    () => qemu.measure({ outputFormat: "qcow2" }),
    TypeError,
    "exactly one",
  );
  await assertRejects(
    () => qemu.measure({ outputFormat: "qcow2", size: 1, source: "/x" }),
    TypeError,
  );
});

Deno.test("rebase pins argv; empty backing removes the reference", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2", { backingFilename: "/old.qcow2" });
  // Unsafe re-pointing at a real file is legitimate: the base merely moved.
  await qemu.rebase("/img.qcow2", {
    format: "qcow2",
    unsafe: true,
    backing: "/new.qcow2",
    backingFormat: "qcow2",
  });
  assertEquals(fake.images.get("/img.qcow2")?.backingFilename, "/new.qcow2");
  // Safe mode flattens: the base's data is copied down first.
  await qemu.rebase("/img.qcow2", { backing: "" });
  assertEquals(fake.images.get("/img.qcow2")?.backingFilename, undefined);
  assertEquals(fake.commandLines(), [
    "qemu-img rebase -f qcow2 -u -b /new.qcow2 -F qcow2 /img.qcow2",
    "qemu-img rebase -b  /img.qcow2",
  ]);
});

Deno.test("rebase refuses unsafe + empty backing (silent data loss)", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2", { backingFilename: "/old.qcow2" });
  const error = await assertRejects(
    () => qemu.rebase("/img.qcow2", { backing: "", unsafe: true }),
    QemuImgUnsafeOperationError,
  );
  assertEquals(error.operation, "rebase");
  // The guard fires before the seam: nothing ran, the image is untouched.
  assertEquals(fake.commandLines(), []);
  assertEquals(fake.images.get("/img.qcow2")?.backingFilename, "/old.qcow2");
});

Deno.test("acknowledgeDataLoss opts back in to the guarded rebase", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2", { backingFilename: "/gone.qcow2" });
  // The canonical legitimate case: the base was deleted, so safe mode and
  // convert() cannot run at all — this pair is the only repair.
  await qemu.rebase("/img.qcow2", {
    backing: "",
    unsafe: true,
    acknowledgeDataLoss: true,
  });
  assertEquals(fake.images.get("/img.qcow2")?.backingFilename, undefined);
  // The opt-in changes nothing about the emitted argv.
  assertEquals(fake.commandLines(), ["qemu-img rebase -u -b  /img.qcow2"]);
});

Deno.test("convert omits -B for an empty backing (qemu-img segfaults on it)", async () => {
  const { qemu, fake } = client();
  fake.setImage("/src.qcow2", { virtualSizeBytes: 1024 });
  await qemu.convert("/src.qcow2", "/out.qcow2", {
    format: "qcow2",
    backing: "",
  });
  await qemu.convert("/src.qcow2", "/backed.qcow2", {
    format: "qcow2",
    backing: "/base.qcow2",
    backingFormat: "qcow2",
  });
  assertEquals(fake.commandLines(), [
    "qemu-img convert -O qcow2 /src.qcow2 /out.qcow2",
    "qemu-img convert -B /base.qcow2 -F qcow2 -O qcow2 /src.qcow2 /backed.qcow2",
  ]);
});

Deno.test("resize pins argv, honors deltas, and guards shrinks", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.raw", { format: "raw", virtualSizeBytes: 1024 ** 3 });
  await qemu.resize("/img.raw", "+1G");
  assertEquals(
    fake.images.get("/img.raw")?.virtualSizeBytes,
    2 * 1024 ** 3,
  );
  await assertRejects(
    () => qemu.resize("/img.raw", "1G"),
    CommandError,
    "--shrink",
  );
  await qemu.resize("/img.raw", "1G", {
    shrink: true,
    preallocation: "off",
    format: "raw",
  });
  assertEquals(fake.images.get("/img.raw")?.virtualSizeBytes, 1024 ** 3);
  assertEquals(fake.commandLines(), [
    "qemu-img resize /img.raw +1G",
    "qemu-img resize /img.raw 1G",
    "qemu-img resize -f raw --preallocation=off --shrink /img.raw 1G",
  ]);
});

Deno.test("snapshot ops pin argv and list via info", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2", { virtualSizeBytes: 1 });
  await qemu.snapshot.create("/img.qcow2", "clean");
  await qemu.snapshot.apply("/img.qcow2", "clean");
  const listed = await qemu.snapshot.list("/img.qcow2");
  assertEquals(listed.length, 1);
  assertEquals(listed[0].tag, "clean");
  await qemu.snapshot.delete("/img.qcow2", "clean");
  assertEquals(fake.images.get("/img.qcow2")?.snapshots.length, 0);
  assertEquals(fake.commandLines(), [
    "qemu-img snapshot -c clean /img.qcow2",
    "qemu-img snapshot -a clean /img.qcow2",
    "qemu-img info --output=json /img.qcow2",
    "qemu-img snapshot -d clean /img.qcow2",
  ]);
});

Deno.test("snapshot apply/delete on a missing tag fail loudly", async () => {
  const { qemu, fake } = client();
  fake.setImage("/img.qcow2");
  await assertRejects(
    () => qemu.snapshot.apply("/img.qcow2", "ghost"),
    CommandError,
    "Can't find the snapshot",
  );
});

Deno.test("raw passes argv through and returns the raw result", async () => {
  const { qemu, fake } = client();
  fake.stub((call) => call.args[0] === "weird", ok("custom output"));
  const result = await qemu.raw(["weird", "--flag"]);
  assert(result.success);
  assertEquals(result.stdout, "custom output");
  assertEquals(fake.commandLines(), ["qemu-img weird --flag"]);
});

Deno.test("renderBlockNode flattens children to dotted keys, sorted", () => {
  assertEquals(
    renderBlockNode({
      driver: "raw",
      offset: 1048576,
      size: 65536,
      file: { driver: "qcow2", file: { driver: "file", filename: "/d.qcow2" } },
    }),
    "driver=raw,file.driver=qcow2,file.file.driver=file," +
      "file.file.filename=/d.qcow2,offset=1048576,size=65536",
  );
  // Booleans render like qemu's other option lists.
  assertEquals(
    renderBlockNode({ driver: "vvfat", rw: true, "fat-type": 16 }),
    "driver=vvfat,fat-type=16,rw=on",
  );
});

Deno.test("convert splices an option-graph source into an option-graph window", async () => {
  const fake = new FakeQemuImg();
  fake.setImage("/disk.qcow2", { virtualSizeBytes: 1024 ** 3 });
  const qemu = new QemuImg({ runner: fake });
  await qemu.convert(
    { imageOpts: { driver: "vvfat", dir: "/staging", "fat-type": 16 } },
    {
      imageOpts: {
        driver: "raw",
        offset: 1048576,
        size: 528450048,
        file: {
          driver: "qcow2",
          file: { driver: "file", filename: "/disk.qcow2" },
        },
      },
    },
    { noCreate: true, parallel: 1 },
  );
  assertEquals(fake.commandLines(), [
    "qemu-img convert --image-opts -n -m 1 --target-image-opts " +
    "dir=/staging,driver=vvfat,fat-type=16 " +
    "driver=raw,file.driver=qcow2,file.file.driver=file," +
    "file.file.filename=/disk.qcow2,offset=1048576,size=528450048",
  ]);
});

Deno.test("renderBlockNode doubles commas so QemuOpts cannot re-split a value", () => {
  // qemu's QemuOpts parser splits on `,` and is last-wins WITHOUT a
  // diagnostic: measured on qemu-img 11.0.2, an unescaped window over
  // `/store,size=512/d.qcow2` reports `"virtual-size": 512` and exits 0.
  assertEquals(
    renderBlockNode({
      driver: "raw",
      offset: 0,
      size: 1048576,
      file: { driver: "file", filename: "/store,size=512/d.qcow2" },
    }),
    "driver=raw,file.driver=file," +
      "file.filename=/store,,size=512/d.qcow2,offset=0,size=1048576",
  );
  // A key holding a comma is escaped too: qemu then rejects the unknown
  // option by name instead of silently splitting it into two.
  assertEquals(
    renderBlockNode({ driver: "raw", "a,b": "c" }),
    "a,,b=c,driver=raw",
  );
  // Nothing else needs escaping — `=` splits on the first occurrence only and
  // newlines pass through literally, both verified against the same binary.
  assertEquals(
    renderBlockNode({ driver: "file", filename: "/eq=dir/d\nx.raw" }),
    "driver=file,filename=/eq=dir/d\nx.raw",
  );
});

Deno.test("-o option lists escape commas in keys and values", async () => {
  const { qemu, fake } = client();
  await qemu.create("/new.qcow2", {
    format: "qcow2",
    size: "1G",
    options: { backing_file: "/a,b/base.qcow2", backing_fmt: "qcow2" },
  });
  assertEquals(fake.commandLines(), [
    "qemu-img create -f qcow2 " +
    "-o backing_file=/a,,b/base.qcow2,backing_fmt=qcow2 /new.qcow2 1G",
  ]);
});

Deno.test("a leading-dash operand gets a -- separator, per verb", async () => {
  // qemu-img runs getopt_long per subcommand, so `-d.qcow2` is otherwise
  // consumed as flags and the verb dies with `invalid option -- d`.
  assertEquals(
    await argvOf((q) => q.create("-d.qcow2", { format: "qcow2", size: "1M" })),
    "qemu-img create -f qcow2 -- -d.qcow2 1M",
  );
  assertEquals(
    await argvOf((q) => q.info("-d.qcow2")),
    "qemu-img info --output=json -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.check("-d.qcow2")),
    "qemu-img check --output=json -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.map("-d.qcow2")),
    "qemu-img map --output=json -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.convert("-a.qcow2", "-b.raw", { format: "raw" })),
    "qemu-img convert -O raw -- -a.qcow2 -b.raw",
  );
  assertEquals(
    await argvOf((q) => q.compare("-a.raw", "-b.raw")),
    "qemu-img compare -- -a.raw -b.raw",
  );
  assertEquals(
    await argvOf((q) => q.measure({ outputFormat: "qcow2", source: "-s.raw" })),
    "qemu-img measure -O qcow2 --output=json -- -s.raw",
  );
  assertEquals(
    await argvOf((q) => q.snapshot.create("-d.qcow2", "tag")),
    "qemu-img snapshot -c tag -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.commit("-d.qcow2")),
    "qemu-img commit -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.rebase("-d.qcow2", { backing: "/b.qcow2" })),
    "qemu-img rebase -b /b.qcow2 -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.bench("-d.qcow2")),
    "qemu-img bench -- -d.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.amend("-d.qcow2", { options: { compat: "1.1" } })),
    "qemu-img amend -o compat=1.1 -- -d.qcow2",
  );
});

Deno.test("the bitmap NAME takes the separator; the snapshot TAG does not", async () => {
  // Measured on 11.0.2: `bitmap --add img.qcow2 -x` dies with
  // `invalid option -- x`, while `snapshot -c -x img.qcow2` creates a
  // snapshot tagged `-x` — the tag is getopt's own option-argument.
  assertEquals(
    await argvOf((q) => q.bitmap("/img.qcow2", "-bm", { op: "add" })),
    "qemu-img bitmap --add -- /img.qcow2 -bm",
  );
  assertEquals(
    await argvOf((q) => q.snapshot.create("/img.qcow2", "-tag")),
    "qemu-img snapshot -c -tag /img.qcow2",
  );
});

Deno.test("resize keeps a relative size out of the separator", async () => {
  // img_resize() pops the size off argv before getopt runs, precisely so a
  // negative delta survives; putting it after `--` would be harmless but
  // would churn the argv of every ordinary shrink.
  assertEquals(
    await argvOf((q) => q.resize("/img.raw", "-512M", { shrink: true })),
    "qemu-img resize --shrink /img.raw -512M",
  );
  assertEquals(
    await argvOf((q) => q.resize("-d.raw", "-512M", { shrink: true })),
    "qemu-img resize --shrink -- -d.raw -512M",
  );
});

Deno.test("ordinary operands emit no separator at all", async () => {
  assertEquals(
    await argvOf((q) => q.info("/img.qcow2")),
    "qemu-img info --output=json /img.qcow2",
  );
  assertEquals(
    await argvOf((q) => q.convert("/a.raw", "/b.raw", { format: "raw" })),
    "qemu-img convert -O raw /a.raw /b.raw",
  );
});

Deno.test("raw forwards the stdout/stderr dispositions", async () => {
  // The pipe-hang workaround documented on RunOptions.stdout is reachable
  // only through raw(); buildRunOptions used to drop both fields.
  const runner = new OptionRecordingRunner();
  const qemu = new QemuImg({ runner });
  await qemu.raw(["convert", "/a", "/b"], {
    stdout: "null",
    stderr: "inherit",
    stdin: "payload",
    uncapped: true,
    timeoutMs: 1234,
  });
  assertEquals(runner.seen[0].stdout, "null");
  assertEquals(runner.seen[0].stderr, "inherit");
  assertEquals(runner.seen[0].stdin, "payload");
  assertEquals(runner.seen[0].uncapped, true);
  assertEquals(runner.seen[0].timeoutMs, 1234);
  // Unset stays unset, so the runner's own "piped" default still applies.
  await qemu.raw(["--version"]);
  assertEquals("stdout" in runner.seen[1], false);
  assertEquals("stderr" in runner.seen[1], false);
});

Deno.test("available answers false for a binary that is not executable", async () => {
  // Deno.Command raises PermissionDenied (os error 13) for a file without
  // +x, and for a directory on PATH; only a missing file is NotFound.
  const noExec = new QemuImg({
    runner: new UnspawnableRunner(
      new Deno.errors.PermissionDenied("Failed to spawn: Permission denied"),
    ),
  });
  assertEquals(await noExec.available(), false);
  await assertRejects(() => noExec.ensureAvailable(), QemuImgMissingError);
  await assertRejects(() => noExec.version(), QemuImgMissingError);
});

Deno.test("available lets a missing --allow-run grant through", async () => {
  // Deno 2 reports that as NotCapable, a distinct class. Swallowing it would
  // send the caller off to reinstall QEMU for a flag they forgot to pass.
  const errors = Deno.errors as unknown as Record<string, ErrorConstructor>;
  const qemu = new QemuImg({
    runner: new UnspawnableRunner(
      new errors.NotCapable('Requires run access to "qemu-img"'),
    ),
  });
  await assertRejects(() => qemu.available(), Error, "Requires run access");
});

Deno.test("every verb maps an unspawnable binary to QemuImgMissingError", async () => {
  // The friendly mapping existed but only version()/available() used it, so
  // every other verb leaked a bare Deno.errors.NotFound.
  for (
    const spawnError of [
      new Deno.errors.NotFound("No such file or directory (os error 2)"),
      new Deno.errors.PermissionDenied("Permission denied (os error 13)"),
    ]
  ) {
    const qemu = new QemuImg({ runner: new UnspawnableRunner(spawnError) });
    const verbs: Record<string, () => Promise<unknown>> = {
      info: () => qemu.info("/i.qcow2"),
      infoChain: () => qemu.infoChain("/i.qcow2"),
      map: () => qemu.map("/i.qcow2"),
      check: () => qemu.check("/i.qcow2"),
      measure: () => qemu.measure({ outputFormat: "qcow2", size: "1G" }),
      create: () => qemu.create("/i.qcow2", { format: "qcow2", size: "1G" }),
      convert: () => qemu.convert("/a", "/b", { format: "raw" }),
      compare: () => qemu.compare("/a", "/b"),
      commit: () => qemu.commit("/i.qcow2"),
      amend: () => qemu.amend("/i.qcow2", { options: { compat: "1.1" } }),
      bench: () => qemu.bench("/i.qcow2"),
      bitmap: () => qemu.bitmap("/i.qcow2", "b", { op: "add" }),
      dd: () => qemu.dd({ input: "/a", output: "/b" }),
      rebase: () => qemu.rebase("/i.qcow2", { backing: "/b" }),
      resize: () => qemu.resize("/i.qcow2", "+1G"),
      snapshotCreate: () => qemu.snapshot.create("/i.qcow2", "t"),
      snapshotApply: () => qemu.snapshot.apply("/i.qcow2", "t"),
      snapshotDelete: () => qemu.snapshot.delete("/i.qcow2", "t"),
      snapshotList: () => qemu.snapshot.list("/i.qcow2"),
      raw: () => qemu.raw(["--version"]),
      version: () => qemu.version(),
    };
    for (const [name, call] of Object.entries(verbs)) {
      const error = await assertRejects(call, QemuImgMissingError);
      assertEquals(error.bin, "qemu-img", `${name} reported the wrong bin`);
    }
  }
});

Deno.test("check keeps the report qemu-img printed before exiting 1", async () => {
  // img_check() dumps the JSON and only then decides the status, so a run
  // whose internal check-errors are nonzero exits 1 with a full report. The
  // counters are the only record of what went wrong.
  const { qemu, fake } = client();
  fake.stub((call) => call.args[0] === "check", {
    success: false,
    code: 1,
    stdout: '{"check-errors": 4, "corruptions": 2, "filename": "/i.qcow2"}',
    stderr: "Check failed",
  });
  const result = await qemu.check("/i.qcow2");
  assertEquals(result.code, 1);
  assertEquals(result.checkErrors, 4);
  assertEquals(result.corruptions, 2);
});

Deno.test("check still throws on an exit that printed no report", async () => {
  // Measured on 11.0.2: a missing file, a wrong -f and a rejected header all
  // exit 1 with stdout completely empty, and raw exits 63.
  const { qemu, fake } = client();
  fake.stub(
    (call) => call.args[0] === "check",
    failed(1, "Could not open '/i.qcow2': No such file or directory"),
  );
  await assertRejects(() => qemu.check("/i.qcow2"), CommandError);
  fake.stub(
    (call) => call.args[0] === "check",
    failed(63, "This image format does not support checks"),
  );
  await assertRejects(() => qemu.check("/i.qcow2"), CommandError);
});

Deno.test("the option-graph guards refuse what qemu would reject later", async () => {
  const qemu = new QemuImg({ runner: new FakeQemuImg() });
  const graph = { imageOpts: { driver: "raw" as const } };
  // --target-image-opts without -n
  await assertRejects(
    () => qemu.convert("/a.raw", graph, {}),
    TypeError,
    "requires noCreate",
  );
  // --image-opts alongside a format flag
  await assertRejects(
    () => qemu.info(graph, { format: "raw" }),
    TypeError,
    "cannot combine an option graph with a format flag",
  );
  // one graph operand, one path
  await assertRejects(
    () => qemu.compare(graph, "/b.raw"),
    TypeError,
    "both operands",
  );
  // a path destination still needs a format
  await assertRejects(
    () => qemu.convert("/a.raw", "/b.raw", {}),
    TypeError,
    "needs a format",
  );
});
