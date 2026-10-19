import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientMessage, sanitizeName } from '../src/net/protocol.js';
import { RateLimiter } from '../src/net/rateLimiter.js';

test('rejects non-JSON, non-objects and unknown types', () => {
    assert.equal(parseClientMessage('not json').ok, false);
    assert.equal(parseClientMessage('[1,2]').ok, false);
    assert.equal(parseClientMessage('{"t":"teleport","x":0}').ok, false);
    assert.equal(parseClientMessage('{"x":1}').ok, false);
});

test('input requires a finite angle; boost coerced to boolean', () => {
    assert.equal(parseClientMessage('{"t":"in","a":"up"}').ok, false);
    assert.equal(parseClientMessage('{"t":"in","a":1e9}').ok, false);
    assert.equal(parseClientMessage('{"t":"in"}').ok, false);
    assert.deepEqual(parseClientMessage('{"t":"in","a":1.5,"b":1}').msg, { t: 'in', a: 1.5, b: true });
    assert.deepEqual(parseClientMessage('{"t":"in","a":-1,"b":"yes"}').msg, { t: 'in', a: -1, b: false });
});

test('client cannot send position, score or length (extra fields are discarded)', () => {
    const r = parseClientMessage('{"t":"in","a":0,"x":999,"score":100000,"length":500}');
    assert.deepEqual(r.msg, { t: 'in', a: 0, b: false });
});

test('join sanitises name, validates ids and clamps viewport', () => {
    const r = parseClientMessage(JSON.stringify({ t: 'join', name: '<script>alert(1)</script>Bob', pid: 'nope', vw: 99999, vh: -5 }));
    assert.equal(r.ok, true);
    assert.equal(r.msg.name.includes('<'), false);
    assert.ok(r.msg.name.length <= 16);
    assert.equal(r.msg.pid, null);
    assert.equal(r.msg.vw, 2560);
    assert.equal(r.msg.vh, 240);
});

test('sanitizeName caps length and defaults to Anonymous', () => {
    assert.equal(sanitizeName('   '), 'Anonymous');
    assert.equal(sanitizeName(42), 'Anonymous');
    assert.equal(sanitizeName('a'.repeat(50)).length, 16);
    assert.equal(sanitizeName('Zoë  the   Snake'), 'Zoë the Snake');
});

test('rate limiter allows the burst then throttles until tokens refill', () => {
    let t = 0;
    const rl = new RateLimiter({ ratePerSecond: 10, burst: 10, now: () => t });
    for (let i = 0; i < 10; i++) assert.equal(rl.take(), true);
    assert.equal(rl.take(), false);
    t += 500;
    for (let i = 0; i < 5; i++) assert.equal(rl.take(), true);
    assert.equal(rl.take(), false);
    assert.equal(rl.dropped, 2);
});
