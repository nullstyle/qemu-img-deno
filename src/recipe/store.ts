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
import { sha256Hex } from "./keys.ts";

/** The container filename inside every layer directory. */
const IMAGE_NAME = "image.qcow2";

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
    return `${this.root}/layers/${key}.partial`;
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
      const actual = await sha256Hex(await Deno.readFile(stored.path));
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
      await this.#release(key);
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
    await this.#release(key);
  }

  /** Every published layer in the store. */
  async list(): Promise<StoredLayer[]> {
    const layers: StoredLayer[] = [];
    for await (const entry of this.#entries()) {
      const layer = await this.get(entry, { trust: true }).catch(() =>
        undefined
      );
      if (layer !== undefined) layers.push(layer);
    }
    return layers;
  }

  /**
   * Delete every layer not reachable from `keep`, and report what went.
   *
   * Reachability follows the backing chain, so keeping a leaf keeps every
   * ancestor it reads through. This is the only safe rule: a qcow2 overlay is
   * a delta against its parent, and deleting a parent leaves a child that
   * opens with an error at best and reads someone else's clusters at worst.
   *
   * In-flight `.partial` directories are never collected — another process may
   * hold one — and a layer whose lock cannot be taken is skipped rather than
   * waited on.
   */
  async gc(
    options: { readonly keep: readonly RealizationKey[] },
  ): Promise<{ removed: RealizationKey[]; keptBytes: number }> {
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
    for (const [key, layer] of byKey) {
      if (reachable.has(key)) {
        keptBytes += await Deno.stat(layer.path).then((s) => s.size).catch(
          () => 0,
        );
        continue;
      }
      const lock = await this.#tryAcquire(key);
      if (lock === undefined) continue;
      try {
        await Deno.remove(this.layerDir(key), { recursive: true });
        removed.push(key);
      } finally {
        lock.close();
      }
    }
    return { removed, keptBytes };
  }

  async *#entries(): AsyncGenerator<RealizationKey> {
    const root = `${this.root}/layers`;
    try {
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isDirectory || entry.name.endsWith(".partial")) continue;
        // Directory names ARE realization keys; that is the store's whole
        // addressing scheme.
        yield entry.name as unknown as RealizationKey;
      }
    } catch {
      // No store on disk yet is an empty store, not an error.
    }
  }

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

  async #release(key: RealizationKey): Promise<void> {
    const held = this.#locks.get(key);
    if (held === undefined) return;
    this.#locks.delete(key);
    held.close();
    await Deno.remove(this.#lockPath(key)).catch(() => {});
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
    const containerSha256 = await sha256Hex(await Deno.readFile(imagePath));
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
    // `rename` onto a non-empty directory is ENOTEMPTY, so re-publishing a key
    // has to replace rather than overwrite. Reachable without any concurrency:
    // an uncacheable layer skips `get()` and so reaches `publish()` on every
    // single run, and would otherwise fail the second one with a raw Deno
    // error. Last writer wins is the right rule here — a cacheable layer only
    // gets this far when `get()` missed, in which case the same key means the
    // same content, and an uncacheable one is by definition not promised to
    // reproduce, so the freshly built bytes are the ones to keep.
    await Deno.remove(published, { recursive: true }).catch(() => {});
    await Deno.rename(partial, published);
    await this.#release(key);
    return { ...record, path: `${published}/${IMAGE_NAME}` };
  }
}
