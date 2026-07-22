/**
 * Run one step script inside the build appliance, against a target disk.
 *
 *     deno task appliance:run [--arch=aarch64|x86_64] [--target=disk.qcow2] step.sh
 *
 * This is the host half of the guest tier, in its simplest complete form:
 * frame the step script onto a payload disk, boot the appliance with the
 * target attached, and read the framed status record back.
 *
 * ## Why the status record, and not qemu's exit code
 *
 * qemu exits 0 for a clean poweroff, for a guest panic under `-no-reboot`,
 * AND for a step that failed and then powered off. The exit code cannot carry
 * the answer, so the guest writes `QIMG1\n<rc>\n<sha256 of output>\n` to a
 * dedicated disk and fsyncs it. A missing or malformed record means the guest
 * never reached its epilogue, which is a different failure from a step that
 * ran and returned nonzero — and this reports them differently.
 *
 * The guest runs with `-nic none`: a step that cannot reach the network is a
 * pure function of its inputs, which is what makes its result cacheable.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import { CommandAbortedError, DenoCommandRunner } from "../src/runner.ts";
import { type ApplianceArch, readLock } from "./build_appliance.ts";

/** Payload framing: sector 0 is the header, the script starts at byte 512. */
const PAYLOAD_MAGIC = "QIMG1";
const SECTOR = 512;

/** What the guest reported, parsed from the status disk. */
export interface StepOutcome {
  /** The step script's exit code. */
  readonly code: number;
  /** sha256 of everything the step wrote to stdout/stderr. */
  readonly outputDigest: string;
}

/**
 * Frame a step script for the payload disk: a header sector carrying the
 * magic and the byte length, then the script itself.
 *
 * The length is explicit because a block device read returns whole sectors:
 * without it the guest cannot tell the script's trailing bytes from the
 * padding, and a truncated read would look like a shorter script that
 * succeeded.
 */
export function framePayload(
  script: string,
  sizeBytes = 1024 * 1024,
): Uint8Array {
  const body = new TextEncoder().encode(script);
  const header = new TextEncoder().encode(
    `${PAYLOAD_MAGIC}\n${body.byteLength}\n`,
  );
  if (header.byteLength > SECTOR) throw new Error("payload header too large");
  if (SECTOR + body.byteLength > sizeBytes) {
    throw new Error(
      `step script is ${body.byteLength} bytes, too large for a ` +
        `${sizeBytes}-byte payload disk`,
    );
  }
  const payload = new Uint8Array(sizeBytes);
  payload.set(header, 0);
  payload.set(body, SECTOR);
  return payload;
}

/**
 * Parse the guest's status record. Throws when it is absent or malformed —
 * that means the guest died before its epilogue, which must never be
 * mistaken for a step that ran.
 */
export function parseStatus(bytes: Uint8Array): StepOutcome {
  const text = new TextDecoder().decode(bytes).replace(/\0+$/, "");
  const [magic, code, digest] = text.split("\n");
  if (magic !== PAYLOAD_MAGIC) {
    throw new Error(
      "the guest wrote no status record (found " +
        `${JSON.stringify(text.slice(0, 40))}). It panicked, hung, or was ` +
        "killed before its epilogue — qemu's own exit code cannot tell you " +
        "which, which is why this record exists.",
    );
  }
  if (!/^\d+$/.test(code ?? "")) {
    throw new Error(`status record has a malformed exit code: ${code}`);
  }
  return { code: Number(code), outputDigest: digest ?? "" };
}

if (import.meta.main) {
  const args = Deno.args;
  const arch = (args.find((a) => a.startsWith("--arch="))?.slice(7) ??
    Deno.build.arch) as ApplianceArch;
  const targetPath = args.find((a) => a.startsWith("--target="))?.slice(9);
  const scriptPath = args.find((a) => !a.startsWith("--"));
  if (scriptPath === undefined) {
    console.error(
      "usage: appliance_run.ts [--arch=…] [--target=disk.qcow2] <step.sh>",
    );
    Deno.exit(2);
  }

  const lock = await readLock("appliance.lock.json");
  const pins = lock.targets[arch];
  if (pins === undefined) throw new Error(`no pins for ${arch}`);

  const work = `.appliance/${arch}`;
  const kernel = `${work}/boot/vmlinuz-virt`;
  const initrd = `${work}/appliance.cpio.gz`;
  for (const required of [kernel, initrd]) {
    if (!(await Deno.stat(required).then(() => true).catch(() => false))) {
      console.error(
        `missing ${required} — build it first: deno task appliance --arch=${arch}`,
      );
      Deno.exit(1);
    }
  }

  const qemu = new QemuImg();
  const run = `${work}/run`;
  await Deno.mkdir(run, { recursive: true });
  const payload = `${run}/payload.raw`;
  const status = `${run}/status.raw`;
  const console_ = `${run}/console.log`;

  // A caller-supplied target is used in place; otherwise make a scratch one so
  // the command is runnable with nothing but a step script.
  const target = targetPath ?? `${run}/target.qcow2`;
  if (targetPath === undefined) {
    await Deno.remove(target).catch(() => {});
    await qemu.create(target, { format: "qcow2", size: "512M" });
  }

  await Deno.writeFile(
    payload,
    framePayload(await Deno.readTextFile(scriptPath)),
  );
  await Deno.writeFile(status, new Uint8Array(4096));

  // Same-arch guests accelerate; a cross-arch guest is emulated end to end and
  // is roughly an order of magnitude slower, so it gets a longer deadline.
  const native = arch === Deno.build.arch;
  const accel = native ? (Deno.build.os === "darwin" ? "hvf" : "kvm") : "tcg";
  const timeoutMs = native ? 120_000 : 600_000;

  const argv = [
    "-M",
    pins.machine,
    "-accel",
    accel,
    ...(native ? ["-cpu", "host"] : []),
    "-m",
    "1024",
    "-kernel",
    kernel,
    "-initrd",
    initrd,
    "-append",
    `console=${pins.console} qi.payload=/dev/vdb qi.status=/dev/vdc`,
    "-drive",
    `file=${target},if=virtio,format=qcow2`,
    "-drive",
    `file=${payload},if=virtio,format=raw`,
    "-drive",
    `file=${status},if=virtio,format=raw`,
    // No network: a step that cannot reach it is a pure function of its inputs.
    "-nic",
    "none",
    "-display",
    "none",
    "-no-reboot",
    // The console goes to a file, never through a pipe: a pipe would keep the
    // run alive for as long as any descendant holds its write end.
    "-serial",
    `file:${console_}`,
  ];

  console.log(`▸ booting the ${arch} appliance (${accel})`);
  const started = Date.now();
  const runner = new DenoCommandRunner();
  try {
    await runner.run(pins.qemu, argv, { timeoutMs, stdout: "null" });
  } catch (error) {
    if (error instanceof CommandAbortedError) {
      console.error(
        `✗ the guest did not power off within ${timeoutMs}ms — it hung.\n` +
          `  console: ${console_}`,
      );
      Deno.exit(1);
    }
    throw error;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const guestOutput = await Deno.readTextFile(console_).catch(() => "");
  const outcome = parseStatus(await Deno.readFile(status));
  const body = guestOutput
    .split("\n")
    .filter((line) => !line.startsWith("appliance:"))
    .join("\n")
    .trim();
  if (body.length > 0) console.log(body);

  if (outcome.code === 0) {
    console.log(`✓ step succeeded in ${elapsed}s`);
    console.log(`  target:  ${target}`);
    console.log(`  output:  sha256:${outcome.outputDigest.slice(0, 16)}…`);
  } else {
    console.error(`✗ step exited ${outcome.code} (after ${elapsed}s)`);
    console.error(`  console: ${console_}`);
    Deno.exit(outcome.code);
  }
}
