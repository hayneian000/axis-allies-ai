import { describe, expect, it } from 'vitest';
import { combatMove, emptyUnits, openBattles, serialize } from '../../engine/engine';
import type { GameState, UnitCounts } from '../../engine/types';
import { freshGame, gotoCombatMove } from '../helpers';

/**
 * Phase 2: Combat Movement - 1942 2e rulebook p.12-15.
 *
 * Rigging convention: board state is rigged BEFORE gotoCombatMove so that
 * ownedAtTurnStart (used for air landing checks) reflects the rigged board.
 * `pid` is always s.currentPlayer; `foe` is the other player in a 2p game.
 */

/** Zero a territory's units, then set the given ones. */
function setUnits(s: GameState, tid: string, units: Partial<UnitCounts>): void {
  s.territories[tid].units = { ...emptyUnits(), ...units };
}

describe('combat movement - land units (1942 2e p.12)', () => {
  it('infantry moves 1 territory into friendly ground', () => {
    // 1942 2e p.12: land units move 1 space during combat movement.
    const s = freshGame(2, 101);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    setUnits(s, 'california', { infantry: 2 });
    setUnits(s, 'arizona', {});
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { infantry: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['california'].units.infantry).toBe(1);
    expect(s.territories['arizona'].units.infantry).toBe(1);
  });

  it('infantry cannot move 2 territories', () => {
    // 1942 2e p.12: infantry move allowance is 1; california->new_mexico is 2 hops.
    const s = freshGame(2, 102);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['new_mexico'].owner = pid;
    s.territories['california'].units.infantry = 2;
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'new_mexico', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('artillery moves 1 territory like infantry', () => {
    // 1942 2e p.12: artillery is a 1-move land unit.
    const s = freshGame(2, 103);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    setUnits(s, 'california', { artillery: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { artillery: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['arizona'].units.artillery).toBe(1);
  });

  it('AA guns cannot move in the combat-move phase (1942 2e p.30)', () => {
    // 1942 2e Noncombat Move, "Where Units Can Move": "Note, this is the
    // only phase in which antiaircraft artillery units can move."
    // Correction (Oct 4 2026): an earlier note claimed p.13 permits AA
    // repositioning in combat movement - wrong. The rulebook explicitly
    // bars AA movement outside noncombat. Engine behavior is correct.
    const s = freshGame(2, 104);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    setUnits(s, 'california', { aa: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { aa: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('aa_no_attack');
  });
});

describe('combat movement - tanks and blitz (1942 2e p.13-14)', () => {
  it('tank moves 2 territories through friendly ground', () => {
    // 1942 2e p.13: tanks move 2 spaces.
    const s = freshGame(2, 105);
    const pid = s.currentPlayer;
    for (const tid of ['california', 'arizona', 'new_mexico']) s.territories[tid].owner = pid;
    setUnits(s, 'california', { tank: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'new_mexico', units: { tank: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['new_mexico'].units.tank).toBe(1);
    expect(s.territories['california'].units.tank).toBe(0);
  });

  it('tank cannot move 3 territories', () => {
    // 1942 2e p.13: tank move allowance is 2; california->texas is 3 hops.
    const s = freshGame(2, 106);
    const pid = s.currentPlayer;
    for (const tid of ['california', 'arizona', 'new_mexico', 'texas']) s.territories[tid].owner = pid;
    setUnits(s, 'california', { tank: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'texas', units: { tank: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('tank blitz captures an empty hostile territory in passing', () => {
    // 1942 2e p.14: a tank may blitz through an unoccupied hostile territory,
    // capturing it, and end in a second territory.
    const s = freshGame(2, 107);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['oregon'].owner = pid;
    setUnits(s, 'oregon', { tank: 1 });
    s.territories['idaho'].owner = foe;
    setUnits(s, 'idaho', {}); // empty: blitzable
    s.territories['montana'].owner = foe;
    setUnits(s, 'montana', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
    expect(r.ok).toBe(true);
    expect(s.territories['idaho'].owner).toBe(pid); // captured in passing
    expect(openBattles(s).some((b) => b.territoryId === 'montana')).toBe(true);
  });

  it('tank cannot blitz through an occupied hostile territory', () => {
    // 1942 2e p.14: blitzing through a territory with enemy units is not allowed.
    const s = freshGame(2, 108);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['oregon'].owner = pid;
    setUnits(s, 'oregon', { tank: 1 });
    s.territories['idaho'].owner = foe;
    setUnits(s, 'idaho', { infantry: 1 }); // occupied: blocks blitz
    s.territories['montana'].owner = foe;
    setUnits(s, 'montana', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blocked');
  });

  it('tank cannot blitz through a neutral garrison', () => {
    // FFA decision (project decision, Oct 2026): neutrals hold 2-infantry garrisons, so they
    // are occupied and block blitzing; the garrison must be defeated first.
    const s = freshGame(2, 109);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['oregon'].owner = pid;
    setUnits(s, 'oregon', { tank: 1 });
    s.territories['idaho'].owner = null;
    setUnits(s, 'idaho', { infantry: 2 }); // neutral garrison: occupied
    s.territories['montana'].owner = foe;
    setUnits(s, 'montana', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blocked');
  });
});

describe('combat movement - air units (1942 2e p.13)', () => {
  it('fighter attacks within range 4 with a legal landing spot', () => {
    // 1942 2e p.13: fighters move 4; air units must be able to land safely.
    const s = freshGame(2, 110);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    for (const tid of ['california', 'arizona', 'new_mexico', 'oklahoma']) s.territories[tid].owner = pid;
    setUnits(s, 'california', { fighter: 1 });
    s.territories['texas'].owner = foe;
    setUnits(s, 'texas', { infantry: 1 });
    gotoCombatMove(s);
    // california->texas is 3 hops (1 remaining); oklahoma is 1 hop from texas.
    const r = combatMove(s, pid, [{ from: 'california', to: 'texas', units: { fighter: 1 } }]);
    expect(r.ok).toBe(true);
    expect(openBattles(s).some((b) => b.territoryId === 'texas')).toBe(true);
  });

  it('fighter cannot exceed range 4', () => {
    // 1942 2e p.13: fighter move allowance is 4; montana->florida is 5 hops
    // (air counts sea zones as steps).
    const s = freshGame(2, 111);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['montana'].owner = pid;
    setUnits(s, 'montana', { fighter: 1 });
    s.territories['florida'].owner = foe;
    setUnits(s, 'florida', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'montana', to: 'florida', units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('fighter with no legal landing spot is rejected', () => {
    // 1942 2e p.13: an air unit must have a safe landing spot within its
    // remaining movement; california->gulf_south spends all 4, leaving 0, and
    // the only friendly territory (california) is 4 hops from the target.
    const s = freshGame(2, 112);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { fighter: 1 });
    for (const tid of Object.keys(s.territories)) {
      if (tid !== 'california') s.territories[tid].owner = foe;
    }
    setUnits(s, 'gulf_south', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'gulf_south', units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_landing');
  });

  it('bomber attacks within range 6', () => {
    // 1942 2e p.13: bombers move 6; california->southeast is 5 hops (1 left),
    // and florida (friendly) is adjacent to southeast for landing.
    const s = freshGame(2, 113);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['california'].owner = pid;
    s.territories['florida'].owner = pid;
    setUnits(s, 'california', { bomber: 1 });
    s.territories['southeast'].owner = foe;
    setUnits(s, 'southeast', { infantry: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'southeast', units: { bomber: 1 } }]);
    expect(r.ok).toBe(true);
    expect(openBattles(s).some((b) => b.territoryId === 'southeast')).toBe(true);
  });
});

describe('combat movement - declaring combat (1942 2e p.14-15)', () => {
  it('entering hostile or neutral ground opens battles', () => {
    // 1942 2e p.14: moving units into a hostile space is an attack.
    // FFA decision: neutrals hold 2-inf garrisons and must be fought.
    const s = freshGame(2, 114);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['wyoming'].owner = foe;
    s.territories['wyoming'].units.infantry = 1;
    s.territories['florida'].owner = pid;
    s.territories['florida'].units.infantry = 2;
    s.territories['southeast'].owner = null;
    setUnits(s, 'southeast', { infantry: 2 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'wyoming', units: { infantry: 1 } }]).ok).toBe(true);
    expect(combatMove(s, pid, [{ from: 'florida', to: 'southeast', units: { infantry: 1 } }]).ok).toBe(true);
    const battles = openBattles(s);
    expect(battles).toHaveLength(2);
    const wy = battles.find((b) => b.territoryId === 'wyoming')!;
    expect(wy.defenderId).toBe(foe);
    const se = battles.find((b) => b.territoryId === 'southeast')!;
    expect(se.defenderId).toBeNull(); // neutral garrison
  });

  it('combat moves are all-or-nothing', () => {
    // Engine atomicity: one illegal move rejects the entire batch; the
    // working copy is discarded so no partial moves leak into the state.
    const s = freshGame(2, 115);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    s.territories['texas'].owner = pid;
    s.territories['california'].units.infantry = 2;
    gotoCombatMove(s);
    const before = serialize(s);
    const r = combatMove(s, pid, [
      { from: 'california', to: 'arizona', units: { infantry: 1 } }, // legal
      { from: 'california', to: 'texas', units: { infantry: 1 } }, // illegal: range
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
    expect(serialize(s)).toBe(before);
    expect(openBattles(s)).toHaveLength(0);
  });
});
