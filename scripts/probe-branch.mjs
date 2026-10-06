#!/usr/bin/env node
/**
 * Live dev-server smoke probe for the A&A UI.
 *
 * Spins up headless Chromium against a running `vite dev` server, skips the
 * intro cinematic, starts a game (default: 2 players, seed 7), clicks a
 * territory, advances one phase, and captures a screenshot at each stage.
 * Prints a JSON summary (console errors, page errors, state checks) and
 * exits non-zero if the game screen never appears or any page error fires.
 *
 * This is the "poke around" companion to `npm run screenshots`: the harness
 * tests the *built* app from `file://`; this tests the *branch you're on*
 * against the live dev server, which is what you want when verifying a PR.
 *
 * Usage:
 *   npm run dev &                                   # in another shell
 *   node scripts/probe-branch.mjs                   # port 5173, ./probe-shots
 *   node scripts/probe-branch.mjs --port 5174 --out /tmp/shots --seed 7 --players 3
 *
 * Requires: playwright-core (devDependency) and a Chromium binary.
 * Set CHROME_PATH if the auto-detection below doesn't find yours.
 *
 * Why the request interception: recent Chromium builds enforce Local Network
 * Access checks that reject direct `http://localhost:…` navigations from
 * automation contexts (net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS), so
 * every localhost request is re-fetched server-side via Node's http module.
 * The original request headers MUST be forwarded — vite's dev server keys
 * CSS-vs-JS-module responses off the Accept header, and without it
 * stylesheets come back as JS modules that parse to zero rules (symptom:
 * `var(--…)` fills silently fall back to black). The vite HMR websocket is
 * also blocked; that's harmless (no live reload, app still works).
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const PORT = Number(opt('port', '5173'));
const OUT = path.resolve(opt('out', 'probe-shots'));
const SEED = opt('seed', '7');
const PLAYERS = opt('players', '2');
const DEV_URL = `http://localhost:${PORT}/`;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    '/opt/meta-chromium/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('No Chromium found. Set CHROME_PATH.');
}

const shot = (pg, name) => pg.screenshot({ path: path.join(OUT, name) });

/** Re-fetch localhost traffic server-side (see header comment for why). */
async function installLocalhostWorkaround(pg) {
  await pg.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      return route.continue();
    }
    const req = http.request(
      {
        host: 'localhost',
        port: PORT,
        path: u.pathname + u.search,
        method: route.request().method(),
        headers: route.request().headers(),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          route.fulfill({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', () => route.abort());
    req.end();
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const pg = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  const consoleErrors = [];
  pg.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')) {
      consoleErrors.push(m.text().slice(0, 200));
    }
  });
  const pageErrors = [];
  pg.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

  // Direct navigation first; fall back to the interception workaround.
  try {
    await pg.goto(DEV_URL, { waitUntil: 'load', timeout: 15000 });
  } catch {
    await installLocalhostWorkaround(pg);
    await pg.goto(DEV_URL, { waitUntil: 'load', timeout: 20000 });
  }

  await pg.waitForTimeout(1200);
  await shot(pg, '01-cinematic.png');

  if (await pg.locator('#intro-skip').count()) {
    await pg.keyboard.press('Space');
    await pg.waitForTimeout(700);
  }
  await shot(pg, '02-setup.png');

  await pg.getByTestId('player-count').locator(`button[data-players="${PLAYERS}"]`).click();
  await pg.getByTestId('seed-input').fill(SEED);
  await pg.getByTestId('commence-btn').click();
  await pg.waitForSelector('[data-testid="game-screen"]:not([hidden])', { timeout: 15000 });
  await pg.waitForTimeout(800);
  await shot(pg, '03-board.png');

  await pg.evaluate(() => {
    const terr = document.querySelector('#map .terr');
    if (terr) terr.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await pg.waitForTimeout(500);
  await shot(pg, '04-territory.png');

  await pg.getByTestId('endphase-btn').click();
  await pg.waitForTimeout(600);
  await shot(pg, '05-combatmove.png');

  const state = await pg.evaluate(() => ({
    title: document.title,
    gameVisible: !!document.querySelector('[data-testid="game-screen"]:not([hidden])'),
    terrCount: document.querySelectorAll('#map .terr').length,
    styledFrames: document.querySelectorAll('#map .uframe').length,
  }));
  // Sanity: stylesheets must actually have rules (catches the CSS-as-JS-module pitfall).
  const cssOk = await pg.evaluate(() =>
    [...document.styleSheets]
      .filter((s) => s.href && s.href.includes('.css'))
      .every((s) => { try { return s.cssRules.length > 0; } catch { return true; } }),
  );

  await browser.close();

  const ok = state.gameVisible && state.terrCount > 0 && cssOk && pageErrors.length === 0;
  console.log(JSON.stringify({ ok, out: OUT, state, cssOk, consoleErrors: consoleErrors.slice(0, 10), pageErrors }, null, 1));
  if (!ok) process.exit(1);
  console.log(`Probe passed. Screenshots in ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
