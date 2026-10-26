// @vitest-environment node
/**
 * SBR factory damage - 1942 2e pp.10, 14, 18, 21, 23.
 *
 * Strategic bombing raids place damage markers on the target industrial
 * complex (one per die point rolled by surviving bombers); they never take
 * IPCs from the victim's bank. Total damage on a complex is capped at
 * twice the IPC value of its territory, excess is lost. Each marker cuts
 * the complex's mobilization capacity by one. The owner removes markers
 * during their Purchase Units phase at 1 IPC each (partial repairs
 * allowed). Markers stay on the complex when the territory is captured.
 */
import { describe, expect, it } from 'vitest';
import { ipcOf, isSea, neighborsOf } from '../data/data';
import {
  autoCasualties,
  combatMove,
  deserialize,
  emptyUnits,
  endPhase,
  incomeOf,
  mobilize,
  openBattles,
  purchase,
  repair,
  resolveCombatRound,
  serialize,
} from '../engine/engine';
import type { CombatRoundResult, GameState } from '../engine/types';
import { freshGame, gotoCombat, gotoCombatMove, gotoMobilize, noopTurn, resolveBattleAuto } from './helpers';

/** Fly one raid from a rigged base next to the foe's capital and resolve
 *  it to completion. Returns the seats, target, and final round result. */
function flyRaid(
  s: GameState,
  opts: { bombers?: number; targetAa?: number; presetDamage?: number } = {},
): { pid: number; foe: number; target: string; last: CombatRoundResult } {
  const pid = s.currentPlayer;
  const foe = (pid + 1) % 2;
  const target = s.players[foe].capital;
  const base = neighborsOf(target).find((n) => !isSea(n))!;
  s.territories[base].owner = pid;
  s.territories[base].units = { ...emptyUnits(), bomber: opts.bombers ?? 1 };
  s.territories[target].units.aa = opts.targetAa ?? 0;
  if (opts.presetDamage !== undefined) s.territories[target].factoryDamage = opts.presetDamage;
  gotoCombatMove(s);
  const mv = combatMove(s, pid, [
    { from: base, to: target, units: { bomber: opts.bombers ?? 1 }, sbr: true },
  ]);
  expect(mv.ok, `raid move: ${mv.code} ${mv.error}`).toBe(true);
  gotoCombat(s);
  let last = resolveCombatRound(s, pid, target);
  expect(last.ok).toBe(true);
  let round = last.combat!;
  let guard = 6;
  while (!round.over && guard-- > 0) {
    if (round.pendingAttacker > 0) {
      expect(autoCasualties(s, pid, target, 'attacker').ok).toBe(true);
    }
    last = resolveCombatRound(s, pid, target);
    expect(last.ok).toBe(true);
    round = last.combat!;
  }
  expect(round.over).toBe(true);
  expect(round.result).toBe('sbr_done');
  return { pid, foe, target, last: round };
}

describe('SBR factory damage (1942 2e p.14)', () => {
  it('createGame starts every factory undamaged', () => {
    const s = freshGame(2, 61);
    for (const t of Object.values(s.territories)) expect(t.factoryDamage).toBe(0);
  });

  it('places damage markers equal to the rolled dice and does NOT touch the victim bank', () => {
    const s = freshGame(2, 71);
    const foe = (s.currentPlayer + 1) % 2;
    const bankBefore = s.players[foe].ipcs;
    const { target, last } = flyRaid(s, { targetAa: 0 });
    const rolled = last.sbrDamage!;
    expect(rolled).toBeGreaterThanOrEqual(1);
    expect(rolled).toBeLessThanOrEqual(6);
    // Capital IPC is 5 or 8 on this map, so the cap (2x IPC) cannot bind.
    expect(s.territories[target].factoryDamage).toBe(rolled);
    expect(s.players[foe].ipcs).toBe(bankBefore);
  });

  it('enforces the damage cap: total damage never exceeds twice the territory IPC value', () => {
    const s = freshGame(2, 72);
    const target = s.players[(s.currentPlayer + 1) % 2].capital;
    const cap = 2 * ipcOf(target);
    // Two bombers roll at least 2 total; preset damage leaves room for 1.
    const { last } = flyRaid(s, { bombers: 2, targetAa: 0, presetDamage: cap - 1 });
    expect(last.sbrDamage!).toBeGreaterThanOrEqual(2);
    expect(s.territories[target].factoryDamage).toBe(cap);
  });

  it('AA fires first: a bomber shot down by AA deals no damage', () => {
    // Seed 7: the target's single AA gun rolls a 1 against the lone bomber.
    const s = freshGame(2, 7);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const target = s.players[foe].capital;
    const base = neighborsOf(target).find((n) => !isSea(n))!;
    s.territories[base].owner = pid;
    s.territories[base].units = { ...emptyUnits(), bomber: 1 };
    s.territories[target].units.aa = 1;
    const bankBefore = s.players[foe].ipcs;
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: base, to: target, units: { bomber: 1 }, sbr: true }]).ok,
    ).toBe(true);
    gotoCombat(s);
    const first = resolveCombatRound(s, pid, target);
    expect(first.ok).toBe(true);
    // The AA shot resolves before any bombing: it hit the only bomber.
    expect(first.combat!.aaHits).toBe(1);
    expect(first.combat!.pendingAttacker).toBe(1);
    expect(autoCasualties(s, pid, target, 'attacker').ok).toBe(true);
    // With the only raider dead, the raid is over before any strike:
    // the battle closes and no damage is dealt.
    const battle = s.battles.find((x) => x.territoryId === target)!;
    expect(battle.over).toBe(true);
    expect(openBattles(s)).toHaveLength(0);
    expect(s.territories[target].factoryDamage).toBe(0);
    expect(s.players[foe].ipcs).toBe(bankBefore);
  });

  it('damage persists across turns until repaired', () => {
    const s = freshGame(2, 73);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    s.territories[cap].factoryDamage = 3;
    noopTurn(s); // pid's turn ends
    noopTurn(s); // foe's turn ends; back to pid
    expect(s.currentPlayer).toBe(pid);
    expect(s.territories[cap].factoryDamage).toBe(3);
  });
});

describe('damaged factory mobilization (1942 2e p.21)', () => {
  /** Buy `buy` infantry, rig damage on the capital factory, advance to mobilize. */
  function atMobilize(seed: number, damage: (ipc: number) => number, buy: number) {
    const s = freshGame(2, seed);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const ipc = ipcOf(cap);
    s.players[pid].ipcs = 90;
    expect(purchase(s, pid, [{ type: 'infantry', count: buy }]).ok).toBe(true);
    s.territories[cap].factoryDamage = damage(ipc);
    gotoMobilize(s);
    return { s, pid, cap, ipc };
  }

  it('mobilizes up to effective capacity (IPC minus damage)', () => {
    // Damage leaves exactly 1 capacity; a 1-infantry placement fits.
    const { s, pid, cap } = atMobilize(82, (ipc) => ipc - 1, 3);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
  });

  it('rejects an over-capacity single placement on a damaged factory', () => {
    const { s, pid, cap } = atMobilize(83, (ipc) => ipc - 1, 3);
    const r = mobilize(s, pid, [{ territory: cap, units: { infantry: 2 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('factory_damaged');
  });

  it('a fully damaged factory (capacity 0) rejects every placement with the damage error', () => {
    const { s, pid, cap } = atMobilize(84, (ipc) => ipc, 2);
    const r = mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('factory_damaged');
    expect(r.error).toMatch(/damage/);
  });

  it('an undamaged factory keeps its full IPC capacity (control)', () => {
    const { s, pid, cap, ipc } = atMobilize(85, () => 0, 8);
    const r = mobilize(s, pid, [{ territory: cap, units: { infantry: ipc } }]);
    expect(r.ok).toBe(true);
  });
});

describe('factory repair (1942 2e p.10)', () => {
  it('pays 1 IPC per marker, supports partial repair, and restores capacity', () => {
    const s = freshGame(2, 91);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    s.territories[cap].factoryDamage = 4;
    s.players[pid].ipcs = 10;
    const r = repair(s, pid, cap, 3);
    expect(r.ok).toBe(true);
    expect(s.territories[cap].factoryDamage).toBe(1);
    expect(s.players[pid].ipcs).toBe(7);
    expect(s.events.some((e) => e.kind === 'repair' && e.detail.includes(cap))).toBe(true);
    // Finish the job, then production capacity is whole again next mobilize.
    expect(repair(s, pid, cap, 1).ok).toBe(true);
    expect(s.territories[cap].factoryDamage).toBe(0);
    expect(s.players[pid].ipcs).toBe(6);
  });

  it('rejects invalid repairs without changing state', () => {
    const s = freshGame(2, 92);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const cap = s.players[pid].capital;
    const foeCap = s.players[foe].capital;
    s.territories[cap].factoryDamage = 3;
    s.territories[foeCap].factoryDamage = 2;
    s.players[pid].ipcs = 2;

    // Not your factory.
    expect(repair(s, pid, foeCap, 1).code).toBe('not_owner');
    // No factory on an owned territory.
    const plain = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory,
    )!;
    expect(repair(s, pid, plain, 1).code).toBe('no_factory');
    // Non-positive and fractional counts.
    expect(repair(s, pid, cap, 0).code).toBe('bad_count');
    expect(repair(s, pid, cap, 1.5).code).toBe('bad_count');
    // More points than damage present.
    expect(repair(s, pid, cap, 4).code).toBe('over_repair');
    // Bank cannot cover the markers.
    expect(repair(s, pid, cap, 3).code).toBe('funds');
    // Nothing changed.
    expect(s.territories[cap].factoryDamage).toBe(3);
    expect(s.players[pid].ipcs).toBe(2);
  });

  it('is a Purchase-phase action only', () => {
    const s = freshGame(2, 93);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    s.territories[cap].factoryDamage = 2;
    s.players[pid].ipcs = 10;
    gotoCombatMove(s);
    const r = repair(s, pid, cap, 1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('wrong_phase');
    expect(s.territories[cap].factoryDamage).toBe(2);
  });

  it('a captured factory keeps its damage; the new owner repairs it on a later turn (p.18)', () => {
    const s = freshGame(2, 94);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    void foe;
    // Rig: texas (IPC 5) is a foe factory carrying 3 damage; oklahoma is
    // pid ground with infantry in reach.
    s.territories['texas'].owner = foe;
    s.territories['texas'].factory = true;
    s.territories['texas'].factoryDamage = 3;
    s.territories['texas'].units = emptyUnits();
    s.territories['oklahoma'].owner = pid;
    s.territories['oklahoma'].units = { ...emptyUnits(), infantry: 3 };
    s.players[pid].ipcs = 20;
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).ok).toBe(true);
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'oklahoma', to: 'texas', units: { infantry: 2 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'texas');
    expect(s.territories['texas'].owner).toBe(pid);
    // Damage markers stay on the complex through the capture (p.18).
    expect(s.territories['texas'].factoryDamage).toBe(3);
    expect(s.territories['texas'].factoryFresh).toBe(true);
    gotoMobilize(s);
    // Fresh (captured this turn): cannot produce yet, existing behavior.
    const blocked = mobilize(s, pid, [{ territory: 'texas', units: { infantry: 1 } }]);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('no_factory');
    // Finish pid's turn, play the foe's turn, then pid repairs as owner.
    expect(endPhase(s, pid).ok).toBe(true);
    noopTurn(s);
    expect(s.currentPlayer).toBe(pid);
    expect(s.phase).toBe('purchase');
    expect(s.territories['texas'].factoryFresh).toBe(false);
    const bankBefore = s.players[pid].ipcs;
    const r = repair(s, pid, 'texas', 2);
    expect(r.ok).toBe(true);
    expect(s.territories['texas'].factoryDamage).toBe(1);
    expect(s.players[pid].ipcs).toBe(bankBefore - 2);
  });
});

describe('income and persistence', () => {
  it('damage does not reduce territory income', () => {
    const s = freshGame(2, 95);
    for (const p of s.players) {
      const before = incomeOf(s, p.id);
      s.territories[p.capital].factoryDamage = 4;
      expect(incomeOf(s, p.id)).toBe(before);
    }
  });

  it('damage survives a save/load round trip; legacy saves load damage as 0', () => {
    const s = freshGame(2, 96);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    s.territories[cap].factoryDamage = 5;
    const loaded = deserialize(serialize(s));
    expect(loaded.territories[cap].factoryDamage).toBe(5);

    const legacy = JSON.parse(serialize(s)) as GameState;
    for (const t of Object.values(legacy.territories)) {
      delete (t as { factoryDamage?: number }).factoryDamage;
    }
    const loadedLegacy = deserialize(JSON.stringify(legacy));
    for (const t of Object.values(loadedLegacy.territories)) {
      expect(t.factoryDamage).toBe(0);
    }
  });
});
