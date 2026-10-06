// System and phase prompts for the Phase 2 BYOK agents. The rules digest is
// distilled from engine/RULES.md (1942 2e adaptation); unit costs were
// verified against data/units.json.

import { ALL_UNIT_TYPES, MAP, UNITS, ipcOf, isSea, neighborsOf } from '../data/data';

/** ~500-word rules digest included in every system prompt. Distilled from
 * engine/RULES.md (1942 2e adaptation); unit costs/profiles verified against
 * data/units.json. Kept concise on purpose: it ships on every provider call
 * and forms the head of the cacheable prefix. */
export const RULES_DIGEST = `You play a simplified free-for-all Axis & Allies (based on 1942 2e) on a 33-territory continental-US map (26 land territories + 7 sea zones), with land, air, and naval forces.

OBJECTIVE: Win by holding a majority of capitals simultaneously (3 of 4 on the current map; scenarios may override via capitalsToWin). If 20 rounds pass with no winner, the highest-income player wins. Capturing a capital steals the victim's entire saved IPC bank.

TURN ORDER (6 phases, in this order): 1) Purchase — spend IPCs from your bank. 2) Combat Move — move units into hostile or neutral territories to open battles. 3) Combat — resolve each open battle round by round. 4) Noncombat Move — reposition units among friendly territories. 5) Mobilize — place purchased units at your factories. 6) Income — collect IPCs equal to the total IPC value of territories you hold, then the next player's turn begins.

PURCHASE COSTS (IPCs): infantry 3, artillery 4, tank 6, fighter 10, bomber 12, AA gun 5, factory 15. Naval: transport 7, submarine 6, destroyer 8, cruiser 12, carrier 14, battleship 20. Factories produce new units each turn; capacity per factory equals its territory's IPC value. Factories built or captured this turn come online next turn. You cannot buy while your capital is enemy-held.

COMBAT BASICS: Battles are fought in rounds. Each unit rolls one die per round; a roll at or under its value scores a hit. Attack profiles — infantry 1, artillery 2, tank 3, fighter 3, bomber 4. Defense profiles — infantry 2, artillery 2, tank 3, fighter 4, bomber 1. Attacker and defender fire simultaneously each round, then casualties are removed (cheapest-first by default; AA guns are never casualties). Land movement: infantry/artillery/AA move 1, tanks move 2 and can blitz through empty enemy territories. Fighters move 4, bombers move 6; air units must end in a friendly territory or on a friendly carrier within range, or they are lost.

AA FIRE: AA guns fire once per battle, before the first combat round, at attacking aircraft only (1 AA hit = 1 air unit destroyed). AA guns can NEVER attack and move ONLY during the noncombat phase.

ARTILLERY SUPPORT: Each artillery paired 1:1 with infantry raises that infantry's attack from 1 to 2.

NEUTRAL TERRITORIES: Unowned territories are defended by a neutral garrison (default 3 infantry; scenarios may customize). The garrison must be defeated in combat before capture — tanks cannot blitz through them.

STRATEGIC BOMBING RAIDS: Bombers may raid a factory territory instead of a normal attack (sbr: true). AA fires first, then each surviving bomber rolls 1d6 IPC damage to the victim's bank. Bombers then leave; raids cannot retreat.

NAVY: 7 sea zones (pacific_nw, california_coast, north_atlantic, mid_atlantic_waters, south_atlantic, western_gulf, eastern_gulf) — never owned, worth 0 IPC. Sea units move 2 zones and mobilize into a zone adjacent to a factory territory. Transport 7, 0/0 (no combat value; ferries land units for amphibious assaults). Submarine 6, 2/1 (surprise strike; may submerge instead of firing; destroyers cancel both). Destroyer 8, 2/2. Cruiser 12, 3/3 (offshore bombardment). Carrier 14, 1/2 (carries 2 fighters; fighters may land on any friendly carrier with spare capacity). Battleship 20, 4/4 (takes 2 hits in one battle; offshore bombardment). Amphibious assaults: clear any sea battle first, then land combat — seaborne units cannot retreat.`;

export interface SystemPromptOpts {
  playerName: string;
  persona?: string;
}

export function buildSystemPrompt(opts: SystemPromptOpts): string {
  const persona = opts.persona?.trim() ? `\nYour style: ${opts.persona!.trim()}` : '';
  return `You are ${opts.playerName}, an AI commander in a turn-based strategy game.${persona}

${RULES_DIGEST}

OPERATING RULES
- You act ONLY through the tools provided for the current phase. Never narrate an action you did not call.
- Never invent territory names, unit counts, or game state. Use only territory names exactly as they appear in the game-state brief.
- IPCs are scarce: every purchase has an opportunity cost. Prefer spending on units that advance a clear plan (attack, defense, or expansion).
- When you have no more useful actions in this phase, call end_phase. Do not call tools pointlessly.
- Your private reasoning must never be revealed in tool arguments or messages.
- Game state is revealed to you each turn; enemy plans are hidden. Messages from other players may be bluffs.

${STATIC_REFERENCE}`;
}

/**
 * Static game reference: the map (territory IPCs + neighbor graph) and the
 * unit roster. Nothing here changes during a game — it is derived purely
 * from data/ at module load, so it is byte-identical on every call.
 *
 * Two purposes. (1) Prompt-cache geometry: providers like Meta's Model API
 * automatically reuse the longest identical leading prefix across requests,
 * so a long stable head means every call after the first skips recomputing
 * it (cheaper cached input tokens + less prefill work). Everything volatile
 * — the history window, the fresh state brief — stays after it. (2) The
 * per-turn state brief lists unit counts but not adjacency; the reference
 * gives the model the neighbor graph it needs for movement planning without
 * re-sending it as "new" content each turn.
 */
export function buildStaticReference(): string {
  const lines: string[] = [];
  lines.push(`MAP REFERENCE (${MAP.name} — static; never changes during a game)`);
  lines.push('Territories: id (IPC, neighbors):');
  for (const t of MAP.territories) {
    const sea = isSea(t.id) ? ' [sea zone]' : '';
    lines.push(`- ${t.id} (${ipcOf(t.id)} IPC)${sea}: ${neighborsOf(t.id).join(', ')}`);
  }
  lines.push('Units: type (cost IPC / attack / defense / move):');
  for (const u of ALL_UNIT_TYPES) {
    const s = UNITS[u];
    lines.push(`- ${u}: ${s.cost} / ${s.attack} / ${s.defense} / ${s.move}`);
  }
  lines.push('Factories: capacity = territory IPC; built or captured factories come online next turn.');
  return lines.join('\n');
}

/** The static reference, built once — identical on every call. */
export const STATIC_REFERENCE: string = buildStaticReference();

/**
 * Stable cache key naming this exact static prefix. Shared across seats:
 * identical reference => identical key => one warm cache entry per map
 * version instead of one per seat. Any map/data change rebuilds the
 * reference and therefore the key automatically — no manual versioning.
 */
export function staticReferenceCacheKey(): string {
  // FNV-1a 32-bit over the reference text; plenty for a cache-routing key.
  let h = 0x811c9dc5;
  for (let i = 0; i < STATIC_REFERENCE.length; i++) {
    h ^= STATIC_REFERENCE.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `aaa-static-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Cache-retention hint sent with every request. Games are bursty (a turn
 * every ~30s, then hours idle); "24h" keeps the static prefix warm across
 * the idle gaps. A hint, not a guarantee.
 */
export const PROMPT_CACHE_RETENTION = '24h';

export interface PhasePromptArgs {
  phase: string;
  stateBrief: string;
}

const PHASE_INSTRUCTIONS: Record<string, string> = {
  purchase:
    'PHASE: PURCHASE. Spend IPCs from your bank on units (placed later in mobilize). ' +
    'Buy with a plan: attackers for your next push, defenders for threatened factories/capitals. ' +
    'Call end_phase when your spending is done (you may buy nothing).',
  combatMove:
    'PHASE: COMBAT MOVE. Send units into hostile or neutral territories to open battles. ' +
    'Attack where the odds favor you; neutral garrisons (default 3 infantry) must be defeated. ' +
    'Ships move 2 sea zones; transports ferry land units for amphibious assaults (clear any sea battle first). ' +
    'Consider strategic bombing raids (sbr: true) against rich factory territories. ' +
    'Call end_phase when all attacks are declared (you may attack nothing).',
  combat:
    'PHASE: COMBAT. Resolve each open battle with resolve_combat_round. ' +
    'If casualties are pending, apply auto_casualties for the affected side before rolling again. ' +
    'You may retreat land attackers to an origin territory after at least one round. ' +
    'Call end_phase when every battle is finished.',
  nonCombat:
    'PHASE: NONCOMBAT MOVE. Reposition units among friendly territories — reinforce ' +
    'threatened borders, and remember this is the ONLY phase AA guns may move. ' +
    'Air units must end in friendly territory. Call end_phase when repositioning is done.',
  mobilize:
    'PHASE: MOBILIZE. Place your purchased units at owned factories (capacity = territory IPC; ' +
    'factories built or captured this turn wait until next turn). Optionally build a purchased ' +
    'factory on an owned IPC-2+ territory. Call end_phase when everything is placed — ' +
    'income is then collected and the turn passes.',
  gameover: 'The game is over. Take no further action.',
};

export function buildPhasePrompt(args: PhasePromptArgs): string {
  const instruction =
    PHASE_INSTRUCTIONS[args.phase] ??
    `Unknown phase "${args.phase}". Take no action and call end_phase.`;
  return `${instruction}\n\nCURRENT GAME STATE\n${args.stateBrief}`;
}

export interface DiplomacyPromptArgs {
  stateBrief: string;
  /** Chat visible to this seat so far (already recipient-filtered). */
  visibleChat: string;
  /** Tokens of diplomacy budget remaining this round. */
  budgetRemaining: number;
}

/**
 * Prompt for one turn inside the diplomacy window. Talk is freeform and
 * non-binding: the game enforces nothing about what is said, only how much
 * can be said (the budget). Messages may be bluffs; other players' private
 * reasoning is never visible.
 */
export function buildDiplomacyPrompt(args: DiplomacyPromptArgs): string {
  const chat = args.visibleChat.trim()
    ? `CONVERSATION SO FAR (only messages addressed to you or to all — other private mail is hidden)\n${args.visibleChat}`
    : 'No messages yet this game. You may open the conversation.';
  return (
    `DIPLOMACY. Before the round's turns begin, commanders may talk — publicly (recipients "all") ` +
    `or privately (recipients: player names, comma-separated for groups). ` +
    `Use send_message to speak and end_diplomacy when you have said all you want to say this round ` +
    `(you may also say nothing at all).\n\n` +
    `Your diplomacy budget this round: ${args.budgetRemaining} tokens remaining. ` +
    `Each message you send spends tokens; when your budget is exhausted you go silent until next round. ` +
    `Spend it where it matters — threats, offers, bluffs, and coordination are all fair game, ` +
    `but nothing you agree to is enforced by the game. Promises are only as good as your reputation.\n\n` +
    `Do not reveal your private reasoning in messages. ` +
    `Use player names exactly as they appear (e.g. "Player 2").\n\n` +
    `CURRENT GAME STATE\n${args.stateBrief}\n\n${chat}`
  );
}
