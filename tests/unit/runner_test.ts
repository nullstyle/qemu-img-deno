import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  CommandAbortedError,
  CommandError,
  DenoCommandRunner,
  runChecked,
} from "../../src/runner.ts";

Deno.test("echo round-trip: stdout captured, success true", async () => {
  const runner = new DenoCommandRunner();
  const result = await runner.run("echo", ["hello", "world"]);
  assertEquals(result.success, true);
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "hello world\n");
  assertEquals(result.stderr, "");
});

Deno.test("nonzero exit resolves without throwing", async () => {
  const runner = new DenoCommandRunner();
  const result = await runner.run("false", []);
  assertEquals(result.success, false);
  assertEquals(result.code, 1);
});

Deno.test("runChecked throws CommandError carrying bin/args/code", async () => {
  const runner = new DenoCommandRunner();
  const error = await assertRejects(
    () => runChecked(runner, "false", ["--flag"]),
    CommandError,
  );
  assertEquals(error.bin, "false");
  assertEquals(error.args, ["--flag"]);
  assertEquals(error.code, 1);
  assertStringIncludes(error.message, "false --flag");
});

Deno.test("stdin is piped to the child", async () => {
  const runner = new DenoCommandRunner();
  const result = await runner.run("cat", [], { stdin: "piped input" });
  assertEquals(result.stdout, "piped input");
});

Deno.test("capture cap bounds stdout byte-accurately; uncapped lifts it", async () => {
  const runner = new DenoCommandRunner({ captureLimit: 8 });
  const long = "a".repeat(64);
  const capped = await runner.run("echo", [long]);
  assertEquals(capped.stdout, "a".repeat(8));
  const uncapped = await runner.run("echo", [long], { uncapped: true });
  assertEquals(uncapped.stdout, `${long}\n`);
});

Deno.test("timeoutMs kills a hung child and throws CommandAbortedError", async () => {
  const runner = new DenoCommandRunner();
  const started = Date.now();
  const error = await assertRejects(
    () => runner.run("sleep", ["5"], { timeoutMs: 150 }),
    CommandAbortedError,
  );
  assert(Date.now() - started < 4_000, "abort must beat the child's exit");
  assertEquals(error.bin, "sleep");
});

Deno.test("stdin to a child that exits early resolves with its status (no broken-pipe throw, no leaked child)", async () => {
  const runner = new DenoCommandRunner();
  // `false` exits immediately without reading stdin; a large write hits a
  // closed pipe. The run must still resolve with the child's real status.
  const result = await runner.run("false", [], {
    stdin: "x".repeat(1 << 20),
  });
  assertEquals(result.success, false);
  assertEquals(result.code, 1);
});

Deno.test("a pre-aborted signal rejects before spawning", async () => {
  const runner = new DenoCommandRunner();
  const controller = new AbortController();
  controller.abort(new Error("already done"));
  await assertRejects(
    () => runner.run("sleep", ["5"], { signal: controller.signal }),
    CommandAbortedError,
  );
});
