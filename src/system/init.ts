/**
 * The appliance `/init`, and the digest that makes host/guest skew detectable.
 *
 * This text is the source of truth for what the guest does. It lives in
 * `src/` rather than in `tools/build_appliance.ts` for one reason: the host
 * can then hash the `/init` it *expects* and compare it against the one the
 * appliance was actually built from. Without that comparison an edit here
 * meets an unrebuilt appliance in silence, and the build produces bytes
 * nobody's source tree describes — see {@link ./identity.ts}.
 *
 * There is no getty, no login and no shell prompt. Feeding a script into a
 * login prompt over serial races the getty and buffers its output, so a build
 * must never depend on prompt timing.
 *
 * @module
 */

import { sha256Hex } from "../digest.ts";

/**
 * The appliance `/init`, ABI 2. Its sha256 is the appliance's identity.
 *
 * Every applet it calls is in the measured busybox 1.37.0 list (`tac`,
 * `mountpoint`, `dmesg`, `grep -c -E`, `sha256sum`, `blockdev` included).
 * There is no `bash`, no GNU `tar`, no coreutils and no `sfdisk`/`partx` in
 * the appliance, so this is POSIX `ash`: no arrays, no `[[ ]]`, no process
 * substitution.
 *
 * Guest exit codes, all reported through the status frame's `stage` so they
 * cannot be confused with a step script's own code: `90` payload device never
 * appeared, `92` bad magic, `93` bad length, `94` empty script, `95` short
 * read, `96` unknown `qi.*` argument, `97` ABI mismatch, `98` role
 * unresolved, `99` nonce mismatch, `100` ext4 unregistered, `101` roles
 * inverted.
 *
 * No `set -o pipefail`: busybox ash treats `set` as a special builtin, so a
 * failed `set -o badopt` exits a non-interactive shell and `|| :` does not
 * save it — and whether 1.37.0 accepts `pipefail` at all is **unmeasured**.
 * A pipeline in a step script therefore reports its LAST command's status;
 * that is a documented hazard, not a papered-over one.
 */
export const APPLIANCE_INIT = `#!/bin/sh
# qemu-img build appliance init — ABI 2. Source of truth: src/system/init.ts.
export PATH=/bin:/sbin:/usr/bin:/usr/sbin
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /qi /mnt
: > /qi/fsck-devs
: > /qi/fsck.log
QI_STATUSDEV=""; QI_NONCE=""

# Called on every exit path. qemu exits 0 for a clean poweroff, a guest panic
# and a failed step alike, so its code cannot carry the answer — and
# kernel_power_off() does not sync, hence conv=fsync.
finish() {
  _rc=$1; _stage=$2; _dig=$3; _detail=$4
  _um=0
  # Reverse order: bind mounts under the root must go before the root itself.
  for _m in $(grep ' /mnt' /proc/mounts 2>/dev/null | cut -d' ' -f2 | tac); do
    umount "$_m" 2>/dev/null || _um=1
  done
  _fs='-'
  while read -r _d; do
    [ -b "$_d" ] || continue
    e2fsck -fn "$_d" >> /qi/fsck.log 2>&1
    _r=$?
    [ "$_fs" = '-' ] && _fs=0
    [ "$_r" -gt "$_fs" ] && _fs=$_r
  done < /qi/fsck-devs
  _dm=$(dmesg 2>/dev/null | grep -c -E 'EXT4-fs error|I/O error|Buffer I/O error')
  printf 'QIMG2\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \\
    "$QI_NONCE" "$_rc" "$_stage" "$_dig" "$_um" "$_fs" "$_dm" "$_detail" > /qi/status.bin
  [ -n "$QI_STATUSDEV" ] && dd if=/qi/status.bin of="$QI_STATUSDEV" conv=fsync 2>/dev/null
  sync
  echo "appliance: rc=$_rc stage=$_stage umount=$_um fsck=$_fs dmesg=$_dm $_detail"
  [ -s /qi/fsck.log ] && cat /qi/fsck.log
  poweroff -f
}

# CONFIG_VIRTIO_BLK=m — with no driver there are no block devices at all.
# ext4 is a module too, and /proc/filesystems carries ZERO block filesystems
# until it loads: \`mount -t ext4\` then fails on a perfect image, while mke2fs
# (pure userspace) succeeds anyway and puts the failure one step after its
# cause. virtio_pci is builtin; virtio_mmio is loaded for machines that use it.
for m in virtio_pci virtio_mmio virtio_blk ext4; do modprobe "$m" 2>/dev/null || true; done
mdev -s 2>/dev/null || true

# Resolve a role to a device by the DISK's own serial. Positional names are not
# stable: a \`-device\` disk enumerates ahead of every \`-drive if=virtio\` disk
# regardless of command-line order. Note the serial is on the disk itself —
# /sys/block/vdX/device/serial and wwid do not exist.
qi_resolve() {
  _want=$1; _hit=""; _n=0
  for _d in /sys/block/vd*; do
    [ -r "$_d/serial" ] || continue
    [ "$(cat "$_d/serial" 2>/dev/null)" = "$_want" ] || continue
    _hit="/dev/\${_d##*/}"; _n=$((_n+1))
  done
  [ "$_n" = 1 ] || return 1
  echo "$_hit"
}

QI_ABI=""; QI_PAYLOAD=""; QI_STATUS=""; QI_DATA=""; QI_DNS=""; QI_BAD=""
for arg in $(cat /proc/cmdline); do
  case "$arg" in
    qi.abi=*)     QI_ABI="\${arg#qi.abi=}" ;;
    qi.nonce=*)   QI_NONCE="\${arg#qi.nonce=}" ;;
    qi.payload=*) QI_PAYLOAD="\${arg#qi.payload=}" ;;
    qi.status=*)  QI_STATUS="\${arg#qi.status=}" ;;
    qi.data=*)    QI_DATA="\${arg#qi.data=}" ;;
    qi.dns=*)     QI_DNS="\${arg#qi.dns=}" ;;
    # No silent default: an unknown qi.* argument is a newer host meeting an
    # older init, which is exactly the skew that otherwise builds a wrong image.
    qi.*)         QI_BAD="$arg" ;;
    *) ;;
  esac
done

QI_STATUSDEV=$(qi_resolve "$QI_STATUS") || {
  echo "appliance: status role '$QI_STATUS' resolved to zero or many disks"; poweroff -f; }
[ -z "$QI_BAD" ] || finish 96 abi - "unknown-cmdline-arg:$QI_BAD"
[ "$QI_ABI" = "2" ] || finish 97 abi - "abi-mismatch:want-2-got-'$QI_ABI'"
grep -q ext4 /proc/filesystems || finish 100 ext4 - "ext4-not-registered"

QI_PAYLOADDEV=$(qi_resolve "$QI_PAYLOAD") || finish 98 roles - "payload-unresolved:$QI_PAYLOAD"
QI_TARGET=$(qi_resolve qimg-target) || finish 98 roles - "target-unresolved"
QI_DATADEV=""
if [ -n "$QI_DATA" ]; then
  QI_DATADEV=$(qi_resolve "$QI_DATA") || finish 98 roles - "data-unresolved:$QI_DATA"
fi

# A target carrying the payload magic means the roles inverted.
if dd if="$QI_TARGET" bs=512 count=1 2>/dev/null | tr -d '\\0' | grep -q '^QIMG2$'; then
  finish 101 roles - "target-carries-payload-magic"
fi

HDR=$(dd if="$QI_PAYLOADDEV" bs=512 count=1 2>/dev/null | tr -d '\\0')
MAGIC=$(echo "$HDR" | sed -n 1p)
LEN=$(echo "$HDR" | sed -n 2p)
PNONCE=$(echo "$HDR" | sed -n 3p)
[ "$MAGIC" = "QIMG2" ] || finish 92 payload - "bad-payload-magic:$MAGIC"
case "$LEN" in ''|*[!0-9]*) finish 93 payload - "bad-payload-length:$LEN" ;; esac
[ "$LEN" -gt 0 ] || finish 94 payload - "empty-step-script"
[ "$PNONCE" = "$QI_NONCE" ] || finish 99 payload - "payload-nonce-mismatch:$PNONCE"
dd if="$QI_PAYLOADDEV" bs=512 skip=1 2>/dev/null | dd bs=1 count="$LEN" 2>/dev/null > /qi/step.sh
GOT=$(wc -c < /qi/step.sh)
[ "$GOT" = "$LEN" ] || finish 95 payload - "short-read:$GOT-of-$LEN"

if [ -n "$QI_DNS" ]; then
  # DHCP is impossible here: there is no af_packet module anywhere in the
  # initramfs, so udhcpc dies in under a second with "Address family not
  # supported by protocol". slirp's own resolver at 10.0.2.3 never answers on
  # qemu 11.0.2/macOS, so the resolver is supplied by the host.
  modprobe virtio_net 2>/dev/null || true
  mdev -s 2>/dev/null || true
  ip link set eth0 up
  ip addr add 10.0.2.15/24 dev eth0
  ip route add default via 10.0.2.2
  echo "nameserver $QI_DNS" > /etc/resolv.conf
fi

# \`set -e\` is imposed here, not trusted to the generator: without it RC is the
# LAST command's status, so \`mke2fs … ; sync\` reports sync's 0 over a failed
# mkfs. Note this does NOT cover pipelines — see the hazard table.
export QI_TARGET
export QI_DATA="$QI_DATADEV"
{ echo 'set -eu'; cat /qi/step.sh; } > /qi/run.sh
echo "appliance: running $LEN-byte step script"
sh /qi/run.sh > /qi/out.log 2>&1
RC=$?
cat /qi/out.log
finish "$RC" step "$(sha256sum /qi/out.log | cut -d' ' -f1)" ok
`;

/** sha256 of {@linkcode APPLIANCE_INIT}. */
export function initDigest(): Promise<string> {
  return sha256Hex(APPLIANCE_INIT);
}
