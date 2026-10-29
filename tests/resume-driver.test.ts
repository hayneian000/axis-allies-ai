// Driver resume safety: runGame with opts.resume from a state saved
// mid-turn must finish that turn (never re-run or re-end passed phases),
// hand a mid-turn human seat to onHumanTurn, and skip the current round's
// diplomacy window exactly once.

import { describe, expect, it } from 'vitest';
import { isSea, neighborsOf, setActiveMap } from '../data/data';
import { combatMove, createGame, endPhase, openBattles } from '../engine/engine';
import type { GameState } from '../engine/types';
import { Agent } from '../agents/agent';
import { runGame, type SeatRuntime } from '../agents/driver';
import type { SeatConfig } from '../agents/types';
import { MockProvider, passBotHandler } from './agents/mock';

const SENTINEL = 'HUMAN_TURN_REACHED';

function aiSeat(pid: number): SeatRuntime {
  const seat: SeatConfig = {
    seatIndex: pid,
    playerId: pid,
    kind: 'ai',
    provider: 'anthropic',
    model: 'mock-model',
    keySlot: 'anthropic',
  };
  return {
    seat,
    agent: new Agent({
      playerId: pid,
      provider: new MockProvider(passBotHandler),
      model: 'mock-model',
      getApiKey: () => 'mock-key',
    }),
  };
}

function humanSeat(pid: number): SeatRuntime {
  return { seat: { seatIndex: pid, playerId: pid, kind: 'human' } };
}

/** Seats for a resumed game: the current player is AI, everyone else human. */
function seatsFor(state: GameState): SeatRuntime[] {
  return state.players.map((p) => (p.id === state.currentPlayer ? aiSeat(p.id) : humanSeat(p.id)));
}

function freshState(): GameState {
  setActiveMap('america');
  return createGame({ numPlayers: 2, seed: 7 });
}

function ok(r: { ok: boolean; error?: string }): void {
  expect(r.ok, r.error).toBe(true);
}

/** Advance the current player's turn to the combatMove phase. */
function toCombatMove(state: GameState): void {
  ok(endPhase(state, state.currentPlayer));
  expect(state.phase).toBe('combatMove');
}

/** Weakest adjacent enemy land territory, with all land units - the same
 *  shape the greedy test bot attacks with. */
function findAttack(state: GameState, pid: number): { from: string; to: string; units: { infantry: number; artillery: number; tank: number } } | null {
  for (const [from, t] of Object.entries(state.territories)) {
    if (t.owner !== pid) continue;
    if (t.units.infantry + t.units.artillery + t.units.tank === 0) continue;
    for (const to of neighborsOf(from)) {
      if (isSea(to)) continue;
      const dt = state.territories[to];
      if (!dt || dt.owner === pid) continue;
      return {
        from,
        to,
        units: { infantry: t.units.infantry, artillery: t.units.artillery, tank: t.units.tank },
      };
    }
  }
  return null;
}

/** Advance to the combat phase with one open battle. */
function toCombat(state: GameState): void {
  toCombatMove(state);
  const pid = state.currentPlayer;
  const attack = findAttack(state, pid);
  expect(attack, 'seed 7 2p game has an attack for the first player').not.toBeNull();
  ok(combatMove(state, pid, [attack!]));
  expect(openBattles(state).length).toBeGreaterThan(0);
  ok(endPhase(state, pid));
  expect(state.phase).toBe('combat');
  expect(openBattles(state).length).toBeGreaterThan(0);
}

/** Advance to the nonCombat phase (no battles fought). */
function toNonCombat(state: GameState): void {
  toCombatMove(state);
  const pid = state.currentPlayer;
  ok(combatMove(state, pid, []));
  ok(endPhase(state, pid));
  expect(state.phase).toBe('combat');
  ok(endPhase(state, pid));
  expect(state.phase).toBe('nonCombat');
}

/** Advance to the mobilize phase. */
function toMobilize(state: GameState): void {
  toNonCombat(state);
  ok(endPhase(state, state.currentPlayer));
  expect(state.phase).toBe('mobilize');
}

/**
 * A resumed AI turn ends with the next (human) seat's turn: the human
 * handler throws a sentinel, which proves the AI turn completed and
 * control passed on. Rejects with the sentinel, not a driver error.
 */
async function expectTurnCompletes(state: GameState): Promise<void> {
  const pid = state.currentPlayer;
  await expect(
    runGame(state, seatsFor(state), {
      onHumanTurn: () => {
        throw new Error(SENTINEL);
      },
    }, { resume: true, diplomacy: { enabled: false } }),
  ).rejects.toThrow(SENTINEL);
  expect(state.currentPlayer).not.toBe(pid);
  expect(state.phase).toBe('purchase');
}

describe('driver resume from each phase', () => {
  it('resumes a purchase-phase turn as a full turn', async () => {
    const state = freshState();
    expect(state.phase).toBe('purchase');
    await expectTurnCompletes(state);
  });

  it('resumes a combatMove-phase turn without re-ending purchase', async () => {
    const state = freshState();
    toCombatMove(state);
    await expectTurnCompletes(state);
  });

  it('resumes a combat-phase turn by auto-resolving the open battle', async () => {
    const state = freshState();
    toCombat(state);
    await expectTurnCompletes(state);
    expect(state.battles.every((b) => b.over)).toBe(true);
  });

  it('resumes a nonCombat-phase turn through consolidate only', async () => {
    const state = freshState();
    toNonCombat(state);
    await expectTurnCompletes(state);
  });

  it('resumes a mobilize-phase turn through mobilize only', async () => {
    const state = freshState();
    toMobilize(state);
    await expectTurnCompletes(state);
  });
});

describe('driver resume: human seats and diplomacy', () => {
  it('hands a mid-turn human seat to onHumanTurn with the saved phase', async () => {
    const state = freshState();
    toNonCombat(state);
    const pid = state.currentPlayer;
    state.turnCap = 1;
    const seen: string[] = [];
    const seats: SeatRuntime[] = state.players.map((p) =>
      p.id === pid ? humanSeat(p.id) : aiSeat(p.id),
    );
    const result = await runGame(
      state,
      seats,
      {
        onHumanTurn: (s, humanPid, phase) => {
          seen.push(phase);
          // Play the rest of this human turn with plain endPhase calls
          // (no battles are open), then control returns to the driver.
          while (s.currentPlayer === humanPid && s.phase !== 'gameover') {
            ok(endPhase(s, humanPid));
          }
          return Promise.resolve();
        },
      },
      { resume: true, diplomacy: { enabled: false } },
    );
    expect(seen[0]).toBe('nonCombat');
    expect(result.state.phase).toBe('gameover');
  });

  it('does not re-run the current round diplomacy window on resume', async () => {
    const openedResume: number[] = [];
    const openedFresh: number[] = [];
    const mkSeats = (): SeatRuntime[] => [aiSeat(0), aiSeat(1)];
    const mkState = (): GameState => {
      const s = freshState();
      s.round = 2;
      s.turnCap = 3;
      return s;
    };
    await runGame(
      mkState(),
      mkSeats(),
      { onDiplomacyWindow: (_s, round, open) => {
        if (open) openedResume.push(round);
      } },
      { resume: true },
    );
    await runGame(
      mkState(),
      mkSeats(),
      { onDiplomacyWindow: (_s, round, open) => {
        if (open) openedFresh.push(round);
      } },
    );
    expect(openedResume).toEqual([3]);
    expect(openedFresh).toEqual([2, 3]);
  });
});
