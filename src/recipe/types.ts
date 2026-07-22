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
     * exactly 528450048 usable bytes, `fatType: 12` yields 33005568. A
     * smaller partition is refused at plan time with the exact figure.
     * `fatType: 32` is refused outright — qemu's vvfat FAT32 output is a
     * FAT16-shaped BPB with a doubled allocation table, which conformant
     * drivers misread.
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
     */
    readonly kind: "ext4";
    readonly label: string;
    /** Optional staging tree copied in after the filesystem is created. */
    readonly from?: DirInput;
  }
  | { readonly kind: "empty" };

/** One partition in a declared GPT. */
export interface PartitionSpec {
  /** Partition name (GPT stores it as UTF-16LE, at most 36 code units). */
  readonly label: string;
  /** Partition type. */
  readonly type: PartitionType;
  /** Size in bytes, or `"rest"` to fill the remaining space. */
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
  }
  | {
    /** Copy a host tree into the image, in the guest. */
    readonly kind: "copyIn";
    readonly id: string;
    readonly from: DirInput;
    /** Absolute destination path inside the image's root filesystem. */
    readonly to: string;
  };

/** Where layer 0 comes from. */
export type BaseSpec =
  | {
    readonly kind: "blank";
    /** Virtual size in bytes. */
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
    readonly format: string;
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
}

/** A recipe whose every declared input has been replaced by its digest. */
export interface ResolvedRecipe {
  /** The recipe as written. */
  readonly recipe: Recipe;
  /** Resolved inputs, keyed by their declared path. */
  readonly inputs: Readonly<Record<string, ResolvedInput>>;
}
