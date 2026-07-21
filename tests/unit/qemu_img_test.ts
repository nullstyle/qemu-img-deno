import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { CommandError } from "../../src/runner.ts";
import {
  QemuImgMissingError,
  QemuImgUnsafeOperationError,
} from "../../src/errors.ts";
import { QemuImg } from "../../src/qemu_img.ts";
import { failed, FakeQemuImg, ok } from "../../testing/mod.ts";

function client(): { qemu: QemuImg; fake: FakeQemuImg } {
  const fake = new FakeQemuImg();
  return { qemu: new QemuImg({ runner: fake }), fake };
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
  assertStringIncludes(error.message, "reads back as zeros");
  // The guard fires before the seam: nothing ran, the image is untouched.
  assertEquals(fake.commandLines(), []);
  assertEquals(fake.images.get("/img.qcow2")?.backingFilename, "/old.qcow2");
  // raw() remains the documented escape hatch for callers who mean it.
  await qemu.raw(["rebase", "-u", "-b", "", "/img.qcow2"]);
  assertEquals(fake.commandLines(), ["qemu-img rebase -u -b  /img.qcow2"]);
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
