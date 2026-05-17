export function createLogger(prefix, isDebugEnabled, isPerfEnabled = () => false) {
    function safeToString(value) {
        try {
            if (typeof value === 'string')
                return value;
            if (value instanceof Error)
                return value.message;
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    function safeConsole(method, message) {
        try {
            console[method]?.(message);
        } catch (_error) {
            // Never let logging crash GNOME Shell extension code paths.
        }
    }

    return {
        debug(message) {
            if (!isDebugEnabled())
                return;
            safeConsole('log', `[${prefix}] ${safeToString(message)}`);
        },
        perf(message) {
            if (!isPerfEnabled())
                return;
            safeConsole('log', `[${prefix}] PERF ${safeToString(message)}`);
        },
        error(message) {
            safeConsole('error', `[${prefix}] ${safeToString(message)}`);
        },
    };
}
