// Custom metrics via CloudWatch Embedded Metric Format (EMF). Each interval the server prints one
// JSON line; the awslogs driver ships it to CloudWatch Logs, which extracts the metrics. No
// PutMetricData calls or SDK are needed.
//
// Dimension = ServiceName only (no per-task dimension), so the Average across tasks is the
// fleet-wide value. That is what the ECS target-tracking policy on WorldOccupancyPct consumes.

export class Metrics {
    constructor({ enabled, namespace, serviceName, intervalMs, logger, sample }) {
        this.enabled = enabled;
        this.namespace = namespace;
        this.serviceName = serviceName;
        this.intervalMs = intervalMs;
        this.log = logger;
        this.sample = sample; // () => gauges for this interval
        this.counters = new Map();
        this.tickDurations = [];
        this.timer = null;
    }

    start() {
        if (!this.enabled) return;
        this.timer = setInterval(() => this.emit(), this.intervalMs);
        this.timer.unref();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }

    count(name, value = 1) {
        this.counters.set(name, (this.counters.get(name) ?? 0) + value);
    }

    add(name, value) {
        this.count(name, value);
    }

    recordTick(ms) {
        this.tickDurations.push(ms);
    }

    /** Build the EMF record for the interval and reset accumulators. Returned for tests. */
    emit() {
        const gauges = this.sample();
        const ticks = this.tickDurations.sort((a, b) => a - b);
        this.tickDurations = [];
        const p = (q) => (ticks.length ? ticks[Math.min(ticks.length - 1, Math.floor(q * ticks.length))] : 0);
        const seconds = this.intervalMs / 1000;

        const values = {
            HumanPlayers: gauges.humans,
            WorldOccupancyPct: (gauges.humans / gauges.maxHumans) * 100,
            EntityCount: gauges.entities,
            ConnectedClients: gauges.connections,
            WorldActive: gauges.active ? 1 : 0,
            TickDurationP50Ms: round(p(0.5)),
            TickDurationP99Ms: round(p(0.99)),
            SnapshotBytesPerSec: Math.round((this.counters.get('SnapshotBytes') ?? 0) / seconds),
            WorldStarted: this.counters.get('WorldStarted') ?? 0,
            WorldEnded: this.counters.get('WorldEnded') ?? 0,
            EventsDropped: this.counters.get('EventsDropped') ?? 0,
        };
        this.counters.clear();

        const units = {
            WorldOccupancyPct: 'Percent',
            TickDurationP50Ms: 'Milliseconds',
            TickDurationP99Ms: 'Milliseconds',
            SnapshotBytesPerSec: 'Bytes/Second',
        };
        const record = {
            _aws: {
                Timestamp: Date.now(),
                CloudWatchMetrics: [
                    {
                        Namespace: this.namespace,
                        Dimensions: [['ServiceName']],
                        Metrics: Object.keys(values).map((Name) => ({ Name, Unit: units[Name] ?? 'Count' })),
                    },
                ],
            },
            ServiceName: this.serviceName,
            msg: 'metrics',
            worldId: gauges.worldId,
            taskId: gauges.taskId,
            ...values,
        };
        if (this.enabled) this.log.raw(record);
        return record;
    }
}

function round(v) {
    return Math.round(v * 100) / 100;
}
