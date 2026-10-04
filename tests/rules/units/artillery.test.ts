import { describe, expect, it } from 'vitest';
import { combatMove, emptyUnits, purchase, resolveCombatRound } from '../../../engine/engine';
import type { GameState, UnitCounts } from '../../../engine/types';
import { freshGame, gotoCombat, gotoCombatMove } from '../../helpers';

/** Rig idaho (owned by current player) -> montana (owned by foe) and declare combat. */
function rigBattle(
  seed: number,
  atkUnits: Partial<UnitCounts>,
  defUnits: Partial<UnitCounts>,
): { s: GameState; pid: number } {
  const s = freshGame(2, seed);
  gotoCombatMove(s);
  const pid = s.currentPlayer;
  const foe = (pid + 1) % 2;
  s.territories['idaho'].owner = pid;
  s.territories['idaho'].units = { ...emptyUnits(), ...atkUnits };
  s.territories['montana'].owner = foe;
  s.territories['montana'].units = { ...emptyUnits(), ...defUnits };
  const mv = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: atkUnits }]);
  expect(mv.ok, `combatMove: ${mv.code} ${mv.error}`).toBe(true);
  gotoCombat(s);
  return { s, pid };
}

/** Collect one round of attack dice for `count` attacking artillery. */
function artilleryAttackDice(count: number, seeds: number): number[] {
  const dice: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const { s, pid } = rigBattle(11000 + i, { artillery: count }, { infantry: 30 });
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    dice.push(...r.combat!.attackRolls);
  }
  return dice;
}

describe('artillery', () => {
  it('attacks at 2 (statistical)', () => {
    // 1942 2e p.10.
    const dice = artilleryAttackDice(8, 50);
    expect(dice).toHaveLength(400);
    const rate = dice.filter((d) => d <= 2).length / dice.length;
    expect(rate).toBeGreaterThan(1 / 3 - 0.08);
    expect(rate).toBeLessThan(1 / 3 + 0.08);
  });

  it('defends at 2 (statistical)', () => {
    // 1942 2e p.10.
    const dice: number[] = [];
    for (let i = 0; i < 50; i++) {
      const { s, pid } = rigBattle(11100 + i, { infantry: 1 }, { artillery: 10 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      dice.push(...r.combat!.defenseRolls);
    }
    expect(dice).toHaveLength(500);
    const rate = dice.filter((d) => d <= 2).length / dice.length;
    expect(rate).toBeGreaterThan(1 / 3 - 0.08);
    expect(rate).toBeLessThan(1 / 3 + 0.08);
  });

  it('supports one infantry 1:1 — the paired infantry attacks at 2 (statistical)', () => {
    // 1942 2e p.18: "Each artillery can support one infantry." The supported
    // infantry attacks at 2 instead of 1.
    let pairedHits = 0;
    let loneHits = 0;
    const seeds = 80;
    for (let i = 0; i < seeds; i++) {
      const { s, pid } = rigBattle(11200 + i, { infantry: 2, artillery: 1 }, { infantry: 30 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      const dice = r.combat!.attackRolls;
      // Dice order: boosted infantry first, then lone infantry, then artillery.
      if (dice[0] <= 2) pairedHits++;
      if (dice[1] <= 1) loneHits++;
    }
    expect(pairedHits).toBeGreaterThan(loneHits);
  });

  it('only one infantry is boosted per artillery (statistical)', () => {
    // 1942 2e p.18: pairing is strictly 1:1. With 3 infantry and 1 artillery,
    // exactly one infantry attacks at 2; the other two attack at 1.
    let boostedHits = 0;
    let loneHits = 0;
    const seeds = 80;
    for (let i = 0; i < seeds; i++) {
      const { s, pid } = rigBattle(11300 + i, { infantry: 3, artillery: 1 }, { infantry: 30 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      const dice = r.combat!.attackRolls;
      if (dice[0] <= 2) boostedHits++;
      if (dice[1] <= 1) loneHits++;
      if (dice[2] <= 1) loneHits++;
    }
    const boostedRate = boostedHits / seeds;
    const loneRate = loneHits / (seeds * 2);
    expect(boostedRate).toBeGreaterThan(loneRate);
  });

  it('two artillery support two infantry (statistical)', () => {
    // 1942 2e p.18: 1:1 pairing scales — both infantry are boosted.
    let boostedHits = 0;
    const seeds = 100;
    for (let i = 0; i < seeds; i++) {
      const { s, pid } = rigBattle(11400 + i, { infantry: 2, artillery: 2 }, { infantry: 30 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      const dice = r.combat!.attackRolls;
      if (dice[0] <= 2) boostedHits++;
      if (dice[1] <= 2) boostedHits++;
    }
    // 200 dice at p=1/3: expect ~67 hits; well above the unboosted ~33.
    expect(boostedHits).toBeGreaterThan(50);
  });

  it('excess artillery beyond the pairing attacks normally at 2 (statistical)', () => {
    // 1942 2e p.18: artillery without a paired infantry still attacks at its
    // own value of 2 — no penalty, no bonus.
    const dice: number[] = [];
    for (let i = 0; i < 100; i++) {
      const { s, pid } = rigBattle(11500 + i, { infantry: 1, artillery: 3 }, { infantry: 30 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      // Dice: 1 boosted infantry, then 3 artillery — all attack at 2.
      dice.push(...r.combat!.attackRolls);
    }
    expect(dice).toHaveLength(400);
    const rate = dice.filter((d) => d <= 2).length / dice.length;
    expect(rate).toBeGreaterThan(1 / 3 - 0.08);
    expect(rate).toBeLessThan(1 / 3 + 0.08);
  });

  it('moves 1 territory in combat movement; costs 4 IPCs', () => {
    // 1942 2e p.10: movement allowance 1. 1942 2e p.9: cost 4 IPCs.
    const s = freshGame(2, 11600);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    void foe;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units = { ...emptyUnits(), artillery: 2 };
    s.territories['wyoming'].owner = pid;
    s.territories['dakotas'].owner = pid;
    // Adjacent friendly reposition: legal.
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'wyoming', units: { artillery: 1 } }]).ok).toBe(
      true,
    );
    // Two-hop move: rejected (artillery moves 1).
    const bad = combatMove(s, pid, [{ from: 'idaho', to: 'dakotas', units: { artillery: 1 } }]);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('range');

    // Cost check in the purchase phase.
    const s2 = freshGame(2, 11601);
    const pid2 = s2.currentPlayer;
    const before = s2.players[pid2].ipcs;
    expect(purchase(s2, pid2, [{ type: 'artillery', count: 2 }]).ok).toBe(true);
    expect(s2.players[pid2].ipcs).toBe(before - 8);
  });
});
