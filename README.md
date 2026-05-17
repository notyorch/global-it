# global-it

`global-it` is a GNOME Shell extension (GNOME 48+) that exposes exported DBus application menus in the top panel, with a Unity/macOS-style global menu workflow.

## What it does

- Tracks focused windows via `global.display` and `Shell.WindowTracker`
- Resolves menu exporters through `com.canonical.AppMenu.Registrar`
- Reads menu trees with async DBus calls (`GetLayout`, `Event`)
- Renders nested menus using Shell `PopupMenu` APIs
- Updates on focus changes and remote DBus layout updates
- Gracefully hides itself when no menu is available
- Includes toolkit toggles (GTK3 / Qt / Electron) and debug logging
- Includes performance instrumentation and lifecycle safety cleanup

## Important compatibility notes

### GTK4 / libadwaita limitations

GTK4/libadwaita apps generally do **not** export classic DBusMenu trees required by global menu implementations. On vanilla Fedora GNOME, many GTK4 apps only expose in-window menus, so `global-it` cannot mirror those menus in the top bar. In those cases, the extension falls back to hidden/empty state depending on your settings.

### Fedora GNOME / Wayland behavior

- Works without Ubuntu Unity patches
- Uses only standard GNOME Shell APIs and session DBus
- Actual menu availability depends on whether each app exports DBusMenu

Detailed per-application results are tracked in [`COMPATIBILITY_MATRIX.md`](./COMPATIBILITY_MATRIX.md).

## Project layout

```
global-it/
├── extension.js
├── panelMenu.js
├── dbus/
│   ├── backend.js
│   ├── dbusMenu.js
│   ├── registrar.js
│   └── mockMenu.js
├── adapters/
│   └── index.js
├── utils/
│   └── logger.js
├── prefs.js
├── schemas/
│   └── org.gnome.shell.extensions.global-it.gschema.xml
├── metadata.json
└── README.md
```

## Install on Fedora Workstation

1. Install required packages:

```bash
sudo dnf install -y gnome-shell-extension-common glib2-devel gettext meson
```

2. Copy extension to local extensions dir:

```bash
UUID="global-it@notyorch.github.io"
mkdir -p ~/.local/share/gnome-shell/extensions/$UUID
cp -r ./* ~/.local/share/gnome-shell/extensions/$UUID/
```

3. Compile schemas in place:

```bash
glib-compile-schemas ~/.local/share/gnome-shell/extensions/$UUID/schemas
```

4. Enable extension:

```bash
gnome-extensions enable $UUID
```

5. Open preferences:

```bash
gnome-extensions prefs $UUID
```

## Development / hot reload

1. Install the extension in development mode (symlink):

```bash
chmod +x scripts/*.sh scripts/*.js
./scripts/install-dev.sh
```

2. Run nested GNOME Shell for safe testing:

```bash
./scripts/run-nested.sh
```

Use Xephyr explicitly when needed:

```bash
./scripts/run-nested.sh --xephyr
```

3. Quick hot reload without logging out:

```bash
./scripts/hot-reload.sh
```

4. Reset settings and extension state:

```bash
./scripts/reset-extension.sh
```

5. Journal logs:

```bash
journalctl --user -f /usr/bin/gnome-shell | grep global-it
```

Enable performance debug logging:

```bash
gsettings set org.gnome.shell.extensions.global-it debug-perf-mode true
# or for one shell process/session:
DEBUG_PERF=1 ./scripts/run-nested.sh
```

### Mock DBusMenu provider app

Run the mock provider inside the same DBus session as your nested shell:

```bash
./scripts/mock-dbusmenu-provider.js normal 1
```

Supported modes:

- `normal` (nested menu tree)
- `malformed` (invalid layout payload)
- `missing` (no menu exporter mapping)
- `slow` (intentional timeout)
- `rapid` (frequent layout updates)

### Automated smoke tests

Core logic smoke tests:

```bash
./scripts/smoke-tests.sh
```

Includes automated checks for:

- focus switching behavior
- malformed DBus payload handling
- missing menu exporters
- rapid window changes
- extension lifecycle cycles (backend lifecycle)
- DBus timeout responsiveness

Optional live Shell enable/disable cycling (run from active nested shell session):

```bash
LIVE_SHELL_TESTS=1 ./scripts/smoke-tests.sh
```

Enable extension-level stress simulation mode:

```bash
gsettings set org.gnome.shell.extensions.global-it stress-test-mode true
```

## Fallback behavior

- No focused window: panel item hides
- Focused app has no registrar entry: panel item hides (or stays visible if disabled in settings)
- DBus malformed layout: parser ignores invalid nodes and logs an error
- DBus call failure/timeouts: menu is cleared without crashing GNOME Shell

## Performance and shell-safety protections

- Measures DBus latency (lookup/init/layout/event), menu parse time, popup render time, and memory estimates
- Debounces focus-change/settings-triggered refreshes and throttles DBus layout-update/menu rebuild bursts
- Prevents recursive refresh loops with in-flight refresh guards and pending refresh coalescing
- Prunes stale DBus proxies (lost owner / idle timeout), disconnects signal handlers on teardown, and clears timers on disable/reload
- Cleans up active clients when applications crash and lose DBus ownership
- Wraps async DBus work with timeout + cancellation to prevent Shell stalls
- Uses watchdog recovery to reset stuck refresh loops to a safe fallback menu state

## Mock DBusMenu data

`dbus/mockMenu.js` ships sample nested menu data for parser/rendering tests and rapid UI iteration.

## Settings keys

- `enable-gtk3`
- `enable-qt`
- `enable-electron`
- `show-app-icon`
- `compact-mode`
- `menu-open-delay`
- `hide-without-menu`
- `debug-mode`
- `debug-perf-mode`
- `stress-test-mode`
