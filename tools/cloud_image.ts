/**
 * Fetching the pinned cloud images `tools/cloud_smoke.ts` builds on.
 *
 * Nothing is trusted by URL. The lockfile records the sha256 the bytes must
 * have, so a fetch is a pure function of its pin and a cached copy is checked
 * on every use rather than assumed — the same contract `appliance.lock.json`
 * has, kept in a separate file because `readApplianceIdentity()` folds that
 * one's digest into every guest layer's cache key.
 *
 * @module
 */

import { sha256Hex } from "../src/digest.ts";

/** Facts measured from the pinned bytes, asserted by the smoke. */
export interface CloudImageMeasurements {
  /** Virtual disk size, from `qemu-img info`. Never the file's size. */
  readonly virtualSizeBytes: number;
  /** qcow2 cluster size. */
  readonly clusterSize: number;
  /** 1-based GPT number of the root partition. */
  readonly rootPartition: number;
  /** `blkid` TYPE of the root partition. */
  readonly rootFilesystem: string;
  /** ext4 volume label of the root partition. */
  readonly rootLabel: string;
  /** Root filesystem block size. Cloud images are not all 4096. */
  readonly rootBlockSizeBytes: number;
  /** Total blocks in the root filesystem. */
  readonly rootTotalBlocks: number;
  /** Free blocks in the root filesystem, as shipped. */
  readonly rootFreeBlocks: number;
  /** Blocks reserved for uid 0, which a guest step can therefore use. */
  readonly rootReservedBlocks: number;
  /** Bytes actually written into the root before ENOSPC, measured. */
  readonly writableBytesAsRoot: number;
  /** 1-based GPT number of the ESP. */
  readonly espPartition: number;
  /** `blkid` TYPE of the ESP. */
  readonly espFilesystem: string;
  /** ESP length in bytes. */
  readonly espLengthBytes: number;
  /** Regular files in the root filesystem as shipped. */
  readonly regularFileCount: number;
  /** sha256 of `/etc/os-release`, a stable content oracle. */
  readonly osReleaseSha256: string;
}

/** One pinned image. */
export interface CloudImagePin {
  /** Where to fetch it. */
  readonly url: string;
  /** Basename it is cached under. */
  readonly file: string;
  /** Guest architecture. */
  readonly arch: string;
  /** Image format, always stated so qemu never probes. */
  readonly format: string;
  /** Size of the FILE on disk — not the virtual size. */
  readonly sizeBytes: number;
  /** sha256 the bytes must have. Enforced on fetch and on every cache hit. */
  readonly sha256: string;
  /** The digest Alpine publishes alongside the image. */
  readonly sha512: string;
  /** Facts read out of these exact bytes. */
  readonly measured: CloudImageMeasurements;
}

/** The parsed `cloud.lock.json`. */
export interface CloudLockfile {
  /** Schema version. */
  readonly lockfileVersion: number;
  /** Pinned images by name. */
  readonly images: Readonly<Record<string, CloudImagePin>>;
}

/** Read and parse the lockfile. */
export async function readCloudLock(
  path = "cloud.lock.json",
): Promise<CloudLockfile> {
  return JSON.parse(await Deno.readTextFile(path)) as CloudLockfile;
}

/** Why {@linkcode ensureCloudImage} could not produce the image. */
export type CloudImageUnavailable =
  /** Not cached, and the network could not be reached. */
  | { readonly reason: "offline"; readonly detail: string }
  /** Fetched or cached bytes did not match the pin. */
  | { readonly reason: "digest"; readonly detail: string };

/** What {@linkcode ensureCloudImage} produced. */
export type CloudImageResult =
  | { readonly ok: true; readonly path: string; readonly fetched: boolean }
  | { readonly ok: false; readonly why: CloudImageUnavailable };

/** Options for {@linkcode ensureCloudImage}. */
export interface EnsureCloudImageOptions {
  /** Directory the image is cached in. @default ".appliance/cloud" */
  readonly cacheDir?: string;
  /** Fetch when absent. Set false to make a cold cache a clean skip. */
  readonly allowFetch?: boolean;
}

/**
 * Return the cached image's path, fetching it if absent.
 *
 * Never throws for the two conditions a smoke should skip on — no cached copy
 * and no network — because a skipped smoke and a failed one mean different
 * things and a thrown error cannot say which this is. A DIGEST mismatch is not
 * one of those: cached bytes that do not match the pin are a fact worth
 * failing over, so it is reported rather than silently refetched.
 */
export async function ensureCloudImage(
  pin: CloudImagePin,
  options: EnsureCloudImageOptions = {},
): Promise<CloudImageResult> {
  const cacheDir = options.cacheDir ?? ".appliance/cloud";
  const path = `${cacheDir}/${pin.file}`;

  const cached = await Deno.stat(path).catch(() => undefined);
  if (cached !== undefined) {
    const actual = await sha256Hex(await Deno.readFile(path));
    if (actual === pin.sha256) return { ok: true, path, fetched: false };
    return {
      ok: false,
      why: {
        reason: "digest",
        detail: `cached ${path} is sha256 ${actual}, pinned ${pin.sha256}. ` +
          "Delete it to refetch; do not assume the pin is stale.",
      },
    };
  }
  if (options.allowFetch === false) {
    return {
      ok: false,
      why: { reason: "offline", detail: `not cached at ${path}` },
    };
  }

  await Deno.mkdir(cacheDir, { recursive: true });
  // Straight into a `.part` sibling, renamed only after the digest matches, so
  // an interrupted fetch can never be picked up as a cache hit.
  const partial = `${path}.part`;
  let response: Response;
  try {
    response = await fetch(pin.url);
  } catch (error) {
    return {
      ok: false,
      why: {
        reason: "offline",
        detail: `${pin.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  if (!response.ok || response.body === null) {
    return {
      ok: false,
      why: {
        reason: "offline",
        detail: `${pin.url} returned ${response.status} ${response.statusText}`,
      },
    };
  }
  const handle = await Deno.open(partial, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    await response.body.pipeTo(handle.writable);
  } catch (error) {
    await Deno.remove(partial).catch(() => {});
    return {
      ok: false,
      why: {
        reason: "offline",
        detail: `${pin.url} transfer failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }

  const actual = await sha256Hex(await Deno.readFile(partial));
  if (actual !== pin.sha256) {
    await Deno.remove(partial).catch(() => {});
    return {
      ok: false,
      why: {
        reason: "digest",
        detail: `${pin.url} delivered sha256 ${actual}, pinned ${pin.sha256}`,
      },
    };
  }
  await Deno.rename(partial, path);
  return { ok: true, path, fetched: true };
}
