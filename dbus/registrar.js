import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const REGISTRAR_XML = `
<node>
  <interface name="com.canonical.AppMenu.Registrar">
    <method name="GetMenuForWindow">
      <arg type="u" name="windowId" direction="in"/>
      <arg type="s" name="service" direction="out"/>
      <arg type="o" name="path" direction="out"/>
    </method>
    <method name="GetMenus">
      <arg type="a(uso)" name="menus" direction="out"/>
    </method>
    <signal name="WindowRegistered">
      <arg type="u" name="windowId"/>
      <arg type="s" name="service"/>
      <arg type="o" name="path"/>
    </signal>
    <signal name="WindowUnregistered">
      <arg type="u" name="windowId"/>
    </signal>
  </interface>
</node>`;

function newProxyAsync(busName, objectPath, interfaceInfo, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            interfaceInfo,
            busName,
            objectPath,
            interfaceInfo.name,
            cancellable,
            (_src, result) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

function callProxyAsync(proxy, methodName, parameters, timeoutMs = 2000, cancellable = null) {
    return new Promise((resolve, reject) => {
        proxy.call(
            methodName,
            parameters,
            Gio.DBusCallFlags.NO_AUTO_START,
            timeoutMs,
            cancellable,
            (_src, result) => {
                try {
                    resolve(proxy.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

export class AppMenuRegistrar {
    constructor(logger) {
        this._logger = logger;
        this._proxy = null;
        this._signalId = 0;
        this._signalId2 = 0;
        this._ownerNotifyId = 0;
        this._changedHandler = null;
    }

    async initialize() {
        if (this._proxy)
            return true;
        try {
            const cancellable = new Gio.Cancellable();
            const info = Gio.DBusNodeInfo.new_for_xml(REGISTRAR_XML).interfaces[0];
            this._proxy = await newProxyAsync('com.canonical.AppMenu.Registrar', '/com/canonical/AppMenu/Registrar', info, cancellable);
            this._signalId = this._proxy.connectSignal('WindowRegistered', () => {
                try {
                    this._changedHandler?.();
                } catch (error) {
                    this._logger.error(`WindowRegistered handler failed: ${error.message}`);
                }
            });
            this._signalId2 = this._proxy.connectSignal('WindowUnregistered', () => {
                try {
                    this._changedHandler?.();
                } catch (error) {
                    this._logger.error(`WindowUnregistered handler failed: ${error.message}`);
                }
            });
            this._ownerNotifyId = this._proxy.connect('notify::g-name-owner', () => {
                try {
                    this._changedHandler?.();
                } catch (error) {
                    this._logger.error(`Registrar owner-change handler failed: ${error.message}`);
                }
            });
            return true;
        } catch (error) {
            this._logger.debug(`Registrar unavailable: ${error.message}`);
            this._proxy = null;
            return false;
        }
    }

    setChangedHandler(callback) {
        this._changedHandler = callback;
    }

    destroy() {
        if (this._proxy && this._signalId)
            this._proxy.disconnectSignal(this._signalId);
        if (this._proxy && this._signalId2)
            this._proxy.disconnectSignal(this._signalId2);
        if (this._proxy && this._ownerNotifyId)
            this._proxy.disconnect(this._ownerNotifyId);
        this._signalId = 0;
        this._signalId2 = 0;
        this._ownerNotifyId = 0;
        this._proxy = null;
        this._changedHandler = null;
    }

    async lookupWindow(window, operation = null) {
        if (!this._proxy || !window)
            return null;
        if (!this._proxy.get_name_owner?.())
            return null;

        const windowId = this._getWindowId(window);
        if (windowId === 0)
            return null;

        try {
            const result = await callProxyAsync(
                this._proxy,
                'GetMenuForWindow',
                new GLib.Variant('(u)', [windowId]),
                2000,
                operation?.cancellable ?? null
            );
            const [service, path] = result.deep_unpack();
            if (!service || !path || !path.startsWith('/'))
                return null;
            return { service, path, windowId };
        } catch (error) {
            if (operation?.isCancelled?.())
                return null;
            this._logger.debug(`GetMenuForWindow failed for ${windowId}: ${error.message}`);
            return this._findWindowInMenuList(windowId, operation);
        }
    }

    async _findWindowInMenuList(windowId, operation = null) {
        if (!this._proxy)
            return null;
        try {
            const result = await callProxyAsync(this._proxy, 'GetMenus', null, 2000, operation?.cancellable ?? null);
            const [menus] = result.deep_unpack();
            for (const entry of menus) {
                if (!Array.isArray(entry) || entry.length < 3)
                    continue;
                const [entryWindowId, service, path] = entry;
                if (entryWindowId === windowId && service && path)
                    return { service, path, windowId };
            }
        } catch (error) {
            if (operation?.isCancelled?.())
                return null;
            this._logger.debug(`GetMenus fallback failed: ${error.message}`);
        }
        return null;
    }

    _getWindowId(window) {
        if (!window)
            return 0;
        if (typeof window.get_id === 'function')
            return window.get_id() >>> 0;
        return 0;
    }
}
