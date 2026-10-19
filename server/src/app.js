import { randomBytes } from 'node:crypto';
import { Room } from './game/room.js';
import { createGameServer } from './net/gameServer.js';
import { createSessionTokens } from './net/sessionToken.js';
import { EventPublisher } from './events/publisher.js';
import { createSink } from './events/sinks.js';
import { Metrics } from './metrics.js';
import { createTaskProtection, resolveIdentity } from './aws/ecs.js';
import { createLogger } from './util/logger.js';

/** Read the shared signing secret from Secrets Manager. On failure the caller falls back to a
 *  per-process secret: the game still works, but player IDs don't carry across tasks. */
async function fetchSecret(arn, region, logger) {
    try {
        const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
        const client = new SecretsManagerClient({ region, maxAttempts: 3 });
        const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
        logger.info('session_secret_loaded', { source: 'secretsmanager' });
        return out.SecretString;
    } catch (err) {
        logger.error('session_secret_unavailable', { err });
        return '';
    }
}

/**
 * Wire everything together. Used by index.js and by the integration tests (which pass a
 * different config, a silent logger and an in-memory sink).
 */
export async function createApp(config, { logger: baseLogger, sink: sinkOverride, identity: identityOverride } = {}) {
    const bootLogger = baseLogger ?? createLogger({ level: config.logLevel, base: { service: 'game' } });
    const identity = identityOverride ?? (await resolveIdentity(bootLogger));
    const logger = bootLogger.child({ taskId: identity.taskShort });

    let secret = config.sessionSecret;
    if (!secret && config.sessionSecretArn) secret = await fetchSecret(config.sessionSecretArn, config.region, logger);
    if (!secret) {
        // Fine for local runs; in AWS the secret comes from SSM so all tasks agree on player IDs.
        secret = randomBytes(32).toString('hex');
        logger.warn('session_secret_generated', { note: 'SESSION_SECRET not set; player IDs only valid on this process' });
    }

    const sink = sinkOverride ?? (await createSink(config.events, { logger, region: config.region }));
    let room; // assigned below; metrics sampling needs it
    let lastTickAt = Date.now();
    let connections = () => 0;

    const metrics = new Metrics({
        ...config.metrics,
        serviceName: config.serviceName,
        logger,
        sample: () => ({
            ...room.stats(),
            active: room.active,
            connections: connections(),
            taskId: identity.taskShort,
        }),
    });

    const publisher = new EventPublisher({
        sink,
        logger,
        identity,
        flushIntervalMs: config.events.flushIntervalMs,
        maxBuffer: config.events.maxBuffer,
        maxRetries: config.events.maxRetries,
        metrics,
    });
    const protection = createTaskProtection({ enabled: config.taskProtection, logger });

    room = new Room({
        config: config.world,
        publisher,
        logger,
        metrics,
        tokens: createSessionTokens(secret),
        identity,
        onActiveChange: (active) => protection.set(active),
    });

    const server = createGameServer({ config, room, logger, identity, getLastTickAt: () => lastTickAt });
    connections = () => server.connections.size;

    // Fixed-timestep loop with drift correction: ticks are scheduled against absolute target
    // times, so a slow tick shortens the next delay instead of permanently lagging.
    const intervalMs = 1000 / config.world.tickRate;
    let nextAt = performance.now();
    let loopTimer = null;
    let running = false;
    function loop() {
        if (!running) return;
        const started = performance.now();
        try {
            room.tick();
        } catch (err) {
            logger.error('tick_failed', { err, stack: err.stack });
        }
        if (room.state === 'running') metrics.recordTick(performance.now() - started);
        lastTickAt = Date.now();
        nextAt += intervalMs;
        const now = performance.now();
        if (now - nextAt > 1000) nextAt = now; // fell far behind (e.g. process paused): resync
        loopTimer = setTimeout(loop, Math.max(0, nextAt - now));
    }

    return {
        config,
        identity,
        room,
        server,
        publisher,
        metrics,
        logger,
        async start(port = config.port) {
            running = true;
            nextAt = performance.now();
            loop();
            publisher.start();
            metrics.start();
            const boundPort = await server.listen(port);
            logger.info('server_started', { port: boundPort, sink: sink.name, tickRate: config.world.tickRate, az: identity.az });
            return boundPort;
        },
        /** Graceful shutdown: drain players, stop the loop, flush events, release protection. */
        async stop(reason = 'shutdown') {
            logger.info('shutdown_started', { reason, humans: room.humanCount });
            room.drain();
            running = false;
            clearTimeout(loopTimer);
            await server.close();
            const flush = await publisher.close(Math.max(1000, config.shutdownGraceMs - 2000));
            metrics.stop();
            metrics.emit();
            await protection.release();
            logger.info('shutdown_complete', { reason, eventFlush: flush, published: publisher.published, dropped: publisher.dropped });
        },
    };
}
