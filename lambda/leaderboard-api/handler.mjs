import { log as defaultLog } from '../lib/log.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function respond(statusCode, body, cacheControl) {
    return {
        statusCode,
        statusDescription: `${statusCode} ${statusCode === 200 ? 'OK' : statusCode === 404 ? 'Not Found' : statusCode === 400 ? 'Bad Request' : 'Error'}`,
        headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
        isBase64Encoded: false,
        body: JSON.stringify(body),
    };
}

function query(event, name) {
    const raw = event.queryStringParameters?.[name];
    // ALB passes query parameters URL-encoded.
    return raw === undefined ? undefined : decodeURIComponent(raw);
}

/**
 * Read API behind the ALB (Lambda target group) and cached by CloudFront:
 *   GET /api/leaderboard?limit=10   public, cached 10 s at the edge
 *   GET /api/player?id=<uuid>       a player's own stats, cached 5 s (cache key includes id)
 */
export function createApiHandler({ store, log = defaultLog }) {
    return async function handler(event) {
        const path = event.path ?? event.rawPath ?? '/';
        const method = event.httpMethod ?? event.requestContext?.http?.method ?? 'GET';
        if (method !== 'GET') return respond(405, { error: 'method_not_allowed' }, 'no-store');
        try {
            if (path === '/api/leaderboard') {
                const limit = Math.min(25, Math.max(1, Number.parseInt(query(event, 'limit') ?? '10', 10) || 10));
                const items = await store.leaderboard(limit);
                log('info', 'leaderboard_served', { limit, count: items.length });
                return respond(200, { items, generatedAt: new Date().toISOString() }, 'public, max-age=10');
            }
            if (path === '/api/player') {
                const id = query(event, 'id');
                if (!id || !UUID.test(id)) return respond(400, { error: 'invalid_id' }, 'no-store');
                const player = await store.player(id);
                if (!player) return respond(404, { error: 'not_found' }, 'public, max-age=5');
                return respond(200, { player }, 'public, max-age=5');
            }
            if (path === '/api/health') return respond(200, { status: 'ok' }, 'no-store');
            return respond(404, { error: 'not_found' }, 'no-store');
        } catch (err) {
            log('error', 'api_failed', { path, err });
            return respond(500, { error: 'internal' }, 'no-store');
        }
    };
}
