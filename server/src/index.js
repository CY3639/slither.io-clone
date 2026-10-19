import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = await createApp(config);
await app.start();

// ECS sends SIGTERM on scale-in or deployment (after ALB deregistration), then SIGKILL after
// stopTimeout. Shut down well inside that window.
let stopping = false;
async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), config.shutdownGraceMs + 2000);
    force.unref();
    try {
        await app.stop(signal);
        process.exit(0);
    } catch (err) {
        app.logger.error('shutdown_failed', { err });
        process.exit(1);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => app.logger.error('unhandled_rejection', { err }));
