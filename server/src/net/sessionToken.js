import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Anonymous identity without accounts: the server issues a random player ID plus an HMAC of it.
 * A returning browser presents both. Without the shared secret nobody can claim someone
 * else's ID, so their leaderboard entry can't be hijacked. All tasks share the secret via
 * SSM Parameter Store, so a player keeps their identity whichever world they land in.
 */
export function createSessionTokens(secret) {
    function sign(playerId) {
        return createHmac('sha256', secret).update(playerId).digest('hex');
    }

    return {
        /** Returns { playerId, token, isNew }. */
        resolve(playerId, token) {
            if (playerId && token) {
                const expected = Buffer.from(sign(playerId), 'hex');
                const given = Buffer.from(token, 'hex');
                if (expected.length === given.length && timingSafeEqual(expected, given)) {
                    return { playerId, token, isNew: false };
                }
            }
            const fresh = randomUUID();
            return { playerId: fresh, token: sign(fresh), isNew: true };
        },
        sign,
    };
}
