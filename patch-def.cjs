'use strict';

/**
 * The edits that add a "Restart DeepSeek Harness" entry to the Windows system
 * tray menu.
 *
 * The tray menu is built by `DesktopTray.relabel()` in `lib/main.js`, and the
 * tray is constructed only under `process.platform === "win32"`, so this is a
 * Windows-only surface with exactly two existing entries ("Open" and "Quit").
 *
 * Layout after patching:
 *     打开 DeepSeek Harness
 *     重启 DeepSeek Harness
 *     ────────────────────
 *     退出 DeepSeek Harness
 *
 * Restart joins the two window actions and keeps the existing "separator then
 * quit" grouping the app menu already uses, so Quit stays the last item as in
 * every other DSH menu.
 */

const MARKER = '/* dsh-tray-restart */';

/**
 * A dedicated dictionary key rather than reusing `restartApplication`.
 *
 * `restartApplication` ("重启" / "Restart") already exists and is the fatal
 * recovery dialog's button. Reusing it would silently widen that dialog's
 * button text, so the tray gets its own key — which also lets it carry the
 * full product name, matching its two sibling entries.
 */
const NEW_KEY = 'restartTrayApplication';

/** 1+2. Add the new label to each shipped dictionary, next to its siblings. */
const LOCALE_PATCHES = [
  {
    id: 'zh',
    before: '\tquitApplication: "退出 DeepSeek Harness",\n\topenApplication: "打开 DeepSeek Harness",\n\tquit: "退出",',
    after: '\tquitApplication: "退出 DeepSeek Harness",\n\topenApplication: "打开 DeepSeek Harness",\n\trestartTrayApplication: "重启 DeepSeek Harness",\n\tquit: "退出",',
  },
  {
    id: 'en',
    before: '\tquitApplication: "Quit DeepSeek Harness",\n\topenApplication: "Open DeepSeek Harness",\n\tquit: "Quit",',
    after: '\tquitApplication: "Quit DeepSeek Harness",\n\topenApplication: "Open DeepSeek Harness",\n\trestartTrayApplication: "Restart DeepSeek Harness",\n\tquit: "Quit",',
  },
];

/**
 * 3. Register the restart action on the tray.
 *
 * The handler copies the app's own restart path verbatim — both the fatal
 * recovery `restart` operation and the development "Restart App and Host" entry
 * do `app.relaunch(); quitWithoutConfirmation();`. `quitWithoutConfirmation()`
 * sets `skipQuitConfirmation`, so the "tasks are running" dialog is skipped: a
 * restart is an explicit decision and those tasks survive the relaunch. The
 * `quitting` guard matches the dev entry's, so a click during an in-flight
 * shutdown is dropped rather than racing it.
 */
const TRAY_CTOR_BEFORE = `\t\t\tquit: () => {
\t\t\t\tapp.quit();
\t\t\t}
\t\t});`;
const TRAY_CTOR_AFTER = `\t\t\tquit: () => {
\t\t\t\tapp.quit();
\t\t\t},
\t\t\t${MARKER} restart: () => {
\t\t\t\tif (quitting) return;
\t\t\t\tapp.relaunch();
\t\t\t\tquitWithoutConfirmation();
\t\t\t}
\t\t});`;

/** 4. Insert the menu item above the separator that precedes Quit. */
const RELABEL_BEFORE = `\t\t\t{ type: "separator" },
\t\t\t{
\t\t\t\tlabel: messages.quitApplication,`;
const RELABEL_AFTER = `\t\t\t{
\t\t\t\t${MARKER} label: messages.restartTrayApplication,
\t\t\t\tclick: () => {
\t\t\t\t\tthis.options.restart();
\t\t\t\t}
\t\t\t},
\t\t\t{ type: "separator" },
\t\t\t{
\t\t\t\tlabel: messages.quitApplication,`;

/** Every substitution applied to `lib/main.js`: [id, before, after]. */
const EDITS = [
  ...LOCALE_PATCHES.map((p) => [p.id, p.before, p.after]),
  ['tray-ctor', TRAY_CTOR_BEFORE, TRAY_CTOR_AFTER],
  ['tray-relabel', RELABEL_BEFORE, RELABEL_AFTER],
];

module.exports = { EDITS, MARKER, NEW_KEY, TRAY_CTOR_AFTER, RELABEL_AFTER, LOCALE_PATCHES };
