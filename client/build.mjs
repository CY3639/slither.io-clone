#!/usr/bin/env node
// Production build for S3/CloudFront (no bundler needed for Phaser 2 global scripts):
//  - concatenates src/*.js (in index.html order) into app.<hash>.js
//  - fingerprints Phaser, CSS and every PNG with a content hash
//  - injects window.ASSET_URLS so the game loads the hashed PNGs
//  - writes dist/index.html plus dist/cache-manifest.json, which tells deploy-frontend.sh
//    which objects are immutable (1-year cache) and which must revalidate (index.html).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, 'asset'), { recursive: true });
mkdirSync(path.join(dist, 'lib'), { recursive: true });

const immutable = [];

function emit(relDir, name, ext, content) {
    const file = `${relDir ? relDir + '/' : ''}${name}.${hash(content)}${ext}`;
    writeFileSync(path.join(dist, file), content);
    immutable.push(file);
    return file;
}

// 1. Images
const assetUrls = {};
for (const file of readdirSync(path.join(root, 'asset')).filter((f) => f.endsWith('.png'))) {
    const content = readFileSync(path.join(root, 'asset', file));
    assetUrls[file] = emit('asset', path.basename(file, '.png'), '.png', content);
}

// 2. Phaser (vendor, kept separate so app changes don't invalidate it)
const phaserFile = emit('lib', 'phaser-2.6.2.min', '.js', readFileSync(path.join(root, 'lib', 'phaser.min.js')));

// 3. App bundle in the order index.html lists the sources
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const jsBlock = html.match(/<!-- build:js -->([\s\S]*?)<!-- endbuild -->/);
const cssBlock = html.match(/<!-- build:css -->([\s\S]*?)<!-- endbuild -->/);
if (!jsBlock || !cssBlock) throw new Error('index.html is missing build markers');
const sources = [...jsBlock[1].matchAll(/src="(src\/[^"]+)"/g)].map((m) => m[1]);
const banner = `/* Battle Snake client — built ${new Date().toISOString()} */\n`;
const app = banner + `window.ASSET_URLS = ${JSON.stringify(assetUrls)};\n` + sources.map((s) => `\n/* ${s} */\n` + readFileSync(path.join(root, s), 'utf8')).join('\n');
const appFile = emit('', 'app', '.js', Buffer.from(app));

// 4. CSS
const cssFile = emit('', 'styles', '.css', readFileSync(path.join(root, 'styles.css')));

// 5. HTML (never fingerprinted; must revalidate so new deployments are picked up)
const out = html
    .replace(cssBlock[0], `<link rel="stylesheet" href="${cssFile}" />`)
    .replace(jsBlock[0], `<script src="${phaserFile}"></script>\n    <script src="${appFile}"></script>`);
writeFileSync(path.join(dist, 'index.html'), out);

writeFileSync(
    path.join(dist, 'cache-manifest.json'),
    JSON.stringify({ immutable, revalidate: ['index.html'], builtAt: new Date().toISOString() }, null, 2),
);
console.log(JSON.stringify({ dist, files: immutable.length + 1, app: appFile, phaser: phaserFile }, null, 2));
