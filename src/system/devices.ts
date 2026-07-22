/**
 * Disk attachment: roles, serials, and the qemu argv that carries them.
 *
 * **Disks are addressed by identity. Positional addressing is removed
 * entirely**, and that is a measurement rather than a preference. With six
 * `-drive if=virtio` disks, `vda..vdf` matched argv order exactly — so
 * positional addressing works right up until anything is spelled differently.
 * Mix the spellings and every `-device` disk lands at a *lower* PCI slot than
 * every `if=virtio` disk regardless of argv position:
 *
 * ```text
 * [0.163328] virtio_blk virtio0: [vda] 2048 512-byte logical blocks    <- payload
 * [0.165465] virtio_blk virtio2: [vdc] 2097152 512-byte logical blocks <- TARGET, read as payload
 * ```
 *
 * The guest read the 1 GiB target as its payload and fsynced its status record
 * onto an unrelated scratch disk. There is also no incremental migration
 * available: `-drive file=…,if=virtio,serial=…` is a **hard error** on qemu
 * 11.0.2 (`Block format 'raw' does not support the option 'serial'`), so this
 * module emits `-blockdev` + `-device virtio-blk-pci` and nothing else.
 *
 * The guest resolves a role by scanning each `/sys/block/vd*` disk's own
 * `serial` file, which depends on nothing but sysfs. Note the serial is on the
 * **disk**, not under `device/`: `/sys/block/vdX/device/serial` and `wwid` do
 * not exist. `/dev/disk/by-id/virtio-<serial>` also works
 * and is deliberately unused: it is produced by `/lib/mdev/persistent-storage`,
 * a file that comes from *Alpine's* initramfs rather than this appliance's
 * overlay.
 *
 * @module
 */

/** A disk's role. The guest resolves these by serial, never by position. */
export type DiskRole = "target" | "payload" | "status" | "data";

/** `qimg-target`, … — the guest matches `/sys/block/vd*` serials against these. */
export const DISK_SERIALS: Readonly<Record<DiskRole, string>> = {
  target: "qimg-target",
  payload: "qimg-payload",
  status: "qimg-status",
  data: "qimg-data",
};

/** virtio-blk caps `serial` at VIRTIO_BLK_ID_BYTES. */
export const SERIAL_MAX_BYTES = 20;

/** One disk to attach to the guest. */
export interface DiskAttachment {
  /** What the guest will use it for. */
  readonly role: DiskRole;
  /** Host path to the backing file. */
  readonly path: string;
  /** Image format. Always explicit — qemu must never probe a build artifact. */
  readonly format: "qcow2" | "raw";
  /** Attach the disk read-only. @default false */
  readonly readOnly?: boolean;
  /**
   * Emit `logical_block_size`/`physical_block_size`.
   *
   * The appliance has **never been booted with a 4096-byte logical-sector
   * disk**; the emission is specified and unit-tested, the guest path is
   * unmeasured. @default 512
   */
  readonly sectorSize?: 512 | 4096;
}

/**
 * qemu argv for one disk: a file blockdev, a format blockdev, and a
 * `virtio-blk-pci` device carrying the role as its serial.
 *
 * `virtio-blk-pci` is the single spelling for both `-M virt` and `-M q35` —
 * on `-M virt` the transport is virtio-PCI, not mmio (the guest device path is
 * `…/pcie/pci0000:00/0000:00:01.0/virtio0/block/vda`).
 */
export function diskArgs(disk: DiskAttachment): string[] {
  const serial = DISK_SERIALS[disk.role];
  const bytes = new TextEncoder().encode(serial).byteLength;
  if (bytes > SERIAL_MAX_BYTES) {
    throw new Error(
      `disk serial ${JSON.stringify(serial)} is ${bytes} bytes; virtio-blk ` +
        `caps VIRTIO_BLK_ID_BYTES at ${SERIAL_MAX_BYTES}. qemu would ` +
        "truncate it silently and the guest would resolve the role to zero " +
        "disks — or, worse, to the wrong one. Shorten the serial.",
    );
  }
  // The role doubles as the node-name stem; `[a-z]+` is a valid qemu id.
  const node = disk.role;
  const sectorSize = disk.sectorSize ?? 512;
  const blockSize = sectorSize === 4096
    ? ",logical_block_size=4096,physical_block_size=4096"
    : "";
  // Read-only is declared on BOTH nodes. qemu refuses a writable format node
  // over a read-only protocol node, so setting it on one alone either fails to
  // open or fails to protect.
  const ro = disk.readOnly === true ? "on" : "off";
  return [
    "-blockdev",
    `driver=file,node-name=${node}f,filename=${escapeOptionValue(disk.path)},` +
    `read-only=${ro}`,
    "-blockdev",
    `driver=${disk.format},node-name=${node},file=${node}f,read-only=${ro}`,
    "-device",
    `virtio-blk-pci,drive=${node},serial=${serial}${blockSize}`,
  ];
}

/**
 * Escape a value for qemu's `QemuOpts` parser, which splits on `,`.
 *
 * A literal comma has to be doubled. Without this, a store rooted anywhere
 * with a comma in its path — a project directory, a home directory — emits a
 * `-blockdev` that qemu parses as an unknown trailing option and refuses to
 * start on, on every guest layer.
 */
function escapeOptionValue(value: string): string {
  return value.replaceAll(",", ",,");
}
