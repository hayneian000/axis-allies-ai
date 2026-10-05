// M3 diplomacy: freeform talk between seats, bounded by token budgets.
//
// One diplomacy window opens at the start of each round (before the first
// purchase phase). Seats talk round-robin in turn order using only
// `send_message` / `end_diplomacy`. The game enforces nothing about WHAT is
// said — only HOW MUCH (per-seat token budgets). Everything said is recorded
// in the DiplomacyLedger, which feeds the end-of-game JSON dump — the raw
// material for later (offline) analysis of alliances, betrayal, and disclosure.
//
// Deferred (explicitly): commitment extraction, betrayal detection, alliance
// graphs, reputation ledgers, structured/enforced deals.

import { dispatchTool } from './tools';
import type { Agent, ToolResultRecord } from './agent';
import type { GameState } from '../engine/types';
import type { PlayerUsage, SeatConfig } from './types';

/** Diplomacy token budget per AI seat per round. Tunable; recorded in the dump. */
export const DIPLOMACY_BUDGET_PER_ROUND = 2500;

/**
 * Anti-runaway fuse: max diplomacy turns per seat per window. Not a gameplay
 * rule — it only bounds a seat that never says done and never runs dry.
 */
export const DIPLOMACY_BACKSTOP_ITERATIONS = 12;

/**
 * Consecutive fully-rejected turns (no accepted message, no end_diplomacy)
 * before a seat is marked done. Rejections cost no budget, so without this a
 * seat could burn unlimited real provider calls on malformed messages.
 */
export const DIPLOMACY_MAX_STRIKES = 2;

export interface DiplomacyMessageRecord {
  seq: number;
  round: number;
  senderId: number;
  sender: string;
  recipients: string;
  text: string;
  /**
   * Tokens (in+out) of the provider round-trip that produced this message.
   * When one call yields several messages each carries the call's full
   * count — do NOT sum this column; spend[pid][round] is authoritative.
   * Human-sent messages record 0.
   */
  tokens: number;
}

/** True when a message was addressed to someone other than "all". */
export function isPrivateMessage(recipients: string): boolean {
  return recipients.trim().toLowerCase() !== 'all';
}

function newGameId(): string {
  const c = (globalThis as Record<string, unknown>).crypto as
    | { randomUUID?: () => string }
    | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `game-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * The running record of everything said during diplomacy, plus per-seat
 * token spend. Owned by the driver; read by the UI (budget meters, panel)
 * and the dump builder.
 */
export class DiplomacyLedger {
  readonly gameId: string;
  readonly messages: DiplomacyMessageRecord[] = [];
  /** spend[pid][round] = diplomacy tokens charged to that seat that round. */
  readonly spend: Record<number, Record<number, number>> = {};
  /** Effective window constants for this game (set by the first window). */
  budgetPerRound: number = DIPLOMACY_BUDGET_PER_ROUND;
  backstopIterations: number = DIPLOMACY_BACKSTOP_ITERATIONS;
  private seqCounter = 0;

  constructor(gameId?: string) {
    this.gameId = gameId ?? newGameId();
  }

  recordMessage(m: Omit<DiplomacyMessageRecord, 'seq'>): DiplomacyMessageRecord {
    const rec: DiplomacyMessageRecord = { ...m, seq: this.seqCounter++ };
    this.messages.push(rec);
    return rec;
  }

  recordSpend(pid: number, round: number, tokens: number): void {
    const r = (this.spend[pid] ??= {});
    r[round] = (r[round] ?? 0) + tokens;
  }

  spendFor(pid: number, round: number): number {
    return this.spend[pid]?.[round] ?? 0;
  }
}

export interface DiplomacySeat {
  seat: SeatConfig;
  /** Required when seat.kind === 'ai'. */
  agent?: Agent;
}

export interface DiplomacyEvents {
  /** Human seat's turn in the window; resolves when the human is done talking. */
  onHumanDiplomacy?: (state: GameState, playerId: number) => Promise<void>;
  /** A message was accepted into chatLog (AI or human). */
  onDiplomacyMessage?: (state: GameState, msg: DiplomacyMessageRecord) => void;
  /** Window opened/closed for a round. */
  onDiplomacyWindow?: (state: GameState, round: number, open: boolean) => void;
  /** Engine validation outcome for an AI seat's send_message. */
  onDiplomacyToolCall?: (playerId: number, name: string, ok: boolean, code?: string) => void;
}

export interface RunDiplomacyOpts {
  budgetPerRound?: number;
  backstopIterations?: number;
  maxStrikes?: number;
}

interface DiplomacyTurnOutcome {
  /** The seat is done with this window. */
  finished: boolean;
  /**
   * Whether the turn's tokens charge against the budget: true when the turn
   * produced at least one accepted message or an end_diplomacy. Fully
   * rejected (or empty) turns cost no budget.
   */
  charged: boolean;
  usage: PlayerUsage;
}

/**
 * One AI seat's turn in the window: a single diplomacyAct round-trip, then
 * dispatch each send_message through engine validation. end_diplomacy is
 * consumed here, never dispatched. Outcomes are recorded back into the
 * agent's history (transcript validity + rejection feedback).
 */
async function aiDiplomacyTurn(
  state: GameState,
  agent: Agent,
  pid: number,
  budgetRemaining: number,
  ledger: DiplomacyLedger,
  events: DiplomacyEvents,
): Promise<DiplomacyTurnOutcome> {
  const { toolCalls, usage } = await agent.diplomacyAct(state, budgetRemaining);
  const turnTokens = usage.inputTokens + usage.outputTokens;
  const results: ToolResultRecord[] = [];
  const sent: DiplomacyMessageRecord[] = [];
  let finished = toolCalls.length === 0;
  let sawEndDiplomacy = false;
  let acceptedAny = false;

  let i = 0;
  for (; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc.name === 'end_diplomacy') {
      results.push({ toolCallId: tc.id, ok: true, summary: 'ok: leaving diplomacy' });
      sawEndDiplomacy = true;
      finished = true;
      i++;
      break;
    }
    if (tc.name !== 'send_message') {
      results.push({
        toolCallId: tc.id,
        ok: false,
        summary: `rejected [unknown_tool]: "${tc.name}" is not available in diplomacy (only send_message and end_diplomacy)`,
      });
      i++;
      break;
    }
    const r = dispatchTool(state, pid, 'send_message', tc.arguments);
    events.onDiplomacyToolCall?.(pid, 'send_message', r.ok, r.ok ? undefined : r.code);
    if (r.ok) {
      acceptedAny = true;
      const msg = state.chatLog[state.chatLog.length - 1];
      sent.push(
        ledger.recordMessage({
          round: state.round,
          senderId: pid,
          sender: msg.sender,
          recipients: msg.recipients,
          text: msg.text,
          tokens: 0, // filled below once charging is decided
        }),
      );
      events.onDiplomacyMessage?.(state, sent[sent.length - 1]);
      results.push({
        toolCallId: tc.id,
        ok: true,
        summary: `ok: sent message to ${String(tc.arguments.recipients ?? 'all')}`,
      });
    } else {
      // First rejection stops the batch (mirrors the phase driver); the
      // model sees why on its next turn via the recorded result.
      results.push({ toolCallId: tc.id, ok: false, summary: `rejected [${r.code}]: ${r.error}` });
      i++;
      break;
    }
  }
  for (; i < toolCalls.length; i++) {
    results.push({
      toolCallId: toolCalls[i].id,
      ok: false,
      summary: 'skipped: not attempted',
    });
  }
  agent.recordToolResults(results);

  const charged = acceptedAny || sawEndDiplomacy;
  if (charged) {
    for (const m of sent) m.tokens = turnTokens;
  }
  return { finished, charged, usage };
}

/**
 * Run one diplomacy window for the current round. Seats speak round-robin in
 * turn order (alive players only). A seat's turn ends when it calls
 * end_diplomacy, sends nothing, exhausts its budget, hits the backstop, or
 * accumulates too many consecutive fully-rejected turns. The window closes
 * when every seat is done.
 */
export async function runDiplomacyWindow(
  state: GameState,
  seats: DiplomacySeat[],
  ledger: DiplomacyLedger,
  events: DiplomacyEvents = {},
  opts: RunDiplomacyOpts = {},
): Promise<void> {
  const budget = opts.budgetPerRound ?? DIPLOMACY_BUDGET_PER_ROUND;
  const backstop = opts.backstopIterations ?? DIPLOMACY_BACKSTOP_ITERATIONS;
  const maxStrikes = opts.maxStrikes ?? DIPLOMACY_MAX_STRIKES;
  const round = state.round;
  // Record the effective constants on the ledger so the dump reflects the
  // game that was actually played (not the defaults).
  ledger.budgetPerRound = budget;
  ledger.backstopIterations = backstop;

  const order = state.turnOrder.filter((pid) => {
    const s = seats[pid];
    return s && state.players[pid]?.alive;
  });
  if (order.length === 0) return;

  events.onDiplomacyWindow?.(state, round, true);
  try {
    const done = new Set<number>();
    const spent = new Map<number, number>();
    const iterations = new Map<number, number>();
    const strikes = new Map<number, number>();
    let guard = 0;

    while (done.size < order.length) {
      // Absolute fuse on top of the per-seat backstop.
      if (++guard > backstop * order.length + order.length) break;
      let progressed = false;
      for (const pid of order) {
        if (done.has(pid)) continue;
        if ((iterations.get(pid) ?? 0) >= backstop) {
          done.add(pid);
          continue;
        }
        iterations.set(pid, (iterations.get(pid) ?? 0) + 1);
        progressed = true;
        const seat = seats[pid];

        if (seat.seat.kind === 'human') {
          await events.onHumanDiplomacy?.(state, pid);
          done.add(pid);
          continue;
        }

        const agent = seat.agent;
        if (!agent) throw new Error(`AI seat ${seat.seat.seatIndex} (player ${pid}) has no agent.`);
        const remaining = budget - (spent.get(pid) ?? 0);
        if (remaining <= 0) {
          done.add(pid); // budget exhausted: silent for the rest of the window
          continue;
        }
        const turn = await aiDiplomacyTurn(state, agent, pid, remaining, ledger, events);
        if (turn.charged) {
          const t = turn.usage.inputTokens + turn.usage.outputTokens;
          spent.set(pid, (spent.get(pid) ?? 0) + t);
          ledger.recordSpend(pid, round, t);
          agent.chargeDiplomacy(turn.usage.inputTokens, turn.usage.outputTokens);
          strikes.set(pid, 0);
        } else {
          const s = (strikes.get(pid) ?? 0) + 1;
          strikes.set(pid, s);
          if (s >= maxStrikes) done.add(pid);
        }
        if (turn.finished) done.add(pid);
      }
      if (!progressed) break;
    }
  } finally {
    events.onDiplomacyWindow?.(state, round, false);
  }
}

// ---------------------------------------------------------------- dump ---

export interface DiplomacyDumpPlayer {
  id: number;
  name: string;
  kind: 'human' | 'ai';
  provider?: string;
  model?: string;
}

export interface DiplomacyDump {
  gameId: string;
  seed: number;
  scenario: string;
  rounds: number;
  players: DiplomacyDumpPlayer[];
  diplomacy: {
    budgetPerRound: number;
    backstopIterations: number;
    messages: Array<{
      seq: number;
      round: number;
      sender: string;
      recipients: string;
      text: string;
      tokens: number;
    }>;
    spend: Record<number, Record<number, number>>;
  };
  result: {
    winner: number | null;
    winReason: string | null;
    rounds: number;
  };
}

/**
 * Build the end-of-game diplomacy JSON dump — the raw material for later
 * offline analysis (commitment extraction, betrayal detection, alliance
 * graphs). Pure function of ledger + final state.
 */
export function buildDiplomacyDump(args: {
  ledger: DiplomacyLedger;
  state: GameState;
  seats: SeatConfig[];
  playerNames: string[];
}): DiplomacyDump {
  const { ledger, state, seats, playerNames } = args;
  return {
    gameId: ledger.gameId,
    seed: state.seed,
    scenario: `scenario-${state.numPlayers}p`,
    rounds: state.round,
    players: state.players.map((p) => {
      const seat = seats[p.id];
      return {
        id: p.id,
        name: playerNames[p.id] ?? p.name,
        kind: seat?.kind ?? 'ai',
        ...(seat?.provider ? { provider: seat.provider } : {}),
        ...(seat?.model ? { model: seat.model } : {}),
      };
    }),
    diplomacy: {
      budgetPerRound: ledger.budgetPerRound,
      backstopIterations: ledger.backstopIterations,
      messages: ledger.messages.map((m) => ({
        seq: m.seq,
        round: m.round,
        sender: m.sender,
        recipients: m.recipients,
        text: m.text,
        tokens: m.tokens,
      })),
      spend: JSON.parse(JSON.stringify(ledger.spend)) as Record<number, Record<number, number>>,
    },
    result: {
      winner: state.winner,
      winReason: state.winReason,
      rounds: state.round,
    },
  };
}
