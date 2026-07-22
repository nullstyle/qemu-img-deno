import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildGpt,
  bytesToGuid,
  crc32,
  deriveGuid,
  ENTRY_BYTES,
  guidToBytes,
  PARTITION_TYPE_GUIDS,
} from "../../src/fs/gpt.ts";

Deno.test("crc32 matches the published IEEE test vector", () => {
  // "123456789" -> 0xCBF43926 is the standard CRC-32 check value.
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("GUIDs serialize mixed-endian, as GPT stores them", () => {
  // The ESP type GUID's on-disk form is the canonical worked example: the
  // first three fields little-endian, the last two big-endian. Getting this
  // wrong yields a table that parses but whose types are unrecognizable.
  assertEquals(
    Array.from(guidToBytes(PARTITION_TYPE_GUIDS.esp)),
    [
      0x28,
      0x73,
      0x2a,
      0xc1,
      0x1f,
      0xf8,
      0xd2,
      0x11,
      0xba,
      0x4b,
      0x00,
      0xa0,
      0xc9,
      0x3e,
      0xc9,
      0x3b,
    ],
  );
  assertEquals(
    bytesToGuid(guidToBytes(PARTITION_TYPE_GUIDS.esp)),
    PARTITION_TYPE_GUIDS.esp,
  );
  assertThrows(() => guidToBytes("not-a-guid"), TypeError);
});

Deno.test("derived GUIDs are stable, seed-dependent, and well-formed v4", async () => {
  const a = await deriveGuid("seed", "disk");
  assertEquals(a, await deriveGuid("seed", "disk"), "same seed, same GUID");
  assert(a !== await deriveGuid("other", "disk"));
  assert(a !== await deriveGuid("seed", "partition:EFI"));
  // Version 4, variant RFC 4122 — some parsers reject anything else.
  assertEquals(a[14], "4");
  assert(["8", "9", "A", "B"].includes(a[19]), `variant nibble was ${a[19]}`);
});

Deno.test("GPT geometry: usable range, backup placement, signatures", () => {
  const diskSizeBytes = 1024 ** 3;
  const gpt = buildGpt({
    diskSizeBytes,
    diskGuid: "12345678-1234-4234-8234-123456789ABC",
    partitions: [{
      typeGuid: PARTITION_TYPE_GUIDS.esp,
      uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      firstLba: 2048,
      lastLba: 4095,
      name: "EFI",
    }],
  });
  const totalSectors = diskSizeBytes / 512;
  assertEquals(gpt.firstUsableLba, 34, "34 sectors of head: MBR+header+array");
  assertEquals(gpt.lastUsableLba, totalSectors - 34);
  assertEquals(gpt.backupOffsetBytes, (totalSectors - 33) * 512);

  // Protective MBR: type 0xEE covering the disk, and the boot signature.
  assertEquals(gpt.primary[446 + 4], 0xee);
  assertEquals(gpt.primary[510], 0x55);
  assertEquals(gpt.primary[511], 0xaa);
  assertEquals(
    new TextDecoder().decode(gpt.primary.subarray(512, 520)),
    "EFI PART",
  );
});

Deno.test("GPT geometry at a 4096-byte sector: 4 array sectors, not 32", () => {
  // The entry array is 16 KiB whatever the sector size, so 4096-byte sectors
  // need 4 of them where 512-byte sectors need 32. Sizing the array against a
  // hardcoded 512 overshoots by 8x and overflows the head it splices into.
  const sectorSize = 4096;
  const diskSizeBytes = 16 * 1024 * 1024;
  const gpt = buildGpt({
    diskSizeBytes,
    sectorSize,
    diskGuid: "12345678-1234-4234-8234-123456789ABC",
    partitions: [{
      typeGuid: PARTITION_TYPE_GUIDS.esp,
      uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      firstLba: 6,
      lastLba: 1023,
      name: "EFI",
    }],
  });
  const totalSectors = diskSizeBytes / sectorSize;
  assertEquals(gpt.firstUsableLba, 6, "MBR + header + 4 array sectors");
  assertEquals(gpt.lastUsableLba, totalSectors - 6);
  assertEquals(gpt.primary.byteLength, 6 * sectorSize);
  assertEquals(gpt.backup.byteLength, 5 * sectorSize);
  // The backup starts 5 sectors from the end and runs to the final byte.
  assertEquals(gpt.backupOffsetBytes, (totalSectors - 5) * sectorSize);
  assertEquals(gpt.backupOffsetBytes + gpt.backup.byteLength, diskSizeBytes);

  // The header's own CRC over the array is what proves the array is sized and
  // placed as the header advertises, rather than merely fitting the buffer.
  const arrayAt = 2 * sectorSize;
  const primaryHeader = new DataView(
    gpt.primary.buffer,
    sectorSize,
    sectorSize,
  );
  assertEquals(
    new TextDecoder().decode(gpt.primary.subarray(sectorSize, sectorSize + 8)),
    "EFI PART",
  );
  assertEquals(
    crc32(gpt.primary.subarray(arrayAt, arrayAt + ENTRY_BYTES * 128)),
    primaryHeader.getUint32(88, true),
    "entry-array CRC covers the array as written",
  );
  assertEquals(
    bytesToGuid(gpt.primary.subarray(arrayAt, arrayAt + 16)),
    PARTITION_TYPE_GUIDS.esp,
  );

  const backupHeader = new DataView(
    gpt.backup.buffer,
    4 * sectorSize,
    sectorSize,
  );
  assertEquals(backupHeader.getBigUint64(24, true), BigInt(totalSectors - 1));
  assertEquals(
    backupHeader.getBigUint64(72, true),
    BigInt(totalSectors - 5),
    "backup entry array LBA",
  );
  // The protective MBR's signature sits at byte 510 whatever the sector size.
  assertEquals(gpt.primary[510], 0x55);
  assertEquals(gpt.primary[511], 0xaa);
});

Deno.test("the backup header is not a copy: LBAs swapped, CRC recomputed", () => {
  const gpt = buildGpt({
    diskSizeBytes: 1024 ** 3,
    diskGuid: "12345678-1234-4234-8234-123456789ABC",
    partitions: [],
  });
  const totalSectors = 1024 ** 3 / 512;
  const primary = new DataView(gpt.primary.buffer, 512, 512);
  const backupAt = gpt.backup.byteLength - 512;
  const backup = new DataView(gpt.backup.buffer, backupAt, 512);

  // A byte-for-byte copy of the primary is an INVALID backup — some tools
  // accept it and others reject it, which is what makes it look intermittent.
  assertEquals(primary.getBigUint64(24, true), 1n, "primary MyLBA");
  assertEquals(
    backup.getBigUint64(24, true),
    BigInt(totalSectors - 1),
    "backup MyLBA is the last sector",
  );
  assertEquals(backup.getBigUint64(32, true), 1n, "backup AlternateLBA");
  assert(
    primary.getUint32(16, true) !== backup.getUint32(16, true),
    "the two header CRCs must differ",
  );

  // Both headers must self-verify with the CRC field zeroed.
  for (
    const [name, header] of [
      ["primary", gpt.primary.slice(512, 512 + 92)],
      ["backup", gpt.backup.slice(backupAt, backupAt + 92)],
    ] as const
  ) {
    const recorded = new DataView(header.buffer).getUint32(16, true);
    new DataView(header.buffer).setUint32(16, 0, true);
    assertEquals(crc32(header), recorded, `${name} header CRC self-verifies`);
  }
});

Deno.test("every byte of the footprint is written, including unused slots", () => {
  const gpt = buildGpt({
    diskSizeBytes: 1024 ** 3,
    diskGuid: "12345678-1234-4234-8234-123456789ABC",
    partitions: [{
      typeGuid: PARTITION_TYPE_GUIDS.esp,
      uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      firstLba: 2048,
      lastLba: 4095,
      name: "EFI",
    }],
  });
  // The array covers all 128 slots, so slots 1..127 are explicitly zeroed.
  // On a qcow2 OVERLAY unwritten clusters read THROUGH to the backing file,
  // so leaving them out would surface stale bytes as phantom partitions.
  assertEquals(gpt.primary.byteLength, 34 * 512);
  const arrayStart = 2 * 512;
  const secondSlot = gpt.primary.subarray(
    arrayStart + ENTRY_BYTES,
    arrayStart + ENTRY_BYTES * 128,
  );
  assert(secondSlot.every((byte) => byte === 0));
  // And the first slot really does carry the ESP type.
  assertEquals(
    bytesToGuid(gpt.primary.subarray(arrayStart, arrayStart + 16)),
    PARTITION_TYPE_GUIDS.esp,
  );
});

Deno.test("refuses a partition outside the usable range", () => {
  assertThrows(
    () =>
      buildGpt({
        diskSizeBytes: 1024 ** 2,
        diskGuid: "12345678-1234-4234-8234-123456789ABC",
        partitions: [{
          typeGuid: PARTITION_TYPE_GUIDS.esp,
          uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
          firstLba: 2048,
          lastLba: 999_999,
          name: "TooBig",
        }],
      }),
    RangeError,
    "outside the usable range",
  );
});

Deno.test("partition names round-trip as UTF-16LE and are length-checked", () => {
  const gpt = buildGpt({
    diskSizeBytes: 1024 ** 3,
    diskGuid: "12345678-1234-4234-8234-123456789ABC",
    partitions: [{
      typeGuid: PARTITION_TYPE_GUIDS["linux-generic"],
      uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      firstLba: 2048,
      lastLba: 4095,
      name: "root",
    }],
  });
  const at = 2 * 512 + 56;
  assertEquals(
    new TextDecoder("utf-16le").decode(gpt.primary.subarray(at, at + 8)),
    "root",
  );
  assertThrows(
    () =>
      buildGpt({
        diskSizeBytes: 1024 ** 3,
        diskGuid: "12345678-1234-4234-8234-123456789ABC",
        partitions: [{
          typeGuid: PARTITION_TYPE_GUIDS["linux-generic"],
          uniqueGuid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
          firstLba: 2048,
          lastLba: 4095,
          name: "x".repeat(37),
        }],
      }),
    TypeError,
    "36 UTF-16 code units",
  );
});
