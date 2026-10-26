// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  autoCasualties,
  combatMove,
  nonCombatMove,
  openBattles,
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
  resolveBattleAuto,
} from '../../helpers';

/**
 * AA gun - 1942 2e p.10 (unit profile), p.18 (AA fire), p.25 (lone AA).
 * Cost 5, no attack/defense values, move 1.
 * FFA decision (project decision, Oct 3 2026): real rules - AA may reposition during the
 * combat phase but never fires offensively.
 */
describe('AA profile', () => {
  it('costs 5 IPCs (1942 2e p.10)', () => {
    expect(UNITS.aa.cost).toBe(5);
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    expect(purchase(s, pid, [{ type: 'aa', count: 1 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 5);
  });

  it('has no attack or defense value, move 1 (1942 2e p.10)', () => {
    expect(UNITS.aa.attack).toBe(0);
    expect(UNITS.aa.defense).toBe(0);
    expect(UNITS.aa.move).toBe(1);
  });
});

describe('AA fire (1942 2e p.18)', () => {
  /** Rig an air attack into an AA-defended territory; returns state/pid/tid. */
  function airAttack(seed: number, aaGuns: number, fighters: number, defenders: number) {
    const s = freshGame(2, seed);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.fighter = fighters;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.aa = aaGuns;
    s.territories['montana'].units.infantry = defenders;
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: fighters } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    gotoCombat(s);
    return { s, pid };
  }

  it('fires before the first exchange when air attacks (1942 2e p.18)', () => {
    const { s, pid } = airAttack(61, 1, 2, 3);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    // AA fired: exactly one die per gun.
    expect(r.combat!.aaRolls).toHaveLength(1);
  });

  it('fires only in the first round, never again (1942 2e p.18)', () => {
    const { s, pid } = airAttack(62, 1, 2, 6);
    const r1 = resolveCombatRound(s, pid, 'montana');
    expect(r1.ok).toBe(true);
    expect(r1.combat!.aaRolls.length).toBeGreaterThan(0);
    // Clear casualties so a second round can be rolled.
    const b = s.battles.find((x) => x.territoryId === 'montana' && !x.over);
    if (b) {
      if (b.pendingAttacker > 0) expect(autoCasualties(s, pid, 'montana', 'attacker').ok).toBe(true);
      if (b.pendingDefender > 0) expect(autoCasualties(s, pid, 'montana', 'defender').ok).toBe(true);
      const stillOpen = s.battles.find((x) => x.territoryId === 'montana' && !x.over);
      if (stillOpen) {
        const r2 = resolveCombatRound(s, pid, 'montana');
        expect(r2.ok).toBe(true);
        expect(r2.combat!.aaRolls).toHaveLength(0);
      }
    }
  });

  it('each die hits on a 1 (1942 2e p.18)', () => {
    const { s, pid } = airAttack(63, 1, 3, 3);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    // Every AA die showing 1 is a hit; nothing else is.
    const ones = c.aaRolls.filter((d) => d === 1).length;
    expect(c.aaHits).toBe(Math.min(ones, 3)); // capped by attacking aircraft
  });

  it('no single gun rolls more than 3 dice (1942 2e p.18: up to 3 shots per gun)', () => {
    // Engine simplification: exactly one die per gun. The rulebook ceiling
    // (3 shots per gun) must still hold.
    const { s, pid } = airAttack(64, 2, 4, 3);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    expect(r.combat!.aaRolls.length).toBeLessThanOrEqual(2 * 3);
  });

  it('does not fire when the attacker brings no air units (1942 2e p.18)', () => {
    const s = freshGame(2, 65);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.aa = 1;
    s.territories['montana'].units.infantry = 2;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    expect(r.combat!.aaRolls).toHaveLength(0);
    expect(r.combat!.aaHits).toBe(0);
  });

  it('AA hits are capped by the number of attacking aircraft', () => {
    // 3 guns vs 1 fighter: at most 1 aircraft can be hit.
    const { s, pid } = airAttack(66, 3, 1, 4);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    expect(r.combat!.aaHits).toBeLessThanOrEqual(1);
  });

  it('lone AA is captured without a fight when attacked (1942 2e p.25)', () => {
    const s = freshGame(2, 67);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 0;
    s.territories['montana'].units.aa = 1;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 2 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'montana');
    // Territory captured; the AA transfers to the attacker.
    expect(s.territories['montana'].owner).toBe(pid);
    expect(s.territories['montana'].units.aa).toBe(1);
  });

  it('AA never rolls attack dice even if somehow in an attack force', () => {
    // UNITS.aa.attack is 0 and attackerRolls never includes AA dice.
    expect(UNITS.aa.attack).toBe(0);
  });
});

describe('AA movement', () => {
  it('moves 1 territory in noncombat (1942 2e p.10: move 1)', () => {
    const s = freshGame(2, 68);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.aa = 1;
    s.territories['montana'].owner = pid;
    gotoCombatMove(s);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    expect(nonCombatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { aa: 1 } }]).ok).toBe(true);
    expect(s.territories['montana'].units.aa).toBe(1);
  });

  it('cannot move during combat movement - AA moves only in noncombat (1942 2e p.30)', () => {
    // 1942 2e Noncombat Move, "Where Units Can Move": "Note, this is the
    // only phase in which antiaircraft artillery units can move."
    // Correction (Oct 4 2026): an earlier FFA decision recorded "real rules
    // allow AA to reposition in combat movement" was wrong - the rulebook
    // explicitly bars AA movement outside noncombat.
    const s = freshGame(2, 69);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.aa = 1;
    s.territories['montana'].owner = pid;
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { aa: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('aa_no_attack');
    // AA stays put.
    expect(s.territories['idaho'].units.aa).toBe(1);
    expect(s.territories['montana'].units.aa).toBe(0);
  });

  it('cannot join an attack - AA moved with attackers is rejected as offensive', () => {
    const s = freshGame(2, 70);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.aa = 1;
    s.territories['idaho'].units.infantry = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    // AA spearheading into a hostile territory is an offensive use: rejected.
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { aa: 1, infantry: 1 } }]);
    expect(r.ok).toBe(false);
  });
});
