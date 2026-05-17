export class ToolkitAdapterManager {
    constructor(settings) {
        this._settings = settings;
    }

    detectToolkit(window, app) {
        const appId = app?.get_id?.()?.toLowerCase?.() ?? '';
        const wmClass = window?.get_wm_class?.()?.toLowerCase?.() ?? '';
        const wmClassInstance = window?.get_wm_class_instance?.()?.toLowerCase?.() ?? '';
        const fingerprint = `${appId} ${wmClass} ${wmClassInstance}`;

        if (fingerprint.includes('electron') || fingerprint.includes('code') || fingerprint.includes('slack'))
            return 'electron';
        if (fingerprint.includes('qt') || fingerprint.includes('kde'))
            return 'qt';
        return 'gtk3';
    }

    isToolkitEnabled(toolkit) {
        switch (toolkit) {
        case 'gtk3':
            return this._settings.get_boolean('enable-gtk3');
        case 'qt':
            return this._settings.get_boolean('enable-qt');
        case 'electron':
            return this._settings.get_boolean('enable-electron');
        default:
            return true;
        }
    }
}
