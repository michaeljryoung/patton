/**
 * The smallest zip reader and writer a .docx needs (docs/review-tab.md R7).
 * Pure Node (zlib), no Electron, so scripts/check-review-comments.mjs drives it
 * headlessly. Entries the caller doesn't change are written back byte for byte
 * (their compressed data and CRC are copied), so adding a comment touches only
 * the parts it edits.
 *
 * Refused, never guessed at: zip64 archives, encrypted entries, compression
 * other than stored or deflate, more than MAX_ENTRIES entries, and archives
 * whose parts would inflate past MAX_TOTAL_BYTES (a zip bomb named .docx).
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate. */
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** The entry's data as stored in the archive (compressed for method 8). */
  raw: Buffer;
  /** Set when the caller replaced the entry's contents; written deflated. */
  replaced?: Buffer;
}

export class ZipError extends Error {}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError('not a zip archive');
}

/** Read every entry's raw data. Throws ZipError on anything refused above. */
export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('zip64 is not supported');
  if (count > MAX_ENTRIES) throw new ZipError('too many entries');
  if (cdOffset + cdSize > buf.length) throw new ZipError('central directory out of range');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if ((flags & 0x0001) !== 0) throw new ZipError('encrypted entries are not supported');
    if (method !== 0 && method !== 8) throw new ZipError(`compression method ${method} is not supported`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('zip64 is not supported');
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new ZipError('archive too large when unpacked');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError('bad local header');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) throw new ZipError('entry data out of range');
    entries.push({ name, method, crc, compressedSize, size, raw: buf.subarray(dataStart, dataStart + compressedSize) });
  }
  return entries;
}

/** An entry's uncompressed contents. */
export function entryData(entry: ZipEntry): Buffer {
  if (entry.replaced) return entry.replaced;
  if (entry.method === 0) return entry.raw;
  const out = inflateRawSync(entry.raw, { maxOutputLength: Math.max(entry.size, 1) });
  if (out.length !== entry.size) throw new ZipError(`size mismatch in ${entry.name}`);
  return out;
}

export function entryText(entries: ZipEntry[], name: string): string | null {
  const entry = entries.find((e) => e.name === name);
  return entry ? entryData(entry).toString('utf8') : null;
}

/** Replace an entry's contents, or add it at the end. */
export function setEntryText(entries: ZipEntry[], name: string, text: string): void {
  const data = Buffer.from(text, 'utf8');
  const entry = entries.find((e) => e.name === name);
  if (entry) {
    entry.replaced = data;
    return;
  }
  entries.push({ name, method: 8, crc: 0, compressedSize: 0, size: data.length, raw: Buffer.alloc(0), replaced: data });
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Write the entries back as one archive, in their order. */
export function writeZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    let method = entry.method;
    let crc = entry.crc;
    let raw = entry.raw;
    let size = entry.size;
    if (entry.replaced) {
      method = 8;
      crc = crc32(entry.replaced) >>> 0;
      raw = deflateRawSync(entry.replaced);
      size = entry.replaced.length;
    }
    const name = Buffer.from(entry.name, 'utf8');
    const utf8Flag = /[^\x20-\x7e]/.test(entry.name) ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8Flag, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8Flag, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, raw);
    centrals.push(central, name);
    offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
