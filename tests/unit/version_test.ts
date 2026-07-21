import { assertEquals, assertThrows } from "@std/assert";
import { QemuImgOutputError } from "../../src/errors.ts";
import { parseQemuImgVersion } from "../../src/version.ts";

Deno.test("parses the release form with a copyright tail", () => {
  const version = parseQemuImgVersion(
    "qemu-img version 10.0.2\n" +
      "Copyright (c) 2003-2025 Fabrice Bellard and the QEMU Project developers\n",
  );
  assertEquals(version, { raw: "10.0.2", major: 10, minor: 0, patch: 2 });
});

Deno.test("parses a prerelease suffix", () => {
  const version = parseQemuImgVersion("qemu-img version 9.1.0-rc2");
  assertEquals(version.raw, "9.1.0-rc2");
  assertEquals(version.major, 9);
  assertEquals(version.prerelease, "rc2");
});

Deno.test("parses a distro-suffixed build", () => {
  const version = parseQemuImgVersion(
    "qemu-img version 8.2.2~ds-0ubuntu1.4",
  );
  assertEquals(version.major, 8);
  assertEquals(version.minor, 2);
  assertEquals(version.patch, 2);
  assertEquals(version.prerelease, "ds-0ubuntu1.4");
});

Deno.test("parses a bare version string", () => {
  assertEquals(parseQemuImgVersion("10.0.2").raw, "10.0.2");
  assertEquals(parseQemuImgVersion("v10.0.2").raw, "10.0.2");
});

Deno.test("throws QemuImgOutputError on unrecognizable output", () => {
  assertThrows(
    () => parseQemuImgVersion("not a version"),
    QemuImgOutputError,
    "unrecognized qemu-img version output",
  );
});
