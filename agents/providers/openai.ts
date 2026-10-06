// OpenAI chat-completions adapter + reusable OpenAI-compatible helper. Model IDs verified 2026-10-03.

import type {
  CompleteRequest,
  CompleteResponse,
  ModelInfo,
  ProviderAdapter,
  ToolCall,
  TranscriptMessage,
} from '../types';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Default cap on generated tokens per request. Mirrors the Anthropic
 * adapter's default max_tokens (2048). Generation is the serial latency
 * bottleneck on every turn — without a cap, one rambly phase dominates the
 * wait. Sent as max_completion_tokens (not max_tokens): Meta's Model API
 * documents that preference, and OpenAI's current models accept it too.
 */
export const DEFAULT_MAX_COMPLETION_TOKENS = 2048;

const MODELS: ModelInfo[] = [
  { id: 'gpt-5.6', label: 'GPT-5.6', default: true },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
];

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function toChatMessages(system: string, transcript: TranscriptMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of transcript) {
    if (m.role === 'assistant') {
      const msg: ChatMessage = { role: 'assistant', content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(msg);
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    } else {
      messages.push({ role: 'user', content: m.content });
    }
  }
  return messages;
}

interface CompatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * One round-trip against any OpenAI-compatible `/chat/completions` endpoint.
 * `baseUrl` is the API root (no trailing slash); `/chat/completions` is appended.
 */
export async function openAiCompatComplete(
  baseUrl: string,
  req: CompleteRequest,
): Promise<CompleteResponse> {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: req.model,
    messages: toChatMessages(req.system, req.transcript),
    tools: req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: 'auto',
    // Bound the output: every generated token is produced serially before
    // the driver can dispatch the phase's tool calls, so an uncapped model
    // can single-handedly make a turn feel stuck.
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    // Prompt-cache routing: the static prefix (system prompt incl. the map
    // reference) is byte-identical across calls, so the server reuses it
    // automatically; the stable key keeps same-prefix requests on the same
    // backend to raise the hit rate at scale. Omitted when not provided.
    ...(req.promptCacheKey ? { prompt_cache_key: req.promptCacheKey } : {}),
    ...(req.promptCacheRetention ? { prompt_cache_retention: req.promptCacheRetention } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`OpenAI-compatible API error at ${baseUrl}: ${res.status} ${res.statusText}`.trim());
  }

  const json = (await res.json()) as CompatResponse;
  const choice = json.choices?.[0];
  const message = choice?.message ?? {};

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
    let args: Record<string, unknown> = {};
    const raw = tc.function?.arguments;
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
    }
    return { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: args };
  });

  return {
    text: message.content ?? '',
    toolCalls,
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      // The number to watch for prompt-cache health: how much of the static
      // prefix the server served from cache instead of recomputing.
      ...(json.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: json.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    stopReason: choice?.finish_reason ?? 'unknown',
  };
}

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  label: 'OpenAI',
  endpoint: `${OPENAI_BASE_URL}/chat/completions`,
  models: MODELS,
  complete(req: CompleteRequest): Promise<CompleteResponse> {
    return openAiCompatComplete(OPENAI_BASE_URL, req);
  },
};
