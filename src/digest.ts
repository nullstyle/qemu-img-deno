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
