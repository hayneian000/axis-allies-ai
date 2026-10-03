#!/usr/bin/env node
/**
 * Real-browser screenshot harness for the A&A UI.
 *
 * Builds the app, inlines it into a single self-contained HTML file (see
 * docs/browser-testing.md for why), then drives a deterministic playthrough
 * (2 players, seed 7 — the same scenario as tests/ui.test.ts) in headless
 * Chromium, capturing PNGs of the 8 major screens.
 *
 * Usage:
 *   npm run screenshots                  # writes to ./screenshots/
 *   npm run screenshots -- /tmp/shots    # custom output dir
 *
 * Requires: playwright-core (devDependency) and a Chromium binary.
 * Set CHROME_PATH if the auto-detection below doesn't find yours.
 */
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'screenshots'));

// Attack pair for the 2-player scenario (seed 7 → Player 2 moves first).
// Recompute from data/scenario-2p.json if the scenario changes: an owned
// territory with infantry adjacent to a non-owned territory.
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/map.json'), 'utf8'));
const IDS = MAP.territories.map((t) => t.id);
const FROM = 'montana';
const TO = 'idaho';

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/meta-chromium/chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    'No Chromium found. Set CHROME_PATH to your Chromium/Chrome binary, or run:\n' +
      '  npx playwright install chromium',
  );
}

/** Build, then inline JS+CSS into dist/single.html (see docs/browser-testing.md). */
function buildSingle() {
  execSync('npx vite build --base ./', { cwd: ROOT, stdio: 'inherit' });
  const dist = path.join(ROOT, 'dist');
  let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const assets = fs.readdirSync(path.join(dist, 'assets'));
  const js = assets.find((f) => f.endsWith('.js'));
  const css = assets.find((f) => f.endsWith('.css'));
  const jsText = fs.readFileSync(path.join(dist, 'assets', js), 'utf8');
  const cssText = fs.readFileSync(path.join(dist, 'assets', css), 'utf8');
  // Replacer *function*: the minified bundle contains `$'`/`$&` sequences
  // that String.replace would otherwise interpret as replacement patterns.
  html = html.replace(
    /<script type="module"[^>]*src="[^"]*"[^>]*><\/script>/,
    () => `<script type="module">${jsText}</script>`,
  );
  html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${cssText}</style>`);
  const out = path.join(dist, 'single.html');
  fs.writeFileSync(out, html);
  return out;
}

const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, name) });

async function main() {
  const single = buildSingle();
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox'],
  });
  const pg = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await pg.goto('file://' + single);
  await pg.waitForTimeout(600);
  await shot(pg, '01-setup.png');

  // Same deterministic game as tests/ui.test.ts.
  await pg.selectOption('#numPlayers', '2');
  await pg.fill('#seed', '7');
  await pg.click('#startBtn');
  await pg.waitForTimeout(400);
  await shot(pg, '02-board-purchase.png');

  // Purchase modal with a cart dialed.
  await pg.click('text=Buy units…');
  await pg.waitForTimeout(300);
  await pg.click('#buy-infantry + button');
  await pg.click('#buy-infantry + button');
  await pg.click('#buy-tank + button');
  await pg.waitForTimeout(200);
  await shot(pg, '03-shop.png');
  await pg.getByRole('button', { name: 'Buy', exact: true }).click();
  await pg.waitForTimeout(300);
  await pg.click('#modal-close'); // shop stays open after Buy (same phase)
  await pg.waitForTimeout(300);

  // Move dialog, then a staged attack.
  await pg.click('#endPhaseBtn'); // -> combatMove
  await pg.waitForTimeout(300);
  await pg.evaluate(
    ([ids, fromId]) => {
      const rects = [...document.querySelectorAll('#map .terr')];
      rects[ids.indexOf(fromId)].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
    [IDS, FROM],
  );
  await pg.waitForTimeout(300);
  await shot(pg, '04-move-dialog.png');
  await pg.fill('#mv-infantry', '1');
  await pg.dispatchEvent('#mv-infantry', 'input');
  await pg.evaluate(
    ([toId]) => {
      document.querySelector(`#modal-body button[data-dest="${toId}"]`).click();
    },
    [TO],
  );
  await pg.waitForTimeout(400);
  await shot(pg, '05-staged.png');

  // Launch into combat; the battle dialog auto-opens with open battles.
  await pg.click('text=Launch moves');
  await pg.waitForTimeout(300);
  await pg.click('#endPhaseBtn'); // -> combat
  await pg.waitForTimeout(400);
  await pg.click('text=Roll one round');
  await pg.waitForTimeout(400);
  await shot(pg, '06-battle.png');
  await pg.click('#modal-close');
  await pg.waitForTimeout(200);

  // Chat tab.
  await pg.click('#tab-chat');
  await pg.fill('#chatText', 'good luck');
  await pg.click('#chatSend');
  await pg.waitForTimeout(300);
  await shot(pg, '07-chat.png');

  // Fresh game, straight to mobilize for the deploy inspector.
  await pg.click('#newBtn');
  await pg.waitForTimeout(300);
  await pg.selectOption('#numPlayers', '2');
  await pg.fill('#seed', '7');
  await pg.click('#startBtn');
  await pg.waitForTimeout(400);
  await pg.click('text=Buy units…');
  await pg.waitForTimeout(300);
  await pg.click('#buy-infantry + button');
  await pg.getByRole('button', { name: 'Buy', exact: true }).click();
  await pg.waitForTimeout(200);
  await pg.click('#modal-close');
  await pg.waitForTimeout(200);
  await pg.click('#endPhaseBtn'); // -> combatMove
  await pg.waitForTimeout(200);
  await pg.getByRole('button', { name: 'No moves', exact: true }).click();
  await pg.waitForTimeout(200);
  await pg.click('#endPhaseBtn'); // -> combat (no battles)
  await pg.waitForTimeout(200);
  await pg.click('#endPhaseBtn'); // -> nonCombat
  await pg.waitForTimeout(200);
  await pg.click('#endPhaseBtn'); // -> mobilize
  await pg.waitForTimeout(300);
  await pg.evaluate(
    ([ids]) => {
      const rects = [...document.querySelectorAll('#map .terr')];
      // Player 2's capital in the 2p scenario.
      rects[ids.indexOf('new_york')].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    },
    [IDS],
  );
  await pg.waitForTimeout(300);
  await shot(pg, '08-mobilize.png');

  await browser.close();
  console.log(`Screenshots written to ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
