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

Deno.test("timeoutMs is a deadline even when a grandchild holds the stdout pipe", async () => {
  const runner = new DenoCommandRunner();
  const started = Date.now();
  await assertRejects(
    // `sleep` inherits the shell's stdout, so the pipe stays readable for the
    // full 5s after SIGTERM kills `sh`. Racing captured output instead of the
    // exit status would block here; the bare `sleep 5` above cannot show this
    // because it has no children.
    () => runner.run("sh", ["-c", "echo x; sleep 5"], { timeoutMs: 200 }),
    CommandAbortedError,
  );
  assert(
    Date.now() - started < 2_000,
    "the deadline must not wait on a grandchild's pipe",
  );
});

Deno.test("an aborted run reports the output it already captured", async () => {
  const runner = new DenoCommandRunner();
  const error = await assertRejects(
    () =>
      runner.run("sh", ["-c", "echo before-the-hang; sleep 5"], {
        timeoutMs: 200,
      }),
    CommandAbortedError,
  );
  // The last line before a hang usually names the thing that hung; discarding
  // it leaves a timeout with no diagnostics at all.
  assertEquals(error.stdout, "before-the-hang\n");
});

Deno.test("stdout disposition null avoids capture entirely", async () => {
  const runner = new DenoCommandRunner();
  const result = await runner.run("echo", ["unwanted"], { stdout: "null" });
  assertEquals(result.success, true);
  assertEquals(result.stdout, "");
});

Deno.test("a long timeoutMs leaves no pending timer once the run completes", async () => {
  const runner = new DenoCommandRunner();
  const started = Date.now();
  const result = await runner.run("echo", ["quick"], { timeoutMs: 120_000 });
  assertEquals(result.success, true);
  // The assertion that matters is Deno's own op sanitizer: an unreleased
  // deadline timer fails this test. `AbortSignal.timeout()` keeps a
  // REFERENCED timer, so a 120s deadline on a 300ms command used to hold the
  // whole process open for the remaining two minutes.
  assert(Date.now() - started < 5_000, "the run itself must not wait");
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

Deno.test("stdin larger than the pipe buffer does not deadlock", async () => {
  // The pipe buffer is ~64 KiB. Writing stdin to completion BEFORE draining
  // stdout deadlocks here: `cat` fills its stdout buffer, blocks writing, so
  // it stops reading stdin, so the parent blocks writing stdin — and no
  // timeout can rescue it, because the deadline races `child.status`, which
  // in that state never settles. 256 KiB is comfortably past the buffer.
  const runner = new DenoCommandRunner();
  // Past the ~64 KiB pipe buffer, but under the runner's capture cap so the
  // assertion below is about the deadlock and not about truncation.
  const payload = "x".repeat(256 * 1024);
  const started = Date.now();
  const result = await runner.run("cat", [], {
    stdin: payload,
    timeoutMs: 20_000,
    uncapped: true,
  });
  assertEquals(result.code, 0);
  assertEquals(result.stdout.length, payload.length, "all of stdin came back");
  assert(
    Date.now() - started < 15_000,
    "completed promptly rather than riding the deadline",
  );
});

Deno.test("a lingering grandchild cannot hang the call past its deadline", async () => {
  // The child exits at once, but the backgrounded `sleep` inherits its stdout
  // and holds the pipe open. Collection used to be unbounded, so `run()` hung
  // on a process that had already been reaped — while `timeoutMs` is
  // documented as a deadline for the whole call.
  const runner = new DenoCommandRunner();
  const started = Date.now();
  await assertRejects(
    () =>
      runner.run("sh", ["-c", "sleep 30 & echo done"], { timeoutMs: 1_500 }),
    CommandAbortedError,
  );
  const elapsed = Date.now() - started;
  assert(
    elapsed < 10_000,
    `honored the deadline rather than waiting for the grandchild (${elapsed}ms)`,
  );
});
