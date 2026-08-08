/**
 * A ZIP writer, store-only.
 *
 * ---------------------------------------------------------------------------
 * NO COMPRESSION, DELIBERATELY.
 *
 * This builds the hundred-year archive, and the whole point of that file is
 * that it survives its own software. Stored entries mean the CSVs sit in the
 * container as plain readable bytes: `strings archive.zip` finds them, a
 * partially recovered file still yields whole rows, and nothing has to
 * understand DEFLATE to get the numbers out. A year of a shop's ledger is a
 * few hundred kilobytes — the compression would save less than it costs in
 * recoverability.
 *
 * Hand-written rather than a dependency for the same reason as the QR encoder:
 * the format is frozen (PKWARE APPNOTE, local header + central directory), it
 * is a hundred and fifty lines, and an archive whose reader had to be
 * downloaded is not an archive.
 * ---------------------------------------------------------------------------
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Buffer;
}

/** CRC-32, the standard reflected polynomial. Table built once at load. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * DOS date/time, which is what ZIP stores.
 *
 * Taken from an explicit instant rather than the clock so the same archive
 * built twice is byte-identical — which is what lets somebody compare two
 * copies of a year and see that they are the same file.
 */
function dosStamp(when: Date): { time: number; date: number } {
  return {
    time:
      (Math.floor(when.getUTCSeconds() / 2) & 0x1f) |
      ((when.getUTCMinutes() & 0x3f) << 5) |
      ((when.getUTCHours() & 0x1f) << 11),
    date:
      (when.getUTCDate() & 0x1f) |
      (((when.getUTCMonth() + 1) & 0x0f) << 5) |
      ((Math.max(when.getUTCFullYear() - 1980, 0) & 0x7f) << 9),
  };
}

export function buildZip(entries: readonly ZipEntry[], when: Date): Buffer {
  const stamp = dosStamp(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0
    // Bit 11: the name is UTF-8. Without it a reader is entitled to assume
    // CP437, which mangles any non-ASCII filename.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // offset of local header
    name.copy(central, 46);

    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, end]);
}
