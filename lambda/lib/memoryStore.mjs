// In-memory store with the same semantics as DynamoStore (idempotency, max best score,
// commutative world records). Used by unit tests and by tools/local-cloud.mjs for local runs.

export class MemoryStore {
    constructor() {
        this.processed = new Set();
        this.profiles = new Map();
        this.deaths = [];
        this.worlds = new Map();
        this.failNext = 0; // tests: simulate transient DynamoDB errors
    }

    maybeFail() {
        if (this.failNext > 0) {
            this.failNext--;
            const err = new Error('Simulated throttling');
            err.name = 'ProvisionedThroughputExceededException';
            throw err;
        }
    }

    profile(playerId) {
        let p = this.profiles.get(playerId);
        if (!p) {
            p = { displayName: null, bestScore: undefined, deaths: 0, kills: 0, sessions: 0, playMs: 0 };
            this.profiles.set(playerId, p);
        }
        return p;
    }

    raiseBest(playerId, name, score) {
        if (score <= 0) return false;
        const p = this.profile(playerId);
        if (p.bestScore !== undefined && p.bestScore >= score) return false;
        p.bestScore = score;
        p.displayName = name;
        p.bestScoreAt = new Date().toISOString();
        return true;
    }

    async apply(evt) {
        this.maybeFail();
        const p = evt.payload;
        let newBest = false;
        if (evt.type === 'PLAYER_DIED') newBest = this.raiseBest(p.playerId, p.displayName, p.score);
        if (evt.type === 'SESSION_ENDED') newBest = this.raiseBest(p.playerId, p.displayName, p.bestScore);
        if (this.processed.has(evt.eventId)) return { result: 'duplicate', newBest };
        this.processed.add(evt.eventId);

        if (evt.type === 'PLAYER_DIED') {
            const prof = this.profile(p.playerId);
            prof.displayName = p.displayName;
            prof.deaths += 1;
            prof.kills += p.kills;
            this.deaths.push({ playerId: p.playerId, eventId: evt.eventId, score: p.score, worldId: evt.worldId });
        } else if (evt.type === 'SESSION_ENDED') {
            const prof = this.profile(p.playerId);
            prof.displayName = p.displayName;
            prof.sessions += 1;
            prof.playMs += p.playedMs;
        } else {
            const w = this.worlds.get(evt.worldId) ?? {};
            if (evt.type === 'WORLD_STARTED') Object.assign(w, { startedAt: evt.occurredAt, startHumans: p.humans, startNpcs: p.npcs });
            else Object.assign(w, { completedAt: evt.occurredAt, durationMs: p.durationMs, peakHumans: p.peakHumans });
            this.worlds.set(evt.worldId, w);
        }
        return { result: 'applied', newBest };
    }

    async leaderboard(limit) {
        return [...this.profiles.values()]
            .filter((p) => p.bestScore > 0)
            .sort((a, b) => b.bestScore - a.bestScore)
            .slice(0, limit)
            .map((p, i) => ({ rank: i + 1, displayName: p.displayName, bestScore: p.bestScore, bestScoreAt: p.bestScoreAt }));
    }

    async player(playerId) {
        const p = this.profiles.get(playerId);
        return p ? { ...p } : null;
    }
}
