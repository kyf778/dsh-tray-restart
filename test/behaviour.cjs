'use strict';

/**
 * Behavioural test for the patched tray.
 *
 * Both halves are lifted out of the *patched* lib/main.js rather than
 * re-implemented, so what is asserted is the code that will actually ship:
 *   1. the menu built by `DesktopTray.relabel()`
 *   2. the `restart:` handler wired into `new DesktopTray({...})`
 *
 * Requires a real app.asar (or one produced by the apply test). The runner
 * passes the path of an already-patched asar via TEST_PATCHED_ASAR.
 */

const fs = require('node:fs');
const { readEntryText } = require('./lib.cjs');

const results = [];
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  results.push({ name, ok: g === w, got: g, want: w });
};

function run(patchedAsar) {
  const patched = readEntryText(patchedAsar, 'lib/main.js');
  if (patched === null) throw new Error('lib/main.js not found in ' + patchedAsar);

  // ---- lift the DesktopTray class out of the patched bundle ----
  const clsStart = patched.indexOf('var DesktopTray = class {');
  const clsEnd = patched.indexOf('//#endregion', clsStart);
  if (clsStart < 0 || clsEnd < 0) throw new Error('DesktopTray class not found');
  const trayClassSrc = patched.slice(clsStart, clsEnd);

  // ---- lift the real restart handler out of the wiring block ----
  const wireStart = patched.indexOf('tray = new DesktopTray({');
  const wireEnd = patched.indexOf('});', wireStart) + 3;
  const wireSrc = patched.slice(wireStart, wireEnd);
  const handlerMatch = wireSrc.match(/restart: \(\) => \{[\s\S]*?\n\t\t\t\}/);
  if (!handlerMatch) throw new Error('could not lift the restart handler');
  const restartHandlerSrc = handlerMatch[0].replace(/^restart:/, '');

  // ---- mocks matching the Electron surface the real code uses ----
  const calls = [];
  const app = { relaunch: () => calls.push('app.relaunch') };
  let skipQuitConfirmation = false;
  function quitWithoutConfirmation() {
    skipQuitConfirmation = true;
    calls.push('quitWithoutConfirmation');
  }
  const Tray = class { on() {} setToolTip() {} setContextMenu() {} destroy() {} };
  const Menu = { buildFromTemplate: (t) => t };
  const nativeImage = { createFromPath: (p) => p };

  const DesktopTray = new Function('Tray', 'Menu', 'nativeImage', `${trayClassSrc}\n return DesktopTray;`)(Tray, Menu, nativeImage);

  const messages = {
    aboutProduct: 'DeepSeek Harness',
    openApplication: '打开 DeepSeek Harness',
    restartTrayApplication: '重启 DeepSeek Harness',
    quitApplication: '退出 DeepSeek Harness',
  };

  // The handler reads the bundle-scoped `quitting` let, which the real code
  // captures by closure. Each bind below is one such closure, so the guard can
  // be exercised by binding with quitting=true.
  const makeRestart = (quitting) =>
    new Function('quitting', 'app', 'quitWithoutConfirmation', `return ${restartHandlerSrc}`)(
      quitting, app, quitWithoutConfirmation
    );

  const buildTray = (restart) => {
    let captured = null;
    const tray = new DesktopTray({
      iconPath: 'x',
      locale: () => ({ id: 'zh-CN', messages }),
      open: () => calls.push('open'),
      quit: () => calls.push('quit'),
      restart,
    });
    tray.tray = { setToolTip() {}, setContextMenu(m) { captured = m; }, destroy() {} };
    tray.relabel();
    return { tray, menu: captured };
  };

  const built = buildTray(makeRestart(false));
  const captured = built.menu;

  // 1. menu order and labels
  check('menu order and labels', (captured || []).map((m) => m.label ?? m.type), [
    '打开 DeepSeek Harness',
    '重启 DeepSeek Harness',
    'separator',
    '退出 DeepSeek Harness',
  ]);

  // 2. restart relaunches, then quits without the confirmation dialog
  calls.length = 0;
  captured[1].click();
  check('restart -> relaunch then skip-confirm', calls, ['app.relaunch', 'quitWithoutConfirmation']);
  check('skipQuitConfirmation set', skipQuitConfirmation, true);

  // 3. the existing entries are untouched
  calls.length = 0;
  captured[3].click();
  check('quit unchanged', calls, ['quit']);

  calls.length = 0;
  captured[0].click();
  check('open unchanged', calls, ['open']);

  // 4. the restart handler matches the app's own restart path
  check('handler uses app.relaunch()', /app\.relaunch\(\);/.test(restartHandlerSrc), true);
  check('handler uses quitWithoutConfirmation()', /quitWithoutConfirmation\(\);/.test(restartHandlerSrc), true);

  // 5. guard: a click while a shutdown is already in flight does nothing
  {
    const guarded = buildTray(makeRestart(true));
    calls.length = 0;
    skipQuitConfirmation = false;
    guarded.menu[1].click();
    check('restart dropped while quitting', calls, []);
    check('guard does not set the skip flag', skipQuitConfirmation, false);
  }

  // 6. both dictionaries carry the new key
  check('zh dictionary key', /restartTrayApplication: "重启 DeepSeek Harness",/.test(patched), true);
  check('en dictionary key', /restartTrayApplication: "Restart DeepSeek Harness",/.test(patched), true);
}

module.exports = { run, results };
