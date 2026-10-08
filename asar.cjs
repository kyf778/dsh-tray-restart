/**
 * Minimal asar read/write for the DSH tray-restart patch.
 *
 * Layout (asar v2, as shipped by DSH 44.0.0):
 *   [0..7]   uint32 LE = 4 (pickle header size marker)
 *   [8..11]  uint32 LE = headerSize + 8
 *   [12..15] uint32 LE = headerSize
 *   [16 .. 16+headerSize)  JSON header
 *   payload starts at 16 + headerSize
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
  return { header: JSON.parse(hb.toString('utf8')), headerSize, base, raw: hb };
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
    // (verified: byte-identical to the original 3,392,048 bytes).
    const newHeader = Buffer.from(JSON.stringify(header), 'utf8');
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0);
    pre.writeUInt32LE(newHeader.length + 8, 4);
    pre.writeUInt32LE(newHeader.length, 12);
    out = Buffer.concat([pre, newHeader, payload]);
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

module.exports = { readHeader, walk, readEntry, rewrite, integrity, hash };
