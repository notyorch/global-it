#!/usr/bin/env gjs -m

import GLib from 'gi://GLib';

import { DbusMenuBackend } from '../dbus/backend.js';
import { parseLayoutNodeForTests } from '../dbus/dbusMenu.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function logger() {
    return {
        debug(_message) {},
        error(_message) {},
    };
}

function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

class FakeClient {
    constructor(treeFactory) {
        this._treeFactory = treeFactory;
        this._layoutChangedHandler = null;
        this._ownerChangedHandler = null;
        this._destroyed = false;
    }

    setLayoutChangedHandler(callback) {
        this._layoutChangedHandler = callback;
    }
    setOwnerChangedHandler(callback) {
        this._ownerChangedHandler = callback;
    }
    async initialize() {}
    destroy() {
        this._destroyed = true;
    }

    async getMenuTree() {
        return this._treeFactory();
    }

    async activateItem(_itemId) {}

    emitRapidUpdate() {
        this._layoutChangedHandler?.();
    }

    crashExporter() {
        this._ownerChangedHandler?.(false);
    }
}

class FakeRegistrar {
    constructor(handler) {
        this._handler = handler;
    }

    setChangedHandler(_callback) {}
    async initialize() {}
    destroy() {}
    async lookupWindow(window) {
        return this._handler(window);
    }
}

class DelayedRegistrar {
    constructor(readyAfterAttempts, handler) {
        this._readyAfterAttempts = readyAfterAttempts;
        this._handler = handler;
        this._attempts = 0;
        this.changedCount = 0;
    }

    setChangedHandler(callback) {
        this._changedHandler = callback;
    }

    async initialize() {
        this._attempts++;
        if (this._attempts < this._readyAfterAttempts)
            return false;
        this._changedHandler?.();
        return true;
    }

    destroy() {}

    async lookupWindow(window) {
        return this._handler(window);
    }
}

async function testMalformedPayloadHandling() {
    const malformed = ['bad', null, []];
    const parsed = parseLayoutNodeForTests(malformed, logger());
    assert(parsed === null, 'Malformed payload should be ignored safely');
}

async function testMissingMenuExporter() {
    const backend = new DbusMenuBackend(logger(), {
        registrar: new FakeRegistrar(() => null),
    });
    await backend.initialize();
    const result = await backend.setActiveWindow({ id: 1 });
    assert(result === null, 'Missing exporter should return null without throwing');
    backend.destroy();
}

async function testFocusSwitchingAndRapidWindowChanges() {
    const trees = {
        a: { id: 0, children: [{ id: 1, label: 'File', children: [] }] },
        b: { id: 0, children: [{ id: 2, label: 'Edit', children: [] }] },
    };

    const backend = new DbusMenuBackend(logger(), {
        registrar: new FakeRegistrar(window => {
            if (window.name === 'A')
                return { service: 'a', path: '/a', windowId: 1 };
            if (window.name === 'B')
                return { service: 'b', path: '/b', windowId: 2 };
            return null;
        }),
        clientFactory: (service, _path) => new FakeClient(async () => {
            await delay(30);
            return service === 'a' ? trees.a : trees.b;
        }),
        lookupTimeoutMs: 200,
        layoutTimeoutMs: 400,
    });
    await backend.initialize();

    const first = backend.setActiveWindow({ name: 'A' });
    const second = backend.setActiveWindow({ name: 'B' });
    await Promise.all([first, second]);
    const resultB = await backend.setActiveWindow({ name: 'B' });
    assert(resultB?.children?.[0]?.label === 'Edit', 'Latest focus window should win');

    for (let i = 0; i < 10; i++)
        await backend.setActiveWindow({ name: i % 2 === 0 ? 'A' : 'B' });

    backend.destroy();
}

async function testTimeoutProtection() {
    const backend = new DbusMenuBackend(logger(), {
        registrar: new FakeRegistrar(() => ({ service: 'slow', path: '/slow', windowId: 1 })),
        clientFactory: () => new FakeClient(() => new Promise(() => {})),
        layoutTimeoutMs: 120,
    });
    await backend.initialize();

    const started = GLib.get_monotonic_time();
    const result = await backend.setActiveWindow({ name: 'Slow' });
    const elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
    assert(result === null, 'Timed out DBus call should degrade to null result');
    assert(elapsedMs < 1000, 'Timeout must keep shell-side code responsive');
    backend.destroy();
}

async function testDelayedRegistrarRecovery() {
    const backend = new DbusMenuBackend(logger(), {
        registrar: new DelayedRegistrar(3, window => {
            if (window?.name !== 'Ready')
                return null;
            return { service: 'ready', path: '/ready', windowId: 1 };
        }),
        clientFactory: () => new FakeClient(() => ({ id: 0, children: [{ id: 1, label: 'Ready', children: [] }] })),
        registrarRetryDelayMs: 20,
        registrarRetryDelayMaxMs: 20,
    });

    let refreshCount = 0;
    backend.setMenuChangedHandler(() => {
        refreshCount++;
    });

    await backend.initialize();
    await delay(90);
    const result = await backend.setActiveWindow({ name: 'Ready' });

    assert(refreshCount > 0, 'Registrar recovery should trigger a refresh callback');
    assert(result?.children?.[0]?.label === 'Ready', 'Registrar recovery should eventually load the menu');
    backend.destroy();
}

async function testEnableDisableCycles() {
    for (let i = 0; i < 12; i++) {
        const backend = new DbusMenuBackend(logger(), {
            registrar: new FakeRegistrar(() => null),
        });
        await backend.initialize();
        await backend.setActiveWindow({ name: `cycle-${i}` });
        backend.destroy();
    }
}

async function testStressModeSimulation() {
    const clients = new Map();
    const backend = new DbusMenuBackend(logger(), {
        registrar: new FakeRegistrar(window => {
            if (!window || typeof window.id !== 'number')
                return null;
            return { service: `svc${window.id % 3}`, path: `/menu/${window.id % 3}`, windowId: window.id };
        }),
        clientFactory: (service) => {
            const client = new FakeClient(() => {
                if (service === 'svc1')
                    return { malformed: true };
                return { id: 0, children: [{ id: 1, label: service, children: [] }] };
            });
            clients.set(service, client);
            return client;
        },
        layoutUpdateThrottleMs: 5,
        clientGcIntervalMs: 20,
        clientMaxIdleMs: 40,
    });
    await backend.initialize();

    for (let i = 0; i < 100; i++)
        await backend.setActiveWindow({ id: i + 1 });

    for (let i = 0; i < 20; i++)
        clients.get('svc0')?.emitRapidUpdate();

    clients.get('svc2')?.crashExporter();
    const afterCrash = await backend.setActiveWindow({ id: 102 });
    assert(afterCrash === null || typeof afterCrash === 'object', 'Crash simulation should not throw');
    backend.destroy();
}

async function run() {
    await testMalformedPayloadHandling();
    await testMissingMenuExporter();
    await testFocusSwitchingAndRapidWindowChanges();
    await testTimeoutProtection();
    await testDelayedRegistrarRecovery();
    await testEnableDisableCycles();
    await testStressModeSimulation();
    print('Smoke tests passed');
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;

run().then(() => {
    print('Smoke tests passed');
    loop.quit();
}).catch(error => {
    printerr(`Smoke tests failed: ${error.message}`);
    exitCode = 1;
    loop.quit();
});

loop.run();
imports.system.exit(exitCode);
