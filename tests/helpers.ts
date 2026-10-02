import { expect } from 'vitest';
import {
  autoCasualties,
  createGame,
  endPhase,
  openBattles,
  resolveCombatRound,
  type CreateGameOptions,
} from '../engine/engine';
import type { GameState, Phase } from '../engine/types';

export function freshGame(numPlayers = 2, seed = 1, opts?: Partial<CreateGameOptions>): GameState {
  return createGame({ numPlayers, seed, ...opts });
}

const ORDER: Phase[] = ['purchase', 'combatMove', 'combat', 'nonCombat', 'mobilize'];

/** Advance the current player's turn until `target` (never crosses into another turn). */
export function gotoPhase(s: GameState, target: Exclude<Phase, 'gameover' | 'purchase'>): void {
  let guard = 6;
  while (s.phase !== target && guard-- > 0) {
    const r = endPhase(s, s.currentPlayer);
    expect(r.ok, `endPhase ${s.phase}: ${r.code} ${r.error}`).toBe(true);
    if (s.phase === 'purchase' || s.phase === 'gameover') {
      throw new Error(`gotoPhase(${target}) crossed into ${s.phase}`);
    }
  }
  expect(s.phase).toBe(target);
}

/** purchase -> combatMove */
export function gotoCombatMove(s: GameState): void {
  expect(s.phase).toBe('purchase');
  gotoPhase(s, 'combatMove');
}

/** purchase/combatMove -> combat */
export function gotoCombat(s: GameState): void {
  expect(['purchase', 'combatMove']).toContain(s.phase);
  gotoPhase(s, 'combat');
}

/** Resolve one battle to completion using auto casualties on both sides. */
export function resolveBattleAuto(s: GameState, pid: number, tid: string, maxRounds = 100): void {
  let guard = maxRounds;
  for (;;) {
    const b = s.battles.find((x) => x.territoryId === tid && !x.over);
    if (!b) return;
    if (guard-- <= 0) throw new Error(`Battle in ${tid} did not finish.`);
    // Clear any pending casualties (including ones left by an earlier manual
    // resolve in the same test) before rolling the next round.
    if (b.pendingAttacker > 0) {
      const r = autoCasualties(s, pid, tid, 'attacker');
      expect(r.ok, `auto-atk ${tid}: ${r.code} ${r.error}`).toBe(true);
      continue;
    }
    if (b.defenderId !== null && b.pendingDefender > 0) {
      const r = autoCasualties(s, pid, tid, 'defender');
      expect(r.ok, `auto-def ${tid}: ${r.code} ${r.error}`).toBe(true);
      continue;
    }
    if (b.pendingDefender > 0) throw new Error(`Neutral casualties stuck in ${tid}.`);
    const r = resolveCombatRound(s, pid, tid);
    expect(r.ok, `resolve ${tid}: ${r.code} ${r.error}`).toBe(true);
  }
}

/** Resolve every open battle to completion. */
export function resolveAllAuto(s: GameState, pid: number): void {
  let guard = 50;
  while (openBattles(s).length > 0 && guard-- > 0) {
    for (const b of openBattles(s)) resolveBattleAuto(s, pid, b.territoryId);
  }
  expect(openBattles(s)).toHaveLength(0);
}

/** Advance out of combat into nonCombat (all battles must be over). */
export function gotoNonCombat(s: GameState): void {
  expect(openBattles(s)).toHaveLength(0);
  expect(['combatMove', 'combat']).toContain(s.phase);
  gotoPhase(s, 'nonCombat');
}

export function gotoMobilize(s: GameState): void {
  expect(openBattles(s)).toHaveLength(0);
  gotoPhase(s, 'mobilize');
}

/** Full no-op turn: no purchases, no moves, no battles. Ends at next player's purchase. */
export function noopTurn(s: GameState): number {
  expect(s.phase).toBe('purchase');
  const pid = s.currentPlayer;
  // purchase->combatMove->combat->nonCombat->mobilize->collect+advance.
  for (let i = 0; i < 5; i++) {
    const r = endPhase(s, pid);
    expect(r.ok, `noop endPhase ${s.phase}: ${r.code} ${r.error}`).toBe(true);
    if (s.phase === 'gameover') break;
  }
  return s.currentPlayer;
}

export function assertValidUnits(s: GameState): void {
  for (const [tid, t] of Object.entries(s.territories)) {
    for (const [type, n] of Object.entries(t.units)) {
      expect(n, `${tid}.${type}`).toBeGreaterThanOrEqual(0);
    }
    if (t.owner !== null) expect(s.players[t.owner]).toBeDefined();
  }
  for (const b of s.battles) {
    for (const [type, n] of Object.entries(b.attack)) {
      expect(n, `battle ${b.territoryId}.${type}`).toBeGreaterThanOrEqual(0);
    }
  }
  expect(s.events[s.events.length - 1].seq).toBe(s.events.length);
}
