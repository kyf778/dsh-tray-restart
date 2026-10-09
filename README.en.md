# DSH tray restart

**English** | [简体中文](./README.md)

Adds a **Restart** entry to the DeepSeek Harness desktop (Windows) system tray menu.

The tray originally had just two entries, so restarting meant quitting and reopening by hand:

```
Open DeepSeek Harness
────────────
Quit DeepSeek Harness
```

After patching there are three, with Restart sitting between Open and Quit:

```
Open DeepSeek Harness
Restart DeepSeek Harness
────────────
Quit DeepSeek Harness
```

The wording, grouping and separator match the app's own other menus (the Restart entry
reuses the app's own restart path rather than implementing a separate one).

## Why this isn't an ordinary plugin

DSH's plugin system (`cordis.patch.yml`) can only compose **backend services**, whereas the
tray icon is created by the `DesktopTray` class inside the Electron **main process**, out of
reach of the plugin API. So this patches the main-process file directly.

Specifically it patches `lib/main.js` inside `resources/app.asar`, in four places:

| Location | Change |
| --- | --- |
| Chinese dictionary | adds `restartTrayApplication: "重启 DeepSeek Harness"` |
| English dictionary | adds `restartTrayApplication: "Restart DeepSeek Harness"` |
| Tray constructor | registers the `restart` action |
| Tray menu | inserts the item between Open and Quit |

The new dictionary key is **added separately** rather than reusing the existing
`restartApplication` (that one is the crash-recovery dialog's button label), so no other
screen's wording changes.

## Install

Requires Node.js 18+.

**On Windows the install script is recommended** — it handles the "file is locked because the
app is running" problem for you:

```bat
git clone https://github.com/kyf778/dsh-tray-restart.git
cd dsh-tray-restart
install.cmd
```

When it finds Harness running, the script offers to close it, applies the patch, and then
offers to reopen it.

**Or use the Node command directly** (quit Harness completely first):

```bash
node index.js apply
```

> On Windows `resources/app.asar` is **locked** while Harness runs, so you must quit the app
> (tray → Quit) before patching, otherwise the write fails. The script detects this and says so.

After seeing `Patched lib/main.js`, reopen DeepSeek Harness and right-click the tray icon to
find "Restart DeepSeek Harness".

If the app is installed somewhere non-standard:

```bat
install.cmd -Asar "D:\path\to\app.asar"
node index.js apply --asar "D:\path\to\app.asar"   # or set DSH_ASAR
```

Available commands:

| Command | Purpose |
| --- | --- |
| `install.cmd` | One-click install (closes/reopens Harness for you) |
| `uninstall.cmd` | One-click revert |
| `node index.js status` | Show whether the patch is applied |
| `node index.js apply` | Apply the patch (backs up first, safe to re-run) |
| `node index.js restore` | Restore from the backup |
| `node index.js verify` | Re-check the integrity of every file in the asar |

> If PowerShell complains about unsigned scripts, that is Windows' default execution policy;
> `install.cmd` / `uninstall.cmd` already pass `-ExecutionPolicy Bypass`, so use those and you
> won't hit it.

## Safety

This modifies a binary bundle in the app's install directory, so it takes these precautions:

- **Back up first.** The first `apply` stores the original `app.asar` as
  `app.asar.dsh-tray-restart.bak`, and `restore` brings back a byte-identical copy.
- **Touch one file only.** Rewriting copies the other 11,469 files unchanged and replaces only
  `lib/main.js`; the tests compare per-file hashes to prove it.
- **Anchors must be unique.** Each of the four match strings may appear exactly once; if any
  one fails to match, the script aborts immediately and **writes nothing**. If a DSH upgrade
  changes that code, the script refuses to run rather than corrupting the file.
- **Recompute integrity.** Every file in the asar carries an `integrity` record, recomputed
  after patching.
- **Idempotent.** An already-patched file is reported as such instead of being patched twice.

Verified on: Windows 11 + DeepSeek Harness Desktop **0.2.0-rc.2** (app version 44.0.0,
`dshBuildCommit` `04f392c`).

## After upgrading DeepSeek Harness

An app upgrade overwrites `resources/app.asar`, which drops the patch. **Just run
`node index.js apply` again after upgrading.**

Thanks to the anchor mechanism, if the new version's `lib/main.js` has a different structure
the script stops safely and tells you instead of corrupting the file — in that case open an
issue with the version number.

## Tests

```bash
node test/run-tests.cjs
```

The tests all run against a **copy** of `app.asar` in a temp directory and never touch your
installed app. They cover 31 checks: header byte round-trip, per-file hash comparison before
and after patching, integrity, syntax, tray menu behaviour (including the race guard that
ignores clicks while shutting down), idempotency, byte-identical restore, and safe abort on
anchor mismatch.

If `app.asar` isn't found, it prints SKIP rather than failing.

## Uninstall

```bat
uninstall.cmd
```

Or quit Harness and restore by hand:

```bash
node index.js restore
```

Then delete the repository folder.

## Compatibility

- **Windows only.** The tray's `DesktopTray` class is itself constructed inside a
  `process.platform === "win32"` branch; macOS / Linux have no such menu.
- Desktop (Electron) only — `dsh web` has no tray.

## Author's note

Having to quit and then hunt for the icon on the desktop every time I wanted to restart was
genuinely annoying. Since the official menu already had the wording and logic for Restart,
the obvious move was to put it in the tray.

Enjoy — and a star in the top-right corner is appreciated if you find it useful.

## License

MIT
