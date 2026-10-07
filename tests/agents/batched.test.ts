// Tests for batched AI turns (agents/driver.ts): two LLM calls per turn
// (assault = purchase+combatMove, consolidate = nonCombat+mobilize),
// affordance-based phase skipping, and scoped retries.

import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/engine';
import { emptyUnits } from '../../engine/units';
import { isSea, neighborsOf } from '../../data/data';
import type { GameState } from '../../engine/types';
import { Agent } from '../../agents/agent';
import { runGame, type SeatRuntime } from '../../agents/driver';
import { phaseHasActions } from '../../agents/affordance';
import type { SeatConfig, TranscriptMessage } from '../../agents/types';
import { mockResponse, mockToolCall, MockProvider } from './mock';
import type { MockHandler } from './mock';

function aiSeat(playerId: number, handler: MockHandler): SeatRuntime {
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

/** A legal land attack for pid, computed from live state (or null). */
function findAttack(state: GameState, pid: number): { from: string; to: string } | null {
  for (const [tid, t] of Object.entries(state.territories)) {
    if (t.owner !== pid || isSea(tid)) continue;
    if (t.units.infantry + t.units.artillery + t.units.tank === 0) continue;
    for (const n of neighborsOf(tid)) {
      const dt = state.territories[n];
      if (dt && !isSea(n) && dt.owner !== pid) return { from: tid, to: n };
    }
  }
  return null;
}

/** Player 0 stripped to a single AA gun in their capital, enemies all around. */
function riggedIdleState(): GameState {
  const state = createGame({ numPlayers: 2, seed: 7 });
  for (const t of Object.values(state.territories)) {
    if (t.owner === 0) t.units = emptyUnits();
  }
  const cap = state.players[0].capital;
  state.territories[cap].units.aa = 1;
  for (const n of neighborsOf(cap)) {
    if (state.territories[n] && !isSea(n)) state.territories[n].owner = 1;
  }
  state.players[0].ipcs = 0;
  return state;
}

describe('batched turns: group partitioning', () => {
  it('applies a scrambled multi-phase batch in canonical phase order', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 1;
    const getState = () => state;
    const seenTools: string[][] = [];
    // Emits combat_move BEFORE purchase (scrambled) plus end_phase, and a
    // mobilize in group B. If the driver applied in emission order, the
    // combat_move would be dispatched during the purchase phase and rejected.
    const handler: MockHandler = (req) => {
      seenTools.push(req.tools.map((t) => t.name));
      const tools = new Set(req.tools.map((t) => t.name));
      const calls = [];
      if (tools.has('purchase')) {
        const atk = findAttack(getState(), 0);
        expect(atk).not.toBeNull();
        calls.push(
          mockToolCall('combat_move', {
            moves: [{ from: atk!.from, to: atk!.to, units: { infantry: 1 } }],
          }),
        );
        calls.push(mockToolCall('purchase', { items: [{ type: 'infantry', count: 2 }] }));
        calls.push(mockToolCall('end_phase', {}));
      } else if (tools.has('mobilize')) {
        const cap = getState().players[0].capital;
        calls.push(
          mockToolCall('mobilize', { placements: [{ territory: cap, units: { infantry: 2 } }] }),
        );
      }
      return mockResponse('scrambled', calls);
    };
    const seats = [aiSeat(0, handler), aiSeat(1, () => mockResponse('pass'))];
    const toolEvents: Array<{ name: string; ok: boolean }> = [];
    const result = await runGame(
      state,
      seats,
      { onToolCall: (_pid, name, ok) => toolEvents.push({ name, ok }) },
      { diplomacy: { enabled: false } },
    );

    expect(result.state.phase).toBe('gameover');
    // No rejections: canonical order held (purchase in purchase phase, ...).
    expect(toolEvents.filter((e) => !e.ok)).toEqual([]);
    expect(toolEvents.map((e) => e.name)).toEqual([
      'purchase',
      'combat_move',
      'mobilize',
    ]);
    // Both phases' effects landed (engine event log).
    expect(state.events.some((e) => e.kind === 'purchase')).toBe(true);
    expect(state.events.some((e) => e.kind === 'mobilize')).toBe(true);
    // A battle was opened and auto-resolved.
    const fought = state.events.some((e) => e.kind === 'combat_round' || e.kind === 'battle_end');
    expect(fought).toBe(true);
    // Group A exposed purchase+combat_move together; group B non_combat+mobilize.
    expect(seenTools[0]).toEqual(expect.arrayContaining(['purchase', 'combat_move', 'end_phase']));
    expect(seenTools[1]).toEqual(
      expect.arrayContaining(['non_combat_move', 'mobilize', 'end_phase']),
    );
  });

  it('runs a no-drama AI turn in exactly 2 provider calls', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 1;
    const getState = () => state;
    const roundOneCalls: Record<number, number> = { 0: 0, 1: 0 };
    const mkHandler = (pid: number): MockHandler => (req) => {
      const s = getState();
      if (s.round === 1 && s.currentPlayer === pid) roundOneCalls[pid]++;
      const tools = new Set(req.tools.map((t) => t.name));
      const calls = [];
      if (tools.has('purchase')) {
        calls.push(mockToolCall('purchase', { items: [{ type: 'infantry', count: 1 }] }));
        const atk = findAttack(s, pid);
        if (atk) {
          calls.push(
            mockToolCall('combat_move', {
              moves: [{ from: atk.from, to: atk.to, units: { infantry: 1 } }],
            }),
          );
        }
      } else if (tools.has('mobilize')) {
        const cap = s.players[pid].capital;
        calls.push(
          mockToolCall('mobilize', { placements: [{ territory: cap, units: { infantry: 1 } }] }),
        );
      }
      return mockResponse('ok', calls);
    };
    const seats = [aiSeat(0, mkHandler(0)), aiSeat(1, mkHandler(1))];
    const result = await runGame(state, seats, {}, { diplomacy: { enabled: false } });
    expect(result.state.phase).toBe('gameover');
    expect(roundOneCalls[0]).toBe(2);
    expect(roundOneCalls[1]).toBe(2);
  });
});

describe('affordance: skip logic', () => {
  it('purchase: skips when broke or capital lost; live otherwise', () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    expect(phaseHasActions(state, 0, 'purchase').has).toBe(true);
    state.players[0].ipcs = 0;
    expect(phaseHasActions(state, 0, 'purchase').has).toBe(false);
    state.players[0].ipcs = 12;
    state.territories[state.players[0].capital].owner = 1;
    expect(phaseHasActions(state, 0, 'purchase').has).toBe(false);
  });

  it('combatMove: skips for AA-only forces; live when an attack exists', () => {
    const state = riggedIdleState();
    // Single AA gun, enemies adjacent: AA can never attack.
    expect(phaseHasActions(state, 0, 'combatMove').has).toBe(false);
    // Add an infantryman: now there is a reachable hostile territory.
    state.territories[state.players[0].capital].units.infantry = 1;
    expect(phaseHasActions(state, 0, 'combatMove').has).toBe(true);
  });

  it('combatMove: live in a fresh game (neutrals in reach)', () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    expect(phaseHasActions(state, 0, 'combatMove').has).toBe(true);
  });

  it('nonCombat: skips when nothing can move; live with a destination or air', () => {
    const state = riggedIdleState();
    // AA gun with only enemy neighbors: no friendly destination.
    expect(phaseHasActions(state, 0, 'nonCombat').has).toBe(false);
    // A friendly neighbor gives the AA gun somewhere to go.
    const cap = state.players[0].capital;
    const friend = neighborsOf(cap).find((n) => state.territories[n] && !isSea(n))!;
    state.territories[friend].owner = 0;
    expect(phaseHasActions(state, 0, 'nonCombat').has).toBe(true);
  });

  it('mobilize: skips with an empty purchase pool; live after buying', () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    expect(phaseHasActions(state, 0, 'mobilize').has).toBe(false);
    state.purchased = { infantry: 2 };
    expect(phaseHasActions(state, 0, 'mobilize').has).toBe(true);
  });

  it('makes zero provider calls for a turn with nothing to do', async () => {
    const state = riggedIdleState();
    state.turnCap = 1;
    let calls = 0;
    const counting: MockHandler = () => {
      calls++;
      return mockResponse('idle');
    };
    const skips: Array<{ pid: number; phase: string; reason: string }> = [];
    const seats = [aiSeat(0, counting), aiSeat(1, () => mockResponse('pass'))];
    const result = await runGame(
      state,
      seats,
      { onPhaseSkipped: (_s, pid, phase, reason) => skips.push({ pid, phase, reason }) },
      { diplomacy: { enabled: false } },
    );
    expect(result.state.phase).toBe('gameover');
    expect(calls).toBe(0);
    expect(result.usage[0].calls).toBe(0);
    expect(
      skips
        .filter((s) => s.pid === 0)
        .map((s) => s.phase)
        .sort(),
    ).toEqual(['combatMove', 'mobilize', 'nonCombat', 'purchase'].sort());
    for (const s of skips) expect(s.reason.length).toBeGreaterThan(0);
  });
});

describe('batched turns: scoped retries', () => {
  it('keeps the valid prefix applied and re-plans from the failed phase with error feedback', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 1;
    const transcripts: TranscriptMessage[][] = [];
    const retryTools: string[][] = [];
    const toolEvents: Array<{ name: string; ok: boolean; code?: string }> = [];
    // First group-A call: one valid purchase then an overspend (rejected).
    // The retry re-plans purchase+combatMove (remaining phases of group A).
    // Later group-B calls pass (no purchase tool live there).
    const handler: MockHandler = (req, callIndex) => {
      transcripts.push(JSON.parse(JSON.stringify(req.transcript)));
      retryTools.push(req.tools.map((t) => t.name));
      if (!req.tools.some((t) => t.name === 'purchase')) return mockResponse('pass');
      if (callIndex === 0) {
        return mockResponse('batch', [
          mockToolCall('purchase', { items: [{ type: 'infantry', count: 1 }] }),
          mockToolCall('purchase', { items: [{ type: 'infantry', count: 9999 }] }),
        ]);
      }
      return mockResponse('retry', [
        mockToolCall('purchase', { items: [{ type: 'infantry', count: 1 }] }),
      ]);
    };
    const seats = [aiSeat(0, handler), aiSeat(1, () => mockResponse('pass'))];
    const result = await runGame(
      state,
      seats,
      { onToolCall: (pid, name, ok, code) => toolEvents.push({ name, ok, code }) },
      { diplomacy: { enabled: false } },
    );
    expect(result.state.phase).toBe('gameover');

    // Exactly one rejection; the valid prefix was applied once, not rolled
    // back and not double-applied (purchase, purchase-fail, purchase).
    expect(toolEvents.filter((e) => e.name === 'purchase').map((e) => e.ok)).toEqual([
      true,
      false,
      true,
    ]);
    expect(result.usage[0].errors).toBe(1);

    // The retry prompt carries the engine's rejection as feedback...
    const retryTranscript = transcripts[1];
    const sawRejection = retryTranscript.some(
      (m) => m.role === 'tool' && m.content.includes('rejected') && m.content.includes('[funds]'),
    );
    expect(sawRejection).toBe(true);
    // ...and re-plans only the failed group's remaining phases
    // (purchase+combatMove), not group B.
    expect(retryTools[1]).toEqual(expect.arrayContaining(['purchase', 'combat_move']));
    expect(retryTools[1]).not.toContain('mobilize');
    expect(retryTools[1]).not.toContain('non_combat_move');
  });

  it('rejects tools outside the live phases and re-plans the group', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 1;
    const transcripts: TranscriptMessage[][] = [];
    const handler: MockHandler = (req, callIndex) => {
      transcripts.push(JSON.parse(JSON.stringify(req.transcript)));
      if (callIndex === 0) {
        // resolve_combat_round is not live in the assault group.
        return mockResponse('bad', [mockToolCall('resolve_combat_round', { territory_id: 'x' })]);
      }
      return mockResponse('fixed', []);
    };
    const seats = [aiSeat(0, handler), aiSeat(1, () => mockResponse('pass'))];
    const result = await runGame(state, seats, {}, { diplomacy: { enabled: false } });
    expect(result.state.phase).toBe('gameover');
    expect(result.usage[0].errors).toBe(1);
    const sawFeedback = transcripts[1].some(
      (m) => m.role === 'tool' && m.content.includes('not available in this batched turn'),
    );
    expect(sawFeedback).toBe(true);
  });

  it('falls back to the no-op after exhausted retries, keeping later phases working', async () => {
    const state = createGame({ numPlayers: 2, seed: 7 });
    state.turnCap = 1;
    const getState = () => state;
    // Purchase always invalid; combat_move always valid. After 4 failed
    // purchase attempts the fallback (buy nothing) runs and the already-
    // planned combat move still executes.
    const handler: MockHandler = (req) => {
      const tools = new Set(req.tools.map((t) => t.name));
      if (!tools.has('purchase')) return mockResponse('pass');
      const atk = findAttack(getState(), 0);
      const calls = [mockToolCall('purchase', { items: [{ type: 'infantry', count: 9999 }] })];
      if (atk) {
        calls.push(
          mockToolCall('combat_move', {
            moves: [{ from: atk.from, to: atk.to, units: { infantry: 1 } }],
          }),
        );
      }
      return mockResponse('bad-purchase', calls);
    };
    const seats = [aiSeat(0, handler), aiSeat(1, () => mockResponse('pass'))];
    const result = await runGame(state, seats, {}, { diplomacy: { enabled: false } });
    expect(result.state.phase).toBe('gameover');
    // Initial attempt + 3 retries, all rejected, then fallback.
    expect(result.usage[0].errors).toBe(4);
    // The combat move from the original plan still executed: a battle happened.
    const fought = state.events.some((e) => e.kind === 'combat_round' || e.kind === 'battle_end');
    expect(fought).toBe(true);
    // Nothing was ever purchased.
    expect(state.players[0].ipcs).toBeGreaterThanOrEqual(12);
  });
});
