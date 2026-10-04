// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  combatMove,
  emptyUnits,
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
 * Infantry — 1942 2e p.10 (unit profile), p.18 (artillery support).
 * Cost 3, attack 1 (2 when supported), defense 2, move 1.
 */
describe('infantry profile', () => {
  it('costs 3 IPCs (1942 2e p.10)', () => {
    expect(UNITS.infantry.cost).toBe(3);
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 6);
  });

  it('has attack 1, defense 2, move 1 (1942 2e p.10)', () => {
    expect(UNITS.infantry.attack).toBe(1);
    expect(UNITS.infantry.defense).toBe(2);
    expect(UNITS.infantry.move).toBe(1);
  });
});

describe('infantry combat', () => {
  it('attack dice hit on 1 or less (1942 2e p.10: attack 1)', () => {
    const s = freshGame(2, 31);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    // Rig: idaho (mine, 3 inf) -> montana (foe, 2 inf).
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    const foe = (pid + 1) % 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 2;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    // Every attacking die hits iff it rolled <= 1.
    const expected = c.attackRolls.filter((d) => d <= 1).length;
    expect(c.attackHits).toBe(expected);
  });

  it('defense dice hit on 2 or less (1942 2e p.10: defense 2)', () => {
    const s = freshGame(2, 32);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 2;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    // Every defending die hits iff it rolled <= 2.
    const expected = c.defenseRolls.filter((d) => d <= 2).length;
    expect(c.defenseHits).toBe(expected);
  });

  it('a lone infantry battle resolves to completion', () => {
    const s = freshGame(2, 33);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'montana');
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    expect(b.over).toBe(true);
  });
});

describe('infantry movement', () => {
  it('moves 1 territory in combat movement (1942 2e p.10)', () => {
    const s = freshGame(2, 34);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    // idaho -> montana is adjacent: legal.
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1 } }]).ok).toBe(true);
  });

  it('cannot move 2 territories (1942 2e p.10: move 1)', () => {
    const s = freshGame(2, 35);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    // idaho -> dakotas is two steps (via montana/wyoming): illegal for infantry.
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'dakotas', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('cannot move 2 territories in noncombat either (1942 2e p.10)', () => {
    const s = freshGame(2, 36);
    const pid = s.currentPlayer;
    // Friendly reposition idaho -> dakotas (2 steps): illegal for infantry.
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = pid;
    s.territories['dakotas'].owner = pid;
    gotoCombatMove(s);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'idaho', to: 'dakotas', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
  });

  it('moves 1 territory to friendly land in noncombat (1942 2e p.22)', () => {
    const s = freshGame(2, 37);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = pid;
    gotoCombatMove(s);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    expect(nonCombatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1 } }]).ok).toBe(true);
    expect(s.territories['montana'].units.infantry).toBeGreaterThanOrEqual(1);
  });
});

describe('infantry with artillery support (1942 2e p.18)', () => {
  it('paired infantry attacks at 2 — statistical check over seeds', () => {
    // 1942 2e p.18: each artillery supports one paired infantry (attack 2).
    let pairedHits = 0;
    let pairedDice = 0;
    let loneHits = 0;
    let loneDice = 0;
    for (let seed = 200; seed < 230; seed++) {
      for (const [inf, art, bucket] of [[1, 1, 'paired'], [1, 0, 'lone']] as const) {
        const s = freshGame(2, seed);
        gotoCombatMove(s);
        const pid = s.currentPlayer;
        const foe = (pid + 1) % 2;
        s.territories['idaho'].owner = pid;
        s.territories['idaho'].units.infantry = inf;
        s.territories['idaho'].units.artillery = art;
        s.territories['montana'].owner = foe;
        s.territories['montana'].units.infantry = 8;
        const units = art > 0 ? { infantry: inf, artillery: art } : { infantry: inf };
        combatMove(s, pid, [{ from: 'idaho', to: 'montana', units }]);
        gotoCombat(s);
        const r = resolveCombatRound(s, pid, 'montana');
        if (!r.ok) continue;
        const c = r.combat!;
        if (bucket === 'paired') {
          pairedHits += c.attackHits;
          pairedDice += c.attackRolls.length;
        } else {
          loneHits += c.attackHits;
          loneDice += c.attackRolls.length;
        }
      }
    }
    // Paired dice hit on <=2 (1/3); lone infantry dice hit on <=1 (1/6),
    // lone artillery dice hit on <=2 — paired must outperform overall.
    expect(pairedDice).toBeGreaterThan(0);
    expect(loneDice).toBeGreaterThan(0);
    expect(pairedHits / pairedDice).toBeGreaterThan(loneHits / loneDice);
  });

  it('pairing is 1:1 — a second infantry without its own artillery is not boosted (1942 2e p.18)', () => {
    // 2 inf + 1 art: only one infantry attacks at 2. Per-die hit rate must be
    // below the fully-paired case (1 inf + 1 art, every die hits on <=2).
    let halfPairedRate = 0;
    let fullPairedRate = 0;
    const N = 30;
    for (let seed = 300; seed < 300 + N; seed++) {
      for (const [inf, art, which] of [[2, 1, 'half'], [1, 1, 'full']] as const) {
        const s = freshGame(2, seed);
        gotoCombatMove(s);
        const pid = s.currentPlayer;
        const foe = (pid + 1) % 2;
        s.territories['idaho'].owner = pid;
        s.territories['idaho'].units.infantry = inf;
        s.territories['idaho'].units.artillery = art;
        s.territories['montana'].owner = foe;
        s.territories['montana'].units.infantry = 8;
        combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: inf, artillery: art } }]);
        gotoCombat(s);
        const r = resolveCombatRound(s, pid, 'montana');
        if (!r.ok) continue;
        const c = r.combat!;
        const rate = c.attackHits / c.attackRolls.length;
        if (which === 'half') halfPairedRate += rate;
        else fullPairedRate += rate;
      }
    }
    // Fully paired: every die hits on <=2 (rate ~1/3).
    // Half paired: one die hits on <=1 (rate ~(2+1+2)/18 = 5/18 < 1/3).
    expect(fullPairedRate / N).toBeGreaterThan(halfPairedRate / N);
  });
});
