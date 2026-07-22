/**
 * The test kit: a recording, stateful fake of the `qemu-img` CLI.
 *
 * Inject {@linkcode FakeQemuImg} as the client's `runner` and assert exact
 * command sequences with {@linkcode FakeQemuImg.commandLines} — no `qemu-img`
 * binary needed.
 *
 * @example Drive the client against the fake
 * ```ts
 * import { QemuImg } from "@nullstyle/qemu-img";
 * import { FakeQemuImg } from "@nullstyle/qemu-img/testing";
 *
 * const fake = new FakeQemuImg();
 * fake.setImage("/tmp/disk.qcow2", { virtualSizeBytes: 1024 ** 3 });
 * const qemu = new QemuImg({ runner: fake });
 * const info = await qemu.info("/tmp/disk.qcow2");
 * console.log(info.virtualSizeBytes, fake.commandLines());
 * ```
 *
 * @module
 */

export {
  failed,
  type FakeConvert,
  type FakeCreate,
  type FakeExtent,
  type FakeImageState,
  FakeQemuImg,
  ok,
  type RecordedCall,
} from "./fake_qemu_img.ts";
