'use strict';

/** Shared helpers for the dsh-tray-restart test suite. */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const { readHeader, walk, readEntry, rewrite } = require(path.join(ROOT, 'asar.cjs'));

/** Locate a real app.asar to test against, or null. */
function findAsar() {
  const cands = [];
  if (process.env.DSH_ASAR) cands.push(process.env.DSH_ASAR);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  }
  if (process.platform === 'darwin') {
    cands.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
  }
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return null;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Read one entry's text from an asar. */
function readEntryText(asarPath, entryPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const { header, base } = readHeader(fd);
    const hit = walk(header.files, '').find((e) => e.path === entryPath);
    if (!hit) return null;
    return readEntry(fd, base, hit.node).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Per-entry sha256 map of every packed entry. */
function entryHashes(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const map = new Map();
  try {
    const { header, base } = readHeader(fd);
    for (const e of walk(header.files, '')) {
      if (e.node.unpacked) continue;
      map.set(e.path, crypto.createHash('sha256').update(readEntry(fd, base, e.node)).digest('hex'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return map;
}

/** Run the CLI against a specific asar; returns {status, stdout, stderr}. */
function runCli(asarPath, cmd) {
  const cp = require('node:child_process');
  const r = cp.spawnSync(process.execPath, ['--max-old-space-size=4096', path.join(ROOT, 'index.js'), cmd], {
    env: { ...process.env, DSH_ASAR: asarPath },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-tray-restart-${name}-`));
  return d;
}

module.exports = { ROOT, findAsar, sha256File, readEntryText, entryHashes, runCli, tmpDir, rewrite, readHeader, walk, readEntry };
