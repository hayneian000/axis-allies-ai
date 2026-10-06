// Provider adapter wire-format + parsing tests. fetch is mocked; no real network calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompleteRequest } from '../../agents/types';
import { anthropicAdapter } from '../../agents/providers/anthropic';
import { openaiAdapter } from '../../agents/providers/openai';
import { metaAdapter } from '../../agents/providers/meta';
import { PROVIDERS, defaultModel, getProvider, listModels } from '../../agents/providers/index';

const API_KEY = 'sk-test-key-123';

let lastUrl = '';
let lastHeaders: Record<string, string> = {};
let lastBodyText = '';
let responder: () => Promise<Response>;

function jsonResponse(payload: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function makeRequest(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    apiKey: API_KEY,
    model: 'model-under-test',
    system: 'You are a strategy game agent.',
    transcript: [
      { role: 'user', content: 'Your move.' },
      {
        role: 'assistant',
        content: 'Let me buy units.',
        toolCalls: [{ id: 'tc_1', name: 'purchase', arguments: { items: [{ type: 'infantry', count: 3 }] } }],
      },
      { role: 'tool', toolCallId: 'tc_1', content: '{"ok":true}' },
    ],
    tools: [
      {
        name: 'purchase',
        description: 'Buy units during the purchase phase.',
        parameters: { type: 'object', properties: { items: { type: 'array' } } },
      },
    ],
    maxTokens: 512,
    ...overrides,
  };
}

beforeEach(() => {
  lastUrl = '';
  lastHeaders = {};
  lastBodyText = '';
  responder = () => jsonResponse({});
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    lastUrl = String(input);
    lastHeaders = { ...(init?.headers as Record<string, string> | undefined) };
    lastBodyText = typeof init?.body === 'string' ? init.body : '';
    return responder();
  }) as typeof fetch;
});

afterEach(() => {
  // fetch is not a saved binding here (tests run before any restore target exists),
  // so just delete the override and let the runtime global come back.
  Reflect.deleteProperty(globalThis, 'fetch');
});

function expectKeyOnlyInAuthHeader(): void {
  expect(lastUrl).not.toContain(API_KEY);
  expect(lastBodyText).not.toContain(API_KEY);
}

describe('anthropic adapter', () => {
  const canned = {
    content: [
      { type: 'text', text: 'Buying infantry.' },
      { type: 'tool_use', id: 'tu_9', name: 'purchase', input: { items: [] } },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'tool_use',
  };

  it('sends the right URL, headers, and body shape', async () => {
    responder = () => jsonResponse(canned);
    await anthropicAdapter.complete(makeRequest());

    expect(lastUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(lastHeaders['x-api-key']).toBe(API_KEY);
    expect(lastHeaders['anthropic-version']).toBe('2023-06-01');
    expect(lastHeaders['anthropic-dangerous-direct-browser-access']).toBe('true');

    const body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body['model']).toBe('model-under-test');
    expect(body['max_tokens']).toBe(512);
    expect(body['system']).toBe('You are a strategy game agent.');
    expect(body).not.toHaveProperty('temperature');

    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]['name']).toBe('purchase');
    expect(tools[0]['input_schema']).toEqual({ type: 'object', properties: { items: { type: 'array' } } });

    const messages = body['messages'] as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    // user message stays plain text
    expect(messages[0]).toEqual({ role: 'user', content: 'Your move.' });
    // assistant with tool calls -> text + tool_use blocks
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me buy units.' },
        {
          type: 'tool_use',
          id: 'tc_1',
          name: 'purchase',
          input: { items: [{ type: 'infantry', count: 3 }] },
        },
      ],
    });
    // tool result -> user message with tool_result block
    expect(messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc_1', content: '{"ok":true}' }],
    });
  });

  it('parses text, tool calls, usage, and stop reason', async () => {
    responder = () => jsonResponse(canned);
    const res = await anthropicAdapter.complete(makeRequest());

    expect(res.text).toBe('Buying infantry.');
    expect(res.toolCalls).toEqual([{ id: 'tu_9', name: 'purchase', arguments: { items: [] } }]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(res.stopReason).toBe('tool_use');
  });

  it('throws an error mentioning the status on non-2xx', async () => {
    responder = () => jsonResponse({ type: 'error', error: { message: 'bad key' } }, 401);
    await expect(anthropicAdapter.complete(makeRequest())).rejects.toThrow(/401/);
  });

  it('keeps the API key out of the URL and body', async () => {
    responder = () => jsonResponse(canned);
    await anthropicAdapter.complete(makeRequest());
    expectKeyOnlyInAuthHeader();
  });
});

describe('openai adapter', () => {
  const canned = {
    choices: [
      {
        message: {
          content: 'Done.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'purchase', arguments: '{"items":[]}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 7 },
  };

  it('sends the right URL, bearer auth, and body shape', async () => {
    responder = () => jsonResponse(canned);
    await openaiAdapter.complete(makeRequest());

    expect(lastUrl).toBe('https://api.openai.com/v1/chat/completions');
    expect(lastHeaders['Authorization']).toBe(`Bearer ${API_KEY}`);

    const body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body['model']).toBe('model-under-test');
    expect(body['tool_choice']).toBe('auto');

    const tools = body['tools'] as Array<{ type: string; function: Record<string, unknown> }>;
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe('function');
    expect(tools[0].function['name']).toBe('purchase');
    expect(tools[0].function['description']).toBe('Buy units during the purchase phase.');
    expect(tools[0].function['parameters']).toEqual({
      type: 'object',
      properties: { items: { type: 'array' } },
    });

    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a strategy game agent.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Your move.' });
    // assistant with tool calls -> assistant message with stringified args
    const assistant = messages[2];
    expect(assistant['role']).toBe('assistant');
    const toolCalls = assistant['tool_calls'] as Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('tc_1');
    expect(toolCalls[0].type).toBe('function');
    expect(toolCalls[0].function.name).toBe('purchase');
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
      items: [{ type: 'infantry', count: 3 }],
    });
    // tool result message
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'tc_1', content: '{"ok":true}' });
  });

  it('caps output tokens via max_completion_tokens (default 2048)', async () => {
    responder = () => jsonResponse(canned);
    await openaiAdapter.complete(makeRequest({ maxTokens: undefined }));
    const body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(2048);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('honors an explicit maxTokens override', async () => {
    responder = () => jsonResponse(canned);
    await openaiAdapter.complete(makeRequest({ maxTokens: 500 }));
    const body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body['max_completion_tokens']).toBe(500);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('sends prompt_cache_key/retention when provided, omits when absent', async () => {
    responder = () => jsonResponse(canned);
    await openaiAdapter.complete(makeRequest({ maxTokens: undefined }));
    let body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('prompt_cache_retention');

    await openaiAdapter.complete(
      makeRequest({
        maxTokens: undefined,
        promptCacheKey: 'aaa-static-deadbeef',
        promptCacheRetention: '24h',
      }),
    );
    body = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(body['prompt_cache_key']).toBe('aaa-static-deadbeef');
    expect(body['prompt_cache_retention']).toBe('24h');
  });

  it('parses cached_tokens into usage.cachedInputTokens', async () => {
    responder = () =>
      jsonResponse({
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      });
    const res = await openaiAdapter.complete(makeRequest({ maxTokens: undefined }));
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 7, cachedInputTokens: 80 });
  });

  it('leaves cachedInputTokens undefined when the provider does not report it', async () => {
    responder = () => jsonResponse(canned);
    const res = await openaiAdapter.complete(makeRequest({ maxTokens: undefined }));
    expect(res.usage.cachedInputTokens).toBeUndefined();
  });

  it('parses content, tool calls, usage, and finish reason', async () => {
    responder = () => jsonResponse(canned);
    const res = await openaiAdapter.complete(makeRequest());

    expect(res.text).toBe('Done.');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'purchase', arguments: { items: [] } }]);
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 7 });
    expect(res.stopReason).toBe('tool_calls');
  });

  it('falls back to {} on malformed tool-call arguments JSON', async () => {
    responder = () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_2', type: 'function', function: { name: 'end_phase', arguments: 'not-json{{' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    const res = await openaiAdapter.complete(makeRequest());
    expect(res.toolCalls).toEqual([{ id: 'call_2', name: 'end_phase', arguments: {} }]);
  });

  it('throws an error mentioning the status on non-2xx', async () => {
    responder = () => jsonResponse({ error: { message: 'rate limited' } }, 429);
    await expect(openaiAdapter.complete(makeRequest())).rejects.toThrow(/429/);
  });

  it('keeps the API key out of the URL and body', async () => {
    responder = () => jsonResponse(canned);
    await openaiAdapter.complete(makeRequest());
    expectKeyOnlyInAuthHeader();
  });
});

describe('meta adapter', () => {
  const canned = {
    choices: [
      {
        message: {
          content: 'Meta response.',
          tool_calls: [
            { id: 'call_9', type: 'function', function: { name: 'mobilize', arguments: '{"placements":[]}' } },
          ],
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 9 },
  };

  it('hits the OpenAI-compatible endpoint with bearer auth and OpenAI body shape', async () => {
    responder = () => jsonResponse(canned);
    const res = await metaAdapter.complete(makeRequest());

    expect(lastUrl).toBe('https://api.meta.ai/v1/chat/completions');
    expect(lastHeaders['Authorization']).toBe(`Bearer ${API_KEY}`);

    const body = JSON.parse(lastBodyText) as Record<string, unknown>;
    const tools = body['tools'] as Array<{ type: string }>;
    expect(tools[0].type).toBe('function');
    expect(body['tool_choice']).toBe('auto');

    expect(res.text).toBe('Meta response.');
    expect(res.toolCalls).toEqual([{ id: 'call_9', name: 'mobilize', arguments: { placements: [] } }]);
    expect(res.usage).toEqual({ inputTokens: 30, outputTokens: 9 });
    expect(res.stopReason).toBe('stop');
  });

  it('throws an error mentioning the status on non-2xx', async () => {
    responder = () => jsonResponse({ error: { message: 'bad key' } }, 401);
    await expect(metaAdapter.complete(makeRequest())).rejects.toThrow(/401/);
  });

  it('keeps the API key out of the URL and body', async () => {
    responder = () => jsonResponse(canned);
    await metaAdapter.complete(makeRequest());
    expectKeyOnlyInAuthHeader();
  });
});

describe('provider registry', () => {
  it('registers all three adapters', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['anthropic', 'meta', 'openai']);
    expect(getProvider('anthropic')).toBe(anthropicAdapter);
    expect(getProvider('openai')).toBe(openaiAdapter);
    expect(getProvider('meta')).toBe(metaAdapter);
  });

  it('resolves the curated defaults', () => {
    expect(defaultModel('anthropic')).toBe('claude-sonnet-5');
    expect(defaultModel('openai')).toBe('gpt-5.6');
    expect(defaultModel('meta')).toBe('muse-spark-1.3');
  });

  it('lists curated models', () => {
    expect(listModels('anthropic').map((m) => m.id)).toContain('claude-opus-5');
    expect(listModels('openai').map((m) => m.id)).toContain('gpt-4.1');
    expect(listModels('meta').map((m) => m.id)).toContain('muse-spark-1.2');
  });

  it('throws on unknown provider ids', () => {
    expect(() => getProvider('nope' as never)).toThrow(/Unknown provider/);
  });
});
