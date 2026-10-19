#!/usr/bin/env node
// Turn a CloudWatch export (evidence/aws/E15-cloudwatch-metrics-*.csv, produced by
// infra/scripts/collect-evidence.sh) into SVG line charts for the report. No dependencies.
// Usage: node report/make-charts.mjs evidence/aws/E15-cloudwatch-metrics-<ts>.csv [HH:MM-HH:MM in AEST]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [csvPath, window] = process.argv.slice(2);
if (!csvPath) throw new Error('usage: make-charts.mjs <csv> [HH:MM-HH:MM]');
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'figures');
mkdirSync(outDir, { recursive: true });

const [header, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n');
const cols = header.split(',');
let rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], i === 0 ? v : v === '' ? null : Number(v)])));
// HumanPlayers is emitted every 10 s by each task (EMF), so a 1-minute Sum counts each player 6 times.
rows.forEach((r) => {
    if (r.humans !== null && r.humans !== undefined) r.humans = Math.round(r.humans / 6);
});
if (window) {
    const [from, to] = window.split('-');
    rows = rows.filter((r) => r.time >= from && r.time <= to);
}
// The AWS CLI renders get-metric-data timestamps in the caller's local zone (AEST here), so the
// CSV times are already Brisbane time and the window argument is given in AEST too.
const local = (t) => t;

const COLORS = ['#ed7100', '#2e27ad', '#3f8624', '#e7157b', '#147eba', '#8c4fff'];

function chart({ file, title, series, yMax, yLabel, step = false, annotations = [] }) {
    const W = 760, H = 300, L = 56, R = 16, T = 34, B = 46;
    const n = rows.length;
    const xs = (i) => L + (n <= 1 ? 0 : (i * (W - L - R)) / (n - 1));
    const max = yMax ?? Math.max(1, ...series.flatMap((s) => rows.map((r) => r[s.key] ?? 0))) * 1.15;
    const ys = (v) => T + (H - T - B) * (1 - v / max);
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="11">`;
    svg += `<rect width="${W}" height="${H}" fill="#fff"/><text x="${L}" y="18" font-weight="bold" font-size="13">${title}</text>`;
    for (let k = 0; k <= 4; k++) {
        const v = (max * k) / 4;
        svg += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="#e5e5e5"/><text x="${L - 6}" y="${ys(v) + 4}" text-anchor="end" fill="#555">${+v.toFixed(v < 10 ? 1 : 0)}</text>`;
    }
    svg += `<text transform="translate(14 ${(H - B + T) / 2}) rotate(-90)" text-anchor="middle" fill="#555">${yLabel}</text>`;
    const every = Math.max(1, Math.ceil(n / 10));
    rows.forEach((r, i) => {
        if (i % every === 0) svg += `<text x="${xs(i)}" y="${H - B + 16}" text-anchor="middle" fill="#555">${local(r.time)}</text>`;
    });
    svg += `<text x="${(W + L) / 2}" y="${H - 8}" text-anchor="middle" fill="#555">time (AEST, 1-minute datapoints)</text>`;
    for (const a of annotations) {
        svg += `<line x1="${L}" x2="${W - R}" y1="${ys(a.value)}" y2="${ys(a.value)}" stroke="#d00" stroke-dasharray="5 4"/><text x="${W - R - 4}" y="${ys(a.value) - 4}" text-anchor="end" fill="#d00">${a.label}</text>`;
    }
    series.forEach((s, si) => {
        let d = '';
        let prev = null;
        rows.forEach((r, i) => {
            const v = r[s.key];
            if (v === null || v === undefined) return;
            if (prev === null) d += `M${xs(i)},${ys(v)}`;
            else if (step) d += `H${xs(i)}V${ys(v)}`;
            else d += `L${xs(i)},${ys(v)}`;
            prev = v;
        });
        svg += `<path d="${d}" fill="none" stroke="${COLORS[si]}" stroke-width="2"${s.dash ? ' stroke-dasharray="6 4"' : ''}/>`;
        svg += `<rect x="${L + 10 + si * 170}" y="${T - 8}" width="12" height="4" fill="${COLORS[si]}"/><text x="${L + 26 + si * 170}" y="${T - 4}" fill="#333">${s.label}</text>`;
    });
    svg += '</svg>';
    writeFileSync(path.join(outDir, file), svg);
    console.log(`wrote report/figures/${file} (${n} points)`);
}

chart({
    file: 'chart-tasks.svg',
    title: 'ECS service: desired vs running tasks during the load test',
    series: [{ key: 'desired', label: 'DesiredTaskCount' }, { key: 'running', label: 'RunningTaskCount', dash: true }],
    yMax: 8, yLabel: 'tasks', step: true,
});
chart({
    file: 'chart-occupancy.svg',
    title: 'World occupancy (scaling metric) and connected humans',
    series: [{ key: 'occupancy', label: 'WorldOccupancyPct (avg)' }, { key: 'humans', label: 'Humans in worlds (fleet)' }],
    yLabel: '% / count', annotations: [{ value: 75, label: 'target 75 %' }],
});
chart({
    file: 'chart-cpu.svg',
    title: 'ECS service CPU and memory utilisation (0.25 vCPU / 0.5 GB tasks)',
    series: [{ key: 'cpu', label: 'CPU avg %' }, { key: 'cpumax', label: 'CPU max %' }, { key: 'mem', label: 'Memory avg %' }],
    yMax: 100, yLabel: '%', annotations: [{ value: 50, label: 'CPU target 50 %' }],
});
chart({
    file: 'chart-async.svg',
    title: 'Async pipeline: SQS messages sent, Lambda invocations/errors, DynamoDB WCU',
    series: [{ key: 'sqssent', label: 'SQS sent' }, { key: 'lambdainv', label: 'Lambda invocations' }, { key: 'lambdaerr', label: 'Lambda errors' }, { key: 'ddbwcu', label: 'DynamoDB WCU' }],
    yLabel: 'per minute',
});
