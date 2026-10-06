// Streaming (SSE) tests for the OpenAI-compatible adapter. fetch is mocked;
// no real network calls. Covers delta forwarding, tool-call fragment
// reassembly, final-chunk usage, and the Agent -> provider onToken handoff.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame } from '../../engine/engine';
import { Agent } from '../../agents/agent';
import { openAiCompatComplete } from '../../agents/providers/openai';
import type { CompleteRequest, ToolCall } from '../../agents/types';
import { MockProvider, mockResponse } from './mock';

let lastBodyText = '';

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Build a Response whose body is a ReadableStream of SSE text chunks. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

function baseReq(overrides: Partial<CompleteRequest> = {}): CompleteRequest {
  return {
    apiKey: 'test-key',
    model: 'muse-spark-1.3',
    system: 'sys',
    transcript: [{ role: 'user', content: 'hi' }],
    tools: [],
    ...overrides,
  };
}

beforeEach(() => {
  lastBodyText = '';
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    lastBodyText = typeof init?.body === 'string' ? init.body : '';
    return responder();
  }) as typeof fetch;
});

// Set per-test by assigning `responder`.
let responder: () => Response = () => sseResponse([]);

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'fetch');
  vi.restoreAllMocks();
});

describe('streaming via onToken', () => {
  it('forwards text deltas in order and assembles the full text', async () => {
    const seen: string[] = [];
    responder = () =>
      sseResponse([
        sseChunk({ choices: [{ delta: { content: 'Hello' } }] }),
        sseChunk({ choices: [{ delta: { content: ' world' } }] }),
        sseChunk({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]);
    const resp = await openAiCompatComplete(
      'https://x.test/v1',
      baseReq({ onToken: (d) => seen.push(d) }),
    );
    expect(seen).toEqual(['Hello', ' world', '!']);
    expect(resp.text).toBe('Hello world!');
    expect(resp.stopReason).toBe('stop');
    expect(resp.toolCalls).toEqual([]);
  });

  it('reassembles tool calls whose arguments arrive split across chunks', async () => {
    responder = () =>
      sseResponse([
        // arguments split mid-string across three chunks, two tool calls
        sseChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'purchase', arguments: '{"items":[' } }] } }],
        }),
        sseChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"unit":"infantry","qty":3}' } }] } }],
        }),
        sseChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ']}' } }] } }],
        }),
        sseChunk({
          choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'end_phase', arguments: '{}' } }] } }],
        }),
        sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ]);
    const resp = await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: () => {} }));
    expect(resp.toolCalls).toEqual([
      { id: 'a', name: 'purchase', arguments: { items: [{ unit: 'infantry', qty: 3 }] } },
      { id: 'b', name: 'end_phase', arguments: {} },
    ] satisfies ToolCall[]);
    expect(resp.stopReason).toBe('tool_calls');
  });

  it('takes usage (incl. cached tokens) from the final chunk', async () => {
    responder = () =>
      sseResponse([
        sseChunk({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        sseChunk({
          choices: [],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 42,
            prompt_tokens_details: { cached_tokens: 900 },
          },
        }),
        'data: [DONE]\n\n',
      ]);
    const resp = await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: () => {} }));
    expect(resp.usage).toEqual({ inputTokens: 1200, outputTokens: 42, cachedInputTokens: 900 });
  });

  it('sends stream:true with include_usage only when streaming', async () => {
    responder = () => sseResponse(['data: [DONE]\n\n']);
    await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: () => {} }));
    const streamBody = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(streamBody.stream).toBe(true);
    expect(streamBody.stream_options).toEqual({ include_usage: true });

    responder = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }]}), {
        headers: { 'content-type': 'application/json' },
      });
    await openAiCompatComplete('https://x.test/v1', baseReq());
    const plainBody = JSON.parse(lastBodyText) as Record<string, unknown>;
    expect(plainBody.stream).toBeUndefined();
    expect(plainBody.stream_options).toBeUndefined();
  });

  it('tolerates [DONE], blank lines, and malformed events', async () => {
    const seen: string[] = [];
    responder = () =>
      sseResponse([
        '\n\n',
        'data: not-json\n\n',
        sseChunk({ choices: [{ delta: { content: 'a' } }] }),
        'data:[DONE]\n\n',
        sseChunk({ choices: [{ delta: { content: 'SHOULD_NOT_HAPPEN' } }] }),
      ]);
    const resp = await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: (d) => seen.push(d) }));
    expect(seen).toEqual(['a']);
    expect(resp.text).toBe('a');
  });

  it('empty stream yields empty text, no tool calls, zero usage', async () => {
    responder = () => sseResponse(['data: [DONE]\n\n']);
    const resp = await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: () => {} }));
    expect(resp).toEqual({ text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'unknown' });
  });

  it('malformed tool-call arguments become {}', async () => {
    responder = () =>
      sseResponse([
        sseChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'z', function: { name: 'purchase', arguments: '{oops' } }] } }],
        }),
        'data: [DONE]\n\n',
      ]);
    const resp = await openAiCompatComplete('https://x.test/v1', baseReq({ onToken: () => {} }));
    expect(resp.toolCalls).toEqual([{ id: 'z', name: 'purchase', arguments: {} }]);
  });
});

describe('Agent forwards onToken to the provider', () => {
  it('act() passes the callback through; omits it when not given', async () => {
    const seen: CompleteRequest[] = [];
    const agent = new Agent({
      playerId: 0,
      provider: new MockProvider((req) => {
        seen.push(req);
        return mockResponse('ok');
      }),
      model: 'mock-model',
      getApiKey: () => 'mock-key',
    });
    const state = createGame({ numPlayers: 2, seed: 7 });
    const cb = (_d: string): void => {};
    await agent.act(state, 'purchase', cb);
    expect(seen[0].onToken).toBe(cb);
    await agent.act(state, 'purchase');
    expect(seen[1].onToken).toBeUndefined();
  });

  it('diplomacyAct() passes the callback through as well', async () => {
    const seen: CompleteRequest[] = [];
    const agent = new Agent({
      playerId: 0,
      provider: new MockProvider((req) => {
        seen.push(req);
        return mockResponse('ok');
      }),
      model: 'mock-model',
      getApiKey: () => 'mock-key',
    });
    const state = createGame({ numPlayers: 2, seed: 7 });
    const cb = (_d: string): void => {};
    await agent.diplomacyAct(state, 100, cb);
    expect(seen[0].onToken).toBe(cb);
  });
});
