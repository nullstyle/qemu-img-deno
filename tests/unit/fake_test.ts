import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { failed, FakeQemuImg, ok } from "../../testing/mod.ts";

/** Scratch under `tests/.tmp`, the only path `deno task test` may write. */
async function scratchDir(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

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

Deno.test("a declared map is answerable; compare and check never are", () => {
  const fake = new FakeQemuImg();
  fake.refuseContentOracles = true;
  fake.setImage("/stated.qcow2", {
    virtualSizeBytes: 4096,
    content: new Uint8Array([1, 2, 3, 4]),
  });
  fake.setImage("/other.qcow2", { virtualSizeBytes: 4096 });
  // Content the test stated is not fiction, so `map` may answer from it: four
  // bytes of data, then the zeros the rest of the disk reads as.
  const extents = JSON.parse(
    fake.dispatch({
      bin: "qemu-img",
      args: ["map", "--output=json", "/stated.qcow2"],
    }).stdout,
  );
  assertEquals(extents, [
    {
      start: 0,
      length: 4,
      depth: 0,
      present: true,
      zero: false,
      data: true,
      offset: 0,
    },
    {
      start: 4,
      length: 4092,
      depth: 0,
      present: true,
      zero: true,
      data: false,
    },
  ]);
  // …but `compare` and `check` have nothing to consult either way.
  assertThrows(
    () =>
      fake.dispatch({
        bin: "qemu-img",
        args: ["compare", "/stated.qcow2", "/other.qcow2"],
      }),
    Error,
    "would be fiction",
  );
  // An explicit extent list wins over the derivation.
  fake.setImage("/stated.qcow2", {
    extents: [{ start: 0, length: 4096, zero: true }],
  });
  assertEquals(
    JSON.parse(
      fake.dispatch({
        bin: "qemu-img",
        args: ["map", "--output=json", "/stated.qcow2"],
      }).stdout,
    ),
    [{
      start: 0,
      length: 4096,
      depth: 0,
      present: true,
      zero: true,
      data: false,
    }],
  );
});

Deno.test("a backing reference resolves against the overlay's own directory", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/store/layers/base/image.qcow2", { virtualSizeBytes: 2048 });
  const created = fake.dispatch({
    bin: "qemu-img",
    args: [
      "create",
      "-f",
      "qcow2",
      "-b",
      "../base/image.qcow2",
      "-F",
      "qcow2",
      "/store/layers/child.partial/image.qcow2",
    ],
  });
  assertEquals(created.success, true);
  const child = fake.images.get("/store/layers/child.partial/image.qcow2");
  // qcow2 records the reference as written; qemu-img opens the resolution.
  assertEquals(child?.backingFilename, "../base/image.qcow2");
  assertEquals(child?.backingPath, "/store/layers/base/image.qcow2");
  assertEquals(child?.virtualSizeBytes, 2048, "size comes from the backing");
  assertEquals(
    fake.creates[0].backingPath,
    "/store/layers/base/image.qcow2",
  );

  const info = JSON.parse(
    fake.dispatch({
      bin: "qemu-img",
      args: [
        "info",
        "--output=json",
        "/store/layers/child.partial/image.qcow2",
      ],
    }).stdout,
  );
  assertEquals(info["backing-filename"], "../base/image.qcow2");
  assertEquals(info["full-backing-filename"], "/store/layers/base/image.qcow2");
});

Deno.test("a backing reference that resolves nowhere fails, unless -u says not to look", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/store/layers/base/image.qcow2", { virtualSizeBytes: 2048 });
  // One directory too far up. Accepting this silently is how a test "proves" a
  // relative backing path is right when it is not — the overlay would then
  // read as zeros wherever it had not been written.
  const wrong = fake.dispatch({
    bin: "qemu-img",
    args: [
      "create",
      "-f",
      "qcow2",
      "-b",
      "../../base/image.qcow2",
      "/store/layers/child.partial/image.qcow2",
    ],
  });
  assertEquals(wrong.success, false);
  assertStringIncludes(wrong.stderr, "Could not open backing file");
  assertStringIncludes(wrong.stderr, "/store/base/image.qcow2");
  assertEquals(
    fake.images.has("/store/layers/child.partial/image.qcow2"),
    false,
  );

  // `-u` is qemu-img's own documented escape: it skips opening the backing.
  const unsafe = fake.dispatch({
    bin: "qemu-img",
    args: [
      "create",
      "-f",
      "qcow2",
      "-u",
      "-b",
      "../../base/image.qcow2",
      "/store/layers/child.partial/image.qcow2",
      "1M",
    ],
  });
  assertEquals(unsafe.success, true);
});

Deno.test("onCreate observes the decoded create and can fail it outright", () => {
  const fake = new FakeQemuImg();
  const seen: string[] = [];
  fake.onCreate = (create) => {
    seen.push(`${create.path}:${create.format}:${create.sizeBytes}`);
    return undefined;
  };
  fake.dispatch({
    bin: "qemu-img",
    args: [
      "create",
      "-f",
      "qcow2",
      "-o",
      "cluster_size=65536",
      "/a.qcow2",
      "1M",
    ],
  });
  assertEquals(seen, ["/a.qcow2:qcow2:1048576"]);
  assertEquals(fake.creates[0].options, "cluster_size=65536");
  assertEquals(fake.images.has("/a.qcow2"), true);

  fake.onCreate = () => failed(1, "No space left on device");
  const refused = fake.dispatch({
    bin: "qemu-img",
    args: ["create", "-f", "qcow2", "/b.qcow2", "1M"],
  });
  assertEquals(refused.success, false);
  assertEquals(
    fake.images.has("/b.qcow2"),
    false,
    "a failed create makes nothing",
  );
});

Deno.test("contentOf flattens the chain, child bytes over parent bytes", () => {
  const fake = new FakeQemuImg();
  fake.setImage("/base.qcow2", {
    virtualSizeBytes: 16,
    content: new Uint8Array([1, 1, 1, 1, 1, 1]),
  });
  fake.setImage("/mid.qcow2", {
    virtualSizeBytes: 16,
    backingFilename: "/base.qcow2",
    content: new Uint8Array([2, 2]),
  });
  fake.setImage("/top.qcow2", {
    virtualSizeBytes: 16,
    backingFilename: "/mid.qcow2",
  });
  // A qcow2 overlay is a delta in GUEST address space, so a child's bytes sit
  // over its parent's and the parent shows through past them.
  assertEquals(
    fake.contentOf("/top.qcow2"),
    new Uint8Array([2, 2, 1, 1, 1, 1]),
  );
  // A chain nobody declared content for has nothing to report — which is not
  // the same answer as "empty".
  fake.setImage("/bare.qcow2", { virtualSizeBytes: 16 });
  assertEquals(fake.contentOf("/bare.qcow2"), undefined);
});

Deno.test("materialize writes real files and follows one across a rename", async () => {
  const root = await scratchDir();
  try {
    const fake = new FakeQemuImg();
    fake.materialize = true;
    fake.setImage(`${root}/src.qcow2`, {
      virtualSizeBytes: 4096,
      content: new Uint8Array([9, 8, 7]),
    });
    // A raw conversion IS the guest address space, so it is extended (sparsely)
    // to the virtual size: the tail has to read as the zeros it would on a real
    // one.
    const converted = fake.dispatch({
      bin: "qemu-img",
      args: ["convert", "-O", "raw", `${root}/src.qcow2`, `${root}/out.raw`],
    });
    assertEquals(converted.success, true);
    assertEquals((await Deno.stat(`${root}/out.raw`)).size, 4096);
    const bytes = await Deno.readFile(`${root}/out.raw`);
    assertEquals(bytes.subarray(0, 3), new Uint8Array([9, 8, 7]));
    assertEquals(bytes.subarray(3).some((byte) => byte !== 0), false);

    // A qcow2 container is NOT its virtual size, so it is left as written.
    fake.dispatch({
      bin: "qemu-img",
      args: ["create", "-f", "qcow2", `${root}/fresh.qcow2`, "1G"],
    });
    assertEquals((await Deno.stat(`${root}/fresh.qcow2`)).size, 0);

    // The rename a layer store performs is invisible to an in-memory map, so
    // the file is matched by inode: same image, same declared size.
    await Deno.rename(`${root}/out.raw`, `${root}/published.raw`);
    const info = JSON.parse(
      fake.dispatch({
        bin: "qemu-img",
        args: ["info", "--output=json", `${root}/published.raw`],
      }).stdout,
    );
    assertEquals(info["virtual-size"], 4096);
    assertEquals(info.format, "raw");

    // A file the fake never wrote is openable but tells it nothing.
    await Deno.writeTextFile(`${root}/foreign.img`, "not ours");
    assert(
      fake.dispatch({
        bin: "qemu-img",
        args: ["info", "--output=json", `${root}/foreign.img`],
      }).success,
    );
    assertEquals(fake.contentOf(`${root}/foreign.img`), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
