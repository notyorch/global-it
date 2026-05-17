import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DASH_TO_DOCK_UUIDS = [
    'dash-to-dock@micxgx.gmail.com',
    'ubuntu-dock@ubuntu.com',
];

export const GlobalItPanelMenu = GObject.registerClass(class GlobalItPanelMenu extends PanelMenu.Button {
    _init(extension, settings, logger, onActivateItem) {
        super._init(0.0, 'global-it');
        this._settings = settings;
        this._logger = logger;
        this._onActivateItem = onActivateItem;
        this._hoverTimeoutId = 0;
        this._rebuildTimeoutId = 0;
        this._pendingTree = null;
        this._menuRebuildThrottleMs = 60;
        this._menuItemSignals = [];
        this._lastRenderDurationUs = 0;
        this._lastRenderMemoryEstimateBytes = 0;
        this._menuTree = null;
        this._focusedWindow = null;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_expand: true,
        });

        this._icon = new St.Icon({
            icon_name: 'application-x-executable-symbolic',
            style_class: 'system-status-icon',
            visible: this._settings.get_boolean('show-app-icon'),
        });
        this._label = new St.Label({
            text: 'global-it',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._icon);
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._settingsSignalId = this._settings.connect('changed', () => this._safeInvoke('settings sync', () => this._syncSettings()));
        this._enterSignalId = this.connect('enter-event', () => this._safeInvoke('hover enter', () => this._queueHoverOpen()));
        this._leaveSignalId = this.connect('leave-event', () => this._safeInvoke('hover leave', () => this._cancelHoverOpen()));
        this._keySignalId = this.connect('key-press-event', (_, event) => this._handleKeyPress(event));

        this._syncSettings();
    }

    destroy() {
        this._cancelHoverOpen();
        this._cancelRebuild();
        this._clearMenu();
        if (this._settingsSignalId)
            this._settings.disconnect(this._settingsSignalId);
        if (this._enterSignalId)
            this.disconnect(this._enterSignalId);
        if (this._leaveSignalId)
            this.disconnect(this._leaveSignalId);
        if (this._keySignalId)
            this.disconnect(this._keySignalId);
        super.destroy();
    }

    setFocusedApplication(app, window) {
        const appName = app?.get_name?.() ?? window?.get_title?.() ?? 'Unknown app';
        this._label.text = appName;
        this._focusedWindow = window ?? null;

        const appIcon = app?.get_app_info?.()?.get_icon?.();
        if (appIcon)
            this._icon.gicon = appIcon;
        else
            this._icon.icon_name = 'application-x-executable-symbolic';
    }

    clearForNoWindow() {
        this._label.text = 'No app';
        this._focusedWindow = null;
        this._clearMenu();
        this.visible = false;
    }

    setNoMenu(reason) {
        this._cancelRebuild();
        this._pendingTree = null;
        this._clearMenu();
        this._menuTree = null;
        this.menu.close();
        this._logger.debug(`No exported menu: ${reason}`);
        this._showFallbackMenu(reason);
        this.visible = !this._settings.get_boolean('hide-without-menu');
    }

    setMenuTree(tree) {
        if (!tree || typeof tree !== 'object') {
            this.setNoMenu('Invalid menu tree');
            return;
        }
        this._pendingTree = tree;
        this._queueMenuRebuild();
    }

    _syncSettings() {
        this._icon.visible = this._settings.get_boolean('show-app-icon');
        const compact = this._settings.get_boolean('compact-mode');
        this._label.set_style(compact ? 'font-size: 0.92em;' : null);
    }

    _queueHoverOpen() {
        this._cancelHoverOpen();
        const delayMs = this._settings.get_int('menu-open-delay');
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._hoverTimeoutId = 0;
            try {
                if (!this.menu.isOpen && this.visible && this._menuTree)
                    this.menu.open();
            } catch (error) {
                this._logger.error(`Hover-open failed: ${error.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHoverOpen() {
        if (!this._hoverTimeoutId)
            return;
        GLib.Source.remove(this._hoverTimeoutId);
        this._hoverTimeoutId = 0;
    }

    _clearMenu() {
        for (const [item, id] of this._menuItemSignals) {
            try {
                item.disconnect(id);
            } catch (_error) {
                // Item may already be destroyed.
            }
        }
        this._menuItemSignals = [];
        this.menu.removeAll();
    }

    _appendNode(menu, node) {
        if (!node || node.visible === false)
            return;

        if (node.type === 'separator') {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            return;
        }

        if (node.children?.length) {
            // PopupSubMenuMenuItem gives native keyboard navigation for nested menus.
            const submenu = new PopupMenu.PopupSubMenuMenuItem(node.label || 'Untitled');
            submenu.setSensitive(node.enabled !== false);
            for (const child of node.children)
                this._appendNode(submenu.menu, child);
            menu.addMenuItem(submenu);
            return;
        }

        const item = new PopupMenu.PopupMenuItem(node.label || 'Untitled');
        item.setSensitive(node.enabled !== false);
        const signalId = item.connect('activate', () => {
            try {
                this._onActivateItem(node.id);
            } catch (error) {
                this._logger.error(`Menu item activation callback failed: ${error.message}`);
            }
        });
        this._menuItemSignals.push([item, signalId]);
        menu.addMenuItem(item);
    }

    getLastRenderStats() {
        return {
            renderMs: this._lastRenderDurationUs / 1000,
            memoryBytes: this._lastRenderMemoryEstimateBytes,
        };
    }

    _queueMenuRebuild() {
        if (this._rebuildTimeoutId)
            return;
        this._rebuildTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._menuRebuildThrottleMs,
            () => {
                this._rebuildTimeoutId = 0;
                this._applyMenuTree();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _cancelRebuild() {
        if (!this._rebuildTimeoutId)
            return;
        GLib.Source.remove(this._rebuildTimeoutId);
        this._rebuildTimeoutId = 0;
    }

    _applyMenuTree() {
        try {
            const tree = this._pendingTree;
            this._pendingTree = null;
            if (!tree)
                return;

            this._menuTree = tree;
            const startUs = GLib.get_monotonic_time();
            this._clearMenu();
            for (const node of tree.children ?? [])
                this._appendNode(this.menu, node);
            this.visible = true;
            this._lastRenderDurationUs = GLib.get_monotonic_time() - startUs;
            this._lastRenderMemoryEstimateBytes = this._estimateTreeMemory(tree);
            this._logger.perf?.(`popup-render ms=${(this._lastRenderDurationUs / 1000).toFixed(2)} memory_bytes=${this._lastRenderMemoryEstimateBytes}`);
        } catch (error) {
            this._logger.error(`Popup render failed: ${error.message}`);
            this._menuTree = null;
            this._clearMenu();
            this._showFallbackMenu('Render failure');
        }
    }

    _estimateTreeMemory(node) {
        if (!node)
            return 0;
        const labelLength = (node.label ?? '').length;
        let bytes = 128 + labelLength * 2;
        for (const child of node.children ?? [])
            bytes += this._estimateTreeMemory(child);
        return bytes;
    }

    _handleKeyPress(event) {
        try {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_space || key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                this.menu.toggle();
                return Clutter.EVENT_STOP;
            }
        } catch (error) {
            this._logger.error(`Key handling failed: ${error.message}`);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _showFallbackMenu(reason) {
        try {
            this._clearMenu();
            const fallback = new PopupMenu.PopupMenuItem(`Menu unavailable (${reason})`);
            fallback.setSensitive(false);
            this.menu.addMenuItem(fallback);
        } catch (error) {
            this._logger.error(`Fallback menu build failed: ${error.message}`);
        }
    }

    _safeInvoke(label, callback) {
        try {
            callback();
        } catch (error) {
            this._logger.error(`${label} failed: ${error.message}`);
        }
    }
});
