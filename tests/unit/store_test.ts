import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  LayerBusyError,
  LayerIntegrityError,
  LayerStore,
} from "../../src/recipe/store.ts";
import type { RealizationKey, RecipeKey } from "../../src/recipe/keys.ts";

/** Keys are opaque branded strings; tests mint them directly. */
const key = (name: string) => name as unknown as RealizationKey;
const recipeKey = (name: string) => name as unknown as RecipeKey;

async function scratch(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

/** Stage and publish one layer holding `content`. */
async function layer(
  store: LayerStore,
  name: string,
  content: string,
  parent?: { containerSha256: string; realizationKey: RealizationKey },
) {
  const dir = await store.begin(key(name));
  await Deno.writeTextFile(`${dir}/image.qcow2`, content);
  return await store.publish(key(name), recipeKey(`r-${name}`), parent);
}

Deno.test("a layer's manifest holds no absolute path, so the store relocates", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(`${root}/a`);
    const published = await layer(store, "base", "hello");
    const manifest = await Deno.readTextFile(
      `${root}/a/layers/base/manifest.json`,
    );
    // The failure this guards is not the ENOENT of a moved store — it is a
    // COPIED store verifying clean while serving the original's bytes.
    assert(!manifest.includes(root), `no absolute path in:\n${manifest}`);
    assertEquals(published.path, `${root}/a/layers/base/image.qcow2`);

    await Deno.rename(`${root}/a`, `${root}/b`);
    const moved = new LayerStore(`${root}/b`);
    const found = await moved.get(key("base"));
    assertEquals(found?.path, `${root}/b/layers/base/image.qcow2`);
    assertEquals(found?.containerSha256, published.containerSha256);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("publishing the same key twice replaces rather than throwing ENOTEMPTY", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await layer(store, "k", "first");
    // Reachable with no concurrency at all: an uncacheable layer skips the
    // cache lookup and so reaches publish() on every single run.
    const second = await layer(store, "k", "second");
    assertEquals(
      await Deno.readTextFile(second.path),
      "second",
      "the fresh bytes win",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a tampered layer is caught on read, and trust: true skips the check", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const published = await layer(store, "k", "original");
    await Deno.chmod(published.path, 0o644);
    await Deno.writeTextFile(published.path, "tampered");
    await assertRejects(
      () => store.get(key("k")),
      LayerIntegrityError,
      "has changed since it was published",
    );
    const trusted = await store.get(key("k"), { trust: true });
    assertEquals(trusted?.containerSha256, published.containerSha256);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("begin() takes an exclusive lock; a second holder is refused", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await store.begin(key("k"));
    // A separate LayerStore models a separate process. Without the lock both
    // would build the layer — two VM boots for one result — and the loser's
    // bytes would briefly be readable under the winner's key.
    const other = new LayerStore(root, { lockTimeoutMs: 250 });
    await assertRejects(
      () => other.begin(key("k")),
      LayerBusyError,
      "is being built by another process",
    );
    await store.abandon(key("k"));
    // Once abandoned the lock is free, and nothing is left behind.
    const dir = await other.begin(key("k"));
    assert(dir.endsWith("k.partial"));
    await other.abandon(key("k"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("abandon() removes the partial directory a failed step left behind", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const dir = await store.begin(key("k"));
    await Deno.writeTextFile(`${dir}/image.qcow2`, "half-written");
    await store.abandon(key("k"));
    assertEquals(await Deno.stat(dir).catch(() => null), null);
    // And it was never publishable: only publish() renames into place.
    assertEquals(await store.get(key("k")), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc keeps every ancestor of a kept leaf and drops the rest", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const base = await layer(store, "base", "b");
    const mid = await layer(store, "mid", "m", base);
    const leaf = await layer(store, "leaf", "l", mid);
    const orphan = await layer(store, "orphan", "o", base);

    const { removed } = await store.gc({ keep: [leaf.realizationKey] });
    // Deleting an ancestor would be the worst possible outcome: a qcow2
    // overlay is a delta, so a child whose parent vanished reads someone
    // else's clusters or fails to open at all.
    assertEquals(removed, [orphan.realizationKey]);
    assert(await store.get(key("base")), "the ancestor survived");
    assert(await store.get(key("mid")), "the intermediate survived");
    assertEquals(await store.get(key("orphan")), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc never collects a layer another process is building", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await layer(store, "keep", "k");
    const busy = new LayerStore(root);
    await busy.begin(key("inflight"));
    // The in-flight layer has no manifest, so it is not a gc candidate at all
    // — but the lock is what makes that safe under a race, and gc must never
    // block on it.
    const { removed } = await store.gc({ keep: [key("keep")] });
    assertEquals(removed, []);
    assert(
      await Deno.stat(`${root}/layers/inflight.partial`).then(() => true),
      "the in-flight directory is untouched",
    );
    await busy.abandon(key("inflight"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
