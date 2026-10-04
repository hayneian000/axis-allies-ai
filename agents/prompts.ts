// System and phase prompts for the Phase 2 BYOK agents. The rules digest is
// distilled from engine/RULES.md (1942 2e adaptation); unit costs were
// verified against data/units.json.

/** ~400-word rules digest included in every system prompt. */
export const RULES_DIGEST = `You play a simplified free-for-all Axis & Allies (based on 1942 2e) on a 26-territory continental-US map. Land and air units only; no navy.

OBJECTIVE: Win by holding a majority of capitals simultaneously (3 of 4 on the current map; scenarios may override via capitalsToWin). If 20 rounds pass with no winner, the highest-income player wins. Capturing a capital steals the victim's entire saved IPC bank.

TURN ORDER (6 phases, in this order): 1) Purchase — spend IPCs from your bank. 2) Combat Move — move units into hostile or neutral territories to open battles. 3) Combat — resolve each open battle round by round. 4) Noncombat Move — reposition units among friendly territories. 5) Mobilize — place purchased units at your factories. 6) Income — collect IPCs equal to the total IPC value of territories you hold, then the next player's turn begins.

PURCHASE COSTS (IPCs): infantry 3, artillery 4, tank 6, fighter 10, bomber 12, AA gun 5, factory 15. Factories produce new units each turn; capacity per factory equals its territory's IPC value. Factories built or captured this turn come online next turn. You cannot buy while your capital is enemy-held.

COMBAT BASICS: Battles are fought in rounds. Each unit rolls one die per round; a roll at or under its value scores a hit. Attack profiles — infantry 1, artillery 2, tank 3, fighter 3, bomber 4. Defense profiles — infantry 2, artillery 2, tank 3, fighter 4, bomber 1. Attacker and defender fire simultaneously each round, then casualties are removed (cheapest-first by default; AA guns are never casualties). Land movement: infantry/artillery/AA move 1, tanks move 2 and can blitz through empty enemy territories. Fighters move 4, bombers move 6; air units must end in a friendly territory within range or they are lost.

AA FIRE: AA guns fire once per battle, before the first combat round, at attacking aircraft only (1 AA hit = 1 air unit destroyed). AA guns can NEVER attack and move ONLY during the noncombat phase.

ARTILLERY SUPPORT: Each artillery paired 1:1 with infantry raises that infantry's attack from 1 to 2.

NEUTRAL TERRITORIES: Unowned territories are defended by a neutral garrison (default 3 infantry; scenarios may customize). The garrison must be defeated in combat before capture — tanks cannot blitz through them.

STRATEGIC BOMBING RAIDS: Bombers may raid a factory territory instead of a normal attack (sbr: true). AA fires first, then each surviving bomber rolls 1d6 IPC damage to the victim's bank. Bombers then leave; raids cannot retreat.`;

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
- Game state is revealed to you each turn; enemy plans are hidden. Messages from other players may be bluffs.`;
}

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
