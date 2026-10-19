import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Snake } from '../src/game/snake.js';
import { SNAKE } from '../src/game/constants.js';
import { normalizeAngle } from '../src/game/geometry.js';

const DT = 1 / 30;

test('new snake has the original 30 sections plus head, evenly spaced behind the head', () => {
    const s = new Snake({ id: 1, name: 'a', x: 100, y: 50, heading: 0 });
    assert.equal(s.length, SNAKE.startSections + 1);
    assert.equal(s.score, 0);
    assert.equal(s.x, 100);
    for (let i = 1; i < s.length; i++) {
        const d = Math.hypot(s.secX[i] - s.secX[i - 1], s.secY[i] - s.secY[i - 1]);
        assert.ok(Math.abs(d - SNAKE.spacingFactor * SNAKE.startScale) < 1e-6, `spacing at ${i} = ${d}`);
        assert.ok(s.secX[i] < s.secX[i - 1], 'body trails behind a head facing +x');
    }
});

test('moves at slow speed, and fast speed when boosting', () => {
    const s = new Snake({ id: 1, name: 'a', x: 0, y: 0, heading: 0 });
    for (let i = 0; i < 30; i++) s.step(DT);
    assert.ok(Math.abs(s.x - SNAKE.slowSpeed) < 1e-6);
    s.setIntent(0, true);
    const before = s.x;
    for (let i = 0; i < 30; i++) s.step(DT);
    assert.ok(Math.abs(s.x - before - SNAKE.fastSpeed) < 1e-6);
});

test('turn rate is bounded by turnRate (2 rad/s)', () => {
    const s = new Snake({ id: 1, name: 'a', x: 0, y: 0, heading: 0 });
    s.setIntent(Math.PI / 2, false);
    s.step(DT);
    assert.ok(Math.abs(s.heading - SNAKE.turnRate * DT) < 1e-9);
    for (let i = 0; i < 60; i++) s.step(DT);
    assert.ok(Math.abs(normalizeAngle(s.heading - Math.PI / 2)) < 1e-9, 'reaches target and stops turning');
});

test('body follows the head path (sections stay spaced while turning)', () => {
    const s = new Snake({ id: 1, name: 'a', x: 0, y: 0, heading: 0 });
    s.setIntent(Math.PI, false); // U-turn
    for (let i = 0; i < 120; i++) s.step(DT);
    const spacing = SNAKE.spacingFactor * s.scale;
    for (let i = 1; i < s.length; i++) {
        const d = Math.hypot(s.secX[i] - s.secX[i - 1], s.secY[i] - s.secY[i - 1]);
        assert.ok(d <= spacing + 1e-6, `chord ${d} must not exceed arc spacing`);
        assert.ok(d > spacing * 0.8, `sections stay apart (${d})`);
    }
    assert.ok(s.pathX.length < 200, 'old path history is trimmed');
});

test('grow() adds a section and scales by 1.01, capped', () => {
    const s = new Snake({ id: 1, name: 'a', x: 0, y: 0, heading: 0 });
    s.grow(1);
    assert.equal(s.length, SNAKE.startSections + 2);
    assert.equal(s.score, 1);
    assert.ok(Math.abs(s.scale - SNAKE.startScale * 1.01) < 1e-12);
    // Regression: sections must be defined immediately after growing (before the next step),
    // otherwise snapshots serialise the new tail as null and clients draw it at (0, 0).
    assert.equal(s.secX.length, s.length);
    assert.ok(Number.isFinite(s.secX[s.length - 1]) && Number.isFinite(s.secY[s.length - 1]));
    assert.equal(s.secX[s.length - 1], s.secX[s.length - 2]);
    s.grow(1000);
    assert.equal(s.secX.length, s.length);
    assert.equal(s.length, SNAKE.maxSections);
    assert.equal(s.scale, SNAKE.maxScale);
});
