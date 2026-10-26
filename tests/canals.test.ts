import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setActiveMap } from '../data/data';
import {
  canalEdgeOpen,
  combatMove,
  createGame,
  emptyUnits,
  nonCombatMove,
} from '../engine/engine';
import type { GameState } from '../engine/types';

// Canal enforcement (1942 board): the Panama edge sz19<->sz18 requires
// control of Central America; the Suez edge sz17<->sz34 requires control
// of BOTH Egypt and Trans-Jordan. Control is evaluated at move time for
// the moving seat. Starting position: seat 3 (British + Americans) holds
// Central America, Egypt, and Trans-Jordan; a seat-3 cruiser starts in
// sz19 and a seat-3 destroyer in sz17.

let s: GameState;

function turn(pid: number, phase: GameState['phase']): void {
  s.currentPlayer = pid;
  s.phase = phase;
}

function setFleet(zid: string, owner: number, units: Partial<Record<string, number>>): void {
  const z = s.territories[zid];
  z.owner = owner;
  z.units = { ...emptyUnits(), ...units } as typeof z.units;
  z.coexist = undefined;
  z.cargo = [];
}

beforeEach(() => {
  setActiveMap('world1942');
  s = createGame({ numPlayers: 4, seed: 7 });
});

afterEach(() => setActiveMap('america'));

describe('canalEdgeOpen (the rule the engine and the UI dialog share)', () => {
  it('Panama is open to the seat holding Central America, closed to others', () => {
    expect(s.territories.central_america.owner).toBe(3);
    expect(canalEdgeOpen(s.territories, 'sz19', 'sz18', 3)).toBe(true);
    expect(canalEdgeOpen(s.territories, 'sz18', 'sz19', 3)).toBe(true);
    expect(canalEdgeOpen(s.territories, 'sz19', 'sz18', 0)).toBe(false);
    s.territories.central_america.owner = 0;
    expect(canalEdgeOpen(s.territories, 'sz19', 'sz18', 3)).toBe(false);
    expect(canalEdgeOpen(s.territories, 'sz19', 'sz18', 0)).toBe(true);
  });

  it('Suez needs BOTH Egypt and Trans-Jordan', () => {
    expect(canalEdgeOpen(s.territories, 'sz17', 'sz34', 3)).toBe(true);
    s.territories.trans_jordan.owner = 0;
    expect(canalEdgeOpen(s.territories, 'sz17', 'sz34', 3)).toBe(false);
    s.territories.trans_jordan.owner = 3;
    s.territories.egypt.owner = 0;
    expect(canalEdgeOpen(s.territories, 'sz17', 'sz34', 3)).toBe(false);
  });

  it('non-canal edges are always open', () => {
    expect(canalEdgeOpen(s.territories, 'sz19', 'sz20', 2)).toBe(true);
    expect(canalEdgeOpen(s.territories, 'sz17', 'sz15', 2)).toBe(true);
  });
});

describe('Panama in combat movement', () => {
  it('allows the controlling seat through (sz19 cruiser -> sz18)', () => {
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz19', to: 'sz18', units: { cruiser: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.territories.sz18.owner).toBe(3);
    expect(s.territories.sz18.units.cruiser).toBe(1);
  });

  it('denies a non-controlling seat with canal_closed', () => {
    s.territories.central_america.owner = 0;
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz19', to: 'sz18', units: { cruiser: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
    // Nothing moved.
    expect(s.territories.sz19.units.cruiser).toBe(1);
    expect(s.territories.sz18.owner).toBeNull();
  });

  it('denies the reverse direction too (sz18 -> sz19)', () => {
    setFleet('sz18', 0, { destroyer: 1 });
    turn(0, 'combatMove');
    const r = combatMove(s, 0, [{ from: 'sz18', to: 'sz19', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });

  it('blocks a two-step route whose second step is the canal (sz20 -> sz18)', () => {
    setFleet('sz20', 3, { destroyer: 1 });
    s.territories.central_america.owner = 0;
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz20', to: 'sz18', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });

  it('allows the same two-step route while the canal is held', () => {
    setFleet('sz20', 3, { destroyer: 1 });
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz20', to: 'sz18', units: { destroyer: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.territories.sz18.units.destroyer).toBe(1);
  });

  it('does not block movement up to the canal mouth (sz20 -> sz19)', () => {
    setFleet('sz20', 3, { destroyer: 1 });
    s.territories.central_america.owner = 0;
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz20', to: 'sz19', units: { destroyer: 1 } }]);
    expect(r.ok, r.error).toBe(true);
  });

  it('submarines get no canal exemption', () => {
    setFleet('sz19', 2, { submarine: 1 });
    turn(2, 'combatMove');
    const r = combatMove(s, 2, [{ from: 'sz19', to: 'sz18', units: { submarine: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });
});

describe('Suez in combat movement', () => {
  it('allows the controlling seat through (sz17 destroyer -> sz34)', () => {
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz17', to: 'sz34', units: { destroyer: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.territories.sz34.units.destroyer).toBe(1);
  });

  it('denies when only one of Egypt / Trans-Jordan is held', () => {
    s.territories.trans_jordan.owner = 0;
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'sz17', to: 'sz34', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
    expect(s.territories.sz17.units.destroyer).toBe(1);
  });

  it('allows a seat that holds both, from the far side (sz34 -> sz17)', () => {
    s.territories.egypt.owner = 0;
    s.territories.trans_jordan.owner = 0;
    setFleet('sz34', 0, { destroyer: 1 });
    turn(0, 'combatMove');
    const r = combatMove(s, 0, [{ from: 'sz34', to: 'sz17', units: { destroyer: 1 } }]);
    expect(r.ok, r.error).toBe(true);
  });

  it('blocks a two-step route through Suez (sz15 battleship -> sz34)', () => {
    // Clear sz17 first: with the British destroyer gone, the closed canal
    // is the ONLY blocker on the sz15 -> sz17 -> sz34 route (otherwise the
    // hostile intermediate zone already bars transit on its own).
    const z17 = s.territories.sz17;
    z17.owner = null;
    z17.units = { ...emptyUnits() };
    turn(0, 'combatMove');
    const r = combatMove(s, 0, [{ from: 'sz15', to: 'sz34', units: { battleship: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });
});

describe('canals in non-combat movement', () => {
  it('allows a held canal (sz17 -> sz34)', () => {
    turn(3, 'nonCombat');
    const r = nonCombatMove(s, 3, [{ from: 'sz17', to: 'sz34', units: { destroyer: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.territories.sz34.units.destroyer).toBe(1);
  });

  it('denies a closed canal (sz17 -> sz34 with Trans-Jordan lost)', () => {
    s.territories.trans_jordan.owner = 0;
    turn(3, 'nonCombat');
    const r = nonCombatMove(s, 3, [{ from: 'sz17', to: 'sz34', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });

  it('denies a closed Panama (sz19 -> sz18)', () => {
    s.territories.central_america.owner = 1;
    turn(3, 'nonCombat');
    const r = nonCombatMove(s, 3, [{ from: 'sz19', to: 'sz18', units: { cruiser: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('canal_closed');
  });
});

describe('canals do not affect land or air movement', () => {
  it('aircraft fly over a closed canal: Egypt fighter strikes sz34', () => {
    // Close Suez to seat 3 (Trans-Jordan lost) and put a German destroyer
    // in sz34. The Egyptian fighter still attacks it — air movement uses
    // air range, never the canal edges.
    s.territories.trans_jordan.owner = 0;
    setFleet('sz34', 0, { destroyer: 1 });
    s.ownedAtTurnStart = ['egypt'];
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [{ from: 'egypt', to: 'sz34', units: { fighter: 1 } }]);
    expect(r.ok, r.error).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'sz34' && !b.over)).toBe(true);
  });

  it('land attacks beside the canal are unaffected', () => {
    // Target East Mexico, Central America's other land neighbor
    // (Colombia-Ecuador is impassable in 1942 2e, so it can never be a
    // land target — see tests/impassable.test.ts).
    s.territories.central_america.units.infantry = 2;
    s.territories.east_mexico.owner = 0;
    s.territories.east_mexico.units.infantry = 1;
    turn(3, 'combatMove');
    const r = combatMove(s, 3, [
      { from: 'central_america', to: 'east_mexico', units: { infantry: 1 } },
    ]);
    expect(r.ok, r.error).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'east_mexico' && !b.over)).toBe(true);
  });
});
