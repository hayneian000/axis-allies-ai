// In-game help: the how-to-play panel behind the Help button (game
// topbar) and the How to play plaque (setup screen). Content is built
// from live game data wherever the values exist - unit stats come from
// UNITS, victory numbers are computed by the caller from the active
// game's state or the map's scenario - so the panel cannot silently
// drift from the game it describes. The remaining copy is short static
// lines verified against engine/RULES.md; tests/help-content.test.ts
// pins the generated parts and the canal facts.
//
// This module is DOM-light: buildHelpHtml is a pure string builder
// (unit-testable in node), renderHelpInto is the thin DOM applier.

import {
  UNITS,
  scenarioForMap,
  victoryCityTargets,
  type MapId,
  type UnitOrFactory,
} from '../data/data';
import { DEFAULT_TURN_CAP, capitalsOf } from '../engine/engine';
import type { GameState } from '../engine/types';

// ------------------------------------------------------------ units ---

/** Display order for the unit table: land, air, sea, then the factory. */
export const UNIT_ORDER: UnitOrFactory[] = [
  'infantry',
  'artillery',
  'tank',
  'aa',
  'fighter',
  'bomber',
  'transport',
  'submarine',
  'destroyer',
  'cruiser',
  'carrier',
  'battleship',
  'factory',
];

/** Player-facing name and one-line special note per unit. The notes are
 *  the only hand-written unit text; every purchasable unit in UNITS must
 *  have one (pinned by test). */
export const UNIT_TEXT: Record<UnitOrFactory, { name: string; note: string }> = {
  infantry: {
    name: 'Infantry',
    note: 'Attacks at 2 when paired with artillery (one artillery boosts one infantry).',
  },
  artillery: {
    name: 'Artillery',
    note: 'Boosts one paired infantry to attack 2.',
  },
  tank: {
    name: 'Tank',
    note: 'Moves 2 and can blitz through an undefended enemy territory into the one beyond.',
  },
  aa: {
    name: 'AA gun',
    note: 'Fires once per battle at attacking aircraft, before the first round. Moves only in the Move step.',
  },
  fighter: {
    name: 'Fighter',
    note: 'Strong on defense. Can land on a friendly carrier with spare room.',
  },
  bomber: {
    name: 'Bomber',
    note: 'Long range. Can raid factories instead of attacking (see Key rules).',
  },
  transport: {
    name: 'Transport',
    note: 'Carries land units: up to 2 per transport, at most one of them not infantry. No combat value, and chosen as a casualty last.',
  },
  submarine: {
    name: 'Submarine',
    note: 'Strikes first in sea battles and can submerge instead of firing. Cannot hit aircraft, and aircraft cannot hit it without a destroyer present.',
  },
  destroyer: {
    name: 'Destroyer',
    note: 'Cancels enemy submarine first strike and submerging. Lets your aircraft hit submarines.',
  },
  cruiser: {
    name: 'Cruiser',
    note: 'Bombards in amphibious assaults when no sea battle was fought first.',
  },
  carrier: {
    name: 'Carrier',
    note: 'Carries up to 2 fighters. Its fighters launch, fight, and land back on it.',
  },
  battleship: {
    name: 'Battleship',
    note: 'Takes 2 hits to sink in one battle; if it survives, the damage is repaired. Bombards in amphibious assaults.',
  },
  factory: {
    name: 'Factory',
    note: 'Produces units at the Deploy step, up to the territory IPC value minus damage. Needs a territory worth 2 IPC or more.',
  },
};

export interface UnitRow {
  id: UnitOrFactory;
  name: string;
  cost: number;
  attack: number;
  defense: number;
  move: number;
  note: string;
}

/** The unit table rows, generated from UNITS so stats always match the
 *  game data. */
export function unitRows(): UnitRow[] {
  return UNIT_ORDER.map((id) => ({
    id,
    name: UNIT_TEXT[id].name,
    cost: UNITS[id].cost,
    attack: UNITS[id].attack,
    defense: UNITS[id].defense,
    move: UNITS[id].move,
    note: UNIT_TEXT[id].note,
  }));
}

// --------------------------------------------------------- objective ---

/** Victory numbers for one map, as far as the caller could determine
 *  them. `capitals: null` means the exact counts were not available
 *  (1942 scenario not loaded yet) and the panel falls back to the
 *  qualitative majority wording; `victoryCities: 'degraded'` does the
 *  same for the victory-city targets. */
export interface HelpObjective {
  mapId: MapId;
  mapLabel: string;
  capitals: { toWin: number; total: number } | null;
  turnCap: number;
  victoryCities: { seats: string[]; targets: number[] } | 'degraded' | null;
}

export interface HelpContentInput {
  /** The active game's (or the setup screen's selected) map, first. */
  primary: HelpObjective;
  /** The other map, when its data could be read. */
  secondary: HelpObjective | null;
}

/** Map display labels, as the setup screen and Resume button name them. */
export function helpMapLabel(mapId: MapId): string {
  return mapId === 'world1942' ? '1942 World' : 'America';
}

/** Victory numbers for a map from its scenario, or qualitative-only
 *  data when the scenario is not available (the 1942 chunk has not
 *  loaded yet): the panel then shows the majority wording with no
 *  invented numbers. */
export function objectiveForMap(mapId: MapId, playerCount: number): HelpObjective {
  const sc = scenarioForMap(mapId, playerCount);
  if (!sc) {
    return {
      mapId,
      mapLabel: helpMapLabel(mapId),
      capitals: null,
      turnCap: DEFAULT_TURN_CAP,
      victoryCities: mapId === 'world1942' ? 'degraded' : null,
    };
  }
  const total = sc.capitals.reduce((n, c) => n + (Array.isArray(c) ? c.length : 1), 0);
  const targets = victoryCityTargets(sc, playerCount);
  return {
    mapId,
    mapLabel: helpMapLabel(mapId),
    capitals: { toWin: sc.capitalsToWin ?? Math.floor(playerCount / 2) + 1, total },
    turnCap: DEFAULT_TURN_CAP,
    victoryCities: targets
      ? { seats: sc.seatNames ?? targets.map((_, i) => `Player ${i + 1}`), targets }
      : null,
  };
}

/** Victory numbers from a live game state (exact, mid-game safe). */
export function objectiveForState(s: GameState): HelpObjective {
  const mapId: MapId = s.mapId === 'world1942' ? 'world1942' : 'america';
  const total = new Set(s.players.flatMap((p) => capitalsOf(s, p.id))).size;
  return {
    mapId,
    mapLabel: helpMapLabel(mapId),
    capitals: { toWin: s.capitalsToWin, total },
    turnCap: s.turnCap,
    victoryCities: s.victoryCitiesToWin
      ? { seats: s.players.map((p) => p.name), targets: s.victoryCitiesToWin }
      : null,
  };
}

function otherMap(mapId: MapId): MapId {
  return mapId === 'america' ? 'world1942' : 'america';
}

function helpInput(primary: HelpObjective, playerCount: number): HelpContentInput {
  const other = otherMap(primary.mapId);
  return {
    primary,
    secondary: objectiveForMap(other, other === 'world1942' ? 4 : playerCount),
  };
}

/** Panel content for a running game: its map first, the other map second. */
export function helpInputForState(s: GameState): HelpContentInput {
  return helpInput(objectiveForState(s), s.players.length);
}

/** Panel content for the setup screen: the selected map first. */
export function helpInputForSetup(selectedMap: MapId, numPlayers: number): HelpContentInput {
  return helpInput(
    objectiveForMap(selectedMap, selectedMap === 'world1942' ? 4 : numPlayers),
    numPlayers,
  );
}

/** Plain-text objective lines for one map (also the test surface). */
export function objectiveLines(o: HelpObjective): string[] {
  const lines: string[] = [];
  lines.push(
    o.capitals
      ? `Hold ${o.capitals.toWin} of the ${o.capitals.total} capitals at the same time and you win at once.`
      : 'Hold a majority of the capitals at the same time and you win at once.',
  );
  if (o.victoryCities === 'degraded') {
    lines.push(
      'Victory cities: hold your seat target of victory cities at the end of a complete round to win. Targets are shown in the roster during a 1942 game.',
    );
  } else if (o.victoryCities) {
    const vc = o.victoryCities;
    const per = vc.seats.map((seat, i) => `${seat} ${vc.targets[i]}`).join(', ');
    lines.push(
      `Victory cities: hold your seat target at the end of a complete round - ${per}. Each target is the seat's starting count plus 3. Crossing your target mid-round is not enough; the cities must still be yours when the round ends.`,
    );
  }
  lines.push(
    `If the game reaches the ${o.turnCap}-round cap with no winner, the highest income wins. Ties go to the bigger bank, then to the earlier seat in turn order.`,
  );
  return lines;
}

// ------------------------------------------------------------ copy -----

/** The five turn steps, named as the UI stepper names them. */
export const TURN_STEPS: Array<{ name: string; text: string }> = [
  {
    name: 'Buy',
    text: 'Spend IPCs on new units. They arrive at the Deploy step. You can also repair factory damage here: 1 IPC per damage marker.',
  },
  {
    name: 'Attack',
    text: 'Move units into enemy territory or sea zones to start battles, or send bombers on factory raids.',
  },
  {
    name: 'Battle',
    text: 'Fight each open battle: roll rounds, choose casualties, retreat or fight on. AA guns fire first, once per battle.',
  },
  {
    name: 'Move',
    text: 'Reposition units that did not attack. Aircraft must end somewhere legal (see Key rules) or they are lost. AA guns can only move in this step.',
  },
  {
    name: 'Deploy',
    text: "Place your bought units at factories you own, up to each factory's capacity.",
  },
];

export const KEY_RULES: string[] = [
  "Capitals: capturing a capital transfers the victim's entire bank to you. While you hold no capital you cannot buy units or collect income.",
  'UK + US (1942 World) rules two capitals, London and Washington. Losing either one still hands your bank to the captor; you are blocked only while you hold neither.',
  'Aircraft: fighters and bombers must end the Move step on territory you held at the start of your turn, or on a friendly carrier with spare room. Aircraft left with no legal landing spot are lost.',
  "Factories: a factory builds up to its territory's IPC value in units per turn, minus its damage markers. A factory built or captured this turn produces from next turn.",
  'Factory raids: bombers can raid a factory instead of attacking. Each surviving bomber rolls one die; the total becomes damage markers on that factory, never more than twice the territory IPC value. Damage does not reduce income. Repair markers in the Buy step, 1 IPC each.',
  'Neutrals (America): neutral territories are guarded by 3 infantry. Defeat the garrison to capture them.',
  'Impassable (1942 World): Spain-Portugal, Sahara, Himalaya, Switzerland, Mongolia, Turkey and 10 other neutral territories are impassable. No unit may enter, land in, fly over, or capture them.',
  "Canals (1942 World): sea units can use the Panama Canal only while you control Central America, and the Suez Canal only while you control both Egypt and Trans-Jordan.",
  'Free-for-all: every other seat is hostile. There are no shared carriers, transports, or victories.',
];

export const AI_LINES: string[] = [
  'Each AI seat is an AI commander playing with its own provider and model. Its API key is stored only in this browser and is never written into save files.',
  'Diplomacy: in AI games a negotiation window opens at the start of each round. Use the Chat tab to propose deals. Deals are talk only - the engine does not enforce them.',
  'A resumed AI seat starts with a fresh conversation and sees the full current board, so it may not remember its earlier plans.',
];

export const SAVE_LINES: string[] = [
  'Save (top right) downloads the current game as a JSON file. Load it again from the setup screen. Saves remember the AI seat setup, so an AI game resumes as an AI game.',
  'The game also autosaves in this browser as you play. If you close the tab, use Resume last game on the setup screen to pick it back up.',
];

// ------------------------------------------------------------ build ----

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function objectiveBlock(o: HelpObjective, heading: string): string {
  const lines = objectiveLines(o).map((l) => `<p>${esc(l)}</p>`).join('');
  return `<h4>${esc(heading)} - ${esc(o.mapLabel)}</h4>${lines}`;
}

/** The full help panel HTML. Pure: no DOM, no game state. */
export function buildHelpHtml(input: HelpContentInput): string {
  const parts: string[] = ['<div class="help-root">'];
  parts.push('<h3>Objective</h3>');
  parts.push(objectiveBlock(input.primary, 'This game'));
  if (input.secondary) {
    parts.push(objectiveBlock(input.secondary, 'On the other map'));
  }
  parts.push('<h3>Your turn</h3>');
  parts.push(
    '<p>Every seat takes its turn in five steps. The stepper at the top shows where you are.</p>',
  );
  parts.push('<ol class="help-steps">');
  TURN_STEPS.forEach((s, i) => {
    parts.push(`<li><strong>${i + 1}. ${esc(s.name)}</strong> - ${esc(s.text)}</li>`);
  });
  parts.push('</ol>');
  parts.push(
    '<p>Income arrives automatically at the end of your turn, equal to the IPC value of the territory you hold.</p>',
  );
  parts.push('<h3>Key rules</h3>');
  parts.push('<ul class="help-rules">');
  for (const r of KEY_RULES) parts.push(`<li>${esc(r)}</li>`);
  parts.push('</ul>');
  parts.push('<h3>Units</h3>');
  parts.push(
    '<table class="help-units"><thead><tr><th>Unit</th><th>Cost</th><th>Atk</th><th>Def</th><th>Move</th><th>Notes</th></tr></thead><tbody>',
  );
  for (const r of unitRows()) {
    parts.push(
      `<tr><td class="uname">${esc(r.name)}</td><td>${r.cost}</td><td>${r.attack}</td><td>${r.defense}</td><td>${r.move === 0 ? '-' : r.move}</td><td class="unote">${esc(r.note)}</td></tr>`,
    );
  }
  parts.push('</tbody></table>');
  parts.push(
    '<p>Attack and defense are the die roll a unit needs to score a hit (roll that number or less on one die).</p>',
  );
  parts.push('<h3>AI games</h3>');
  for (const l of AI_LINES) parts.push(`<p>${esc(l)}</p>`);
  parts.push('<h3>Saves</h3>');
  for (const l of SAVE_LINES) parts.push(`<p>${esc(l)}</p>`);
  parts.push('</div>');
  return parts.join('');
}

/** Apply the help panel to a container element (the modal body). */
export function renderHelpInto(el: HTMLElement, input: HelpContentInput): void {
  el.innerHTML = buildHelpHtml(input);
}
