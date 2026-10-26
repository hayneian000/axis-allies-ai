// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  combatMove,
  nonCombatMove,
  openBattles,
  purchase,
  resolveCombatRound,
} from '../../../engine/engine';
import { UNITS, neighborsOf } from '../../../data/data';
import {
  freshGame,
  gotoCombat,
  gotoCombatMove,
  gotoNonCombat,
  resolveAllAuto,
  resolveBattleAuto,
} from '../../helpers';

/**
 * Tank - 1942 2e p.10 (unit profile), p.14 (blitz).
 * Cost 6 (FAQ errata: not 5), attack 3, defense 3, move 2, blitz.
 */
describe('tank profile', () => {
  it('costs 6 IPCs - FAQ errata, not 5 (1942 2e p.10, FAQ Nov 2012)', () => {
    expect(UNITS.tank.cost).toBe(6);
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    expect(purchase(s, pid, [{ type: 'tank', count: 1 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 6);
  });

  it('has attack 3, defense 3, move 2 (1942 2e p.10)', () => {
    expect(UNITS.tank.attack).toBe(3);
    expect(UNITS.tank.defense).toBe(3);
    expect(UNITS.tank.move).toBe(2);
  });
});

describe('tank combat values', () => {
  it('attack dice hit on 3 or less (1942 2e p.10: attack 3)', () => {
    const s = freshGame(2, 42);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 3;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { tank: 2 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    const expected = c.attackRolls.filter((d) => d <= 3).length;
    expect(c.attackHits).toBe(expected);
  });

  it('defense dice hit on 3 or less (1942 2e p.10: defense 3)', () => {
    const s = freshGame(2, 43);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    // Attack the tank: montana (foe, 2 tanks) <- idaho (mine, 3 inf).
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.tank = 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    const r = resolveCombatRound(s, pid, 'montana');
    expect(r.ok).toBe(true);
    const c = r.combat!;
    const expected = c.defenseRolls.filter((d) => d <= 3).length;
    expect(c.defenseHits).toBe(expected);
  });
});

describe('tank movement', () => {
  it('moves 2 through friendly territories in combat movement (1942 2e p.10)', () => {
    const s = freshGame(2, 44);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    // california -> oregon -> washington, all friendly.
    for (const t of ['california', 'oregon', 'washington']) s.territories[t].owner = pid;
    s.territories['california'].units.tank = 1;
    const r = combatMove(s, pid, [{ from: 'california', to: 'washington', units: { tank: 1 } }]);
    expect(r.ok).toBe(true);
    expect(s.territories['washington'].units.tank).toBe(1);
  });

  it('cannot move 3 territories (1942 2e p.10: move 2)', () => {
    const s = freshGame(2, 45);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    // california -> montana is 3 steps minimum (via nevada_utah -> idaho): illegal.
    for (const t of ['california', 'nevada_utah', 'idaho', 'montana']) s.territories[t].owner = pid;
    s.territories['california'].units.tank = 1;
    const r = combatMove(s, pid, [{ from: 'california', to: 'montana', units: { tank: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('moves 2 in noncombat movement (1942 2e p.22)', () => {
    const s = freshGame(2, 46);
    const pid = s.currentPlayer;
    for (const t of ['california', 'oregon', 'washington']) s.territories[t].owner = pid;
    s.territories['california'].units.tank = 1;
    gotoCombatMove(s);
    gotoCombat(s);
    resolveAllAuto(s, pid);
    gotoNonCombat(s);
    expect(nonCombatMove(s, pid, [{ from: 'california', to: 'washington', units: { tank: 1 } }]).ok).toBe(true);
  });
});

describe('tank blitz (1942 2e p.14)', () => {
  it('blitzes through an unoccupied enemy territory, capturing it in passing', () => {
    // 1942 2e p.14: a tank may move through an unoccupied hostile territory
    // as the first step of its move and attack a second territory.
    const s = freshGame(2, 47);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    // idaho (mine, tank) -> montana (foe, empty) -> dakotas (foe, 1 inf).
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 0;
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    const r = combatMove(s, pid, [
      { from: 'idaho', to: 'dakotas', units: { tank: 1 }, via: ['montana'] },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    // Blitz capture: montana taken without a fight.
    expect(s.territories['montana'].owner).toBe(pid);
    // And a battle is open at dakotas.
    expect(openBattles(s).map((b) => b.territoryId)).toContain('dakotas');
  });

  it('a 2-step tank attack must declare its via territory (1942 2e p.14)', () => {
    const s = freshGame(2, 48);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 0;
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'dakotas', units: { tank: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blitz_path');
  });

  it('cannot blitz through an occupied enemy territory (1942 2e p.14)', () => {
    const s = freshGame(2, 49);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 1;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1; // occupied: blocks blitz
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    const r = combatMove(s, pid, [
      { from: 'idaho', to: 'dakotas', units: { tank: 1 }, via: ['montana'] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blocked');
  });

  it('cannot blitz through a defended neutral (FFA decision: neutrals garrisoned)', () => {
    // FFA decision (project decision, Oct 3 2026): neutral territories hold 2-infantry
    // garrisons, so they are occupied and block blitzing.
    const s = freshGame(2, 50);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const neutral = Object.entries(s.territories).find(([, t]) => t.owner === null)?.[0];
    expect(neutral).toBeDefined();
    // Find a chain mine -> neutral -> foe through map adjacency.
    const chain = findChain(s, pid, neutral!);
    expect(chain, 'no mine->neutral->foe chain on this map/seed').toBeDefined();
    const [a, , c] = chain!;
    s.territories[a].units.tank = 1;
    const r = combatMove(s, pid, [{ from: a, to: c, units: { tank: 1 }, via: [neutral!] }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('blocked');
  });

  it('2-step move through friendly territory is not a blitz (no capture needed)', () => {
    const s = freshGame(2, 51);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    // idaho (mine) -> montana (mine) -> dakotas (foe): normal attack.
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 1;
    s.territories['montana'].owner = pid;
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    const r = combatMove(s, pid, [
      { from: 'idaho', to: 'dakotas', units: { tank: 1 }, via: ['montana'] },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(openBattles(s).map((b) => b.territoryId)).toContain('dakotas');
  });

  it('blitzed territory can be fought over afterwards like any capture', () => {
    const s = freshGame(2, 52);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.tank = 2;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 0;
    s.territories['dakotas'].owner = foe;
    s.territories['dakotas'].units.infantry = 1;
    expect(
      combatMove(s, pid, [{ from: 'idaho', to: 'dakotas', units: { tank: 2 }, via: ['montana'] }]).ok,
    ).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'dakotas');
    const b = s.battles.find((x) => x.territoryId === 'dakotas')!;
    expect(b.over).toBe(true);
  });
});

/** Find a, c such that a is pid-owned and adjacent to neutral, neutral adjacent to c, c hostile. */
function findChain(
  s: ReturnType<typeof freshGame>,
  pid: number,
  neutral: string,
): [string, string, string] | undefined {
  for (const a of neighborsOf(neutral)) {
    if (s.territories[a]?.owner !== pid) continue;
    for (const c of neighborsOf(neutral)) {
      if (c === a) continue;
      const co = s.territories[c]?.owner;
      if (co !== null && co !== pid) return [a, neutral, c];
    }
  }
  return undefined;
}
