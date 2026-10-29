// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import indexHtml from '../ui/index.html?raw';
import { ensureMapLoaded, setActiveMap } from '../data/data';
import { createGame } from '../engine/engine';
import type { GameState } from '../engine/types';
import { bridge } from '../ui/driverBridge';

// Canal filtering in the sea move dialog (1942 board): the dialog's
// destination list is generated with the same canalEdgeOpen rule the
// engine validates, so a closed canal route is never offered. States are
// injected through the app's own driver bridge (the AI driver's path),
// with seat 3 to move in the combat-move phase: its sz17 destroyer sits
// at the Suez mouth and its sz19 cruiser at the Panama mouth.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  expect(e, `#${id} exists`).not.toBeNull();
  return e as T;
}

function inject(mutate?: (s: GameState) => void): void {
  setActiveMap('world1942');
  const s = createGame({ numPlayers: 4, seed: 7 });
  s.currentPlayer = 3;
  s.phase = 'combatMove';
  mutate?.(s);
  bridge.ui!.setGameState(s);
  bridge.ui!.refresh();
  bridge.ui!.showGame();
}

function destButtons(tid: string): string[] {
  const poly = document.querySelector(`#map g.tgroup[data-terr="${tid}"] polygon.terr`);
  expect(poly, `tile for ${tid}`).not.toBeNull();
  poly!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(el('modal').hidden).toBe(false);
  return [...el('modal-body').querySelectorAll('button')].map((b) => b.textContent ?? '');
}

beforeAll(async () => {
  const body = (indexHtml as string).match(/<body>([\s\S]*)<\/body>/)![1].replace(
    /<script[\s\S]*?<\/script>/,
    '',
  );
  document.body.innerHTML = body;
  (window as unknown as Record<string, unknown>).__SKIP_INTRO__ = true;
  await import('../ui/main');
  expect(bridge.ui).not.toBeNull();
  await ensureMapLoaded('world1942');
});

describe('sea move dialog canal filtering (1942)', () => {
  it('offers the Suez route while Egypt + Trans-Jordan are held', () => {
    inject();
    const dests = destButtons('sz17');
    expect(dests.some((d) => d.includes('Sea Zone 34'))).toBe(true);
  });

  it('omits the Suez route when Trans-Jordan is enemy-held', () => {
    inject((s) => {
      s.territories.trans_jordan.owner = 0;
    });
    const dests = destButtons('sz17');
    expect(dests.some((d) => d.includes('Sea Zone 34'))).toBe(false);
    // The non-canal neighbor is still offered.
    expect(dests.some((d) => d.includes('Sea Zone 15'))).toBe(true);
  });

  it('offers the Panama route while Central America is held', () => {
    inject();
    const dests = destButtons('sz19');
    expect(dests.some((d) => d.includes('Sea Zone 18'))).toBe(true);
  });

  it('omits the Panama route when Central America is enemy-held', () => {
    inject((s) => {
      s.territories.central_america.owner = 0;
    });
    const dests = destButtons('sz19');
    expect(dests.some((d) => d.includes('Sea Zone 18'))).toBe(false);
    // The non-canal neighbor is still offered.
    expect(dests.some((d) => d.includes('Sea Zone 20'))).toBe(true);
  });
});
