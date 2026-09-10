'use strict';
// ─── zipfile.js — minimal ZIP writer (STORE only) ───────────────────────────
// Invoice copies are bundled as a ZIP so a request for 40 invoices arrives as
// one file. PDFs are already compressed, so DEFLATE would buy ~nothing and
// STORE keeps this to a page of code with no new dependency to install on a
// production box (Edwin 2026-09-10).
//
// Produces a standard PKZIP archive: [local header + data] per entry, then the
// central directory, then the end-of-central-directory record. Zip64 is not
// implemented — see the guard in build().

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS date/time, which is what the ZIP format stores. Second resolution is
// 2s; the format has no timezone, so local time is what every tool expects.
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F),
    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F),
  };
}

// Names are stored UTF-8 with the language-encoding flag set (bit 11), so
// non-ASCII invoice ids survive on Windows as well as macOS.
function sanitizeName(name) {
  return String(name || 'file')
    .replace(/[\\/]+/g, '_')          // no directory traversal, no nesting
    .replace(/[\x00-\x1f]/g, '')
    .slice(0, 200) || 'file';
}

/**
 * @param {Array<{name: string, data: Buffer, date?: Date}>} files
 * @returns {Buffer}
 */
function build(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;
  const seen = new Map();

  for (const f of files) {
    // Duplicate names inside one archive are legal but unzip to a single file,
    // which would silently lose an invoice copy. Suffix instead.
    let name = sanitizeName(f.name);
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      const dot = name.lastIndexOf('.');
      name = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    } else {
      seen.set(name, 1);
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data || '');
    const { time, date } = dosDateTime(f.date instanceof Date ? f.date : new Date());
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 name
    local.writeUInt16LE(0, 8);            // method 0 = STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == size for STORE
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field

    chunks.push(local, nameBuf, data);
    entries.push({ nameBuf, crc, size: data.length, time, date, offset });
    offset += local.length + nameBuf.length + data.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central directory header signature
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(e.time, 12);
    cd.writeUInt16LE(e.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.size, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra len
    cd.writeUInt16LE(0, 32);              // comment len
    cd.writeUInt16LE(0, 34);              // disk number
    cd.writeUInt16LE(0, 36);              // internal attrs
    cd.writeUInt32LE(0, 38);              // external attrs
    cd.writeUInt32LE(e.offset, 42);
    chunks.push(cd, e.nameBuf);
    offset += cd.length + e.nameBuf.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  // The 32-bit fields above cannot describe an archive past 4GB or past 65,535
  // entries. Fail loudly rather than write a corrupt file; job sizes are capped
  // well below this, so hitting it means something upstream went wrong.
  if (cdStart >= 0xFFFFFFFF || entries.length > 0xFFFF) {
    throw new Error('Archive too large for a non-Zip64 ZIP — split the request');
  }
  return Buffer.concat(chunks);
}

module.exports = { build, crc32 };
