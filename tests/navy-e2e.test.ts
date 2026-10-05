import { describe, expect, it } from 'vitest';
import {
  combatMove,
  emptyUnits,
  endPhase,
  mobilize,
  nonCombatMove,
  purchase,
} from '../engine/engine';
import type { GameState, UnitCounts } from '../engine/types';
import {
  freshGame,
  gotoCombatMove,
  gotoMobilize,
  gotoNonCombat,
  noopTurn,
} from './helpers';

function cargoN(s: GameState, zid: string, owner: number, t: keyof UnitCounts): number {
  const c = s.territories[zid].cargo ?? [];
  return c.filter((x) => x.owner === owner).reduce((n, x) => n + (x.units[t] ?? 0), 0);
}

/**
 * Navy end-to-end on the America map: from a real 2p scenario start, a player
 * buys a transport, floats it, loads troops, sails it, and unloads — proving
 * the navy loop is playable on the shipped US map, not just in rigged setups.
 */
describe('navy end-to-end on the America map', () => {
  it('buys, mobilizes, loads, sails, and unloads a transport across two turns', () => {
    const s = freshGame(2, 4242);
    const pid = s.currentPlayer; // P0: west, capital california, bank 12
    expect(s.players[pid].capital).toBe('california');

    // --- Turn 1: purchase a transport (7 IPCs of the 12-bank) ...
    const pr = purchase(s, pid, [{ type: 'transport', count: 1 }]);
    expect(pr.ok, `${pr.code} ${pr.error}`).toBe(true);
    expect(s.players[pid].ipcs).toBe(5);

    // ... and float it in the Pacific, adjacent to the california factory.
    gotoCombatMove(s);
    gotoNonCombat(s);
    gotoMobilize(s);
    const m = mobilize(s, pid, [{ territory: 'california', seaZone: 'california_coast', units: { transport: 1 } }]);
    expect(m.ok, `${m.code} ${m.error}`).toBe(true);
    expect(s.territories['california_coast'].units.transport).toBe(1);

    // P1 takes a quiet turn; P0 is up again.
    expect(endPhase(s, pid).ok).toBe(true); // mobilize -> P1 purchase
    noopTurn(s);
    expect(s.currentPlayer).toBe(pid);
    expect(s.phase).toBe('purchase');

    // --- Turn 2: embark 2 infantry from california and sail pacific -> gulf.
    gotoCombatMove(s);
    const cm = combatMove(s, pid, [
      { from: 'california', to: 'california_coast', units: { infantry: 2 }, embark: true },
      { from: 'california_coast', to: 'western_gulf', units: { transport: 1 } },
    ]);
    expect(cm.ok, `${cm.code} ${cm.error}`).toBe(true);
    expect(s.territories['western_gulf'].units.transport).toBe(1);
    expect(cargoN(s, 'western_gulf', pid, 'infantry')).toBe(2);
    expect(s.territories['california'].units.infantry).toBe(1); // 3 - 2

    // Non-combat: unload into friendly texas (P0 holds it in the 2p scenario).
    gotoNonCombat(s);
    const nc = nonCombatMove(s, pid, [
      { from: 'western_gulf', to: 'texas', units: { infantry: 2 }, disembark: true },
    ]);
    expect(nc.ok, `${nc.code} ${nc.error}`).toBe(true);
    expect(s.territories['texas'].units.infantry).toBe(4); // 2 + 2
    expect(cargoN(s, 'western_gulf', pid, 'infantry')).toBe(0);
    expect(s.territories['western_gulf'].units.transport).toBe(1); // ship stays at sea
  });

  it('a purchased warship can sail and fight on the shipped map', () => {
    const s = freshGame(2, 4243);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const homeWater = cap === 'california' ? 'california_coast' : 'north_atlantic';
    // Float a destroyer in the home water adjacent to the capital's factory...
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'destroyer', count: 1 }]).ok).toBe(true);
    gotoCombatMove(s);
    gotoNonCombat(s);
    gotoMobilize(s);
    const mz = mobilize(s, pid, [{ territory: cap, seaZone: homeWater, units: { destroyer: 1 } }]);
    expect(mz.ok, `${mz.code} ${mz.error}`).toBe(true);
    expect(s.territories[homeWater].units.destroyer).toBe(1);
    expect(endPhase(s, pid).ok).toBe(true); // mobilize -> next purchase
    noopTurn(s);
    // ...and on the next turn sail it onward through friendly waters.
    gotoCombatMove(s);
    // Sail to an adjacent water: california_coast->western_gulf, north_atlantic->mid_atlantic_waters.
    const away = homeWater === 'california_coast' ? 'western_gulf' : 'mid_atlantic_waters';
    const cm = combatMove(s, pid, [{ from: homeWater, to: away, units: { destroyer: 1 } }]);
    expect(cm.ok, `${cm.code} ${cm.error}`).toBe(true);
    expect(s.territories[away].units.destroyer).toBe(1);
  });
});
