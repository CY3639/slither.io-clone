import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoStore } from '../lib/dynamoStore.mjs';

/** Fake DocumentClient: records commands and lets a test script responses. */
function fakeDoc(responder = () => ({})) {
    const sent = [];
    return {
        sent,
        async send(cmd) {
            sent.push({ name: cmd.constructor.name, input: cmd.input });
            return responder(cmd.constructor.name, cmd.input);
        },
    };
}

const evt = {
    eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    type: 'PLAYER_DIED',
    version: 1,
    occurredAt: '2026-10-19T00:00:00.000Z',
    worldId: 'w-1',
    taskId: 't',
    payload: { playerId: '11111111-2222-4333-8444-555555555555', displayName: 'Bob', score: 42, length: 73, kills: 2, killedBy: { type: 'boundary' }, survivedMs: 1000 },
};

test('PLAYER_DIED: conditional max update first, then one transaction with the idempotency marker', async () => {
    const doc = fakeDoc();
    const store = new DynamoStore({ doc, tableName: 'tbl', now: () => new Date('2026-10-19T00:00:01Z') });
    const out = await store.apply(evt);
    assert.deepEqual(out, { result: 'applied', newBest: true });

    const [best, tx] = doc.sent;
    assert.equal(best.name, 'UpdateCommand');
    assert.match(best.input.ConditionExpression, /bestScore < :s/);
    assert.equal(best.input.ExpressionAttributeValues[':s'], 42);
    assert.equal(best.input.ExpressionAttributeValues[':lb'], 'LB');

    assert.equal(tx.name, 'TransactWriteCommand');
    const [marker, profile, death] = tx.input.TransactItems;
    assert.equal(marker.Put.Item.PK, `EVENT#${evt.eventId}`);
    assert.equal(marker.Put.ConditionExpression, 'attribute_not_exists(PK)');
    assert.ok(marker.Put.Item.ttl > 0);
    assert.match(profile.Update.UpdateExpression, /ADD deaths :one, kills :k/);
    assert.equal(death.Put.Item.SK, `DEATH#${evt.occurredAt}#${evt.eventId}`);
});

test('a redelivered event (marker exists) is reported as duplicate, not an error', async () => {
    const doc = fakeDoc((name) => {
        if (name === 'UpdateCommand') {
            const err = new Error('cond');
            err.name = 'ConditionalCheckFailedException';
            throw err;
        }
        if (name === 'TransactWriteCommand') {
            const err = new Error('cancelled');
            err.name = 'TransactionCanceledException';
            err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }, { Code: 'None' }];
            throw err;
        }
        return {};
    });
    const store = new DynamoStore({ doc, tableName: 'tbl' });
    assert.deepEqual(await store.apply(evt), { result: 'duplicate', newBest: false });
});

test('other transaction failures propagate so SQS retries the message', async () => {
    const doc = fakeDoc((name) => {
        if (name === 'TransactWriteCommand') {
            const err = new Error('throttled');
            err.name = 'TransactionCanceledException';
            err.CancellationReasons = [{ Code: 'None' }, { Code: 'ThrottlingError' }];
            throw err;
        }
        return {};
    });
    const store = new DynamoStore({ doc, tableName: 'tbl' });
    await assert.rejects(store.apply(evt), /throttled/);
});

test('leaderboard is a descending Query on GSI1 (no Scan)', async () => {
    const doc = fakeDoc(() => ({ Items: [{ displayName: 'A', bestScore: 90 }, { displayName: 'B', bestScore: 50 }] }));
    const store = new DynamoStore({ doc, tableName: 'tbl' });
    const items = await store.leaderboard(10);
    const q = doc.sent[0];
    assert.equal(q.name, 'QueryCommand');
    assert.equal(q.input.IndexName, 'GSI1');
    assert.equal(q.input.ScanIndexForward, false);
    assert.equal(q.input.Limit, 10);
    assert.deepEqual(items.map((i) => i.rank), [1, 2]);
});
