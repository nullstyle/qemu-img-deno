/**
 * The recipe vocabulary: plain values describing an image to build.
 *
 * Constructing a {@linkcode Recipe} runs nothing. It is data, so it can be
 * shared, parameterized, diffed, and unit-tested without a binary, a VM, or a
 * network.
 *
 * @module
 */

import type { CapabilityTrait } from "./errors.ts";

/** Guest architecture. Selects the EFI fallback filename and console device. */
export type GuestArch = "aarch64" | "x86_64";

/** The machine a built image targets. */
export interface Platform {
  /** Guest architecture. */
  readonly arch: GuestArch;
  /**
   * Logical sector size every partition table is built for. An image laid out
   * for 512 and later attached at 4096 has every offset wrong and presents as
   * a blank disk — so this is part of the cache key, not a detail.
   * @default 512
   */
  readonly sectorSize?: 512 | 4096;
  /**
   * QEMU machine type, when the recipe pins one.
   *
   * Must be VERSIONED (`"virt-11.0"`, not `"virt"`): a bare alias resolves to
   * whatever the installed qemu calls current, silently changing ACPI and
   * device enumeration across a `brew upgrade` while the cache key — which
   * records only the string — stays put.
   */
  readonly machine?: string;
}

/** A host file whose CONTENT, never its mtime, contributes to the key. */
export interface FileInput {
  /** Discriminant. */
  readonly kind: "file";
  /** Path to the file. */
  readonly path: string;
}

/** A host directory tree, hashed as a canonical sorted walk. */
export interface DirInput {
  /** Discriminant. */
  readonly kind: "dir";
  /** Path to the staging tree. */
  readonly path: string;
}

/** Anything a step can read. */
export type Input = FileInput | DirInput;

/**
 * How an archive handed to an `unpack` step is compressed.
 *
 * DETECTED from the file's leading magic bytes by the resolver, never inferred
 * from its name: a `.tar.gz` that is really zstd is a real thing, and the guest
 * would fail on it with `gzip: invalid magic` after the disk was attached and
 * the VM booted. Sniffing costs four bytes of a file the resolver already reads
 * in full to hash.
 *
 * `zstd` and `xz` are listed so the refusals can NAME them, for two different
 * measured reasons — see {@link ../system/script.ts}'s `GUEST_TAR_FLAG`. Both
 * are refused at plan time rather than after a boot.
 */
export type ArchiveCompression =
  | "none"
  | "gzip"
  | "bzip2"
  | "xz"
  | "lzma"
  | "zstd";

/** Declare a host file input. */
export function file(path: string): FileInput {
  return { kind: "file", path };
}

/** Declare a host directory input. */
export function dir(path: string): DirInput {
  return { kind: "dir", path };
}

/**
 * Every value that would otherwise be random or clock-derived.
 *
 * No field has a default. A build step must never generate a random value, and
 * the cheapest place to enforce that is a required field — which is also what
 * lets content reproducibility be the default rather than an aspiration.
 */
export interface DeterminismPolicy {
  /** Stamped into generated structures in place of the wall clock. */
  readonly sourceDateEpoch: number;
  /** Seed every GPT disk and partition GUID is derived from by hashing. */
  readonly guidSeed: string;
  /** Seed filesystem volume IDs and serials are derived from by hashing. */
  readonly fsSeed: string;
}

/** A GPT partition type. Named types serialize to their spec GUID. */
export type PartitionType = "esp" | "linux-root" | "linux-generic";

/** What lives inside a partition. */
export type FilesystemSpec =
  | {
    /**
     * FAT synthesized by qemu's `vvfat` driver from a host directory.
     *
     * vvfat's geometry is FIXED and content-independent: `fatType: 16` yields
     * exactly 528450048 usable bytes, `fatType: 12` yields 32997888. The
     * partition must be that size EXACTLY, and both directions are refused at
     * plan time with the figures — a smaller window truncates a filesystem
     * whose BPB claims the full size, and a larger one is a window qemu-img
     * refuses to open at all. `fatType: 32` is refused outright — qemu's vvfat
     * FAT32 output is a FAT16-shaped BPB with a doubled allocation table,
     * which conformant drivers misread.
     *
     * A consequence worth stating: neither figure is a multiple of 4096, so a
     * FAT partition cannot be laid out on a `sectorSize: 4096` disk at all.
     */
    readonly kind: "fat";
    readonly from: DirInput;
    readonly fatType: 12 | 16;
    /** Volume label, at most 11 bytes. */
    readonly label: string;
  }
  | {
    /**
     * ext4, created in the guest appliance. There is no host-side path: ext4
     * creation needs a Linux kernel executing target-architecture ELF.
     *
     * Deliberately has no `from`. The layer that creates an ext4 filesystem
     * formats it and does nothing else, so a staging tree declared here would
     * produce an empty filesystem that mounts and passes `e2fsck` while
     * holding none of it. Populate it with a `copyIn` step, which is a layer of
     * its own and can say whether it worked. A `from` property reaching this
     * arm from untyped JavaScript is refused at plan time rather than ignored.
     */
    readonly kind: "ext4";
    /** Volume label, stamped by `mke2fs -L`. */
    readonly label: string;
  }
  | { readonly kind: "empty" };

/** One partition in a declared GPT. */
export interface PartitionSpec {
  /** Partition name (GPT stores it as UTF-16LE, at most 36 code units). */
  readonly label: string;
  /** Partition type. */
  readonly type: PartitionType;
  /**
   * Size in bytes, or `"rest"` to fill the remaining space.
   *
   * Deliberately NOT named `sizeBytes`, unlike {@linkcode BaseSpec}'s
   * `sizeBytes` and `virtualSizeBytes`. It is a size *specification* rather
   * than a byte count, and a name promising bytes would be a lie in the
   * `"rest"` case — the direction this package refuses everywhere else. The
   * three names were weighed against a unifying rename and kept: the base's
   * two are also not interchangeable, since `virtualSizeBytes` is an assertion
   * about a file that already exists and is explicitly not its size on disk.
   *
   * A byte count here is rounded UP to the sector size, so the partition is
   * never smaller than asked. A `"rest"` partition must be the last declared.
   */
  readonly size: number | "rest";
  /** Contents. */
  readonly contents: FilesystemSpec;
}

/** How the built image boots. */
export type BootSpec =
  | {
    /**
     * UEFI removable-media fallback. Refused unless the ESP's staging tree
     * holds `/EFI/BOOT/BOOTAA64.EFI` (aarch64) or `/EFI/BOOT/BOOTX64.EFI`
     * (x86_64).
     *
     * That path is the only one independent of an NVRAM `Boot####` entry —
     * and NVRAM lives in a per-run vars file OUTSIDE the image, so an image
     * that boots only because `efibootmgr` ran is not a reproducible artifact.
     */
    readonly kind: "uefi-removable";
  }
  | {
    /** The image is not expected to boot on its own (a data disk). */
    readonly kind: "none";
  };

/** One build step. */
export type Step =
  | {
    /** Lay down a GPT and populate its partitions. */
    readonly kind: "partition";
    readonly id: string;
    readonly partitions: readonly PartitionSpec[];
    /**
     * Bytes reserved before the first partition. Never defaults to the legacy
     * LBA 63: 1 MiB alignment is what every modern producer emits, and the
     * 31.5 KiB the old value leaves is smaller than a GRUB2 core image.
     * @default 1048576
     */
    readonly firstPartitionOffset?: number;
  }
  | {
    /** Run a shell script inside the guest appliance. */
    readonly kind: "run";
    readonly id: string;
    /** The script, run with `sh`. */
    readonly script: string;
    /**
     * Whether this step needs the network. Off by default: a step that cannot
     * reach the network is a pure function of its declared inputs, which is
     * what makes its result safely cacheable. A step that opts in is marked
     * uncacheable, and so is everything downstream of it.
     */
    readonly network?: boolean;
    /**
     * Run the script INSIDE the target root rather than beside it.
     *
     * Off: the target is mounted at `$QI_ROOT` and the script runs on the
     * appliance's own busybox. On: `/proc`, `/sys` and a bind of `/dev` are
     * mounted under the root and the script runs under `chroot`, so a package
     * manager installed in the target manages the target.
     *
     * The `/dev` bind is not a nicety. **Measured**: `apk add nginx` in a
     * chroot with no `/dev` exits `0` and leaves a *regular file* at
     * `/dev/null` — a post-install script's `> /dev/null` created it — which
     * every later redirect in the shipped image then appends to.
     *
     * With `network`, the resolver `/init` configured is copied to
     * `$QI_ROOT/etc/resolv.conf` for the duration of the step and removed (or
     * restored) afterwards, so the build host's resolver does not ship inside
     * the image.
     */
    readonly chroot?: boolean;
  }
  | {
    /** Copy a host tree into the image, in the guest. */
    readonly kind: "copyIn";
    readonly id: string;
    readonly from: DirInput;
    /** Absolute destination path inside the image's root filesystem. */
    readonly to: string;
  }
  | {
    /**
     * Extract a host archive into the image, in the guest.
     *
     * This is how a distro rootfs gets in. It is a STEP and not a `base`,
     * because layer 0 is the disk: a rootfs goes into a partition that does
     * not exist until the table has been written and the mkfs layer has run.
     *
     * The host never decompresses. The archive is attached to the guest as
     * the data disk exactly as `copyIn`'s generated ustar is, and busybox
     * `tar` reads the raw block device — measured at 0.05 s for the 3.8 MiB
     * Alpine minirootfs, with the tar's own two-zero-block trailer ending the
     * read before the padding.
     */
    readonly kind: "unpack";
    readonly id: string;
    /** The archive. Digest-pinned by the resolver, which also sniffs it. */
    readonly from: FileInput;
    /** Absolute destination path inside the image's root filesystem. */
    readonly to: string;
    /**
     * Leading path components to drop, as busybox `tar --strip-components`.
     * @default 0
     */
    readonly stripComponents?: number;
  };

/** Where layer 0 comes from. */
export type BaseSpec =
  | {
    readonly kind: "blank";
    /**
     * Virtual size in bytes of the qcow2 to create.
     *
     * The `"image"` arm spells the same quantity `virtualSizeBytes`, because
     * there the number is an assertion about a file that already exists rather
     * than an instruction — see that field.
     */
    readonly sizeBytes: number;
    /**
     * qcow2 creation options. `cluster_size` is a cache-key input rather than
     * a tunable: `qemu-img amend` cannot change it, so altering it invalidates
     * every cached layer with no in-place migration.
     */
    readonly options?: Readonly<Record<string, string | number | boolean>>;
  }
  | {
    /** Start from an existing image. */
    readonly kind: "image";
    readonly from: FileInput;
    /**
     * The base's format, always stated. Never left for qemu to probe: format
     * probing on a file this recipe did not produce is how a crafted image
     * gets read as something other than what it is.
     */
    readonly format: string;
    /**
     * The base's VIRTUAL size in bytes.
     *
     * Declared rather than measured, because `plan()` runs no binary — and the
     * only size the resolver can see is the FILE's, which for a sparse or
     * compressed qcow2 is nowhere near the disk's. Alpine's aarch64 cloud
     * image measures 225378304 bytes on disk and 257949696 virtual: a 12.6%
     * shortfall, close enough to look right.
     *
     * An image base is copied in whole and a `partition` step over one is
     * refused, so this number lays out nothing. Its whole job is the assertion
     * `build()` makes against `qemu-img info` — that the file on disk is still
     * the one the recipe was written against. Declaring MORE than the image
     * holds is how a grow is spelled, and is refused with
     * {@linkcode BaseImageSizeMismatchError}; see that error for why `resize()`
     * alone does not grow a partitioned image.
     */
    readonly virtualSizeBytes: number;
    /**
     * 1-based GPT partition number holding the root filesystem, which `copyIn`
     * and `run` steps mount.
     *
     * There is no declared layout to infer it from — the table came with the
     * image — and guessing produces something that mounts, populates, and is
     * the wrong partition. Read it off the image: on Alpine's aarch64 cloud
     * image it is `2`, with `1` being a 512 KiB FAT ESP.
     *
     * The guest checks it before mounting rather than trusting it, since a
     * plan has no geometry of its own to compare an existing table against: a
     * number with no partition and a number naming a non-ext filesystem are
     * both refused by `blkid`, each naming this field.
     */
    readonly rootPartition: number;
  };

/** A complete, buildable image definition. */
export interface Recipe {
  /** Human name; part of the key, so renaming rebuilds. */
  readonly name: string;
  /** Target platform. */
  readonly platform: Platform;
  /** Layer 0. */
  readonly base: BaseSpec;
  /** How the artifact boots. */
  readonly boot: BootSpec;
  /** The steps, in order. */
  readonly steps: readonly Step[];
  /** Determinism policy; see the type, none of it is optional. */
  readonly determinism: DeterminismPolicy;
}

/** Build a {@linkcode Recipe}. Pure — constructs a value, runs nothing. */
export function defineRecipe(recipe: Recipe): Recipe {
  return recipe;
}

/** One entry from a resolved staging tree. */
export interface ResolvedEntry {
  /** Path relative to the tree root, with `/` separators. */
  readonly path: string;
  /** Entry type. */
  readonly type: "file" | "dir" | "symlink";
  /** POSIX mode bits, when the host reports them. */
  readonly mode: number;
  /** Size in bytes for files. */
  readonly sizeBytes: number;
  /** sha256 of the content, for files. */
  readonly sha256?: string;
  /** Target, for symlinks. */
  readonly linkTarget?: string;
  /** Owning uid, when the host reports one. */
  readonly uid?: number;
  /** Owning gid, when the host reports one. */
  readonly gid?: number;
}

/** A resolved input: its digest, plus tree detail when it is a directory. */
export interface ResolvedInput {
  /** The declaration this resolves. */
  readonly input: Input;
  /** Digest of the file, or of the canonical walk for a directory. */
  readonly sha256: string;
  /** Total bytes. */
  readonly sizeBytes: number;
  /** Entries, for a directory input. */
  readonly entries?: readonly ResolvedEntry[];
  /** Traits the data requires, derived from the walk rather than declared. */
  readonly traits?: readonly CapabilityTrait[];
  /**
   * Compression sniffed from a FILE input's leading magic bytes.
   *
   * Absent for directory inputs, and absent from any resolver that does not
   * sniff — `plan()` refuses an `unpack` step whose archive has no detected
   * compression rather than falling back to the filename, because the filename
   * is the one thing about an archive that is free to lie.
   */
  readonly compression?: ArchiveCompression;
}

/** A recipe whose every declared input has been replaced by its digest. */
export interface ResolvedRecipe {
  /** The recipe as written. */
  readonly recipe: Recipe;
  /** Resolved inputs, keyed by their declared path. */
  readonly inputs: Readonly<Record<string, ResolvedInput>>;
}
