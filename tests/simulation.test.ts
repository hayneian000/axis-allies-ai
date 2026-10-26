import { describe, expect, it } from 'vitest';
import { UNITS, airDistance, ipcOf, isSea, neighborsOf, setActiveMap } from '../data/data';
import {
  autoCasualties,
  combatMove,
  countLand,
  countUnits,
  createGame,
  emptyUnits,
  endPhase,
  mobilize,
  nonCombatMove,
  openBattles,
  ownedTerritories,
  ownsCapital,
  purchase,
  resolveCombatRound,
} from '../engine/engine';
import type { CombatMove, GameState, UnitCounts } from '../engine/types';
import { assertValidUnits } from './helpers';

export interface BotStats {
  rounds: number;
  battles: number;
  captures: number;
  sbrs: number;
  stranded: number;
}

/** Deterministic bot RNG (independent of the engine's seeded stream). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function subAvail(have: UnitCounts, used: Partial<UnitCounts>): UnitCounts {
  return {
    infantry: have.infantry - (used.infantry ?? 0),
    artillery: have.artillery - (used.artillery ?? 0),
    tank: have.tank - (used.tank ?? 0),
    fighter: have.fighter - (used.fighter ?? 0),
    bomber: have.bomber - (used.bomber ?? 0),
    aa: have.aa - (used.aa ?? 0),
    transport: have.transport - (used.transport ?? 0),
    submarine: have.submarine - (used.submarine ?? 0),
    destroyer: have.destroyer - (used.destroyer ?? 0),
    cruiser: have.cruiser - (used.cruiser ?? 0),
    carrier: have.carrier - (used.carrier ?? 0),
    battleship: have.battleship - (used.battleship ?? 0),
  };
}

/** Weakest adjacent enemy/neutral target for a land stack, if any. */
function landTarget(s: GameState, pid: number, from: string): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const n of neighborsOf(from)) {
    if (isSea(n)) continue; // phase-1 bot runs no naval operations
    const t = s.territories[n];
    if (t.owner === pid) continue;
    const score = countUnits(t.units) * 10 - ipcOf(n);
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

function botPurchase(s: GameState, pid: number): void {
  if (!ownsCapital(s, pid)) {
    expect(purchase(s, pid, []).ok).toBe(true);
    return;
  }
  const bank = s.players[pid].ipcs;
  if (bank < UNITS.infantry.cost) {
    expect(purchase(s, pid, []).ok).toBe(true);
    return;
  }
  // Mostly infantry, sometimes a tank or fighter if affordable.
  const items: Array<{ type: 'infantry' | 'tank' | 'fighter'; count: number }> = [];
  let left = bank;
  if (left >= UNITS.fighter.cost && s.players[pid].ipcs > 20) {
    items.push({ type: 'fighter', count: 1 });
    left -= UNITS.fighter.cost;
  } else if (left >= UNITS.tank.cost && left % 3 !== 0) {
    items.push({ type: 'tank', count: 1 });
    left -= UNITS.tank.cost;
  }
  const inf = Math.floor(left / UNITS.infantry.cost);
  if (inf > 0) items.push({ type: 'infantry', count: inf });
  expect(purchase(s, pid, items).ok).toBe(true);
}

function botCombatMove(s: GameState, pid: number, rng: () => number, stats: BotStats): void {
  const moves: CombatMove[] = [];
  const committed: Record<string, UnitCounts> = {};
  const availAt = (t: string): UnitCounts => {
    const have = s.territories[t].units;
    return subAvail(have, committed[t] ?? {});
  };
  const landing = s.ownedAtTurnStart.filter((t) => s.territories[t]?.owner === pid);

  for (const from of ownedTerritories(s, pid)) {
    const avail = availAt(from);
    const land = countLand(avail);
    if (land >= 1) {
      const target = landTarget(s, pid, from);
      if (target) {
        // Send everything except a single infantry screen (if we have one to spare).
        const send: Partial<UnitCounts> = {};
        const keepInf = avail.infantry > 1 ? 1 : 0;
        if (avail.infantry - keepInf > 0) send.infantry = avail.infantry - keepInf;
        if (avail.artillery > 0) send.artillery = avail.artillery;
        if (avail.tank > 0 && neighborsOf(from).includes(target)) send.tank = avail.tank;
        if (countLand({ ...emptyUnits(), ...send }) > 0) {
          moves.push({ from, to: target, units: send });
          committed[from] = { ...emptyUnits(), ...send, fighter: 0, bomber: 0, aa: 0 };
        }
      }
    }
    // Air support: fighters/bombers join attacks within half range (guaranteed landing math).
    for (const air of ['fighter', 'bomber'] as const) {
      const n = availAt(from)[air];
      if (n === 0) continue;
      const maxDist = Math.floor(UNITS[air].move / 2);
      const targets = neighborsOf(from)
        .filter((t) => !isSea(t)) // phase-1 bot runs no naval operations
        .filter((t) => s.territories[t].owner !== pid)
        .filter((t) => airDistance(from, t) <= maxDist)
        .filter((t) => landing.some((l) => airDistance(t, l) <= UNITS[air].move - airDistance(from, t)));
      if (targets.length > 0) {
        const to = pick(rng, targets);
        moves.push({ from, to, units: { [air]: n } as Partial<UnitCounts> });
        committed[from] = { ...(committed[from] ?? emptyUnits()), [air]: n } as UnitCounts;
      }
    }
  }
  // Occasional strategic bombing raid.
  if (rng() < 0.25) {
    const bomberBase = ownedTerritories(s, pid).find((t) => availAt(t).bomber > 0);
    const factoryTarget = Object.keys(s.territories).find(
      (t) =>
        s.territories[t].owner !== pid &&
        s.territories[t].factory &&
        bomberBase &&
        airDistance(bomberBase, t) <= UNITS.bomber.move &&
        landing.some((l) => airDistance(t, l) <= UNITS.bomber.move - airDistance(bomberBase, t)),
    );
    if (bomberBase && factoryTarget) {
      moves.push({ from: bomberBase, to: factoryTarget, units: { bomber: 1 }, sbr: true });
      stats.sbrs++;
    }
  }
  const r = combatMove(s, pid, moves);
  expect(r.ok).toBe(true);
}

function botCombat(s: GameState, pid: number): void {
  let guard = 2000;
  while (openBattles(s).length > 0 && guard-- > 0 && s.phase !== 'gameover') {
    const b = openBattles(s)[0];
    if (b.pendingAttacker > 0) {
      expect(autoCasualties(s, pid, b.territoryId, 'attacker').ok).toBe(true);
      continue;
    }
    if (b.defenderId !== null && b.pendingDefender > 0) {
      expect(autoCasualties(s, pid, b.territoryId, 'defender').ok).toBe(true);
      continue;
    }
    const r = resolveCombatRound(s, pid, b.territoryId);
    expect(r.ok, `bot resolve ${b.territoryId}: ${r.code} ${r.error}`).toBe(true);
  }
  // Game may end via majority victory with battles unresolved — that's fine
  if (s.phase !== 'gameover') {
    expect(openBattles(s)).toHaveLength(0);
  }
}

function botNonCombat(s: GameState, pid: number, stats: BotStats): void {
  // Land every aircraft on the nearest legal landing spot.
  const landing = s.ownedAtTurnStart.filter((t) => s.territories[t]?.owner === pid);
  const moves: Array<{ from: string; to: string; units: Partial<UnitCounts> }> = [];
  const nearest = (from: string): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const l of landing) {
      const d = airDistance(from, l);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return best;
  };
  // Air aloft over contested ground.
  for (const b of s.battles) {
    for (const air of ['fighter', 'bomber'] as const) {
      if (b.attack[air] > 0) {
        const dest = nearest(b.territoryId);
        if (dest && airDistance(b.territoryId, dest) <= UNITS[air].move) {
          moves.push({ from: b.territoryId, to: dest, units: { [air]: b.attack[air] } as Partial<UnitCounts> });
        } else {
          stats.stranded += b.attack[air];
        }
      }
    }
  }
  // Air sitting on newly captured (non-landing) ground.
  for (const t of ownedTerritories(s, pid)) {
    if (landing.includes(t)) continue;
    for (const air of ['fighter', 'bomber'] as const) {
      const n = s.territories[t].units[air];
      if (n > 0) {
        const dest = nearest(t);
        if (dest && airDistance(t, dest) <= UNITS[air].move) {
          moves.push({ from: t, to: dest, units: { [air]: n } as Partial<UnitCounts> });
        } else {
          stats.stranded += n;
        }
      }
    }
  }
  // Merge moves with the same from/to.
  const merged = new Map<string, { from: string; to: string; units: Partial<UnitCounts> }>();
  for (const m of moves) {
    const k = `${m.from}>${m.to}`;
    const e = merged.get(k) ?? { from: m.from, to: m.to, units: {} };
    for (const [type, n] of Object.entries(m.units)) {
      (e.units as Record<string, number>)[type] = ((e.units as Record<string, number>)[type] ?? 0) + (n ?? 0);
    }
    merged.set(k, e);
  }
  if (merged.size > 0) {
    expect(nonCombatMove(s, pid, [...merged.values()]).ok).toBe(true);
  }
}

function botMobilize(s: GameState, pid: number): void {
  const pool = { ...(s.purchased as Record<string, number>) };
  const totalUnits =
    (pool.infantry ?? 0) + (pool.artillery ?? 0) + (pool.tank ?? 0) + (pool.fighter ?? 0) + (pool.bomber ?? 0) + (pool.aa ?? 0);
  if (totalUnits === 0) {
    expect(mobilize(s, pid, []).ok).toBe(true);
    return;
  }
  // Fill the capital first, then other turn-start factories.
  const factories = [s.players[pid].capital, ...s.turnStartFactories.filter((t) => t !== s.players[pid].capital)];
  const placements: Array<{ territory: string; units: Partial<UnitCounts> }> = [];
  const remaining = { ...pool };
  for (const f of factories) {
    if (s.territories[f]?.owner !== pid || !s.territories[f]?.factory) continue;
    let cap = ipcOf(f);
    const units: Partial<UnitCounts> = {};
    for (const t of ['infantry', 'tank', 'fighter', 'artillery', 'bomber', 'aa'] as const) {
      if (cap <= 0) break;
      const take = Math.min(remaining[t] ?? 0, cap);
      if (take > 0) {
        units[t] = take;
        remaining[t]! -= take;
        cap -= take;
      }
    }
    if (Object.keys(units).length > 0) placements.push({ territory: f, units });
  }
  const r = mobilize(s, pid, placements);
  expect(r.ok).toBe(true);
}

function botTurn(s: GameState, stats: BotStats, seed: number): void {
  const pid = s.currentPlayer;
  const rng = makeRng(seed + s.round * 7919 + pid * 131);
  expect(s.phase).toBe('purchase');
  const isOver = () => (s.phase as string) === 'gameover';
  botPurchase(s, pid);
  if (isOver()) return;
  expect(endPhase(s, pid).ok).toBe(true); // -> combatMove
  botCombatMove(s, pid, rng, stats);
  if (isOver()) return;
  expect(endPhase(s, pid).ok).toBe(true); // -> combat
  const before = s.battles.filter((b) => b.over && b.result === 'captured').length;
  botCombat(s, pid);
  stats.battles += s.battles.length;
  stats.captures += s.battles.filter((b) => b.over && b.result === 'captured').length - before;
  if (isOver()) return;
  expect(endPhase(s, pid).ok).toBe(true); // -> nonCombat
  botNonCombat(s, pid, stats);
  if (isOver()) return;
  expect(endPhase(s, pid).ok).toBe(true); // -> mobilize
  botMobilize(s, pid);
  if (isOver()) return;
  expect(endPhase(s, pid).ok).toBe(true); // -> income + next
  assertValidUnits(s);
  stats.rounds = s.round;
}

export function playBotGame(seed: number, numPlayers: number, maxRounds = 60): { state: GameState; stats: BotStats } {
  const state = createGame({ numPlayers, seed });
  const stats: BotStats = { rounds: 0, battles: 0, captures: 0, sbrs: 0, stranded: 0 };
  let guard = maxRounds * numPlayers + 10;
  while (state.phase !== 'gameover' && guard-- > 0) {
    botTurn(state, stats, seed);
  }
  return { state, stats };
}

describe('headless simulation on the 1942 board-space map', () => {
  it('plays at least 3 full rounds with all 4 seats (seed 7)', () => {
    setActiveMap('world1942');
    try {
      // maxRounds caps the turn guard; the assertion is on rounds actually
      // completed with every engine call the strict bot makes succeeding.
      const { state, stats } = playBotGame(7, 4, 6);
      expect(state.round).toBeGreaterThanOrEqual(4);
      expect(stats.captures).toBeGreaterThan(0);
      assertValidUnits(state);
      console.log(
        `1942 sim seed=7: rounds=${stats.rounds} battles=${stats.battles} captures=${stats.captures} phase=${state.phase} winner=${state.winner}`,
      );
    } finally {
      setActiveMap('america');
    }
  }, 120000);
});

describe('headless full-game simulation', () => {
  for (const numPlayers of [2, 3, 4]) {
    for (const seed of [1, 2]) {
      it(`plays a ${numPlayers}-player game to an ending (seed ${seed})`, () => {
        const { state, stats } = playBotGame(seed * 100 + numPlayers, numPlayers);
        expect(state.phase).toBe('gameover');
        expect(state.winner).not.toBeNull();
        assertValidUnits(state);
        expect(state.events[state.events.length - 1].seq).toBe(state.events.length);
        console.log(
          `players=${numPlayers} seed=${seed}: rounds=${stats.rounds} battles=${stats.battles} captures=${stats.captures} sbrs=${stats.sbrs} stranded=${stats.stranded} winner=${state.winner} (${state.winReason})`,
        );
        expect(stats.battles).toBeGreaterThan(0);
      });
    }
  }
});
