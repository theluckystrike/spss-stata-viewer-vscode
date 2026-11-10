'use strict';
// Bounded access to the bytes of a data file. Every read checks its range: a read past the end throws Trunc, so a
// cut or hostile file gives a message (or the rows read so far) and never reads outside the file.
// A file source reads 1 MB blocks with a small cache. No vscode here: the readers run in a worker thread and in tests.
const fs = require('fs');

const BLOCK = 1 << 20;
const MAX_BLOCKS = 8;

class DataError extends Error {
  constructor(message, code = 'BAD_FILE') { super(message); this.name = 'DataError'; this.code = code; }
}

class Trunc extends DataError {
  constructor(off, n, size) {
    super(`The file ends early: ${n} byte${n === 1 ? '' : 's'} needed at offset ${off}, the file has ${size}.`, 'TRUNC');
    this.name = 'Trunc';
  }
}

class Source {
  constructor(size, readBlock) {
    this.size = size;
    this.readBlock = readBlock;
    this.cache = new Map();
  }

  static fromBuffer(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const s = new Source(b.length, null);
    s.buf = b;
    return s;
  }

  static fromFile(file) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const s = new Source(size, (k) => {
      const len = Math.min(BLOCK, size - k * BLOCK);
      const out = Buffer.alloc(Math.max(0, len));
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, out, got, len - got, k * BLOCK + got);
        if (n <= 0) break;
        got += n;
      }
      return new Uint8Array(out.buffer, out.byteOffset, got);
    });
    s.fd = fd;
    return s;
  }

  close() { if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch { /* closed */ } this.fd = undefined; } }

  block(k) {
    let b = this.cache.get(k);
    if (b) return b;
    b = this.readBlock(k);
    if (this.cache.size >= MAX_BLOCKS) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(k, b);
    return b;
  }

  /** n bytes at off (a view when possible). Throws Trunc when the range leaves the file. */
  read(off, n) {
    if (!Number.isSafeInteger(off) || !Number.isSafeInteger(n) || off < 0 || n < 0 || off + n > this.size) throw new Trunc(off, n, this.size);
    if (this.buf) return this.buf.subarray(off, off + n);
    const k0 = Math.floor(off / BLOCK), k1 = Math.floor((off + n - 1) / BLOCK);
    if (n === 0) return new Uint8Array(0);
    if (k0 === k1) { const b = this.block(k0); const s = off - k0 * BLOCK; if (s + n > b.length) throw new Trunc(off, n, this.size); return b.subarray(s, s + n); }
    const out = new Uint8Array(n);
    let p = 0;
    for (let k = k0; k <= k1; k++) {
      const b = this.block(k);
      const s = k === k0 ? off - k0 * BLOCK : 0;
      const e = Math.min(b.length, off + n - k * BLOCK);
      if (e <= s) throw new Trunc(off, n, this.size);
      out.set(b.subarray(s, e), p); p += e - s;
    }
    if (p !== n) throw new Trunc(off, n, this.size);
    return out;
  }

  /** Up to n bytes at off (fewer at the end of the file). */
  readUpTo(off, n) { return this.read(off, Math.max(0, Math.min(n, this.size - off))); }
}

/** A cursor over a Source with an byte order; every read advances pos. */
class Cursor {
  constructor(src, pos = 0, le = true) { this.src = src; this.pos = pos; this.le = le; }
  get left() { return this.src.size - this.pos; }
  bytes(n) { const b = this.src.read(this.pos, n); this.pos += n; return b; }
  skip(n) { if (n < 0 || this.pos + n > this.src.size) throw new Trunc(this.pos, n, this.src.size); this.pos += n; }
  dv(n) { const b = this.bytes(n); return new DataView(b.buffer, b.byteOffset, n); }
  u8() { return this.bytes(1)[0]; }
  i16() { return this.dv(2).getInt16(0, this.le); }
  u16() { return this.dv(2).getUint16(0, this.le); }
  i32() { return this.dv(4).getInt32(0, this.le); }
  u32() { return this.dv(4).getUint32(0, this.le); }
  f32() { return this.dv(4).getFloat32(0, this.le); }
  f64() { return this.dv(8).getFloat64(0, this.le); }
  /** 64-bit integer as a Number; throws when it does not fit in 2^53. */
  i64() {
    const d = this.dv(8);
    const v = d.getBigInt64(0, this.le);
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new DataError('A 64-bit count in the file is too large.');
    return Number(v);
  }
  u64() {
    const v = this.dv(8).getBigUint64(0, this.le);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new DataError('A 64-bit count in the file is too large.');
    return Number(v);
  }
}

module.exports = { Source, Cursor, DataError, Trunc, BLOCK };
