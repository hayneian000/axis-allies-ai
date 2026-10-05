// M3 diplomacy tests: window mechanics, budgets, isolation, and the JSON dump.
// No live keys — all providers are scripted mocks.

import { describe, expect, it } from 'vitest';
import { createGame, sendMessage } from '../../engine/engine';
import { Agent } from '../../agents/agent';
import { MaxRoundsExceeded, runGame, type SeatRuntime } from '../../agents/driver';
import {
  buildDiplomacyDump,
  DIPLOMACY_BACKSTOP_ITERATIONS,
  DiplomacyLedger,
  isPrivateMessage,
  runDiplomacyWindow,
} from '../../agents/diplomacy';
import type { SeatConfig } from '../../agents/types';
import {
  mockResponse,
  mockToolCall,
  MockProvider,
  passBotHandler,
} from './mock';
import type { MockHandler } from './mock';

function aiSeat(pid: number, handler: MockHandler): SeatRuntime {
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

const seatConfigs = (seats: SeatRuntime[]): SeatConfig[] => seats.map((s) => s.seat);

/** Scripted talker: each diplomacy turn sends the scripted messages, then ends. */
function scriptBot(
  rounds: Array<Array<{ recipients: string; text: string }>>,
): MockHandler {
  let dipTurn = 0;
  return (req) => {
    if (!req.tools.some((t) => t.name === 'send_message')) return mockResponse('pass');
    const step = rounds[dipTurn++] ?? [];
    const calls = step.map((m) =>
      mockToolCall('send_message', { recipients: m.recipients, text: m.text }),
    );
    calls.push(mockToolCall('end_diplomacy', {}));
    return mockResponse('talking', calls);
  };
}

describe('diplomacy: budget', () => {
  it('silences a seat whose budget is exhausted', async () => {
    const state = createGame({ numPlayers: 2, seed: 101 });
    let calls = 0;
    const chatty: MockHandler = () => {
      calls++;
      return mockResponse('chatty', [
        mockToolCall('send_message', { recipients: 'all', text: `hello ${calls}` }),
      ]);
    };
    const seats = [aiSeat(0, chatty), aiSeat(1, passBotHandler)];
    const ledger = new DiplomacyLedger('test-budget');
    // Mock usage is 10 in + 5 out = 15 tokens per call; budget 30 -> 2 sends, then silent.
    await runDiplomacyWindow(state, seats, ledger, {}, { budgetPerRound: 30, backstopIterations: 100 });
    expect(calls).toBe(2);
    expect(ledger.spendFor(0, 1)).toBe(30);
    expect(ledger.messages.filter((m) => m.senderId === 0)).toHaveLength(2);
    // Budget breakout on the agent matches the ledger.
    expect(seats[0].agent!.usage.diplomacy.calls).toBe(2);
    expect(seats[0].agent!.usage.diplomacy.inputTokens).toBe(20);
  });

  it('rejected send_message calls spend no budget', async () => {
    const state = createGame({ numPlayers: 2, seed: 102 });
    const bad: MockHandler = () =>
      mockResponse('bad', [
        // 600 chars > engine MAX_CHAT_LENGTH (500) -> message_too_long.
        mockToolCall('send_message', { recipients: 'all', text: 'x'.repeat(600) }),
      ]);
    const seats = [aiSeat(0, bad), aiSeat(1, passBotHandler)];
    const ledger = new DiplomacyLedger('test-reject');
    await runDiplomacyWindow(
      state,
      seats,
      ledger,
      {},
      { budgetPerRound: 2500, backstopIterations: 5, maxStrikes: 10 },
    );
    expect(ledger.spendFor(0, 1)).toBe(0);
    expect(state.chatLog).toHaveLength(0);
    expect(seats[0].agent!.usage.diplomacy.calls).toBe(0);
    // ...but the totals still count the real provider calls that happened.
    expect(seats[0].agent!.usage.calls).toBeGreaterThan(0);
    expect(seats[0].agent!.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe('diplomacy: window mechanics', () => {
  it('backstop closes a window where nobody says done', async () => {
    const state = createGame({ numPlayers: 2, seed: 103 });
    let calls = 0;
    const chatty: MockHandler = () => {
      calls++;
      return mockResponse('still here', [
        mockToolCall('send_message', { recipients: 'all', text: 'still here' }),
      ]);
    };
    const seats = [aiSeat(0, chatty), aiSeat(1, passBotHandler)];
    const ledger = new DiplomacyLedger('test-backstop');
    await runDiplomacyWindow(
      state,
      seats,
      ledger,
      {},
      { budgetPerRound: 1e9, backstopIterations: 3 },
    );
    expect(calls).toBe(3);
    expect(ledger.messages.filter((m) => m.senderId === 0)).toHaveLength(3);
  });

  it('empty tool calls end a seat\'s participation without spending budget', async () => {
    const state = createGame({ numPlayers: 2, seed: 104 });
    const seats = [aiSeat(0, passBotHandler), aiSeat(1, passBotHandler)];
    const ledger = new DiplomacyLedger('test-quiet');
    await runDiplomacyWindow(state, seats, ledger, {}, { budgetPerRound: 2500 });
    expect(ledger.messages).toHaveLength(0);
    expect(ledger.spendFor(0, 1)).toBe(0);
    expect(ledger.spendFor(1, 1)).toBe(0);
  });

  it('isPrivateMessage detects broadcasts', () => {
    expect(isPrivateMessage('all')).toBe(false);
    expect(isPrivateMessage('All')).toBe(false);
    expect(isPrivateMessage('Player 2')).toBe(true);
    expect(isPrivateMessage('Player 2, Player 3')).toBe(true);
  });
});

describe('diplomacy: isolation', () => {
  it('a private message is invisible in other seats\' prompts', async () => {
    const state = createGame({ numPlayers: 4, seed: 105 });
    // Player 2 (pid 1) -> Player 3 (pid 2): private, seeded before the window.
    const r = sendMessage(state, 1, 'Player 3', 'SECRET_XYZ meet at dawn');
    expect(r.ok).toBe(true);

    const seen: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [] };
    const capture = (pid: number): MockHandler => (req) => {
      seen[pid].push(req.transcript.map((m) => m.content ?? '').join('\n'));
      return mockResponse('done', [mockToolCall('end_diplomacy', {})]);
    };
    const seats = [aiSeat(0, capture(0)), aiSeat(1, capture(1)), aiSeat(2, capture(2)), aiSeat(3, capture(3))];
    const ledger = new DiplomacyLedger('test-isolation');
    await runDiplomacyWindow(state, seats, ledger, {}, { budgetPerRound: 2500 });

    expect(seen[0].join('\n')).not.toContain('SECRET_XYZ');
    expect(seen[3].join('\n')).not.toContain('SECRET_XYZ');
    expect(seen[2].join('\n')).toContain('SECRET_XYZ');
  });
});

describe('diplomacy: end-to-end over two rounds', () => {
  it('two bots exchange public and private messages; dump validates', async () => {
    const state = createGame({ numPlayers: 4, seed: 106 });
    state.turnCap = 4;
    const seats = [
      aiSeat(0, scriptBot([[{ recipients: 'all', text: 'p0 public r1' }], [{ recipients: 'Player 2', text: 'p0 private r2' }]])),
      aiSeat(1, scriptBot([[{ recipients: 'all', text: 'p1 public r1' }], [{ recipients: 'Player 1', text: 'p1 private r2' }]])),
      aiSeat(2, passBotHandler),
      aiSeat(3, passBotHandler),
    ];
    const ledger = new DiplomacyLedger('test-e2e');
    let threw: unknown = null;
    try {
      await runGame(state, seats, {}, { maxRounds: 2, diplomacy: { ledger, budgetPerRound: 1000 } });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(MaxRoundsExceeded);

    // chatLog contents: 4 messages. Turn order is shuffled by seed, so
    // assert per-round sets rather than exact order.
    const log = state.chatLog;
    expect(log).toHaveLength(4);
    const byRound = (r: number) => log.filter((m) => m.round === r);
    expect(byRound(1).map((m) => m.text).sort()).toEqual(['p0 public r1', 'p1 public r1']);
    expect(byRound(2).map((m) => m.text).sort()).toEqual(['p0 private r2', 'p1 private r2']);
    expect(byRound(1).map((m) => m.recipients).sort()).toEqual(['all', 'all']);
    expect(byRound(2).map((m) => m.recipients).sort()).toEqual(['Player 1', 'Player 2']);
    // Sender/recipient pairing is correct regardless of order.
    for (const m of log) {
      if (m.text === 'p0 private r2') {
        expect(m.sender).toBe('Player 1');
        expect(m.recipients).toBe('Player 2');
      }
      if (m.text === 'p1 private r2') {
        expect(m.sender).toBe('Player 2');
        expect(m.recipients).toBe('Player 1');
      }
    }

    // Dump schema validity.
    const dump = buildDiplomacyDump({
      ledger,
      state,
      seats: seatConfigs(seats),
      playerNames: ['P1', 'P2', 'P3', 'P4'],
    });
    expect(dump.gameId).toBe('test-e2e');
    expect(dump.seed).toBe(state.seed);
    expect(dump.scenario).toBe('scenario-4p');
    expect(dump.players).toHaveLength(4);
    expect(dump.players[0]).toMatchObject({ id: 0, name: 'P1', kind: 'ai', provider: 'anthropic' });
    expect(dump.diplomacy.budgetPerRound).toBe(1000);
    expect(dump.diplomacy.backstopIterations).toBe(DIPLOMACY_BACKSTOP_ITERATIONS);
    expect(dump.diplomacy.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    const priv = dump.diplomacy.messages.find((m) => m.text === 'p0 private r2')!;
    expect(priv).toMatchObject({
      round: 2,
      sender: 'Player 1',
      recipients: 'Player 2',
      text: 'p0 private r2',
    });
    expect(priv.tokens).toBe(15);
    // Spend accounting: one 15-token call per talking turn per round.
    expect(dump.diplomacy.spend['0']).toEqual({ '1': 15, '2': 15 });
    expect(dump.diplomacy.spend['1']).toEqual({ '1': 15, '2': 15 });
    expect(dump.diplomacy.spend['2']).toBeUndefined();
    // Agent usage breakout agrees with the ledger.
    expect(seats[0].agent!.usage.diplomacy.calls).toBe(2);
  }, 30000);
});
