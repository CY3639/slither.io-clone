#!/usr/bin/env node
// Synthetic WebSocket players for load testing and for demonstrating ECS scale-out.
//
// Each virtual player behaves like a real client: joins, retries ROOM_FULL with jitter (so the ALB
// routes it to another task), steers with plausible input at 10 Hz, boosts occasionally,
// respawns after death and pings every 2 s for RTT. The load is genuine gameplay, not a busy loop.
//
// Usage:
//   node load-tests/websocket-load.js --url wss://<cloudfront>/ws --clients 12 --duration 600 --ramp 60
// Options: --url --clients --duration (s) --ramp (s) --input-hz --max-room-full-retries --out <file> --quiet
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
const URL_ = args.url ?? 'ws://localhost:8080/ws';
const CLIENTS = int(args.clients, 8);
const DURATION_S = int(args.duration, 60);
const RAMP_S = int(args.ramp, 10);
const INPUT_HZ = int(args['input-hz'], 10);
const MAX_ROOM_FULL = int(args['max-room-full-retries'], 300);
const MAX_RECONNECTS = int(args['max-reconnects'], 20);
const QUIET = Boolean(args.quiet);
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = args.out ?? path.join(here, 'results', `load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const stats = {
    attempts: 0,
    opened: 0,
    joined: 0,
    roomFull: 0,
    connectErrors: 0,
    unexpectedCloses: 0,
    serverShutdowns: 0,
    deaths: 0,
    snapshots: 0,
    bytes: 0,
    rtt: [],
    snapshotGaps: [],
    tasks: {}, // taskId -> clients currently joined
    worlds: new Set(),
    taskSeen: new Set(),
};

const startedAt = Date.now();
const endAt = startedAt + DURATION_S * 1000;
const players = [];

function int(v, d) {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined ? n : d;
}

function parseArgs(list) {
    const out = {};
    for (let i = 0; i < list.length; i++) {
        if (!list[i].startsWith('--')) continue;
        const key = list[i].slice(2);
        const next = list[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else out[key] = list[++i];
    }
    return out;
}

class VirtualPlayer {
    constructor(index) {
        this.index = index;
        this.name = `load-${index}`;
        this.angle = Math.random() * Math.PI * 2;
        this.turn = 0;
        this.roomFullRetries = 0;
        this.reconnects = 0;
        this.taskId = null;
        this.alive = false;
        this.lastSnapAt = 0;
        this.timers = [];
        this.done = false;
    }

    connect() {
        if (this.done || Date.now() > endAt) return;
        stats.attempts++;
        const ws = new WebSocket(URL_, { handshakeTimeout: 10000 });
        this.ws = ws;
        ws.on('open', () => {
            stats.opened++;
            ws.send(JSON.stringify({ t: 'join', name: this.name, vw: 1600, vh: 900 }));
        });
        ws.on('message', (data) => this.onMessage(data));
        ws.on('error', () => {
            stats.connectErrors++;
        });
        ws.on('close', (code) => this.onClose(code));
    }

    onMessage(data) {
        stats.bytes += data.length;
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }
        switch (msg.t) {
            case 'welcome':
                stats.joined++;
                this.roomFullRetries = 0;
                this.taskId = msg.taskId;
                stats.taskSeen.add(msg.taskId);
                stats.tasks[msg.taskId] = (stats.tasks[msg.taskId] ?? 0) + 1;
                this.startLoops();
                break;
            case 'start':
                stats.worlds.add(msg.worldId);
                break;
            case 'spawn':
                this.alive = true;
                break;
            case 'dead':
                this.alive = false;
                stats.deaths++;
                this.later(() => this.send({ t: 'respawn' }), 1000 + Math.random() * 1500);
                break;
            case 's': {
                stats.snapshots++;
                const now = Date.now();
                if (this.lastSnapAt) stats.snapshotGaps.push(now - this.lastSnapAt);
                this.lastSnapAt = now;
                if (stats.snapshotGaps.length > 200000) stats.snapshotGaps.splice(0, 100000);
                break;
            }
            case 'pong':
                stats.rtt.push(Date.now() - msg.c);
                break;
            case 'bye':
                stats.serverShutdowns++;
                break;
        }
    }

    onClose(code) {
        this.stopLoops();
        if (this.taskId && stats.tasks[this.taskId]) stats.tasks[this.taskId]--;
        this.taskId = null;
        this.alive = false;
        if (this.done || Date.now() > endAt) return;
        if (code === 4001) {
            // ROOM_FULL: retry quickly with jitter so the load balancer can pick another task.
            stats.roomFull++;
            if (++this.roomFullRetries > MAX_ROOM_FULL) return this.giveUp('room_full_retries_exhausted');
            this.later(() => this.connect(), 150 + Math.random() * 450);
            return;
        }
        if (code !== 4002) stats.unexpectedCloses++;
        if (++this.reconnects > MAX_RECONNECTS) return this.giveUp('reconnects_exhausted');
        const base = Math.min(8000, 300 * 2 ** Math.min(this.reconnects, 5));
        this.later(() => this.connect(), base / 2 + Math.random() * (base / 2));
    }

    giveUp(reason) {
        this.done = true;
        this.gaveUp = reason;
    }

    startLoops() {
        this.stopLoops();
        // Smooth wandering steering, like a person moving the mouse.
        this.inputTimer = setInterval(() => {
            if (!this.alive) return;
            if (Math.random() < 0.05) this.turn = (Math.random() - 0.5) * 0.6;
            this.angle += this.turn;
            const boost = Math.random() < 0.08 ? 1 : 0;
            this.send({ t: 'in', a: Math.round(this.angle * 1000) / 1000, b: boost });
        }, 1000 / INPUT_HZ);
        this.pingTimer = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 2000);
    }

    stopLoops() {
        clearInterval(this.inputTimer);
        clearInterval(this.pingTimer);
    }

    later(fn, ms) {
        this.timers.push(setTimeout(fn, ms));
    }

    send(obj) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }

    stop() {
        this.done = true;
        this.stopLoops();
        this.timers.forEach(clearTimeout);
        this.ws?.close(1000, 'load test finished');
    }
}

function percentile(values, q) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function connectedNow() {
    return Object.values(stats.tasks).reduce((a, b) => a + b, 0);
}

let lastBytes = 0;
let lastSnaps = 0;
function progress() {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const bytes = stats.bytes - lastBytes;
    const snaps = stats.snapshots - lastSnaps;
    lastBytes = stats.bytes;
    lastSnaps = stats.snapshots;
    const recent = stats.rtt.slice(-500);
    const perTask = Object.entries(stats.tasks)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');
    if (!QUIET) {
        console.log(
            `[${String(elapsed).padStart(4)}s] in-world=${connectedNow()}/${players.length} roomFull=${stats.roomFull} ` +
                `errors=${stats.connectErrors} closes=${stats.unexpectedCloses} rx=${(bytes / 5 / 1024).toFixed(0)}KiB/s ` +
                `snaps/s=${(snaps / 5).toFixed(0)} rtt p50=${percentile(recent, 0.5) ?? '-'} p95=${percentile(recent, 0.95) ?? '-'}ms tasks{${perTask}}`,
        );
    }
}

function summary() {
    return {
        url: URL_,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        config: { clients: CLIENTS, durationS: DURATION_S, rampS: RAMP_S, inputHz: INPUT_HZ },
        connections: {
            attempts: stats.attempts,
            opened: stats.opened,
            joined: stats.joined,
            roomFullResponses: stats.roomFull,
            connectErrors: stats.connectErrors,
            unexpectedCloses: stats.unexpectedCloses,
            serverShutdownNotices: stats.serverShutdowns,
            playersGaveUp: players.filter((p) => p.gaveUp).length,
            inWorldAtEnd: connectedNow(),
        },
        distinctTasks: [...stats.taskSeen],
        distinctWorlds: [...stats.worlds],
        playersPerTaskAtEnd: Object.fromEntries(Object.entries(stats.tasks).filter(([, n]) => n > 0)),
        gameplay: { snapshots: stats.snapshots, deaths: stats.deaths, megabytesReceived: +(stats.bytes / 1048576).toFixed(1) },
        rttMs: { samples: stats.rtt.length, p50: percentile(stats.rtt, 0.5), p95: percentile(stats.rtt, 0.95), p99: percentile(stats.rtt, 0.99), max: percentile(stats.rtt, 1) },
        snapshotIntervalMs: { p50: percentile(stats.snapshotGaps, 0.5), p95: percentile(stats.snapshotGaps, 0.95), p99: percentile(stats.snapshotGaps, 0.99) },
    };
}

console.log(`Load test: ${CLIENTS} players → ${URL_} for ${DURATION_S}s (ramp ${RAMP_S}s)`);
for (let i = 0; i < CLIENTS; i++) {
    const p = new VirtualPlayer(i);
    players.push(p);
    setTimeout(() => p.connect(), (RAMP_S * 1000 * i) / Math.max(1, CLIENTS));
}
const progressTimer = setInterval(progress, 5000);

function finish() {
    clearInterval(progressTimer);
    players.forEach((p) => p.stop());
    const result = summary();
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(`Saved ${OUT}`);
    setTimeout(() => process.exit(0), 500);
}
setTimeout(finish, DURATION_S * 1000);
process.on('SIGINT', finish);
