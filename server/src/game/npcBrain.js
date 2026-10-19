// Deliberately simple NPC steering. It builds on the original BotSnake "trend" wander
// (keep turning one way, flip with probability 1/20 per update) and adds three priorities:
//   1. stay inside the arena, 2. avoid bodies ahead, 3. seek nearby food.
// NPCs exist to make the world busy and to generate realistic simulation load, not to be clever.

const BOUNDARY_MARGIN = 320;
const FOOD_SCAN_TICKS = 6;
const FOOD_RANGE = 320;

export function thinkNpc(world, snake, rng) {
    let brain = snake.brain;
    if (!brain) {
        brain = snake.brain = {
            trend: rng() < 0.5 ? -1 : 1,
            foodId: null,
            // Stagger food scans so all NPCs don't scan on the same tick.
            nextScan: Math.floor(rng() * FOOD_SCAN_TICKS),
        };
    }
    snake.boosting = false;
    const hx = snake.x;
    const hy = snake.y;

    // 1. Arena boundary: head back toward the centre.
    if (hx * hx + hy * hy > (world.radius - BOUNDARY_MARGIN) ** 2) {
        snake.targetAngle = Math.atan2(-hy, -hx);
        return;
    }

    // 2a. Another head close by and in front of us (most NPC deaths were head-to-head while
    //     converging on the same food): turn away from it.
    const r = snake.radius;
    const threat = nearestHeadInFront(world, snake, r * 2 + 130);
    if (threat) {
        const cross = Math.cos(snake.heading) * (threat.y - hy) - Math.sin(snake.heading) * (threat.x - hx);
        snake.targetAngle = snake.heading + (cross > 0 ? -1.5 : 1.5);
        brain.foodId = null;
        return;
    }

    // 2b. Danger ahead: sample several points along the heading; if any is blocked, turn hard
    //     toward the side with fewer blocked samples.
    if (rayBlocked(world, snake, snake.heading, r) > 0) {
        const left = rayBlocked(world, snake, snake.heading - 0.6, r) + rayBlocked(world, snake, snake.heading - 1.3, r);
        const right = rayBlocked(world, snake, snake.heading + 0.6, r) + rayBlocked(world, snake, snake.heading + 1.3, r);
        let turn;
        if (left < right) turn = -1.5;
        else if (right < left) turn = 1.5;
        else turn = brain.trend * 1.5;
        snake.targetAngle = snake.heading + turn;
        brain.foodId = null;
        return;
    }

    // 3. Food seeking.
    if (--brain.nextScan <= 0) {
        brain.nextScan = FOOD_SCAN_TICKS;
        const food = world.nearestFood(hx, hy, FOOD_RANGE);
        // Ignore food lying against another body (e.g. the remains of a fresh kill being contested).
        brain.foodId = food && !world.isBlocked(food.x, food.y, r, snake) ? food.id : null;
    }
    if (brain.foodId !== null) {
        const food = world.food.get(brain.foodId);
        if (food) {
            snake.targetAngle = Math.atan2(food.y - hy, food.x - hx);
            return;
        }
        brain.foodId = null;
    }

    // 4. Wander: the original bot behaviour, softened so NPCs drift instead of spinning in place.
    if (rng() < 1 / 20) brain.trend *= -1;
    snake.targetAngle = snake.heading + brain.trend * 0.05;
}

function nearestHeadInFront(world, snake, range) {
    const hx = snake.x;
    const hy = snake.y;
    const fx = Math.cos(snake.heading);
    const fy = Math.sin(snake.heading);
    let best = null;
    let bestD = range * range;
    world.bodyGrid.query(hx, hy, range, (item) => {
        if (item.i !== 0 || item.snake === snake) return false;
        const ox = item.snake.x - hx;
        const oy = item.snake.y - hy;
        const d = ox * ox + oy * oy;
        if (d < bestD && ox * fx + oy * fy > 0) {
            bestD = d;
            best = item.snake;
        }
        return false;
    });
    return best;
}

// Look-ahead distances as multiples of the snake radius plus a fixed margin (~0.9 s of travel).
const RAY_STEPS = [[1, 14], [2, 30], [2, 70], [2, 110]];

/** Number of blocked sample points along a ray from the head. */
function rayBlocked(world, snake, angle, r) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let blocked = 0;
    for (const [k, extra] of RAY_STEPS) {
        const d = r * k + extra;
        if (world.isBlocked(snake.x + cos * d, snake.y + sin * d, r * 0.8, snake)) blocked++;
    }
    return blocked;
}
