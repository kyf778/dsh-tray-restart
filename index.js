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
 * The app version from the packaged root package.json, or null.
 *
 * That file starts with a UTF-8 BOM and, in shipped builds, is missing its
 * closing brace — so a strict JSON.parse is not an option. Read the first
 * `"version"` field directly instead; the root entry is the app's own manifest,
 * so the first match is the one we want.
 */
function readAppVersion(asar) {
  try {
    const fd = fs.openSync(asar, 'r');
    try {
      const { header, base } = readHeader(fd);
      const hit = walk(header.files, '').find((e) => e.path === 'package.json');
      if (!hit || hit.node.unpacked) return null;
      const txt = readEntry(fd, base, hit.node).toString('utf8').replace(/^\uFEFF/, '');
      const m = /"version"\s*:\s*"([^"]+)"/.exec(txt);
      return m ? m[1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function metaPathFor(asar) {
  return asar + '.dsh-tray-restart.json';
}

function readMeta(asar) {
  try {
    return JSON.parse(fs.readFileSync(metaPathFor(asar), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(asar, meta) {
  fs.writeFileSync(metaPathFor(asar), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * Ensure the backup next to `asar` is a pristine copy of the CURRENT build.
 *
 * An app update replaces app.asar wholesale but leaves the old backup behind.
 * Trusting that stale file would make `restore` silently downgrade the app to
 * the previous release, so a backup recorded for a different version is thrown
 * away and re-created. A backup with no metadata is accepted only when it is
 * byte-identical to the current asar (the pre-metadata layout).
 */
function ensureBackup(asar, appVersion) {
  const backup = backupPathFor(asar);
  const meta = readMeta(asar);

  if (fs.existsSync(backup)) {
    const recorded = meta && meta.appVersion ? meta.appVersion : null;
    const sameBuild = recorded
      ? recorded === appVersion
      : appVersion !== null && sha256File(backup) === sha256File(asar);
    if (sameBuild) {
      if (!meta) {
        writeMeta(asar, {
          appVersion,
          backupSha256: sha256File(backup),
          createdAt: new Date().toISOString(),
        });
      }
      console.log(`Backup already exists for ${appVersion || 'this build'} (keeping it):`, backup);
      return backup;
    }
    console.log(`Backup belongs to ${recorded || 'an unknown build'}, but the app is now ${appVersion || 'unknown'} — re-creating it.`);
    fs.rmSync(backup, { force: true });
    fs.rmSync(metaPathFor(asar), { force: true });
  }

  fs.copyFileSync(asar, backup);
  writeMeta(asar, {
    appVersion: appVersion || null,
    backupSha256: sha256File(backup),
    createdAt: new Date().toISOString(),
  });
  console.log(`Backup for ${appVersion || 'current build'}:`, backup);
  return backup;
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

  const backup = ensureBackup(asar, readAppVersion(asar));

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

function restore(force = false) {
  const asar = findAsar();
  if (!asar) { console.error('Could not find app.asar.'); process.exit(1); }
  const backup = backupPathFor(asar);
  if (!fs.existsSync(backup)) {
    console.error('No backup found at', backup);
    process.exit(1);
  }

  const meta = readMeta(asar);
  const current = readAppVersion(asar);
  if (meta && meta.appVersion && current && meta.appVersion !== current) {
    if (!force) {
      console.error(`The backup is from ${meta.appVersion}, but the installed app is ${current}.`);
      console.error('Restoring it would replace the current build with an older one.');
      console.error('Re-run with --force if that is really what you want.');
      process.exit(1);
    }
    console.log(`WARNING: restoring ${meta.appVersion} over ${current} (--force).`);
  }
  if (meta && meta.backupSha256 && sha256File(backup) !== meta.backupSha256) {
    console.error('The backup file is damaged (hash mismatch); refusing to restore it.');
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
  const meta = readMeta(asar);
  const hasBackup = fs.existsSync(backup);
  console.log('asar   :', asar);
  console.log('version:', readAppVersion(asar) || '(unknown)');
  console.log('target :', TARGET);
  console.log('state  :', state);
  console.log('backup :', hasBackup
    ? backup + (meta && meta.appVersion ? ` (${meta.appVersion})` : '')
    : '(none)');
}

/**
 * Everything needed to tell whether this app build is still patchable: the
 * version, the patch state, which backup is on disk, and how many times each
 * anchor occurs (exactly 1 is required). Meant to be pasted into an issue.
 */
function diag() {
  const asar = findAsar();
  if (!asar) { console.error('Could not find app.asar.'); process.exit(1); }
  const fd = fs.openSync(asar, 'r');
  let src;
  try {
    const { header, base } = readHeader(fd);
    const hit = walk(header.files, '').find((e) => e.path === TARGET);
    if (!hit) { console.error(`No ${TARGET} inside ${asar}.`); process.exit(1); }
    src = readEntry(fd, base, hit.node).toString('utf8');
  } finally { fs.closeSync(fd); }

  const meta = readMeta(asar);
  const backup = backupPathFor(asar);
  console.log('asar    :', asar);
  console.log('version :', readAppVersion(asar) || '(unknown)');
  console.log('state   :', detect(src));
  console.log('backup  :', fs.existsSync(backup)
    ? `${backup} (${meta && meta.appVersion ? meta.appVersion : 'unversioned'})`
    : '(none)');
  console.log('anchors :');
  for (const [id, before] of EDITS) {
    let i = 0, c = 0;
    while ((i = src.indexOf(before, i)) >= 0) { c++; i++; }
    console.log(`  ${id.padEnd(12)} ${c}${c === 1 ? '' : '   <-- expected 1'}`);
  }
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

const argv = process.argv.slice(2);
const COMMANDS = ['status', 'apply', 'restore', 'verify', 'diag'];
// The command is the first bare word; flags (`--force`) and `--asar <path>`
// may appear before or after it.
const cmd = argv[0] && !argv[0].startsWith('-')
  ? argv[0]
  : (argv.find((a) => COMMANDS.includes(a)) || 'status');
const force = argv.includes('--force');
switch (cmd) {
  case 'apply': apply(); break;
  case 'restore': restore(force); break;
  case 'status': status(); break;
  case 'verify': verify(); break;
  case 'diag': diag(); break;
  default:
    console.error('Unknown command:', cmd);
    console.error('Usage: node index.js <status|apply|restore|verify|diag> [--force] [--asar <path>]');
    process.exit(1);
}
