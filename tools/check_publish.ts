/**
 * Fail-closed publish-readiness gate. Run via `deno task publish:check`.
 *
 * Verifies deno.json is shaped for a real release: right name, a non-dev
 * version, the root export, the publish allowlist covering every required
 * file, and no dev-only import specifiers. Prints `release blocker: …` lines
 * and exits 1 on any failure.
 *
 * @module
 */

const PACKAGE_NAME = "@nullstyle/qemu-img";
const REQUIRED_INCLUDE = [
  "mod.ts",
  "src/**",
  "testing/**",
  "README.md",
  "LICENSE",
  "deno.json",
];
const DEV_SPECIFIER_PATTERNS = ["./vendor/", "http://", "https://"];

/** The publish-readiness failures for a parsed deno.json (empty = ready). */
export function publishReadinessFailures(denoJson: unknown): string[] {
  const failures: string[] = [];
  if (denoJson === null || typeof denoJson !== "object") {
    return ["deno.json is not an object"];
  }
  const config = denoJson as Record<string, unknown>;
  if (config.name !== PACKAGE_NAME) {
    failures.push(
      `package name must be ${PACKAGE_NAME} (found ${config.name})`,
    );
  }
  if (typeof config.version !== "string" || config.version === "0.0.0") {
    failures.push("version must be a real release version, not 0.0.0");
  }
  const exports = config.exports;
  if (
    exports === null || typeof exports !== "object" ||
    (exports as Record<string, unknown>)["."] !== "./mod.ts"
  ) {
    failures.push('the root export "." must be "./mod.ts"');
  }
  const include = (config.publish as Record<string, unknown> | undefined)
    ?.include;
  if (!Array.isArray(include)) {
    failures.push("publish.include allowlist is missing");
  } else {
    for (const required of REQUIRED_INCLUDE) {
      if (!include.includes(required)) {
        failures.push(`publish.include must contain ${required}`);
      }
    }
  }
  const imports = config.imports;
  if (imports !== null && typeof imports === "object") {
    for (
      const [specifier, target] of Object.entries(
        imports as Record<string, unknown>,
      )
    ) {
      if (typeof target !== "string") continue;
      for (const pattern of DEV_SPECIFIER_PATTERNS) {
        if (target.startsWith(pattern)) {
          failures.push(
            `import ${specifier} uses a dev-only specifier: ${target}`,
          );
        }
      }
    }
  }
  return failures;
}

if (import.meta.main) {
  const denoJson = JSON.parse(
    Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
  );
  const failures = publishReadinessFailures(denoJson);
  for (const failure of failures) {
    console.error(`release blocker: ${failure}`);
  }
  if (failures.length > 0) Deno.exit(1);
  console.log(`publish check ok: ${PACKAGE_NAME}@${denoJson.version}`);
}
