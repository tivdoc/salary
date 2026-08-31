import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export type DeterministicZipEntry = Readonly<{
  path: string;
  sha256: string;
  byte_count: number;
  compressed_byte_count: number;
  compression: 0;
  date_time: readonly [1980, 1, 1, 0, 0, 0];
  external_attr: number;
  create_system: 3;
}>;

export type DeterministicZipInspection = Readonly<{
  schema_version: "tivdoc-canonical-postgresql-dynamic-zip-inspection-v0.9.1";
  entries: readonly DeterministicZipEntry[];
  entry_count: number;
}>;

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const STORE = 0;
const DOS_TIME_MIDNIGHT = 0;
const DOS_DATE_1980_01_01 = (1 << 5) | 1;
const UNIX_REGULAR_FILE_0644 = 0o100644 * 65_536;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffff_ffff;
const MAX_EVIDENCE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

type MaterializedEntry = Readonly<{
  name: string;
  nameBytes: Buffer;
  content: Buffer;
  crc32: number;
  localOffset: number;
}>;

type CentralEntry = Readonly<{
  name: string;
  nameBytes: Buffer;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}>;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

export async function writeDeterministicStoreZip(input: Readonly<{
  root: string;
  output: string;
  entries: readonly string[];
}>): Promise<void> {
  if (input.entries.length === 0 || input.entries.length >= MAX_UINT16) {
    throw new Error("DYNAMIC_ZIP_ENTRY_COUNT_INVALID");
  }
  const unique = new Set<string>();
  const uniquePortable = new Set<string>();
  for (const name of input.entries) {
    assertSafeRelativeName(name);
    const portable = name.toLowerCase();
    if (unique.has(name) || uniquePortable.has(portable)) {
      throw new Error("DYNAMIC_ZIP_ENTRY_DUPLICATE");
    }
    unique.add(name);
    uniquePortable.add(portable);
  }

  const sourceRoot = await realpath(path.resolve(input.root));
  if (!(await lstat(sourceRoot)).isDirectory()) throw new Error("DYNAMIC_ZIP_ROOT_INVALID");
  const output = path.resolve(input.output);
  const localRecords: Buffer[] = [];
  const materialized: MaterializedEntry[] = [];
  let localOffset = 0;

  for (const name of input.entries) {
    const source = await resolveOrdinarySource(sourceRoot, name);
    if (samePath(source, output)) throw new Error("DYNAMIC_ZIP_OUTPUT_IS_SOURCE");
    const sourceMetadata = await lstat(source);
    if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.nlink !== 1
        || sourceMetadata.size > MAX_EVIDENCE_ENTRY_BYTES) {
      throw new Error("DYNAMIC_ZIP_SOURCE_FILE_INVALID");
    }
    const content = await readFile(source);
    if (content.byteLength !== sourceMetadata.size || content.byteLength > MAX_EVIDENCE_ENTRY_BYTES) {
      throw new Error("DYNAMIC_ZIP_ENTRY_TOO_LARGE");
    }
    const nameBytes = Buffer.from(name, "ascii");
    const checksum = crc32(content);
    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(STORE, 8);
    header.writeUInt16LE(DOS_TIME_MIDNIGHT, 10);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.byteLength, 18);
    header.writeUInt32LE(content.byteLength, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    const record = Buffer.concat([header, nameBytes, content]);
    materialized.push(Object.freeze({
      name,
      nameBytes,
      content,
      crc32: checksum,
      localOffset,
    }));
    localRecords.push(record);
    localOffset = checkedUint32(localOffset + record.byteLength, "DYNAMIC_ZIP_ARCHIVE_TOO_LARGE");
    if (localOffset > MAX_EVIDENCE_ARCHIVE_BYTES) throw new Error("DYNAMIC_ZIP_ARCHIVE_TOO_LARGE");
  }

  const centralOffset = localOffset;
  const centralRecords: Buffer[] = [];
  let centralSize = 0;
  for (const entry of materialized) {
    const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
    header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(STORE, 10);
    header.writeUInt16LE(DOS_TIME_MIDNIGHT, 12);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.content.byteLength, 20);
    header.writeUInt32LE(entry.content.byteLength, 24);
    header.writeUInt16LE(entry.nameBytes.byteLength, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(UNIX_REGULAR_FILE_0644, 38);
    header.writeUInt32LE(entry.localOffset, 42);
    const record = Buffer.concat([header, entry.nameBytes]);
    centralRecords.push(record);
    centralSize = checkedUint32(centralSize + record.byteLength, "DYNAMIC_ZIP_CENTRAL_DIRECTORY_TOO_LARGE");
  }

  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(materialized.length, 8);
  end.writeUInt16LE(materialized.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localRecords, ...centralRecords, end]);
  if (archive.byteLength > MAX_EVIDENCE_ARCHIVE_BYTES) throw new Error("DYNAMIC_ZIP_ARCHIVE_TOO_LARGE");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, archive, { flag: "wx", mode: 0o600 });
}

export async function inspectDeterministicStoreZip(archivePath: string): Promise<DeterministicZipInspection> {
  const archiveStats = await lstat(path.resolve(archivePath));
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.nlink !== 1) {
    throw new Error("DYNAMIC_ZIP_ARCHIVE_NOT_FILE");
  }
  if (archiveStats.size > MAX_EVIDENCE_ARCHIVE_BYTES) throw new Error("DYNAMIC_ZIP_ARCHIVE_SIZE_INVALID");
  const archive = await readFile(path.resolve(archivePath));
  if (archive.byteLength !== archiveStats.size || archive.byteLength < END_RECORD_BYTES
      || archive.byteLength > MAX_EVIDENCE_ARCHIVE_BYTES) {
    throw new Error("DYNAMIC_ZIP_ARCHIVE_SIZE_INVALID");
  }

  const endOffset = archive.byteLength - END_RECORD_BYTES;
  assertUInt32(archive, endOffset, END_OF_CENTRAL_DIRECTORY, "DYNAMIC_ZIP_END_RECORD_INVALID");
  const disk = readUInt16(archive, endOffset + 4);
  const centralDisk = readUInt16(archive, endOffset + 6);
  const diskEntries = readUInt16(archive, endOffset + 8);
  const entryCount = readUInt16(archive, endOffset + 10);
  const centralSize = readUInt32(archive, endOffset + 12);
  const centralOffset = readUInt32(archive, endOffset + 16);
  const commentLength = readUInt16(archive, endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0
      || entryCount === MAX_UINT16 || centralSize === MAX_UINT32 || centralOffset === MAX_UINT32) {
    throw new Error("DYNAMIC_ZIP_MULTIDISK_OR_ZIP64_FORBIDDEN");
  }
  if (commentLength !== 0) throw new Error("DYNAMIC_ZIP_COMMENT_FORBIDDEN");
  if (centralOffset + centralSize !== endOffset) throw new Error("DYNAMIC_ZIP_CENTRAL_DIRECTORY_INVALID");

  const centralEntries: CentralEntry[] = [];
  const unique = new Set<string>();
  const uniquePortable = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(archive, cursor, CENTRAL_HEADER_BYTES, "DYNAMIC_ZIP_CENTRAL_HEADER_TRUNCATED");
    assertUInt32(archive, cursor, CENTRAL_DIRECTORY_HEADER, "DYNAMIC_ZIP_CENTRAL_HEADER_INVALID");
    const versionMadeBy = readUInt16(archive, cursor + 4);
    const versionNeeded = readUInt16(archive, cursor + 6);
    const flags = readUInt16(archive, cursor + 8);
    const compression = readUInt16(archive, cursor + 10);
    const modifiedTime = readUInt16(archive, cursor + 12);
    const modifiedDate = readUInt16(archive, cursor + 14);
    const checksum = readUInt32(archive, cursor + 16);
    const compressedSize = readUInt32(archive, cursor + 20);
    const uncompressedSize = readUInt32(archive, cursor + 24);
    const nameLength = readUInt16(archive, cursor + 28);
    const extraLength = readUInt16(archive, cursor + 30);
    const entryCommentLength = readUInt16(archive, cursor + 32);
    const startDisk = readUInt16(archive, cursor + 34);
    const internalAttributes = readUInt16(archive, cursor + 36);
    const externalAttributes = readUInt32(archive, cursor + 38);
    const localOffset = readUInt32(archive, cursor + 42);
    if (versionMadeBy !== VERSION_MADE_BY_UNIX || versionNeeded !== VERSION_NEEDED
        || compression !== STORE || modifiedTime !== DOS_TIME_MIDNIGHT
        || modifiedDate !== DOS_DATE_1980_01_01 || internalAttributes !== 0
        || externalAttributes !== UNIX_REGULAR_FILE_0644) {
      throw new Error("DYNAMIC_ZIP_ENTRY_METADATA_INVALID");
    }
    if (flags !== 0) throw new Error("DYNAMIC_ZIP_ENCRYPTION_OR_DESCRIPTOR_FORBIDDEN");
    if (extraLength !== 0 || entryCommentLength !== 0) throw new Error("DYNAMIC_ZIP_EXTRA_OR_COMMENT_FORBIDDEN");
    if (startDisk !== 0 || compressedSize === MAX_UINT32 || uncompressedSize === MAX_UINT32
        || localOffset === MAX_UINT32) {
      throw new Error("DYNAMIC_ZIP_ENTRY_ZIP64_FORBIDDEN");
    }
    if (compressedSize > MAX_EVIDENCE_ENTRY_BYTES || uncompressedSize > MAX_EVIDENCE_ENTRY_BYTES) {
      throw new Error("DYNAMIC_ZIP_ENTRY_TOO_LARGE");
    }
    if (compressedSize !== uncompressedSize) throw new Error("DYNAMIC_ZIP_STORE_SIZE_MISMATCH");
    const variableLength = nameLength + extraLength + entryCommentLength;
    assertRange(archive, cursor + CENTRAL_HEADER_BYTES, variableLength, "DYNAMIC_ZIP_CENTRAL_ENTRY_TRUNCATED");
    const nameBytes = archive.subarray(cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength);
    const name = decodeSafeName(nameBytes);
    const portable = name.toLowerCase();
    if (unique.has(name) || uniquePortable.has(portable)) throw new Error("DYNAMIC_ZIP_ENTRY_DUPLICATE");
    unique.add(name);
    uniquePortable.add(portable);
    centralEntries.push(Object.freeze({
      name,
      nameBytes: Buffer.from(nameBytes),
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
    }));
    cursor += CENTRAL_HEADER_BYTES + variableLength;
  }
  if (cursor !== endOffset) throw new Error("DYNAMIC_ZIP_CENTRAL_DIRECTORY_TRAILING_BYTES");

  const entries: DeterministicZipEntry[] = [];
  let expectedLocalOffset = 0;
  for (const entry of centralEntries) {
    if (entry.localOffset !== expectedLocalOffset) throw new Error("DYNAMIC_ZIP_LOCAL_RECORD_LAYOUT_INVALID");
    const localOffset = entry.localOffset;
    assertRange(archive, localOffset, LOCAL_HEADER_BYTES, "DYNAMIC_ZIP_LOCAL_HEADER_TRUNCATED");
    assertUInt32(archive, localOffset, LOCAL_FILE_HEADER, "DYNAMIC_ZIP_LOCAL_HEADER_INVALID");
    const versionNeeded = readUInt16(archive, localOffset + 4);
    const flags = readUInt16(archive, localOffset + 6);
    const compression = readUInt16(archive, localOffset + 8);
    const modifiedTime = readUInt16(archive, localOffset + 10);
    const modifiedDate = readUInt16(archive, localOffset + 12);
    const checksum = readUInt32(archive, localOffset + 14);
    const compressedSize = readUInt32(archive, localOffset + 18);
    const uncompressedSize = readUInt32(archive, localOffset + 22);
    const nameLength = readUInt16(archive, localOffset + 26);
    const extraLength = readUInt16(archive, localOffset + 28);
    if (versionNeeded !== VERSION_NEEDED || compression !== STORE
        || modifiedTime !== DOS_TIME_MIDNIGHT || modifiedDate !== DOS_DATE_1980_01_01) {
      throw new Error("DYNAMIC_ZIP_LOCAL_METADATA_INVALID");
    }
    if (flags !== 0) throw new Error("DYNAMIC_ZIP_ENCRYPTION_OR_DESCRIPTOR_FORBIDDEN");
    if (extraLength !== 0) throw new Error("DYNAMIC_ZIP_EXTRA_FORBIDDEN");
    if (checksum !== entry.crc32 || compressedSize !== entry.compressedSize
        || uncompressedSize !== entry.uncompressedSize || nameLength !== entry.nameBytes.byteLength) {
      throw new Error("DYNAMIC_ZIP_LOCAL_CENTRAL_MISMATCH");
    }
    const nameOffset = localOffset + LOCAL_HEADER_BYTES;
    assertRange(archive, nameOffset, nameLength, "DYNAMIC_ZIP_LOCAL_NAME_TRUNCATED");
    if (!archive.subarray(nameOffset, nameOffset + nameLength).equals(entry.nameBytes)) {
      throw new Error("DYNAMIC_ZIP_LOCAL_NAME_MISMATCH");
    }
    const contentOffset = nameOffset + nameLength;
    assertRange(archive, contentOffset, compressedSize, "DYNAMIC_ZIP_ENTRY_CONTENT_TRUNCATED");
    const content = archive.subarray(contentOffset, contentOffset + compressedSize);
    if (crc32(content) !== entry.crc32) throw new Error("DYNAMIC_ZIP_CRC32_MISMATCH");
    expectedLocalOffset = contentOffset + compressedSize;
    if (expectedLocalOffset > centralOffset) throw new Error("DYNAMIC_ZIP_ENTRY_OVERLAPS_CENTRAL_DIRECTORY");
    entries.push(Object.freeze({
      path: entry.name,
      sha256: createHash("sha256").update(content).digest("hex"),
      byte_count: content.byteLength,
      compressed_byte_count: content.byteLength,
      compression: STORE,
      date_time: Object.freeze([1980, 1, 1, 0, 0, 0] as const),
      external_attr: UNIX_REGULAR_FILE_0644,
      create_system: 3,
    }));
  }
  if (expectedLocalOffset !== centralOffset) throw new Error("DYNAMIC_ZIP_LOCAL_RECORD_TRAILING_BYTES");

  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-dynamic-zip-inspection-v0.9.1",
    entries: Object.freeze(entries),
    entry_count: entries.length,
  });
}

export function crc32(bytes: Uint8Array): number {
  let value = MAX_UINT32;
  for (const byte of bytes) value = (CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return (value ^ MAX_UINT32) >>> 0;
}

async function resolveOrdinarySource(root: string, name: string): Promise<string> {
  let current = root;
  const segments = name.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    assertPathWithin(root, current);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error("DYNAMIC_ZIP_SOURCE_SYMLINK_FORBIDDEN");
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error("DYNAMIC_ZIP_SOURCE_PARENT_NOT_DIRECTORY");
    }
    if (index === segments.length - 1 && !metadata.isFile()) {
      throw new Error("DYNAMIC_ZIP_SOURCE_NOT_FILE");
    }
  }
  const canonical = await realpath(current);
  assertPathWithin(root, canonical);
  return canonical;
}

function assertSafeRelativeName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.includes("\\")
      || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || !/^[A-Za-z0-9._/-]+$/u.test(name)) {
    throw new Error("DYNAMIC_ZIP_ENTRY_NAME_UNSAFE");
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || segments.some((segment) => segment.endsWith(".")
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))
      || path.posix.normalize(name) !== name) {
    throw new Error("DYNAMIC_ZIP_ENTRY_NAME_UNSAFE");
  }
  const encoded = Buffer.from(name, "ascii");
  if (encoded.byteLength === 0 || encoded.byteLength > MAX_UINT16) {
    throw new Error("DYNAMIC_ZIP_ENTRY_NAME_LENGTH_INVALID");
  }
}

function decodeSafeName(bytes: Buffer): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_UINT16
      || bytes.some((byte) => byte > 0x7f)) {
    throw new Error("DYNAMIC_ZIP_ENTRY_NAME_ENCODING_INVALID");
  }
  const name = bytes.toString("ascii");
  assertSafeRelativeName(name);
  return name;
}

function assertPathWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new Error("DYNAMIC_ZIP_SOURCE_ESCAPE");
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function checkedUint32(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_UINT32) throw new Error(code);
  return value;
}

function assertRange(bytes: Buffer, offset: number, length: number, code: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
      || offset > bytes.byteLength || length > bytes.byteLength - offset) {
    throw new Error(code);
  }
}

function readUInt16(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 2, "DYNAMIC_ZIP_TRUNCATED");
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 4, "DYNAMIC_ZIP_TRUNCATED");
  return bytes.readUInt32LE(offset);
}

function assertUInt32(bytes: Buffer, offset: number, expected: number, code: string): void {
  if (readUInt32(bytes, offset) !== expected) throw new Error(code);
}
