import { describe, expect, it } from 'vitest';
import {
  autoCasualties,
  autoCasualtyPolicy,
  chooseCasualties,
  combatMove,
  emptyUnits,
  resolveCombatRound,
  retreat,
  serialize,
} from '../../engine/engine';
import type { GameState, UnitCounts } from '../../engine/types';
import { freshGame, gotoCombat, gotoCombatMove, resolveBattleAuto } from '../helpers';

type AirLandType = 'infantry' | 'artillery' | 'tank' | 'fighter' | 'bomber';

/** Rig idaho (owned by current player) -> montana (owned by foe) and declare combat. */
function rigBattle(
  seed: number,
  atkUnits: Partial<UnitCounts>,
  defUnits: Partial<UnitCounts>,
): { s: GameState; pid: number; foe: number } {
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
  return { s, pid, foe };
}

/**
 * One round of attack dice for `count` units of a single type, across `seeds`
 * games. Defenders are a 30-infantry meat shield so the round always yields
 * a full set of dice to read.
 */
function attackDice(type: AirLandType, count: number, seeds: number): number[] {
  const dice: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const { s, pid } = rigBattle(5000 + i, { [type]: count } as Partial<UnitCounts>, {
      infantry: 30,
    });
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    dice.push(...r.combat!.attackRolls);
  }
  return dice;
}

/** One round of defense dice for `count` units of a single defending type. */
function defenseDice(type: AirLandType, count: number, seeds: number): number[] {
  const dice: number[] = [];
  for (let i = 0; i < seeds; i++) {
    const { s, pid } = rigBattle(7000 + i, { infantry: 1 }, { [type]: count } as Partial<UnitCounts>);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    dice.push(...r.combat!.defenseRolls);
  }
  return dice;
}

/** Assert the observed hit rate is within `tol` of the theoretical p = value/6. */
function expectHitRate(dice: number[], value: number, tol = 0.09): void {
  expect(dice.length).toBeGreaterThan(0);
  const rate = dice.filter((d) => d <= value).length / dice.length;
  const expected = value / 6;
  expect(rate, `hit rate for value ${value}: got ${rate.toFixed(3)}, want ~${expected.toFixed(3)}`).toBeGreaterThan(
    expected - tol,
  );
  expect(rate).toBeLessThan(expected + tol);
}

describe('AA fire', () => {
  it('fires only in the first round of a battle', () => {
    // 1942 2e p.25: "Antiaircraft fire occurs once per battle, before the
    // first round of general combat."
    let checked = false;
    for (let i = 0; i < 30 && !checked; i++) {
      const s = freshGame(2, 9600 + i);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const foe = (pid + 1) % 2;
      s.territories['idaho'].owner = pid;
      s.territories['idaho'].units = { ...emptyUnits(), fighter: 10 };
      s.territories['montana'].owner = foe;
      s.territories['montana'].units = { ...emptyUnits(), infantry: 12, aa: 1 };
      const mv = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 10 } }]);
      expect(mv.ok).toBe(true);
      gotoCombat(s);
      const r1 = resolveCombatRound(s, pid, 'montana');
      expect(r1.ok).toBe(true);
      expect(r1.combat!.aaRolls).toHaveLength(1); // one AA gun = one die
      if (r1.combat!.pendingAttacker > 0) {
        expect(autoCasualties(s, pid, 'montana', 'attacker').ok).toBe(true);
      }
      if (r1.combat!.pendingDefender > 0) {
        expect(autoCasualties(s, pid, 'montana', 'defender').ok).toBe(true);
      }
      const b = s.battles.find((x) => x.territoryId === 'montana' && !x.over);
      if (!b) continue; // battle ended; try another seed
      const r2 = resolveCombatRound(s, pid, 'montana');
      expect(r2.ok).toBe(true);
      expect(r2.combat!.aaRolls).toHaveLength(0);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it('does not fire when the attacker brings no aircraft', () => {
    // 1942 2e p.25: AA fires "at attacking air units" — ground-only attacks
    // are unaffected.
    const { s, pid } = rigBattle(9700, { infantry: 4, tank: 2 }, { infantry: 2, aa: 2 });
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    expect(r.combat!.aaRolls).toHaveLength(0);
    expect(r.combat!.aaHits).toBe(0);
  });

  it('hits on a roll of 1 (statistical)', () => {
    // 1942 2e p.25.
    const dice: number[] = [];
    for (let i = 0; i < 100; i++) {
      const s = freshGame(2, 9800 + i);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const foe = (pid + 1) % 2;
      s.territories['idaho'].owner = pid;
      s.territories['idaho'].units = { ...emptyUnits(), fighter: 5 };
      s.territories['montana'].owner = foe;
      s.territories['montana'].units = { ...emptyUnits(), infantry: 10, aa: 2 };
      const mv = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 5 } }]);
      expect(mv.ok).toBe(true);
      gotoCombat(s);
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      dice.push(...r.combat!.aaRolls);
    }
    expect(dice).toHaveLength(200); // 2 AA x 100 battles
    expectHitRate(dice, 1, 0.08);
  });

  it('AA hits cannot exceed the number of attacking aircraft', () => {
    // Engine rule: each AA hit destroys one aircraft, so hits are capped at
    // the air count. 1942 2e p.25: casualties come from the attacking air units.
    for (let i = 0; i < 30; i++) {
      const s = freshGame(2, 9900 + i);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const foe = (pid + 1) % 2;
      s.territories['idaho'].owner = pid;
      s.territories['idaho'].units = { ...emptyUnits(), fighter: 1, infantry: 1 };
      s.territories['montana'].owner = foe;
      s.territories['montana'].units = { ...emptyUnits(), aa: 3 };
      const mv = combatMove(s, pid, [
        { from: 'idaho', to: 'montana', units: { fighter: 1, infantry: 1 } },
      ]);
      expect(mv.ok).toBe(true);
      gotoCombat(s);
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      expect(r.combat!.aaRolls).toHaveLength(3);
      expect(r.combat!.aaHits).toBeLessThanOrEqual(1);
    }
  });
});

describe('unit combat profiles', () => {
  it('attack values match the rulebook (statistical)', () => {
    // 1942 2e p.10: infantry 1, artillery 2, tank 3, fighter 3, bomber 4.
    const profiles: Array<[AirLandType, number]> = [
      ['infantry', 1],
      ['artillery', 2],
      ['tank', 3],
      ['fighter', 3],
      ['bomber', 4],
    ];
    for (const [type, value] of profiles) {
      const dice = attackDice(type, 8, 40);
      expect(dice).toHaveLength(320);
      expectHitRate(dice, value);
    }
  });

  it('defense values match the rulebook (statistical)', () => {
    // 1942 2e p.10: infantry 2, artillery 2, tank 3, fighter 4, bomber 1.
    // (AA guns never roll; they are captured, not destroyed. 1942 2e p.25.)
    const profiles: Array<[AirLandType, number]> = [
      ['infantry', 2],
      ['artillery', 2],
      ['tank', 3],
      ['fighter', 4],
      ['bomber', 1],
    ];
    for (const [type, value] of profiles) {
      const dice = defenseDice(type, 10, 40);
      expect(dice).toHaveLength(400);
      expectHitRate(dice, value);
    }
  });

  it('artillery supports paired infantry 1:1 — boosted infantry attacks at 2 (statistical)', () => {
    // 1942 2e p.18: "Each artillery can support one infantry." The paired
    // infantry attacks at 2 instead of 1.
    let pairedHits = 0;
    let loneHits = 0;
    const seeds = 80;
    for (let i = 0; i < seeds; i++) {
      const { s, pid } = rigBattle(10100 + i, { infantry: 2, artillery: 1 }, { infantry: 30 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      const dice = r.combat!.attackRolls;
      // Dice order: boosted infantry first, then lone infantry, then artillery.
      if (dice[0] <= 2) pairedHits++;
      if (dice[1] <= 1) loneHits++;
    }
    expect(pairedHits).toBeGreaterThan(loneHits);
  });
});

describe('casualty selection', () => {
  it('the unit owner chooses; the engine validates the selection', () => {
    // 1942 2e p.19: "The owner of the units chooses which units are removed."
    let s: GameState | null = null;
    let pid = 0;
    for (let i = 0; i < 20 && !s; i++) {
      const rig = rigBattle(10200 + i, { infantry: 3 }, { infantry: 12 });
      const r = resolveCombatRound(rig.s, rig.pid, 'montana');
      expect(r.ok).toBe(true);
      const b = rig.s.battles.find((x) => x.territoryId === 'montana')!;
      if (!b.over && b.pendingAttacker > 0) {
        s = rig.s;
        pid = rig.pid;
      }
    }
    expect(s, 'expected a seed with attacker casualties').not.toBeNull();
    const game = s!;
    const b = game.battles.find((x) => x.territoryId === 'montana')!;
    const pending = b.pendingAttacker;
    expect(pending).toBeGreaterThan(0);

    const before = serialize(game);
    expect(chooseCasualties(game, pid, 'montana', 'attacker', { aa: 1 }).code).toBe('aa_spared');
    expect(chooseCasualties(game, pid, 'montana', 'attacker', { infantry: 99 }).code).toBe(
      'too_few_units',
    );
    expect(chooseCasualties(game, pid, 'montana', 'attacker', { infantry: 0 }).code).toBe(
      'bad_casualties',
    );
    expect(serialize(game)).toBe(before);

    const take = Math.min(pending, b.attack.infantry);
    expect(chooseCasualties(game, pid, 'montana', 'attacker', { infantry: take }).ok).toBe(true);
    expect(b.pendingAttacker).toBe(0);
  });

  it('AA guns are never taken as casualties', () => {
    // 1942 2e p.25: AA guns are captured when a territory falls; they are
    // never removed as combat casualties.
    const force = { ...emptyUnits(), infantry: 1, aa: 1 };
    expect(autoCasualtyPolicy(force, 1)).toEqual({ infantry: 1 });
    expect(autoCasualtyPolicy(force, 99)).toEqual({ infantry: 1 });

    let s: GameState | null = null;
    let pid = 0;
    for (let i = 0; i < 20 && !s; i++) {
      const rig = rigBattle(10300 + i, { infantry: 3 }, { infantry: 12 });
      const r = resolveCombatRound(rig.s, rig.pid, 'montana');
      expect(r.ok).toBe(true);
      const b = rig.s.battles.find((x) => x.territoryId === 'montana')!;
      if (!b.over && b.pendingAttacker > 0) {
        s = rig.s;
        pid = rig.pid;
      }
    }
    expect(s).not.toBeNull();
    expect(chooseCasualties(s!, pid, 'montana', 'attacker', { aa: 1 }).code).toBe('aa_spared');
  });

  it('neutral garrison casualties are applied automatically', () => {
    // Engine rule: neutral defenders have no player to choose casualties, so
    // the auto policy is applied immediately inside the combat round.
    const s = freshGame(2, 10400);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units = { ...emptyUnits(), infantry: 6 };
    s.territories['montana'].owner = null;
    s.territories['montana'].units = { ...emptyUnits(), infantry: 2 };
    const mv = combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 6 } }]);
    expect(mv.ok, `combatMove: ${mv.code} ${mv.error}`).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    expect(b.defenderId).toBe(null);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    // Defender hits were auto-applied: never left pending, and choosing for
    // the neutral side is rejected.
    expect(b.pendingDefender).toBe(0);
    expect(chooseCasualties(s, pid, 'montana', 'defender', { infantry: 1 }).code).toBe('auto');
  });
});

describe('retreat', () => {
  it('attacker may retreat after a full round, to an origin territory; defender never retreats', () => {
    // 1942 2e p.20: "The attacker can retreat after any round of combat...
    // move all attacking land units to a single adjacent friendly territory
    // from which the attack was launched." The defender never retreats.

    // (a) No retreat before the first round completes.
    {
      const { s, pid } = rigBattle(10500, { infantry: 3 }, { infantry: 5 });
      expect(retreat(s, pid, 'montana', 'idaho').code).toBe('no_rounds');
    }

    // (b) No retreat while casualties are pending.
    {
      let done = false;
      for (let i = 0; i < 20 && !done; i++) {
        const { s, pid } = rigBattle(10520 + i, { infantry: 3 }, { infantry: 12 });
        const r = resolveCombatRound(s, pid, 'montana');
        expect(r.ok).toBe(true);
        const b = s.battles.find((x) => x.territoryId === 'montana')!;
        if (!b.over && b.pendingAttacker > 0) {
          expect(retreat(s, pid, 'montana', 'idaho').code).toBe('casualties_pending');
          done = true;
        }
      }
      expect(done).toBe(true);
    }

    // (c) Retreat destination must be a territory the attack came from.
    // (d) Successful retreat returns surviving land units to the origin.
    {
      let retreated = false;
      for (let i = 0; i < 30 && !retreated; i++) {
        const { s, pid, foe } = rigBattle(10540 + i, { infantry: 6 }, { infantry: 8 });
        const r = resolveCombatRound(s, pid, 'montana');
        expect(r.ok).toBe(true);
        if (r.combat!.pendingAttacker > 0) {
          expect(autoCasualties(s, pid, 'montana', 'attacker').ok).toBe(true);
        }
        if (r.combat!.pendingDefender > 0) {
          expect(autoCasualties(s, pid, 'montana', 'defender').ok).toBe(true);
        }
        const b = s.battles.find((x) => x.territoryId === 'montana' && !x.over);
        if (!b) continue;
        expect(retreat(s, pid, 'montana', 'wyoming').code).toBe('bad_retreat');
        const before = s.territories['idaho'].units.infantry;
        expect(retreat(s, pid, 'montana', 'idaho').ok).toBe(true);
        expect(s.territories['idaho'].units.infantry).toBeGreaterThan(before);
        expect(s.territories['montana'].owner).toBe(foe);
        expect(b.result).toBe('retreated');
        retreated = true;
      }
      expect(retreated).toBe(true);
    }

    // (e) The defender cannot retreat (only the current player — the attacker — acts).
    {
      const { s, pid, foe } = rigBattle(10580, { infantry: 3 }, { infantry: 3 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      expect(retreat(s, foe, 'montana', 'dakotas').code).toBe('not_your_turn');
    }
  });
});

describe('battle resolution', () => {
  it('a victorious attacker captures the territory', () => {
    // 1942 2e p.20: surviving attacking land units occupy the territory.
    const { s, pid } = rigBattle(10600, { tank: 10 }, { infantry: 1 });
    resolveBattleAuto(s, pid, 'montana');
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    expect(b.over).toBe(true);
    expect(b.result).toBe('captured');
    expect(s.territories['montana'].owner).toBe(pid);
    expect(s.territories['montana'].units.tank).toBeGreaterThan(0);
  });

  it('a surviving defender holds the territory', () => {
    // 1942 2e p.20: if the attacker is eliminated, the defender holds.
    const { s, pid, foe } = rigBattle(10620, { infantry: 1 }, { infantry: 10 });
    resolveBattleAuto(s, pid, 'montana');
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    expect(b.over).toBe(true);
    expect(b.result).toBe('defender_holds');
    expect(s.territories['montana'].owner).toBe(foe);
  });

  it('mutual annihilation leaves the territory with the defender', () => {
    // 1942 2e p.20: with no surviving attacking land units there is no
    // capture, so the defender retains the territory.
    let found = false;
    for (let seed = 0; seed < 500 && !found; seed++) {
      const { s, pid, foe } = rigBattle(10640 + seed, { infantry: 1 }, { infantry: 1 });
      const r = resolveCombatRound(s, pid, 'montana');
      expect(r.ok).toBe(true);
      // Both sides score exactly one hit in the opening round.
      if (r.combat!.attackHits === 1 && r.combat!.defenseHits === 1) {
        found = true;
        const b = s.battles.find((x) => x.territoryId === 'montana')!;
        expect(autoCasualties(s, pid, 'montana', 'attacker').ok).toBe(true);
        expect(autoCasualties(s, pid, 'montana', 'defender').ok).toBe(true);
        expect(b.over).toBe(true);
        expect(s.territories['montana'].owner).toBe(foe);
      }
    }
    expect(found, 'expected a seed with mutual annihilation').toBe(true);
  });
});
