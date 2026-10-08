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

// ── cleanup ──────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

log('');
if (failures) {
  log(`${failures} check(s) FAILED`);
  process.exit(1);
}
log('ALL CHECKS PASSED');
