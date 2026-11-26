// Headless end-to-end tests for the agent turn driver (agents/driver.ts).

import { describe, expect, it } from 'vitest';
import { createGame, emptyUnits, endPhase } from '../../engine/engine';
import type { Battle, GameState, Phase, UnitCounts } from '../../engine/types';
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
    // Diplomacy disabled: this test targets the phase retry path, and the
    // flaky handler's first (invalid) call would otherwise be consumed by
    // the round-1 diplomacy window.
    const result = await runGame(state, seats, {}, { diplomacy: { enabled: false } });

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
      // Human says nothing in diplomacy.
      onHumanDiplomacy: async () => {},
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

describe('driver: submerge auto-resolve', () => {
  it('auto-resolves a sea battle with eligible submarines instead of throwing submerge_pending', async () => {
    const state = createGame({ numPlayers: 2, seed: 42 });
    state.turnCap = 3;
    const pid = state.currentPlayer;
    const foe = 1 - pid;
    const setSea = (zid: string, owner: number, units: Partial<UnitCounts>): void => {
      state.territories[zid].owner = owner;
      state.territories[zid].units = { ...emptyUnits(), ...units };
    };
    // Attacker stages a cruiser + submarine one zone away; the defender
    // holds a cruiser + submarine. No destroyer on either side, so BOTH
    // sides have eligible subs and owe a submerge decision before any
    // dice (1942 2e p.29) - the sz9 shape that killed the Haiku game
    // g-20261118-007 in round 6.
    setSea('california_coast', pid, { cruiser: 1, submarine: 1 });
    setSea('western_gulf', foe, { cruiser: 1, submarine: 1 });

    // Scripted attacker: sortie into western_gulf on its first assault
    // group, pass everything else. The state check (not a latch) keeps
    // the attack live across driver retries until it actually applies.
    const attacker: MockHandler = (req) => {
      const tools = new Set(req.tools.map((t) => t.name));
      const staged =
        state.territories['california_coast'].units.submarine > 0 &&
        state.currentPlayer === pid;
      if (
        staged &&
        tools.has('combat_move') &&
        (state.phase === 'purchase' || state.phase === 'combatMove')
      ) {
        return mockResponse('sortie', [
          mockToolCall('combat_move', {
            moves: [
              {
                from: 'california_coast',
                to: 'western_gulf',
                units: { cruiser: 1, submarine: 1 },
              },
            ],
          }),
        ]);
      }
      return mockResponse('pass');
    };
    const seats: SeatRuntime[] = [];
    seats[pid] = aiSeat(pid, attacker);
    seats[foe] = aiSeat(foe, passBotHandler);

    const result = await runGame(state, seats, {}, { diplomacy: { enabled: false } });

    expect(result.state.phase).toBe('gameover');
    // The battle was fought to a finish by the driver's auto-resolver.
    expect(
      result.state.events.some(
        (e) => e.kind === 'battle_end' && e.detail.includes('western_gulf'),
      ),
    ).toBe(true);
    expect(result.state.battles.every((b) => b.over)).toBe(true);
    // The never-submerge policy recorded decisions for both sides before
    // the first dice (attacker first, then defender).
    const decisions = result.state.events.filter(
      (e) => e.kind === 'submerge' && e.detail.includes('western_gulf'),
    );
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    assertValidUnits(result.state);
  }, 30000);
});

describe('driver: stalemate auto-resolve', () => {
  it('ends an air-only attack on submarines as defender-holds instead of looping 100 rounds', async () => {
    const state = createGame({ numPlayers: 2, seed: 42 });
    state.turnCap = 3;
    const pid = state.currentPlayer;
    const foe = 1 - pid;
    const setUnits = (zid: string, owner: number, units: Partial<UnitCounts>): void => {
      state.territories[zid].owner = owner;
      state.territories[zid].units = { ...emptyUnits(), ...units };
    };
    // The sz9 shape that killed league game g-20261126-103 in round 1:
    // a lone bomber against 2 submarines. Air cannot hit subs without a
    // friendly destroyer and subs cannot hit air (1942 2e pp.28-29), so
    // neither side can ever score an effective hit.
    setUnits('texas', pid, { bomber: 1 });
    setUnits('western_gulf', foe, { submarine: 2 });

    const attacker: MockHandler = (req) => {
      const tools = new Set(req.tools.map((t) => t.name));
      const staged =
        state.territories['texas'].units.bomber > 0 && state.currentPlayer === pid;
      if (
        staged &&
        tools.has('combat_move') &&
        (state.phase === 'purchase' || state.phase === 'combatMove')
      ) {
        return mockResponse('sortie', [
          mockToolCall('combat_move', {
            moves: [{ from: 'texas', to: 'western_gulf', units: { bomber: 1 } }],
          }),
        ]);
      }
      return mockResponse('pass');
    };
    const seats: SeatRuntime[] = [];
    seats[pid] = aiSeat(pid, attacker);
    seats[foe] = aiSeat(foe, passBotHandler);

    // The engine clears state.battles at the end of non-combat movement,
    // so capture the battle via the onPhase hook at the start of the
    // attacker's non-combat phase: after auto-resolve, before the list is
    // cleared. Snapshot the fields (the engine later zeroes the attacker's
    // air in the battle record when the phase ends).
    let battle: Pick<Battle, 'over' | 'result' | 'rounds'> | undefined;
    const events = {
      onPhase: (s: GameState, _pid: number, phase: Phase): void => {
        if (phase === 'nonCombat' && !battle) {
          const b = s.battles.find((x) => x.territoryId === 'western_gulf');
          if (b) battle = { over: b.over, result: b.result, rounds: b.rounds };
        }
      },
    };
    const result = await runGame(state, seats, events, { diplomacy: { enabled: false } });

    expect(result.state.phase).toBe('gameover');
    // The battle ended after one round as defender-holds, not with the
    // 100-round throw: the defender's subs survived untouched.
    expect(battle).toBeDefined();
    expect(battle!.over).toBe(true);
    expect(battle!.result).toBe('defender_holds');
    expect(battle!.rounds).toBe(1);
    expect(result.state.territories['western_gulf'].units.submarine).toBe(2);
    expect(
      result.state.events.some(
        (e) => e.kind === 'battle_end' && e.detail.includes('western_gulf'),
      ),
    ).toBe(true);
    assertValidUnits(result.state);
  }, 30000);
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
