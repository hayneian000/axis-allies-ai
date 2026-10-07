// Single-browser turn driver: runs a full game with human and/or AI (LLM) seats.

import { autoCasualties, endPhase, openBattles, resolveCombatRound } from '../engine/engine';
import type { ActionResult, GameState, Phase } from '../engine/types';
import type { Agent, ToolResultRecord } from './agent';
import { phaseHasActions } from './affordance';
import {
  DiplomacyLedger,
  runDiplomacyWindow,
  type DiplomacyEvents,
  type RunDiplomacyOpts,
} from './diplomacy';
import { dispatchTool, PHASE_GROUP_ORDER, phaseForTool, type PhaseGroup } from './tools';
import type { PlayerUsage, SeatConfig, ToolCall } from './types';

export interface DriverEvents {
  onHumanTurn?: (state: GameState, playerId: number, phase: Phase) => Promise<void>;
  onPhase?: (state: GameState, playerId: number, phase: Phase) => void;
  onToolCall?: (playerId: number, name: string, ok: boolean, code?: string) => void;
  /**
   * An AI phase was skipped with no LLM call: the affordance check found
   * provably no legal actions (e.g. nothing affordable to buy, nothing
   * purchased to mobilize). The phase was ended directly.
   */
  onPhaseSkipped?: (state: GameState, playerId: number, phase: Phase, reason: string) => void;
  /** Human seat's turn in the diplomacy window; resolves when done talking. */
  onHumanDiplomacy?: (state: GameState, playerId: number) => Promise<void>;
  /** A diplomacy message was accepted into chatLog. */
  onDiplomacyMessage?: DiplomacyEvents['onDiplomacyMessage'];
  /** Diplomacy window opened/closed for a round. */
  onDiplomacyWindow?: DiplomacyEvents['onDiplomacyWindow'];
  /** Engine validation outcome for an AI seat's send_message. */
  onDiplomacyToolCall?: DiplomacyEvents['onDiplomacyToolCall'];
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
  /** Everything said during diplomacy, plus spend accounting. */
  diplomacy: DiplomacyLedger;
}

export interface DiplomacyOptions extends RunDiplomacyOpts {
  /**
   * Run the diplomacy window each round. Default true. The window is
   * skipped automatically when no seat is AI-driven.
   */
  enabled?: boolean;
  /** Bring your own ledger (the UI keeps one for live budget meters). */
  ledger?: DiplomacyLedger;
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
 * Run one batched phase group for an AI seat: a single actGroup() plans
 * every live phase, the driver partitions the returned tool calls by tool
 * name, and applies them in canonical phase order with an endPhase between
 * phases. Phases with no legal actions are skipped with no LLM call.
 *
 * Retry semantics (scoped, with error feedback): tool calls apply in order
 * and the valid prefix STAYS applied — the driver never re-applies it. On
 * the first rejection in a phase, the failed phase and the not-yet-executed
 * later phases are re-planned in one fresh actGroup() (the model sees the
 * applied prefix plus the `rejected [code]: reason` tool result in its
 * history). Retries are bounded per phase; on exhaustion the phase's
 * no-op fallback runs and later phases keep their validated plans
 * (fallbacks are no-ops, so those plans still apply cleanly).
 *
 * Transcript validity: every tool_call id gets exactly one tool result.
 * Applied buckets are recorded as they execute; superseded buckets (from a
 * re-planned group) are recorded as skipped before the re-plan.
 */
type TurnPhase = 'purchase' | 'combatMove' | 'nonCombat' | 'mobilize';

/** No-op fallbacks per phase (safe defaults when no valid plan emerges). */
const PHASE_FALLBACKS: Record<TurnPhase, (state: GameState, pid: number) => ActionResult> = {
  purchase: (s, p) => dispatchTool(s, p, 'purchase', { items: [] }),
  combatMove: (s, p) => dispatchTool(s, p, 'combat_move', { moves: [] }),
  nonCombat: (s, p) => dispatchTool(s, p, 'non_combat_move', { moves: [] }),
  mobilize: (s, p) => dispatchTool(s, p, 'mobilize', { placements: [] }),
};

type Partition = { ok: true; buckets: Map<TurnPhase, ToolCall[]> } | { ok: false; badCall: ToolCall };

/**
 * Sort a batched response into per-phase buckets. `end_phase` is consumed
 * (phases advance automatically). A tool that isn't live in this group —
 * unknown or belonging to another phase — fails the whole partition so the
 * group is re-planned with feedback.
 */
function partitionGroupCalls(toolCalls: ToolCall[], live: TurnPhase[]): Partition {
  const buckets = new Map<TurnPhase, ToolCall[]>(live.map((p) => [p, []]));
  for (const tc of toolCalls) {
    if (tc.name === 'end_phase') continue;
    const phase = phaseForTool(tc.name) as TurnPhase | null;
    const bucket = phase ? buckets.get(phase) : undefined;
    if (!bucket) return { ok: false, badCall: tc };
  }
  for (const tc of toolCalls) {
    if (tc.name === 'end_phase') continue;
    buckets.get(phaseForTool(tc.name) as TurnPhase)!.push(tc);
  }
  return { ok: true, buckets };
}

/** Record "skipped" tool results for buckets that will never execute. */
function recordSkipped(
  agent: Agent,
  buckets: Map<TurnPhase, ToolCall[]>,
  phases: TurnPhase[],
  summary: string,
): void {
  const calls = phases.flatMap((p) => buckets.get(p) ?? []);
  if (calls.length === 0) return;
  agent.recordToolResults(calls.map((tc) => ({ toolCallId: tc.id, ok: false, summary })));
}

/**
 * Get a validated partition for the given live phases: one actGroup() call,
 * retrying the whole group (with rejection feedback) when the model emits a
 * tool that isn't live. On exhaustion, empty buckets — the caller then runs
 * per-phase fallbacks.
 */
async function planGroup(
  state: GameState,
  agent: Agent,
  pid: number,
  group: PhaseGroup,
  live: TurnPhase[],
  maxRetries: number,
  errors: ErrorCounter,
): Promise<Map<TurnPhase, ToolCall[]>> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { toolCalls } = await agent.actGroup(state, group, live);
    const part = partitionGroupCalls(toolCalls, live);
    if (part.ok) {
      const consumed = toolCalls.filter((tc) => tc.name === 'end_phase');
      if (consumed.length > 0) {
        agent.recordToolResults(
          consumed.map((tc) => ({
            toolCallId: tc.id,
            ok: true,
            summary: 'ok: end_phase consumed by the driver (phases advance automatically)',
          })),
        );
      }
      return part.buckets;
    }
    errors.count++;
    agent.recordToolResults(
      toolCalls.map((tc) => ({
        toolCallId: tc.id,
        ok: false,
        summary:
          tc.id === part.badCall.id
            ? `rejected: tool "${tc.name}" is not available in this batched turn (live phases: ${live.join(', ')})`
            : 'skipped: not attempted after an unavailable tool was emitted',
      })),
    );
  }
  return new Map(live.map((p) => [p, []]));
}

/**
 * Apply one phase's bucket in order, recording every outcome. Returns true
 * when the whole bucket applied cleanly. The valid prefix stays applied on
 * failure — the caller re-plans from this phase forward.
 */
function applyPhaseBucket(
  state: GameState,
  agent: Agent,
  pid: number,
  phase: TurnPhase,
  bucket: ToolCall[],
  events: DriverEvents,
): boolean {
  const results: ToolResultRecord[] = [];
  let failed: { name: string; result: ActionResult } | null = null;
  let i = 0;
  for (; i < bucket.length; i++) {
    const tc = bucket[i];
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
  for (; i < bucket.length; i++) {
    results.push({
      toolCallId: bucket[i].id,
      ok: false,
      summary: failed
        ? `skipped: not attempted after "${failed.name}" was rejected`
        : 'skipped: phase already ending',
    });
  }
  agent.recordToolResults(results);
  return !failed;
}

function endPhaseOrThrow(state: GameState, pid: number, phase: Phase): void {
  const end = endPhase(state, pid);
  if (!end.ok) {
    throw new Error(`endPhase failed for player ${pid} in ${phase}: [${end.code}] ${end.error}`);
  }
}

function skipReason(state: GameState, pid: number, phase: TurnPhase): string {
  return phaseHasActions(state, pid, phase).reason;
}

/**
 * Execute one phase group (assault or consolidate) for an AI seat.
 * `live` is the subset of the group's phases with legal actions; the rest
 * are ended directly with an onPhaseSkipped event and no LLM call.
 */
async function runPhaseGroup(
  state: GameState,
  agent: Agent,
  pid: number,
  group: PhaseGroup,
  live: TurnPhase[],
  events: DriverEvents,
  maxRetries: number,
  errors: ErrorCounter,
): Promise<void> {
  // PHASE_GROUP_ORDER is typed as Phase[]; the groups only ever contain the
  // four LLM-driven turn phases.
  const order = PHASE_GROUP_ORDER[group] as TurnPhase[];
  let buckets =
    live.length > 0
      ? await planGroup(state, agent, pid, group, live, maxRetries, errors)
      : new Map<TurnPhase, ToolCall[]>();
  const retries = new Map<TurnPhase, number>();
  let remaining = [...live];
  for (const phase of order) {
    events.onPhase?.(state, pid, phase);
    if (!live.includes(phase)) {
      events.onPhaseSkipped?.(state, pid, phase, skipReason(state, pid, phase));
      endPhaseOrThrow(state, pid, phase);
      continue;
    }
    let bucket = buckets.get(phase) ?? [];
    for (;;) {
      if (applyPhaseBucket(state, agent, pid, phase, bucket, events)) break;
      errors.count++;
      const used = (retries.get(phase) ?? 0) + 1;
      retries.set(phase, used);
      if (used > maxRetries) {
        const fr = PHASE_FALLBACKS[phase](state, pid);
        if (!fr.ok) {
          throw new Error(
            `Fallback action failed for player ${pid} in phase ${phase}: [${fr.code}] ${fr.error}`,
          );
        }
        break;
      }
      // Scoped retry: the valid prefix stays applied; the failed phase and
      // the not-yet-executed later phases are re-planned in one fresh call.
      // The old later-phase buckets are superseded — record them as skipped
      // so every tool_call keeps exactly one tool response.
      const later = remaining.slice(remaining.indexOf(phase) + 1);
      recordSkipped(agent, buckets, later, `skipped: ${phase} failed validation; re-planned with the retry`);
      remaining = remaining.slice(remaining.indexOf(phase));
      buckets = await planGroup(state, agent, pid, group, remaining, maxRetries, errors);
      bucket = buckets.get(phase) ?? [];
    }
    remaining = remaining.filter((p) => p !== phase);
    endPhaseOrThrow(state, pid, phase);
  }
}

/**
 * Run one full AI turn: two LLM calls. Group A (assault) plans purchase +
 * combat move from the pre-turn state; combat auto-resolves locally with no
 * LLM; group B (consolidate) plans non-combat + mobilize from the
 * post-combat state. Phases with no legal actions are skipped without a
 * call (see agents/affordance.ts).
 */
async function runAiTurn(
  state: GameState,
  seat: SeatRuntime,
  events: DriverEvents,
  errors: ErrorCounter,
): Promise<void> {
  const agent = seat.agent;
  if (!agent) throw new Error(`AI seat ${seat.seat.seatIndex} has no agent.`);
  const pid = seat.seat.playerId;

  const liveA = (['purchase', 'combatMove'] as TurnPhase[]).filter(
    (p) => phaseHasActions(state, pid, p).has,
  );
  await runPhaseGroup(state, agent, pid, 'assault', liveA, events, DEFAULT_MAX_RETRIES, errors);

  events.onPhase?.(state, pid, 'combat');
  autoResolveCombat(state, pid);
  endPhaseOrThrow(state, pid, 'combat');

  const liveB: TurnPhase[] = [];
  if (phaseHasActions(state, pid, 'nonCombat').has) liveB.push('nonCombat');
  if (phaseHasActions(state, pid, 'mobilize').has) liveB.push('mobilize');
  await runPhaseGroup(state, agent, pid, 'consolidate', liveB, events, DEFAULT_MAX_RETRIES, errors);
}
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

export async function runGame(
  state: GameState,
  seats: SeatRuntime[],
  events: DriverEvents = {},
  opts: { maxRounds?: number; diplomacy?: DiplomacyOptions } = {},
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
  const diplomacyOpts = opts.diplomacy ?? {};
  const diplomacyEnabled = diplomacyOpts.enabled ?? true;
  const anyAi = seats.some((s) => s.seat.kind === 'ai');
  if (diplomacyEnabled && anyAi && seats.some((s) => s.seat.kind === 'human') && !events.onHumanDiplomacy) {
    throw new Error('Human seats require events.onHumanDiplomacy when the diplomacy window runs.');
  }
  const ledger = diplomacyOpts.ledger ?? new DiplomacyLedger();
  // The Agent keeps its playerId private, so the driver cannot introspect the
  // pairing; it is established by whoever constructed the SeatRuntime
  // (AgentOptions.playerId === seat.playerId). A mismatch fails loudly via
  // engine validation, then falls back.
  const maxRounds = opts.maxRounds ?? Math.max(state.turnCap + 5, 60);
  const errorsByPlayer = new Map<number, number>();
  let lastDiplomacyRound = 0;

  while (state.phase !== 'gameover') {
    if (state.round > maxRounds) throw new MaxRoundsExceeded(state.round, maxRounds);
    // Diplomacy window: once per round, before the first purchase phase.
    // Skipped when no seat is AI-driven (humans already chat freely).
    if (diplomacyEnabled && anyAi && state.round !== lastDiplomacyRound) {
      lastDiplomacyRound = state.round;
      await runDiplomacyWindow(
        state,
        seats,
        ledger,
        {
          onHumanDiplomacy: events.onHumanDiplomacy,
          onDiplomacyMessage: events.onDiplomacyMessage,
          onDiplomacyWindow: events.onDiplomacyWindow,
          onDiplomacyToolCall: events.onDiplomacyToolCall,
        },
        {
          budgetPerRound: diplomacyOpts.budgetPerRound,
          backstopIterations: diplomacyOpts.backstopIterations,
        },
      );
    }
    const pid = state.currentPlayer;
    const seat = seats[pid];
    if (!seat) throw new Error(`No seat configured for current player ${pid}.`);
    if (seat.seat.kind === 'human') {
      events.onPhase?.(state, pid, state.phase);
      await events.onHumanTurn!(state, pid, state.phase);
    } else {
      // AI seats run the whole turn batched (two LLM calls); per-phase
      // onPhase/onPhaseSkipped events fire inside runAiTurn.
      const errors: ErrorCounter = { count: 0 };
      await runAiTurn(state, seat, events, errors);
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
  return { state, usage, rounds: state.round, diplomacy: ledger };
}
