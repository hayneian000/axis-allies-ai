// Shared mock provider and scripted bot policies for agent e2e tests.

import { ipcOf, neighborsOf, UNITS } from '../../data/data';
import { ownsCapital } from '../../engine/engine';
import type { GameState, Phase } from '../../engine/types';
import type {
  CompleteRequest,
  CompleteResponse,
  ProviderAdapter,
  ProviderId,
  ToolCall,
} from '../../agents/types';

export type MockHandler = (req: CompleteRequest, callIndex: number) => CompleteResponse;

export class MockProvider implements ProviderAdapter {
  readonly id: ProviderId = 'anthropic';
  readonly label = 'Mock provider (tests)';
  readonly endpoint = 'mock://local';
  readonly models = [{ id: 'mock-model', label: 'Mock model', default: true }];
  private calls = 0;
  constructor(private readonly handler: MockHandler) {}
  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    return this.handler(req, this.calls++);
  }
}

let toolCallSeq = 0;

export function mockToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `mock-tc-${++toolCallSeq}`, name, arguments: args };
}

export function mockResponse(text: string, toolCalls: ToolCall[] = []): CompleteResponse {
  return { text, toolCalls, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' };
}

const endPhaseCall = (): ToolCall[] => [mockToolCall('end_phase', {})];

/** Always passes: no tool calls, so the driver just ends each phase. */
export const passBotHandler: MockHandler = () => mockResponse('pass');

/**
 * First provider call returns an invalid purchase (9999 infantry exceeds the
 * bank); every later call passes. Exercises the driver's retry path.
 */
export function flakyHandlerFactory(): MockHandler {
  return (_req, callIndex) =>
    callIndex === 0
      ? mockResponse('flaky: overspend', [
          mockToolCall('purchase', { items: [{ type: 'infantry', count: 9999 }] }),
        ])
      : mockResponse('flaky: pass');
}

/** Spends up to all IPCs on infantry, capped by estimated factory capacity. */
function greedyPurchase(state: GameState, pid: number): Array<{ type: string; count: number }> {
  const me = state.players[pid];
  if (!me.alive || !ownsCapital(state, pid)) return [];
  // Capacity comes online for every owned factory at end of purchase, so all
  // currently-held factories count. Battles later in the turn may change
  // ownership; any shortfall is forfeited by the engine at mobilize end.
  let capacity = 0;
  for (const [tid, t] of Object.entries(state.territories)) {
    if (t.owner === pid && t.factory) capacity += ipcOf(tid);
  }
  const count = Math.min(Math.floor(me.ipcs / UNITS.infantry.cost), capacity);
  return count > 0 ? [{ type: 'infantry', count }] : [];
}

/**
 * Attacks the weakest adjacent enemy/neutral territory with all land units
 * (never AA — AA guns cannot move in combat). Returns null when there is no
 * legal attack.
 */
function greedyAttack(state: GameState, pid: number): {
  from: string;
  to: string;
  units: { infantry: number; artillery: number; tank: number };
} | null {
  let best: { from: string; to: string; def: number } | null = null;
  for (const [from, t] of Object.entries(state.territories)) {
    if (t.owner !== pid) continue;
    if (t.units.infantry + t.units.artillery + t.units.tank === 0) continue;
    for (const to of neighborsOf(from)) {
      const dt = state.territories[to];
      if (!dt || dt.owner === pid) continue;
      const def =
        dt.units.infantry + dt.units.artillery + dt.units.tank + dt.units.fighter + dt.units.bomber;
      if (!best || def < best.def) best = { from, to, def };
    }
  }
  if (!best) return null;
  const t = state.territories[best.from];
  return {
    from: best.from,
    to: best.to,
    units: { infantry: t.units.infantry, artillery: t.units.artillery, tank: t.units.tank },
  };
}

/** Places all purchased infantry across usable turn-start factories. */
function greedyMobilize(
  state: GameState,
  pid: number,
): Array<{ territory: string; units: { infantry: number } }> {
  const pool = state.purchased.infantry ?? 0;
  if (pool <= 0) return [];
  let remaining = pool;
  const placements: Array<{ territory: string; units: { infantry: number } }> = [];
  for (const terr of state.turnStartFactories) {
    const t = state.territories[terr];
    if (!t || t.owner !== pid || !t.factory || t.factoryFresh) continue;
    const n = Math.min(remaining, ipcOf(terr));
    if (n > 0) {
      placements.push({ territory: terr, units: { infantry: n } });
      remaining -= n;
    }
    if (remaining <= 0) break;
  }
  return placements;
}

/**
 * A bot that plays a full legal game by itself: buys infantry, attacks the
 * weakest neighbor, auto-resolves nothing itself (the driver does that),
 * passes non-combat, and mobilizes everything it bought.
 *
 * The real Agent may call complete() several times per act(); this handler
 * tracks per-phase steps via closure state, resetting whenever the phase
 * changes.
 */
export function makeGreedyHandler(getState: () => GameState, pid: number): MockHandler {
  let lastPhase: Phase | '' = '';
  let step = 0;
  return (_req, _callIndex) => {
    const state = getState();
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      step = 0;
    }
    const s = step++;
    switch (state.phase) {
      case 'purchase': {
        if (s === 0) {
          const items = greedyPurchase(state, pid);
          return mockResponse('greedy purchase', items.length ? [mockToolCall('purchase', { items })] : []);
        }
        return mockResponse('greedy done', s === 1 ? endPhaseCall() : []);
      }
      case 'combatMove': {
        if (s === 0) {
          const attack = greedyAttack(state, pid);
          return mockResponse('greedy attack', attack ? [mockToolCall('combat_move', { moves: [attack] })] : []);
        }
        return mockResponse('greedy done', s === 1 ? endPhaseCall() : []);
      }
      case 'nonCombat':
        return mockResponse('greedy pass', s === 0 ? endPhaseCall() : []);
      case 'mobilize': {
        if (s === 0) {
          const placements = greedyMobilize(state, pid);
          return mockResponse(
            'greedy mobilize',
            placements.length ? [mockToolCall('mobilize', { placements })] : [],
          );
        }
        return mockResponse('greedy done', s === 1 ? endPhaseCall() : []);
      }
      default:
        return mockResponse('greedy pass');
    }
  };
}
