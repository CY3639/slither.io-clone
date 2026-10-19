// Structured JSON logger. One JSON object per line so CloudWatch Logs Insights can filter on
// worldId / playerId / taskId / event without parsing free text.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', base = {}, write = (line) => process.stdout.write(line + '\n') } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;

    function emit(lvl, msg, fields) {
        if (LEVELS[lvl] < threshold) return;
        const entry = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
        if (fields && fields.err instanceof Error) {
            entry.err = { name: fields.err.name, message: fields.err.message, code: fields.err.code };
        }
        write(JSON.stringify(entry));
    }

    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
        child: (extra) => createLogger({ level, base: { ...base, ...extra }, write }),
        // Raw line output, used for CloudWatch Embedded Metric Format records.
        raw: (obj) => write(JSON.stringify(obj)),
    };
}

export const silentLogger = createLogger({ level: 'silent' });
