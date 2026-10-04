// Single-browser turn driver: runs a full game with human and/or AI (LLM) seats.

import { autoCasualties, endPhase, openBattles, resolveCombatRound } from '../engine/engine';
import type { ActionResult, GameState, Phase } from '../engine/types';
import type { Agent, ToolResultRecord } from './agent';
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
 * After each batch, the driver records every tool call's outcome back into
 * the agent via recordToolResults — provider APIs require each assistant
 * tool_calls entry to have a matching tool response, and the feedback also
 * tells the model what was rejected and why before its next attempt.
 *
 * Note: a retry builds a fresh prompt from the updated state, so the model
 * implicitly sees what happened on top of the explicit tool results.
 */
/**
 * One-line human summary of a successful tool call, recorded into the
 * agent's history alongside the outcome.
 */
function summarizeOk(name: string, args: Record<string, unknown>): string {
  const listLen = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case 'purchase': {
      const items = args.items as Array<{ type: string; count: number }> | undefined;
      if (!items || items.length === 0) return 'purchased nothing';
      return `purchased ${items.map((i) => `${i.count} ${i.type}`).join(', ')}`;
    }
    case 'combat_move': {
      const n = listLen(args.moves);
      return n === 0 ? 'no combat moves' : `ordered ${n} combat move${n === 1 ? '' : 's'}`;
    }
    case 'non_combat_move': {
      const n = listLen(args.moves);
      return n === 0 ? 'no non-combat moves' : `made ${n} non-combat move${n === 1 ? '' : 's'}`;
    }
    case 'mobilize': {
      const placements = args.placements as
        | Array<{ territory: string; units: Record<string, number> }>
        | undefined;
      if (!placements || placements.length === 0) return 'mobilized nothing';
      const parts = placements.map((p) => {
        const units = Object.entries(p.units ?? {})
          .filter(([, n]) => n > 0)
          .map(([t, n]) => `${n} ${t}`)
          .join(', ');
        return `${units || 'nothing'} at ${p.territory}`;
      });
      return `mobilized ${parts.join('; ')}`;
    }
    case 'send_message':
      return `sent message to ${String(args.recipients ?? 'all')}`;
    default:
      return `${name} ok`;
  }
}

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
    const results: ToolResultRecord[] = [];
    let failed: { name: string; result: ActionResult } | null = null;
    let i = 0;
    for (; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (tc.name === 'end_phase') {
        results.push({ toolCallId: tc.id, ok: true, summary: `ok: ending ${phase} phase` });
        i++;
        break;
      }
      const r = dispatchTool(state, pid, tc.name, tc.arguments);
      events.onToolCall?.(pid, tc.name, r.ok, r.ok ? undefined : r.code);
      results.push({
        toolCallId: tc.id,
        ok: r.ok,
        summary: r.ok
          ? `ok: ${summarizeOk(tc.name, tc.arguments)}`
          : `rejected [${r.code}]: ${r.error}`,
      });
      if (!r.ok) {
        failed = { name: tc.name, result: r };
        i++;
        break;
      }
    }
    // Tool calls after the break were never attempted; record them as
    // skipped so the transcript stays valid (every tool_call needs a matching
    // tool response) and the model knows they didn't happen.
    for (; i < toolCalls.length; i++) {
      results.push({
        toolCallId: toolCalls[i].id,
        ok: false,
        summary: failed
          ? `skipped: not attempted after "${failed.name}" was rejected`
          : 'skipped: phase already ending',
      });
    }
    // The driver owns tool results: feed them back into this seat's history
    // so the next act() sends a provider-valid transcript and the model sees
    // what succeeded and why rejections happened.
    agent.recordToolResults(results);
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
