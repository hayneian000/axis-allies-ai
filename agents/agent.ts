// One LLM seat at the table. Builds prompts ONLY from its own inputs —
// RULES_DIGEST, its own name/persona, summarizeState(ownPlayerId), its own
// private history, and PUBLIC chatLog messages. It has no access path to
// other agents' histories, system prompts, or private messages. The driver
// (not this class) executes tool calls against the engine.

import { summarizeState } from '../engine/engine';
import type { GameState, Phase } from '../engine/types';
import { buildPhasePrompt, buildSystemPrompt } from './prompts';
import { toolsForPhase } from './tools';
import {
  emptyUsage,
  type PlayerUsage,
  type ProviderAdapter,
  type TokenUsage,
  type ToolCall,
  type TranscriptMessage,
} from './types';

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
}

export interface ActResult {
  toolCalls: ToolCall[];
  text: string;
  /** Token usage consumed by THIS act call (the accumulated total is on `usage`). */
  usage: PlayerUsage;
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
  /** Private conversation memory for THIS seat only. Never exposed. */
  private history: TranscriptMessage[] = [];
  private totalUsage: PlayerUsage = emptyUsage();

  constructor(opts: AgentOptions) {
    this.playerId = opts.playerId;
    this.provider = opts.provider;
    this.model = opts.model;
    this.getApiKey = opts.getApiKey;
    this.persona = opts.persona;
    this.maxTokens = opts.maxTokens;
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
   */
  async act(state: GameState, phase: Phase): Promise<ActResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new MissingApiKeyError(this.playerId);

    const me = state.players[this.playerId];
    const playerName = me?.name ?? `Player ${this.playerId}`;
    const system = buildSystemPrompt({ playerName, persona: this.persona });

    const stateBrief = summarizeState(state, this.playerId);
    const chat = visibleChat(state, playerName);
    const phasePrompt = buildPhasePrompt({ phase, stateBrief });
    const userContent = chat ? `${phasePrompt}\n\nPUBLIC CHAT (visible to you)\n${chat}` : phasePrompt;

    const transcript: TranscriptMessage[] = [...this.history, { role: 'user', content: userContent }];
    const tools = toolsForPhase(phase);
    const delta: PlayerUsage = emptyUsage();

    const resp = await this.provider.complete({
      apiKey,
      model: this.model,
      system,
      transcript,
      tools,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
    });
    delta.inputTokens += resp.usage.inputTokens;
    delta.outputTokens += resp.usage.outputTokens;
    delta.calls += 1;

    const assistantMsg: TranscriptMessage = { role: 'assistant', content: resp.text };
    if (resp.toolCalls.length > 0) assistantMsg.toolCalls = resp.toolCalls;
    this.history.push(assistantMsg);

    this.totalUsage.inputTokens += delta.inputTokens;
    this.totalUsage.outputTokens += delta.outputTokens;
    this.totalUsage.calls += delta.calls;

    return { toolCalls: resp.toolCalls, text: resp.text, usage: { ...delta } };
  }

  /** Forget this seat's private conversation memory. */
  resetHistory(): void {
    this.history = [];
  }

  /** Token usage accumulated across all act() calls for this seat. */
  get usage(): PlayerUsage {
    return { ...this.totalUsage };
  }
}

/** Re-exported for drivers that only need the delta shape. */
export type { TokenUsage };
