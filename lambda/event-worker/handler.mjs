import { parseEvent, ValidationError } from '../lib/validate.mjs';
import { log as defaultLog } from '../lib/log.mjs';

/**
 * SQS → DynamoDB worker. Uses partial batch responses (ReportBatchItemFailures): only failed
 * records go back on the queue, so one bad message doesn't make SQS redeliver the whole batch.
 *  - malformed message  → failure → retried until maxReceiveCount → dead-letter queue
 *  - transient AWS error → failure → retried after the visibility timeout
 *  - duplicate delivery  → success, no effect (idempotency marker)
 */
export function createHandler({ store, log = defaultLog }) {
    return async function handler(event) {
        const batchItemFailures = [];
        for (const record of event.Records ?? []) {
            const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? 1);
            let evt;
            try {
                evt = parseEvent(record.body);
                const outcome = await store.apply(evt);
                log('info', 'event_processed', {
                    eventId: evt.eventId,
                    eventType: evt.type,
                    worldId: evt.worldId,
                    playerId: evt.payload.playerId,
                    result: outcome.result,
                    newBest: outcome.newBest || undefined,
                    receiveCount,
                    messageId: record.messageId,
                });
            } catch (err) {
                batchItemFailures.push({ itemIdentifier: record.messageId });
                if (err instanceof ValidationError) {
                    log('error', 'event_malformed', { messageId: record.messageId, reason: err.message, receiveCount });
                } else {
                    log('error', 'event_failed', { messageId: record.messageId, eventId: evt?.eventId, receiveCount, err });
                }
            }
        }
        log('info', 'batch_complete', { records: event.Records?.length ?? 0, failed: batchItemFailures.length });
        return { batchItemFailures };
    };
}
