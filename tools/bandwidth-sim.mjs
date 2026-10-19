#!/usr/bin/env node
// Offline bandwidth model: age a 50-snake world for 4 minutes, record 30 s of one player's
// snapshots in the current wire format (delta-encoded, half-resolution bodies), and compare raw
// bytes with permessage-deflate (level 1, context takeover, as configured on the server).
// Usage: node tools/bandwidth-sim.mjs
import zlib from 'node:zlib';
import { Room } from '../server/src/game/room.js';
import { createSessionTokens } from '../server/src/net/sessionToken.js';
import { silentLogger } from '../server/src/util/logger.js';
import { mulberry32 } from '../server/src/util/random.js';
let t = 1e6; const clock = { now: () => t };
const cfg = { tickRate: 30, snapshotRate: 15, totalSnakes: 50, maxHumans: 4, lobbyMs: 0, respawnMs: 3000, radius: 2400, foodTarget: 700, maxFood: 1600, seed: 3 };
const room = new Room({ config: cfg, clock, rng: mulberry32(5), publisher: { publish() {} }, logger: silentLogger, tokens: createSessionTokens('x'), identity: { taskShort: 'sim' } });
const msgs = []; let record = false;
const conn = { id: 1, send() { return true; }, sendRaw(s) { if (record && s.startsWith('{"t":"s"')) msgs.push(s); return true; }, close() {} };
room.join(conn, { name: 'p', vw: 1600, vh: 900 });
const step = () => { t += 1000 / 30; room.tick(); const sl = [...room.humans.values()][0]; if (sl.snakeId === null) room.respawn(conn); };
for (let i = 0; i < 30 * 240; i++) step();        // age the world 4 minutes
record = true; for (let i = 0; i < 30 * 30; i++) step();  // record 30 s
const raw = msgs.reduce((a, m) => a + m.length, 0);
const def = zlib.createDeflateRaw({ level: 1, memLevel: 7 });
for (const m of msgs) def.write(m);
const parts = []; def.on('data', (c) => parts.push(c));
await new Promise((r) => { def.end(r); });
const compressed = parts.reduce((a, b) => a + b.length, 0);
const lens = [...room.world.snakes.values()].map((s) => s.length);
console.log(JSON.stringify({ snapshots: msgs.length, avgLen: (lens.reduce((a, b) => a + b) / lens.length).toFixed(0), rawKiBs: (raw / 30 / 1024).toFixed(1), deflateKiBs: (compressed / 30 / 1024).toFixed(1) }));
