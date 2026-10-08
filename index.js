#!/usr/bin/env node
'use strict';

/**
 * dsh-tray-restart — add a "Restart DeepSeek Harness" entry to the Windows
 * system tray menu of the DeepSeek Harness desktop app.
 *
 * The tray menu lives in the Electron main bundle (`lib/main.js` inside
 * `resources/app.asar`), which no plugin API can reach: DSH's `cordis.patch.yml`
 * composes backend services only. So this patches the asar directly, with a
 * byte-exact rewrite (every untouched file is copied verbatim and its
 * `integrity` record preserved) plus a full backup for one-command rollback.
 *
 * Usage:
 *   node index.js status            is the patch applied?
 *   node index.js apply             patch (idempotent; backs up first)
 *   node index.js restore           put the backup back
 *   node index.js verify            re-check every entry's integrity
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readHeader, walk, readEntry, rewrite, integrity } = require('./asar.cjs');
const { EDITS, MARKER } = require('./patch-def.cjs');

const TARGET = 'lib/main.js';

/** Explicit `--asar <path>` / `--asar=<path>` override, if given. */
function asarOverride(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') return argv[i + 1] ?? '';
    if (a.startsWith('--asar=')) return a.slice('--asar='.length);
  }
  return undefined;
}

/** Locate app.asar: explicit override, else the standard install paths. */
function findAsar(argv = process.argv) {
  const cli = asarOverride(argv);
  if (cli !== undefined) {
    if (!cli) {
      console.error('--asar needs a path, e.g. --asar "D:\\path\\to\\app.asar"');
      process.exit(1);
    }
    if (!fs.existsSync(cli)) {
      console.error('No such file:', cli);
      process.exit(1);
    }
    return cli;
  }
  if (process.env.DSH_ASAR) return process.env.DSH_ASAR;
  const candidates = [];
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
      : null;
    if (base) candidates.push(base);
    candidates.push('C:\\Users\\' + (process.env.USERNAME || '') + '\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
  } else {
    candidates.push('/opt/DeepSeek Harness/resources/app.asar');
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function backupPathFor(asar) {
  return asar + '.dsh-tray-restart.bak';
}

/** Read the target entry's text out of an asar without writing anything. */
function readTarget(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const { header, base } = readHeader(fd);
    const entries = walk(header.files, '');
    const hit = entries.find((e) => e.path === TARGET);
    if (!hit) return null;
    if (hit.node.unpacked) {
      throw new Error(`${TARGET} is unpacked; unsupported`);
    }
    return readEntry(fd, base, hit.node).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 'applied' — every patched fragment is present.
 * 'absent'  — no trace of the patch.
 * 'partial' — marker present but incomplete: refuse to touch it.
 */
function detect(src) {
  if (EDITS.every(([, , after]) => src.includes(after))) return 'applied';
  return src.includes(MARKER) ? 'partial' : 'absent';
}

function apply() {
  const asar = findAsar();
  if (!asar) {
    console.error('Could not find app.asar. Set DSH_ASAR=<full path to app.asar>.');
    process.exit(1);
  }
  const backup = backupPathFor(asar);
  const src = readTarget(asar);
  if (src === null) {
    console.error(`Could not find ${TARGET} inside ${asar}.`);
    process.exit(1);
  }

  const state = detect(src);
  if (state === 'applied') {
    console.log('Already patched — nothing to do.');
    return;
  }
  if (state === 'partial') {
    console.error('Found a partial patch. Run "restore" first, then apply again.');
    process.exit(1);
  }

  // Every anchor must appear exactly once, or the edit is unsafe.
  for (const [id, before] of EDITS) {
    let i = 0, c = 0;
    while ((i = src.indexOf(before, i)) >= 0) { c++; i++; }
    if (c !== 1) {
      console.error(`Anchor "${id}" occurs ${c} times (expected 1). The app version may differ; aborting.`);
      process.exit(1);
    }
  }

  if (!fs.existsSync(backup)) {
    fs.copyFileSync(asar, backup);
    console.log('Backup:', backup);
  } else {
    console.log('Backup already exists (keeping it):', backup);
  }

  let cur = src;
  for (const [, before, after] of EDITS) cur = cur.replace(before, after);

  const ok = rewrite(asar, (header, entries, contents) => {
    const hit = entries.find((e) => e.path === TARGET);
    if (!hit) throw new Error(`${TARGET} vanished mid-write`);
    contents.set(hit.node, Buffer.from(cur, 'utf8'));
  });
  if (!ok) { console.error('Patch failed.'); process.exit(1); }

  const after = readTarget(asar);
  if (detect(after) !== 'applied') {
    console.error('Post-check failed; restoring backup.');
    fs.copyFileSync(backup, asar);
    process.exit(1);
  }
  console.log(`Patched ${TARGET} in ${asar}`);
  console.log('Restart DeepSeek Harness for the new tray entry to appear.');
}

function restore() {
  const asar = findAsar();
  if (!asar) { console.error('Could not find app.asar.'); process.exit(1); }
  const backup = backupPathFor(asar);
  if (!fs.existsSync(backup)) {
    console.error('No backup found at', backup);
    process.exit(1);
  }
  fs.copyFileSync(backup, asar);
  console.log('Restored original app.asar from', backup);
  console.log('Restart DeepSeek Harness.');
}

function status() {
  const asar = findAsar();
  if (!asar) { console.error('Could not find app.asar.'); process.exit(1); }
  const src = readTarget(asar);
  if (src === null) { console.error(`No ${TARGET} inside ${asar}.`); process.exit(1); }
  const state = detect(src);
  const backup = backupPathFor(asar);
  console.log('asar   :', asar);
  console.log('target :', TARGET);
  console.log('state  :', state);
  console.log('backup :', fs.existsSync(backup) ? backup : '(none)');
}

/** Re-derive integrity for every packed entry and compare with the header. */
function verify() {
  const asar = findAsar();
  if (!asar) { console.error('Could not find app.asar.'); process.exit(1); }
  const fd = fs.openSync(asar, 'r');
  let bad = 0, n = 0;
  try {
    const { header, base } = readHeader(fd);
    for (const e of walk(header.files, '')) {
      if (e.node.unpacked) continue;
      const buf = readEntry(fd, base, e.node);
      n++;
      const got = integrity(buf);
      const same = got.hash === e.node.integrity.hash &&
        got.blocks.length === e.node.integrity.blocks.length &&
        got.blocks.every((b, i) => b === e.node.integrity.blocks[i]);
      if (!same) { bad++; console.error('MISMATCH', e.path); }
    }
  } finally { fs.closeSync(fd); }
  console.log(`verify: ${n} packed entries, ${bad} mismatches`);
  if (bad) process.exit(1);
  console.log('OK');
}

const cmd = process.argv[2] || 'status';
switch (cmd) {
  case 'apply': apply(); break;
  case 'restore': restore(); break;
  case 'status': status(); break;
  case 'verify': verify(); break;
  default:
    console.error('Unknown command:', cmd);
    console.error('Usage: node index.js <status|apply|restore|verify>');
    process.exit(1);
}
