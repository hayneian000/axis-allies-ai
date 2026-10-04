// Shared types for the Phase 2 BYOK agent package.

/** LLM providers supported in v1. */
export type ProviderId = 'anthropic' | 'openai' | 'meta';

/** One seat at the table: a human (driven via UI) or an AI (driven via LLM). */
export interface SeatConfig {
  seatIndex: number;
  playerId: number;
  kind: 'human' | 'ai';
  /** Required when kind === 'ai'. */
  provider?: ProviderId;
  /** Required when kind === 'ai'. Must be one of the provider's curated models. */
  model?: string;
  /**
   * BYOK key slot id. Defaults to the provider id. Keys are stored client-side
   * (see agents/keys.ts) and passed per call — never persisted by adapters.
   */
  keySlot?: string;
}

/** Provider-agnostic conversation transcript. Adapters translate this to wire format. */
export type TranscriptMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** A tool the agent may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool call requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Token counts for a single provider round-trip. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Accumulated usage for one player across a game. */
export interface PlayerUsage extends TokenUsage {
  calls: number;
  /** Tool calls rejected by engine validation. */
  errors: number;
}

export function emptyUsage(): PlayerUsage {
  return { inputTokens: 0, outputTokens: 0, calls: 0, errors: 0 };
}

/** Single round-trip request to a provider. */
export interface CompleteRequest {
  apiKey: string;
  model: string;
  system: string;
  transcript: TranscriptMessage[];
  tools: ToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Single round-trip response from a provider. */
export interface CompleteResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason: string;
}

/** One entry in the provider registry. */
export interface ModelInfo {
  id: string;
  label: string;
  default?: boolean;
}

/**
 * Common interface every provider adapter implements.
 * Implementations MUST NOT log or persist apiKey; it is passed per call only.
 */
export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  endpoint: string;
  /** Curated v1 model list. Model IDs roll forward — refresh periodically. */
  models: ModelInfo[];
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}
