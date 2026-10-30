// Content pins for the in-game help panel (ui/help.ts): the unit table
// is generated from UNITS, and the objective numbers are derived from
// scenario/state data, so the panel cannot silently drift from the
// game it describes. Static copy is pinned where it states facts that
// live in data (the canal requirements).

import { describe, expect, it } from 'vitest';
import { UNITS, canalList, ensureMapLoaded, setActiveMap } from '../data/data';
import { createGame } from '../engine/engine';
import {
  KEY_RULES,
  UNIT_ORDER,
  UNIT_TEXT,
  buildHelpHtml,
  helpInputForSetup,
  objectiveForMap,
  objectiveForState,
  objectiveLines,
  unitRows,
  type HelpContentInput,
} from '../ui/help';

const NO_DASHES = /[—–]/;

describe('help unit table', () => {
  it('covers exactly the purchasable units in UNITS', () => {
    const rows = unitRows();
    expect(rows.map((r) => r.id).sort()).toEqual(Object.keys(UNITS).sort());
    expect(UNIT_ORDER).toHaveLength(Object.keys(UNITS).length);
  });

  it('takes every stat from UNITS', () => {
    for (const row of unitRows()) {
      const u = UNITS[row.id];
      expect(row.cost, `${row.id} cost`).toBe(u.cost);
      expect(row.attack, `${row.id} attack`).toBe(u.attack);
      expect(row.defense, `${row.id} defense`).toBe(u.defense);
      expect(row.move, `${row.id} move`).toBe(u.move);
    }
  });

  it('gives every unit a display name and a special note', () => {
    for (const id of Object.keys(UNITS) as Array<keyof typeof UNITS>) {
      expect(UNIT_TEXT[id].name.length, `${id} name`).toBeGreaterThan(0);
      expect(UNIT_TEXT[id].note.length, `${id} note`).toBeGreaterThan(0);
    }
  });
});

describe('help objective derivation', () => {
  it('degrades gracefully before the 1942 data is loaded', () => {
    // This test must run before any ensureMapLoaded call in this file.
    const o = objectiveForMap('world1942', 4);
    expect(o.capitals).toBeNull();
    expect(o.victoryCities).toBe('degraded');
    const lines = objectiveLines(o);
    expect(lines[0]).toContain('majority of the capitals');
    expect(lines[1]).toContain('Victory cities');
    expect(lines.join(' ')).not.toContain('Germany 6');
  });

  it('derives America numbers from the scenario (majority of capitals)', () => {
    const o4 = objectiveForMap('america', 4);
    expect(o4.capitals).toEqual({ toWin: 3, total: 4 });
    expect(o4.victoryCities).toBeNull();
    expect(o4.turnCap).toBe(20);
    expect(objectiveLines(o4)[0]).toBe(
      'Hold 3 of the 4 capitals at the same time and you win at once.',
    );
    const o2 = objectiveForMap('america', 2);
    expect(o2.capitals).toEqual({ toWin: 2, total: 2 });
  });

  it('derives objective numbers from a live America game state', () => {
    const s = createGame({ numPlayers: 2, seed: 7 });
    const o = objectiveForState(s);
    expect(o.mapId).toBe('america');
    expect(o.capitals).toEqual({ toWin: s.capitalsToWin, total: 2 });
    expect(o.turnCap).toBe(s.turnCap);
    expect(o.victoryCities).toBeNull();
  });

  it('derives 1942 numbers from the loaded scenario', async () => {
    await ensureMapLoaded('world1942');
    const o = objectiveForMap('world1942', 4);
    expect(o.capitals).toEqual({ toWin: 3, total: 5 });
    expect(o.victoryCities).toEqual({
      seats: ['Germany', 'USSR', 'Japan', 'UK + US'],
      targets: [6, 5, 6, 8],
    });
    const text = objectiveLines(o).join('\n');
    expect(text).toContain('Hold 3 of the 5 capitals');
    expect(text).toContain('Germany 6, USSR 5, Japan 6, UK + US 8');
    expect(text).toContain('end of a complete round');
  });

  it('derives 1942 numbers from a live game state', async () => {
    await ensureMapLoaded('world1942');
    setActiveMap('world1942');
    const s = createGame({ numPlayers: 4, seed: 7 });
    const o = objectiveForState(s);
    expect(o.mapId).toBe('world1942');
    expect(o.capitals).toEqual({ toWin: 3, total: 5 });
    const vc = o.victoryCities;
    if (vc === null || vc === 'degraded') throw new Error('expected exact VC data');
    expect(vc.targets).toEqual([6, 5, 6, 8]);
    expect(vc.seats).toEqual(['Germany', 'USSR', 'Japan', 'UK + US']);
    setActiveMap('america');
  });

  it('pins the canal copy to the 1942 map data', async () => {
    await ensureMapLoaded('world1942');
    setActiveMap('world1942');
    const descriptions = canalList().map((c) => c.description).join(' ');
    expect(descriptions).toContain('Central America');
    expect(descriptions).toContain('Egypt');
    expect(descriptions).toContain('Trans-Jordan');
    const canalRule = KEY_RULES.find((r) => r.startsWith('Canals')) ?? '';
    expect(canalRule).toContain('Central America');
    expect(canalRule).toContain('Egypt and Trans-Jordan');
    setActiveMap('america');
  });
});

describe('help panel HTML', () => {
  const variants: Array<[string, HelpContentInput]> = [
    ['setup, America selected', helpInputForSetup('america', 4)],
    [
      'degraded 1942 primary',
      {
        primary: {
          mapId: 'world1942',
          mapLabel: '1942 World',
          capitals: null,
          turnCap: 20,
          victoryCities: 'degraded',
        },
        secondary: null,
      },
    ],
  ];

  it('renders every section and the full unit table', () => {
    const html = buildHelpHtml(variants[0][1]);
    for (const heading of ['Objective', 'Your turn', 'Key rules', 'Units', 'AI games', 'Saves']) {
      expect(html, heading).toContain(`<h3>${heading}</h3>`);
    }
    expect(html).toContain('On the other map');
    for (const row of unitRows()) {
      expect(html, row.name).toContain(row.name);
    }
    expect(html).toContain('Hold 3 of the 4 capitals');
  });

  it('uses no em dashes or en dashes anywhere in the copy', () => {
    for (const [name, input] of variants) {
      expect(buildHelpHtml(input), name).not.toMatch(NO_DASHES);
    }
    for (const line of KEY_RULES) expect(line).not.toMatch(NO_DASHES);
  });
});
