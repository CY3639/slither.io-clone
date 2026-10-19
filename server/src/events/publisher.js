import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 10; // SQS SendMessageBatch limit

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Buffers domain events in memory and ships them in batches through a sink (SQS in AWS).
 * The tick loop only calls publish(), which is O(1) and never awaits the network.
 *
 * Failure handling:
 *  - entries the sink rejects are retried with exponential backoff + jitter, up to maxRetries;
 *  - after that the full event is written to the log (EVENT_DROPPED) so it is recoverable;
 *  - the buffer is bounded; on overflow the oldest event is dropped and logged.
 * Every event carries a unique eventId, so the consumer can de-duplicate the redeliveries that
 * at-least-once delivery implies.
 */
export class EventPublisher {
    constructor({ sink, logger, identity, flushIntervalMs = 1000, maxBuffer = 5000, maxRetries = 4, baseDelayMs = 200, metrics }) {
        this.sink = sink;
        this.log = logger;
        this.identity = identity;
        this.flushIntervalMs = flushIntervalMs;
        this.maxBuffer = maxBuffer;
        this.maxRetries = maxRetries;
        this.baseDelayMs = baseDelayMs;
        this.metrics = metrics;
        this.buffer = [];
        this.flushing = null;
        this.timer = null;
        this.published = 0;
        this.dropped = 0;
    }

    start() {
        this.timer = setInterval(() => this.flush().catch(() => {}), this.flushIntervalMs);
        this.timer.unref();
    }

    publish(type, payload, { worldId } = {}) {
        const event = {
            eventId: randomUUID(),
            type,
            version: 1,
            occurredAt: new Date().toISOString(),
            worldId: worldId ?? null,
            taskId: this.identity.taskShort,
            payload,
        };
        if (this.buffer.length >= this.maxBuffer) {
            const lost = this.buffer.shift();
            this.dropped++;
            this.log.error('event_dropped', { reason: 'buffer_full', event: lost.event });
        }
        this.buffer.push({ event, attempts: 0 });
        this.log.info('event_published', { eventId: event.eventId, eventType: type, worldId: event.worldId, playerId: payload?.playerId });
        if (this.buffer.length >= BATCH_SIZE) queueMicrotask(() => this.flush().catch(() => {}));
        return event;
    }

    /** Send everything currently buffered. Concurrent callers share the same in-flight flush. */
    flush() {
        if (!this.flushing) {
            this.flushing = this.drainOnce().finally(() => {
                this.flushing = null;
            });
        }
        return this.flushing;
    }

    async drainOnce() {
        while (this.buffer.length) {
            const batch = this.buffer.splice(0, BATCH_SIZE);
            let failed;
            try {
                failed = await this.sink.sendBatch(batch.map((b) => b.event));
            } catch (err) {
                // Whole-batch failure (network, throttling, credentials): retry all entries.
                this.log.warn('event_batch_failed', { err, count: batch.length });
                failed = batch.map((b) => b.event.eventId);
            }
            this.published += batch.length - failed.length;
            if (failed.length === 0) continue;

            const failedSet = new Set(failed);
            const retry = [];
            for (const entry of batch) {
                if (!failedSet.has(entry.event.eventId)) continue;
                entry.attempts++;
                if (entry.attempts > this.maxRetries) {
                    this.dropped++;
                    this.metrics?.count('EventsDropped');
                    this.log.error('event_dropped', { reason: 'max_retries', event: entry.event });
                } else {
                    retry.push(entry);
                }
            }
            if (retry.length) {
                const attempt = Math.max(...retry.map((r) => r.attempts));
                const delay = this.baseDelayMs * 2 ** (attempt - 1);
                await sleep(delay / 2 + Math.random() * (delay / 2)); // "equal jitter" backoff
                this.buffer.unshift(...retry);
            }
        }
    }

    /** Flush on shutdown, bounded by a deadline so SIGTERM handling cannot hang. */
    async close(timeoutMs = 5000) {
        if (this.timer) clearInterval(this.timer);
        const deadline = sleep(timeoutMs).then(() => 'timeout');
        const result = await Promise.race([this.flush().then(() => 'flushed'), deadline]);
        if (result === 'timeout' && this.buffer.length) {
            for (const entry of this.buffer) this.log.error('event_dropped', { reason: 'shutdown_timeout', event: entry.event });
        }
        return result;
    }
}
