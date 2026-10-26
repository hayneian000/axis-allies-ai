// Isolation tests for agents/agent.ts: each Agent's prompts are built ONLY
// from its own inputs (name/persona, summarizeState(ownPlayerId), own
// history, public chat). A per-agent mock provider captures what it received.

import { describe, expect, it } from 'vitest';
import { createGame, sendMessage } from '../../engine/engine';
import { Agent, MissingApiKeyError } from '../../agents/agent';
import type {
  CompleteRequest,
  CompleteResponse,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
} from '../../agents/types';

class MockProvider implements ProviderAdapter {
  id: ProviderId = 'anthropic';
  label = 'mock';
  endpoint = 'mock://local';
  models: ModelInfo[] = [];
  received: CompleteRequest[] = [];
  constructor(private readonly marker: string) {}
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    // Snapshot at call time (real providers serialize the request immediately).
    this.received.push({ ...req, transcript: [...req.transcript], tools: [...req.tools] });
    return {
      text: this.marker,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    };
  }
}

function promptText(req: CompleteRequest): string {
  const parts = req.transcript.map((m) => m.content);
  return `${req.system}\n${parts.join('\n')}`;
}

describe('agent prompt isolation', () => {
  it('agents only see their own persona, name, and public chat', async () => {
    const state = createGame({ numPlayers: 2, seed: 1 });
    const n0 = state.players[0].name;
    const n1 = state.players[1].name;

    // One private message (player 1 only) and one broadcast.
    expect(sendMessage(state, 1, n1, 'PRIVATE-FOR-PLAYER-1-ONLY').ok).toBe(true);
    expect(sendMessage(state, 1, 'all', 'PUBLIC-BROADCAST-MARKER').ok).toBe(true);

    const mock0 = new MockProvider('REASONING-FOR-PLAYER-0-ONLY');
    const mock1 = new MockProvider('REASONING-FOR-PLAYER-1-ONLY');
    const agent0 = new Agent({
      playerId: 0,
      provider: mock0,
      model: 'mock',
      getApiKey: () => 'key-0',
      persona: 'You are the RED commander',
    });
    const agent1 = new Agent({
      playerId: 1,
      provider: mock1,
      model: 'mock',
      getApiKey: () => 'key-1',
      persona: 'You are the BLUE commander',
    });

    const res0 = await agent0.act(state, 'purchase');
    const res1 = await agent1.act(state, 'purchase');
    expect(res0.text).toBe('REASONING-FOR-PLAYER-0-ONLY');
    expect(res1.text).toBe('REASONING-FOR-PLAYER-1-ONLY');

    const text0 = promptText(mock0.received[0]);
    const text1 = promptText(mock1.received[0]);

    // Own persona present, other agent's persona absent.
    expect(text0).toContain('RED commander');
    expect(text0).not.toContain('BLUE commander');
    expect(text1).toContain('BLUE commander');
    expect(text1).not.toContain('RED commander');

    // System prompt carries summarizeState for the OWN player id (own name).
    expect(mock0.received[0].system).toContain(n0);
    expect(mock1.received[0].system).toContain(n1);

    // Public chat is shared; the private message is not.
    expect(text0).toContain('PUBLIC-BROADCAST-MARKER');
    expect(text1).toContain('PUBLIC-BROADCAST-MARKER');
    expect(text0).not.toContain('PRIVATE-FOR-PLAYER-1-ONLY');
    expect(text1).toContain('PRIVATE-FOR-PLAYER-1-ONLY');

    // Phase-appropriate tools were offered.
    expect(mock0.received[0].tools.map((t) => t.name)).toEqual(['purchase', 'repair', 'end_phase']);
  });

  it('histories are not reference-shared between agents', async () => {
    const state = createGame({ numPlayers: 2, seed: 1 });
    const mock0 = new MockProvider('m0');
    const mock1 = new MockProvider('m1');
    const agent0 = new Agent({ playerId: 0, provider: mock0, model: 'mock', getApiKey: () => 'k' });
    const agent1 = new Agent({ playerId: 1, provider: mock1, model: 'mock', getApiKey: () => 'k' });

    await agent0.act(state, 'purchase');
    await agent1.act(state, 'purchase');
    // Each transcript is just the fresh user message (only assistant turns persist).
    expect(mock0.received[0].transcript).toHaveLength(1);
    expect(mock1.received[0].transcript).toHaveLength(1);

    // Resetting agent0's history must not touch agent1's.
    agent0.resetHistory();
    await agent0.act(state, 'purchase');
    await agent1.act(state, 'purchase');
    expect(mock0.received[1].transcript).toHaveLength(1);
    expect(mock1.received[1].transcript).toHaveLength(2); // own assistant msg + new user msg
  });

  it('usage accumulates per agent and act returns the per-act delta', async () => {
    const state = createGame({ numPlayers: 2, seed: 1 });
    const mock = new MockProvider('m');
    const agent = new Agent({ playerId: 0, provider: mock, model: 'mock', getApiKey: () => 'k' });
    const r1 = await agent.act(state, 'purchase');
    const r2 = await agent.act(state, 'purchase');
    expect(r1.usage.calls).toBe(1);
    expect(r2.usage.calls).toBe(1);
    expect(agent.usage.calls).toBe(2);
    expect(agent.usage.inputTokens).toBe(20);
  });

  it('throws MissingApiKeyError when no key is available', async () => {
    const state = createGame({ numPlayers: 2, seed: 1 });
    const agent = new Agent({
      playerId: 0,
      provider: new MockProvider('m'),
      model: 'mock',
      getApiKey: () => null,
    });
    await expect(agent.act(state, 'purchase')).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});
