// DynamoDB single-table store. Key design (see docs/aws-architecture.md):
//   PLAYER#<id> / PROFILE                 aggregates + sparse GSI1 (GSI1PK='LB', GSI1SK=bestScore)
//   PLAYER#<id> / DEATH#<time>#<eventId>  death history
//   WORLD#<id>  / META                    world lifecycle
//   EVENT#<id>  / EVENT                   idempotency marker (TTL 7 days)
//
// Idempotency: SQS is at-least-once, so the same event can be delivered twice. Non-idempotent
// changes (ADD counters, insert history) go in ONE transaction together with a conditional
// put of the event marker; a redelivery fails the condition and changes nothing.
// The best-score update is a conditional "max", which is naturally idempotent, so it runs first
// and outside the transaction: a crash between the two steps can never lose a high score.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const LEADERBOARD_PK = 'LB';
const MARKER_TTL_SECONDS = 7 * 24 * 3600;

export function createDocClient(region) {
    return DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 4 }), {
        marshallOptions: { removeUndefinedValues: true },
    });
}

export class DynamoStore {
    constructor({ doc, tableName, now = () => new Date() }) {
        this.doc = doc;
        this.table = tableName;
        this.now = now;
    }

    async apply(evt) {
        switch (evt.type) {
            case 'PLAYER_DIED':
                return this.playerDied(evt);
            case 'SESSION_ENDED':
                return this.sessionEnded(evt);
            case 'WORLD_STARTED':
                return this.worldStarted(evt);
            case 'WORLD_COMPLETED':
                return this.worldCompleted(evt);
            default:
                throw new Error(`no handler for ${evt.type}`);
        }
    }

    marker(evt) {
        return {
            Put: {
                TableName: this.table,
                Item: {
                    PK: `EVENT#${evt.eventId}`,
                    SK: 'EVENT',
                    type: evt.type,
                    worldId: evt.worldId,
                    processedAt: this.now().toISOString(),
                    ttl: Math.floor(this.now().getTime() / 1000) + MARKER_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
            },
        };
    }

    /** Run marker + items atomically. Returns 'applied' or 'duplicate'. */
    async transact(evt, items) {
        try {
            await this.doc.send(new TransactWriteCommand({ TransactItems: [this.marker(evt), ...items] }));
            return 'applied';
        } catch (err) {
            const reasons = err.CancellationReasons ?? [];
            if (err.name === 'TransactionCanceledException' && reasons[0]?.Code === 'ConditionalCheckFailed') {
                return 'duplicate';
            }
            throw err;
        }
    }

    /** Raise bestScore only if the new score is higher. Returns true if it changed. */
    async raiseBestScore(playerId, displayName, score) {
        if (score <= 0) return false;
        try {
            await this.doc.send(
                new UpdateCommand({
                    TableName: this.table,
                    Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' },
                    UpdateExpression: 'SET bestScore = :s, GSI1PK = :lb, GSI1SK = :s, bestScoreAt = :now, displayName = :n',
                    ConditionExpression: 'attribute_not_exists(bestScore) OR bestScore < :s',
                    ExpressionAttributeValues: { ':s': score, ':lb': LEADERBOARD_PK, ':now': this.now().toISOString(), ':n': displayName },
                }),
            );
            return true;
        } catch (err) {
            if (err.name === 'ConditionalCheckFailedException') return false;
            throw err;
        }
    }

    async playerDied(evt) {
        const p = evt.payload;
        const newBest = await this.raiseBestScore(p.playerId, p.displayName, p.score);
        const result = await this.transact(evt, [
            {
                Update: {
                    TableName: this.table,
                    Key: { PK: `PLAYER#${p.playerId}`, SK: 'PROFILE' },
                    UpdateExpression: 'SET displayName = :n, updatedAt = :now ADD deaths :one, kills :k',
                    ExpressionAttributeValues: { ':n': p.displayName, ':now': this.now().toISOString(), ':one': 1, ':k': p.kills },
                },
            },
            {
                Put: {
                    TableName: this.table,
                    Item: {
                        PK: `PLAYER#${p.playerId}`,
                        SK: `DEATH#${evt.occurredAt}#${evt.eventId}`,
                        score: p.score,
                        length: p.length,
                        kills: p.kills,
                        killedBy: p.killedBy,
                        survivedMs: p.survivedMs,
                        worldId: evt.worldId,
                        taskId: evt.taskId,
                    },
                },
            },
        ]);
        return { result, newBest };
    }

    async sessionEnded(evt) {
        const p = evt.payload;
        const newBest = await this.raiseBestScore(p.playerId, p.displayName, p.bestScore);
        const result = await this.transact(evt, [
            {
                Update: {
                    TableName: this.table,
                    Key: { PK: `PLAYER#${p.playerId}`, SK: 'PROFILE' },
                    UpdateExpression: 'SET displayName = :n, updatedAt = :now ADD sessions :one, playMs :ms',
                    ExpressionAttributeValues: { ':n': p.displayName, ':now': this.now().toISOString(), ':one': 1, ':ms': p.playedMs },
                },
            },
        ]);
        return { result, newBest };
    }

    // World events use SET (not Put) so STARTED/COMPLETED commute: SQS standard queues do not
    // guarantee ordering, and either may arrive first.
    async worldStarted(evt) {
        const p = evt.payload;
        const result = await this.transact(evt, [
            {
                Update: {
                    TableName: this.table,
                    Key: { PK: `WORLD#${evt.worldId}`, SK: 'META' },
                    UpdateExpression: 'SET startedAt = :t, taskId = :task, startHumans = :h, startNpcs = :n, lobbyWaitMs = :w, startReason = :r',
                    ExpressionAttributeValues: {
                        ':t': evt.occurredAt,
                        ':task': evt.taskId,
                        ':h': p.humans,
                        ':n': p.npcs,
                        ':w': p.lobbyWaitMs,
                        ':r': p.reason ?? 'unknown',
                    },
                },
            },
        ]);
        return { result };
    }

    async worldCompleted(evt) {
        const p = evt.payload;
        const result = await this.transact(evt, [
            {
                Update: {
                    TableName: this.table,
                    Key: { PK: `WORLD#${evt.worldId}`, SK: 'META' },
                    UpdateExpression: 'SET completedAt = :t, taskId = :task, durationMs = :d, peakHumans = :p, humanDeaths = :hd, endReason = :r',
                    ExpressionAttributeValues: {
                        ':t': evt.occurredAt,
                        ':task': evt.taskId,
                        ':d': p.durationMs,
                        ':p': p.peakHumans,
                        ':hd': p.humanDeaths ?? 0,
                        ':r': p.reason ?? 'unknown',
                    },
                },
            },
        ]);
        return { result };
    }

    /** Top-N by best score from the sparse GSI. A Query, never a Scan. */
    async leaderboard(limit) {
        const out = await this.doc.send(
            new QueryCommand({
                TableName: this.table,
                IndexName: 'GSI1',
                KeyConditionExpression: 'GSI1PK = :lb',
                ExpressionAttributeValues: { ':lb': LEADERBOARD_PK },
                ScanIndexForward: false,
                Limit: limit,
                ProjectionExpression: 'displayName, bestScore, bestScoreAt',
            }),
        );
        return (out.Items ?? []).map((item, i) => ({
            rank: i + 1,
            displayName: item.displayName,
            bestScore: item.bestScore,
            bestScoreAt: item.bestScoreAt,
        }));
    }

    async player(playerId) {
        const out = await this.doc.send(
            new GetCommand({
                TableName: this.table,
                Key: { PK: `PLAYER#${playerId}`, SK: 'PROFILE' },
                ProjectionExpression: 'displayName, bestScore, deaths, kills, sessions, playMs, updatedAt',
            }),
        );
        return out.Item ?? null;
    }
}
