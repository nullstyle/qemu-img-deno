/**
 * The content-addressed layer store.
 *
 * Layers are qcow2 overlays chained by relative backing references, so the
 * whole cache directory can be moved, rsynced or restored in CI with no
 * rebase pass and no machine-specific prefix inside the image bytes.
 *
 * @module
 */

import type { RealizationKey, RecipeKey } from "./keys.ts";
import { sha256HexFile } from "../digest.ts";

/** The container filename inside every layer directory. */
const IMAGE_NAME = "image.qcow2";

/** Suffix on a layer directory that is still being built. */
const PARTIAL_SUFFIX = ".partial";

/**
 * Infix on a published directory that {@linkcode LayerStore.publish} moved out
 * of the way so a replacement could take its name.
 *
 * A crash between the two renames leaves one behind; {@linkcode LayerStore.gc}
 * reclaims it.
 */
const STALE_INFIX = ".stale-";

/**
 * How old a `scratch/` entry must be before {@linkcode LayerStore.gc} takes it.
 *
 * Nothing in the store can prove a scratch file is not in use — the builds that
 * write there hold no lock on it — so age is the only signal available, and the
 * default is chosen to be far longer than any single writer's lifetime. The
 * longest of them is `contentDigest()`'s raw materialization, which lives for
 * one `qemu-img convert` plus one pass over the result.
 */
const DEFAULT_SCRATCH_STALE_MS = 24 * 60 * 60 * 1000;

/** Apparent size of every file at or under `path`; 0 if it is not there. */
async function treeBytes(path: string): Promise<number> {
  const info = await Deno.lstat(path).catch(() => null);
  if (info === null) return 0;
  if (!info.isDirectory) return info.isFile ? info.size : 0;
  let total = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      total += await treeBytes(`${path}/${entry.name}`);
    }
  } catch {
    // A tree that vanished mid-walk contributes what was counted before it did.
  }
  return total;
}

/** A published layer. */
export interface StoredLayer {
  /** The key naming this layer's directory. */
  readonly realizationKey: RealizationKey;
  /** The recipe key it realizes. */
  readonly recipeKey: RecipeKey;
  /**
   * Path to `image.qcow2`, resolved against the store's current root.
   *
   * Derived on read, never read back from the manifest. A manifest recording
   * an absolute path would defeat the relocatability this module promises in
   * two different ways: a store that MOVED would throw `ENOENT`, and — worse —
   * a store that was COPIED would verify happily and hand back the *original's*
   * bytes, since both the digest and the path it checked would still describe
   * the file left behind.
   */
  readonly path: string;
  /**
   * sha256 of the container file, recorded at publish and re-verified on hit.
   *
   * This is deliberately the wrong artifact *identity* — it moves with cluster
   * layout, chain depth and, for a layer a guest wrote, with I/O completion
   * order between two boots that produced the same filesystem — but exactly
   * the right tamper check. It catches the likeliest real corruption: someone
   * boots a cached layer directly, qemu opens it read-write, and every
   * descendant is now built on sand. `qemu-img check` cannot detect that,
   * because the chain stays structurally perfect.
   *
   * Identity is {@linkcode StoredLayer.contentSha256}'s job. Both are recorded
   * because they answer different questions, and neither substitutes for the
   * other.
   */
  readonly containerSha256: string;
  /**
   * sha256 over the layer's guest-visible content — what a guest READS through
   * it, including every byte inherited from its parents.
   *
   * This is the layer's identity, and it is what a child's realization key
   * folds in: a child's overlay is a delta in guest address space, so content
   * is the only property of a parent it can be silently wrong about. Unlike
   * the container digest it does not move when qemu stores the same bytes
   * differently. See `contentDigest()` in `./content.ts`.
   */
  readonly contentSha256: string;
  /**
   * The parent's content digest — the value this layer's realization key
   * folded.
   *
   * Recorded so a published key can be re-derived from this manifest alone,
   * with no need to open a parent that may since have been collected.
   */
  readonly parentContentSha256?: string;
  /**
   * The parent layer's key, absent on a base layer.
   *
   * Recorded so garbage collection can walk the chain without opening every
   * image. A layer's qcow2 names its parent too — as a relative backing path —
   * but reading that back means trusting the very file the collector is
   * deciding whether to delete.
   */
  readonly parentRealizationKey?: RealizationKey;
}

/** A layer directory that another process is building right now. */
export class LayerBusyError extends Error {
  /** The contended key. */
  readonly realizationKey: RealizationKey;

  /** Build the error naming the layer and the wait that timed out. */
  constructor(key: RealizationKey, waitedMs: number) {
    super(
      `layer ${key.slice(0, 12)} is being built by another process, and it ` +
        `did not finish within ${waitedMs}ms. Guest layers boot a VM, so a ` +
        "legitimate build can take a while — raise `lockTimeoutMs`, or find " +
        "the stalled build. Nothing was written.",
    );
    this.name = "LayerBusyError";
    this.realizationKey = key;
  }
}

/** Raised when a cached layer's bytes no longer match its recorded digest. */
export class LayerIntegrityError extends Error {
  /** The layer that failed verification. */
  readonly realizationKey: RealizationKey;

  /** Build the error from the expected and actual digests. */
  constructor(key: RealizationKey, expected: string, actual: string) {
    super(
      `cached layer ${key.slice(0, 12)} has changed since it was published\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        "Every descendant built on it would silently read different content, " +
        "and qemu-img check cannot see that. Delete the layer to rebuild it.",
    );
    this.name = "LayerIntegrityError";
    this.realizationKey = key;
  }
}

/** A filesystem-backed layer store. */
export class LayerStore {
  /** Root directory holding `layers/`. */
  readonly root: string;
  /**
   * How long {@linkcode begin} waits for another process's lock.
   *
   * Generous by default: a guest layer boots a VM, and a cross-architecture
   * one runs under TCG at roughly a twelfth of native speed.
   */
  readonly lockTimeoutMs: number;
  readonly #locks = new Map<RealizationKey, Deno.FsFile>();

  /** Open (and lazily create) a store rooted at `root`. */
  constructor(root: string, options: { readonly lockTimeoutMs?: number } = {}) {
    this.root = root;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 600_000;
  }

  /** The published directory for a key. */
  layerDir(key: RealizationKey): string {
    return `${this.root}/layers/${key}`;
  }

  /**
   * The in-flight directory for a key — a SAME-DEPTH sibling, not a `tmp/`
   * subtree.
   *
   * That is load-bearing rather than cosmetic. `qemu-img create` resolves a
   * backing reference against the *target's* own directory and opens it before
   * creating anything, so from `layers/<child>.partial/` the relative path
   * `../<parent>/image.qcow2` resolves correctly both before and after the
   * publishing rename. Staging under `tmp/<uuid>/` cannot resolve it at all,
   * and the escapes — building at the final path, or passing `-u` — give up
   * atomic publish or backing validation respectively.
   */
  partialDir(key: RealizationKey): string {
    return `${this.root}/layers/${key}${PARTIAL_SUFFIX}`;
  }

  /**
   * Where a build stages transient files — `contentDigest()`'s raw
   * materialization, a `bytes` layer's GPT halves.
   *
   * Nothing here is part of any layer, and every writer removes its own files
   * on the way out, so what survives is a killed process's leftovers.
   * {@linkcode gc} is what reclaims them.
   */
  get scratchDir(): string {
    return `${this.root}/scratch`;
  }

  /**
   * Look up a published layer, verifying its bytes unless `trust` is set.
   *
   * A present `manifest.json` means a complete layer — the publish rename is
   * atomic — so a hit takes no lock.
   */
  async get(
    key: RealizationKey,
    options: { readonly trust?: boolean } = {},
  ): Promise<StoredLayer | undefined> {
    const dir = this.layerDir(key);
    const manifestPath = `${dir}/manifest.json`;
    const manifest = await Deno.readTextFile(manifestPath).catch(() => null);
    if (manifest === null) return undefined;
    const record = JSON.parse(manifest) as Omit<StoredLayer, "path">;
    const stored: StoredLayer = { ...record, path: `${dir}/${IMAGE_NAME}` };
    if (options.trust !== true) {
      // Streamed, never `Deno.readFile`: this runs on EVERY cache hit, and
      // reading a layer whole peaks at twice its size — 4.05 GiB measured for a
      // 2 GiB layer. See `sha256HexFile` for the numbers and for why the digest
      // it produces is the same one.
      const actual = await sha256HexFile(stored.path);
      if (actual !== stored.containerSha256) {
        throw new LayerIntegrityError(key, stored.containerSha256, actual);
      }
    }
    return stored;
  }

  /**
   * Begin a layer: a clean `.partial` sibling directory, held under an
   * exclusive advisory lock until {@linkcode publish} or {@linkcode abandon}.
   *
   * Without the lock, two builds that miss the same key both do the work and
   * both publish — which for a guest layer means two VM boots for one result,
   * and a window in which a reader sees the loser's bytes under the winner's
   * key. The lock file lives OUTSIDE the `.partial` directory, because that
   * directory is deleted and recreated here and a lock held on a deleted inode
   * guards nothing.
   */
  async begin(key: RealizationKey): Promise<string> {
    const lock = await this.#acquire(key);
    this.#locks.set(key, lock);
    try {
      const dir = this.partialDir(key);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.mkdir(dir, { recursive: true });
      return dir;
    } catch (error) {
      this.#release(key);
      throw error;
    }
  }

  /**
   * Give up on an in-flight layer, releasing its lock and removing the
   * `.partial` directory.
   *
   * A failed guest step leaves a half-written filesystem there. It can never
   * be published — publishing is a rename that only `publish()` performs — but
   * without this it would sit until the next `begin()` for the same key, still
   * holding the lock in this process.
   */
  async abandon(key: RealizationKey): Promise<void> {
    await Deno.remove(this.partialDir(key), { recursive: true }).catch(
      () => {},
    );
    this.#release(key);
  }

  /** Every published layer in the store. */
  async list(): Promise<StoredLayer[]> {
    const layers: StoredLayer[] = [];
    for (const [key, presence] of await this.#presence()) {
      if (!presence.published) continue;
      const layer = await this.get(key, { trust: true }).catch(() => undefined);
      if (layer !== undefined) layers.push(layer);
    }
    return layers;
  }

  /**
   * Delete every layer not reachable from `keep`, reclaim the debris a killed
   * build left behind, and report what went.
   *
   * Reachability follows the backing chain, so keeping a leaf keeps every
   * ancestor it reads through. This is the only safe rule: a qcow2 overlay is
   * a delta against its parent, and deleting a parent leaves a child that
   * opens with an error at best and reads someone else's clusters at worst.
   *
   * Debris is a `.partial` directory a build never finished, a `.stale-`
   * directory {@linkcode publish} moved aside and was killed before removing,
   * and anything left in `scratch/`. The first two are collected under the
   * key's own lock, which is the ONLY thing that can tell a crashed build's
   * leftovers from a live build's working directory — so a key whose lock is
   * held is skipped rather than waited on, and its `.partial` is left exactly
   * where it is.
   *
   * Two things are deliberately never collected. A `.lock` file is kept
   * forever: a lock is held on an INODE, so removing the file at the path lets
   * a waiter that opened it before the removal and an arrival that creates a
   * fresh one afterwards BOTH hold "the lock" for one key. And `scratch/`
   * entries younger than `scratchStaleMs` are kept, because nothing here can
   * prove one is not in use.
   */
  async gc(
    options: {
      /** Layers to keep, along with every ancestor each one reads through. */
      readonly keep: readonly RealizationKey[];
      /**
       * How old a `scratch/` entry must be to be reclaimed.
       * @default 86400000 (24 h)
       */
      readonly scratchStaleMs?: number;
    },
  ): Promise<{
    /** The layers that were deleted. */
    readonly removed: RealizationKey[];
    /**
     * Apparent size of every file in every layer directory still on disk —
     * the manifest as well as the image, and an unreachable layer whose lock
     * was held, because gc left that one in place too.
     */
    readonly keptBytes: number;
    /** Apparent size of everything gc deleted, layers and debris alike. */
    readonly reclaimedBytes: number;
  }> {
    const byKey = new Map<RealizationKey, StoredLayer>();
    for (const layer of await this.list()) {
      byKey.set(layer.realizationKey, layer);
    }

    const reachable = new Set<RealizationKey>();
    const walk = (key: RealizationKey | undefined): void => {
      while (key !== undefined && !reachable.has(key)) {
        reachable.add(key);
        key = byKey.get(key)?.parentRealizationKey;
      }
    };
    for (const root of options.keep) walk(root);

    const removed: RealizationKey[] = [];
    let keptBytes = 0;
    let reclaimedBytes = 0;
    for (const [key, presence] of await this.#presence()) {
      const collect = presence.published && !reachable.has(key);
      if (!collect && presence.debris.length === 0) {
        if (presence.published) {
          keptBytes += await treeBytes(this.layerDir(key));
        }
        continue;
      }
      const lock = await this.#tryAcquire(key);
      if (lock === undefined) {
        if (presence.published) {
          keptBytes += await treeBytes(this.layerDir(key));
        }
        continue;
      }
      try {
        for (const path of presence.debris) {
          reclaimedBytes += await treeBytes(path);
          await Deno.remove(path, { recursive: true });
        }
        if (collect) {
          reclaimedBytes += await treeBytes(this.layerDir(key));
          await Deno.remove(this.layerDir(key), { recursive: true });
          removed.push(key);
        } else if (presence.published) {
          keptBytes += await treeBytes(this.layerDir(key));
        }
      } finally {
        lock.close();
      }
    }
    reclaimedBytes += await this.#sweepScratch(
      options.scratchStaleMs ?? DEFAULT_SCRATCH_STALE_MS,
    );
    return { removed, keptBytes, reclaimedBytes };
  }

  /**
   * Everything under `layers/`, grouped by the key it belongs to.
   *
   * One classifier for the whole store, so `list()` and `gc()` cannot disagree
   * about which directory names are layers.
   */
  async #presence(): Promise<
    Map<RealizationKey, { published: boolean; debris: string[] }>
  > {
    const root = `${this.root}/layers`;
    const found = new Map<
      RealizationKey,
      { published: boolean; debris: string[] }
    >();
    const at = (name: string) => {
      // Directory names ARE realization keys; that is the store's whole
      // addressing scheme.
      const key = name as unknown as RealizationKey;
      let entry = found.get(key);
      if (entry === undefined) {
        entry = { published: false, debris: [] };
        found.set(key, entry);
      }
      return entry;
    };
    try {
      for await (const entry of Deno.readDir(root)) {
        // Lock files are the only non-directories here, and they are never
        // reclaimed.
        if (!entry.isDirectory) continue;
        const path = `${root}/${entry.name}`;
        if (entry.name.endsWith(PARTIAL_SUFFIX)) {
          at(entry.name.slice(0, -PARTIAL_SUFFIX.length)).debris.push(path);
          continue;
        }
        const stale = entry.name.lastIndexOf(STALE_INFIX);
        if (stale > 0) {
          at(entry.name.slice(0, stale)).debris.push(path);
          continue;
        }
        at(entry.name).published = true;
      }
    } catch {
      // No store on disk yet is an empty store, not an error.
    }
    return found;
  }

  /** Remove `scratch/` entries last written more than `staleMs` ago. */
  async #sweepScratch(staleMs: number): Promise<number> {
    const cutoff = Date.now() - staleMs;
    let reclaimed = 0;
    try {
      for await (const entry of Deno.readDir(this.scratchDir)) {
        const path = `${this.scratchDir}/${entry.name}`;
        const info = await Deno.lstat(path).catch(() => null);
        // An unreadable or timestamp-less entry is treated as fresh: this
        // sweep runs alongside builds that hold no lock on what they wrote
        // there, so every uncertain case has to fall on the side of keeping it.
        if (info === null) continue;
        if ((info.mtime?.getTime() ?? Date.now()) > cutoff) continue;
        const bytes = await treeBytes(path);
        const gone = await Deno.remove(path, { recursive: true })
          .then(() => true).catch(() => false);
        if (gone) reclaimed += bytes;
      }
    } catch {
      // No scratch directory is nothing to sweep.
    }
    return reclaimed;
  }

  /**
   * The lock file for a key. Created once and then never removed.
   *
   * The removal is what has to be resisted, because a lock is a lock on an
   * INODE and the path is only how you find it. Unlink it on release and this
   * interleaving becomes reachable: B opens the path and is descheduled before
   * it locks; A releases and unlinks; B's lock now succeeds on an inode that
   * nothing else can reach; C opens the path, creates a fresh file, and locks
   * that. B and C both believe they hold the key, and they proceed to build and
   * publish the same layer over each other — the exact outcome the lock exists
   * to prevent, made rarer and no less possible by the narrow window.
   *
   * Nothing removes these later either, including {@linkcode gc}: unlinking
   * while holding the lock reopens the same window against a waiter, and
   * unlinking after releasing it reopens it against a fresh arrival. The
   * standing cost is one empty file per key the store has ever begun, next to
   * directories that hold whole disk images.
   */
  #lockPath(key: RealizationKey): string {
    return `${this.root}/layers/${key}.lock`;
  }

  async #tryAcquire(key: RealizationKey): Promise<Deno.FsFile | undefined> {
    await Deno.mkdir(`${this.root}/layers`, { recursive: true });
    const file = await Deno.open(this.#lockPath(key), {
      create: true,
      write: true,
      read: true,
    });
    // `tryLock`, never `lock`. The blocking form waits forever, which turns
    // the timeout below into decoration and deadlocks a GC pass against any
    // build that is holding the same key.
    const held = await file.tryLock(true).catch(() => false);
    if (!held) {
      file.close();
      return undefined;
    }
    return file;
  }

  async #acquire(key: RealizationKey): Promise<Deno.FsFile> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      const held = await this.#tryAcquire(key);
      if (held !== undefined) return held;
      if (Date.now() >= deadline) {
        throw new LayerBusyError(key, this.lockTimeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  #release(key: RealizationKey): void {
    const held = this.#locks.get(key);
    if (held === undefined) return;
    this.#locks.delete(key);
    // Closing the descriptor releases the lock. The FILE stays — see
    // `#lockPath` for why removing it is what breaks mutual exclusion.
    held.close();
  }

  /**
   * Publish a completed layer: hash it, write its manifest, make it read-only,
   * then rename into place.
   *
   * `contentSha256` comes from the caller rather than being computed here, and
   * that is the one thing about this signature worth defending: reading a
   * layer's guest-visible content means running `qemu-img`, and this module
   * otherwise touches nothing but the filesystem — which is what lets its
   * tests cover locking, publishing and collection with no binary installed.
   * `build()` computes it with the driver it already holds.
   *
   * The image is `chmod 0444` because the one corruption this design cannot
   * otherwise prevent is someone opening a cached layer read-write.
   *
   * **Publishing a key that is already published.** This happens with no
   * concurrency at all: an uncacheable layer skips `get()` and so reaches here
   * on every single run. `rename` onto a non-empty directory is ENOTEMPTY, so
   * something has to give, and the choice is made on CONTENT:
   *
   * - Same `contentSha256` — the published layer is left exactly where it is,
   *   and the freshly built `.partial` is discarded. There is nothing to gain
   *   by swapping: content is a layer's identity, and every child addresses it
   *   in guest space, so two layers with one content digest are the same layer
   *   however differently qemu chose to store the bytes. This is the common
   *   case, and taking it means no window, no swap and no re-pointing.
   * - Different `contentSha256` — the layer really did change, which only an
   *   uncacheable one is allowed to do, and the fresh bytes have to win. The
   *   old directory is RENAMED aside and deleted afterwards, rather than
   *   deleted first: rename is atomic and `remove` of a multi-gigabyte tree is
   *   not, so the window in which the key resolves to nothing shrinks from a
   *   recursive delete to a single syscall, and a child that already opened
   *   `../<key>/image.qcow2` keeps reading the inode it opened rather than
   *   having it disappear underneath it.
   *
   * What is still not solved is a child that RE-OPENS that path across the
   * swap: it would be a delta against bytes it was not built on. Closing that
   * needs reader accounting the store does not keep — the layer directory is
   * addressed by path, and qemu opens it by path on every invocation. It is
   * confined to the second case above, i.e. an uncacheable layer rebuilt into
   * different content while a child of it is being built.
   *
   * Returns whichever layer is at the key when this finishes, published bytes
   * and all. On the keep-the-existing path that is NOT the record just built,
   * and callers must chain children off what comes back rather than off what
   * they passed in.
   */
  async publish(
    key: RealizationKey,
    recipeKey: RecipeKey,
    contentSha256: string,
    parent?: {
      /** The parent's content digest — the value the key folded. */
      readonly contentSha256: string;
      /** The parent's key, for garbage collection. */
      readonly realizationKey: RealizationKey;
    },
  ): Promise<StoredLayer> {
    const partial = this.partialDir(key);
    const imagePath = `${partial}/${IMAGE_NAME}`;
    // Streamed for the same reason `get()` streams: a layer is a disk image,
    // and reading one whole to hash it peaks at twice its size.
    const containerSha256 = await sha256HexFile(imagePath);
    const published = this.layerDir(key);
    const record: Omit<StoredLayer, "path"> = {
      realizationKey: key,
      recipeKey,
      containerSha256,
      contentSha256,
      ...(parent === undefined ? {} : {
        parentContentSha256: parent.contentSha256,
        parentRealizationKey: parent.realizationKey,
      }),
    };
    await Deno.writeTextFile(
      `${partial}/manifest.json`,
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await Deno.chmod(imagePath, 0o444).catch(() => {});
    await Deno.mkdir(`${this.root}/layers`, { recursive: true });

    const existing = await this.#publishedLayer(key);
    if (existing?.contentSha256 === contentSha256) {
      await Deno.remove(partial, { recursive: true }).catch(() => {});
      this.#release(key);
      return existing;
    }
    // `existing` is undefined for a directory with no manifest as well as for
    // no directory at all, and the first still has to be moved out of the way.
    const occupied = await Deno.stat(published).then(() => true).catch(
      () => false,
    );
    if (occupied) {
      const stale = `${published}${STALE_INFIX}${crypto.randomUUID()}`;
      await Deno.rename(published, stale);
      try {
        await Deno.rename(partial, published);
      } catch (error) {
        // Put the old layer back rather than leave the key resolving to
        // nothing: a published layer that is merely out of date still opens,
        // and every child already cached against it still reads what it was
        // built on.
        await Deno.rename(stale, published).catch(() => {});
        throw error;
      }
      await Deno.remove(stale, { recursive: true }).catch(() => {});
    } else {
      await Deno.rename(partial, published);
    }
    this.#release(key);
    return { ...record, path: `${published}/${IMAGE_NAME}` };
  }

  /**
   * The layer published under `key`, or undefined if there is not a complete
   * one there.
   *
   * `trust: true` on purpose: this decides which of two directories to keep,
   * and re-hashing a multi-gigabyte image to answer that would put a full read
   * of the store on the publish path. A layer that has rotted since it was
   * written is still caught, by the check {@linkcode get} runs on the next read
   * of it.
   */
  async #publishedLayer(
    key: RealizationKey,
  ): Promise<StoredLayer | undefined> {
    const layer = await this.get(key, { trust: true }).catch(() => undefined);
    if (layer === undefined) return undefined;
    // A manifest with no image beside it is debris, not a layer.
    const image = await Deno.stat(layer.path).catch(() => null);
    return image?.isFile === true ? layer : undefined;
  }
}
