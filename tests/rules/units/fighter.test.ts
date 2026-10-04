// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  combatMove,
  nonCombatMove,
  purchase,
  resolveCombatRound,
} from '../../../engine/engine';
import { UNITS } from '../../../data/data';
import {
  freshGame,
  gotoCombat,
  gotoCombatMove,
  gotoNonCombat,
  resolveAllAuto,
} from '../../helpers';

/**
 * Fighter — 1942 2e p.10 (unit profile).
 * Cost 10, attack 3, defense 4, move 4. Fighters are air units: they need
 * a landing spot and cannot capture territory alone.
 */
describe('fighter profile', () => {
  it('costs 10 IPCs (1942 2e p.10)', () => {
    expect(UNITS.fighter.cost).toBe(10);
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    expect(purchase(s, pid, [{ type: 'fighter', count: 1 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 10);
  });

  it('has attack 3, defense 4, move 4 (1942 2e p.10)', () => {
    expect(UNITS.fighter.attack).toBe(3);
    expect(UNITS.fighter.defense).toBe(4);
    expect(UNITS.fighter.move).toBe(4);
  });

  it('is an air unit (1942 2e p.10: fighters are air units)', () => {
    expect(UNITS.fighter.air).toBe(true);
  });
});

describe('fighter combat values', () => {
  it('attack dice hit on 3 or less (1942 2e p.10: attack 3)', () => {
    const s = freshGame(2, 42);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.fighter = 2;
    s.ownedAtTurnStart.push('idaho');
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 3;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 2 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    const expected = c.attackRolls.filter((d) => d <= 3).length;
    expect(c.attackHits).toBe(expected);
  });

  it('defense dice hit on 4 or less — best defender (1942 2e p.10: defense 4)', () => {
    const s = freshGame(2, 43);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    // Attack the fighter: montana (foe, 2 fighters) <- idaho (mine, 3 inf).
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.fighter = 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.ownedAtTurnStart.push('idaho');
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    const expected = c.defenseRolls.filter((d) => d <= 4).length;
    expect(c.defenseHits).toBe(expected);
  });
});

describe('fighter movement and range', () => {
  it('moves up to 4 territories in combat movement (1942 2e p.10: move 4)', () => {
    const s = freshGame(2, 44);
    const pid = s.currentPlayer;
    // california -> gulf_south is 4 steps; rig both friendly BEFORE
    // gotoCombatMove so ownedAtTurnStart covers the landing spot.
    for (const t of ['california', 'gulf_south']) s.territories[t].owner = pid;
    s.territories['california'].units.fighter = 1;
    gotoCombatMove(s);
    // 4 steps out, 0 remaining: must land at the destination itself.
    const r = combatMove(s, pid, [{ from: 'california', to: 'gulf_south', units: { fighter: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['gulf_south'].units.fighter).toBe(1);
  });

  it('cannot move 5 territories (1942 2e p.10: move 4)', () => {
    const s = freshGame(2, 45);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    // california -> southeast is 5 steps: beyond fighter range.
    for (const t of ['california', 'southeast']) s.territories[t].owner = pid;
    s.territories['california'].units.fighter = 1;
    const r = combatMove(s, pid, [{ from: 'california', to: 'southeast', units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('needs a reachable landing spot (1942 2e p.15: air units must land)', () => {
    const s = freshGame(2, 46);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['california'].owner = pid;
    s.territories['california'].units.fighter = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    // 3 steps out, 1 remaining, but the only turn-start friendly ground
    // (california) is 3 steps back: no legal landing.
    s.ownedAtTurnStart = ['california'];
    expect(combatMove(s, pid, [{ from: 'california', to: 'montana', units: { fighter: 1 } }]).code).toBe(
      'no_landing',
    );
  });

  it('can attack when a landing spot is in range (1942 2e p.15)', () => {
    const s = freshGame(2, 47);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.fighter = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    gotoCombatMove(s);
    // 1 step out, 3 remaining: idaho (turn-start friendly) is reachable.
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
  });
});

describe('fighter strategic bombing raids', () => {
  it('cannot escort a bombing raid — engine requires bombers only (1942 2e p.17 vs engine)', () => {
    // 1942 2e p.17 allows fighters to escort SBRs, but this engine's
    // combatMove rejects any non-bomber in an SBR declaration
    // (sbr_bombers). This test pins the engine's actual behavior.
    const s = freshGame(2, 48);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['pa_nj'].owner = pid;
    s.territories['pa_nj'].units.bomber = 1;
    s.territories['pa_nj'].units.fighter = 1;
    s.ownedAtTurnStart.push('pa_nj');
    s.territories['new_york'].owner = foe;
    s.territories['new_york'].factory = true;
    const r = combatMove(s, pid, [
      { from: 'pa_nj', to: 'new_york', units: { bomber: 1, fighter: 1 }, sbr: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('sbr_bombers');
  });
});

describe('fighter noncombat movement', () => {
  it('repositions in noncombat movement (1942 2e p.22)', () => {
    const s = freshGame(2, 49);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['california'].units.fighter = 1;
    s.territories['arizona'].owner = pid;
    gotoCombatMove(s);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { fighter: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['arizona'].units.fighter).toBe(1);
  });

  it('lands after combat during noncombat movement (1942 2e p.22: air units land)', () => {
    const s = freshGame(2, 50);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.fighter = 1;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 1, infantry: 2 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    // The fighter is aloft over montana; land it back at idaho (friendly).
    const r = nonCombatMove(s, pid, [{ from: 'montana', to: 'idaho', units: { fighter: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['idaho'].units.fighter).toBe(1);
  });
});
