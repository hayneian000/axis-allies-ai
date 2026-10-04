// Headless end-to-end tests for the agent turn driver (agents/driver.ts).

import { describe, expect, it } from 'vitest';
import { createGame, endPhase } from '../../engine/engine';
import type { GameState } from '../../engine/types';
import { Agent } from '../../agents/agent';
import { MaxRoundsExceeded, runGame } from '../../agents/driver';
import type { SeatRuntime } from '../../agents/driver';
import { buildSeats, validateSeats } from '../../agents/lobby';
import type { LobbySeatInput } from '../../agents/lobby';
import type { SeatConfig } from '../../agents/types';
import { assertValidUnits } from '../helpers';
import {
  flakyHandlerFactory,
  makeGreedyHandler,
  mockResponse,
  mockToolCall,
  MockProvider,
  passBotHandler,
} from './mock';
import type { MockHandler } from './mock';

function aiSeat(playerId: number, handler: MockHandler, name = `AI ${playerId + 1}`): SeatRuntime {
  const seat: SeatConfig = {
    seatIndex: playerId,
    playerId,
    kind: 'ai',
    provider: 'anthropic',
    model: 'mock-model',
    keySlot: 'anthropic',
  };
  return {
    seat,
    agent: new Agent({
      playerId,
      provider: new MockProvider(handler),
      model: 'mock-model',
      getApiKey: () => 'mock-key',
    }),
  };
}

/** 2p game where player 0 is human (driven by onHumanTurn) and player 1 is a pass bot. */
function humanPlusPassBot(): { state: GameState; seats: SeatRuntime[] } {
  const state = createGame({ numPlayers: 2, seed: 11 });
  state.turnCap = 4;
  const seats: SeatRuntime[] = [
    { seat: { seatIndex: 0, playerId: 0, kind: 'human' } },
    aiSeat(1, passBotHandler),
  ];
  return { state, seats };
}

describe('driver: full games', () => {
  it('runs a 4-player pass-bot game to completion', async () => {
    const state = createGame({ numPlayers: 4, seed: 7 });
    state.turnCap = 6;
    const seats = [0, 1, 2, 3].map((pid) => aiSeat(pid, passBotHandler));
    const result = await runGame(state, seats);

    expect(result.state.phase).toBe('gameover');
    expect(result.state.winner).not.toBeNull();
    // Events seq integrity + unit validity at the end of a full game.
    const evts = result.state.events;
    expect(evts[evts.length - 1].seq).toBe(evts.length);
    assertValidUnits(result.state);
    // Usage recorded per player with real provider round-trips.
    for (let pid = 0; pid < 4; pid++) {
      const u = result.usage[pid];
      expect(u).toBeDefined();
      expect(u.calls).toBeGreaterThan(0);
      expect(u.inputTokens).toBeGreaterThan(0);
    }
    expect(result.rounds).toBeGreaterThan(6);
  }, 30000);

  it('runs a 2-player greedy-bot game with real battles', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 8;
    const getState = () => state;
    const seats = [0, 1].map((pid) => aiSeat(pid, makeGreedyHandler(getState, pid)));
    const result = await runGame(state, seats);

    expect(result.state.phase).toBe('gameover');
    const fought = result.state.events.some(
      (e) => e.kind === 'combat_round' || e.kind === 'battle_end',
    );
    expect(fought).toBe(true);
    assertValidUnits(result.state);
  }, 30000);

  it('retries an invalid tool call and continues the game', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 4;
    const seats = [aiSeat(0, flakyHandlerFactory()), aiSeat(1, passBotHandler)];
    const result = await runGame(state, seats);

    expect(result.state.phase).toBe('gameover');
    // The overspend purchase was rejected by engine validation and retried.
    expect(result.usage[0].errors).toBeGreaterThanOrEqual(1);
    assertValidUnits(result.state);
  }, 30000);

  it('falls back to a pass when every attempt fails', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 4;
    // Invalid only in purchase (pass everywhere else); nothing attacks, so
    // player 0 deterministically gets 4 purchase phases.
    const alwaysInvalidPurchase: MockHandler = () =>
      state.phase === 'purchase'
        ? mockResponse('bad', [mockToolCall('purchase', { items: [{ type: 'infantry', count: 9999 }] })])
        : mockResponse('pass');
    const seats = [aiSeat(0, alwaysInvalidPurchase), aiSeat(1, passBotHandler)];
    const result = await runGame(state, seats);

    expect(result.state.phase).toBe('gameover');
    // 4 purchase phases x (initial attempt + 3 retries), all rejected.
    expect(result.usage[0].errors).toBe(16);
    assertValidUnits(result.state);
  }, 30000);

  it('drives a human seat through onHumanTurn', async () => {
    const { state, seats } = humanPlusPassBot();
    const phasesSeen: string[] = [];
    const result = await runGame(state, seats, {
      // Human plays a full no-op turn each time they are up.
      onHumanTurn: async (s, pid) => {
        for (let i = 0; i < 6 && s.phase !== 'gameover' && s.currentPlayer === pid; i++) {
          const r = endPhase(s, pid);
          expect(r.ok).toBe(true);
        }
      },
      onPhase: (_s, pid, phase) => {
        phasesSeen.push(`${pid}:${phase}`);
      },
    });

    expect(result.state.phase).toBe('gameover');
    expect(phasesSeen.length).toBeGreaterThan(0);
    expect(phasesSeen[0]).toMatch(/^\d:(purchase)$/);
    assertValidUnits(result.state);
  }, 30000);

  it('throws when a human seat has no onHumanTurn', async () => {
    const { state, seats } = humanPlusPassBot();
    await expect(runGame(state, seats)).rejects.toThrow(/onHumanTurn/);
  });

  it('throws when an AI seat has no agent', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const seats: SeatRuntime[] = [
      { seat: { seatIndex: 0, playerId: 0, kind: 'ai', provider: 'anthropic', model: 'mock-model' } },
      aiSeat(1, passBotHandler),
    ];
    await expect(runGame(state, seats)).rejects.toThrow(/no agent/);
  });

  it('throws MaxRoundsExceeded when the game cannot finish in time', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    const seats = [aiSeat(0, passBotHandler), aiSeat(1, passBotHandler)];
    await expect(runGame(state, seats, {}, { maxRounds: 1 })).rejects.toThrow(MaxRoundsExceeded);
  });
});

describe('lobby', () => {
  const names = ['Alice', 'Bob'];

  it('builds seats with defaults', () => {
    const inputs: LobbySeatInput[] = [
      { kind: 'human' },
      { kind: 'ai', provider: 'openai', model: 'gpt-5.6' },
    ];
    const seats = buildSeats(inputs, names);
    expect(seats).toHaveLength(2);
    expect(seats[0]).toEqual({ seatIndex: 0, playerId: 0, kind: 'human' });
    expect(seats[1]).toEqual({
      seatIndex: 1,
      playerId: 1,
      kind: 'ai',
      provider: 'openai',
      model: 'gpt-5.6',
      keySlot: 'openai',
    });
    expect(validateSeats(seats)).toEqual([]);
  });

  it('throws on seat/player count mismatch', () => {
    expect(() => buildSeats([{ kind: 'human' }], names)).toThrow(/one seat per player/);
  });

  it('throws when an AI seat lacks provider or model', () => {
    expect(() => buildSeats([{ kind: 'ai', model: 'x' }, { kind: 'human' }], names)).toThrow(
      /needs a provider/,
    );
    expect(() => buildSeats([{ kind: 'ai', provider: 'anthropic' }, { kind: 'human' }], names)).toThrow(
      /needs a model/,
    );
  });

  it('validateSeats catches an AI seat without a model', () => {
    const bad: SeatConfig[] = [
      { seatIndex: 0, playerId: 0, kind: 'human' },
      { seatIndex: 1, playerId: 1, kind: 'ai', provider: 'anthropic' },
    ];
    const errors = validateSeats(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('model'))).toBe(true);
  });

  it('validateSeats accepts all-human tables and rejects tiny ones', () => {
    const humans: SeatConfig[] = [
      { seatIndex: 0, playerId: 0, kind: 'human' },
      { seatIndex: 1, playerId: 1, kind: 'human' },
    ];
    expect(validateSeats(humans)).toEqual([]);
    expect(validateSeats([humans[0]]).length).toBeGreaterThan(0);
  });
});
