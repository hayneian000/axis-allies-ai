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
 *
 * When `req.onToken` is set the request goes out with `stream: true` (SSE):
 * text deltas are forwarded to the callback as they arrive and the response
 * is assembled from the stream. The returned shape is identical to a
 * non-streaming call, so callers consume it the same way. This also dodges
 * Meta's 504-on-long-non-streaming-requests behavior — the browser UI
 * streams every turn for exactly that reason.
 */
export async function openAiCompatComplete(
  baseUrl: string,
  req: CompleteRequest,
): Promise<CompleteResponse> {
  if (req.onToken) {
    return openAiCompatStream(baseUrl, req, req.onToken);
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(compatRequestBody(req, false)),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`OpenAI-compatible API error at ${baseUrl}: ${res.status} ${res.statusText}`.trim());
  }

  const json = (await res.json()) as CompatResponse;
  const choice = json.choices?.[0];
  const message = choice?.message ?? {};

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
    id: tc.id ?? '',
    name: tc.function?.name ?? '',
    arguments: parseToolArgs(tc.function?.arguments),
  }));

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

/** Request body shared by the streaming and non-streaming paths. */
function compatRequestBody(req: CompleteRequest, streaming: boolean): Record<string, unknown> {
  return {
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
    // Streaming: ask the server to send token usage in the final SSE chunk
    // (OpenAI `stream_options.include_usage`; Meta's Model API honors it).
    ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/** Parse a tool-call `arguments` JSON string; malformed JSON becomes {}. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to {}
  }
  return {};
}

interface SseChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: CompatResponse['usage'];
}

/**
 * SSE variant of the chat-completions call. Forwards each text delta to
 * `onToken` as it arrives, reassembles tool calls from their per-chunk
 * fragments (`arguments` arrives as concatenated JSON string pieces keyed
 * by `index`), and takes usage from the final chunk (when the server sends
 * it — falls back to zeros otherwise).
 */
async function openAiCompatStream(
  baseUrl: string,
  req: CompleteRequest,
  onToken: (deltaText: string) => void,
): Promise<CompleteResponse> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      'content-type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(compatRequestBody(req, true)),
    signal: req.signal,
  });

  if (!res.ok) {
    throw new Error(`OpenAI-compatible API error at ${baseUrl}: ${res.status} ${res.statusText}`.trim());
  }
  const body = res.body;
  if (!body) {
    throw new Error(`OpenAI-compatible streaming response from ${baseUrl} had no body`);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  // Tool-call fragments accumulate per `index` until the stream ends.
  const frags = new Map<number, { id: string; name: string; args: string }>();
  let stopReason = 'unknown';
  let usage: CompleteResponse['usage'] = { inputTokens: 0, outputTokens: 0 };
  // [DONE] is the terminal event per the SSE convention; anything after it
  // is ignored.
  let terminated = false;

  const handleEvent = (event: string): void => {
    if (terminated) return;
    for (const line of event.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice('data:'.length).trim();
      if (data === '[DONE]') {
        terminated = true;
        return;
      }
      let chunk: SseChunk;
      try {
        chunk = JSON.parse(data) as SseChunk;
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        onToken(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        let f = frags.get(i);
        if (!f) {
          f = { id: '', name: '', args: '' };
          frags.set(i, f);
        }
        if (tc.id) f.id = tc.id;
        if (tc.function?.name) f.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') f.args += tc.function.arguments;
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
            ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
            : {}),
        };
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (terminated) break;
    }
    if (done || terminated) break;
  }
  if (!terminated && buf.trim().length > 0) handleEvent(buf);

  const toolCalls: ToolCall[] = [...frags.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, f]) => ({ id: f.id, name: f.name, arguments: parseToolArgs(f.args) }));

  return { text, toolCalls, usage, stopReason };
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
