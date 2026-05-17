import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { DbusMenuClient } from './dbusMenu.js';
import { AppMenuRegistrar } from './registrar.js';

function withTimeout(promise, timeoutMs, message, onTimeout = null) {
    return new Promise((resolve, reject) => {
        let sourceId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            sourceId = 0;
            try {
                onTimeout?.();
            } catch (_error) {
                // Ignore timeout callback failures.
            }
            reject(new Error(message));
            return GLib.SOURCE_REMOVE;
        });

        promise.then(value => {
            if (sourceId)
                GLib.Source.remove(sourceId);
            resolve(value);
        }).catch(error => {
            if (sourceId)
                GLib.Source.remove(sourceId);
            reject(error);
        });
    });
}

function nowUs() {
    return GLib.get_monotonic_time();
}

export class DbusMenuBackend {
    constructor(logger, options = {}) {
        this._logger = logger;
        this._registrar = options.registrar ?? new AppMenuRegistrar(this._logger);
        this._clientFactory = options.clientFactory ?? ((service, path) =>
            new DbusMenuClient(service, path, this._logger));
        this._lookupTimeoutMs = options.lookupTimeoutMs ?? 1600;
        this._layoutTimeoutMs = options.layoutTimeoutMs ?? 2400;
        this._eventTimeoutMs = options.eventTimeoutMs ?? 1200;
        this._layoutUpdateThrottleMs = options.layoutUpdateThrottleMs ?? 80;
        this._clientMaxIdleUs = (options.clientMaxIdleMs ?? 60000) * 1000;
        this._clientGcIntervalMs = options.clientGcIntervalMs ?? 15000;
        this._clients = new Map();
        this._activeClient = null;
        this._menuChangedHandler = null;
        this._requestGeneration = 0;
        this._layoutUpdateTimeoutId = 0;
        this._destroyed = false;
        this._gcSourceId = 0;
        this._registrarRetryTimeoutId = 0;
        this._registrarRetryDelayMs = options.registrarRetryDelayMs ?? 1000;
        this._registrarRetryDelayMaxMs = options.registrarRetryDelayMaxMs ?? 10000;
        this._currentRegistrarRetryDelayMs = this._registrarRetryDelayMs;
        this._activeOperation = null;
        this._perf = {
            lookupMs: 0,
            initMs: 0,
            layoutMs: 0,
            eventMs: 0,
        };
    }

    async initialize() {
        this._registrar.setChangedHandler(() => this._menuChangedHandler?.());
        await this._ensureRegistrarInitialized();
        this._gcSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._clientGcIntervalMs,
            () => {
                this._pruneClients();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    destroy() {
        this._destroyed = true;
        this._cancelOperation();
        if (this._layoutUpdateTimeoutId) {
            GLib.Source.remove(this._layoutUpdateTimeoutId);
            this._layoutUpdateTimeoutId = 0;
        }
        if (this._registrarRetryTimeoutId) {
            GLib.Source.remove(this._registrarRetryTimeoutId);
            this._registrarRetryTimeoutId = 0;
        }
        if (this._gcSourceId) {
            GLib.Source.remove(this._gcSourceId);
            this._gcSourceId = 0;
        }
        this.clearActiveClient();
        this._registrar.destroy();
        for (const client of this._clients.values())
            client.destroy();
        this._clients.clear();
        this._menuChangedHandler = null;
        this._activeClient = null;
    }

    setMenuChangedHandler(callback) {
        this._menuChangedHandler = callback;
    }

    async _ensureRegistrarInitialized() {
        if (this._destroyed)
            return false;

        const ready = await this._registrar.initialize();
        if (this._destroyed)
            return false;

        if (ready) {
            if (this._registrarRetryTimeoutId) {
                GLib.Source.remove(this._registrarRetryTimeoutId);
                this._registrarRetryTimeoutId = 0;
            }
            this._currentRegistrarRetryDelayMs = this._registrarRetryDelayMs;
            this._menuChangedHandler?.();
            return true;
        }

        this._scheduleRegistrarRetry();
        return false;
    }

    _scheduleRegistrarRetry() {
        if (this._destroyed || this._registrarRetryTimeoutId)
            return;

        const delayMs = this._currentRegistrarRetryDelayMs;
        this._registrarRetryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._registrarRetryTimeoutId = 0;
            this._ensureRegistrarInitialized().catch(error => {
                this._logger.error(`Registrar retry failed: ${error.message}`);
            });
            return GLib.SOURCE_REMOVE;
        });
        this._currentRegistrarRetryDelayMs = Math.min(this._currentRegistrarRetryDelayMs * 2, this._registrarRetryDelayMaxMs);
    }

    clearActiveClient() {
        this._cancelOperation();
        this._requestGeneration++;
        this._activeClient = null;
    }

    getMemoryEstimate() {
        const baseBytes = 4096;
        const perClientBytes = 6144;
        return baseBytes + this._clients.size * perClientBytes;
    }

    getPerfSnapshot() {
        return {
            ...this._perf,
            clients: this._clients.size,
            memoryBytes: this.getMemoryEstimate(),
        };
    }

    async setActiveWindow(window) {
        if (this._destroyed)
            return null;
        this._cancelOperation();
        const operation = this._createOperation();
        this._activeOperation = operation;
        const generation = ++this._requestGeneration;
        this._pruneClients();

        let menuAddress = null;
        try {
            const lookupStartUs = nowUs();
            menuAddress = await withTimeout(
                this._registrar.lookupWindow(window, operation),
                this._lookupTimeoutMs,
                'Registrar lookup timed out',
                () => operation.cancel()
            );
            if (operation.isCancelled())
                return null;
            this._perf.lookupMs = (nowUs() - lookupStartUs) / 1000;
            this._logger.perf?.(`dbus-latency op=registrar-lookup ms=${this._perf.lookupMs.toFixed(2)}`);
        } catch (error) {
            if (operation.isCancelled())
                return null;
            if (generation === this._requestGeneration)
                this._logger.debug(`Registrar lookup failed: ${error.message}`);
        }

        if (generation !== this._requestGeneration) {
            return null;
        }

        if (!menuAddress) {
            this._activeClient = null;
            return null;
        }

        const key = `${menuAddress.service}:${menuAddress.path}`;
        let client = this._clients.get(key);
        if (!client) {
            client = this._clientFactory(menuAddress.service, menuAddress.path);
            client.setLayoutChangedHandler(() => {
                if (this._activeClient === client)
                    this._queueMenuChanged('layout-update');
            });
            client.setOwnerChangedHandler?.(hasOwner => {
                try {
                    if (hasOwner)
                        return;
                    if (this._activeClient === client) {
                        this._activeClient = null;
                        this._queueMenuChanged('owner-lost');
                    }
                } catch (error) {
                    this._logger.error(`Owner-changed handler failed: ${error.message}`);
                }
            });
            this._clients.set(key, client);
        }

        try {
            const initStartUs = nowUs();
            await withTimeout(
                client.initialize(operation),
                this._lookupTimeoutMs,
                'DBusMenu client init timed out',
                () => operation.cancel()
            );
            if (operation.isCancelled())
                return null;
            this._perf.initMs = (nowUs() - initStartUs) / 1000;
            this._logger.perf?.(`dbus-latency op=client-init ms=${this._perf.initMs.toFixed(2)}`);
        } catch (error) {
            if (operation.isCancelled())
                return null;
            if (generation === this._requestGeneration)
                this._logger.debug(`Menu client init failed: ${error.message}`);
            this._activeClient = null;
            return null;
        }

        if (generation !== this._requestGeneration)
            return null;

        this._activeClient = client;
        try {
            const layoutStartUs = nowUs();
            const tree = await withTimeout(
                client.getMenuTree(operation),
                this._layoutTimeoutMs,
                'DBusMenu GetLayout timed out',
                () => operation.cancel()
            );
            if (operation.isCancelled())
                return null;
            this._perf.layoutMs = (nowUs() - layoutStartUs) / 1000;
            this._logger.perf?.(`dbus-latency op=get-layout ms=${this._perf.layoutMs.toFixed(2)}`);
            return tree;
        } catch (error) {
            if (operation.isCancelled())
                return null;
            if (generation === this._requestGeneration)
                this._logger.debug(`Menu layout load failed: ${error.message}`);
            return null;
        } finally {
            if (this._activeOperation === operation)
                this._activeOperation = null;
        }
    }

    async activateItem(itemId) {
        if (!this._activeClient)
            return;
        const operation = this._createOperation();
        try {
            const eventStartUs = nowUs();
            await withTimeout(
                this._activeClient.activateItem(itemId, operation),
                this._eventTimeoutMs,
                'DBusMenu Event timed out',
                () => operation.cancel()
            );
            if (operation.isCancelled())
                return;
            this._perf.eventMs = (nowUs() - eventStartUs) / 1000;
            this._logger.perf?.(`dbus-latency op=event ms=${this._perf.eventMs.toFixed(2)}`);
        } catch (error) {
            if (operation.isCancelled())
                return;
            this._logger.debug(`Menu item activation failed: ${error.message}`);
        } finally {
            operation.cancel();
        }
    }

    _queueMenuChanged(reason) {
        if (this._destroyed)
            return;
        if (this._layoutUpdateTimeoutId)
            return;
        this._layoutUpdateTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._layoutUpdateThrottleMs,
            () => {
                this._layoutUpdateTimeoutId = 0;
                this._logger.perf?.(`layout-update-throttle reason=${reason}`);
                try {
                    this._menuChangedHandler?.();
                } catch (error) {
                    this._logger.error(`Menu-changed handler failed: ${error.message}`);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _pruneClients() {
        if (this._destroyed)
            return;
        const now = nowUs();
        for (const [key, client] of this._clients.entries()) {
            const stats = client.getStats?.() ?? null;
            if (!stats)
                continue;

            const idleUs = now - stats.lastUsedUs;
            const staleByOwner = !stats.hasOwner;
            const staleByIdle = idleUs > this._clientMaxIdleUs;
            if (!staleByOwner && !staleByIdle)
                continue;

            if (this._activeClient === client)
                this._activeClient = null;
            client.destroy();
            this._clients.delete(key);
            this._logger.perf?.(`client-prune key=${key} reason=${staleByOwner ? 'no-owner' : 'idle'}`);
        }
    }

    _createOperation() {
        let cancelled = false;
        const cancellable = new Gio.Cancellable();
        return {
            cancellable,
            cancel() {
                if (cancelled)
                    return;
                cancelled = true;
                try {
                    cancellable.cancel();
                } catch (_error) {
                    // Ignore cancellation races.
                }
            },
            isCancelled() {
                return cancelled || cancellable.is_cancelled();
            },
        };
    }

    _cancelOperation() {
        if (!this._activeOperation)
            return;
        this._activeOperation.cancel();
        this._activeOperation = null;
    }
}
