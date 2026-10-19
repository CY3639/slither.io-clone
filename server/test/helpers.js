import { Room } from '../src/game/room.js';
import { createSessionTokens } from '../src/net/sessionToken.js';
import { silentLogger } from '../src/util/logger.js';
import { mulberry32 } from '../src/util/random.js';

export const WORLD_CFG = {
    tickRate: 30,
    snapshotRate: 15,
    totalSnakes: 50,
    maxHumans: 4,
    lobbyMs: 10000,
    respawnMs: 3000,
    radius: 2400,
    foodTarget: 700,
    maxFood: 1600,
    seed: 7,
};

export function fakeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => {
            t += ms;
        },
    };
}

let connId = 1;
export function fakeConn() {
    const conn = {
        id: connId++,
        messages: [],
        closed: null,
        send(obj) {
            conn.messages.push(obj);
            return true;
        },
        sendRaw(str) {
            conn.messages.push(JSON.parse(str));
            return true;
        },
        close(code, reason) {
            conn.closed = { code, reason };
        },
        last(type) {
            return [...conn.messages].reverse().find((m) => m.t === type);
        },
        all(type) {
            return conn.messages.filter((m) => m.t === type);
        },
    };
    return conn;
}

export function fakePublisher() {
    const events = [];
    return {
        events,
        publish(type, payload, ctx) {
            events.push({ type, payload, ...ctx });
        },
        ofType: (type) => events.filter((e) => e.type === type),
    };
}

export function makeRoom(overrides = {}) {
    const clock = fakeClock();
    const publisher = fakePublisher();
    const room = new Room({
        config: { ...WORLD_CFG, ...overrides },
        clock,
        rng: mulberry32(42),
        publisher,
        logger: silentLogger,
        tokens: createSessionTokens('test-secret'),
        identity: { taskId: 'task-abc', taskShort: 'taskabc0' },
    });
    return { room, clock, publisher };
}

export function joinMsg(name = 'Tester') {
    return { name, pid: null, tok: null, vw: 1600, vh: 900 };
}

/** Advance the fake clock and run room ticks for `ms` of game time. */
export function runFor(room, clock, ms) {
    const step = 1000 / room.cfg.tickRate;
    for (let t = 0; t < ms; t += step) {
        clock.advance(step);
        room.tick();
    }
}
