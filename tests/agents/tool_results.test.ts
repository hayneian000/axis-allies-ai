// Regression test for the tool-result history bug (caught by live e2e,
// 2026-10-04): Agent.act() persists assistant messages containing tool_calls
// in its private history, but unless the driver records the matching
// {role:'tool'} results, the next provider call sends tool_calls with no tool
// responses — and real provider APIs reject the transcript (HTTP 400).
//
// The capturing mock below enforces the exact invariant real providers
// enforce: every assistant tool_call id in an outgoing transcript must have
// a matching tool message.

import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/engine';
import type { GameState } from '../../engine/types';
import { Agent } from '../../agents/agent';
import { runGame } from '../../agents/driver';
import type { SeatRuntime } from '../../agents/driver';
import type { SeatConfig, TranscriptMessage } from '../../agents/types';
import { flakyHandlerFactory, makeGreedyHandler, MockProvider } from './mock';
import type { MockHandler } from './mock';

/** The provider-side transcript invariant: every tool_call id is answered. */
function assertTranscriptValid(transcripts: TranscriptMessage[][]): void {
  for (const t of transcripts) {
    const calls = new Set<string>();
    for (const m of t) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) calls.add(tc.id);
      }
    }
    const responses = new Set<string>();
    for (const m of t) {
      if (m.role === 'tool') responses.add(m.toolCallId);
    }
    for (const id of calls) {
      expect(responses.has(id), `tool_call ${id} has no matching tool response`).toBe(true);
    }
  }
}

/** Wrap a handler so every outgoing transcript is recorded (deep copy). */
function capturing(handler: MockHandler, log: TranscriptMessage[][]): MockHandler {
  return (req, callIndex) => {
    log.push(JSON.parse(JSON.stringify(req.transcript)) as TranscriptMessage[]);
    return handler(req, callIndex);
  };
}

function aiSeat(pid: number, handler: MockHandler, getState: () => GameState): SeatRuntime {
  const seat: SeatConfig = {
    seatIndex: pid,
    playerId: pid,
    kind: 'ai',
    provider: 'anthropic',
    model: 'mock-model',
    keySlot: 'anthropic',
  };
  return {
    seat,
    agent: new Agent({
      playerId: pid,
      provider: new MockProvider(handler),
      model: 'mock-model',
      getApiKey: () => 'mock-key',
    }),
  };
}

describe('tool result history', () => {
  it('records tool results so every transcript stays provider-valid', async () => {
    const state = createGame({ numPlayers: 2, seed: 21 });
    state.turnCap = 2;
    const getState = () => state;
    const logs: TranscriptMessage[][][] = [[], []];
    const seats = [0, 1].map((pid) =>
      aiSeat(pid, capturing(makeGreedyHandler(getState, pid), logs[pid]), getState),
    );
    await runGame(state, seats);

    // Each agent acted several times, so later transcripts contain history
    // with tool calls — exactly where the bug bit.
    expect(logs[0].length).toBeGreaterThan(1);
    expect(logs[1].length).toBeGreaterThan(1);
    assertTranscriptValid(logs[0]);
    assertTranscriptValid(logs[1]);
  });

  it('records rejections as tool results, not just successes', async () => {
    const state = createGame({ numPlayers: 2, seed: 21 });
    state.turnCap = 2;
    const getState = () => state;
    const logs: TranscriptMessage[][][] = [[], []];
    const seats = [
      aiSeat(0, capturing(flakyHandlerFactory(), logs[0]), getState),
      aiSeat(1, capturing(makeGreedyHandler(getState, 1), logs[1]), getState),
    ];
    await runGame(state, seats);

    assertTranscriptValid(logs[0]);
    // The overspend rejection must be visible to the model as a tool result.
    const sawRejection = logs[0].some((t) =>
      t.some((m) => m.role === 'tool' && m.content.includes('rejected')),
    );
    expect(sawRejection).toBe(true);
  });

  it('never leaks one seat\'s tool results into another seat\'s history', async () => {
    const state = createGame({ numPlayers: 2, seed: 21 });
    state.turnCap = 2;
    const getState = () => state;
    const logs: TranscriptMessage[][][] = [[], []];
    const seats = [0, 1].map((pid) =>
      aiSeat(pid, capturing(makeGreedyHandler(getState, pid), logs[pid]), getState),
    );
    await runGame(state, seats);

    // Collect per-seat tool_call ids from their own transcripts, then make
    // sure no tool response id appears in a transcript that never issued it.
    const issued: Set<string>[] = [new Set(), new Set()];
    logs.forEach((agentLog, pid) => {
      for (const t of agentLog) {
        for (const m of t) {
          if (m.role === 'assistant' && m.toolCalls) {
            for (const tc of m.toolCalls) issued[pid].add(tc.id);
          }
        }
      }
    });
    logs.forEach((agentLog, pid) => {
      const other = pid === 0 ? 1 : 0;
      for (const t of agentLog) {
        for (const m of t) {
          if (m.role === 'tool') {
            expect(issued[other].has(m.toolCallId)).toBe(false);
          }
        }
      }
    });
  });
});
