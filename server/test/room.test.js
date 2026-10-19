import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeConn, joinMsg, makeRoom, runFor } from './helpers.js';

function npcCount(room) {
    return [...room.world.snakes.values()].filter((s) => !s.isHuman).length;
}

test('first human opens a lobby; the world starts after at most 10 s and fills to 50 with NPCs', () => {
    const { room, clock, publisher } = makeRoom();
    const a = fakeConn();
    assert.equal(room.join(a, joinMsg('Alice')).ok, true);
    assert.equal(room.state, 'lobby');
    assert.equal(a.last('welcome').state, 'lobby');

    runFor(room, clock, 9900);
    assert.equal(room.state, 'lobby', 'still waiting before 10 s');
    runFor(room, clock, 200);
    assert.equal(room.state, 'running', 'started by 10 s');

    assert.equal(room.world.snakes.size, 50);
    assert.equal(npcCount(room), 49);
    const started = publisher.ofType('WORLD_STARTED')[0];
    assert.equal(started.payload.reason, 'timer');
    assert.ok(started.payload.lobbyWaitMs <= 10000 + 1000 / 30);
    assert.ok(a.last('spawn'), 'human was spawned');
});

test('NPC fill is 50 - humans for 1..4 humans', () => {
    for (let humans = 1; humans <= 4; humans++) {
        const { room, clock } = makeRoom();
        for (let i = 0; i < humans; i++) room.join(fakeConn(), joinMsg(`p${i}`));
        runFor(room, clock, 10100);
        assert.equal(room.world.snakes.size, 50, `${humans} humans`);
        assert.equal(npcCount(room), 50 - humans);
    }
});

test('four humans start the world immediately', () => {
    const { room, publisher } = makeRoom();
    for (let i = 0; i < 4; i++) room.join(fakeConn(), joinMsg(`p${i}`));
    assert.equal(room.state, 'running');
    assert.equal(publisher.ofType('WORLD_STARTED')[0].payload.reason, 'full');
});

test('fifth human receives ROOM_FULL', () => {
    const { room } = makeRoom();
    for (let i = 0; i < 4; i++) room.join(fakeConn(), joinMsg(`p${i}`));
    const fifth = fakeConn();
    assert.deepEqual(room.join(fifth, joinMsg('late')), { ok: false, code: 'ROOM_FULL' });
    assert.equal(room.humanCount, 4);
});

test('late joiner replaces an NPC in a running world', () => {
    const { room, clock } = makeRoom();
    room.join(fakeConn(), joinMsg('a'));
    runFor(room, clock, 10100);
    const late = fakeConn();
    assert.equal(room.join(late, joinMsg('late')).ok, true);
    assert.ok(late.last('start') && late.last('food') && late.last('spawn'), 'late joiner receives world intro');
    runFor(room, clock, 50);
    assert.equal(room.world.snakes.size, 50);
    assert.equal(npcCount(room), 48);
});

test('a lobby that empties goes back to idle; a world that empties completes', () => {
    const { room, clock, publisher } = makeRoom();
    const a = fakeConn();
    room.join(a, joinMsg('a'));
    room.leave(a);
    assert.equal(room.state, 'idle');

    const b = fakeConn();
    room.join(b, joinMsg('b'));
    runFor(room, clock, 10100);
    room.leave(b);
    assert.equal(room.state, 'idle');
    assert.equal(room.world, null, 'simulation stops when idle');
    const done = publisher.ofType('WORLD_COMPLETED')[0];
    assert.equal(done.payload.reason, 'empty');
    assert.equal(publisher.ofType('SESSION_ENDED')[0].payload.reason, 'disconnect');
});

test('human death publishes PLAYER_DIED, then auto-respawns after RESPAWN_MS', () => {
    const { room, clock, publisher } = makeRoom();
    const a = fakeConn();
    room.join(a, joinMsg('Alice'));
    runFor(room, clock, 10100);
    const slot = [...room.humans.values()][0];
    const snake = room.world.snakes.get(slot.snakeId);
    // Steer the human straight out of the arena.
    room.input(a, { a: Math.atan2(snake.y, snake.x), b: true });
    runFor(room, clock, 30000);
    const died = publisher.ofType('PLAYER_DIED');
    assert.ok(died.length >= 1, 'player died');
    assert.equal(died[0].payload.playerId, slot.playerId);
    assert.equal(died[0].payload.displayName, 'Alice');
    assert.ok(a.last('dead'), 'client told about the death');
    assert.ok(a.all('spawn').length >= 2, 'respawned');
});

test('snapshots contain the own snake and stay within the area of interest', () => {
    const { room, clock } = makeRoom();
    const a = fakeConn();
    room.join(a, joinMsg('a'));
    runFor(room, clock, 10200);
    const snap = a.last('s');
    assert.ok(snap, 'snapshot received');
    const me = snap.sn.find((s) => s.i === snap.me);
    assert.ok(me, 'own snake included');
    assert.ok(snap.sn.length < 50, `AoI culls distant snakes (${snap.sn.length} visible)`);
    assert.equal(me.p.length % 2, 0);

    // Points are delta-encoded: decoding must give back the authoritative section positions.
    room.broadcastSnapshot(clock.now()); // fresh snapshot of the current state
    const fresh = a.last('s');
    const mine = fresh.sn.find((s) => s.i === fresh.me);
    const snake = room.world.snakes.get(fresh.me);
    const abs = [...mine.p];
    for (let k = 2; k < abs.length; k++) abs[k] += abs[k - 2];
    assert.equal(abs.length / 2, snake.length);
    for (let i = 0; i < snake.length; i++) {
        assert.equal(abs[i * 2], Math.round(snake.secX[i]));
        assert.equal(abs[i * 2 + 1], Math.round(snake.secY[i]));
    }
    assert.ok(Math.max(...mine.p.slice(2).map(Math.abs)) < 30, 'deltas are small numbers');
});

test('drain sends bye, closes sockets and ends the world', () => {
    const { room, clock, publisher } = makeRoom();
    const a = fakeConn();
    room.join(a, joinMsg('a'));
    runFor(room, clock, 10100);
    room.drain();
    assert.ok(a.last('bye'));
    assert.equal(a.closed.code, 4002);
    assert.equal(publisher.ofType('WORLD_COMPLETED')[0].payload.reason, 'shutdown');
    assert.deepEqual(room.join(fakeConn(), joinMsg('x')), { ok: false, code: 'SERVER_DRAINING' });
});

test('returning player keeps their signed player id; forged id is replaced', () => {
    const { room } = makeRoom();
    const a = fakeConn();
    room.join(a, joinMsg('a'));
    const { pid, tok } = a.last('welcome');
    room.leave(a);

    const again = fakeConn();
    room.join(again, { ...joinMsg('a'), pid, tok });
    assert.equal(again.last('welcome').pid, pid);

    const forged = fakeConn();
    room.join(forged, { ...joinMsg('b'), pid, tok: 'f'.repeat(64) });
    assert.notEqual(forged.last('welcome').pid, pid);
});
