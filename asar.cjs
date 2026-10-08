/**
 * Minimal asar read/write for the DSH tray-restart patch.
 *
 * Layout (asar v2, as shipped by DSH 44.0.0) - four separate uint32 fields,
 * NOT two 8-byte ones:
 *   [0..3]   uint32 LE = 4                    (size-pickle payload size)
 *   [4..7]   uint32 LE = headerSize + 8       (size-pickle value: total header blob)
 *   [8..11]  uint32 LE = headerSize + 4       (header-pickle payload size)
 *   [12..15] uint32 LE = headerSize           (JSON string byte length)
 *   [16 .. 16+headerSize)  JSON header
 *   payload starts at 16 + headerSize
 *
 * All four fields are load-bearing. Electron reads [0..3]/[4..7] as one Pickle
 * (payload size + header blob size), then treats the blob starting at [8] as a
 * SECOND Pickle whose payload size is [8..11], whose first string length is
 * [12..15] and whose string bytes start at [16]. Leaving [8..11] zeroed makes
 * Electron fail to read the header and silently fall back to default_app.asar -
 * the app launches with the window titled "Electron" showing the welcome page.
 * Verified against Electron's own resources/default_app.asar, which satisfies
 * u8 === u12 + 4 and u4 === u8 + 4.
 *
 * Every file node carries `offset` (relative to payload start), `size`, and an
 * `integrity` record: { algorithm, hash, blockSize, blocks[] }. Electron only
 * validates `integrity` when the EnableEmbeddedAsarIntegrityValidation fuse is
 * on and the app is packaged; DSH does not set it (verified). We recompute it
 * anyway so the file stays self-consistent.
 */
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const BLOCK = 4 * 1024 * 1024; // 4194304, the blockSize DSH ships

function hash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function integrity(buf) {
  const blocks = [];
  if (buf.length === 0) blocks.push(hash(Buffer.alloc(0)));
  for (let o = 0; o < buf.length; o += BLOCK) {
    blocks.push(hash(buf.subarray(o, Math.min(o + BLOCK, buf.length))));
  }
  return {
    algorithm: 'SHA256',
    hash: hash(buf),
    blockSize: BLOCK,
    blocks,
  };
}

/** Read the header JSON and payload base offset. */
function readHeader(fd) {
  const pre = Buffer.alloc(16);
  fs.readSync(fd, pre, 0, 16, 0);
  const headerSize = pre.readUInt32LE(12);
  const base = 16 + headerSize;
  const hb = Buffer.alloc(headerSize);
  fs.readSync(fd, hb, 0, headerSize, 16);
  return {
    header: JSON.parse(hb.toString('utf8')),
    headerSize,
    base,
    raw: hb,
    // The three size words, kept so rewrite() can preserve their exact
    // relationship to headerSize instead of assuming a fixed delta.
    sizeWord: pre.readUInt32LE(0),
    outerSize: pre.readUInt32LE(4),
    innerSize: pre.readUInt32LE(8),
  };
}

/**
 * Re-read a fully built archive the way Electron does. A header that fails here
 * would fail at app launch, where the only symptom is a silent fallback to
 * default_app.asar - so validate the bytes we are about to write instead.
 * @param {Buffer} out complete archive image
 */
function assertReadableHeader(out) {
  if (out.length < 16) throw new Error('asar too small to hold a header');
  const outer = out.readUInt32LE(4);
  const blob = out.subarray(8, 8 + outer);
  if (blob.length !== outer) throw new Error(`asar header truncated: want ${outer} bytes, have ${blob.length}`);
  const inner = blob.readUInt32LE(0);
  if (inner !== blob.length - 4) {
    throw new Error(`asar header corrupt: inner pickle payload size ${inner}, expected ${blob.length - 4}`);
  }
  const strLen = blob.readUInt32LE(4);
  if (strLen > inner - 4) throw new Error(`asar header corrupt: JSON length ${strLen} overruns payload ${inner}`);
  const json = JSON.parse(blob.subarray(8, 8 + strLen).toString('utf8'));
  if (!json || typeof json !== 'object' || !json.files) throw new Error('asar header corrupt: no files table');
  return json;
}

/** Depth-first walk producing the same order as the on-disk offset order. */
function walk(node, prefix, out = []) {
  for (const [name, val] of Object.entries(node)) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (val.files) walk(val.files, p, out);
    else out.push({ path: p, node: val });
  }
  return out;
}

/** Read one archive entry's bytes (packed entries only). */
function readEntry(fd, base, node) {
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
  return buf;
}

/**
 * Rewrite an asar: `mutate(header, entries, contents)` may replace entry
 * payloads in the `contents` Map (entry node -> Buffer). Every entry keeps its
 * bytes unless replaced, and offsets/integrity are recomputed for all packed
 * entries. Returns false if `mutate` returns false.
 *
 * The result is written to a sibling temp file and atomically renamed over the
 * original, so an interrupted run cannot leave a half-written asar behind.
 */
function rewrite(asarPath, mutate) {
  const fd = fs.openSync(asarPath, 'r');
  let entries, packed, contents, out;
  try {
    const { header, base } = readHeader(fd);
    entries = walk(header.files, '');
    packed = entries.filter((e) => !e.node.unpacked);

    contents = new Map();
    for (const e of packed) contents.set(e.node, readEntry(fd, base, e.node));

    if (mutate(header, entries, contents) === false) return false;

    // Assign new offsets in DFS order and rebuild every integrity record.
    let offset = 0;
    for (const e of packed) {
      const buf = contents.get(e.node);
      e.node.offset = String(offset);
      e.node.size = buf.length;
      e.node.integrity = integrity(buf);
      offset += buf.length;
    }
    const payload = Buffer.concat(packed.map((e) => contents.get(e.node)));

    // Rebuild the header. JSON.stringify reproduces DSH's header bytes exactly
    // (verified: byte-identical to the original 3,392,048 bytes). Pad to a
    // 4-byte boundary the way the real asar writer does, so headerSize stays a
    // multiple of 4 and payload offsets need no adjustment (pad is 0 for DSH).
    const json = JSON.stringify(header);
    const padLen = (4 - (Buffer.byteLength(json) % 4)) % 4;
    const newHeader = Buffer.from(json + ' '.repeat(padLen), 'utf8');
    const innerSize = newHeader.length + 4; // header-pickle payload size
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(innerSize + 4, 4); // total header blob size
    pre.writeUInt32LE(innerSize, 8); // ← must be written: Electron reads this
    pre.writeUInt32LE(newHeader.length, 12);
    out = Buffer.concat([pre, newHeader, payload]);

    // Fail loudly here rather than shipping a header Electron cannot read.
    assertReadableHeader(out);
  } finally {
    fs.closeSync(fd);
  }

  const tmp = asarPath + '.dsh-tray-restart.tmp';
  const wf = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(wf, out, 0, out.length, 0);
    fs.fsyncSync(wf);
  } finally {
    fs.closeSync(wf);
  }
  try {
    fs.renameSync(tmp, asarPath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  return true;
}

module.exports = { readHeader, assertReadableHeader, walk, readEntry, rewrite, integrity, hash };
