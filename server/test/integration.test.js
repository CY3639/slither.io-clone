import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { silentLogger } from '../src/util/logger.js';

let app;
let port;
const sent = [];

before(async () => {
    const config = loadConfig();
    config.world.lobbyMs = 600;
    config.world.respawnMs = 300;
    config.metrics.enabled = false;
    config.sessionSecret = 'integration-secret';
    config.taskProtection = false;
    app = await createApp(config, {
        logger: silentLogger,
        identity: { taskId: 'itest', taskShort: 'itest' },
        sink: { name: 'memory', sendBatch: async (events) => (sent.push(...events), []) },
    });
    port = await app.start(0);
});

after(async () => {
    if (app) await app.stop('test');
});

/** Minimal test client that records messages and can wait for a predicate. */
function client() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    const waiters = [];
    let closeInfo = null;
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        for (const w of [...waiters]) if (w.pred(msg)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(msg);
        }
    });
    ws.on('close', (code, reason) => {
        closeInfo = { code, reason: reason.toString() };
        for (const w of waiters) if (w.onClose) w.resolve(closeInfo);
    });
    return {
        ws,
        messages,
        open: () => new Promise((resolve, reject) => (ws.readyState === WebSocket.OPEN ? resolve() : (ws.once('open', resolve), ws.once('error', reject)))),
        send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
        waitFor: (pred, timeoutMs = 3000) =>
            new Promise((resolve, reject) => {
                const found = messages.find(pred);
                if (found) return resolve(found);
                const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
                waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
            }),
        waitClose: (timeoutMs = 3000) =>
            new Promise((resolve, reject) => {
                if (closeInfo) return resolve(closeInfo);
                const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
                waiters.push({ pred: () => false, onClose: true, resolve: (c) => (clearTimeout(timer), resolve(c)) });
            }),
        close: () => ws.close(),
    };
}

test('health and readiness endpoints respond', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    assert.equal(ready.status, 200);
});

test('two clients share one authoritative world with 50 snakes; ROOM_FULL for a 5th; malformed input rejected', async () => {
    const a = client();
    const b = client();
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'join', name: 'Alice', vw: 1600, vh: 900 });
    b.send({ t: 'join', name: 'Bob', vw: 1600, vh: 900 });

    const lobby = await a.waitFor((m) => m.t === 'lobby' && m.humans.length === 2);
    assert.ok(lobby.endsIn <= 600);

    const [startA, startB] = await Promise.all([a.waitFor((m) => m.t === 'start'), b.waitFor((m) => m.t === 'start')]);
    assert.equal(startA.worldId, startB.worldId, 'both clients are in the same world');
    assert.equal(app.room.stats().entities, 50);
    assert.equal(app.room.stats().npcs, 48);

    // Snapshots arrive and contain the client's own snake.
    const spawnA = await a.waitFor((m) => m.t === 'spawn');
    const snap = await a.waitFor((m) => m.t === 's' && m.me === spawnA.id);
    assert.ok(snap.sn.some((s) => s.i === spawnA.id));

    // Input changes the authoritative heading; a forged position is ignored.
    a.send({ t: 'in', a: Math.PI / 2, b: 1, x: 0, y: 0, score: 9999 });
    a.send('{this is not json');
    const err = await a.waitFor((m) => m.t === 'err' && m.code === 'BAD_MESSAGE');
    assert.equal(err.reason, 'invalid_json');
    const scoreSnap = await a.waitFor((m) => m.t === 's' && m.k > snap.k + 4);
    assert.ok(scoreSnap.sc < 100, 'score is not taken from the client');

    // Ping/pong for latency measurement.
    a.send({ t: 'ping', c: 123 });
    const pong = await a.waitFor((m) => m.t === 'pong');
    assert.equal(pong.c, 123);

    // Fill the room to 4, then a 5th client gets ROOM_FULL and is closed with 4001.
    const c = client();
    const d = client();
    await Promise.all([c.open(), d.open()]);
    c.send({ t: 'join', name: 'Cat' });
    d.send({ t: 'join', name: 'Dan' });
    await Promise.all([c.waitFor((m) => m.t === 'spawn'), d.waitFor((m) => m.t === 'spawn')]);
    const e = client();
    await e.open();
    e.send({ t: 'join', name: 'Eve' });
    const full = await e.waitFor((m) => m.t === 'err');
    assert.equal(full.code, 'ROOM_FULL');
    assert.equal((await e.waitClose()).code, 4001);
    assert.equal(app.room.stats().entities >= 49, true);

    // When everyone leaves the world completes and events were published with eventIds.
    for (const x of [a, b, c, d]) x.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.room.state, 'idle');
    await app.publisher.flush();
    const types = sent.map((ev) => ev.type);
    assert.ok(types.includes('WORLD_STARTED'));
    assert.ok(types.includes('SESSION_ENDED'));
    assert.ok(types.includes('WORLD_COMPLETED'));
    assert.ok(sent.every((ev) => typeof ev.eventId === 'string' && ev.eventId.length === 36));
});

test('a client that never joins is closed after the join timeout', { timeout: 8000 }, async () => {
    const z = client();
    await z.open();
    const closed = await z.waitClose(7000);
    assert.equal(closed.code, 4009);
});

test('graceful shutdown tells connected players to reconnect', async () => {
    const a = client();
    await a.open();
    a.send({ t: 'join', name: 'Last' });
    await a.waitFor((m) => m.t === 'welcome');
    await app.stop('test-sigterm');
    const bye = await a.waitFor((m) => m.t === 'bye');
    assert.equal(bye.reason, 'server_shutdown');
    assert.equal((await a.waitClose()).code, 4002);
    app = null;
});
