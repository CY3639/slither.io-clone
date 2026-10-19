// All runtime configuration comes from environment variables so the same image runs locally,
// in Docker and on ECS. Defaults are the values used in production unless noted.

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`Invalid ${name}=${raw} (expected number in [${min}, ${max}])`);
    }
    return value;
}

function str(name, fallback) {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? fallback : raw;
}

function bool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes'].includes(raw.toLowerCase());
}

export function loadConfig() {
    return {
        port: int('PORT', 8080, { min: 1, max: 65535 }),
        logLevel: str('LOG_LEVEL', 'info'),
        serviceName: str('SERVICE_NAME', 'n5528712-a3-game'),

        world: {
            tickRate: int('TICK_RATE', 30, { min: 5, max: 60 }),
            snapshotRate: int('SNAPSHOT_RATE', 15, { min: 1, max: 60 }),
            totalSnakes: int('TOTAL_SNAKES', 50, { min: 1, max: 200 }),
            maxHumans: int('MAX_HUMANS', 4, { min: 1, max: 50 }),
            lobbyMs: int('LOBBY_MS', 10000, { min: 0, max: 60000 }),
            respawnMs: int('RESPAWN_MS', 3000, { min: 0, max: 60000 }),
            radius: int('WORLD_RADIUS', 2400, { min: 500, max: 20000 }),
            foodTarget: int('FOOD_TARGET', 700, { min: 0, max: 10000 }),
            maxFood: int('MAX_FOOD', 1600, { min: 0, max: 20000 }),
            seed: int('SEED', 0),
        },

        net: {
            maxPayloadBytes: int('WS_MAX_PAYLOAD', 1024, { min: 128, max: 65536 }),
            joinTimeoutMs: int('JOIN_TIMEOUT_MS', 5000, { min: 500, max: 60000 }),
            maxMessagesPerSecond: int('MAX_MSGS_PER_SEC', 40, { min: 5, max: 1000 }),
            heartbeatMs: int('WS_HEARTBEAT_MS', 20000, { min: 1000, max: 120000 }),
            maxBufferedBytes: int('WS_MAX_BUFFERED', 1_000_000, { min: 10_000 }),
        },

        events: {
            sink: str('EVENT_SINK', 'log'), // log | sqs | http
            queueUrl: str('EVENTS_QUEUE_URL', ''),
            httpUrl: str('EVENT_HTTP_URL', ''),
            flushIntervalMs: int('EVENT_FLUSH_MS', 1000, { min: 50 }),
            maxBuffer: int('EVENT_MAX_BUFFER', 5000, { min: 10 }),
            maxRetries: int('EVENT_MAX_RETRIES', 4, { min: 0, max: 10 }),
        },

        metrics: {
            enabled: bool('METRICS_ENABLED', true),
            namespace: str('METRICS_NAMESPACE', 'n5528712/A3Game'),
            intervalMs: int('METRICS_INTERVAL_MS', 10000, { min: 1000 }),
        },

        // HMAC secret used to sign anonymous player IDs. In AWS it is injected from SSM Parameter Store.
        sessionSecret: str('SESSION_SECRET', ''),
        taskProtection: bool('TASK_PROTECTION', Boolean(process.env.ECS_AGENT_URI)),
        shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 8000, { min: 0, max: 60000 }),

        // Local development only: serve the client and proxy /api to tools/local-cloud.mjs.
        staticDir: str('STATIC_DIR', ''),
        localApiUrl: str('LOCAL_API_URL', ''),
        region: str('AWS_REGION', 'ap-southeast-2'),
    };
}
