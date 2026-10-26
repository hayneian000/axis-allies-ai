// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAP, airDistance, isImpassable, isSea, neighborsOf, setActiveMap } from '../data/data';
import {
  combatMove,
  countUnits,
  createGame,
  emptyUnits,
  mobilize,
  nonCombatMove,
} from '../engine/engine';
import type { GameState } from '../engine/types';

/**
 * Impassable neutrals (1942 world map). In 1942 2e the board's 16 neutral
 * territories are impassable: no garrison, and no unit may enter, land in,
 * fly over, or capture them. They are flagged `neutral: true` in
 * data/map-1942.json and read via isImpassable(). (The America map is the
 * opposite by design: its neutrals are garrisoned and capturable — see the
 * regression describe at the bottom.)
 */

const IMPASSABLE_16 = [
  'spain_portugal',
  'sweden',
  'switzerland',
  'turkey',
  'saudi_arabia',
  'sahara',
  'afghanistan',
  'himalaya',
  'mongolia',
  'venezuela',
  'colombia_ecuador',
  'peru_argentina',
  'chile',
  'angola',
  'mozambique',
  'eire',
];

let s: GameState;

function turn(pid: number, phase: GameState['phase']): void {
  s.currentPlayer = pid;
  s.phase = phase;
}

describe('impassable neutrals on the 1942 map', () => {
  beforeEach(() => {
    setActiveMap('world1942');
    s = createGame({ numPlayers: 4, seed: 7 });
  });

  afterEach(() => setActiveMap('america'));

  it('isImpassable flags exactly the 16 board neutrals', () => {
    const flagged = MAP.territories.filter((t) => isImpassable(t.id)).map((t) => t.id);
    expect(flagged.sort()).toEqual([...IMPASSABLE_16].sort());
    expect(isImpassable('france')).toBe(false);
    expect(isImpassable('sz14')).toBe(false);
  });

  it('setup: all 16 start unowned, ungarrisoned, and factory-free', () => {
    expect(Object.keys(s.territories)).toHaveLength(161);
    for (const tid of IMPASSABLE_16) {
      const t = s.territories[tid];
      expect(t, tid).toBeDefined();
      expect(t.owner, tid).toBeNull();
      expect(countUnits(t.units), tid).toBe(0);
      expect(t.factory, tid).toBe(false);
    }
    // Control: an ordinary owned territory is set up normally.
    expect(s.territories.france.owner).toBe(0);
    expect(s.territories.france.units.infantry).toBe(1);
  });

  it('combat move: infantry attack into Spain-Portugal is rejected as impassable', () => {
    turn(0, 'combatMove'); // seat 0 (Germany) holds France, next to Spain
    const r = combatMove(s, 0, [{ from: 'france', to: 'spain_portugal', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    // Nothing moved and no battle opened.
    expect(s.territories.france.units.infantry).toBe(1);
    expect(s.battles).toHaveLength(0);
    expect(s.territories.spain_portugal.owner).toBeNull();
  });

  it('combat move: an ordinary attack beside impassable ground still works', () => {
    turn(0, 'combatMove'); // Libya (seat 0) borders Egypt (seat 3) and the Sahara
    const r = combatMove(s, 0, [{ from: 'libya', to: 'egypt', units: { infantry: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'egypt' && !b.over)).toBe(true);
  });

  it('combat move: tank blitz via the Sahara is rejected as impassable', () => {
    turn(0, 'combatMove'); // Libya tank -> Sahara -> Anglo-Egyptian Sudan
    const r = combatMove(s, 0, [
      { from: 'libya', to: 'anglo_egyptian_sudan', units: { tank: 1 }, via: ['sahara'] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    expect(s.territories.anglo_egyptian_sudan.owner).toBe(3);
    expect(s.battles).toHaveLength(0);
  });

  it('combat move: aircraft may not attack an impassable territory', () => {
    turn(3, 'combatMove'); // Egypt (seat 3) has a fighter; Saudi Arabia is impassable
    const r = combatMove(s, 3, [{ from: 'egypt', to: 'saudi_arabia', units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    expect(s.battles).toHaveLength(0);
  });

  it('air range never routes through impassable territory', () => {
    // The destination itself is unreachable.
    expect(airDistance('india', 'himalaya')).toBe(Infinity);
    expect(airDistance('egypt', 'saudi_arabia')).toBe(Infinity);
    // India -> Szechwan was 2 via the Himalaya; around it (Burma, Yunnan) is 3.
    expect(airDistance('india', 'szechwan')).toBe(3);
    // Control: Persia -> Szechwan via Kazakh SSR never crossed impassable
    // ground, so its distance is unchanged.
    expect(airDistance('persia', 'szechwan')).toBe(2);
  });

  it('non-combat move: repositioning into the Sahara is rejected as impassable', () => {
    turn(3, 'nonCombat'); // seat 3 holds Egypt, next to the Sahara
    const r = nonCombatMove(s, 3, [{ from: 'egypt', to: 'sahara', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    expect(s.territories.egypt.units.infantry).toBe(1);
    expect(countUnits(s.territories.sahara.units)).toBe(0);
  });

  it('combat move: amphibious offload into Spain-Portugal is rejected as impassable', () => {
    // A seat-3 transport loaded with infantry in sz14 (off Spain).
    const z = s.territories.sz14;
    z.units = { ...z.units, transport: 1 };
    z.cargo = [{ owner: 3, units: { ...emptyUnits(), infantry: 1 } }];
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [
      { from: 'sz14', to: 'spain_portugal', units: { infantry: 1 }, disembark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    expect(s.battles).toHaveLength(0);
    expect(s.territories.spain_portugal.owner).toBeNull();
  });

  it('mobilize: nothing can be placed in an impassable territory', () => {
    turn(0, 'mobilize');
    s.purchased = { infantry: 1 };
    const r = mobilize(s, 0, [{ territory: 'spain_portugal', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('impassable');
    expect(countUnits(s.territories.spain_portugal.units)).toBe(0);
  });
});

describe('America map neutrals are unchanged (garrisoned and capturable)', () => {
  beforeEach(() => {
    setActiveMap('america');
  });

  afterEach(() => setActiveMap('america'));

  it('no America territory is impassable', () => {
    for (const t of MAP.territories) {
      expect(isImpassable(t.id), t.id).toBe(false);
    }
  });

  it('attacking a garrisoned America neutral still opens a battle', () => {
    const g = createGame({ numPlayers: 2, seed: 1 });
    // Find any seat-owned land territory with infantry next to a neutral.
    let staged: { pid: number; from: string; to: string } | null = null;
    for (const pid of [0, 1]) {
      for (const [tid, t] of Object.entries(g.territories)) {
        if (t.owner !== pid || t.units.infantry < 1 || isSea(tid)) continue;
        const target = neighborsOf(tid).find(
          (n) => !isSea(n) && g.territories[n].owner === null,
        );
        if (target) {
          staged = { pid, from: tid, to: target };
          break;
        }
      }
      if (staged) break;
    }
    expect(staged).not.toBeNull();
    const { pid, from, to } = staged!;
    // The neutral is garrisoned (that is what makes it a battle, not a walk-in).
    expect(g.territories[to].units.infantry).toBeGreaterThan(0);
    g.currentPlayer = pid;
    g.phase = 'combatMove';
    const r = combatMove(g, pid, [{ from, to, units: { infantry: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(g.battles.some((b) => b.territoryId === to && !b.over)).toBe(true);
  });
});
