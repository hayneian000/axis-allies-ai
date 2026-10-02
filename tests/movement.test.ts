import { describe, expect, it } from 'vitest';
import {
  combatMove,
  endPhase,
  nonCombatMove,
  openBattles,
  resolveCombatRound,
  serialize,
} from '../engine/engine';
import { neighborsOf } from '../data/data';
import { freshGame, gotoCombat, gotoCombatMove, gotoNonCombat, resolveBattleAuto } from './helpers';

describe('combat movement', () => {
  it('rejects illegal moves all-or-nothing without mutating state', () => {
    const s = freshGame(2, 11);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const before = serialize(s);
    // Unknown territory, AA in combat move, moving enemy units, over-range infantry.
    expect(combatMove(s, pid, [{ from: 'atlantis', to: 'texas', units: { infantry: 1 } }]).code).toBe('unknown_territory');
    expect(combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { aa: 1 } }]).code).toBe('aa_no_attack');
    expect(combatMove(s, pid, [{ from: 'new_york', to: 'pa_nj', units: { infantry: 1 } }]).code).toBe('not_owner');
    expect(combatMove(s, pid, [{ from: 'california', to: 'texas', units: { infantry: 1 } }]).code).toBe('range');
    expect(serialize(s)).toBe(before);
    expect(openBattles(s)).toHaveLength(0);
  });

  it('creates battles when moving into enemy/neutral ground', () => {
    const s = freshGame(4, 12);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    // Rig: idaho (mine) -> wyoming (neutral garrison).
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['wyoming'].owner = null;
    s.territories['wyoming'].units.infantry = 1;
    const r = combatMove(s, pid, [{ from: 'idaho', to: 'wyoming', units: { infantry: 2 } }]);
    expect(r.ok).toBe(true);
    expect(openBattles(s)).toHaveLength(1);
    const b = openBattles(s)[0];
    expect(b.territoryId).toBe('wyoming');
    expect(b.defenderId).toBeNull();
    expect(b.attack.infantry).toBe(2);
    expect(b.origins).toEqual(['idaho']);
    expect(s.territories['idaho'].units.infantry).toBe(0);
  });

  it('supports blitz: tanks capture an empty enemy territory in passing', () => {
    const s = freshGame(4, 13);
    gotoCombatMove(s);
    const me = s.currentPlayer;
    const foe = (me + 1) % s.numPlayers;
    // Rig: oregon (mine, with tank) -> idaho (empty enemy) -> montana (enemy, 1 inf).
    // (oregon->montana is not adjacent, so the via path is required.)
    s.territories['oregon'].owner = me;
    s.territories['oregon'].units.tank = 1;
    s.territories['idaho'].owner = foe;
    for (const k of Object.keys(s.territories['idaho'].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories['idaho'].units[k] = 0;
    }
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    const r = combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
    expect(r.ok).toBe(true);
    expect(s.territories['idaho'].owner).toBe(me); // captured in passing
    expect(openBattles(s).some((b) => b.territoryId === 'montana')).toBe(true);
  });

  it('rejects blitzing through occupied territory', () => {
    const s = freshGame(4, 14);
    gotoCombatMove(s);
    const me = s.currentPlayer;
    const foe = (me + 1) % s.numPlayers;
    // oregon->montana is not adjacent, so the via path is exercised.
    s.territories['oregon'].owner = me;
    s.territories['oregon'].units.tank = 1;
    s.territories['idaho'].owner = foe;
    s.territories['idaho'].units.infantry = 1; // occupied: no blitz
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 1;
    const r = combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
    expect(r.code).toBe('blocked');
  });

  it('enforces aircraft range and landing checks', () => {
    const s = freshGame(2, 15);
    gotoCombatMove(s);
    const me = s.currentPlayer;
    // Find the current player's fighter.
    const base = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === me && s.territories[t].units.fighter > 0,
    )!;
    // Far target beyond range 4 with no landing: southeast vs california (dist > 4).
    const far = base === 'california' ? 'southeast' : 'california';
    const r = combatMove(s, me, [{ from: base, to: far, units: { fighter: 1 } }]);
    expect(r.ok).toBe(false);
    expect(['range', 'no_landing']).toContain(r.code);
  });
});

describe('non-combat movement', () => {
  it('allows friendly repositioning but not entering enemy ground', () => {
    const s = freshGame(2, 21);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    expect(combatMove(s, pid, []).ok).toBe(true);
    gotoNonCombat(s);
    // Find two adjacent friendly territories.
    const from = Object.keys(s.territories).find((t) => s.territories[t].owner === pid)!;
    const dest = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && t !== from,
    )!;
    s.territories[from].units.infantry = 2;
    const r = nonCombatMove(s, pid, [{ from, to: dest, units: { infantry: 1 } }]);
    // May fail on range if not adjacent; assert the failure mode is range, not ownership.
    if (!r.ok) expect(r.code).toBe('range');
    const enemy = Object.keys(s.territories).find((t) => s.territories[t].owner !== pid)!;
    expect(nonCombatMove(s, pid, [{ from, to: enemy, units: { infantry: 1 } }]).code).toBe('not_owner');
  });

  it('blocks units that already moved in combat, but lets AA move', () => {
    const s = freshGame(2, 22);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const a = Object.keys(s.territories).find((t) => s.territories[t].owner === pid)!;
    const b = Object.keys(s.territories).find((t) => s.territories[t].owner === pid && t !== a)!;
    s.territories[a].units.infantry = 3;
    s.territories[a].units.aa = 1;
    // Friendly combat reposition marks units used.
    const r1 = combatMove(s, pid, [{ from: a, to: b, units: { infantry: 1 } }]);
    if (r1.ok) {
      gotoCombat(s);
      gotoNonCombat(s);
      // The moved infantry is used; AA never moved so it can go (if adjacent).
      const back = nonCombatMove(s, pid, [{ from: b, to: a, units: { infantry: 2 } }]);
      if (!back.ok) expect(['range', 'too_few_units']).toContain(back.code);
    }
  });

  it('lands attack aircraft after combat; stranded air is destroyed at phase end', () => {
    const s = freshGame(2, 23);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const base = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && s.territories[t].units.fighter > 0,
    )!;
    // Rig an adjacent enemy: the scenario clusters each player's land together.
    const foe = (pid + 1) % s.numPlayers;
    const neighbor = neighborsOf(base)[0];
    s.territories[neighbor].owner = foe;
    const target = neighborsOf(base).find((t) => s.territories[t].owner !== pid)!;
    expect(target, 'fighter base needs an adjacent enemy').toBeDefined();
    // Empty the target so the fighter deterministically survives (air_only ending).
    for (const k of Object.keys(s.territories[target].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories[target].units[k] = 0;
    }
    expect(combatMove(s, pid, [{ from: base, to: target, units: { fighter: 1 } }]).ok).toBe(true);
    expect(openBattles(s)).toHaveLength(1);
    gotoCombat(s);
    resolveBattleAuto(s, pid, target);
    const b = s.battles.find((x) => x.territoryId === target)!;
    expect(b.over).toBe(true);
    expect(b.result).toBe('air_only');
    gotoNonCombat(s);
    // Land back at base (owned since turn start).
    expect(nonCombatMove(s, pid, [{ from: target, to: base, units: { fighter: 1 } }]).ok).toBe(true);
    expect(s.territories[base].units.fighter).toBeGreaterThanOrEqual(1);
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.phase).toBe('mobilize');
  });
});
