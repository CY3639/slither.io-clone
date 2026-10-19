import { World } from './world.js';
import { SNAKE_COLORS } from './constants.js';
import { normalizeAngle } from './geometry.js';
import { ERROR_CODES } from '../net/protocol.js';
import { createRng } from '../util/random.js';

const LOBBY_BROADCAST_MS = 500;
const LEADERBOARD_EVERY_TICKS = 15;
const AOI_MARGIN = 350; // px beyond the viewport edge that is still sent, to cover interpolation
const EARLY_RESPAWN_MS = 500;
// Bright tints reserved for humans so they stand out from NPCs (indices into the client palette).
const HUMAN_COLORS = [0, 3, 6, 9];

/**
 * The room owns this task's single world and its lifecycle:
 *
 *   idle ──first human──► lobby ──(4 humans | 10 s)──► running ──last human leaves──► idle
 *
 * It maps sockets to human slots, enforces the human cap (ROOM_FULL), keeps the world at
 * exactly `totalSnakes` slots by filling with NPCs, publishes domain events, and builds the
 * per-client snapshots.
 */
export class Room {
    constructor({ config, clock = { now: () => Date.now() }, rng, publisher, logger, metrics, tokens, identity, onActiveChange }) {
        this.cfg = config; // config.world
        this.clock = clock;
        this.rng = rng ?? createRng(config.seed);
        this.publisher = publisher;
        this.log = logger;
        this.metrics = metrics;
        this.tokens = tokens;
        this.identity = identity; // { taskId, taskShort }
        this.onActiveChange = onActiveChange ?? (() => {});

        this.state = 'idle';
        this.world = null;
        this.worldId = null;
        this.generation = 0;
        this.humans = new Map(); // conn.id -> HumanSlot
        this.draining = false;
        this.tickNo = 0;
        this.lobbyStartedAt = 0;
        this.lobbyEndsAt = 0;
        this.lastLobbyBroadcast = 0;
        this.worldStartedAt = 0;
        this.peakHumans = 0;
        this.humanDeaths = 0;
        this.snapshotEvery = Math.max(1, Math.round(config.tickRate / config.snapshotRate));
        this.leaderboard = [];
    }

    get dt() {
        return 1 / this.cfg.tickRate;
    }

    get humanCount() {
        return this.humans.size;
    }

    get active() {
        return this.state !== 'idle';
    }

    // ------------------------------------------------------------------ membership

    /** Handle a validated join message. Returns { ok } or { ok: false, code }. */
    join(conn, { name, pid, tok, vw, vh }) {
        if (this.humans.has(conn.id)) return { ok: false, code: ERROR_CODES.ALREADY_JOINED };
        if (this.draining) return { ok: false, code: ERROR_CODES.DRAINING };
        if (this.humans.size >= this.cfg.maxHumans) return { ok: false, code: ERROR_CODES.ROOM_FULL };

        // The same player ID may be connected twice (two tabs share localStorage). That is allowed:
        // kicking the older socket would make two tabs evict each other in a reconnect loop, and
        // half-open ghost connections are reaped by the WebSocket heartbeat anyway.
        const { playerId, token } = this.tokens.resolve(pid, tok);

        const now = this.clock.now();
        const slot = {
            conn,
            playerId,
            name,
            color: this.pickHumanColor(),
            snakeId: null,
            viewport: { w: vw, h: vh },
            focus: { x: 0, y: 0 },
            respawnAt: 0,
            diedAt: 0,
            lifeStartedAt: 0,
            joinedAt: now,
            best: 0,
            deaths: 0,
            kills: 0,
            pendingInput: null,
        };
        this.humans.set(conn.id, slot);
        this.peakHumans = Math.max(this.peakHumans, this.humans.size);

        conn.send({
            t: 'welcome',
            pid: playerId,
            tok: token,
            taskId: this.identity.taskShort,
            state: this.state === 'idle' ? 'lobby' : this.state,
            cfg: {
                tickRate: this.cfg.tickRate,
                snapshotRate: this.cfg.snapshotRate,
                radius: this.cfg.radius,
                maxHumans: this.cfg.maxHumans,
                totalSnakes: this.cfg.totalSnakes,
                lobbyMs: this.cfg.lobbyMs,
            },
        });

        if (this.state === 'idle') this.openLobby(now);
        if (this.state === 'lobby') {
            this.broadcastLobby(now);
            if (this.humans.size >= this.cfg.maxHumans) this.startWorld('full');
        } else if (this.state === 'running') {
            // Late join: the slot-balancing step in tick() removes one NPC to make room.
            this.sendWorldIntro(slot);
            this.spawnHuman(slot);
        }
        this.log.info('player_joined', { playerId, worldId: this.worldId, humans: this.humans.size, state: this.state });
        return { ok: true, playerId };
    }

    leave(conn, reason = 'disconnect') {
        const slot = this.humans.get(conn.id);
        if (!slot) return;
        this.humans.delete(conn.id);
        const now = this.clock.now();
        if (this.world && slot.snakeId !== null) {
            const snake = this.world.snakes.get(slot.snakeId);
            if (snake) slot.best = Math.max(slot.best, snake.score);
            this.world.removeSnake(slot.snakeId, { dropFood: true });
        }
        if (this.state === 'running') {
            this.publish('SESSION_ENDED', {
                playerId: slot.playerId,
                displayName: slot.name,
                bestScore: slot.best,
                deaths: slot.deaths,
                kills: slot.kills,
                playedMs: now - slot.joinedAt,
                reason,
            });
        }
        this.log.info('player_left', { playerId: slot.playerId, worldId: this.worldId, reason, humans: this.humans.size });

        if (this.humans.size === 0) {
            if (this.state === 'running') this.endWorld(reason === 'shutdown' ? 'shutdown' : 'empty');
            else if (this.state === 'lobby') this.setState('idle');
        } else if (this.state === 'lobby') {
            this.broadcastLobby(now);
        }
    }

    input(conn, { a, b }) {
        const slot = this.humans.get(conn.id);
        if (!slot) return;
        slot.pendingInput = { a: normalizeAngle(a), b };
    }

    respawn(conn) {
        const slot = this.humans.get(conn.id);
        if (!slot || this.state !== 'running' || slot.snakeId !== null) return;
        if (this.clock.now() - slot.diedAt < EARLY_RESPAWN_MS) return;
        this.spawnHuman(slot);
    }

    pickHumanColor() {
        const used = new Set([...this.humans.values()].map((h) => h.color));
        return HUMAN_COLORS.find((c) => !used.has(c)) ?? Math.floor(this.rng() * SNAKE_COLORS);
    }

    // ------------------------------------------------------------------ lifecycle

    setState(state) {
        const wasActive = this.active;
        this.state = state;
        if (wasActive !== this.active) this.onActiveChange(this.active);
    }

    openLobby(now) {
        this.lobbyStartedAt = now;
        this.lobbyEndsAt = now + this.cfg.lobbyMs;
        this.peakHumans = this.humans.size;
        this.setState('lobby');
        this.log.info('lobby_opened', { lobbyMs: this.cfg.lobbyMs });
    }

    startWorld(reason) {
        const now = this.clock.now();
        this.generation++;
        this.worldId = `${this.identity.taskShort}-${this.generation}`;
        this.world = new World({
            radius: this.cfg.radius,
            foodTarget: this.cfg.foodTarget,
            maxFood: this.cfg.maxFood,
            rng: this.rng,
        });
        this.worldStartedAt = now;
        this.humanDeaths = 0;
        this.peakHumans = this.humans.size;
        this.tickNo = 0;
        this.setState('running');

        for (const slot of this.humans.values()) {
            this.sendWorldIntro(slot);
            this.spawnHuman(slot);
        }
        this.balanceSlots();

        const stats = this.world.stats();
        this.publish('WORLD_STARTED', {
            humans: stats.humans,
            npcs: stats.npcs,
            lobbyWaitMs: now - this.lobbyStartedAt,
            reason,
        });
        this.metrics?.count('WorldStarted');
        this.log.info('world_started', { worldId: this.worldId, reason, humans: stats.humans, npcs: stats.npcs, lobbyWaitMs: now - this.lobbyStartedAt });
    }

    endWorld(reason) {
        if (!this.world) return;
        const now = this.clock.now();
        this.publish('WORLD_COMPLETED', {
            durationMs: now - this.worldStartedAt,
            peakHumans: this.peakHumans,
            humanDeaths: this.humanDeaths,
            reason,
        });
        this.metrics?.count('WorldEnded');
        this.log.info('world_completed', { worldId: this.worldId, reason, durationMs: now - this.worldStartedAt });
        // Dropping the world stops all simulation work: an idle task uses ~0 CPU.
        this.world = null;
        this.setState(this.humans.size > 0 ? 'lobby' : 'idle');
        if (this.state === 'lobby') this.openLobby(now);
    }

    /** SIGTERM: stop accepting players, tell clients to reconnect elsewhere, close the world. */
    drain() {
        if (this.draining) return;
        this.draining = true;
        for (const slot of [...this.humans.values()]) {
            slot.conn.send({ t: 'bye', reason: 'server_shutdown', retryInMs: 200 + Math.floor(this.rng() * 1300) });
            this.leave(slot.conn, 'shutdown');
            slot.conn.close(4002, 'server shutting down');
        }
        if (this.world) this.endWorld('shutdown');
        this.setState('idle');
    }

    // ------------------------------------------------------------------ slots

    spawnHuman(slot) {
        const snake = this.world.spawnSnake({ name: slot.name, isHuman: true, playerId: slot.playerId, color: slot.color });
        slot.snakeId = snake.id;
        slot.lifeStartedAt = this.clock.now();
        slot.pendingInput = null;
        slot.conn.send({ t: 'spawn', id: snake.id });
    }

    /** Keep humans + NPCs == totalSnakes. Dead humans keep their slot until they respawn. */
    balanceSlots() {
        if (!this.world) return;
        const wantNpcs = Math.max(0, this.cfg.totalSnakes - this.humans.size);
        let npcs = 0;
        for (const s of this.world.snakes.values()) if (!s.isHuman) npcs++;
        while (npcs < wantNpcs) {
            this.world.spawnSnake({});
            npcs++;
        }
        if (npcs > wantNpcs) {
            // A late-joining human replaces the smallest NPC (removed without dropping food).
            const victims = [...this.world.snakes.values()].filter((s) => !s.isHuman).sort((a, b) => a.length - b.length);
            for (let i = 0; i < npcs - wantNpcs; i++) this.world.removeSnake(victims[i].id);
        }
    }

    // ------------------------------------------------------------------ tick

    tick() {
        const now = this.clock.now();
        if (this.state === 'lobby') {
            if (now >= this.lobbyEndsAt || this.humans.size >= this.cfg.maxHumans) {
                this.startWorld(this.humans.size >= this.cfg.maxHumans ? 'full' : 'timer');
            } else if (now - this.lastLobbyBroadcast >= LOBBY_BROADCAST_MS) {
                this.broadcastLobby(now);
            }
            return;
        }
        if (this.state !== 'running') return;

        this.tickNo++;
        for (const slot of this.humans.values()) {
            if (slot.pendingInput && slot.snakeId !== null) {
                this.world.setIntent(slot.snakeId, slot.pendingInput.a, slot.pendingInput.b);
            }
        }

        const deaths = this.world.tick(this.dt);
        for (const death of deaths) this.handleDeath(death, now);

        for (const slot of this.humans.values()) {
            if (slot.snakeId === null && slot.respawnAt && now >= slot.respawnAt) this.spawnHuman(slot);
        }
        this.balanceSlots();

        if (this.tickNo % LEADERBOARD_EVERY_TICKS === 1) this.leaderboard = this.computeLeaderboard();
        if (this.tickNo % this.snapshotEvery === 0) this.broadcastSnapshot(now);
    }

    handleDeath({ snake, killer, cause }, now) {
        if (killer?.isHuman) {
            for (const slot of this.humans.values()) if (slot.snakeId === killer.id) slot.kills++;
        }
        if (!snake.isHuman) return;
        const slot = [...this.humans.values()].find((h) => h.snakeId === snake.id);
        if (!slot) return;

        const score = snake.score;
        slot.best = Math.max(slot.best, score);
        slot.deaths++;
        slot.snakeId = null;
        slot.diedAt = now;
        slot.respawnAt = now + this.cfg.respawnMs;
        slot.focus = { x: snake.x, y: snake.y };
        this.humanDeaths++;

        const killedBy = killer ? { type: 'snake', name: killer.name, isHuman: killer.isHuman } : { type: cause };
        slot.conn.send({ t: 'dead', score, kills: snake.kills, by: killer ? killer.name : null, cause, respawnIn: this.cfg.respawnMs });
        this.publish('PLAYER_DIED', {
            playerId: slot.playerId,
            displayName: slot.name,
            score,
            length: snake.length,
            kills: snake.kills,
            killedBy,
            survivedMs: now - slot.lifeStartedAt,
        });
        this.log.info('player_died', { playerId: slot.playerId, worldId: this.worldId, score, cause, killer: killer?.name });
    }

    computeLeaderboard() {
        return [...this.world.snakes.values()]
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map((s) => [s.name, s.score, s.isHuman ? 1 : 0]);
    }

    // ------------------------------------------------------------------ outbound

    publish(type, payload) {
        this.publisher?.publish(type, payload, { worldId: this.worldId });
    }

    broadcastLobby(now) {
        this.lastLobbyBroadcast = now;
        const msg = JSON.stringify({
            t: 'lobby',
            endsIn: Math.max(0, this.lobbyEndsAt - now),
            humans: [...this.humans.values()].map((h) => h.name),
            max: this.cfg.maxHumans,
        });
        for (const slot of this.humans.values()) slot.conn.sendRaw(msg);
    }

    sendWorldIntro(slot) {
        const food = [];
        for (const f of this.world.food.values()) food.push(f.id, f.x, f.y, f.c);
        slot.conn.send({ t: 'start', worldId: this.worldId, radius: this.cfg.radius, totalSnakes: this.cfg.totalSnakes });
        slot.conn.send({ t: 'food', f: food });
    }

    /**
     * Snapshot = the snakes inside each client's area of interest + food deltas + leaderboard.
     * Each snake is serialised once per snapshot and the fragment reused for every client,
     * so the cost is O(snakes + clients × visible) rather than O(clients × snakes) stringify.
     */
    broadcastSnapshot(now) {
        const world = this.world;
        const fragments = new Map();
        const fragmentOf = (snake) => {
            let frag = fragments.get(snake.id);
            if (frag === undefined) {
                // Body encoding (measured to cut egress, the dominant running cost):
                //  - half resolution: every second section (0, 2, 4, ...) plus the tail; sections
                //    are ~10 px apart with an 18+ px radius, so the client rebuilds the skipped
                //    ones as neighbour midpoints with no visible difference;
                //  - delta-encoded: first point absolute, then small offsets (1-2 digit numbers).
                const pts = [];
                let px = 0;
                let py = 0;
                const push = (i) => {
                    const x = Math.round(snake.secX[i]);
                    const y = Math.round(snake.secY[i]);
                    pts.push(x - px, y - py);
                    px = x;
                    py = y;
                };
                const last = snake.length - 1;
                for (let i = 0; i <= last; i += 2) push(i);
                if (last % 2 === 1) push(last); // keep the tail exact when the length is even
                frag = JSON.stringify({
                    i: snake.id,
                    n: snake.name,
                    c: snake.color,
                    h: snake.isHuman ? 1 : 0,
                    r: Math.round(snake.scale * 1000),
                    b: snake.boosting ? 1 : 0,
                    l: snake.length,
                    p: pts,
                });
                fragments.set(snake.id, frag);
            }
            return frag;
        };

        const { added, removed } = world.drainFoodDelta();
        const fa = [];
        for (const f of added) if (world.food.has(f.id)) fa.push(f.id, f.x, f.y, f.c);
        const shared =
            `"fa":${JSON.stringify(fa)},"fr":${JSON.stringify(removed)}` +
            (this.tickNo % LEADERBOARD_EVERY_TICKS === 0 || this.tickNo === this.snapshotEvery
                ? `,"lb":${JSON.stringify(this.leaderboard)}`
                : '');

        let bytes = 0;
        for (const slot of this.humans.values()) {
            const own = slot.snakeId !== null ? world.snakes.get(slot.snakeId) : null;
            if (own) slot.focus = { x: own.x, y: own.y };
            const hw = slot.viewport.w / 2 + AOI_MARGIN;
            const hh = slot.viewport.h / 2 + AOI_MARGIN;
            const minX = slot.focus.x - hw;
            const maxX = slot.focus.x + hw;
            const minY = slot.focus.y - hh;
            const maxY = slot.focus.y + hh;

            const visible = [];
            for (const snake of world.snakes.values()) {
                const b = snake.bbox;
                if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue;
                visible.push(fragmentOf(snake));
            }
            const msg =
                `{"t":"s","k":${this.tickNo},"ts":${now},"me":${own ? own.id : null},"sc":${own ? own.score : 0},` +
                `"fx":${Math.round(slot.focus.x)},"fy":${Math.round(slot.focus.y)},"sn":[${visible.join(',')}],${shared}}`;
            if (slot.conn.sendRaw(msg)) bytes += msg.length;
        }
        this.metrics?.add('SnapshotBytes', bytes);
    }

    stats() {
        const world = this.world ? this.world.stats() : { snakes: 0, humans: 0, npcs: 0, food: 0 };
        return {
            state: this.state,
            worldId: this.worldId,
            humans: this.humans.size,
            maxHumans: this.cfg.maxHumans,
            entities: world.snakes,
            npcs: world.npcs,
            food: world.food,
            draining: this.draining,
        };
    }
}
