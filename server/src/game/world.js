import { FOOD, NPC_NAMES, SNAKE, SNAKE_COLORS } from './constants.js';
import { dist2 } from './geometry.js';
import { Snake } from './snake.js';
import { RebuildGrid, SetGrid } from './spatialGrid.js';
import { thinkNpc } from './npcBrain.js';
import { randomInt, randomRange } from '../util/random.js';

const BODY_CELL = 64;
const FOOD_CELL = 96;
const MAX_SECTION_RADIUS = SNAKE.baseRadius * SNAKE.maxScale;

/**
 * One authoritative world: snakes, food, the tick (move → eat → collide → die) and the spatial
 * indexes. It knows nothing about networking, lobbies or humans vs. sockets (see room.js).
 */
export class World {
    constructor({ radius, foodTarget, maxFood, rng }) {
        this.radius = radius;
        this.foodTarget = foodTarget;
        this.maxFood = maxFood;
        this.rng = rng;

        this.snakes = new Map();
        this.food = new Map();
        this.ambientFood = 0;
        this.nextSnakeId = 1;
        this.nextFoodId = 1;
        this.tickCount = 0;

        this.bodyGrid = new RebuildGrid(BODY_CELL);
        this.foodGrid = new SetGrid(FOOD_CELL);
        this.foodAdded = [];
        this.foodRemoved = [];

        this.replenishFood(foodTarget);
        this.rebuildBodyGrid();
    }

    // ---------------------------------------------------------------- snakes

    spawnSnake({ name, isHuman = false, playerId = null, color }) {
        const { x, y } = this.findSpawnPoint();
        const snake = new Snake({
            id: this.nextSnakeId++,
            name: name ?? NPC_NAMES[randomInt(this.rng, 0, NPC_NAMES.length - 1)],
            isHuman,
            playerId,
            color: color ?? randomInt(this.rng, 0, SNAKE_COLORS - 1),
            x,
            y,
            // Face roughly toward the centre so new snakes don't spawn heading into the wall.
            heading: Math.atan2(-y, -x) + randomRange(this.rng, -0.8, 0.8),
        });
        this.snakes.set(snake.id, snake);
        this.indexSnake(snake);
        return snake;
    }

    /** Remove a snake. `dropFood` turns the body into food, as in game.js snakeDestroyed(). */
    removeSnake(id, { dropFood = false } = {}) {
        const snake = this.snakes.get(id);
        if (!snake) return null;
        snake.alive = false;
        this.snakes.delete(id);
        if (dropFood) {
            // Every second section becomes food with ±10 px jitter (original: headPath step ≈ 2 sections).
            for (let i = 0; i < snake.length; i += 2) {
                if (this.food.size >= this.maxFood) break;
                this.addFood(
                    snake.secX[i] + randomInt(this.rng, -10, 10),
                    snake.secY[i] + randomInt(this.rng, -10, 10),
                    snake.color % FOOD.colors,
                    false,
                );
            }
        }
        return snake;
    }

    findSpawnPoint() {
        const r = this.radius * 0.8;
        let best = null;
        let bestClear = -1;
        for (let attempt = 0; attempt < 25; attempt++) {
            const angle = randomRange(this.rng, 0, Math.PI * 2);
            const d = Math.sqrt(this.rng()) * r; // uniform over the disc
            const x = Math.cos(angle) * d;
            const y = Math.sin(angle) * d;
            const clear = this.clearance(x, y, 400);
            if (clear >= 400) return { x, y };
            if (clear > bestClear) {
                bestClear = clear;
                best = { x, y };
            }
        }
        return best;
    }

    /** Distance from (x, y) to the nearest snake section, capped at `limit`. */
    clearance(x, y, limit) {
        let best = limit * limit;
        this.bodyGrid.query(x, y, limit, (item) => {
            const d = dist2(x, y, item.snake.secX[item.i], item.snake.secY[item.i]);
            if (d < best) best = d;
            return false;
        });
        return Math.sqrt(best);
    }

    setIntent(snakeId, angle, boosting) {
        const snake = this.snakes.get(snakeId);
        if (snake) snake.setIntent(angle, boosting);
    }

    // ---------------------------------------------------------------- food

    addFood(x, y, color, ambient) {
        const food = { id: this.nextFoodId++, x: Math.round(x), y: Math.round(y), c: color, ambient };
        this.food.set(food.id, food);
        this.foodGrid.insert(food);
        if (ambient) this.ambientFood++;
        this.foodAdded.push(food);
        return food;
    }

    removeFood(food) {
        this.food.delete(food.id);
        this.foodGrid.remove(food);
        if (food.ambient) this.ambientFood--;
        this.foodRemoved.push(food.id);
    }

    replenishFood(maxToAdd) {
        const r = this.radius * 0.95;
        let added = 0;
        while (this.ambientFood < this.foodTarget && this.food.size < this.maxFood && added < maxToAdd) {
            const angle = randomRange(this.rng, 0, Math.PI * 2);
            const d = Math.sqrt(this.rng()) * r;
            this.addFood(Math.cos(angle) * d, Math.sin(angle) * d, randomInt(this.rng, 0, FOOD.colors - 1), true);
            added++;
        }
    }

    nearestFood(x, y, range) {
        let best = null;
        let bestD = range * range;
        this.foodGrid.query(x, y, range, (f) => {
            const d = dist2(x, y, f.x, f.y);
            if (d < bestD) {
                bestD = d;
                best = f;
            }
            return false;
        });
        return best;
    }

    /** Food added/removed since the last call; sent to clients as deltas. */
    drainFoodDelta() {
        const delta = { added: this.foodAdded, removed: this.foodRemoved };
        this.foodAdded = [];
        this.foodRemoved = [];
        return delta;
    }

    // ---------------------------------------------------------------- spatial index

    indexSnake(snake) {
        const items = snake.gridItems;
        for (let i = 0; i < snake.length; i++) {
            let item = items[i];
            if (!item) {
                item = { snake, i };
                items[i] = item;
            }
            this.bodyGrid.insert(item, snake.secX[i], snake.secY[i]);
        }
    }

    rebuildBodyGrid() {
        this.bodyGrid.clear();
        for (const snake of this.snakes.values()) this.indexSnake(snake);
    }

    /** True if a point is inside (or within `margin` of) another snake's body or outside the arena. */
    isBlocked(x, y, margin, self) {
        if (x * x + y * y > (this.radius - margin) ** 2) return true;
        return this.bodyGrid.query(x, y, margin + MAX_SECTION_RADIUS, (item) => {
            if (item.snake === self) return false;
            const r = item.snake.radius + margin;
            return dist2(x, y, item.snake.secX[item.i], item.snake.secY[item.i]) < r * r;
        });
    }

    // ---------------------------------------------------------------- tick

    /**
     * Advance the world by dt seconds. Returns the snakes that died this tick so the room can
     * publish events and respawn. Deaths are resolved after every snake has moved, so a
     * head-on collision kills both snakes regardless of iteration order.
     */
    tick(dt) {
        this.tickCount++;

        for (const snake of this.snakes.values()) {
            if (!snake.isHuman) thinkNpc(this, snake, this.rng);
        }
        for (const snake of this.snakes.values()) snake.step(dt);
        this.rebuildBodyGrid();

        // Eating: head overlaps food (the original pulled food into the head with a constraint).
        for (const snake of this.snakes.values()) {
            const reach = snake.radius + FOOD.radius;
            const reach2 = reach * reach;
            const hx = snake.x;
            const hy = snake.y;
            const eaten = [];
            this.foodGrid.query(hx, hy, reach, (f) => {
                if (dist2(hx, hy, f.x, f.y) <= reach2) eaten.push(f);
                return false;
            });
            for (const f of eaten) {
                this.removeFood(f);
                snake.grow(1);
            }
        }

        // Collisions: the edge in front of the head touching another snake's body kills (snake.js edgeContact).
        const deaths = [];
        const r2Arena = this.radius * this.radius;
        for (const snake of this.snakes.values()) {
            const edge = snake.edgePoint();
            if (edge.x * edge.x + edge.y * edge.y > r2Arena) {
                deaths.push({ snake, killer: null, cause: 'boundary' });
                continue;
            }
            let killer = null;
            this.bodyGrid.query(edge.x, edge.y, SNAKE.edgeOffset + MAX_SECTION_RADIUS, (item) => {
                const other = item.snake;
                if (other === snake) return false; // own body is ignored, as in the original
                const r = other.radius + SNAKE.edgeOffset;
                if (dist2(edge.x, edge.y, other.secX[item.i], other.secY[item.i]) < r * r) {
                    killer = other;
                    return true;
                }
                return false;
            });
            if (killer) deaths.push({ snake, killer, cause: 'collision' });
        }
        for (const death of deaths) {
            if (death.killer && death.killer.alive) death.killer.kills++;
            this.removeSnake(death.snake.id, { dropFood: true });
        }
        if (deaths.length) this.rebuildBodyGrid();

        this.replenishFood(10);
        return deaths;
    }

    stats() {
        let humans = 0;
        let npcs = 0;
        for (const s of this.snakes.values()) {
            if (s.isHuman) humans++;
            else npcs++;
        }
        return { snakes: this.snakes.size, humans, npcs, food: this.food.size };
    }
}
