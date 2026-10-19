import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/game/world.js';
import { mulberry32 } from '../src/util/random.js';
import { FOOD } from '../src/game/constants.js';

const DT = 1 / 30;

function emptyWorld() {
    return new World({ radius: 2400, foodTarget: 0, maxFood: 1600, rng: mulberry32(1) });
}

/** Place a human-controlled (no NPC brain) snake at an exact position and heading. */
function placeSnake(world, x, y, heading) {
    const s = world.spawnSnake({ isHuman: true, name: 'p' });
    // Rebuild its body at the requested pose.
    s.pathX = [];
    s.pathY = [];
    for (let k = s.length - 1; k >= 0; k--) {
        s.pathX.push(x - Math.cos(heading) * s.spacing * k);
        s.pathY.push(y - Math.sin(heading) * s.spacing * k);
    }
    s.heading = heading;
    s.targetAngle = heading;
    s.resample();
    world.rebuildBodyGrid();
    return s;
}

test('starts with the ambient food target', () => {
    const w = new World({ radius: 2400, foodTarget: 300, maxFood: 1600, rng: mulberry32(3) });
    assert.equal(w.food.size, 300);
    for (const f of w.food.values()) assert.ok(Math.hypot(f.x, f.y) <= 2400);
});

test('eating food grows the snake and emits a food removal delta', () => {
    const w = emptyWorld();
    const s = placeSnake(w, 0, 0, 0);
    const f = w.addFood(10, 0, 1, false);
    w.drainFoodDelta();
    w.tick(DT);
    assert.ok(!w.food.has(f.id));
    assert.equal(s.score, 1);
    assert.deepEqual(w.drainFoodDelta().removed, [f.id]);
});

test('head edge hitting another body kills the attacker; the victim is credited with the kill', () => {
    const w = emptyWorld();
    const wall = placeSnake(w, 0, 300, -Math.PI / 2); // vertical body from y=300 down to ~y=616
    const attacker = placeSnake(w, -40, 450, 0); // heading +x toward the wall's body
    let deaths = [];
    for (let i = 0; i < 30 && deaths.length === 0; i++) deaths = w.tick(DT);
    assert.equal(deaths.length, 1);
    assert.equal(deaths[0].snake, attacker);
    assert.equal(deaths[0].killer, wall);
    assert.equal(deaths[0].cause, 'collision');
    assert.equal(wall.kills, 1);
    assert.ok(!w.snakes.has(attacker.id));
});

test('own body never kills (tight circle)', () => {
    const w = emptyWorld();
    const s = placeSnake(w, 0, 0, 0);
    s.grow(40);
    for (let i = 0; i < 300; i++) {
        s.setIntent(s.heading + 1, false); // turn as hard as possible forever
        assert.equal(w.tick(DT).length, 0);
    }
});

test('leaving the arena kills with cause "boundary"', () => {
    const w = emptyWorld();
    const s = placeSnake(w, 2380, 0, 0);
    const deaths = w.tick(DT);
    assert.equal(deaths.length, 1);
    assert.equal(deaths[0].snake, s);
    assert.equal(deaths[0].cause, 'boundary');
});

test('a dead snake drops food along its body (every second section)', () => {
    const w = emptyWorld();
    const s = placeSnake(w, 0, 0, 0);
    const len = s.length;
    w.removeSnake(s.id, { dropFood: true });
    assert.equal(w.food.size, Math.ceil(len / 2));
    for (const f of w.food.values()) assert.ok(f.c >= 0 && f.c < FOOD.colors);
});

test('a full NPC world keeps simulating with stable timing', () => {
    const w = new World({ radius: 2400, foodTarget: 700, maxFood: 1600, rng: mulberry32(9) });
    for (let i = 0; i < 50; i++) w.spawnSnake({});
    const started = performance.now();
    for (let t = 0; t < 300; t++) {
        for (const d of w.tick(DT)) w.spawnSnake({});
    }
    const msPerTick = (performance.now() - started) / 300;
    assert.equal(w.snakes.size, 50);
    assert.ok(msPerTick < 10, `tick took ${msPerTick} ms`);
});
