import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventPublisher } from '../src/events/publisher.js';
import { createLogger } from '../src/util/logger.js';

function capturingLogger() {
    const lines = [];
    return { logger: createLogger({ level: 'info', write: (l) => lines.push(JSON.parse(l)) }), lines };
}

const identity = { taskShort: 'task0001' };

test('publishes envelopes with unique eventIds in batches of at most 10', async () => {
    const batches = [];
    const sink = { sendBatch: async (events) => (batches.push(events), []) };
    const { logger } = capturingLogger();
    const pub = new EventPublisher({ sink, logger, identity });
    for (let i = 0; i < 23; i++) pub.publish('PLAYER_DIED', { playerId: 'p', score: i }, { worldId: 'w1' });
    await pub.flush();
    assert.deepEqual(batches.map((b) => b.length), [10, 10, 3]);
    const ids = new Set(batches.flat().map((e) => e.eventId));
    assert.equal(ids.size, 23);
    const e = batches[0][0];
    assert.equal(e.type, 'PLAYER_DIED');
    assert.equal(e.worldId, 'w1');
    assert.equal(e.taskId, 'task0001');
    assert.equal(e.version, 1);
});

test('retries only the failed entries with backoff, then succeeds', async () => {
    let calls = 0;
    const seen = [];
    const sink = {
        sendBatch: async (events) => {
            calls++;
            seen.push(events.map((e) => e.payload.n));
            return calls === 1 ? [events[1].eventId] : [];
        },
    };
    const { logger } = capturingLogger();
    const pub = new EventPublisher({ sink, logger, identity, baseDelayMs: 1 });
    pub.publish('X', { n: 0 });
    pub.publish('X', { n: 1 });
    pub.publish('X', { n: 2 });
    await pub.flush();
    assert.deepEqual(seen, [[0, 1, 2], [1]]);
    assert.equal(pub.published, 3);
    assert.equal(pub.dropped, 0);
});

test('gives up after maxRetries and logs the full event (bounded retry, no infinite loop)', async () => {
    let calls = 0;
    const sink = {
        sendBatch: async () => {
            calls++;
            throw new Error('SQS unavailable');
        },
    };
    const { logger, lines } = capturingLogger();
    const pub = new EventPublisher({ sink, logger, identity, baseDelayMs: 1, maxRetries: 3 });
    const evt = pub.publish('PLAYER_DIED', { playerId: 'p1' });
    await pub.flush();
    assert.equal(calls, 4, 'initial attempt + 3 retries');
    assert.equal(pub.dropped, 1);
    const dropped = lines.find((l) => l.msg === 'event_dropped');
    assert.equal(dropped.event.eventId, evt.eventId, 'dropped event is recoverable from logs');
});

test('bounded buffer drops the oldest event when full', () => {
    const sink = { sendBatch: async () => [] };
    const { logger } = capturingLogger();
    const pub = new EventPublisher({ sink, logger, identity, maxBuffer: 3 });
    for (let i = 0; i < 5; i++) pub.publish('X', { n: i });
    assert.deepEqual(pub.buffer.map((b) => b.event.payload.n), [2, 3, 4]);
    assert.equal(pub.dropped, 2);
});

test('close() flushes pending events before shutdown', async () => {
    const sent = [];
    const sink = { sendBatch: async (events) => (sent.push(...events), []) };
    const { logger } = capturingLogger();
    const pub = new EventPublisher({ sink, logger, identity });
    pub.start();
    pub.publish('WORLD_COMPLETED', { reason: 'shutdown' });
    assert.equal(await pub.close(1000), 'flushed');
    assert.equal(sent.length, 1);
});
