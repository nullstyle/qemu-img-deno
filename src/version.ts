/**
 * `qemu-img --version` parsing.
 *
 * @module
 */

import { QemuImgOutputError } from "./errors.ts";

/** A parsed `qemu-img --version`. */
export interface QemuImgVersion {
  /** The raw version string as printed (e.g. `"10.0.2"`, `"9.1.0-rc2"`). */
  readonly raw: string;
  /** Major version component. */
  readonly major: number;
  /** Minor version component. */
  readonly minor: number;
  /** Patch version component. */
  readonly patch: number;
  /** Prerelease / distro suffix, when present (e.g. `"rc2"`). */
  readonly prerelease?: string;
}

const VERSION_PATTERN =
  /version\s+v?(\d+)\.(\d+)\.(\d+)(?:[-~]([0-9A-Za-z.+~-]+))?/;
const BARE_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-~]([0-9A-Za-z.+~-]+))?$/;

/**
 * Parse `qemu-img --version` output. Accepts the release form
 * (`qemu-img version 10.0.2` followed by a copyright line), prerelease and
 * distro-suffixed builds (`qemu-img version 9.1.0-rc2`,
 * `… version 8.2.2~ds-0ubuntu1`), and a bare version string.
 * Throws {@linkcode QemuImgOutputError} when the output is unrecognizable.
 */
export function parseQemuImgVersion(output: string): QemuImgVersion {
  const trimmed = output.trim();
  const match = VERSION_PATTERN.exec(trimmed) ?? BARE_PATTERN.exec(trimmed);
  if (match === null) {
    throw new QemuImgOutputError(
      "unrecognized qemu-img version output",
      output,
    );
  }
  const [, major, minor, patch, prerelease] = match;
  const raw = `${major}.${minor}.${patch}${
    prerelease === undefined ? "" : `-${prerelease}`
  }`;
  return {
    raw,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}
