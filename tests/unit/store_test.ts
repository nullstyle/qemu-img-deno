import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  LayerBusyError,
  LayerIntegrityError,
  LayerStore,
} from "../../src/recipe/store.ts";
import type { RealizationKey, RecipeKey } from "../../src/recipe/keys.ts";
import { sha256Hex } from "../../src/recipe/keys.ts";

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
  options: {
    readonly parent?: {
      readonly contentSha256: string;
      readonly realizationKey: RealizationKey;
    };
    /** Override the stand-in content digest, to model two runs of one step. */
    readonly contentSha256?: string;
  } = {},
) {
  const dir = await store.begin(key(name));
  await Deno.writeTextFile(`${dir}/image.qcow2`, content);
  // The content digest arrives from the caller: reading a layer's
  // guest-visible content means running qemu-img, and this module is pure
  // filesystem — which is what lets these tests cover locking, publishing and
  // collection with no binary installed. A stand-in is all the store sees, and
  // it tracks the bytes because the real `contentDigest()` does.
  return await store.publish(
    key(name),
    recipeKey(`r-${name}`),
    options.contentSha256 ?? `content-of-${content}`,
    options.parent,
  );
}

/** Names under `layers/` beginning with `prefix`, sorted. */
async function names(root: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(`${root}/layers`)) {
    if (entry.name.startsWith(prefix)) found.push(entry.name);
  }
  return found.sort();
}

/** `Deno.stat`, or null when the path is not there. */
const statOrNull = (path: string) => Deno.stat(path).catch(() => null);

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

Deno.test("the container digest is the file's sha256, at every block boundary", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const block = 1024 * 1024;
    // publish() and get() fold the image a megabyte at a time rather than
    // reading it whole — a 2 GiB layer peaked at 4.05 GiB doing the latter.
    // These are the lengths where a mistake in that loop would show, and the
    // expectation is deliberately the expression the store used to evaluate:
    // the digest NAMES cached layers, so a value that moved by a byte would
    // silently invalidate every layer anyone has.
    for (const size of [0, 1, block - 1, block, block + 1, 3 * block + 7]) {
      const name = `n${size}`;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
      const dir = await store.begin(key(name));
      await Deno.writeFile(`${dir}/image.qcow2`, bytes);
      const published = await store.publish(
        key(name),
        recipeKey(`r-${name}`),
        `c-${name}`,
      );
      assertEquals(
        published.containerSha256,
        await sha256Hex(bytes),
        `size ${size}`,
      );
      // And the on-hit check reaches the same value, or every hit would throw.
      assert(await store.get(key(name)), `size ${size} verifies on read`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("re-publishing identical content keeps the published directory", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    // Two runs of one step that agree on what a guest reads and disagree on
    // how qemu stored it. That is not a hypothetical: a qcow2 written by a
    // booted guest records cluster ordering that follows I/O completion order,
    // measured at four distinct container digests over one filesystem.
    const first = await layer(store, "k", "one way", {
      contentSha256: "content-of-k",
    });
    const dir = `${root}/layers/k`;
    const before = (await Deno.stat(dir)).ino;
    const second = await layer(store, "k", "another way", {
      contentSha256: "content-of-k",
    });

    // Content is the layer's identity, so there is nothing to swap. The
    // directory a child resolves `../k/image.qcow2` through never moves, and
    // there is no instant at which the key resolves to nothing.
    assertEquals((await Deno.stat(dir)).ino, before, "same directory");
    assertEquals(await Deno.readTextFile(second.path), "one way");
    assertEquals(second.containerSha256, first.containerSha256);
    // publish() returns what is actually at the key, because build() chains
    // the next layer's realization key off the value it gets back.
    assertEquals(second.contentSha256, "content-of-k");
    assertEquals(await statOrNull(`${root}/layers/k.partial`), null);
    assertEquals(await names(root, "k.stale-"), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("re-publishing different content replaces it, leaving no debris", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await layer(store, "k", "first");
    // Reachable with no concurrency at all: an uncacheable layer skips the
    // cache lookup and so reaches publish() on every single run. A cacheable
    // one cannot get here having changed — it only publishes after a miss, and
    // the same key then means the same content.
    const second = await layer(store, "k", "second");
    assertEquals(
      await Deno.readTextFile(second.path),
      "second",
      "the fresh bytes win",
    );
    // The old directory is renamed aside rather than deleted in place, so the
    // key is unresolvable for one syscall instead of one recursive delete —
    // but the aside copy does not outlive the call.
    assertEquals(await names(root, "k.stale-"), []);
    assertEquals(await statOrNull(`${root}/layers/k.partial`), null);
    assertEquals((await store.list()).length, 1);
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
    // A separate LayerStore models a separate process. `flock` is held per open
    // file description, not per process, so the kernel refuses the second
    // handle here exactly as it would refuse another process's. Without it both
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

Deno.test("releasing a lock leaves the file, so two openers cannot both hold it", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await store.begin(key("k"));
    const lockPath = `${root}/layers/k.lock`;
    const before = (await Deno.stat(lockPath)).ino;
    assert(before !== null, "this store needs a filesystem that has inodes");

    // A second arrival caught mid-acquire: it has the path open and has not
    // taken the lock yet. That is the entire window, and it is why release must
    // not unlink — a lock is a lock on an INODE, and unlinking hands this
    // handle one that nothing else can reach while the next arrival creates a
    // fresh file and locks that.
    const waiter = await Deno.open(lockPath, {
      read: true,
      write: true,
      create: true,
    });
    try {
      await store.abandon(key("k"));
      assertEquals(await waiter.tryLock(true), true, "the waiter gets it");

      // Now a fresh arrival takes exactly the path begin() takes. It has to
      // find the key held: two holders is two builds publishing over each
      // other, which is the whole thing the lock exists to stop. Against a
      // release that unlinks, this call SUCCEEDS — it creates a new file and
      // locks that, while the waiter above still holds the old inode.
      const arriving = new LayerStore(root, { lockTimeoutMs: 250 });
      await assertRejects(
        () => arriving.begin(key("k")),
        LayerBusyError,
        "is being built by another process",
      );
      assertEquals(
        (await Deno.stat(lockPath)).ino,
        before,
        "release left a different file, or none",
      );
    } finally {
      waiter.close();
    }
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
    assertEquals(await statOrNull(dir), null);
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
    const mid = await layer(store, "mid", "m", { parent: base });
    const leaf = await layer(store, "leaf", "l", { parent: mid });
    const orphan = await layer(store, "orphan", "o", { parent: base });

    const { removed, reclaimedBytes } = await store.gc({
      keep: [leaf.realizationKey],
    });
    // Deleting an ancestor would be the worst possible outcome: a qcow2
    // overlay is a delta, so a child whose parent vanished reads someone
    // else's clusters or fails to open at all.
    assertEquals(removed, [orphan.realizationKey]);
    assert(await store.get(key("base")), "the ancestor survived");
    assert(await store.get(key("mid")), "the intermediate survived");
    assertEquals(await store.get(key("orphan")), undefined);
    assert(reclaimedBytes > 0, "the orphan's bytes are reported reclaimed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc reports the whole layer directory, not just the image", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const kept = await layer(store, "keep", "0123456789");
    const { keptBytes } = await store.gc({ keep: [kept.realizationKey] });
    const image = (await Deno.stat(kept.path)).size;
    const manifest =
      (await Deno.stat(`${root}/layers/keep/manifest.json`)).size;
    // "How much am I still holding" is one of the two questions gc exists to
    // answer, and the manifest is part of the answer.
    assert(manifest > 0);
    assertEquals(keptBytes, image + manifest);
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
    // The in-flight layer has no manifest, so it is not a candidate for
    // collection as a LAYER — but its `.partial` directory is exactly what gc
    // reclaims after a crash, and the held lock is the only thing that tells
    // the two apart. gc must skip it, and must not block on it.
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

Deno.test("gc collects the partial directory a killed build left behind", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const kept = await layer(store, "keep", "k");
    // A build killed between begin() and publish(): the directory is there and
    // nobody holds the key's lock. Staged by hand because a live begin() would
    // hold that lock, which is the difference this is about.
    const dead = `${root}/layers/dead.partial`;
    await Deno.mkdir(dead, { recursive: true });
    await Deno.writeTextFile(`${dead}/image.qcow2`, "half-written");

    const { removed, reclaimedBytes } = await store.gc({
      keep: [kept.realizationKey],
    });
    assertEquals(await statOrNull(dead), null, "the debris was reclaimed");
    // It was never a published layer, so it is not reported as one removed.
    assertEquals(removed, []);
    assertEquals(reclaimedBytes, "half-written".length);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc collects a directory publish was killed between its renames", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    const kept = await layer(store, "keep", "k");
    const stale = `${root}/layers/keep.stale-0123`;
    await Deno.mkdir(stale, { recursive: true });
    await Deno.writeTextFile(`${stale}/image.qcow2`, "old");
    // With the manifest copied across it is a complete layer by every test the
    // store applies except its name — so a collector that walked directory
    // names naively would serve it, and a lister would count it twice.
    await Deno.copyFile(
      `${root}/layers/keep/manifest.json`,
      `${stale}/manifest.json`,
    );
    assertEquals((await store.list()).length, 1, "not a layer");

    const { removed } = await store.gc({ keep: [kept.realizationKey] });
    assertEquals(await statOrNull(stale), null);
    assertEquals(removed, []);
    assert(await store.get(key("keep")), "the live layer is untouched");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gc sweeps stale scratch entries and keeps the fresh ones", async () => {
  const root = await scratch();
  try {
    const store = new LayerStore(root);
    await Deno.mkdir(store.scratchDir, { recursive: true });
    const leaked = `${store.scratchDir}/content-abc.raw`;
    await Deno.writeTextFile(leaked, "leaked");
    // Nothing in the store can prove a scratch file is idle — its writers hold
    // no lock on it — so age is the only signal there is. A zero cutoff means
    // "anything already written".
    const swept = await store.gc({ keep: [], scratchStaleMs: 0 });
    assertEquals(await statOrNull(leaked), null);
    assertEquals(swept.reclaimedBytes, "leaked".length);

    const live = `${store.scratchDir}/content-def.raw`;
    await Deno.writeTextFile(live, "live");
    const kept = await store.gc({ keep: [] });
    assert(await statOrNull(live), "a file younger than the cutoff is kept");
    assertEquals(kept.reclaimedBytes, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
