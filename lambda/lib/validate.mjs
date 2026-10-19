// Schema validation for events arriving from SQS. Anything that fails here is a poison message:
// the worker reports it as a batch-item failure so SQS redelivers it, and after maxReceiveCount
// it lands in the dead-letter queue for inspection instead of corrupting the table.

export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORLD_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_SCORE = 1_000_000;

function req(cond, message) {
    if (!cond) throw new ValidationError(message);
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isName = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 16;

const PAYLOAD_RULES = {
    PLAYER_DIED(p) {
        req(UUID.test(p.playerId ?? ''), 'playerId must be a UUID');
        req(isName(p.displayName), 'displayName must be 1-16 chars');
        req(isInt(p.score, 0, MAX_SCORE), 'score out of range');
        req(isInt(p.length, 1, 10_000), 'length out of range');
        req(isInt(p.kills, 0, 10_000), 'kills out of range');
        req(isInt(p.survivedMs, 0, 86_400_000), 'survivedMs out of range');
        req(p.killedBy && typeof p.killedBy.type === 'string', 'killedBy.type required');
    },
    SESSION_ENDED(p) {
        req(UUID.test(p.playerId ?? ''), 'playerId must be a UUID');
        req(isName(p.displayName), 'displayName must be 1-16 chars');
        req(isInt(p.bestScore, 0, MAX_SCORE), 'bestScore out of range');
        req(isInt(p.deaths, 0, 100_000), 'deaths out of range');
        req(isInt(p.playedMs, 0, 7 * 86_400_000), 'playedMs out of range');
    },
    WORLD_STARTED(p) {
        req(isInt(p.humans, 0, 50) && isInt(p.npcs, 0, 200), 'humans/npcs out of range');
        req(isInt(p.lobbyWaitMs, 0, 600_000), 'lobbyWaitMs out of range');
    },
    WORLD_COMPLETED(p) {
        req(isInt(p.durationMs, 0, 30 * 86_400_000), 'durationMs out of range');
        req(isInt(p.peakHumans, 0, 50), 'peakHumans out of range');
    },
};

export const EVENT_TYPES = Object.keys(PAYLOAD_RULES);

/** Parse an SQS message body into a validated event, or throw ValidationError. */
export function parseEvent(body) {
    let evt;
    try {
        evt = JSON.parse(body);
    } catch {
        throw new ValidationError('body is not JSON');
    }
    req(evt && typeof evt === 'object', 'event must be an object');
    req(UUID.test(evt.eventId ?? ''), 'eventId must be a UUID');
    req(Object.hasOwn(PAYLOAD_RULES, evt.type), `unknown event type ${String(evt.type).slice(0, 40)}`);
    req(evt.version === 1, 'unsupported version');
    req(typeof evt.occurredAt === 'string' && !Number.isNaN(Date.parse(evt.occurredAt)), 'occurredAt must be ISO time');
    req(evt.payload && typeof evt.payload === 'object', 'payload required');
    if (evt.type.startsWith('WORLD_')) req(WORLD_ID.test(evt.worldId ?? ''), 'worldId required');
    PAYLOAD_RULES[evt.type](evt.payload);
    return evt;
}
