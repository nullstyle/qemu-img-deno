import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { failed, FakeQemuImg, ok } from "../../testing/mod.ts";

Deno.test("run records calls; commandLines flattens them", async () => {
  const fake = new FakeQemuImg();
  await fake.run("qemu-img", ["--version"]);
  await fake.run("qemu-img", ["info", "--output=json", "/x"], {});
  assertEquals(fake.commandLines(), [
    "qemu-img --version",
    "qemu-img info --output=json /x",
  ]);
});

Deno.test("available=false rejects with NotFound and records nothing", async () => {
  const fake = new FakeQemuImg();
  fake.available = false;
  await assertRejects(
    () => fake.run("qemu-img", ["--version"]),
    Deno.errors.NotFound,
  );
  assertEquals(fake.calls.length, 0);
});

Deno.test("stubs fire once, before the state machine", async () => {
  const fake = new FakeQemuImg();
  fake.setImage("/img.qcow2");
  fake.stub(
    (call) => call.args[0] === "info",
    failed(1, "injected"),
  );
  const first = await fake.run("qemu-img", [
    "info",
    "--output=json",
    "/img.qcow2",
  ]);
  assertEquals(first.success, false);
  assertEquals(first.stderr, "injected");
  const second = await fake.run("qemu-img", [
    "info",
    "--output=json",
    "/img.qcow2",
  ]);
  assertEquals(second.success, true);
});

Deno.test("dispatch does not record — the embedding fake owns the ledger", () => {
  const fake = new FakeQemuImg();
  const result = fake.dispatch({ bin: "qemu-img", args: ["--version"] });
  assertEquals(result.success, true);
  assertEquals(fake.calls.length, 0);
});

Deno.test("unknown subcommands fail loudly", () => {
  const fake = new FakeQemuImg();
  const result = fake.dispatch({ bin: "qemu-img", args: ["frobnicate"] });
  assertEquals(result.success, false);
  assertEquals(result.stderr.includes("unhandled subcommand"), true);
});

Deno.test("operating on unknown images fails like the real tool", () => {
  const fake = new FakeQemuImg();
  const result = fake.dispatch({
    bin: "qemu-img",
    args: ["info", "--output=json", "/missing.qcow2"],
  });
  assertEquals(result.success, false);
  assertEquals(result.stderr.includes("Could not open"), true);
});

Deno.test("onConvert can inject side effects and override the result", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/src.raw", { format: "raw" });
  const seen: string[] = [];
  fake.onConvert = (convert) => {
    seen.push(convert.dest);
    return undefined; // fall through to default success
  };
  const success = fake.dispatch({
    bin: "qemu-img",
    args: ["convert", "-O", "qcow2", "/src.raw", "/dst.qcow2"],
  });
  assertEquals(success.success, true);
  assertEquals(seen, ["/dst.qcow2"]);
  assertEquals(fake.images.has("/dst.qcow2"), true);

  fake.onConvert = () => failed(1, "disk full");
  const failure = fake.dispatch({
    bin: "qemu-img",
    args: ["convert", "-O", "qcow2", "/src.raw", "/dst2.qcow2"],
  });
  assertEquals(failure.success, false);
  assertEquals(fake.images.has("/dst2.qcow2"), false);
});

Deno.test("create/resize/rebase/bitmap/snapshot maintain coherent state", () => {
  const fake = new FakeQemuImg();
  fake.dispatch({
    bin: "qemu-img",
    args: ["create", "-f", "qcow2", "/disk.qcow2", "1G"],
  });
  const state = fake.images.get("/disk.qcow2")!;
  assertEquals(state.format, "qcow2");
  assertEquals(state.virtualSizeBytes, 1024 ** 3);

  fake.dispatch({
    bin: "qemu-img",
    args: ["resize", "/disk.qcow2", "+512M"],
  });
  assertEquals(state.virtualSizeBytes, 1024 ** 3 + 512 * 1024 ** 2);

  fake.dispatch({
    bin: "qemu-img",
    args: ["create", "-f", "qcow2", "-b", "/disk.qcow2", "/ov.qcow2"],
  });
  assertEquals(fake.images.get("/ov.qcow2")?.backingFilename, "/disk.qcow2");
  assertEquals(
    fake.images.get("/ov.qcow2")?.virtualSizeBytes,
    state.virtualSizeBytes,
  );

  fake.dispatch({
    bin: "qemu-img",
    args: ["rebase", "-u", "-b", "", "/ov.qcow2"],
  });
  assertEquals(fake.images.get("/ov.qcow2")?.backingFilename, undefined);

  fake.dispatch({
    bin: "qemu-img",
    args: ["bitmap", "--add", "/disk.qcow2", "dirty"],
  });
  assertEquals(state.bitmaps.has("dirty"), true);
  fake.dispatch({
    bin: "qemu-img",
    args: ["bitmap", "--remove", "/disk.qcow2", "dirty"],
  });
  assertEquals(state.bitmaps.has("dirty"), false);

  fake.dispatch({
    bin: "qemu-img",
    args: ["snapshot", "-c", "s1", "/disk.qcow2"],
  });
  fake.dispatch({
    bin: "qemu-img",
    args: ["snapshot", "-c", "s2", "/disk.qcow2"],
  });
  assertEquals(state.snapshots.map((snapshot) => snapshot.tag), ["s1", "s2"]);
  assertEquals(state.snapshots[0].id !== state.snapshots[1].id, true);
});

Deno.test("info --backing-chain walks links; ok/failed helpers shape results", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/base.qcow2", { virtualSizeBytes: 10 });
  fake.setImage("/mid.qcow2", {
    virtualSizeBytes: 10,
    backingFilename: "/base.qcow2",
  });
  fake.setImage("/top.qcow2", {
    virtualSizeBytes: 10,
    backingFilename: "/mid.qcow2",
  });
  const result = fake.dispatch({
    bin: "qemu-img",
    args: ["info", "--backing-chain", "--output=json", "/top.qcow2"],
  });
  const chain = JSON.parse(result.stdout) as { filename: string }[];
  assertEquals(chain.map((entry) => entry.filename), [
    "/top.qcow2",
    "/mid.qcow2",
    "/base.qcow2",
  ]);
  assertEquals(ok("x"), { success: true, code: 0, stdout: "x", stderr: "" });
  assertEquals(failed(7, "e"), {
    success: false,
    code: 7,
    stdout: "",
    stderr: "e",
  });
});

Deno.test("create accepts the long backing spellings and builds the right image", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/base.qcow2", { virtualSizeBytes: 1024 });
  fake.dispatch({
    bin: "qemu-img",
    args: [
      "create",
      "-f",
      "qcow2",
      "--backing",
      "/base.qcow2",
      "--backing-format",
      "qcow2",
      "/out.qcow2",
    ],
  });
  // Regression: these flags used to be skipped as unknown, so their values
  // became positionals — the fake registered an image at "/base.qcow2",
  // clobbered the real base, never created /out.qcow2, and returned exit 0.
  const out = fake.images.get("/out.qcow2");
  assertEquals(out?.backingFilename, "/base.qcow2");
  assertEquals(out?.backingFormat, "qcow2");
  assertEquals(out?.virtualSizeBytes, 1024, "size inherited from the backing");
  assertEquals(fake.images.get("/base.qcow2")?.virtualSizeBytes, 1024);
});

Deno.test("an unrecognized flag throws instead of mis-parsing positionals", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/x.qcow2");
  assertThrows(
    () =>
      fake.dispatch({
        bin: "qemu-img",
        args: ["create", "-f", "qcow2", "--not-a-flag", "value", "/y.qcow2"],
      }),
    Error,
    "unrecognized flag --not-a-flag",
  );
});

Deno.test("refuseContentOracles refuses the verbs the fake cannot honestly answer", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/a.qcow2");
  fake.setImage("/b.qcow2");
  fake.refuseContentOracles = true;
  for (
    const args of [
      ["compare", "/a.qcow2", "/b.qcow2"],
      ["check", "--output=json", "/a.qcow2"],
      ["map", "--output=json", "/a.qcow2"],
    ]
  ) {
    assertThrows(
      () => fake.dispatch({ bin: "qemu-img", args }),
      Error,
      "models no image content",
    );
  }
  // Everything else still works, so a suite can opt in wholesale.
  assertEquals(fake.dispatch({ bin: "qemu-img", args: ["--version"] }).code, 0);
});
