#!/usr/bin/env node
// Local stand-in for the AWS async path, so the full flow can be exercised without an account:
//   game server --POST /events--> [SQS-shaped batch] --> real event-worker handler --> MemoryStore
//   browser --GET /api/*--> (game server dev proxy) --> real leaderboard-api handler --> MemoryStore
// The handlers are the same modules deployed to Lambda; only the store differs.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../lambda/event-worker/handler.mjs';
import { createApiHandler } from '../lambda/leaderboard-api/handler.mjs';
import { MemoryStore } from '../lambda/lib/memoryStore.mjs';

const port = Number(process.env.LOCAL_CLOUD_PORT ?? 8090);
const store = new MemoryStore();
const worker = createHandler({ store });
const api = createApiHandler({ store });

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 1_000_000) reject(new Error('too large'));
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
        if (req.method === 'POST' && url.pathname === '/events') {
            const { events } = JSON.parse(await readBody(req));
            const records = events.map((e) => ({ messageId: randomUUID(), body: JSON.stringify(e), attributes: { ApproximateReceiveCount: '1' } }));
            const out = await worker({ Records: records });
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(out));
        }
        if (url.pathname.startsWith('/api/')) {
            const out = await api({ httpMethod: req.method, path: url.pathname, queryStringParameters: Object.fromEntries(url.searchParams) });
            res.writeHead(out.statusCode, out.headers);
            return res.end(out.body);
        }
        res.writeHead(404).end();
    } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
});

server.listen(port, () => console.log(JSON.stringify({ msg: 'local_cloud_started', port })));
