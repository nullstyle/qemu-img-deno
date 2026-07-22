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

/** A published layer. */
export interface StoredLayer {
  /** The key naming this layer's directory. */
  readonly realizationKey: RealizationKey;
  /** The recipe key it realizes. */
  readonly recipeKey: RecipeKey;
  /** Absolute path to `image.qcow2`. */
  readonly path: string;
  /**
   * sha256 of the container file, recorded at publish and re-verified on hit.
   *
   * This is deliberately the wrong artifact *identity* — it moves with cluster
   * layout and chain depth — but exactly the right tamper check, and it is
   * what a child's realization key folds in. It catches the likeliest real
   * corruption: someone boots a cached layer directly, qemu opens it
   * read-write, and every descendant is now built on sand. `qemu-img check`
   * cannot detect that, because the chain stays structurally perfect.
   */
  readonly containerSha256: string;
  /** The parent's container digest, for auditing. */
  readonly parentContainerSha256?: string;
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

  /** Open (and lazily create) a store rooted at `root`. */
  constructor(root: string) {
    this.root = root;
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
    const stored = JSON.parse(manifest) as StoredLayer;
    if (options.trust !== true) {
      const actual = await sha256Hex(await Deno.readFile(stored.path));
      if (actual !== stored.containerSha256) {
        throw new LayerIntegrityError(key, stored.containerSha256, actual);
      }
    }
    return stored;
  }

  /** Begin a layer: a clean `.partial` sibling directory. */
  async begin(key: RealizationKey): Promise<string> {
    const dir = this.partialDir(key);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    await Deno.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Publish a completed layer: hash it, write its manifest, make it read-only,
   * then rename into place.
   *
   * The image is `chmod 0444` because the one corruption this design cannot
   * otherwise prevent is someone opening a cached layer read-write.
   */
  async publish(
    key: RealizationKey,
    recipeKey: RecipeKey,
    parentContainerSha256?: string,
  ): Promise<StoredLayer> {
    const partial = this.partialDir(key);
    const imagePath = `${partial}/image.qcow2`;
    const containerSha256 = await sha256Hex(await Deno.readFile(imagePath));
    const published = this.layerDir(key);
    const layer: StoredLayer = {
      realizationKey: key,
      recipeKey,
      path: `${published}/image.qcow2`,
      containerSha256,
      ...(parentContainerSha256 === undefined ? {} : { parentContainerSha256 }),
    };
    await Deno.writeTextFile(
      `${partial}/manifest.json`,
      `${JSON.stringify(layer, null, 2)}\n`,
    );
    await Deno.chmod(imagePath, 0o444).catch(() => {});
    await Deno.mkdir(`${this.root}/layers`, { recursive: true });
    await Deno.rename(partial, published);
    return layer;
  }
}
