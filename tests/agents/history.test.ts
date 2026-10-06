// The seat's private history used to grow without bound: every act()
// re-sent all previous responses and tool results, so input tokens (and
// prefill latency) grew every phase of every game. The history window keeps
// only the last N transcript turns — the current prompt already carries a
// full state snapshot, so old turns are pure overhead.

import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/engine';
import type { GameState } from '../../engine/types';
import { Agent, DEFAULT_HISTORY_WINDOW_TURNS } from '../../agents/agent';
import type { TranscriptMessage } from '../../agents/types';
import { MockProvider, mockResponse, mockToolCall } from './mock';
import type { MockHandler } from './mock';

/** Each mock turn: one assistant message with one tool call, one tool result. */
function turnHandler(log: TranscriptMessage[][]): MockHandler {
  return (req) => {
    log.push(JSON.parse(JSON.stringify(req.transcript)) as TranscriptMessage[]);
    return mockResponse('reasoning', [mockToolCall('end_phase', {})]);
  };
}

function testAgent(windowTurns: number | undefined, log: TranscriptMessage[][]): Agent {
  return new Agent({
    playerId: 0,
    provider: new MockProvider(turnHandler(log)),
    model: 'mock-model',
    getApiKey: () => 'mock-key',
    ...(windowTurns === undefined ? {} : { historyWindowTurns: windowTurns }),
  });
}

/** Drive N full turns: act() + recordToolResults, the way the driver does. */
async function driveTurns(agent: Agent, state: GameState, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const { toolCalls } = await agent.act(state, 'purchase');
    agent.recordToolResults(toolCalls.map((tc) => ({ toolCallId: tc.id, ok: true, summary: 'ok' })));
  }
}

/** Provider invariant: every assistant tool_call id has a matching tool response. */
function assertTranscriptValid(t: TranscriptMessage[]): void {
  const calls = new Set<string>();
  const responses = new Set<string>();
  for (const m of t) {
    if (m.role === 'assistant' && m.toolCalls) for (const tc of m.toolCalls) calls.add(tc.id);
    if (m.role === 'tool') responses.add(m.toolCallId);
  }
  for (const id of calls) {
    expect(responses.has(id), `tool_call ${id} has no matching tool response`).toBe(true);
  }
}

describe('history window', () => {
  it('bounds the transcript to the last N turns plus the fresh prompt', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const log: TranscriptMessage[][] = [];
    const agent = testAgent(2, log);
    await driveTurns(agent, state, 6);
    // 2 old turns x (assistant + tool result) + the new user prompt.
    const last = log[log.length - 1];
    expect(last).toHaveLength(5);
    // Still bounded after more turns — the window, not the game length,
    // decides the transcript size.
    await driveTurns(agent, state, 4);
    expect(log[log.length - 1]).toHaveLength(5);
    assertTranscriptValid(log[log.length - 1]);
  });

  it('defaults to DEFAULT_HISTORY_WINDOW_TURNS', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const log: TranscriptMessage[][] = [];
    const agent = testAgent(undefined, log);
    await driveTurns(agent, state, DEFAULT_HISTORY_WINDOW_TURNS + 3);
    expect(log[log.length - 1]).toHaveLength(DEFAULT_HISTORY_WINDOW_TURNS * 2 + 1);
    assertTranscriptValid(log[log.length - 1]);
  });

  it('window 0 restores the old unbounded behavior', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const log: TranscriptMessage[][] = [];
    const agent = testAgent(0, log);
    await driveTurns(agent, state, 6);
    // 5 completed turns x (assistant + tool result) + the new user prompt.
    expect(log[log.length - 1]).toHaveLength(11);
  });

  it('diplomacy turns share the same window', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const log: TranscriptMessage[][] = [];
    const agent = testAgent(2, log);
    for (let i = 0; i < 3; i++) {
      const { toolCalls } = await agent.act(state, 'purchase');
      agent.recordToolResults(toolCalls.map((tc) => ({ toolCallId: tc.id, ok: true, summary: 'ok' })));
    }
    for (let i = 0; i < 3; i++) {
      const { toolCalls } = await agent.diplomacyAct(state, 2500);
      agent.recordToolResults(toolCalls.map((tc) => ({ toolCallId: tc.id, ok: true, summary: 'ok' })));
    }
    const last = log[log.length - 1];
    expect(last).toHaveLength(5);
    assertTranscriptValid(last);
  });

  it('resetHistory clears the window bookkeeping', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const log: TranscriptMessage[][] = [];
    const agent = testAgent(2, log);
    await driveTurns(agent, state, 4);
    agent.resetHistory();
    await driveTurns(agent, state, 1);
    // Fresh history: just the new user prompt.
    expect(log[log.length - 1]).toHaveLength(1);
  });
});
