import { assert, assertEquals, assertThrows } from "@std/assert";
import { buildGpt, crc32, PARTITION_TYPE_GUIDS } from "../../src/fs/gpt.ts";
import {
  diagnoseGpt,
  DiskView,
  encodeGptEntries,
  encodeGptHeader,
  type GptEntry,
  GptParseError,
  type GptProblemCode,
  GptRepairRefusedError,
  parseGpt,
  parseGptView,
  planGptRepair,
  repairGpt,
} from "../../src/block/mod.ts";

const DISK_GUID = "12345678-1234-4234-8234-123456789ABC";
const PART_GUID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const MiB = 1024 * 1024;

/** A raw disk image with a GPT written by the package's own writer. */
function makeDisk(options: {
  diskSizeBytes: number;
  sectorSize?: 512 | 4096;
  diskGuid?: string;
  partitions?: readonly {
    firstLba: number;
    lastLba: number;
    name: string;
    uniqueGuid?: string;
  }[];
}): Uint8Array {
  const sectorSize = options.sectorSize ?? 512;
  const gpt = buildGpt({
    diskSizeBytes: options.diskSizeBytes,
    sectorSize,
    diskGuid: options.diskGuid ?? DISK_GUID,
    partitions: (options.partitions ?? []).map((partition) => ({
      typeGuid: PARTITION_TYPE_GUIDS["linux-generic"],
      uniqueGuid: partition.uniqueGuid ?? PART_GUID,
      firstLba: partition.firstLba,
      lastLba: partition.lastLba,
      name: partition.name,
    })),
  });
  const bytes = new Uint8Array(options.diskSizeBytes);
  bytes.set(gpt.primary, 0);
  bytes.set(gpt.backup, gpt.backupOffsetBytes);
  return bytes;
}

/** A full partition entry, defaulted so tests name only what they care about. */
function entry(options: Partial<GptEntry> & { index: number }): GptEntry {
  return {
    typeGuid: PARTITION_TYPE_GUIDS["linux-generic"],
    uniqueGuid: PART_GUID,
    firstLba: 2048,
    lastLba: 4095,
    attributes: 0n,
    name: "part",
    ...options,
  };
}

function protectiveMbr(totalSectors: number, sectorSize: number): Uint8Array {
  const bytes = new Uint8Array(sectorSize);
  const view = new DataView(bytes.buffer);
  bytes[450] = 0xee;
  view.setUint32(454, 1, true);
  view.setUint32(458, Math.min(totalSectors - 1, 0xffffffff), true);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

/**
 * Lay a table down with **this module's own** encoders.
 *
 * `buildGpt` cannot serve here: it throws `RangeError` for every 4096-byte
 * sector size (measured against src/fs/gpt.ts at the time of writing — its
 * `ARRAY_SECTORS` constant is computed against a hardcoded 512 and then
 * multiplied by the real sector size). Encoding the table here also makes the
 * round trip through `encodeGptHeader`/`encodeGptEntries` a tested path.
 */
function layTable(options: {
  diskSizeBytes: number;
  sectorSize: 512 | 4096;
  entries: readonly GptEntry[];
  diskGuid?: string;
}): Uint8Array {
  const { diskSizeBytes, sectorSize } = options;
  const totalSectors = Math.floor(diskSizeBytes / sectorSize);
  const arraySectors = Math.ceil(128 * 128 / sectorSize);
  const entryBytes = encodeGptEntries(options.entries, 128, 128);
  const common = {
    revision: 0x00010000,
    headerSizeBytes: 92,
    headerCrc32: 0,
    firstUsableLba: 2 + arraySectors,
    lastUsableLba: totalSectors - arraySectors - 2,
    diskGuid: options.diskGuid ?? DISK_GUID,
    entryCount: 128,
    entrySizeBytes: 128,
    entriesCrc32: crc32(entryBytes),
  };
  const disk = new Uint8Array(diskSizeBytes);
  disk.set(protectiveMbr(totalSectors, sectorSize), 0);
  disk.set(
    encodeGptHeader({
      ...common,
      myLba: 1,
      alternateLba: totalSectors - 1,
      entryArrayLba: 2,
    }, sectorSize),
    sectorSize,
  );
  disk.set(entryBytes, 2 * sectorSize);
  disk.set(entryBytes, (totalSectors - arraySectors - 1) * sectorSize);
  disk.set(
    encodeGptHeader({
      ...common,
      myLba: totalSectors - 1,
      alternateLba: 1,
      entryArrayLba: totalSectors - arraySectors - 1,
    }, sectorSize),
    (totalSectors - 1) * sectorSize,
  );
  return disk;
}

/** Rewrite only the primary side, leaving whatever is at the tail alone. */
function rewritePrimary(
  disk: Uint8Array,
  sectorSize: 512 | 4096,
  entries: readonly GptEntry[],
  header: { alternateLba: number; lastUsableLba: number },
): void {
  const arraySectors = Math.ceil(128 * 128 / sectorSize);
  const entryBytes = encodeGptEntries(entries, 128, 128);
  disk.set(
    encodeGptHeader({
      revision: 0x00010000,
      headerSizeBytes: 92,
      headerCrc32: 0,
      myLba: 1,
      alternateLba: header.alternateLba,
      firstUsableLba: 2 + arraySectors,
      lastUsableLba: header.lastUsableLba,
      diskGuid: DISK_GUID,
      entryArrayLba: 2,
      entryCount: 128,
      entrySizeBytes: 128,
      entriesCrc32: crc32(entryBytes),
    }, sectorSize),
    sectorSize,
  );
  disk.set(entryBytes, 2 * sectorSize);
}

function grow(disk: Uint8Array, toBytes: number): Uint8Array {
  const out = new Uint8Array(toBytes);
  out.set(disk);
  return out;
}

function codes(problems: readonly { code: GptProblemCode }[]): string[] {
  return problems.map((problem) => problem.code);
}

Deno.test("parseGpt reads back what buildGpt wrote, both sides", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const parsed = parseGpt(disk);

  assertEquals(parsed.sectorSize, 512);
  assertEquals(parsed.totalSectors, 32768);
  assert(parsed.protectiveMbr, "0xEE protective MBR at LBA 0");
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "ok");
  assertEquals(parsed.primary.header?.myLba, 1);
  assertEquals(parsed.primary.header?.alternateLba, 32767);
  assertEquals(parsed.backup.header?.myLba, 32767);
  assertEquals(parsed.backup.header?.alternateLba, 1);
  assertEquals(parsed.primary.header?.diskGuid, DISK_GUID);
  assertEquals(parsed.primary.header?.lastUsableLba, 32768 - 34);

  assertEquals(parsed.primary.entries.length, 1);
  const entry = parsed.primary.entries[0];
  assertEquals(entry.index, 0);
  assertEquals(entry.name, "root");
  assertEquals(entry.firstLba, 2048);
  assertEquals(entry.lastLba, 20000);
  assertEquals(entry.typeGuid, PARTITION_TYPE_GUIDS["linux-generic"]);
  assertEquals(diagnoseGpt(parsed).ok, true);
});

Deno.test("a 4096-byte sector table is probed, not assumed", () => {
  const disk = layTable({
    diskSizeBytes: 16 * MiB,
    sectorSize: 4096,
    entries: [entry({ index: 0, firstLba: 256, lastLba: 2000, name: "root" })],
  });
  const parsed = parseGpt(disk);
  assertEquals(parsed.sectorSize, 4096);
  assertEquals(parsed.totalSectors, 4096);
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "ok");
  // 128 entries of 128 bytes is 4 sectors here, not the 32 a 512-byte disk
  // needs — the geometry has to follow the sector size, not a constant.
  assertEquals(parsed.primary.header?.firstUsableLba, 6);
  assertEquals(parsed.primary.header?.lastUsableLba, 4096 - 6);
  assertEquals(parsed.backup.header?.myLba, 4095);
  assertEquals(parsed.primary.entries[0].name, "root");
  assertEquals(diagnoseGpt(parsed).ok, true);
});

Deno.test("grow and repair at a 4096-byte sector size", () => {
  const disk = layTable({
    diskSizeBytes: 16 * MiB,
    sectorSize: 4096,
    entries: [entry({ index: 0, firstLba: 256, lastLba: 2000, name: "root" })],
  });
  const grown = grow(disk, 24 * MiB);
  const parsed = parseGpt(grown, { sectorSize: 4096 });
  assertEquals(parsed.stranded?.lba, 4095);
  assertEquals(codes(diagnoseGpt(parsed).problems), [
    "backup-stranded",
    "last-usable-stale",
    "alternate-lba-stale",
  ]);

  const after = parseGpt(repairGpt(grown, { sectorSize: 4096 }), {
    sectorSize: 4096,
  });
  assertEquals(after.totalSectors, 6144);
  assertEquals(after.backup.header?.myLba, 6143);
  assertEquals(after.primary.header?.lastUsableLba, 6144 - 6);
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("grow: the backup is stranded, and both headers are stale", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const grown = grow(disk, 24 * MiB);
  const parsed = parseGpt(grown);

  assertEquals(parsed.primary.status, "ok", "the primary still verifies");
  assertEquals(parsed.backup.status, "no-signature", "nothing at the new end");
  assertEquals(parsed.stranded?.status, "ok", "the old backup is still there");
  assertEquals(parsed.stranded?.lba, 32767);

  const diagnosis = diagnoseGpt(parsed);
  assertEquals(diagnosis.ok, false);
  assertEquals(codes(diagnosis.problems), [
    "backup-stranded",
    "last-usable-stale",
    "alternate-lba-stale",
  ]);
  assert(
    diagnosis.problems.every((problem) => problem.repairable),
    "a grow is losslessly repairable",
  );
  // The measured distance, not a guess: 8 MiB of new space.
  assert(
    diagnosis.problems[0].detail.includes(String(8 * MiB)),
    diagnosis.problems[0].detail,
  );
});

Deno.test("grow: repair moves the backup and restates both headers", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const grown = grow(disk, 24 * MiB);
  const repaired = repairGpt(grown);
  const parsed = parseGpt(repaired);

  assertEquals(parsed.totalSectors, 49152);
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "ok");
  assertEquals(parsed.backup.header?.myLba, 49151);
  assertEquals(parsed.primary.header?.alternateLba, 49151);
  assertEquals(parsed.primary.header?.lastUsableLba, 49152 - 34);
  assertEquals(parsed.backup.header?.lastUsableLba, 49152 - 34);
  // Identity and contents survive: this is a repair, not a rebuild.
  assertEquals(parsed.primary.header?.diskGuid, DISK_GUID);
  assertEquals(parsed.primary.entries.length, 1);
  assertEquals(parsed.primary.entries[0].name, "root");
  assertEquals(parsed.primary.entries[0].lastLba, 20000);
  assertEquals(diagnoseGpt(parsed).ok, true);

  // The stranded copy is gone, so nothing scanning the disk finds a second
  // valid "EFI PART" that no header points at.
  assertEquals(parsed.stranded, undefined);
  const oldBackupAt = 32767 * 512;
  assertEquals(
    new TextDecoder().decode(repaired.subarray(oldBackupAt, oldBackupAt + 8)),
    "\0\0\0\0\0\0\0\0",
  );
});

Deno.test("grow: repair is idempotent and the healthy case writes nothing", () => {
  const grown = grow(
    makeDisk({
      diskSizeBytes: 16 * MiB,
      partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
    }),
    24 * MiB,
  );
  const once = repairGpt(grown);
  const twice = repairGpt(once);
  assertEquals(once, twice);
  assertEquals(planGptRepair(parseGpt(once)).changed, false);
});

Deno.test("grow: a stranded backup under a partition is left alone", () => {
  // The real sequence this guards: after a grow, a partition is extended to
  // fill the new space (by growpart, gdisk, or by hand) and the primary is
  // rewritten, while the old backup header still sits mid-disk — now
  // underneath the partition that was just extended over it. Zeroing that
  // sector blindly would punch a hole in the filesystem on top of it.
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 32700, name: "root" }],
  });
  const grown = grow(disk, 24 * MiB);
  rewritePrimary(
    grown,
    512,
    [entry({ index: 0, firstLba: 2048, lastLba: 40000, name: "root" })],
    { alternateLba: 32767, lastUsableLba: 32734 },
  );

  const parsed = parseGpt(grown);
  assertEquals(parsed.stranded?.status, "ok");
  assertEquals(parsed.stranded?.lba, 32767);
  const plan = planGptRepair(parsed);
  assertEquals(
    plan.writes.filter((write) => write.what.startsWith("stranded")).length,
    0,
    "the stranded header sits inside partition 1, so it is not overwritten",
  );

  // The partition's bytes survive, and the table is still repaired.
  const after = parseGpt(repairGpt(grown));
  assertEquals(after.primary.entries[0].lastLba, 40000);
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("shrink: the backup is gone, and repair rebuilds it from the primary", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const shrunk = disk.slice(0, 12 * MiB);
  const parsed = parseGpt(shrunk);

  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "no-signature");
  assertEquals(parsed.stranded, undefined, "the old backup is off the end");
  const diagnosis = diagnoseGpt(parsed);
  assertEquals(codes(diagnosis.problems), [
    "backup-missing",
    "last-usable-stale",
    "alternate-lba-stale",
  ]);

  const repaired = repairGpt(shrunk);
  const after = parseGpt(repaired);
  assertEquals(after.backup.status, "ok");
  assertEquals(after.backup.header?.myLba, 24576 - 1);
  assertEquals(after.primary.header?.lastUsableLba, 24576 - 34);
  assertEquals(after.primary.entries[0].name, "root");
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("shrink: a partition past the new end is REFUSED, not truncated", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 30000, name: "root" }],
  });
  const shrunk = disk.slice(0, 12 * MiB);
  const parsed = parseGpt(shrunk);

  const diagnosis = diagnoseGpt(parsed);
  assert(codes(diagnosis.problems).includes("partition-past-last-usable"));
  const problem = diagnosis.problems.find((p) =>
    p.code === "partition-past-last-usable"
  )!;
  assertEquals(problem.repairable, false);
  // 24576 sectors, last usable 24542; the partition ends at 30000.
  assert(problem.detail.includes("30000"), problem.detail);
  assert(problem.detail.includes("24542"), problem.detail);
  assert(
    problem.detail.includes(String((30000 - 24542) * 512)),
    "the shortfall is stated in bytes: " + problem.detail,
  );

  const error = assertThrows(
    () => repairGpt(shrunk),
    GptRepairRefusedError,
    "cannot be repaired without losing data",
  ) as GptRepairRefusedError;
  assertEquals(error.problems.length, 1);
  assertEquals(error.problems[0].code, "partition-past-last-usable");
});

Deno.test("the refused shrink names a grow-back size that actually works", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 30000, name: "root" }],
  });
  const shrunk = disk.slice(0, 12 * MiB);
  const problem = diagnoseGpt(parseGpt(shrunk)).problems.find((p) =>
    p.code === "partition-past-last-usable"
  )!;

  // The fix quotes an exact byte count. Take it literally and it must repair
  // cleanly — an unactionable number would be worse than no number at all.
  const quoted = problem.fix.match(/at least (\d+) bytes/);
  assert(quoted !== null, `no byte count in: ${problem.fix}`);
  const target = Number(quoted[1]);
  assertEquals(target, (30000 + 32 + 2) * 512);

  const regrown = grow(shrunk, target);
  const repaired = repairGpt(regrown);
  const after = parseGpt(repaired);
  assertEquals(diagnoseGpt(after).ok, true);
  assertEquals(after.primary.entries.length, 1, "nothing was dropped");
  assertEquals(after.primary.entries[0].lastLba, 30000);
  assert(after.primary.header!.lastUsableLba >= 30000);
});

Deno.test("acknowledgeDataLoss drops the entry whole; it never shortens one", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [
      { firstLba: 2048, lastLba: 4095, name: "EFI", uniqueGuid: PART_GUID },
      {
        firstLba: 4096,
        lastLba: 30000,
        name: "root",
        uniqueGuid: "BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF",
      },
    ],
  });
  const shrunk = disk.slice(0, 12 * MiB);
  const plan = planGptRepair(parseGpt(shrunk), { acknowledgeDataLoss: true });
  assertEquals(plan.droppedPartitions.length, 1);
  assertEquals(plan.droppedPartitions[0].name, "root");

  const repaired = repairGpt(shrunk, { acknowledgeDataLoss: true });
  const after = parseGpt(repaired);
  assertEquals(after.primary.entries.length, 1);
  assertEquals(after.primary.entries[0].name, "EFI");
  // The surviving entry keeps its own geometry untouched, and no clamped
  // stand-in for "root" was invented at the last usable LBA.
  assertEquals(after.primary.entries[0].lastLba, 4095);
  assert(
    after.primary.entries.every((entry) =>
      entry.lastLba !== after.primary.header!.lastUsableLba
    ),
    "no entry was clamped to fit",
  );
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("primary corrupt, backup intact: recovered the other direction", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  // Wipe the primary header sector, as a stray write to LBA 1 would.
  disk.fill(0, 512, 1024);
  const parsed = parseGpt(disk, { sectorSize: 512 });
  assertEquals(parsed.primary.status, "no-signature");
  assertEquals(parsed.backup.status, "ok");

  const diagnosis = diagnoseGpt(parsed);
  assertEquals(diagnosis.source, "backup");
  assert(codes(diagnosis.problems).includes("primary-corrupt"));

  const repaired = repairGpt(disk, { sectorSize: 512 });
  const after = parseGpt(repaired);
  assertEquals(after.primary.status, "ok");
  assertEquals(after.primary.header?.myLba, 1);
  assertEquals(after.primary.header?.entryArrayLba, 2);
  assertEquals(after.primary.entries[0].name, "root");
  assertEquals(after.primary.header?.diskGuid, DISK_GUID);
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("a flipped bit in the entry array is caught by its CRC", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  disk[2 * 512 + 40] ^= 0x01; // one bit of the primary entry's FirstLBA
  const parsed = parseGpt(disk);
  assertEquals(parsed.primary.status, "bad-entries-crc");
  assertEquals(parsed.backup.status, "ok");
  assertEquals(diagnoseGpt(parsed).source, "backup");

  const after = parseGpt(repairGpt(disk));
  assertEquals(after.primary.status, "ok");
  assertEquals(after.primary.entries[0].firstLba, 2048, "restored from backup");
});

Deno.test("both sides intact but disagreeing: refused, never picked", () => {
  const a = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const b = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 9999, name: "other" }],
  });
  // A's head, B's tail: both verify, and they describe different disks.
  const mixed = new Uint8Array(a);
  const tailFrom = (32768 - 33) * 512;
  mixed.set(b.subarray(tailFrom), tailFrom);

  const parsed = parseGpt(mixed);
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "ok");
  const diagnosis = diagnoseGpt(parsed);
  const problem = diagnosis.problems.find((p) => p.code === "headers-disagree");
  assert(problem !== undefined, codes(diagnosis.problems).join(","));
  assertEquals(problem.repairable, false);

  const error = assertThrows(
    () => repairGpt(mixed),
    GptRepairRefusedError,
  ) as GptRepairRefusedError;
  assertEquals(codes(error.problems), ["headers-disagree"]);
  assert(
    error.message.includes("picking a side silently discards"),
    error.message,
  );
});

Deno.test("a differing disk GUID alone is a disagreement", () => {
  const a = makeDisk({ diskSizeBytes: 16 * MiB, partitions: [] });
  const b = makeDisk({
    diskSizeBytes: 16 * MiB,
    diskGuid: "FFFFFFFF-1234-4234-8234-123456789ABC",
    partitions: [],
  });
  const mixed = new Uint8Array(a);
  const tailFrom = (32768 - 33) * 512;
  mixed.set(b.subarray(tailFrom), tailFrom);
  assertThrows(() => repairGpt(mixed), GptRepairRefusedError, "disk GUID");
});

Deno.test("no GPT at all is reported, not repaired into existence", () => {
  const blank = new Uint8Array(4 * MiB);
  const parsed = parseGpt(blank);
  const diagnosis = diagnoseGpt(parsed);
  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.source, "none");
  assertEquals(codes(diagnosis.problems), ["no-gpt"]);
  assert(diagnosis.problems[0].fix.includes("buildGpt"));
  const error = assertThrows(
    () => repairGpt(blank),
    GptRepairRefusedError,
    "holds a usable GPT",
  ) as GptRepairRefusedError;
  assertEquals(codes(error.problems), ["no-gpt"]);
});

Deno.test("an absurd entry count is refused before it is allocated for", () => {
  const disk = makeDisk({ diskSizeBytes: 16 * MiB, partitions: [] });
  // NumberOfPartitionEntries = 0xFFFFFFFF, then fix the header CRC so the
  // only thing standing between this and a 549 GiB allocation is the cap.
  const header = disk.subarray(512, 1024);
  const view = new DataView(header.buffer, header.byteOffset, 512);
  view.setUint32(80, 0xffffffff, true);
  view.setUint32(16, 0, true);
  view.setUint32(16, crc32(header.subarray(0, 92)), true);

  const parsed = parseGpt(disk);
  assertEquals(parsed.primary.status, "unsupported");
  assert(parsed.primary.note?.includes("4194304"), parsed.primary.note);
  // The backup is untouched, so the disk is still repairable from it.
  assertEquals(parsed.backup.status, "ok");
  assertEquals(diagnoseGpt(parsed).source, "backup");
});

Deno.test("a windowed view parses the same table as the whole image", () => {
  const disk = makeDisk({
    diskSizeBytes: 16 * MiB,
    partitions: [{ firstLba: 2048, lastLba: 20000, name: "root" }],
  });
  const whole = parseGpt(disk);

  // Only the two ends, as readGptImage fetches them.
  const span = 64 * 4096;
  const view = new DiskView(disk.byteLength, [
    { offsetBytes: 0, bytes: disk.subarray(0, span) },
    {
      offsetBytes: disk.byteLength - span,
      bytes: disk.subarray(disk.byteLength - span),
    },
  ]);
  const windowed = parseGptView(view);
  assertEquals(windowed.primary.status, whole.primary.status);
  assertEquals(windowed.backup.status, whole.backup.status);
  assertEquals(windowed.primary.entries, whole.primary.entries);
  assertEquals(diagnoseGpt(windowed).ok, true);
});

Deno.test("a missing protective MBR is a problem, and repair writes one", () => {
  const disk = makeDisk({ diskSizeBytes: 16 * MiB, partitions: [] });
  disk.fill(0, 0, 512);
  const diagnosis = diagnoseGpt(parseGpt(disk, { sectorSize: 512 }));
  assertEquals(codes(diagnosis.problems), ["protective-mbr-missing"]);

  const after = parseGpt(repairGpt(disk, { sectorSize: 512 }));
  assert(after.protectiveMbr);
  assertEquals(diagnoseGpt(after).ok, true);
});

Deno.test("every problem names a fix, and no fix names sgdisk", () => {
  // The whole point of this module: the README used to prescribe `sgdisk -e`
  // on a host that has never had sgdisk.
  const cases = [
    grow(makeDisk({ diskSizeBytes: 16 * MiB, partitions: [] }), 24 * MiB),
    makeDisk({
      diskSizeBytes: 16 * MiB,
      partitions: [{ firstLba: 2048, lastLba: 30000, name: "root" }],
    }).slice(0, 12 * MiB),
    new Uint8Array(4 * MiB),
  ];
  for (const disk of cases) {
    for (const problem of diagnoseGpt(parseGpt(disk)).problems) {
      assert(problem.fix.length > 0, `${problem.code} has no fix`);
      assert(
        !/sgdisk|gdisk|parted/.test(problem.fix),
        `${problem.code} prescribes a tool this host does not have: ` +
          problem.fix,
      );
    }
  }
});

// Defect #1: sameTable() omitted lastUsableLba, so two headers describing disks
// of different sizes read back as "the same table" — the disagreement went
// undetected and repair silently overwrote the backup with the primary's view.
Deno.test("headers disagreeing only on LastUsableLBA are caught, not merged", () => {
  const sectorSize = 512;
  const diskSizeBytes = 16 * MiB;
  const totalSectors = diskSizeBytes / sectorSize; // 32768
  const arraySectors = 32;
  const entries = [
    entry({ index: 0, firstLba: 2048, lastLba: 20000, name: "root" }),
  ];
  const disk = layTable({ diskSizeBytes, sectorSize, entries });

  // The primary keeps the correct LastUsableLBA — so `last-usable-stale` never
  // fires to mask the test — while the backup is rewritten, its own CRC still
  // valid, with a LastUsableLBA 100 sectors short. The two headers now describe
  // disks of different sizes, disagreeing on nothing else.
  const entryBytes = encodeGptEntries(entries, 128, 128);
  const correctLastUsable = totalSectors - arraySectors - 2; // 32734
  const backupHeader = encodeGptHeader({
    revision: 0x00010000,
    headerSizeBytes: 92,
    headerCrc32: 0,
    myLba: totalSectors - 1,
    alternateLba: 1,
    firstUsableLba: 2 + arraySectors,
    lastUsableLba: correctLastUsable - 100,
    diskGuid: DISK_GUID,
    entryArrayLba: totalSectors - arraySectors - 1,
    entryCount: 128,
    entrySizeBytes: 128,
    entriesCrc32: crc32(entryBytes),
  }, sectorSize);
  disk.set(backupHeader, (totalSectors - 1) * sectorSize);

  const parsed = parseGpt(disk);
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.backup.status, "ok", "the backup still self-verifies");
  assertEquals(parsed.primary.header?.lastUsableLba, correctLastUsable);
  assertEquals(parsed.backup.header?.lastUsableLba, correctLastUsable - 100);

  const diagnosis = diagnoseGpt(parsed);
  assertEquals(diagnosis.ok, false, "a header disagreement is not 'ok'");
  const problem = diagnosis.problems.find((p) => p.code === "headers-disagree");
  assert(problem !== undefined, codes(diagnosis.problems).join(","));
  assertEquals(problem.repairable, false);
  assert(problem.detail.includes("LastUsableLBA"), problem.detail);

  const error = assertThrows(
    () => repairGpt(disk),
    GptRepairRefusedError,
  ) as GptRepairRefusedError;
  assertEquals(codes(error.problems), ["headers-disagree"]);

  // The legitimate case is untouched: a healthy primary and backup differ in
  // MyLBA/AlternateLBA/PartitionEntryLBA by design, and that is NOT a
  // disagreement.
  const healthy = diagnoseGpt(parseGpt(layTable({
    diskSizeBytes,
    sectorSize,
    entries,
  })));
  assert(
    !codes(healthy.problems).includes("headers-disagree"),
    "the deliberate primary/backup differences must not read as a disagreement",
  );
  assertEquals(healthy.ok, true);
});

// Defect #2: the stranded-backup zeroing sized its write from entryArrayLba read
// out of a header whose CRC had failed — a negative length crashed with an
// untyped RangeError, a large one wiped an arbitrary span.
Deno.test("a stranded header with a failed CRC is refused, not trusted for a write", () => {
  const sectorSize = 512;
  const disk = layTable({
    diskSizeBytes: 16 * MiB,
    sectorSize,
    entries: [
      entry({ index: 0, firstLba: 2048, lastLba: 20000, name: "root" }),
    ],
  });
  const grown = grow(disk, 24 * MiB);

  // The old backup header sits stranded at LBA 32767 after the grow. Give it a
  // wild PartitionEntryLBA (well past its own sector) and leave the recorded
  // CRC alone, so the header no longer self-verifies. Sized from this u64 the
  // zeroing would compute `(32767 - 4294967295 + 1) * 512` — a negative
  // Uint8Array length, an untyped RangeError.
  const strandedLba = 32767;
  const patch = new DataView(
    grown.buffer,
    grown.byteOffset + strandedLba * sectorSize,
    sectorSize,
  );
  patch.setBigUint64(72, 0xffffffffn, true); // PartitionEntryLBA, CRC now stale

  const parsed = parseGpt(grown, { sectorSize });
  assertEquals(parsed.primary.status, "ok");
  assertEquals(parsed.stranded?.lba, strandedLba);
  assertEquals(parsed.stranded?.status, "bad-header-crc");
  assertEquals(parsed.stranded?.header?.entryArrayLba, 0xffffffff);

  const error = assertThrows(
    () => repairGpt(grown, { sectorSize }),
    GptRepairRefusedError,
  ) as GptRepairRefusedError;
  assertEquals(codes(error.problems), ["stranded-backup-unverifiable"]);
  assert(error.message.includes(String(strandedLba)), error.message);
});

// Defect #3: an entry array too big for the 256 KiB read window came back
// "unread" on both sides, which diagnoseGpt folded into "no-gpt" — telling the
// caller to RECREATE a table that was perfectly sound.
Deno.test("an entry array past the read window is 'unread', not 'no GPT'", () => {
  const sectorSize = 512;
  const diskSizeBytes = 8 * MiB;
  const totalSectors = diskSizeBytes / sectorSize; // 16384
  const entryCount = 4096; // 4096 * 128 = 512 KiB array, 1024 sectors
  const entrySize = 128;
  const arraySectors = Math.ceil(entryCount * entrySize / sectorSize); // 1024
  const backupArrayLba = totalSectors - arraySectors - 1; // 15359
  const backupHeaderLba = totalSectors - 1; // 16383

  const entryBytes = encodeGptEntries(
    [entry({ index: 0, firstLba: 1026, lastLba: 8000, name: "root" })],
    entryCount,
    entrySize,
  );
  const common = {
    revision: 0x00010000,
    headerSizeBytes: 92,
    headerCrc32: 0,
    firstUsableLba: 2 + arraySectors, // 1026
    lastUsableLba: totalSectors - arraySectors - 2, // 15358
    diskGuid: DISK_GUID,
    entryCount,
    entrySizeBytes: entrySize,
    entriesCrc32: crc32(entryBytes),
  };
  const disk = new Uint8Array(diskSizeBytes);
  disk.set(protectiveMbr(totalSectors, sectorSize), 0);
  disk.set(
    encodeGptHeader({
      ...common,
      myLba: 1,
      alternateLba: backupHeaderLba,
      entryArrayLba: 2,
    }, sectorSize),
    sectorSize,
  );
  disk.set(entryBytes, 2 * sectorSize);
  disk.set(entryBytes, backupArrayLba * sectorSize);
  disk.set(
    encodeGptHeader({
      ...common,
      myLba: backupHeaderLba,
      alternateLba: 1,
      entryArrayLba: backupArrayLba,
    }, sectorSize),
    backupHeaderLba * sectorSize,
  );

  // Read whole, this is a perfectly sound table.
  assertEquals(
    diagnoseGpt(parseGpt(disk, { sectorSize })).ok,
    true,
    "the disk itself is sound when fully read",
  );

  // Now read it as readGptImage does — only the first and last 256 KiB. The
  // 512 KiB entry array falls outside both windows, so both sides are unread.
  const span = 64 * 4096; // 262144, what readGptImage fetches
  const view = new DiskView(diskSizeBytes, [
    { offsetBytes: 0, bytes: disk.subarray(0, span) },
    {
      offsetBytes: diskSizeBytes - span,
      bytes: disk.subarray(diskSizeBytes - span),
    },
  ]);
  const parsed = parseGptView(view, { sectorSize });
  assertEquals(parsed.primary.status, "unread");
  assertEquals(parsed.backup.status, "unread");

  const diagnosis = diagnoseGpt(parsed);
  assertEquals(diagnosis.ok, false);
  const cs = codes(diagnosis.problems);
  assert(cs.includes("table-unread"), cs.join(","));
  assert(!cs.includes("no-gpt"), "a windowing limit is not 'no GPT'");
  for (const problem of diagnosis.problems) {
    assert(
      !/recreate/i.test(problem.fix),
      `an unread window must not tell the caller to recreate: ${problem.fix}`,
    );
    assert(
      /widen|read more|window/i.test(problem.fix),
      `the fix should be to widen the read: ${problem.fix}`,
    );
  }
});

// Defect #4: encodeGptEntries iterated the name by code POINT and wrote one
// UTF-16 unit per element, so an astral character was written as its lone high
// surrogate and the low surrogate was dropped.
Deno.test("encodeGptEntries preserves an astral name's surrogate pair", () => {
  const emoji = "😀"; // U+1F600 → UTF-16 D83D DE00, two code units
  const encoded = encodeGptEntries(
    [entry({ index: 0, name: emoji })],
    128,
    128,
  );
  const dv = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  // The name field starts at byte 56. Both units must be present.
  assertEquals(dv.getUint16(56, true), 0xd83d, "high surrogate");
  assertEquals(
    dv.getUint16(58, true),
    0xde00,
    "low surrogate — dropped by bug",
  );

  // And it round-trips through the reader as the original emoji, on both sides.
  const disk = layTable({
    diskSizeBytes: 16 * MiB,
    sectorSize: 512,
    entries: [entry({ index: 0, firstLba: 2048, lastLba: 20000, name: emoji })],
  });
  const parsed = parseGpt(disk);
  assertEquals(parsed.primary.entries[0].name, emoji, "round-trips (primary)");
  assertEquals(parsed.backup.entries[0].name, emoji, "round-trips (backup)");

  // The 36-unit cap is counted in code UNITS: 36 astral characters are 72 code
  // units and must be refused, where the by-code-point bug counted 36 and
  // silently truncated.
  assertThrows(
    () =>
      encodeGptEntries([entry({ index: 0, name: emoji.repeat(36) })], 128, 128),
    GptParseError,
  );
});
