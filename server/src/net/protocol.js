// Client → server message validation. The client is untrusted: it may only express intent
// (heading, boost, join, respawn, ping). Anything else is rejected before touching game state.

export const ERROR_CODES = Object.freeze({
    ROOM_FULL: 'ROOM_FULL',
    DRAINING: 'SERVER_DRAINING',
    BAD_MESSAGE: 'BAD_MESSAGE',
    NOT_JOINED: 'NOT_JOINED',
    ALREADY_JOINED: 'ALREADY_JOINED',
    RATE_LIMITED: 'RATE_LIMITED',
    JOIN_TIMEOUT: 'JOIN_TIMEOUT',
});

// WebSocket close codes in the private range (4000-4999) so the client can tell them apart.
export const CLOSE_CODES = Object.freeze({
    ROOM_FULL: 4001,
    SHUTDOWN: 4002,
    DRAINING: 4003,
    POLICY: 4008,
    JOIN_TIMEOUT: 4009,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const NAME_MAX = 16;

/** Keep letters, digits, spaces and a few symbols; collapse whitespace; cap the length. */
export function sanitizeName(raw) {
    if (typeof raw !== 'string') return 'Anonymous';
    const cleaned = raw
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N} _.\-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX)
        .trim();
    return cleaned || 'Anonymous';
}

function clampInt(v, lo, hi, fallback) {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
}

/**
 * Parse and validate one raw message. Returns { ok: true, msg } with a normalised message,
 * or { ok: false, reason }.
 */
export function parseClientMessage(raw) {
    let data;
    try {
        data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
        return { ok: false, reason: 'invalid_json' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.t !== 'string') {
        return { ok: false, reason: 'missing_type' };
    }

    switch (data.t) {
        case 'in': {
            // Heading in radians (any finite value is normalised later) and a boost flag.
            if (typeof data.a !== 'number' || !Number.isFinite(data.a) || Math.abs(data.a) > 1000) {
                return { ok: false, reason: 'bad_angle' };
            }
            return { ok: true, msg: { t: 'in', a: data.a, b: data.b === 1 || data.b === true } };
        }
        case 'join': {
            const pid = typeof data.pid === 'string' && UUID_RE.test(data.pid) ? data.pid : null;
            const tok = typeof data.tok === 'string' && TOKEN_RE.test(data.tok) ? data.tok : null;
            return {
                ok: true,
                msg: {
                    t: 'join',
                    name: sanitizeName(data.name),
                    pid,
                    tok,
                    vw: clampInt(data.vw, 320, 2560, 1600),
                    vh: clampInt(data.vh, 240, 1600, 900),
                },
            };
        }
        case 'respawn':
            return { ok: true, msg: { t: 'respawn' } };
        case 'ping': {
            if (typeof data.c !== 'number' || !Number.isFinite(data.c)) return { ok: false, reason: 'bad_ping' };
            return { ok: true, msg: { t: 'ping', c: data.c } };
        }
        default:
            return { ok: false, reason: 'unknown_type' };
    }
}
