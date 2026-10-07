// One LLM seat at the table. Builds prompts ONLY from its own inputs —
// RULES_DIGEST, its own name/persona, summarizeState(ownPlayerId), its own
// private history, and PUBLIC chatLog messages. It has no access path to
// other agents' histories, system prompts, or private messages. The driver
// (not this class) executes tool calls against the engine.

import { summarizeState } from '../engine/engine';
import type { GameState, Phase } from '../engine/types';
import { buildDiplomacyPrompt, buildGroupPrompt, buildPhasePrompt, buildSystemPrompt, PROMPT_CACHE_RETENTION, staticReferenceCacheKey } from './prompts';
import { TOOLS, toolsForGroup, toolsForPhase } from './tools';
import type { PhaseGroup } from './tools';
import {
  emptyDiplomacyUsage,
  emptyUsage,
  type DiplomacyUsage,
  type PlayerUsage,
  type ProviderAdapter,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  type TranscriptMessage,
} from './types';

/** Default history window: the last 4 transcript turns per seat. */
export const DEFAULT_HISTORY_WINDOW_TURNS = 4;

export class MissingApiKeyError extends Error {
  readonly playerId: number;
  constructor(playerId: number) {
    super(`No API key available for player ${playerId}.`);
    this.name = 'MissingApiKeyError';
    this.playerId = playerId;
  }
}

export interface AgentOptions {
  playerId: number;
  provider: ProviderAdapter;
  model: string;
  getApiKey: () => string | null;
  persona?: string;
  maxTokens?: number;
  /**
   * How many recent transcript turns to keep in the seat's private history.
   * A "turn" is one act()/diplomacyAct() round-trip: its response plus the
   * tool results the driver records for it. Older turns are dropped from the
   * front, whole — so every assistant tool_calls entry stays paired with
   * its tool responses, which provider APIs require.
   *
   * The bound that matters for turn speed: every act() re-sends the full
   * history, so without a window input tokens (and prefill latency) grow
   * every phase of every game. The current prompt already carries a full
   * state snapshot (summarizeState), so dropped turns cost almost no
   * decision context. Default 4; 0 restores the old unbounded behavior.
   */
  historyWindowTurns?: number;
}

export interface ActResult {
  toolCalls: ToolCall[];
  text: string;
  /** Token usage consumed by THIS act call (the accumulated total is on `usage`). */
  usage: PlayerUsage;
}

/**
 * One tool-call outcome, recorded into the agent's history by the driver
 * after it executes the batch from act().
 */
export interface ToolResultRecord {
  /** Matches the `id` of the ToolCall this result answers. */
  toolCallId: string;
  ok: boolean;
  /** Short human-readable summary, e.g. `ok: purchased 3 infantry`. */
  summary: string;
}

/** Public chat messages visible to `playerName`: broadcast or addressed to them. */
function visibleChat(state: GameState, playerName: string): string {
  const lines: string[] = [];
  for (const m of state.chatLog) {
    const recipients = m.recipients.trim().toLowerCase();
    const addressed = recipients === 'all' || recipients.split(',').map((s) => s.trim().toLowerCase()).includes(playerName.toLowerCase());
    if (!addressed) continue;
    lines.push(`[Round ${m.round}] ${m.sender} -> ${m.recipients}: ${m.text}`);
  }
  return lines.join('\n');
}

export class Agent {
  private readonly playerId: number;
  private readonly provider: ProviderAdapter;
  private readonly model: string;
  private readonly getApiKey: () => string | null;
  private readonly persona?: string;
  private readonly maxTokens?: number;
  private readonly historyWindowTurns: number;
  /** Private conversation memory for THIS seat only. Never exposed. */
  private history: TranscriptMessage[] = [];
  /**
   * History entries appended by each act()/diplomacyAct() turn (plus the
   * tool results recorded for it afterwards), oldest first. Drives the
   * history window: entries are only ever dropped whole turns from the
   * front, so tool_calls/tool-response pairing is never split.
   */
  private turnSizes: number[] = [];
  private totalUsage: PlayerUsage = emptyUsage();
  private diplomacyUsage: DiplomacyUsage = emptyDiplomacyUsage();

  constructor(opts: AgentOptions) {
    this.playerId = opts.playerId;
    this.provider = opts.provider;
    this.model = opts.model;
    this.getApiKey = opts.getApiKey;
    this.persona = opts.persona;
    this.maxTokens = opts.maxTokens;
    this.historyWindowTurns = opts.historyWindowTurns ?? DEFAULT_HISTORY_WINDOW_TURNS;
  }

  /**
   * Drop transcript turns older than the window, whole turns from the
   * front. Called at the start of every act()/diplomacyAct(), before the
   * fresh prompt is appended — so the outgoing transcript never exceeds
   * the window plus the current turn, no matter how long the game runs.
   */
  private trimHistory(): void {
    const w = this.historyWindowTurns;
    if (w <= 0) return; // 0 (or negative) = unbounded, the pre-window behavior
    let drop = 0;
    while (this.turnSizes.length > w) drop += this.turnSizes.shift()!;
    if (drop > 0) this.history.splice(0, drop);
  }

  /**
   * Run one phase's worth of LLM reasoning: a single provider round-trip.
   * Returns the tool calls the model requested — the DRIVER executes them
   * against the engine; this method never touches game state beyond reading it.
   *
   * Single round-trip (not a ReAct loop) by design: tool results are produced
   * by the driver, so looping here without them would just burn tokens. A
   * model that wants several actions in one phase returns several tool calls
   * in this response; the driver applies them in order, and re-prompts (with
   * fresh state) when validation rejects one.
   *
   * `onToken`, when provided, is forwarded to the provider: adapters that
   * support it stream the response (SSE) and call it with each text delta
   * as it arrives, instead of returning only after the full response.
   */
  async act(state: GameState, phase: Phase, onToken?: (deltaText: string) => void): Promise<ActResult> {
    const phasePrompt = buildPhasePrompt({ phase, stateBrief: summarizeState(state, this.playerId) });
    return this.complete(state, phasePrompt, toolsForPhase(phase), onToken);
  }

  /**
   * Run one BATCHED turn's worth of LLM reasoning: a single provider
   * round-trip plans every live phase in `phases` (canonical order). The
   * driver partitions the returned tool calls by tool name and applies them
   * phase by phase. Used by the turn driver; diplomacy and human-driven
   * paths keep using act().
   *
   * `onToken`, when provided, is forwarded to the provider for streaming
   * (see act()).
   */
  async actGroup(
    state: GameState,
    group: PhaseGroup,
    phases: Phase[],
    onToken?: (deltaText: string) => void,
  ): Promise<ActResult> {
    const groupPrompt = buildGroupPrompt({
      group,
      phases,
      stateBrief: summarizeState(state, this.playerId),
    });
    return this.complete(state, groupPrompt, toolsForGroup(phases), onToken);
  }

  /**
   * Shared single-round-trip implementation behind act()/actGroup(): build
   * the prompt from the seat's own inputs, send it, and file the response
   * in the private history (tool results are recorded afterwards by the
   * driver via recordToolResults).
   */
  private async complete(
    state: GameState,
    userPrompt: string,
    tools: ToolDefinition[],
    onToken?: (deltaText: string) => void,
  ): Promise<ActResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new MissingApiKeyError(this.playerId);

    // Bound the outgoing transcript before the fresh prompt goes on it.
    this.trimHistory();
    const historyBefore = this.history.length;

    const me = state.players[this.playerId];
    const playerName = me?.name ?? `Player ${this.playerId}`;
    const system = buildSystemPrompt({ playerName, persona: this.persona });

    const chat = visibleChat(state, playerName);
    const userContent = chat ? `${userPrompt}\n\nPUBLIC CHAT (visible to you)\n${chat}` : userPrompt;

    const transcript: TranscriptMessage[] = [...this.history, { role: 'user', content: userContent }];
    const delta: PlayerUsage = emptyUsage();

    const resp = await this.provider.complete({
      apiKey,
      model: this.model,
      system,
      transcript,
      tools,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      // Prompt-cache routing for the static prefix (system prompt incl. the
      // map reference — byte-identical every call). One shared key across
      // seats; the retention hint keeps it warm across idle gaps.
      promptCacheKey: staticReferenceCacheKey(),
      promptCacheRetention: PROMPT_CACHE_RETENTION,
      // Stream the response when the caller wants live deltas (the browser
      // UI does); otherwise this is a plain non-streaming round-trip.
      ...(onToken ? { onToken } : {}),
    });
    delta.inputTokens += resp.usage.inputTokens;
    delta.outputTokens += resp.usage.outputTokens;
    delta.calls += 1;

    const assistantMsg: TranscriptMessage = { role: 'assistant', content: resp.text };
    if (resp.toolCalls.length > 0) assistantMsg.toolCalls = resp.toolCalls;
    this.history.push(assistantMsg);
    // The driver records this turn's tool results afterwards via
    // recordToolResults, which attributes them to this same turn entry.
    this.turnSizes.push(this.history.length - historyBefore);

    this.totalUsage.inputTokens += delta.inputTokens;
    this.totalUsage.outputTokens += delta.outputTokens;
    this.totalUsage.calls += delta.calls;

    return { toolCalls: resp.toolCalls, text: resp.text, usage: { ...delta } };
  }

  /**
   * One turn inside the diplomacy window: a single provider round-trip with
   * only the chat tools exposed. Shares the seat's private history (so the
   * model remembers the game). Token usage always accumulates into the
   * totals; the diplomacy-budget breakout is charged separately via
   * chargeDiplomacy, because the budget rule charges only round-trips that
   * produced an accepted message or an end_diplomacy.
   *
   * `onToken`, when provided, is forwarded to the provider for streaming
   * (see act()).
   */
  async diplomacyAct(state: GameState, budgetRemaining: number, onToken?: (deltaText: string) => void): Promise<ActResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new MissingApiKeyError(this.playerId);

    // Same window as act(): diplomacy shares the seat's history.
    this.trimHistory();
    const historyBefore = this.history.length;

    const me = state.players[this.playerId];
    const playerName = me?.name ?? `Player ${this.playerId}`;
    const system = buildSystemPrompt({ playerName, persona: this.persona });

    const stateBrief = summarizeState(state, this.playerId);
    const chat = visibleChat(state, playerName);
    const prompt = buildDiplomacyPrompt({ stateBrief, visibleChat: chat, budgetRemaining });

    const transcript: TranscriptMessage[] = [...this.history, { role: 'user', content: prompt }];
    const tools = [TOOLS.send_message, TOOLS.end_diplomacy];
    const delta: PlayerUsage = emptyUsage();

    const resp = await this.provider.complete({
      apiKey,
      model: this.model,
      system,
      transcript,
      tools,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      // Prompt-cache routing for the static prefix (system prompt incl. the
      // map reference — byte-identical every call). One shared key across
      // seats; the retention hint keeps it warm across idle gaps.
      promptCacheKey: staticReferenceCacheKey(),
      promptCacheRetention: PROMPT_CACHE_RETENTION,
      // Stream the response when the caller wants live deltas (the browser
      // UI does); otherwise this is a plain non-streaming round-trip.
      ...(onToken ? { onToken } : {}),
    });
    // Diplomacy usage always accumulates into the seat totals, and the
    // budget breakout is charged separately by the driver.
    delta.inputTokens += resp.usage.inputTokens;
    delta.outputTokens += resp.usage.outputTokens;
    delta.calls += 1;

    const assistantMsg: TranscriptMessage = { role: 'assistant', content: resp.text };
    if (resp.toolCalls.length > 0) assistantMsg.toolCalls = resp.toolCalls;
    this.history.push(assistantMsg);
    // Attributed to this turn; recordToolResults adds this turn's tool
    // results to the same entry afterwards.
    this.turnSizes.push(this.history.length - historyBefore);

    this.totalUsage.inputTokens += delta.inputTokens;
    this.totalUsage.outputTokens += delta.outputTokens;
    this.totalUsage.calls += delta.calls;

    return { toolCalls: resp.toolCalls, text: resp.text, usage: { ...delta } };
  }

  /**
   * Charge tokens against the diplomacy budget breakout. Called by the
   * diplomacy driver only for round-trips that produced at least one
   * accepted send_message or an end_diplomacy — fully-rejected round-trips
   * cost no budget (they still count in the totals above).
   */
  chargeDiplomacy(inputTokens: number, outputTokens: number): void {
    this.diplomacyUsage.inputTokens += inputTokens;
    this.diplomacyUsage.outputTokens += outputTokens;
    this.diplomacyUsage.calls += 1;
  }

  /** Token usage accumulated across all act() calls for this seat. */
  get usage(): PlayerUsage {
    return {
      ...this.totalUsage,
      diplomacy: { ...this.diplomacyUsage },
    };
  }

  /**
   * Record the outcomes of this seat's own tool calls into the private
   * history as `{role:'tool'}` messages. The driver calls this after
   * executing each batch returned from act().
   *
   * Two purposes: (1) provider APIs require every assistant `tool_calls`
   * entry to have a matching tool response — without this, the second and
   * later provider calls are rejected (HTTP 400); (2) the model sees what
   * succeeded and why rejections happened before its next act().
   */
  recordToolResults(results: ToolResultRecord[]): void {
    for (const r of results) {
      this.history.push({ role: 'tool', toolCallId: r.toolCallId, content: r.summary });
    }
    // These belong to the turn that produced the tool calls (the most
    // recent act()/diplomacyAct()), so the history window keeps dropping
    // whole turns and never splits a tool_calls/tool-response pair.
    if (this.turnSizes.length === 0) this.turnSizes.push(0);
    this.turnSizes[this.turnSizes.length - 1] += results.length;
  }

  /** Forget this seat's private conversation memory. */
  resetHistory(): void {
    this.history = [];
    this.turnSizes = [];
  }
}

/** Re-exported for drivers that only need the delta shape. */
export type { TokenUsage };
