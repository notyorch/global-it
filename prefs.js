import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GlobalItPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const generalPage = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        const appearanceGroup = new Adw.PreferencesGroup({ title: _('Appearance') });
        const behaviorGroup = new Adw.PreferencesGroup({ title: _('Behavior') });
        const compatibilityGroup = new Adw.PreferencesGroup({ title: _('Compatibility') });
        const diagnosticsGroup = new Adw.PreferencesGroup({ title: _('Diagnostics') });

        appearanceGroup.add(this._buildSwitchRow(settings, 'show-app-icon', _('Show app icon')));
        appearanceGroup.add(this._buildSwitchRow(settings, 'compact-mode', _('Compact mode')));

        const delayRow = new Adw.SpinRow({
            title: _('Menu open delay (ms)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1500,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_int('menu-open-delay'),
            }),
        });
        settings.bind('menu-open-delay', delayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(delayRow);

        behaviorGroup.add(this._buildSwitchRow(settings, 'hide-without-menu', _('Auto-hide when no menu is exported')));

        compatibilityGroup.add(this._buildSwitchRow(settings, 'enable-gtk3', _('Enable GTK3 integration')));
        compatibilityGroup.add(this._buildSwitchRow(settings, 'enable-qt', _('Enable Qt5/Qt6 integration')));
        compatibilityGroup.add(this._buildSwitchRow(settings, 'enable-electron', _('Enable Electron integration')));

        diagnosticsGroup.add(this._buildSwitchRow(settings, 'debug-mode', _('Debug mode logging')));
        diagnosticsGroup.add(this._buildSwitchRow(settings, 'debug-perf-mode', _('DEBUG_PERF instrumentation mode')));
        diagnosticsGroup.add(this._buildSwitchRow(settings, 'stress-test-mode', _('Stress-test mode')));

        generalPage.add(appearanceGroup);
        generalPage.add(behaviorGroup);
        generalPage.add(compatibilityGroup);
        generalPage.add(diagnosticsGroup);
        window.add(generalPage);

        window.search_enabled = true;
        window.set_default_size(680, 560);
    }

    _buildSwitchRow(settings, key, title) {
        const row = new Adw.SwitchRow({ title });
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
