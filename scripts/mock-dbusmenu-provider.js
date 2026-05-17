#!/usr/bin/env -S gjs -m

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MODE = ARGV[0] ?? 'normal';
const WINDOW_ID = Number(ARGV[1] ?? 1);
const MENU_SERVICE = 'io.github.notyorch.GlobalIt.MockMenu';
const MENU_PATH = '/io/github/notyorch/GlobalIt/MockMenu';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';

const registrarXml = `
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
  </interface>
</node>`;

const dbusMenuXml = `
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
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
  </interface>
</node>`;

function buildNestedLayout() {
    const fileMenu = new GLib.Variant('(ia{sv}av)', [1, {
        label: new GLib.Variant('s', '_File'),
        enabled: new GLib.Variant('b', true),
    }, [
        new GLib.Variant('(ia{sv}av)', [10, { label: new GLib.Variant('s', '_New') }, []]),
        new GLib.Variant('(ia{sv}av)', [11, { label: new GLib.Variant('s', '_Open…') }, []]),
        new GLib.Variant('(ia{sv}av)', [12, { type: new GLib.Variant('s', 'separator') }, []]),
        new GLib.Variant('(ia{sv}av)', [13, { label: new GLib.Variant('s', '_Recent') }, [
            new GLib.Variant('(ia{sv}av)', [130, { label: new GLib.Variant('s', 'Project A') }, []]),
            new GLib.Variant('(ia{sv}av)', [131, { label: new GLib.Variant('s', 'Project B') }, []]),
        ]]),
    ]]);

    const editMenu = new GLib.Variant('(ia{sv}av)', [2, {
        label: new GLib.Variant('s', '_Edit'),
        enabled: new GLib.Variant('b', true),
    }, [
        new GLib.Variant('(ia{sv}av)', [20, { label: new GLib.Variant('s', '_Undo'), enabled: new GLib.Variant('b', false) }, []]),
        new GLib.Variant('(ia{sv}av)', [21, { label: new GLib.Variant('s', '_Redo'), enabled: new GLib.Variant('b', false) }, []]),
    ]]);

    return [0, { label: new GLib.Variant('s', 'Root') }, [fileMenu, editMenu]];
}

function buildMalformedLayout() {
    return [0, { label: new GLib.Variant('s', 'Root') }, [
        new GLib.Variant('s', 'invalid-child-payload'),
    ]];
}

let revision = 1;
const loop = new GLib.MainLoop(null, false);

let sessionBus = null;
let registrarObjectId = 0;
let dbusMenuObjectId = 0;

const registrarInfo = Gio.DBusNodeInfo.new_for_xml(registrarXml).interfaces[0];
const dbusMenuInfo = Gio.DBusNodeInfo.new_for_xml(dbusMenuXml).interfaces[0];

function onRegistrarCall(_conn, _sender, _path, _iface, method, parameters, invocation) {
    if (method === 'GetMenuForWindow') {
        const [windowId] = parameters.deep_unpack();
        if (MODE === 'missing' || windowId !== WINDOW_ID) {
            invocation.return_value(new GLib.Variant('(so)', ['', '/']));
            return;
        }

        invocation.return_value(new GLib.Variant('(so)', [MENU_SERVICE, MENU_PATH]));
        return;
    }

    if (method === 'GetMenus') {
        if (MODE === 'missing') {
            invocation.return_value(new GLib.Variant('(a(uso))', [[]]));
            return;
        }

        invocation.return_value(new GLib.Variant('(a(uso))', [[[WINDOW_ID, MENU_SERVICE, MENU_PATH]]]));
        return;
    }

    invocation.return_dbus_error('io.github.notyorch.GlobalIt.Error.UnknownMethod', `Unknown method ${method}`);
}

function onDbusMenuCall(connection, _sender, _path, _iface, method, parameters, invocation) {
    if (method === 'GetLayout') {
        if (MODE === 'slow') {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4500, () => {
                const layout = buildNestedLayout();
                invocation.return_value(new GLib.Variant('(u(ia{sv}av))', [revision, layout]));
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const [_parentId, _depth, _props] = parameters.deep_unpack();
        const layout = MODE === 'malformed' ? buildMalformedLayout() : buildNestedLayout();
        invocation.return_value(new GLib.Variant('(u(ia{sv}av))', [revision, layout]));
        return;
    }

    if (method === 'Event') {
        const [id, eventId] = parameters.deep_unpack();
        print(`Mock DBusMenu Event id=${id} event=${eventId}`);
        invocation.return_value(null);

        if (MODE === 'rapid') {
            revision += 1;
            connection.emit_signal(
                null,
                MENU_PATH,
                'com.canonical.dbusmenu',
                'LayoutUpdated',
                new GLib.Variant('(ui)', [revision, 0])
            );
        }
        return;
    }

    invocation.return_dbus_error('io.github.notyorch.GlobalIt.Error.UnknownMethod', `Unknown method ${method}`);
}

function registerObjects() {
    registrarObjectId = sessionBus.register_object(REGISTRAR_PATH, registrarInfo, onRegistrarCall, null, null);
    dbusMenuObjectId = sessionBus.register_object(MENU_PATH, dbusMenuInfo, onDbusMenuCall, null, null);
}

Gio.bus_own_name(
    Gio.BusType.SESSION,
    'com.canonical.AppMenu.Registrar',
    Gio.BusNameOwnerFlags.NONE,
    (_conn) => {
        sessionBus = _conn;
        registerObjects();
    },
    null,
    null
);

Gio.bus_own_name(
    Gio.BusType.SESSION,
    MENU_SERVICE,
    Gio.BusNameOwnerFlags.NONE,
    null,
    null,
    null
);

print(`Mock DBusMenu provider running (mode=${MODE}, windowId=${WINDOW_ID})`);
loop.run();

if (sessionBus) {
    if (registrarObjectId)
        sessionBus.unregister_object(registrarObjectId);
    if (dbusMenuObjectId)
        sessionBus.unregister_object(dbusMenuObjectId);
}
