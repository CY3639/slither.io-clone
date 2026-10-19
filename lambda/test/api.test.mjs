import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler } from '../leaderboard-api/handler.mjs';
import { MemoryStore } from '../lib/memoryStore.mjs';

const quiet = () => {};
const alb = (path, qs = {}) => ({ httpMethod: 'GET', path, queryStringParameters: qs, headers: {} });

test('GET /api/leaderboard returns ranked items with an edge-cacheable header', async () => {
    const store = new MemoryStore();
    store.raiseBest('11111111-2222-4333-8444-555555555555', 'Alice', 40);
    store.raiseBest('22222222-2222-4333-8444-555555555555', 'Bob', 70);
    const res = await createApiHandler({ store, log: quiet })(alb('/api/leaderboard', { limit: '5' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=10');
    const body = JSON.parse(res.body);
    assert.deepEqual(body.items.map((i) => i.displayName), ['Bob', 'Alice']);
});

test('limit is clamped and invalid player ids are rejected', async () => {
    const handler = createApiHandler({ store: new MemoryStore(), log: quiet });
    assert.equal((await handler(alb('/api/leaderboard', { limit: '99999' }))).statusCode, 200);
    assert.equal((await handler(alb('/api/player', { id: '../../etc' }))).statusCode, 400);
    assert.equal((await handler(alb('/api/player', { id: '11111111-2222-4333-8444-555555555555' }))).statusCode, 404);
    assert.equal((await handler(alb('/api/nope'))).statusCode, 404);
    assert.equal((await handler({ ...alb('/api/leaderboard'), httpMethod: 'POST' })).statusCode, 405);
});

test('store failures return 500 without leaking details', async () => {
    const store = { leaderboard: async () => { throw new Error('secret internal detail'); } };
    const res = await createApiHandler({ store, log: quiet })(alb('/api/leaderboard'));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.includes('secret'), false);
});
