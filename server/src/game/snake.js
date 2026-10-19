import { SNAKE } from './constants.js';
import { clamp, normalizeAngle } from './geometry.js';

/**
 * Headless snake. Same movement model as the original Phaser snake.js: the head moves forward,
 * its positions are recorded in a path, and each following section sits on that path about
 * `spacingFactor * scale` behind the section in front of it. P2 physics is gone; positions are
 * computed directly so the server is deterministic and testable.
 *
 * The path is stored oldest-first (head = last element) so appending is O(1).
 */
export class Snake {
    constructor({ id, name, isHuman = false, playerId = null, color = 0, x, y, heading = 0 }) {
        this.id = id;
        this.name = name;
        this.isHuman = isHuman;
        this.playerId = playerId;
        this.color = color;

        this.scale = SNAKE.startScale;
        this.length = SNAKE.startSections + 1; // number of sections including the head
        this.heading = heading;
        this.targetAngle = heading;
        this.boosting = false;
        this.alive = true;
        this.kills = 0;
        this.foodEaten = 0;
        this.brain = null; // NPC state, owned by npcBrain.js

        this.pathX = [];
        this.pathY = [];
        this.secX = new Array(this.length);
        this.secY = new Array(this.length);
        this.gridItems = []; // reusable spatial-grid entries, one per section
        this.bbox = { minX: x, minY: y, maxX: x, maxY: y };

        // Lay out the starting body in a straight line behind the head (snake.js initSections).
        const spacing = this.spacing;
        const dx = Math.cos(heading);
        const dy = Math.sin(heading);
        for (let k = this.length - 1; k >= 0; k--) {
            this.pathX.push(x - dx * spacing * k);
            this.pathY.push(y - dy * spacing * k);
        }
        this.resample();
    }

    get x() {
        return this.secX[0];
    }

    get y() {
        return this.secY[0];
    }

    get spacing() {
        return SNAKE.spacingFactor * this.scale;
    }

    get radius() {
        return SNAKE.baseRadius * this.scale;
    }

    get score() {
        return this.length - (SNAKE.startSections + 1);
    }

    /** Position of the collision edge (the original `edge` sprite locked in front of the head). */
    edgePoint() {
        const d = this.radius + SNAKE.edgeOffset;
        return { x: this.x + Math.cos(this.heading) * d, y: this.y + Math.sin(this.heading) * d };
    }

    setIntent(angle, boosting) {
        this.targetAngle = angle;
        this.boosting = Boolean(boosting);
    }

    /** Advance one tick: turn toward the target angle at a bounded rate, then move forward. */
    step(dt) {
        const diff = normalizeAngle(this.targetAngle - this.heading);
        const maxTurn = SNAKE.turnRate * dt;
        this.heading = normalizeAngle(this.heading + clamp(diff, -maxTurn, maxTurn));

        const speed = this.boosting ? SNAKE.fastSpeed : SNAKE.slowSpeed;
        const nx = this.x + Math.cos(this.heading) * speed * dt;
        const ny = this.y + Math.sin(this.heading) * speed * dt;
        this.pathX.push(nx);
        this.pathY.push(ny);
        this.resample();
    }

    /** Eating one food: one extra section and 1% larger, as in snake.js incrementSize(). */
    grow(amount = 1) {
        for (let i = 0; i < amount; i++) {
            if (this.length < SNAKE.maxSections) {
                // Keep secX/secY consistent with length until the next resample(): the new
                // section starts on top of the current tail, as in the original game.
                this.secX.push(this.secX[this.length - 1]);
                this.secY.push(this.secY[this.length - 1]);
                this.length++;
            }
            this.scale = Math.min(SNAKE.maxScale, this.scale * SNAKE.growthFactor);
        }
        this.foodEaten += amount;
    }

    /**
     * Place every section on the head path at equal arc-length spacing (the job of
     * findNextPointIndex in snake.js), then trim path history that no section uses.
     */
    resample() {
        const px = this.pathX;
        const py = this.pathY;
        const spacing = this.spacing;
        const n = px.length;
        const len = this.length;
        const secX = this.secX;
        const secY = this.secY;
        secX.length = len;
        secY.length = len;

        secX[0] = px[n - 1];
        secY[0] = py[n - 1];
        let s = 1;
        let acc = 0;
        let target = spacing;
        let i = n - 1;
        for (; i > 0 && s < len; i--) {
            const ax = px[i];
            const ay = py[i];
            const bx = px[i - 1];
            const by = py[i - 1];
            const segLen = Math.hypot(bx - ax, by - ay);
            if (segLen === 0) continue;
            while (s < len && acc + segLen >= target) {
                const t = (target - acc) / segLen;
                secX[s] = ax + (bx - ax) * t;
                secY[s] = ay + (by - ay) * t;
                s++;
                target += spacing;
            }
            acc += segLen;
        }
        // Newly grown sections wait at the tail until the head has moved far enough (as in the original).
        for (; s < len; s++) {
            secX[s] = px[0];
            secY[s] = py[0];
        }

        // Drop path points older than the tail. Splice in chunks to keep the cost amortised.
        if (i > 64) {
            px.splice(0, i - 1);
            py.splice(0, i - 1);
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let k = 0; k < len; k++) {
            const x = secX[k];
            const y = secY[k];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        const r = this.radius;
        this.bbox.minX = minX - r;
        this.bbox.minY = minY - r;
        this.bbox.maxX = maxX + r;
        this.bbox.maxY = maxY + r;
    }
}
