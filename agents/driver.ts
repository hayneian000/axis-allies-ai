// Single-browser turn driver: runs a full game with human and/or AI (LLM) seats.

import { autoCasualties, endPhase, openBattles, resolveCombatRound } from '../engine/engine';
import type { ActionResult, GameState, Phase } from '../engine/types';
import type { Agent } from './agent';
import { dispatchTool } from './tools';
import type { PlayerUsage, SeatConfig } from './types';

export interface DriverEvents {
  onHumanTurn?: (state: GameState, playerId: number, phase: Phase) => Promise<void>;
  onPhase?: (state: GameState, playerId: number, phase: Phase) => void;
  onToolCall?: (playerId: number, name: string, ok: boolean, code?: string) => void;
}

export interface SeatRuntime {
  seat: SeatConfig;
  /** Required when seat.kind === 'ai'. PlayerId pairing is established at construction. */
  agent?: Agent;
}

export interface GameResult {
  state: GameState;
  usage: Record<number, PlayerUsage>;
  rounds: number;
}

export class MaxRoundsExceeded extends Error {
  constructor(rounds: number, maxRounds: number) {
    super(`Game did not finish within ${maxRounds} rounds (reached round ${rounds}).`);
    this.name = 'MaxRoundsExceeded';
  }
}

const DEFAULT_MAX_RETRIES = 3;
const MAX_BATTLE_ROUNDS = 100;

interface ErrorCounter {
  count: number;
}

/**
 * Run one AI phase: ask the agent for tool calls, apply them in order via
 * dispatchTool, and retry the whole act() on the first invalid call (up to
 * maxRetries). An `end_phase` tool call means "I'm done" — it is consumed, not
 * dispatched, and the driver performs the single engine endPhase afterwards.
 * If every attempt fails, the fallback action runs instead.
 *
 * Note: a retry builds a fresh prompt from the updated state, so the model
 * implicitly sees what happened; feeding the error text back into the prompt
 * is a v2 improvement.
 */
async function agentPhaseWithRetry(
  state: GameState,
  agent: Agent,
  pid: number,
  phase: Phase,
  events: DriverEvents,
  maxRetries: number,
  fallback: () => ActionResult,
  errors: ErrorCounter,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { toolCalls } = await agent.act(state, phase);
    let failed: { name: string; result: ActionResult } | null = null;
    for (const tc of toolCalls) {
      if (tc.name === 'end_phase') break;
      const r = dispatchTool(state, pid, tc.name, tc.arguments);
      events.onToolCall?.(pid, tc.name, r.ok, r.ok ? undefined : r.code);
      if (!r.ok) {
        failed = { name: tc.name, result: r };
        break;
      }
    }
    if (!failed) return;
    errors.count++;
  }
  const fr = fallback();
  if (!fr.ok) {
    throw new Error(
      `Fallback action failed for player ${pid} in phase ${phase}: [${fr.code}] ${fr.error}`,
    );
  }
}

/**
 * Resolve every open battle without agent input (MVP): roll rounds, apply the
 * engine's auto-casualty policy to both sides, repeat until the battle ends.
 * Neutral garrisons are auto-resolved by the engine inside resolveCombatRound.
 */
function autoResolveCombat(state: GameState, pid: number): void {
  for (const b0 of openBattles(state)) {
    for (let round = 0; round < MAX_BATTLE_ROUNDS; round++) {
      const b = state.battles.find((x) => x.id === b0.id && !x.over);
      if (!b) break;
      const r = resolveCombatRound(state, pid, b.territoryId);
      if (!r.ok) {
        throw new Error(
          `Auto-resolve: resolveCombatRound failed in ${b.territoryId}: [${r.code}] ${r.error}`,
        );
      }
      const after = state.battles.find((x) => x.id === b0.id);
      if (!after || after.over) break;
      if (after.pendingAttacker > 0) {
        const c = autoCasualties(state, pid, after.territoryId, 'attacker');
        if (!c.ok) {
          throw new Error(
            `Auto-resolve: attacker casualties failed in ${after.territoryId}: [${c.code}] ${c.error}`,
          );
        }
      }
      const after2 = state.battles.find((x) => x.id === b0.id);
      if (!after2 || after2.over) break;
      if (after2.defenderId !== null && after2.pendingDefender > 0) {
        const c = autoCasualties(state, pid, after2.territoryId, 'defender');
        if (!c.ok) {
          throw new Error(
            `Auto-resolve: defender casualties failed in ${after2.territoryId}: [${c.code}] ${c.error}`,
          );
        }
      }
    }
    const still = state.battles.find((x) => x.id === b0.id && !x.over);
    if (still) {
      throw new Error(
        `Auto-resolve: battle in ${still.territoryId} did not finish within ${MAX_BATTLE_ROUNDS} rounds.`,
      );
    }
  }
}

async function runAiPhase(
  state: GameState,
  seat: SeatRuntime,
  events: DriverEvents,
  errors: ErrorCounter,
): Promise<void> {
  const agent = seat.agent;
  if (!agent) throw new Error(`AI seat ${seat.seat.seatIndex} has no agent.`);
  const pid = seat.seat.playerId;
  switch (state.phase) {
    case 'purchase':
      await agentPhaseWithRetry(
        state, agent, pid, 'purchase', events, DEFAULT_MAX_RETRIES,
        () => dispatchTool(state, pid, 'purchase', { items: [] }),
        errors,
      );
      break;
    case 'combatMove':
      await agentPhaseWithRetry(
        state, agent, pid, 'combatMove', events, DEFAULT_MAX_RETRIES,
        () => dispatchTool(state, pid, 'combat_move', { moves: [] }),
        errors,
      );
      break;
    case 'combat':
      autoResolveCombat(state, pid);
      break;
    case 'nonCombat':
      await agentPhaseWithRetry(
        state, agent, pid, 'nonCombat', events, DEFAULT_MAX_RETRIES,
        () => dispatchTool(state, pid, 'non_combat_move', { moves: [] }),
        errors,
      );
      break;
    case 'mobilize':
      await agentPhaseWithRetry(
        state, agent, pid, 'mobilize', events, DEFAULT_MAX_RETRIES,
        () => dispatchTool(state, pid, 'mobilize', { placements: [] }),
        errors,
      );
      break;
    case 'gameover':
      return;
  }
  const end = endPhase(state, pid);
  if (!end.ok) {
    throw new Error(`endPhase failed for player ${pid} in ${state.phase}: [${end.code}] ${end.error}`);
  }
}

export async function runGame(
  state: GameState,
  seats: SeatRuntime[],
  events: DriverEvents = {},
  opts: { maxRounds?: number } = {},
): Promise<GameResult> {
  if (seats.length !== state.numPlayers) {
    throw new Error(
      `Driver needs one seat per player: got ${seats.length} seats for ${state.numPlayers} players.`,
    );
  }
  for (const s of seats) {
    if (s.seat.kind === 'ai' && !s.agent) {
      throw new Error(`AI seat ${s.seat.seatIndex} (player ${s.seat.playerId}) has no agent.`);
    }
    if (s.seat.kind === 'human' && !events.onHumanTurn) {
      throw new Error('Human seats require events.onHumanTurn.');
    }
  }
  // The Agent keeps its playerId private, so the driver cannot introspect the
  // pairing; it is established by whoever constructed the SeatRuntime
  // (AgentOptions.playerId === seat.playerId). A mismatch fails loudly via
  // engine validation, then falls back.
  const maxRounds = opts.maxRounds ?? Math.max(state.turnCap + 5, 60);
  const errorsByPlayer = new Map<number, number>();

  while (state.phase !== 'gameover') {
    if (state.round > maxRounds) throw new MaxRoundsExceeded(state.round, maxRounds);
    const pid = state.currentPlayer;
    const seat = seats[pid];
    if (!seat) throw new Error(`No seat configured for current player ${pid}.`);
    events.onPhase?.(state, pid, state.phase);
    if (seat.seat.kind === 'human') {
      await events.onHumanTurn!(state, pid, state.phase);
    } else {
      const errors: ErrorCounter = { count: 0 };
      await runAiPhase(state, seat, events, errors);
      errorsByPlayer.set(pid, (errorsByPlayer.get(pid) ?? 0) + errors.count);
    }
  }

  const usage: Record<number, PlayerUsage> = {};
  for (const s of seats) {
    if (s.agent) {
      const u = s.agent.usage;
      // Agent.usage is a snapshot copy; the driver owns engine-validation
      // error accounting (errors = tool calls rejected by validation).
      usage[s.seat.playerId] = { ...u, errors: u.errors + (errorsByPlayer.get(s.seat.playerId) ?? 0) };
    }
  }
  return { state, usage, rounds: state.round };
}
