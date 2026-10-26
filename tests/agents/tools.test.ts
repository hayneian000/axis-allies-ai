// Tests for agents/tools.ts: schema shape, per-phase allowlists, dispatch mapping.

import { describe, expect, it } from 'vitest';
import { createGame } from '../../engine/engine';
import type { Phase } from '../../engine/types';
import { dispatchTool, TOOL_NAMES, TOOLS, toolsForPhase } from '../../agents/tools';

const EXPECTED: Record<Phase, string[]> = {
  purchase: ['purchase', 'repair', 'end_phase'],
  combatMove: ['combat_move', 'end_phase'],
  combat: ['resolve_combat_round', 'auto_casualties', 'retreat', 'end_phase'],
  nonCombat: ['non_combat_move', 'end_phase'],
  mobilize: ['mobilize', 'end_phase'],
  gameover: [],
};

describe('TOOLS definitions', () => {
  it('has all eleven canonical tool names', () => {
    expect(TOOL_NAMES.sort()).toEqual(
      [
        'purchase',
        'repair',
        'combat_move',
        'resolve_combat_round',
        'auto_casualties',
        'retreat',
        'non_combat_move',
        'mobilize',
        'end_phase',
        'send_message',
        'end_diplomacy',
      ].sort(),
    );
  });

  it('every tool has name, description, and an object parameters schema', () => {
    for (const name of TOOL_NAMES) {
      const t = TOOLS[name];
      expect(t.name).toBe(name);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.parameters as { type?: string }).type).toBe('object');
    }
  });

  it('send_message is enabled for the diplomacy window (M3)', () => {
    expect(TOOLS.send_message.description).toMatch(/diplomacy/i);
    expect(TOOLS.send_message.description).toMatch(/non-binding/i);
  });

  it('end_diplomacy is a driver-consumed tool with an empty schema', () => {
    expect(TOOLS.end_diplomacy.name).toBe('end_diplomacy');
    expect((TOOLS.end_diplomacy.parameters as { type?: string }).type).toBe('object');
    expect(TOOLS.end_diplomacy.description).toMatch(/diplomacy/i);
  });
});

describe('toolsForPhase', () => {
  for (const [phase, names] of Object.entries(EXPECTED)) {
    it(`returns exactly the allowlisted set for ${phase}`, () => {
      const got = toolsForPhase(phase as Phase).map((t) => t.name);
      expect(got).toEqual(names);
    });
  }
});

describe('dispatchTool', () => {
  it('dispatches purchase to the engine (ok:true on a fresh 2p game)', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    expect(s.phase).toBe('purchase');
    const r = dispatchTool(s, 0, 'purchase', { items: [{ type: 'infantry', count: 1 }] });
    expect(r.ok).toBe(true);
    expect(s.players[0].ipcs).toBe(9); // 12 - 3
  });

  it('dispatches end_phase to the engine', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    const r = dispatchTool(s, 0, 'end_phase', {});
    expect(r.ok).toBe(true);
    expect(s.phase).toBe('combatMove');
  });

  it('dispatches send_message plumbing to the engine', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    const r = dispatchTool(s, 0, 'send_message', { recipients: 'all', text: 'hello' });
    expect(r.ok).toBe(true);
    expect(s.chatLog).toHaveLength(1);
  });

  it('passes engine validation failures through (wrong phase)', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    const r = dispatchTool(s, 0, 'combat_move', { moves: [] });
    expect(r.ok).toBe(false);
    expect(typeof r.code).toBe('string');
  });

  it('unknown tool name -> ok:false code unknown_tool', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    const r = dispatchTool(s, 0, 'nuke_everything', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('unknown_tool');
  });

  it('malformed args -> ok:false', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    expect(dispatchTool(s, 0, 'purchase', {}).ok).toBe(false);
    expect(dispatchTool(s, 0, 'purchase', { items: 'nope' }).ok).toBe(false);
    expect(dispatchTool(s, 0, 'resolve_combat_round', {}).ok).toBe(false);
    expect(dispatchTool(s, 0, 'auto_casualties', { territory_id: 'x', side: 'sideways' }).ok).toBe(false);
    expect(dispatchTool(s, 0, 'retreat', { territory_id: 42, to_id: 'x' }).ok).toBe(false);
    expect(dispatchTool(s, 0, 'non_combat_move', { moves: null }).ok).toBe(false);
    expect(dispatchTool(s, 0, 'mobilize', { placements: [{}] }).ok).toBe(false);
    expect(dispatchTool(s, 0, 'send_message', { recipients: 'all' }).ok).toBe(false);
  });
});
