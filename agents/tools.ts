// JSON-Schema tool definitions for the Phase 2 BYOK agent tools, mapping
// each canonical snake_case tool name to the real engine action.
// Agent-initiated chat (send_message from an agent) is disabled in the MVP:
// the driver owns diplomacy in v1.

import {
  autoCasualties,
  combatMove,
  endPhase,
  mobilize,
  nonCombatMove,
  purchase,
  resolveCombatRound,
  retreat,
  sendMessage,
} from '../engine/engine';
import type {
  ActionResult,
  CombatMove,
  GameState,
  MobilizePlacement,
  NonCombatMove,
  Phase,
  PurchaseItem,
} from '../engine/types';
import type { ToolDefinition } from './types';

const UNIT_TYPES = ['infantry', 'artillery', 'tank', 'fighter', 'bomber', 'aa'] as const;

/** JSON Schema fragment for a unit-count object. `aa` is excluded from
 *  casualty schemas (the engine never takes AA as a casualty). */
function unitCountsSchema(includeAa: boolean): Record<string, unknown> {
  const names = includeAa ? UNIT_TYPES : UNIT_TYPES.filter((t) => t !== 'aa');
  const properties: Record<string, unknown> = {};
  for (const n of names) properties[n] = { type: 'integer', minimum: 0 };
  return { type: 'object', properties, additionalProperties: false };
}

export const TOOLS: Record<string, ToolDefinition> = {
  purchase: {
    name: 'purchase',
    description:
      'Spend IPCs from your bank on new units (bought now, placed during the mobilize phase). ' +
      'Costs: infantry 3, artillery 4, tank 6, fighter 10, bomber 12, AA 5, factory 15 IPCs. ' +
      'You may also buy nothing this turn.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Units to purchase. Empty array = buy nothing.',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['infantry', 'artillery', 'tank', 'fighter', 'bomber', 'aa', 'factory'],
              },
              count: { type: 'integer', minimum: 1 },
            },
            required: ['type', 'count'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },

  combat_move: {
    name: 'combat_move',
    description:
      'Move units into hostile or neutral territories to start battles (and blitz through ' +
      'empty enemy territories with tanks). Each move: from/to territory, units to send. ' +
      'Tanks may pass through one extra territory via `via`. Bombers may instead run a ' +
      'strategic bombing raid on a factory territory with `sbr: true` (AA fires first, 1d6 IPC damage).',
    parameters: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              units: unitCountsSchema(true),
              via: { type: 'array', items: { type: 'string' } },
              sbr: { type: 'boolean' },
            },
            required: ['from', 'to', 'units'],
            additionalProperties: false,
          },
        },
      },
      required: ['moves'],
      additionalProperties: false,
    },
  },

  resolve_combat_round: {
    name: 'resolve_combat_round',
    description:
      'Roll one round of combat for an open battle you are attacking in the given territory ' +
      '(AA fires once before the first round; then attacker and defender exchange fire ' +
      'simultaneously per unit hit profiles). If casualties result, resolve them with ' +
      'auto_casualties before rolling again.',
    parameters: {
      type: 'object',
      properties: {
        territory_id: { type: 'string' },
      },
      required: ['territory_id'],
      additionalProperties: false,
    },
  },

  auto_casualties: {
    name: 'auto_casualties',
    description:
      'Automatically apply pending casualties for one side of an open battle using the ' +
      'standard cheapest-first policy (AA guns are never taken as casualties). ' +
      'Call this for both attacker and defender sides when each has pending losses.',
    parameters: {
      type: 'object',
      properties: {
        territory_id: { type: 'string' },
        side: { type: 'string', enum: ['attacker', 'defender'] },
      },
      required: ['territory_id', 'side'],
      additionalProperties: false,
    },
  },

  retreat: {
    name: 'retreat',
    description:
      'Retreat your surviving land attackers from an open battle back to a territory they ' +
      'attacked from this turn (to_id must be one of the battle origins and still yours). ' +
      'Requires at least one combat round fought and no pending casualties. ' +
      'Bombing raids cannot retreat.',
    parameters: {
      type: 'object',
      properties: {
        territory_id: { type: 'string' },
        to_id: { type: 'string' },
      },
      required: ['territory_id', 'to_id'],
      additionalProperties: false,
    },
  },

  non_combat_move: {
    name: 'non_combat_move',
    description:
      'Move units between friendly territories after combat (no battles result). ' +
      'Air units must land in a friendly territory within range. This is the ONLY phase ' +
      'in which AA guns may move.',
    parameters: {
      type: 'object',
      properties: {
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              units: unitCountsSchema(true),
            },
            required: ['from', 'to', 'units'],
            additionalProperties: false,
          },
        },
      },
      required: ['moves'],
      additionalProperties: false,
    },
  },

  mobilize: {
    name: 'mobilize',
    description:
      'Place units purchased this turn at your factories (capacity per factory = its ' +
      'territory IPC value; factories built or captured this turn produce from next turn). ' +
      'Optionally build a purchased factory in an owned territory with IPC 2+ and no factory.',
    parameters: {
      type: 'object',
      properties: {
        placements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              territory: { type: 'string' },
              units: unitCountsSchema(true),
              build_factory: { type: 'boolean' },
            },
            required: ['territory', 'units'],
            additionalProperties: false,
          },
        },
      },
      required: ['placements'],
      additionalProperties: false,
    },
  },

  end_phase: {
    name: 'end_phase',
    description:
      'End the current phase and advance the game. Call this when you have no more useful ' +
      'actions in the current phase (e.g. no purchases, no attacks, combat fully resolved, ' +
      'no moves, nothing to place). After mobilize, income is collected and the next ' +
      "player's turn begins.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },

  send_message: {
    name: 'send_message',
    description:
      'NOTE: agent-initiated chat is DISABLED in the MVP (v2). The tool exists for ' +
      'schema/driver completeness only; the driver does not expose it to agents, ' +
      'so do not plan around sending messages. Sends text to "all" or named recipients.',
    parameters: {
      type: 'object',
      properties: {
        recipients: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['recipients', 'text'],
      additionalProperties: false,
    },
  },
};

/** All canonical tool names. */
export const TOOL_NAMES = Object.keys(TOOLS);

/** Tool allowlist per phase (the driver enforces this). */
export function toolsForPhase(phase: Phase): ToolDefinition[] {
  const pick = (names: string[]): ToolDefinition[] => names.map((n) => TOOLS[n]);
  switch (phase) {
    case 'purchase':
      return pick(['purchase', 'end_phase']);
    case 'combatMove':
      return pick(['combat_move', 'end_phase']);
    case 'combat':
      return pick(['resolve_combat_round', 'auto_casualties', 'retreat', 'end_phase']);
    case 'nonCombat':
      return pick(['non_combat_move', 'end_phase']);
    case 'mobilize':
      return pick(['mobilize', 'end_phase']);
    case 'gameover':
      return [];
  }
}

function badArgs(detail: string): ActionResult {
  return { ok: false, code: 'bad_args', error: `Malformed tool arguments: ${detail}` };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function coercePurchaseItems(v: unknown): PurchaseItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: PurchaseItem[] = [];
  for (const it of v) {
    if (!isRecord(it) || !isStr(it.type) || typeof it.count !== 'number') return null;
    out.push({ type: it.type as PurchaseItem['type'], count: it.count });
  }
  return out;
}

function coerceMoves<T extends { from: string; to: string; units: Record<string, unknown> }>(
  v: unknown,
  extra: (rec: Record<string, unknown>) => T,
): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const m of v) {
    if (!isRecord(m) || !isStr(m.from) || !isStr(m.to) || !isRecord(m.units)) return null;
    out.push(extra(m));
  }
  return out;
}

/**
 * Map a parsed tool call to the real engine action. Performs only minimal
 * shape validation (missing/wrongly-typed required fields); the engine does
 * deep validation and returns {ok:false} for illegal moves. Unknown tool
 * names return ok:false with code 'unknown_tool'.
 */
export function dispatchTool(
  state: GameState,
  playerId: number,
  name: string,
  args: Record<string, unknown>,
): ActionResult {
  switch (name) {
    case 'purchase': {
      const items = coercePurchaseItems(args.items);
      if (items === null) return badArgs('purchase.items must be an array of {type, count}');
      return purchase(state, playerId, items);
    }
    case 'combat_move': {
      const moves = coerceMoves<CombatMove>(args.moves, (m) => ({
        from: m.from as string,
        to: m.to as string,
        units: m.units as CombatMove['units'],
        ...(m.via !== undefined ? { via: m.via as string[] } : {}),
        ...(m.sbr !== undefined ? { sbr: m.sbr as boolean } : {}),
      }));
      if (moves === null) return badArgs('combat_move.moves must be an array of {from,to,units}');
      return combatMove(state, playerId, moves);
    }
    case 'resolve_combat_round': {
      if (!isStr(args.territory_id)) return badArgs('resolve_combat_round.territory_id must be a string');
      return resolveCombatRound(state, playerId, args.territory_id);
    }
    case 'auto_casualties': {
      if (!isStr(args.territory_id)) return badArgs('auto_casualties.territory_id must be a string');
      if (args.side !== 'attacker' && args.side !== 'defender') {
        return badArgs("auto_casualties.side must be 'attacker' or 'defender'");
      }
      return autoCasualties(state, playerId, args.territory_id, args.side);
    }
    case 'retreat': {
      if (!isStr(args.territory_id) || !isStr(args.to_id)) {
        return badArgs('retreat.territory_id and retreat.to_id must be strings');
      }
      return retreat(state, playerId, args.territory_id, args.to_id);
    }
    case 'non_combat_move': {
      const moves = coerceMoves<NonCombatMove>(args.moves, (m) => ({
        from: m.from as string,
        to: m.to as string,
        units: m.units as NonCombatMove['units'],
      }));
      if (moves === null) return badArgs('non_combat_move.moves must be an array of {from,to,units}');
      return nonCombatMove(state, playerId, moves);
    }
    case 'mobilize': {
      if (!Array.isArray(args.placements)) return badArgs('mobilize.placements must be an array');
      const placements: MobilizePlacement[] = [];
      for (const p of args.placements) {
        if (!isRecord(p) || !isStr(p.territory) || !isRecord(p.units)) {
          return badArgs('mobilize.placements entries must be {territory, units}');
        }
        placements.push({
          territory: p.territory,
          units: p.units as MobilizePlacement['units'],
          ...(p.build_factory !== undefined ? { buildFactory: p.build_factory as boolean } : {}),
        });
      }
      return mobilize(state, playerId, placements);
    }
    case 'end_phase':
      return endPhase(state, playerId);
    case 'send_message': {
      if (!isStr(args.recipients) || !isStr(args.text)) {
        return badArgs('send_message.recipients and send_message.text must be strings');
      }
      return sendMessage(state, playerId, args.recipients, args.text);
    }
    default:
      return {
        ok: false,
        code: 'unknown_tool',
        error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}.`,
      };
  }
}
