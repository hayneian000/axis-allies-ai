#!/usr/bin/env node
/**
 * Visual validation screenshot pipeline.
 * Renders the actual app UI in jsdom (via vitest), extracts the SVG map,
 * inlines critical CSS, and converts to PNG via Sharp.
 * 
 * Usage: node scripts/screenshot.mjs [output.png]
 * 
 * This solves the "can't screenshot localhost" problem: instead of needing
 * a browser, we render the real app code in Node and capture the SVG output.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUTPUT = process.argv[2] || path.join(__dirname, 'screenshot.png');

// Step 1: Create a temp vitest test that renders the game and saves HTML
const testCode = `
// @vitest-environment jsdom
import { it, beforeAll } from 'vitest';
import * as fs from 'fs';

const indexHtml = fs.readFileSync('./ui/index.html', 'utf8');
function el(id) { return document.getElementById(id); }

beforeAll(async () => {
  const body = indexHtml.match(/<body>([\\s\\S]*)<\\/body>/)[1].replace(/<script[\\s\\S]*?<\\/script>/, '');
  document.body.innerHTML = body;
  await import('../ui/main');
});

it('captures UI', () => {
  el('numPlayers').value = '2';
  el('seed').value = '7';
  const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Start game');
  btns[0].click();
  fs.writeFileSync('${path.join(__dirname, 'captured.html').replace(/\\/g, '\\\\')}', document.documentElement.outerHTML);
});
`;

const testPath = path.join(ROOT, 'tests', '__screenshot__.test.ts');
fs.writeFileSync(testPath, testCode);

try {
  execSync('npx vitest run tests/__screenshot__.test.ts', { cwd: ROOT, stdio: 'pipe' });
} finally {
  fs.unlinkSync(testPath);
}

// Step 2: Extract SVG and inline CSS
const html = fs.readFileSync(path.join(__dirname, 'captured.html'), 'utf8');
const svgMatch = html.match(/<svg id="map".*?<\/svg>/s);
if (!svgMatch) throw new Error('No SVG found');

let svg = svgMatch[0];
// Render at 1.25x scale (1250x588) to simulate the larger map size from CSS
svg = svg.replace('<svg id="map"', '<svg xmlns="http://www.w3.org/2000/svg" id="map" width="1250" height="588"');
// Inline CSS variables and classes
const replacements = {
  'var(--paper, #c9b98a)': '#c9b98a',
  'var(--ink)': '#2a2419',
  'var(--brass)': '#c9a227',
  'var(--brass-deep)': '#8a734d',
  'var(--chit)': '#d8c99a',
  'class="tname"': 'fill="#2a2419" font-family="sans-serif" font-weight="bold"',
  'class="towner"': 'fill="#2a2419" font-family="sans-serif" opacity="0.85"',
  'class="ipcpill"': 'fill="#2a2419" stroke="#8a734d" stroke-width="1"',
  'class="ipctext"': 'fill="#c9a227" font-family="sans-serif" font-weight="600"',
  'class="capring"': 'stroke="#8a734d" stroke-width="1.2"',
  'class="capstar"': 'fill="#c9a227"',
  'class="uframe"': 'fill="#d8c99a" stroke="#2a2419" stroke-width="1.2"',
  'class="uink"': 'stroke="#2a2419" stroke-width="1.3" fill="none"',
  'class="uinkfill"': 'fill="#2a2419"',
  'class="facglyph"': 'fill="#4a3f2a" stroke="#d8c99a"',
};
for (const [from, to] of Object.entries(replacements)) {
  svg = svg.split(from).join(to);
}

const svgPath = path.join(__dirname, 'screenshot.svg');
fs.writeFileSync(svgPath, svg);

// Step 3: Convert to PNG
const sharp = (await import('sharp')).default;
await sharp(svgPath).png().toFile(OUTPUT);
console.log(`Screenshot saved: ${OUTPUT}`);

// Cleanup
fs.unlinkSync(path.join(__dirname, 'captured.html'));
fs.unlinkSync(svgPath);
