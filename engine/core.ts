/**
 * engine/core.ts — Cross-cutting engine primitives: RNG, dice, results, logging, validation, state readers.
 */
import { ipcOf, isSea, victoryCityIds } from '../data/data';
import type { ActionResult, Battle, GameState, Phase } from './types';


export const PLAYER_COLORS = ['#6b7a3f', '#3e5a78', '#7e3b3b', '#b49b62'];

export const MAX_CHAT_LENGTH = 500;

export const DEFAULT_TURN_CAP = 20;


export function fail(code: string, error: string): ActionResult {
  return { ok: false, code, error };
}


// ------------------------------------------------------------------ RNG ---

/** Mulberry32 step. Mutates state.rngState so the stream is serializable. */
export function rand(state: GameState): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}


export function rollDie(state: GameState): number {
  return 1 + Math.floor(rand(state) * 6);
}


export function shuffle<T>(state: GameState, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


// ------------------------------------------------------------------ combat ---

export function rollHits(state: GameState, count: number, value: number): { dice: number[]; hits: number } {
  const dice: number[] = [];
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const d = rollDie(state);
    dice.push(d);
    if (d <= value) hits++;
  }
  return { dice, hits };
}


export function log(state: GameState, kind: string, detail: string): void {
  logEvent(state, kind, detail);
}


// ---------------------------------------------------------------- helpers ---

export function logEvent(
  state: GameState,
  kind: string,
  detail: string,
  rolls?: { side: string; dice: number[]; hits: number },
): void {
  state.events.push({
    seq: state.events.length + 1,
    round: state.round,
    player: state.currentPlayer,
    kind,
    detail,
    ...(rolls ? { rolls } : {}),
  });
}


/** `used` key: sea zones track per occupying owner, since several players'
 *  forces can share one zone. Land keeps the plain territory id. */
export function usedKey(terrId: string, owner: number): string {
  return isSea(terrId) ? `${terrId}~${owner}` : terrId;
}


export function requirePhase(state: GameState, phases: Phase[]): ActionResult | null {
  if (!phases.includes(state.phase)) {
    return fail('wrong_phase', `Action not allowed in phase "${state.phase}".`);
  }
  return null;
}


export function requireCurrentAlive(state: GameState, playerId: number): ActionResult | null {
  if (playerId !== state.currentPlayer) {
    return fail('not_your_turn', `It is ${state.players[state.currentPlayer].name}'s turn.`);
  }
  if (!state.players[playerId].alive) return fail('eliminated', 'You are eliminated.');
  return null;
}


export function ownedTerritories(state: GameState, playerId: number): string[] {
  return Object.keys(state.territories).filter((t) => state.territories[t].owner === playerId);
}


export function incomeOf(state: GameState, playerId: number): number {
  return ownedTerritories(state, playerId).reduce((sum, t) => sum + ipcOf(t), 0);
}


/** All capitals belonging to a seat (multi-capital seats: 1942 seat 3
 *  holds both London and Washington). Falls back to the primary capital
 *  for saves created before the `capitals` field existed. */
export function capitalsOf(state: GameState, playerId: number): string[] {
  const p = state.players[playerId];
  return p.capitals ?? [p.capital];
}


/** True while the seat holds at least one of its capitals. A seat is
 *  capital-blocked (no purchase, no income) only when it holds none. */
export function ownsCapital(state: GameState, playerId: number): boolean {
  return capitalsOf(state, playerId).some((c) => state.territories[c]?.owner === playerId);
}


/** Victory cities the seat currently holds (territories flagged
 *  victoryCity on the active map whose owner is this seat). */
export function victoryCitiesHeld(state: GameState, playerId: number): number {
  return victoryCityIds().filter((t) => state.territories[t]?.owner === playerId).length;
}


export function openBattles(state: GameState): Battle[] {
  return state.battles.filter((b) => !b.over);
}
