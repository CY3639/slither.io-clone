import os from 'node:os';

/**
 * Identify this task. On Fargate the task metadata endpoint v4 gives the task ARN; locally
 * fall back to the hostname. taskShort is used in worldIds and logs.
 */
export async function resolveIdentity(logger) {
    const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (metadataUri) {
        try {
            const res = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2000) });
            const meta = await res.json();
            const taskId = meta.TaskARN.split('/').pop();
            return { taskId, taskShort: taskId.slice(0, 8), az: meta.AvailabilityZone ?? null };
        } catch (err) {
            logger.warn('task_metadata_unavailable', { err });
        }
    }
    const host = os.hostname();
    return { taskId: host, taskShort: host.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'local', az: null };
}

/**
 * ECS task scale-in protection. While a world has players, the task asks ECS not to pick it
 * when the service scales in, so auto-scaling never terminates a game in progress. Protection is
 * renewed periodically (it expires on its own if the process dies) and released when idle.
 * https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection-endpoint.html
 */
export function createTaskProtection({ enabled, logger, expiresInMinutes = 15, renewEveryMs = 5 * 60 * 1000 }) {
    const agentUri = process.env.ECS_AGENT_URI;
    let desired = false;
    let renewTimer = null;

    async function put(protectionEnabled) {
        if (!enabled || !agentUri) return;
        try {
            const res = await fetch(`${agentUri}/task-protection/v1/state`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                    protectionEnabled ? { ProtectionEnabled: true, ExpiresInMinutes: expiresInMinutes } : { ProtectionEnabled: false },
                ),
                signal: AbortSignal.timeout(3000),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.failure) {
                logger.warn('task_protection_failed', { protectionEnabled, status: res.status, failure: body.failure ?? body.error });
            } else {
                logger.info('task_protection_set', { protectionEnabled, expiresInMinutes: protectionEnabled ? expiresInMinutes : 0 });
            }
        } catch (err) {
            logger.warn('task_protection_failed', { protectionEnabled, err });
        }
    }

    return {
        set(active) {
            if (active === desired) return;
            desired = active;
            clearInterval(renewTimer);
            renewTimer = null;
            put(active);
            if (active) {
                renewTimer = setInterval(() => put(true), renewEveryMs);
                renewTimer.unref();
            }
        },
        async release() {
            clearInterval(renewTimer);
            desired = false;
            await put(false);
        },
    };
}
