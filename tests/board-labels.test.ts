// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import indexHtml from '../ui/index.html?raw';
import map1942 from '../data/map-1942.json';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  expect(e, `#${id} exists`).not.toBeNull();
  return e as T;
}

interface TName {
  id: string;
  domain: string;
  ipc: number;
  nameLabel: [number, number];
}
const TS = map1942.territories as unknown as TName[];
const byId = new Map(TS.map((t) => [t.id, t]));

beforeAll(async () => {
  const body = (indexHtml as string).match(/<body>([\s\S]*)<\/body>/)![1].replace(
    /<script[\s\S]*?<\/script>/,
    '',
  );
  document.body.innerHTML = body;
  // Skip the fog-of-war intro cinematic in tests.
  (window as unknown as Record<string, unknown>).__SKIP_INTRO__ = true;
  await import('../ui/main');
  // Pick the 1942 World folio (forces the 4-seat scenario) and commence.
  document.querySelector<HTMLButtonElement>('.map-folio[data-map="world1942"]')!.click();
  el<HTMLInputElement>('seed').value = '7';
  el<HTMLButtonElement>('startBtn').click();
});

describe('board-space name labels (1942 map)', () => {
  it('starts a 1942 game in board mode', () => {
    expect(el('game').hidden).toBe(false);
    const map = el('map');
    expect(map.classList.contains('board-mode')).toBe(true);
    expect(map.getAttribute('viewBox')).toBe('0 0 3500 2000');
  });

  it('renders a label group for every one of the 161 territories', () => {
    const groups = document.querySelectorAll('#map .boardlabels');
    expect(groups).toHaveLength(161);
    for (const g of groups) {
      expect(g.getAttribute('pointer-events')).toBe('none');
    }
  });

  it('renders every land territory name at its nameLabel anchor', () => {
    const names = [...document.querySelectorAll('#map text.board-tname')];
    const land = TS.filter((t) => t.domain === 'land');
    expect(names).toHaveLength(land.length);
    const texts = names.map((n) => n.textContent);
    for (const want of ['Germany', 'United Kingdom', 'Russia', 'Japan', 'France']) {
      expect(texts, `name ${want} rendered`).toContain(want);
    }
    // Germany's name sits exactly on its name_place anchor (x), in the
    // label group for germany.
    const gGroup = document.querySelector('#map .boardlabels[data-terr="germany"]');
    expect(gGroup).not.toBeNull();
    const gName = gGroup!.querySelector('text.board-tname')!;
    expect(gName.textContent).toBe('Germany');
    expect(gName.getAttribute('x')).toBe(String(byId.get('germany')!.nameLabel[0]));
  });

  it('renders every sea zone as a bare number', () => {
    const nums = [...document.querySelectorAll('#map text.board-seanum')];
    expect(nums).toHaveLength(65);
    const texts = nums.map((n) => n.textContent).sort((a, b) => Number(a) - Number(b));
    expect(texts).toEqual(Array.from({ length: 65 }, (_, i) => String(i + 1)));
    // sz5's number is anchored in the Baltic (its name_place point).
    const sz5 = document.querySelector('#map .boardlabels[data-terr="sz5"] text.board-seanum')!;
    expect(sz5.textContent).toBe('5');
    expect(sz5.getAttribute('x')).toBe(String(byId.get('sz5')!.nameLabel[0]));
    expect(sz5.getAttribute('y')).toBe(String(byId.get('sz5')!.nameLabel[1]));
  });

  it('renders an IPC line for every land territory with IPC > 0', () => {
    const lines = [...document.querySelectorAll('#map text.board-ipc')];
    const withIpc = TS.filter((t) => t.domain === 'land' && t.ipc > 0);
    expect(lines).toHaveLength(withIpc.length);
    const germany = document.querySelector('#map .boardlabels[data-terr="germany"] text.board-ipc')!;
    expect(germany.textContent).toBe('IPC 10');
    // Zero-IPC territories (e.g. Iwo Jima) get no IPC line.
    const iwo = document.querySelector('#map .boardlabels[data-terr="iwo_jima"] text.board-ipc');
    expect(iwo).toBeNull();
  });
});
