// Anthropic Messages API adapter. Model IDs verified live 2026-10-31 -
// refresh periodically. The account models list reports Haiku only as the
// dated claude-haiku-4-5-20251001; the claude-haiku-4-5 alias below is
// accepted by /v1/messages and resolves to that snapshot (checked live).

import type {
  CompleteRequest,
  CompleteResponse,
  ModelInfo,
  ProviderAdapter,
  ToolCall,
  TranscriptMessage,
} from '../types';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

const MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', default: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

function toAnthropicMessages(transcript: TranscriptMessage[]): AnthropicMessage[] {
  return transcript.map((m): AnthropicMessage => {
    if (m.role === 'assistant') {
      const content: ContentBlock[] = [];
      // Anthropic rejects empty text blocks ("text content blocks must be
      // non-empty"), and a tool-only reply is stored with "" as its text -
      // only send a text block when there is text to send.
      if (m.content) {
        content.push({ type: 'text', text: m.content });
      }
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      // A reply with neither text nor tool calls would serialize to an
      // empty content array, which the API also rejects - send a neutral
      // placeholder so the history entry stays valid.
      if (content.length === 0) {
        content.push({ type: 'text', text: '(no text reply)' });
      }
      return { role: 'assistant', content };
    }
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
      };
    }
    return { role: 'user', content: m.content };
  });
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic',
  endpoint: ENDPOINT,
  models: MODELS,

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: toAnthropicMessages(req.transcript),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      // NOTE: temperature is intentionally omitted (non-default values 400 on current models).
    };

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': req.apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error: ${res.status} ${res.statusText}`.trim());
    }

    const json = (await res.json()) as AnthropicResponse;
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text') {
        texts.push(block.text ?? '');
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? '',
          name: block.name ?? '',
          arguments: block.input ?? {},
        });
      }
    }

    return {
      text: texts.join(''),
      toolCalls,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      stopReason: json.stop_reason ?? 'unknown',
    };
  },
};
