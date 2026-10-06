// Prompt-cache geometry: the static reference must be byte-identical on
// every call (it forms the cacheable leading prefix), deterministic, and
// free of volatile game state. The agent must pass the stable cache key and
// retention hint on every provider call.

import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/engine';
import { Agent } from '../../agents/agent';
import {
  PROMPT_CACHE_RETENTION,
  STATIC_REFERENCE,
  buildStaticReference,
  buildSystemPrompt,
  staticReferenceCacheKey,
} from '../../agents/prompts';
import { MAP, ipcOf, neighborsOf } from '../../data/data';
import { MockProvider, mockResponse, mockToolCall } from './mock';

describe('static reference', () => {
  it('is deterministic and byte-identical across builds', () => {
    expect(buildStaticReference()).toBe(STATIC_REFERENCE);
    expect(buildStaticReference()).toBe(buildStaticReference());
  });

  it('covers every territory with IPC and neighbors', () => {
    for (const t of MAP.territories) {
      expect(STATIC_REFERENCE).toContain(`${t.id} (${ipcOf(t.id)} IPC)`);
    }
    // Spot-check the neighbor graph is actually present.
    const t0 = MAP.territories[0];
    for (const n of neighborsOf(t0.id).slice(0, 3)) {
      expect(STATIC_REFERENCE).toContain(n);
    }
  });

  it('lists the unit roster with costs', () => {
    expect(STATIC_REFERENCE).toContain('infantry: 3 /');
  });

  it('carries no volatile game state', () => {
    expect(STATIC_REFERENCE).not.toMatch(/Round \d/);
    expect(STATIC_REFERENCE).not.toContain('Bank');
  });

  it('is part of every system prompt (the cacheable prefix head)', () => {
    expect(buildSystemPrompt({ playerName: 'Player 1' })).toContain(STATIC_REFERENCE);
    expect(buildSystemPrompt({ playerName: 'Player 2' })).toContain(STATIC_REFERENCE);
  });
});

describe('static reference cache key', () => {
  it('is stable across calls and shaped like aaa-static-<8hex>', () => {
    expect(staticReferenceCacheKey()).toBe(staticReferenceCacheKey());
    expect(staticReferenceCacheKey()).toMatch(/^aaa-static-[0-9a-f]{8}$/);
  });

  it('retention hint is the documented 24h value', () => {
    expect(PROMPT_CACHE_RETENTION).toBe('24h');
  });
});

describe('agent cache wiring', () => {
  it('passes the static cache key and retention on every call', async () => {
    const seen: Array<{ promptCacheKey?: string; promptCacheRetention?: string }> = [];
    const provider = new MockProvider((req) => {
      seen.push({
        promptCacheKey: req.promptCacheKey,
        promptCacheRetention: req.promptCacheRetention,
      });
      return mockResponse('ok', [mockToolCall('end_phase', {})]);
    });
    const agent = new Agent({ playerId: 0, provider, model: 'mock', getApiKey: () => 'k' });
    const state = createGame({ numPlayers: 2, seed: 7 });
    await agent.act(state, 'purchase');
    await agent.diplomacyAct(state, 2500);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.promptCacheKey).toBe(staticReferenceCacheKey());
      expect(s.promptCacheRetention).toBe('24h');
    }
  });
});
