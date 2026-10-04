import { describe, expect, it } from 'vitest';
import { combatMove, emptyUnits, endPhase, nonCombatMove, openBattles } from '../../engine/engine';
import type { GameState, UnitCounts } from '../../engine/types';
import { freshGame, gotoCombat, gotoCombatMove, gotoNonCombat, resolveBattleAuto } from '../helpers';

/**
 * Phase 4: Noncombat Movement — 1942 2e rulebook p.22-23.
 *
 * Rigging convention: board state is rigged BEFORE gotoCombatMove so that
 * ownedAtTurnStart (the legal-landing set) reflects the rigged board.
 */

/** Zero a territory's units, then set the given ones. */
function setUnits(s: GameState, tid: string, units: Partial<UnitCounts>): void {
  s.territories[tid].units = { ...emptyUnits(), ...units };
}

/** Rig, then advance a quiet turn to the nonCombat phase (no battles). */
function quietNonCombat(seed: number, rig: (s: GameState, pid: number) => void): { s: GameState; pid: number } {
  const s = freshGame(2, seed);
  const pid = s.currentPlayer;
  rig(s, pid);
  gotoCombatMove(s);
  expect(combatMove(s, pid, []).ok).toBe(true);
  gotoNonCombat(s);
  return { s, pid };
}

describe('noncombat movement — ground rules (1942 2e p.22)', () => {
  it('infantry repositions 1 territory between friendly ground', () => {
    // 1942 2e p.22: land units may move to friendly territories in noncombat.
    const { s, pid } = quietNonCombat(201, (s, pid) => {
      s.territories['california'].owner = pid;
      s.territories['arizona'].owner = pid;
      setUnits(s, 'california', { infantry: 2 });
      setUnits(s, 'arizona', {});
    });
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { infantry: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['california'].units.infantry).toBe(1);
    expect(s.territories['arizona'].units.infantry).toBe(1);
  });

  it('cannot move into hostile territory during noncombat', () => {
    // 1942 2e p.22: noncombat moves stay inside friendly territory.
    const s = freshGame(2, 202);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    s.territories['california'].units.infantry = 2;
    s.territories['nevada_utah'].owner = foe;
    gotoCombatMove(s);
    expect(combatMove(s, pid, []).ok).toBe(true);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'nevada_utah', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_owner');
  });

  it('tank moves 2 territories through friendly ground', () => {
    // 1942 2e p.22: tanks keep their 2-space allowance in noncombat.
    const { s, pid } = quietNonCombat(203, (s, pid) => {
      for (const tid of ['california', 'arizona', 'new_mexico']) s.territories[tid].owner = pid;
      setUnits(s, 'california', { tank: 1 });
    });
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'new_mexico', units: { tank: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['new_mexico'].units.tank).toBe(1);
  });

  it('land units that moved in the combat phase cannot move again', () => {
    // 1942 2e p.22: units that moved during combat movement are done for the turn.
    const s = freshGame(2, 204);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    setUnits(s, 'california', { infantry: 3 });
    setUnits(s, 'arizona', {});
    gotoCombatMove(s);
    // Friendly reposition during combat phase marks the unit used.
    expect(combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { infantry: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    gotoNonCombat(s);
    // The moved infantry is spent and cannot go back...
    const spent = nonCombatMove(s, pid, [{ from: 'arizona', to: 'california', units: { infantry: 1 } }]);
    expect(spent.ok).toBe(false);
    expect(spent.code).toBe('too_few_units');
    // ...but infantry that never moved is still available.
    const fresh = nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { infantry: 1 } }]);
    expect(fresh.ok).toBe(true);
  });

  it('AA guns reposition in noncombat movement', () => {
    // 1942 2e p.22: AA guns move 1 space; the engine restricts AA to this phase
    // (see combat-move.test.ts for the documented deviation).
    const { s, pid } = quietNonCombat(205, (s, pid) => {
      s.territories['california'].owner = pid;
      s.territories['arizona'].owner = pid;
      setUnits(s, 'california', { aa: 1 });
    });
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { aa: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['arizona'].units.aa).toBe(1);
    expect(s.territories['california'].units.aa).toBe(0);
  });
});

describe('noncombat movement — aircraft landing (1942 2e p.23)', () => {
  it('fighter that survived combat lands on friendly ground', () => {
    // 1942 2e p.22-23: after combat, surviving air units land during noncombat.
    const s = freshGame(2, 206);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { fighter: 1 });
    s.territories['arizona'].owner = foe;
    setUnits(s, 'arizona', {}); // empty: fighter survives, air_only result
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { fighter: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'arizona');
    const b = s.battles.find((x) => x.territoryId === 'arizona')!;
    expect(b.over).toBe(true);
    expect(b.result).toBe('air_only');
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'arizona', to: 'california', units: { fighter: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['california'].units.fighter).toBe(1);
  });

  it('aircraft that cannot land are destroyed at the end of noncombat', () => {
    // 1942 2e p.23: air units with no legal landing spot are lost.
    const s = freshGame(2, 207);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { fighter: 1 });
    s.territories['arizona'].owner = foe;
    setUnits(s, 'arizona', {});
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { fighter: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'arizona');
    gotoNonCombat(s);
    // Deliberately do NOT land the fighter, then end the phase.
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.phase).toBe('mobilize');
    expect(s.territories['california'].units.fighter).toBe(0);
    expect(s.events.some((e) => e.kind === 'stranded')).toBe(true);
  });

  it('aircraft cannot land in a territory captured this turn', () => {
    // 1942 2e p.23: legal landing spots must have been friendly since the
    // start of the turn. Simulates a mid-turn capture by flipping ownership
    // after the purchase->combatMove transition (which snapshots
    // ownedAtTurnStart).
    const s = freshGame(2, 208);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = foe; // not ours at turn start
    setUnits(s, 'california', { fighter: 1 });
    gotoCombatMove(s);
    // Simulate a capture: arizona is owned now but was not owned at turn start.
    s.territories['arizona'].owner = pid;
    expect(combatMove(s, pid, []).ok).toBe(true);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_landing');
  });
});
