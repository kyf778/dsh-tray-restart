'use strict';

/**
 * End-to-end suite for dsh-tray-restart.
 *
 * Everything runs against *copies* of a real app.asar in a temp directory — the
 * installed application is never touched. If no app.asar can be found, the
 * suite reports SKIP rather than failing.
 *
 *   node test/run-tests.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { findAsar, sha256File, readEntryText, entryHashes, runCli, tmpDir, rewrite } = require('./lib.cjs');

const behaviour = require('./behaviour.cjs');

let failures = 0;
const log = (...a) => console.log(...a);
function ok(name) { log(`  PASS  ${name}`); }
function bad(name, detail) { failures++; log(`  FAIL  ${name}`); if (detail) log(`        ${detail}`); }

function assert(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail);
}

const original = findAsar();
if (!original) {
  log('SKIP: no DeepSeek Harness app.asar found.');
  log('      Set DSH_ASAR=<path to app.asar> to run the suite.');
  process.exit(0);
}

log('Using app.asar:', original);
const tmp = tmpDir('e2e');
const work = path.join(tmp, 'app.asar');
fs.copyFileSync(original, work);
const originalHash = sha256File(original);

// ── 1. header round-trip fidelity ────────────────────────────────────────────
log('\n[1] asar reader');
{
  const { readHeader, walk } = require('../asar.cjs');
  const fd = fs.openSync(work, 'r');
  const { header, headerSize, raw } = readHeader(fd);
  fs.closeSync(fd);
  const entries = walk(header.files, '');
  assert('header re-serialises byte-identically', Buffer.from(JSON.stringify(header), 'utf8').equals(raw));
  assert('entries discovered', entries.length > 1000, `found ${entries.length}`);
}

// ── 2. status before patching ────────────────────────────────────────────────
log('\n[2] status (unpatched)');
{
  const r = runCli(work, 'status');
  assert('reports state=absent', /state\s*:\s*absent/.test(r.stdout), r.stdout);
}

// ── 3. apply ─────────────────────────────────────────────────────────────────
log('\n[3] apply');
{
  const r = runCli(work, 'apply');
  assert('exits 0', r.status === 0, r.stderr);
  assert('creates a backup', fs.existsSync(work + '.dsh-tray-restart.bak'));
  const b = runCli(work, 'status');
  assert('reports state=applied', /state\s*:\s*applied/.test(b.stdout), b.stdout);
}

// ── 3b. the patched header must satisfy Electron's real pickle layout ───────
// Reading the archive back through asar.cjs/readHeader() cannot catch a wrong
// [8..11] word, because readHeader() only consults [12..15]. Electron reads the
// blob at [8..] as a Pickle whose payload size is [8..11]; zeroing it makes the
// app fall back to default_app.asar (window titled "Electron", welcome page).
log('\n[3b] patched header layout (Electron semantics)');
{
  const buf = fs.readFileSync(work);
  const u0 = buf.readUInt32LE(0);
  const u4 = buf.readUInt32LE(4);
  const u8 = buf.readUInt32LE(8);
  const u12 = buf.readUInt32LE(12);
  assert('u0 is the pickle size marker (4)', u0 === 4, `u0=${u0}`);
  assert('u12 is the JSON byte length', u12 === Buffer.byteLength(buf.subarray(16, 16 + u12).toString('utf8')), `u12=${u12}`);
  assert('u8 == u12 + 4 (inner pickle payload size)', u8 === u12 + 4, `u8=${u8} u12=${u12}`);
  assert('u4 == u8 + 4 (total header blob size)', u4 === u8 + 4, `u4=${u4} u8=${u8}`);
  const blob = buf.subarray(8, 8 + u4);
  assert('header blob is complete', blob.length === u4, `${blob.length} != ${u4}`);
  assert('inner payload size matches blob length', blob.readUInt32LE(0) === blob.length - 4,
    `inner=${blob.readUInt32LE(0)} blob-4=${blob.length - 4}`);
  const strLen = blob.readUInt32LE(4);
  assert('Electron-style header read yields the files table',
    !!JSON.parse(blob.subarray(8, 8 + strLen).toString('utf8')).files);
  // Chrome's Pickle pads a written string to a 4-byte payload boundary, so the
  // gap between u12 (JSON length) and u8 (payload size) is 4 + pad, where pad
  // depends on len(JSON) % 4. The patched header re-serialises the files table
  // and pads it to a multiple of 4 itself, which lands on pad = 0; the shipped
  // original padded by 1. Demanding equal deltas would only re-test JSON length,
  // so assert the invariant instead: the payload stays 4-byte aligned and the
  // padding stays inside Pickle's 0..3 range.
  const orig = fs.readFileSync(original);
  const origPad = orig.readUInt32LE(8) - orig.readUInt32LE(12) - 4;
  const pad = u8 - u12 - 4;
  assert('Pickle payload stays 4-byte aligned', u8 % 4 === 0, `u8=${u8} (padding ${pad})`);
  assert('padding is inside Pickle range 0..3', pad >= 0 && pad <= 3, `pad=${pad}`);
  assert('padding differs only because the JSON length changed',
    (origPad === pad) === ((orig.readUInt32LE(12) % 4) === (u12 % 4)),
    `orig pad=${origPad} (u12=${orig.readUInt32LE(12)}), patched pad=${pad} (u12=${u12})`);
}

// ── 4. only lib/main.js changed ──────────────────────────────────────────────
log('\n[4] blast radius');
{
  const a = entryHashes(original), b = entryHashes(work);
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  assert('exactly one entry changed', changed.length === 1, `changed: ${changed.join(', ')}`);
  assert('the changed entry is lib/main.js', changed[0] === 'lib/main.js', String(changed[0]));
}

// ── 5. integrity of every entry ──────────────────────────────────────────────
log('\n[5] integrity');
{
  const r = runCli(work, 'verify');
  assert('verify exits 0', r.status === 0, r.stdout + r.stderr);
  assert('zero mismatches', /0 mismatches/.test(r.stdout), r.stdout);
}

// ── 6. patched JavaScript parses ─────────────────────────────────────────────
log('\n[6] syntax');
{
  const src = readEntryText(work, 'lib/main.js');
  const tmpJs = path.join(tmp, 'main.mjs');
  fs.writeFileSync(tmpJs, src);
  const cp = require('node:child_process');
  const r = cp.spawnSync(process.execPath, ['--check', tmpJs], { encoding: 'utf8' });
  assert('node --check passes', r.status === 0, r.stderr);
}

// ── 7. behaviour ─────────────────────────────────────────────────────────────
log('\n[7] tray behaviour');
{
  behaviour.results.length = 0;
  behaviour.run(work);
  for (const r of behaviour.results) {
    if (r.ok) ok(r.name);
    else bad(r.name, `got ${r.got} want ${r.want}`);
  }
}

// ── 8. idempotence ───────────────────────────────────────────────────────────
log('\n[8] idempotence');
{
  const before = sha256File(work);
  const r = runCli(work, 'apply');
  assert('re-apply exits 0', r.status === 0, r.stderr);
  assert('reports already patched', /Already patched/.test(r.stdout), r.stdout);
  assert('file untouched', sha256File(work) === before);
}

// ── 9. restore is byte-identical ─────────────────────────────────────────────
log('\n[9] restore');
{
  const r = runCli(work, 'restore');
  assert('restore exits 0', r.status === 0, r.stderr);
  assert('restored hash matches the original', sha256File(work) === originalHash);
}

// ── 10. unknown version aborts without touching the file ─────────────────────
log('\n[10] safety on an unknown version');
{
  const t = path.join(tmp, 'unknown.asar');
  fs.copyFileSync(original, t);
  // simulate an upstream change that removes one anchor
  rewrite(t, (header, entries, contents) => {
    const hit = entries.find((e) => e.path === 'lib/main.js');
    const src = contents.get(hit.node).toString('utf8');
    const mutated = src.replace(
      '\t\t\tquit: () => {\n\t\t\t\tapp.quit();\n\t\t\t}\n\t\t});',
      '\t\t\tquit: () => {\n\t\t\t\t/* changed upstream */ app.quit();\n\t\t\t}\n\t\t});'
    );
    if (mutated === src) throw new Error('could not simulate the change');
    contents.set(hit.node, Buffer.from(mutated, 'utf8'));
  });
  const before = sha256File(t);
  const r = runCli(t, 'apply');
  assert('aborts with non-zero exit', r.status !== 0, String(r.status));
  assert('explains why', /occurs 0 times/.test(r.stderr), r.stderr);
  assert('file left untouched', sha256File(t) === before);
  assert('no backup written', !fs.existsSync(t + '.dsh-tray-restart.bak'));
}

// ── 11. version-stamped backup ───────────────────────────────────────────────
// An app update replaces app.asar but leaves the old backup in place. Without a
// version stamp, `restore` would quietly put the previous release back, so the
// backup must carry the version it belongs to and be rebuilt when that changes.
log('\n[11] version-stamped backup');
{
  const t = path.join(tmp, 'versioned.asar');
  fs.copyFileSync(original, t);
  const metaPath = t + '.dsh-tray-restart.json';

  const a1 = runCli(t, 'apply');
  assert('apply exits 0', a1.status === 0, a1.stderr);
  assert('apply writes backup metadata', fs.existsSync(metaPath));
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert('metadata records the app version',
    typeof meta.appVersion === 'string' && meta.appVersion.length > 0, JSON.stringify(meta));
  assert('metadata records the backup hash', /^[0-9a-f]{64}$/.test(meta.backupSha256 || ''));

  // Pretend the backup came from an older release, as after an app update.
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta, appVersion: '0.0.0-old' }, null, 2) + '\n');

  const r1 = runCli(t, 'restore');
  assert('restore refuses a backup from another version', r1.status !== 0, r1.stdout + r1.stderr);
  assert('explains the version mismatch', /from 0\.0\.0-old/.test(r1.stderr), r1.stderr);
  assert('file left untouched by the refusal', /state\s*:\s*applied/.test(runCli(t, 'status').stdout));

  const r2 = runCli(t, 'restore', ['--force']);
  assert('--force restores anyway', r2.status === 0, r2.stderr);

  const a2 = runCli(t, 'apply');
  assert('apply rebuilds a stale backup', /re-creating it/.test(a2.stdout), a2.stdout);
  const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert('rebuilt backup carries the current version',
    meta2.appVersion !== '0.0.0-old', JSON.stringify(meta2));

  // A damaged backup must never be written over a live install.
  fs.writeFileSync(metaPath, JSON.stringify({ ...meta2, backupSha256: '0'.repeat(64) }, null, 2) + '\n');
  const r3 = runCli(t, 'restore', ['--force']);
  assert('restore refuses a damaged backup', r3.status !== 0, r3.stdout + r3.stderr);
  assert('names the damage', /damaged/.test(r3.stderr), r3.stderr);

  // Backups created before the metadata existed have no version stamp: trust
  // one only when it is byte-identical to the asar it sits next to, and
  // backfill the metadata instead of copying the 180 MB file again.
  fs.rmSync(metaPath, { force: true });
  runCli(t, 'restore', ['--force']);
  const a3 = runCli(t, 'apply');
  assert('legacy backup is kept when byte-identical', /keeping it/.test(a3.stdout), a3.stdout);
  assert('metadata is backfilled', fs.existsSync(metaPath));
}

// ── cleanup ──────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

log('');
if (failures) {
  log(`${failures} check(s) FAILED`);
  process.exit(1);
}
log('ALL CHECKS PASSED');
