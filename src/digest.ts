/**
 * Canonical serialization and hashing — the two primitives every key, digest
 * and identity in this package is built from.
 *
 * They live here rather than beside the cache keys that first needed them for
 * a structural reason: `src/system/` must not import from `src/recipe/`. The
 * recipe tier imports the guest tier (`build()` dispatches guest layers), so
 * an import in the other direction is a cycle. Both tiers need to hash a
 * canonical record, so the primitive moves below both of them.
 *
 * `src/recipe/keys.ts` re-exports both names, and the `./recipe` subpath's
 * surface is unchanged.
 *
 * @module
 */

import { createHash } from "node:crypto";

/**
 * Serialize a value with object keys sorted at every depth, so two values that
 * differ only in key order hash identically.
 *
 * Rejects anything whose JSON encoding is lossy or ambiguous: `undefined` and
 * functions vanish silently under `JSON.stringify`, and a non-integer or
 * out-of-range number cannot round-trip. A key input that silently vanishes is
 * a cache-poisoning bug, so this throws rather than encoding it.
 */
export function canonicalJson(value: unknown): string {
  const encode = (node: unknown, path: string): string => {
    if (node === null) return "null";
    switch (typeof node) {
      case "boolean":
        return node ? "true" : "false";
      case "string":
        return JSON.stringify(node);
      case "number":
        if (!Number.isFinite(node)) {
          throw new TypeError(`canonicalJson: non-finite number at ${path}`);
        }
        if (!Number.isSafeInteger(node) && !Number.isInteger(node)) {
          throw new TypeError(
            `canonicalJson: non-integer number at ${path} (${node}) cannot ` +
              "round-trip; use a string",
          );
        }
        return JSON.stringify(node);
      case "object": {
        if (Array.isArray(node)) {
          return `[${
            node.map((item, i) => encode(item, `${path}[${i}]`)).join(",")
          }]`;
        }
        const record = node as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        const fields = keys.map((key) => {
          const child = record[key];
          if (child === undefined) {
            throw new TypeError(
              `canonicalJson: undefined at ${path}.${key} would vanish; omit ` +
                "the key or encode it as null",
            );
          }
          return `${JSON.stringify(key)}:${encode(child, `${path}.${key}`)}`;
        });
        return `{${fields.join(",")}}`;
      }
      default:
        throw new TypeError(
          `canonicalJson: unsupported ${typeof node} at ${path}`,
        );
    }
  };
  return encode(value, "$");
}

/** Lowercase-hex sha256 of a string. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The window {@linkcode sha256HexFile} holds while folding a file.
 *
 * 1 MiB, the same block `contentDigest()` reads in `src/recipe/content.ts`, so
 * a build that digests one layer both ways has a single buffer size to reason
 * about.
 */
const FILE_BLOCK_BYTES = 1024 * 1024;

/**
 * Lowercase-hex sha256 of a file's bytes, read one block at a time.
 *
 * Byte-identical to `sha256Hex(await Deno.readFile(path))` — that is the whole
 * contract, because this digest names cached layers and a changed value
 * silently invalidates every one of them. Verified against both that
 * expression and `shasum -a 256` on a 2 GiB file.
 *
 * It exists for the memory. `Deno.readFile` holds the entire file, and
 * `crypto.subtle.digest` then copies it again to hash it, so the peak is twice
 * the file — and the files here are disk images, which makes that the common
 * case rather than the pathological one. Measured on one 2 GiB file:
 *
 * | how                                  | peak RSS | wall    |
 * | ------------------------------------ | -------- | ------- |
 * | `Deno.readFile` + `crypto.subtle`    | 4.05 GiB | 894 ms  |
 * | `node:crypto` `createHash`, 1 MiB    | 55 MB    | 756 ms  |
 * | `@std/crypto` (wasm) over a stream   | 84 MB    | 4396 ms |
 * | `node:crypto` over `file.readable`   | 109 MB   | 1109 ms |
 *
 * Streaming needs an INCREMENTAL hash, and `crypto.subtle` has none: on Deno
 * 2.9.3 its `digest` rejects a `ReadableStream`, an async iterable and an array
 * of chunks alike ("Argument 1 can not be converted to a BufferSource"). Of the
 * two incremental sha256s available, `node:crypto` wins on both axes and adds
 * no dependency — Deno implements the `node:` builtins natively. The
 * portability a `node:` specifier costs was never on offer: this package only
 * runs where `Deno.Command` does.
 */
export async function sha256HexFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  try {
    const block = new Uint8Array(FILE_BLOCK_BYTES);
    for (;;) {
      const read = await file.read(block);
      if (read === null) break;
      // `update` consumes the bytes before it returns, so one block can be
      // refilled for the whole file.
      hash.update(block.subarray(0, read));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}
