import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ToolkitAdapterManager } from './adapters/index.js';
import { DbusMenuBackend } from './dbus/backend.js';
import { GlobalItPanelMenu } from './panelMenu.js';
import { createLogger } from './utils/logger.js';

export default class GlobalItExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._logger = createLogger(
            'global-it',
            () => this._settings?.get_boolean('debug-mode') ?? false,
            () => this._settings?.get_boolean('debug-perf-mode') ?? GLib.getenv('DEBUG_PERF') === '1'
        );

        this._windowTracker = Shell.WindowTracker.get_default();
        this._adapters = new ToolkitAdapterManager(this._settings);
        this._menuBackend = new DbusMenuBackend(this._logger);
        this._panel = new GlobalItPanelMenu(this, this._settings, this._logger, itemId => this._activateMenuItem(itemId));
        this._focusGeneration = 0;
        this._focusDebounceMs = 55;
        this._focusDebounceId = 0;
        this._watchdogIntervalMs = 1500;
        this._watchdogStuckMs = 4500;
        this._watchdogId = 0;
        this._refreshInProgress = false;
        this._refreshStartedUs = 0;
        this._pendingRefreshReason = null;
        this._destroyed = false;
        this._stressTimeouts = [];
        this._signals = [];

        Main.panel.addToStatusArea('global-it-panel', this._panel, 1, 'left');

        this._menuBackend.setMenuChangedHandler(() => this._safeInvoke('menu-changed handler', () => {
            this._scheduleRefresh('menu-changed', 45);
        }));

        this._connectSignals();
        this._startWatchdog();
        this._menuBackend.initialize().catch(error => {
            this._logger.error(`Failed to initialize DBus registrar: ${error.message}`);
            this._panel?.setNoMenu('Registrar unavailable');
        });
        this._scheduleRefresh('enable', 0);
        if (this._settings.get_boolean('stress-test-mode') || GLib.getenv('STRESS_TEST_MODE') === '1')
            this._startStressTestMode();
    }

    disable() {
        this._destroyed = true;
        this._stopStressTestMode();
        this._stopWatchdog();
        this._cancelScheduledRefresh();
        this._disconnectSignals();
        this._refreshInProgress = false;
        this._pendingRefreshReason = null;
        this._refreshStartedUs = 0;

        this._menuBackend?.destroy();
        this._menuBackend = null;

        this._panel?.destroy();
        this._panel = null;

        this._adapters = null;
        this._windowTracker = null;
        this._logger = null;
        this._settings = null;
    }

    _connectSignals() {
        // GNOME Shell updates this property whenever focus changes.
        this._signals.push([
            global.display,
            global.display.connect('notify::focus-window', () => this._safeInvoke('focus-window signal', () => this._scheduleRefresh('focus-window'))),
        ]);
        this._signals.push([
            global.display,
            global.display.connect('window-created', () => this._safeInvoke('window-created signal', () => this._scheduleRefresh('window-created', 75))),
        ]);
        this._signals.push([
            this._settings,
            this._settings.connect('changed', () => this._safeInvoke('settings-changed signal', () => this._scheduleRefresh('settings-changed', 70))),
        ]);
    }

    _disconnectSignals() {
        for (const [object, id] of this._signals ?? []) {
            if (!object || !id)
                continue;
            object.disconnect(id);
        }
        this._signals = [];
    }

    _scheduleRefresh(reason, debounceMs = this._focusDebounceMs) {
        if (this._destroyed)
            return;
        if (this._focusDebounceId)
            GLib.Source.remove(this._focusDebounceId);
        this._focusDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, debounceMs, () => {
            this._focusDebounceId = 0;
            this._refreshFocusedWindow(reason).catch(error => this._logger.error(`Refresh failure (${reason}): ${error.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelScheduledRefresh() {
        if (!this._focusDebounceId)
            return;
        GLib.Source.remove(this._focusDebounceId);
        this._focusDebounceId = 0;
    }

    async _refreshFocusedWindow(reason = 'unspecified') {
        if (this._destroyed)
            return;
        if (this._refreshInProgress) {
            this._pendingRefreshReason = reason;
            return;
        }
        this._refreshInProgress = true;
        this._refreshStartedUs = GLib.get_monotonic_time();
        const generation = ++this._focusGeneration;
        const startUs = GLib.get_monotonic_time();
        try {
            const window = global.display.focus_window;

            if (!window) {
                this._menuBackend.clearActiveClient();
                this._panel.clearForNoWindow();
                return;
            }

            const app = this._windowTracker.get_window_app(window);
            this._panel.setFocusedApplication(app, window);

            const toolkit = this._adapters.detectToolkit(window, app);
            if (!this._adapters.isToolkitEnabled(toolkit)) {
                this._menuBackend.clearActiveClient();
                this._panel.setNoMenu(`Disabled for ${toolkit.toUpperCase()} apps`);
                return;
            }

            const tree = await this._menuBackend.setActiveWindow(window);
            if (generation !== this._focusGeneration)
                return;

            if (!tree || !tree.children?.length) {
                this._panel.setNoMenu('No exported menu');
                return;
            }

            this._panel.setMenuTree(tree);
        } catch (error) {
            if (generation !== this._focusGeneration)
                return;
            this._logger.error(`Failed to load menu: ${error.message}`);
            this._panel.setNoMenu('Menu unavailable');
        } finally {
            const totalMs = (GLib.get_monotonic_time() - startUs) / 1000;
            const backendStats = this._menuBackend?.getPerfSnapshot?.() ?? {};
            const panelStats = this._panel?.getLastRenderStats?.() ?? {};
            const lookupMs = Number(backendStats.lookupMs ?? 0);
            const layoutMs = Number(backendStats.layoutMs ?? 0);
            const popupMs = Number(panelStats.renderMs ?? 0);
            const memoryBytes = Math.round((backendStats.memoryBytes ?? 0) + (panelStats.memoryBytes ?? 0));
            this._logger.perf(
                `refresh reason=${reason} total_ms=${totalMs.toFixed(2)} ` +
                `lookup_ms=${lookupMs.toFixed(2)} ` +
                `layout_ms=${layoutMs.toFixed(2)} ` +
                `popup_ms=${popupMs.toFixed(2)} ` +
                `mem_bytes=${memoryBytes}`
            );
            this._refreshInProgress = false;
            this._refreshStartedUs = 0;
            if (this._pendingRefreshReason && !this._destroyed) {
                const pending = this._pendingRefreshReason;
                this._pendingRefreshReason = null;
                this._scheduleRefresh(pending, 20);
            }
        }
    }

    _activateMenuItem(itemId) {
        this._menuBackend.activateItem(itemId).catch(error => {
            this._logger.error(`Failed to activate menu item ${itemId}: ${error.message}`);
        });
    }

    _safeInvoke(label, callback) {
        try {
            callback();
        } catch (error) {
            this._logger.error(`${label} failed: ${error.message}`);
        }
    }

    _startWatchdog() {
        this._watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._watchdogIntervalMs, () => {
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            if (this._refreshInProgress && this._refreshStartedUs > 0) {
                const elapsedMs = (GLib.get_monotonic_time() - this._refreshStartedUs) / 1000;
                if (elapsedMs > this._watchdogStuckMs) {
                    this._logger.error(`Watchdog recovered stuck refresh (${elapsedMs.toFixed(1)}ms)`);
                    this._refreshInProgress = false;
                    this._refreshStartedUs = 0;
                    this._menuBackend.clearActiveClient();
                    this._panel.setNoMenu('Watchdog recovery');
                    this._scheduleRefresh('watchdog-recovery', 20);
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWatchdog() {
        if (!this._watchdogId)
            return;
        GLib.Source.remove(this._watchdogId);
        this._watchdogId = 0;
    }

    _startStressTestMode() {
        const pushTimeout = (delay, callback) => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._safeInvoke('stress-test callback', callback);
                return GLib.SOURCE_REMOVE;
            });
            this._stressTimeouts.push(id);
        };

        for (let i = 0; i < 100; i++)
            pushTimeout(i * 8, () => this._scheduleRefresh(`stress-focus-${i}`, 1));

        for (let i = 0; i < 40; i++) {
            pushTimeout(i * 12, () => {
                this._panel.setMenuTree({
                    id: 0,
                    children: [{ id: 1000 + i, label: `Stress ${i}`, children: [] }],
                });
            });
        }

        for (let i = 0; i < 12; i++) {
            pushTimeout(200 + i * 35, () => {
                this._panel.setMenuTree({ bad: 'tree' });
            });
        }

        for (let i = 0; i < 10; i++) {
            pushTimeout(300 + i * 60, () => {
                this._menuBackend.clearActiveClient();
                this._panel.setNoMenu('Stress exporter crash');
            });
        }
    }

    _stopStressTestMode() {
        for (const id of this._stressTimeouts) {
            try {
                GLib.Source.remove(id);
            } catch (_error) {
                // Ignore already removed sources.
            }
        }
        this._stressTimeouts = [];
    }
}
