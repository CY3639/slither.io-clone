#!/usr/bin/env node
// Build the report: inline the appendices from the living docs (so they never drift from the
// repository), then print report.html to PDF with headless Chrome. No dependencies.
// Usage: node report/build.mjs [--pdf]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Minimal Markdown → HTML for the docs' tables, headings, paragraphs, lists and code spans. */
function md(text) {
    const inline = (s) =>
        esc(s)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/\*([^*]+)\*/g, '<i>$1</i>');
    const out = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('|')) {
            const rows = [];
            while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
            i--;
            const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim()));
            const [head, , ...body] = rows;
            out.push('<table><tr>' + cells(head).map((c) => `<th>${c}</th>`).join('') + '</tr>' +
                body.map((r) => '<tr>' + cells(r).map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>');
        } else if (line.startsWith('```')) {
            const buf = [];
            while (++i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i]);
            out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
        } else if (/^#{1,3} /.test(line)) {
            const level = Math.min(3, line.match(/^#+/)[0].length + 1);
            out.push(`<h${level}>${inline(line.replace(/^#+ /, ''))}</h${level}>`);
        } else if (/^(\*|-|\d+\.) /.test(line)) {
            const buf = [];
            while (i < lines.length && /^(\*|-|\d+\.) /.test(lines[i])) buf.push(lines[i++].replace(/^(\*|-|\d+\.) /, ''));
            i--;
            out.push('<ul>' + buf.map((b) => `<li>${inline(b)}</li>`).join('') + '</ul>');
        } else if (line.trim() && !line.startsWith('>')) {
            out.push(`<p>${inline(line)}</p>`);
        }
    }
    return out.join('\n');
}

function section(file, startHeading) {
    const text = read(file);
    const from = startHeading ? text.indexOf(startHeading) : 0;
    return md(text.slice(from < 0 ? 0 : from).replace(/^# .*\n/, ''));
}

const appendices = [
    '<h2>Appendix A. Assessment pattern matrix</h2>', section('docs/assessment-pattern-matrix.md'),
    '<h2>Appendix B. Evidence register</h2>', section('docs/evidence-register.md'),
    '<h2>Appendix C. Acceptance test results</h2>', section('docs/final-test-results.md'),
    '<h2>Appendix D. AWS Pricing Calculator inputs</h2>', section('docs/cost-estimate.md', '## AWS Pricing Calculator'),
    '<h2>Appendix E. Repository and reproduction</h2>',
    md(`Source: the \`a3-cloud-multiplayer\` branch of https://github.com/CY3639/slither.io-clone. Key paths: \`server/\` (game server, Dockerfile), \`client/\` (Phaser client and build), \`lambda/\` (event worker and leaderboard API), \`infra/\` (CloudFormation and scripts), \`load-tests/\`, \`tests/\`, \`evidence/\`.
Deploy with \`AWS_PROFILE=default infra/scripts/deploy.sh\`; run locally with \`npm run install:all && npm run dev\`; test with \`npm test\`. Teardown steps are in \`infra/CLEANUP.md\`.`),
].join('\n');

let html = read('report/report.html');
const marker = '⟦APPENDICES⟧';
const built = html.includes(marker) ? html.replace(marker, appendices) : html;
const out = path.join(here, 'report.built.html');
writeFileSync(out, built);

const unresolved = [...built.matchAll(/⟦([^⟧]{0,60})/g)].map((m) => m[1]);
const allowed = /STUDENT|PRICING_CALCULATOR_LINK|Replace or extend/;
const blocking = unresolved.filter((u) => !allowed.test(u));
console.log(`built ${path.relative(root, out)}; markers awaiting the student: ${unresolved.length - blocking.length}`);
if (blocking.length) {
    console.error('Unfilled placeholders:', blocking);
    process.exitCode = 1;
}

if (process.argv.includes('--pdf')) {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const pdf = path.join(here, 'n5528712-CAB432-A3-report.pdf');
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, `file://${out}`], { stdio: 'ignore' });
    console.log(`wrote ${path.relative(root, pdf)}`);
}
