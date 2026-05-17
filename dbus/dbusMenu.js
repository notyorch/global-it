import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DBUS_MENU_XML = `
<node>
  <interface name="com.canonical.dbusmenu">
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
    <signal name="ItemsPropertiesUpdated">
      <arg type="a(ia{sv})" name="updatedProps"/>
      <arg type="a(ias)" name="removedProps"/>
    </signal>
  </interface>
</node>`;

function newProxyAsync(service, path, interfaceInfo, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            interfaceInfo,
            service,
            path,
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

function unpackVariant(value) {
    return value?.deep_unpack ? value.deep_unpack() : value;
}

function cleanMnemonic(label) {
    if (typeof label !== 'string')
        return '';
    return label.replace(/_/g, '');
}

function parseNode(nodeTuple, logger) {
    try {
        if (!Array.isArray(nodeTuple) || nodeTuple.length < 3)
            return null;

        // DBusMenu layout nodes are (id, properties, children).
        const [id, propertiesRaw, childrenRaw] = nodeTuple;
        if (typeof id !== 'number' || !propertiesRaw || typeof propertiesRaw !== 'object')
            return null;
        const properties = {};
        for (const key in propertiesRaw)
            properties[key] = unpackVariant(propertiesRaw[key]);

        const type = properties.type === 'separator' ? 'separator' : 'item';
        const label = cleanMnemonic(properties.label ?? '');
        const enabled = properties.enabled !== false;
        const visible = properties.visible !== false;
        const iconName = properties['icon-name'] ?? null;

        const children = [];
        if (Array.isArray(childrenRaw)) {
            for (const childTuple of childrenRaw) {
                const parsedChild = parseNode(unpackVariant(childTuple), logger);
                if (parsedChild)
                    children.push(parsedChild);
            }
        }

        return { id, type, label, enabled, visible, iconName, children };
    } catch (error) {
        logger.error(`Failed to parse DBusMenu node: ${error.message}`);
        return null;
    }
}

export function parseLayoutNodeForTests(nodeTuple, logger = { error() {} }) {
    return parseNode(nodeTuple, logger);
}

export class DbusMenuClient {
    constructor(service, path, logger) {
        this._service = service;
        this._path = path;
        this._logger = logger;
        this._proxy = null;
        this._signalIds = [];
        this._layoutChangedHandler = null;
        this._ownerChangedHandler = null;
        this._ownerNotifyId = 0;
        this._lastUsedUs = GLib.get_monotonic_time();
        this._lastParseDurationUs = 0;
    }

    get key() {
        return `${this._service}:${this._path}`;
    }

    async initialize(operation = null) {
        if (this._proxy)
            return;
        const info = Gio.DBusNodeInfo.new_for_xml(DBUS_MENU_XML).interfaces[0];
        this._proxy = await newProxyAsync(this._service, this._path, info, operation?.cancellable ?? null);
        this._signalIds.push(this._proxy.connectSignal('LayoutUpdated', () => {
            try {
                this._layoutChangedHandler?.();
            } catch (error) {
                this._logger.error(`LayoutUpdated handler failed: ${error.message}`);
            }
        }));
        this._signalIds.push(this._proxy.connectSignal('ItemsPropertiesUpdated', () => {
            try {
                this._layoutChangedHandler?.();
            } catch (error) {
                this._logger.error(`ItemsPropertiesUpdated handler failed: ${error.message}`);
            }
        }));
        this._ownerNotifyId = this._proxy.connect('notify::g-name-owner', () => {
            try {
                this._ownerChangedHandler?.(this.hasOwner());
            } catch (error) {
                this._logger.error(`DBusMenu owner-change handler failed: ${error.message}`);
            }
        });
        this.touch();
    }

    setLayoutChangedHandler(callback) {
        this._layoutChangedHandler = callback;
    }

    setOwnerChangedHandler(callback) {
        this._ownerChangedHandler = callback;
    }

    getStats() {
        return {
            key: this.key,
            lastUsedUs: this._lastUsedUs,
            lastParseDurationUs: this._lastParseDurationUs,
            hasProxy: Boolean(this._proxy),
            hasOwner: this.hasOwner(),
        };
    }

    touch() {
        this._lastUsedUs = GLib.get_monotonic_time();
    }

    hasOwner() {
        if (!this._proxy)
            return false;
        return Boolean(this._proxy.get_name_owner?.());
    }

    destroy() {
        if (!this._proxy)
            return;
        for (const id of this._signalIds)
            this._proxy.disconnectSignal(id);
        this._signalIds = [];
        if (this._ownerNotifyId)
            this._proxy.disconnect(this._ownerNotifyId);
        this._ownerNotifyId = 0;
        this._proxy = null;
        this._layoutChangedHandler = null;
        this._ownerChangedHandler = null;
    }

    async getMenuTree(operation = null) {
        if (!this._proxy)
            await this.initialize(operation);
        this.touch();

        const result = await callProxyAsync(
            this._proxy,
            'GetLayout',
            new GLib.Variant('(iias)', [0, -1, []]),
            3000,
            operation?.cancellable ?? null
        );
        const [revision, layout] = result.deep_unpack();
        const parseStartUs = GLib.get_monotonic_time();
        const root = parseNode(layout, this._logger);
        this._lastParseDurationUs = GLib.get_monotonic_time() - parseStartUs;
        this._logger.perf?.(`menu-parse key=${this.key} dur_ms=${(this._lastParseDurationUs / 1000).toFixed(2)}`);
        if (!root) {
            this._logger.debug(`Invalid DBusMenu layout from ${this.key} (rev=${revision})`);
            return null;
        }
        return root;
    }

    async activateItem(itemId, operation = null) {
        if (!this._proxy || typeof itemId !== 'number')
            return;
        this.touch();
        await callProxyAsync(
            this._proxy,
            'Event',
            new GLib.Variant('(isvu)', [itemId, 'clicked', new GLib.Variant('s', ''), 0]),
            1500,
            operation?.cancellable ?? null
        );
    }
}
