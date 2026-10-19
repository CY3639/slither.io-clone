#!/usr/bin/env node
// Start the local cloud emulator and the game server together (Ctrl+C stops both).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [
    spawn(process.execPath, ['tools/local-cloud.mjs'], { cwd: root, stdio: 'inherit' }),
    spawn('npm', ['--prefix', 'server', 'run', 'dev'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT ?? '8080' } }),
];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((c) => c.on('exit', (code) => code && stop()));
