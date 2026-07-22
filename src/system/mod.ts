/**
 * The guest tier: running one build step inside a throwaway Linux VM.
 *
 * This tier exists for exactly one reason. **ext4 creation needs a Linux
 * kernel executing target-architecture ELF** — `mke2fs` is userspace, but the
 * `e2fsck` that makes its output checkable, the kernel that parses the GPT it
 * formats into, and the mount that populates it are not. Everything the host
 * *can* do stays host-side by construction: GPT tables come from
 * `src/fs/gpt.ts` as bytes, and FAT filesystems come from qemu's own `vvfat`
 * driver. Only kernel filesystems leave the host.
 *
 * That boundary is a fact about the toolchain, not about the disk, which is
 * why a `partition` step carrying an ext4 window plans as two layers: the host
 * writes the table and every FAT filesystem, the guest formats the ext4
 * windows. It also puts a digest boundary between the two mechanisms, so the
 * mkfs layer's key contains the actual bytes of the GPT its kernel will parse.
 *
 * Nothing here imports `src/recipe/` — `build()` dispatches guest layers
 * through {@linkcode GuestRunner}, so the reverse edge would cycle.
 *
 * @example Run one step in the appliance
 * ```ts ignore
 * import {
 *   ApplianceGuestRunner,
 *   readApplianceIdentity,
 *   stepNonce,
 * } from "@nullstyle/qemu-img/system";
 *
 * const identity = await readApplianceIdentity({ arch: "aarch64" });
 * const guest = new ApplianceGuestRunner({ identity });
 * const result = await guest.run({
 *   stepId: "table:mkfs",
 *   imagePath: "store/layers/abc.partial/image.qcow2",
 *   script: "echo hi\n",
 *   nonce: await stepNonce("abc", "table:mkfs"),
 *   scratchDir: "store/layers/abc.partial",
 * });
 * console.log(result.outcome.code, result.outcome.stage);
 * ```
 *
 * @module
 */

export {
  APPLIANCE_ABI,
  FRAME_MAGIC,
  framePayload,
  type FramePayloadOptions,
  type FsckVerdict,
  fsckVerdict,
  type GuestStage,
  parseStatus,
  type ParseStatusExpectation,
  SECTOR,
  STATUS_BYTES,
  stepNonce,
  type StepOutcome,
} from "./abi.ts";

export { APPLIANCE_INIT, initDigest } from "./init.ts";

export {
  type ApplianceArch,
  type ApplianceIdentity,
  type ApplianceIdentityRecord,
  DEFAULT_LOCK_URL,
  IDENTITY_FILE,
  readApplianceIdentity,
  type ReadApplianceIdentityOptions,
  writeApplianceIdentity,
} from "./identity.ts";

export {
  DISK_SERIALS,
  diskArgs,
  type DiskAttachment,
  type DiskRole,
  SERIAL_MAX_BYTES,
} from "./devices.ts";

export {
  copyInScript,
  type CopyInScriptArgs,
  type MkfsPartition,
  mkfsScript,
  type MkfsScriptArgs,
  runScript,
  type RunScriptArgs,
} from "./script.ts";

export {
  ApplianceGuestRunner,
  type ApplianceOptions,
  type GuestNetworkOptions,
  type GuestRunner,
  type GuestStepRequest,
  type GuestStepResult,
} from "./appliance.ts";

export {
  GuestBootError,
  GuestNetworkUnavailableError,
  GuestStatusError,
  type GuestStatusErrorOptions,
  type GuestStatusFault,
  GuestStepFailedError,
  GuestTimeoutError,
  InvalidGuestDnsError,
  PayloadFrameError,
  type PayloadFrameFault,
  StaleApplianceError,
  type StaleApplianceField,
} from "./errors.ts";
