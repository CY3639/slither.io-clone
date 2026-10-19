import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { CLOSE_CODES, ERROR_CODES, parseClientMessage } from './protocol.js';
import { RateLimiter } from './rateLimiter.js';

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json',
};

const MAX_BAD_MESSAGES = 20;
const TICK_STALL_MS = 2000;

let nextConnId = 1;

/** Thin wrapper so the room never touches the socket library directly (and tests can fake it). */
class Connection {
    constructor(ws, { maxBuffered, logger }) {
        this.id = nextConnId++;
        this.ws = ws;
        this.maxBuffered = maxBuffered;
        this.log = logger;
        this.joined = false;
        this.alive = true;
        this.badMessages = 0;
        this.skipped = 0;
    }

    send(obj) {
        return this.sendRaw(JSON.stringify(obj));
    }

    /** Backpressure: skip snapshots for a slow client rather than buffering without bound. */
    sendRaw(str) {
        const ws = this.ws;
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount > this.maxBuffered) {
            this.skipped++;
            if (ws.bufferedAmount > this.maxBuffered * 4) {
                this.log.warn('slow_client_terminated', { connId: this.id, buffered: ws.bufferedAmount });
                ws.terminate();
            }
            return false;
        }
        ws.send(str);
        return true;
    }

    close(code, reason) {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close(code, reason);
        }
    }
}

export function createGameServer({ config, room, logger, identity, getLastTickAt }) {
    const { net } = config;
    const connections = new Set();
    const staticRoot = config.staticDir ? path.resolve(config.staticDir) : null;

    const httpServer = http.createServer((req, res) => {
        handleHttp(req, res).catch((err) => {
            logger.error('http_error', { err, url: req.url });
            if (!res.headersSent) json(res, 500, { error: 'internal' });
        });
    });

    async function handleHttp(req, res) {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/health') {
            // Liveness: the process is up and the tick loop has not stalled.
            const tickAgeMs = Date.now() - getLastTickAt();
            const ok = tickAgeMs < TICK_STALL_MS;
            return json(res, ok ? 200 : 503, { status: ok ? 'ok' : 'stalled', tickAgeMs, taskId: identity.taskShort });
        }
        if (req.method === 'GET' && url.pathname === '/ready') {
            // Readiness: accepting new players. A full room is still "ready" (it answers ROOM_FULL);
            // failing readiness when full would make ECS replace a perfectly healthy task.
            const ready = !room.draining;
            return json(res, ready ? 200 : 503, { ready, ...room.stats() });
        }
        if (req.method === 'GET' && url.pathname === '/status') {
            return json(res, 200, { ...room.stats(), connections: connections.size, taskId: identity.taskShort, az: identity.az });
        }
        if (config.localApiUrl && url.pathname.startsWith('/api/')) return proxyLocalApi(req, res, url);
        if (staticRoot && req.method === 'GET') return serveStatic(res, url.pathname);
        json(res, 404, { error: 'not_found' });
    }

    // Local development only: in AWS, CloudFront/ALB route /api/* to the Lambda instead.
    async function proxyLocalApi(req, res, url) {
        try {
            const upstream = await fetch(config.localApiUrl + url.pathname + url.search, { signal: AbortSignal.timeout(3000) });
            res.writeHead(upstream.status, {
                'content-type': upstream.headers.get('content-type') ?? 'application/json',
                'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
            });
            res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
            json(res, 502, { error: 'local_api_unavailable' });
        }
    }

    async function serveStatic(res, pathname) {
        const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
        const file = path.resolve(staticRoot, rel);
        if (!file.startsWith(staticRoot + path.sep)) return json(res, 403, { error: 'forbidden' });
        try {
            const body = await readFile(file);
            res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
            res.end(body);
        } catch {
            json(res, 404, { error: 'not_found' });
        }
    }

    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: net.maxPayloadBytes,
        perMessageDeflate: net.deflate
            ? {
                  zlibDeflateOptions: { level: net.deflateLevel, memLevel: 7 },
                  threshold: 256, // tiny messages (pong, err) are not worth compressing
                  concurrencyLimit: 4,
              }
            : false,
    });

    httpServer.on('upgrade', (req, socket, head) => {
        const { pathname } = new URL(req.url, 'http://localhost');
        if (pathname !== '/ws') {
            socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
        const conn = new Connection(ws, { maxBuffered: net.maxBufferedBytes, logger });
        const limiter = new RateLimiter({ ratePerSecond: net.maxMessagesPerSecond, burst: net.maxMessagesPerSecond });
        connections.add(conn);

        const joinTimer = setTimeout(() => {
            if (!conn.joined) {
                conn.send({ t: 'err', code: ERROR_CODES.JOIN_TIMEOUT });
                conn.close(CLOSE_CODES.JOIN_TIMEOUT, 'join timeout');
            }
        }, net.joinTimeoutMs);

        ws.on('pong', () => {
            conn.alive = true;
        });

        ws.on('message', (data, isBinary) => {
            if (!limiter.take()) {
                // Ignore the excess. Sustained flooding (5 s worth of budget dropped) closes the socket.
                if (limiter.dropped > net.maxMessagesPerSecond * 5) {
                    logger.warn('client_rate_limited', { connId: conn.id });
                    conn.close(CLOSE_CODES.POLICY, 'rate limit');
                }
                return;
            }
            const parsed = isBinary ? { ok: false, reason: 'binary' } : parseClientMessage(data);
            if (!parsed.ok) {
                conn.badMessages++;
                if (conn.badMessages <= 3) conn.send({ t: 'err', code: ERROR_CODES.BAD_MESSAGE, reason: parsed.reason });
                if (conn.badMessages > MAX_BAD_MESSAGES) conn.close(CLOSE_CODES.POLICY, 'too many invalid messages');
                return;
            }
            const msg = parsed.msg;
            switch (msg.t) {
                case 'join': {
                    if (conn.joined) {
                        conn.send({ t: 'err', code: ERROR_CODES.ALREADY_JOINED });
                        return;
                    }
                    const result = room.join(conn, msg);
                    if (result.ok) {
                        conn.joined = true;
                        clearTimeout(joinTimer);
                    } else {
                        conn.send({ t: 'err', code: result.code, taskId: identity.taskShort });
                        const code = result.code === ERROR_CODES.ROOM_FULL ? CLOSE_CODES.ROOM_FULL : CLOSE_CODES.DRAINING;
                        conn.close(code, result.code);
                    }
                    return;
                }
                case 'in':
                    if (conn.joined) room.input(conn, msg);
                    return;
                case 'respawn':
                    if (conn.joined) room.respawn(conn);
                    return;
                case 'ping':
                    conn.send({ t: 'pong', c: msg.c, s: Date.now() });
                    return;
            }
        });

        ws.on('close', () => {
            clearTimeout(joinTimer);
            connections.delete(conn);
            if (conn.joined) room.leave(conn, 'disconnect');
        });

        ws.on('error', (err) => logger.warn('ws_error', { err, connId: conn.id }));
    });

    // Detect half-open connections (e.g. a laptop lid closed) so their slots are released.
    const heartbeat = setInterval(() => {
        for (const conn of connections) {
            if (!conn.alive) {
                conn.ws.terminate();
                continue;
            }
            conn.alive = false;
            conn.ws.ping();
        }
    }, net.heartbeatMs);
    heartbeat.unref();

    return {
        httpServer,
        wss,
        connections,
        listen(port) {
            return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address().port)));
        },
        /** Stop accepting connections. Existing sockets are closed by room.drain(). */
        async close(graceMs = 1500) {
            clearInterval(heartbeat);
            // room.drain() already sent `bye` and started a close handshake on every socket. Give
            // them a moment to flush (compression makes sends asynchronous) before forcing it.
            const deadline = Date.now() + graceMs;
            while (connections.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
            for (const conn of connections) conn.ws.terminate();
            wss.close();
            await new Promise((resolve) => httpServer.close(() => resolve()));
        },
    };
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
