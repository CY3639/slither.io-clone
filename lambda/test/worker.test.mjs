import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../event-worker/handler.mjs';
import { MemoryStore } from '../lib/memoryStore.mjs';
import { parseEvent } from '../lib/validate.mjs';

const quiet = () => {};
const PLAYER = '11111111-2222-4333-8444-555555555555';

function died(score, overrides = {}) {
    return {
        eventId: randomUUID(),
        type: 'PLAYER_DIED',
        version: 1,
        occurredAt: new Date().toISOString(),
        worldId: 'task0001-1',
        taskId: 'task0001',
        payload: { playerId: PLAYER, displayName: 'Alice', score, length: 31 + score, kills: 1, killedBy: { type: 'snake', name: 'Viper' }, survivedMs: 5000 },
        ...overrides,
    };
}

function sqsEvent(...bodies) {
    return {
        Records: bodies.map((b, i) => ({
            messageId: `m${i}`,
            body: typeof b === 'string' ? b : JSON.stringify(b),
            attributes: { ApproximateReceiveCount: '1' },
        })),
    };
}

test('applies PLAYER_DIED: deaths, kills and best score; leaderboard sorted by best score', async () => {
    const store = new MemoryStore();
    const handler = createHandler({ store, log: quiet });
    const res = await handler(sqsEvent(died(12), died(30), died(5)));
    assert.deepEqual(res.batchItemFailures, []);
    const p = await store.player(PLAYER);
    assert.equal(p.deaths, 3);
    assert.equal(p.kills, 3);
    assert.equal(p.bestScore, 30, 'best score is the maximum, not the latest');
    const lb = await store.leaderboard(10);
    assert.equal(lb[0].bestScore, 30);
});

test('duplicate delivery of the same eventId is applied once (idempotent consumer)', async () => {
    const store = new MemoryStore();
    const handler = createHandler({ store, log: quiet });
    const evt = died(20);
    await handler(sqsEvent(evt));
    await handler(sqsEvent(evt)); // SQS at-least-once redelivery
    await handler(sqsEvent(evt, evt)); // duplicate inside one batch
    const p = await store.player(PLAYER);
    assert.equal(p.deaths, 1);
    assert.equal(store.deaths.length, 1);
});

test('malformed and unknown messages fail only their own record (partial batch response)', async () => {
    const store = new MemoryStore();
    const handler = createHandler({ store, log: quiet });
    const good = died(7);
    const res = await handler(
        sqsEvent(
            good,
            'not json at all',
            { ...died(1), type: 'DELETE_EVERYTHING' },
            died(-5),
            { ...died(3), payload: { ...died(3).payload, displayName: '' } },
        ),
    );
    assert.deepEqual(res.batchItemFailures.map((f) => f.itemIdentifier), ['m1', 'm2', 'm3', 'm4']);
    assert.equal((await store.player(PLAYER)).deaths, 1, 'the valid record was still applied');
});

test('transient store errors are reported as failures so SQS retries them', async () => {
    const store = new MemoryStore();
    store.failNext = 1;
    const handler = createHandler({ store, log: quiet });
    const evt = died(9);
    const first = await handler(sqsEvent(evt));
    assert.equal(first.batchItemFailures.length, 1);
    const retry = await handler(sqsEvent(evt));
    assert.equal(retry.batchItemFailures.length, 0);
    assert.equal((await store.player(PLAYER)).deaths, 1);
});

test('world events commute regardless of arrival order', async () => {
    const store = new MemoryStore();
    const handler = createHandler({ store, log: quiet });
    const base = { version: 1, occurredAt: new Date().toISOString(), worldId: 'abc-2', taskId: 'abc' };
    await handler(sqsEvent({ ...base, eventId: randomUUID(), type: 'WORLD_COMPLETED', payload: { durationMs: 60000, peakHumans: 3, humanDeaths: 2, reason: 'empty' } }));
    await handler(sqsEvent({ ...base, eventId: randomUUID(), type: 'WORLD_STARTED', payload: { humans: 1, npcs: 49, lobbyWaitMs: 10000, reason: 'timer' } }));
    const w = store.worlds.get('abc-2');
    assert.equal(w.durationMs, 60000);
    assert.equal(w.startNpcs, 49);
});

test('validation rejects missing eventId, bad version and out-of-range values', () => {
    assert.throws(() => parseEvent(JSON.stringify({ ...died(1), eventId: 'x' })), /eventId/);
    assert.throws(() => parseEvent(JSON.stringify({ ...died(1), version: 2 })), /version/);
    assert.throws(() => parseEvent(JSON.stringify(died(5_000_000))), /score/);
    assert.equal(parseEvent(JSON.stringify(died(5))).type, 'PLAYER_DIED');
});
