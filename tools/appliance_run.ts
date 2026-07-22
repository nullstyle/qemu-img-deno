/**
 * Run one step script inside the build appliance, against a target disk.
 *
 *     deno task appliance:run [--arch=aarch64|x86_64] [--target=disk.qcow2] \
 *       [--scratch=<dir>] [--dns=<ip>] [--abi=<n>] step.sh
 *
 * This is a thin CLI over `ApplianceGuestRunner`. The framing codec, the disk
 * argv and the boot itself all live in `src/system/` now, so what this file
 * exercises is exactly what `build()` will: there is no second implementation
 * to drift.
 *
 * `--abi` exists only to prove the staleness tripwire. Booting with `--abi=99`
 * must come back as stage `abi`, rc 97 — a host that speaks a contract the
 * appliance does not is refused by the appliance, not silently accommodated.
 *
 * @module
 */

import { QemuImg } from "../src/qemu_img.ts";
import { APPLIANCE_ABI, stepNonce } from "../src/system/abi.ts";
import {
  type ApplianceArch,
  readApplianceIdentity,
} from "../src/system/identity.ts";
import { ApplianceGuestRunner } from "../src/system/appliance.ts";
import { StaleApplianceError } from "../src/system/errors.ts";

if (import.meta.main) {
  const args = Deno.args;
  const flag = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const arch = (flag("arch") ?? Deno.build.arch) as ApplianceArch;
  const targetPath = flag("target");
  const dns = flag("dns");
  const abiOverride = flag("abi");
  const scriptPath = args.find((a) => !a.startsWith("--"));
  if (scriptPath === undefined) {
    console.error(
      "usage: appliance_run.ts [--arch=…] [--target=disk.qcow2] " +
        "[--scratch=dir] [--dns=ip] [--abi=n] <step.sh>",
    );
    Deno.exit(2);
  }

  let identity;
  try {
    identity = await readApplianceIdentity({ arch });
  } catch (error) {
    if (error instanceof StaleApplianceError) {
      console.error(`✗ ${error.message}`);
      Deno.exit(1);
    }
    throw error;
  }

  const scratch = flag("scratch") ?? `.appliance/${arch}/run`;
  await Deno.mkdir(scratch, { recursive: true });

  const qemu = new QemuImg();
  // A caller-supplied target is used in place; otherwise make a scratch one so
  // the command is runnable with nothing but a step script.
  const target = targetPath ?? `${scratch}/target.qcow2`;
  if (targetPath === undefined) {
    await Deno.remove(target).catch(() => {});
    await qemu.create(target, { format: "qcow2", size: "512M" });
  }

  const script = await Deno.readTextFile(scriptPath);
  // The nonce is derived, not random, so a rerun of the same script against
  // the same scratch dir frames identically and stays diffable.
  const nonce = await stepNonce(identity.digest, scriptPath);

  const guest = new ApplianceGuestRunner({
    identity,
    ...(dns === undefined ? {} : { network: { dns } }),
    ...(abiOverride === undefined ? {} : { abi: Number(abiOverride) }),
  });

  console.log(`▸ booting the ${arch} appliance (${identity.machine})`);
  if (abiOverride !== undefined && abiOverride !== String(APPLIANCE_ABI)) {
    console.log(`  forcing qi.abi=${abiOverride} — expecting stage abi, rc 97`);
  }
  const result = await guest.run({
    stepId: scriptPath,
    imagePath: target,
    script,
    nonce,
    scratchDir: scratch,
    ...(dns === undefined ? {} : { network: true }),
  });

  const body = result.console
    .split("\n")
    .filter((line) => !line.startsWith("appliance:"))
    .join("\n")
    .trim();
  if (body.length > 0) console.log(body);

  const outcome = result.outcome;
  const elapsed = (result.elapsedMs / 1000).toFixed(1);
  if (outcome.code === 0 && outcome.stage === "step") {
    console.log(`✓ step succeeded in ${elapsed}s`);
    console.log(`  target:  ${target}`);
    console.log(`  output:  sha256:${outcome.outputDigest.slice(0, 16)}…`);
    console.log(
      `  umount=${outcome.umountRc} fsck=${outcome.fsckRc ?? "-"} ` +
        `dmesg=${outcome.dmesgErrors}`,
    );
  } else {
    console.error(
      `✗ step exited ${outcome.code} at stage ${outcome.stage} ` +
        `(after ${elapsed}s): ${outcome.detail}`,
    );
    console.error(`  console: ${scratch}/console.log`);
    Deno.exit(outcome.code);
  }
}
