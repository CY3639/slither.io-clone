// Event sinks. Each sendBatch(events) resolves to the list of eventIds that failed and should be retried.

/** Writes events to the log only (default for local runs without the local cloud emulator). */
export function createLogSink(logger) {
    return {
        name: 'log',
        async sendBatch(events) {
            for (const event of events) logger.info('event_sink_log', { event });
            return [];
        },
    };
}

/** POSTs a batch to tools/local-cloud.mjs, which runs the real Lambda handler locally. */
export function createHttpSink(url) {
    return {
        name: 'http',
        async sendBatch(events) {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ events }),
                signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) throw new Error(`local cloud responded ${res.status}`);
            return [];
        },
    };
}

/** Amazon SQS. Credentials come from the ECS task role; nothing is baked into the image. */
export async function createSqsSink({ queueUrl, region }) {
    if (!queueUrl) throw new Error('EVENTS_QUEUE_URL is required when EVENT_SINK=sqs');
    const { SQSClient, SendMessageBatchCommand } = await import('@aws-sdk/client-sqs');
    // The SDK's own retries (3 attempts, adaptive) handle throttling; the publisher retries per entry.
    const client = new SQSClient({ region, maxAttempts: 3, retryMode: 'adaptive' });
    return {
        name: 'sqs',
        async sendBatch(events) {
            const out = await client.send(
                new SendMessageBatchCommand({
                    QueueUrl: queueUrl,
                    Entries: events.map((event, idx) => ({
                        Id: String(idx),
                        MessageBody: JSON.stringify(event),
                        MessageAttributes: {
                            type: { DataType: 'String', StringValue: event.type },
                            eventId: { DataType: 'String', StringValue: event.eventId },
                        },
                    })),
                }),
            );
            return (out.Failed ?? []).map((f) => events[Number(f.Id)].eventId);
        },
    };
}

export async function createSink(eventsConfig, { logger, region }) {
    switch (eventsConfig.sink) {
        case 'sqs':
            return createSqsSink({ queueUrl: eventsConfig.queueUrl, region });
        case 'http':
            if (!eventsConfig.httpUrl) throw new Error('EVENT_HTTP_URL is required when EVENT_SINK=http');
            return createHttpSink(eventsConfig.httpUrl);
        case 'log':
            return createLogSink(logger);
        default:
            throw new Error(`Unknown EVENT_SINK ${eventsConfig.sink}`);
    }
}
