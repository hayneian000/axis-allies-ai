# AI Axis & Allies — Phase 1 Build Prompt

## Goal

Build a playable, hot-seat (all players on one computer) strategy game using Axis & Allies–style rules on a simplified map of the continental United States. This is Phase 1 of a larger project: in Phase 2, LLM agents will replace some or all human players and negotiate with each other via chat. Design the engine now so that Phase 2 is an additive layer, not a rewrite.

The deliverable is a working web app I can open locally, set up a 2–4 player free-for-all, and play through to a winner.

## Architecture requirements

Keep these separate and independently testable:

1. **Rules engine** — a pure, headless module with no UI or I/O dependencies. Owns all game state and all rule enforcement. Every state change goes through an explicit action, and every action is validated against the current state. Invalid actions return a structured error (never throw the game into a bad state).
2. **Map and scenario data** — territories, adjacency, IPC values, SVG layout, unit stats, and starting setups per player count live in data files, not in code.
3. **UI** — a browser front end that renders the map and drives the engine through the same action API that LLM agents will use later.

Non-negotiables for the engine:

- Full game state is a plain serializable object (JSON round-trip with no loss). Save, load, inspect.
- Randomness uses an injectable seeded RNG so games are replayable and testable.
- Append-only event log of every action and dice result.
- Provide a `summarizeState(playerId)` function returning a compact text description of the board from one player's point of view: for each territory, owner, IPC value, and units by type; each player's income, IPC bank, capital status, and factory locations; whose turn and which phase. Target under ~800 words for a full board. This will be pasted into LLM prompts in Phase 2.
- The action API should be exactly the set of things a player can do, one function per action. This becomes the LLM tool set in Phase 2:
  - `purchase(units: {type, count}[])` — purchase phase; deducts IPCs, units go to a "to be mobilized" pool
  - `combatMove(moves: {from, to, units}[])` — declare all combat moves at once; each move validated for range and legality
  - `resolveCombatRound(territoryId)` — rolls one round for one contested territory and returns hits and current forces
  - `chooseCasualties(territoryId, side, units)` — used when a human is defending; an `autoCasualties` policy (lose cheapest / lowest-defense units first) must also exist so Phase 2 can skip this step
  - `retreat(territoryId, toId)` — attacker only, after any round
  - `nonCombatMove(moves)` — includes landing aircraft
  - `mobilize(placements: {factoryTerritoryId, units}[])`
  - `endPhase()` — advances purchase → combat move → combat → non-combat move → mobilize → collect income → next player
- Include a `chatLog` structure in the game state (sender, recipients or "all", text, turn number) and a `sendMessage` action. Phase 1 only needs a text box; Phase 2 negotiation plugs in here.

Tech stack: TypeScript end to end (engine as a plain TS package, front end with React or plain DOM + SVG — your call). Vite for dev, Vitest for tests. No backend in Phase 1; state lives in the browser with export/import to JSON.

## Map

Simplified continental US: 26 land territories. No sea zones or naval units in Phase 1 (leave the data model open to adding coastal sea zones later). Derive adjacency from the real shared borders of the constituent states; corner-only contact (Four Corners) does not count. Store the adjacency table explicitly in the data file and test that it's symmetric and connected.

Each territory has an **IPC value** (income when controlled). Suggested values below; total is 64. Adjust for balance and note changes.

| Territory | States | IPC |
|---|---|---|
| Washington | WA | 2 |
| Oregon | OR | 1 |
| California | CA | 5 |
| Idaho | ID | 1 |
| Montana | MT | 1 |
| Wyoming | WY | 1 |
| Nevada+Utah | NV, UT | 2 |
| Colorado | CO | 2 |
| Arizona | AZ | 2 |
| New Mexico | NM | 1 |
| Texas | TX | 5 |
| Oklahoma | OK | 1 |
| Dakotas | ND, SD | 1 |
| Plains | NE, KS | 2 |
| Upper Midwest | MN, WI | 2 |
| Heartland | IA, MO | 2 |
| Great Lakes | IL, IN, MI, OH | 5 |
| Gulf South | LA, MS, AL | 2 |
| Arkansas | AR | 1 |
| Appalachia | KY, TN, WV | 2 |
| Florida | FL | 3 |
| Southeast | GA, SC, NC | 3 |
| Mid-Atlantic | VA, MD, DE | 3 |
| Pennsylvania+New Jersey | PA, NJ | 4 |
| New York | NY | 4 |
| New England | ME, NH, VT, MA, RI, CT | 3 |

For the SVG map, real geography is not required: stylized polygons in roughly the right relative positions, with adjacencies visually obvious. Each territory shows name, IPC value, owner color, and a unit summary (icon + count per type).

## Units

Land and air only. Standard A&A-style stats (cost / attack / defense / move):

| Unit | Cost | Att | Def | Move | Notes |
|---|---|---|---|---|---|
| Infantry | 3 | 1 | 2 | 1 | Attacks at 2 when paired 1:1 with artillery |
| Artillery | 4 | 2 | 2 | 1 | Boosts one infantry per artillery |
| Tank | 6 | 3 | 3 | 2 | May blitz: move through an empty enemy territory (capturing it) into a second territory |
| Fighter | 10 | 3 | 4 | 4 | Must end non-combat move in a friendly territory or is lost |
| Bomber | 12 | 4 | 1 | 6 | Same landing rule; can strategic-bomb a factory instead of fighting (1d6 IPC damage to that player, target AA fires first) |
| AA Gun | 5 | 0 | 0 | 1 | Fires once at each attacking aircraft (hit on 1) before combat; cannot attack; captured with the territory |
| Factory | 15 | — | — | 0 | Can be built on any owned territory with IPC ≥ 2; produces up to that territory's IPC value in units per turn; captured with the territory |

Put unit stats in a data file so they can be tuned without code changes.

## Rules

**Players:** 2–4, free-for-all. Turn order randomized at start; play proceeds in that order. (Optional later: 2v2 team mode.)

**Setup:** Scenario files per player count define each player's capital, starting territories (contiguous block, roughly balanced on IPC and border exposure), starting units, and starting IPC bank. Capitals suggested: California, Texas, Great Lakes, New York. Each capital starts with a factory. Territories not assigned to a player are **neutral**: unowned, with a small fixed garrison (1–2 infantry) that defends but never moves; capturing one gives its IPCs to the captor thereafter. Propose concrete starting unit lists and I'll review them.

**Turn sequence** (one player at a time):

1. **Purchase** — spend IPCs from the bank on units; purchased units are placed in the mobilize phase.
2. **Combat move** — move units into enemy or neutral territories. Units may not move through enemy-held territory except tanks blitzing through empty ones. Aircraft must have enough move to reach a legal landing spot in non-combat.
3. **Combat** — resolve each contested territory. Per round: AA fires first if present, then attacker rolls all units, then defender rolls; a unit hits on a roll ≤ its attack/defense value. Hits are applied simultaneously. Defending player chooses casualties (or auto policy). Attacker may retreat all surviving land units to one territory they came from after any round; aircraft retreat to be landed in non-combat. Combat continues until one side is eliminated or the attacker retreats. Attacker captures the territory only if at least one **land** unit survives.
4. **Non-combat move** — units that did not attack may move; all aircraft (including ones that attacked) must land on a territory the player owned at the start of the turn (or one they just captured is not allowed — classic rule).
5. **Mobilize** — place purchased units on factories, up to each factory's territory IPC value.
6. **Collect income** — add the IPC value of all owned territories to the bank. If your capital is enemy-held, you collect nothing.

**Capitals and elimination:** Capturing a capital transfers the victim's entire IPC bank to the captor. A player whose capital is enemy-held cannot purchase or collect until they retake it. A player is eliminated when they control no territories and have no units on the board.

**Win condition:** Control all capitals in play (a player may still be alive with units elsewhere but the game ends). Also enforce a turn cap (default 20 rounds); at cap, highest total income wins, ties by IPC bank.

## UI

Hot-seat flow on one screen: "Player N — Phase X" banner, phase-appropriate interactions on the map (select units in a territory, choose destination, confirm), a purchase panel showing costs and remaining IPCs, a combat panel showing both sides' forces, dice results, casualty selection, and retreat/continue buttons. Event log panel, chat panel with a text box, save (download JSON) and load. Functional over pretty; Phase 2 gets a design pass.

## Testing

- Unit tests for: purchasing and factory placement caps, move range and blitz legality, aircraft landing enforcement, combat round math including artillery pairing and AA fire, casualty application, retreat, capital capture and IPC transfer, income collection, elimination, turn cap tiebreak.
- Map tests: adjacency symmetric and connected, IPC total matches expectation, every scenario's starting territories are contiguous and every capital has a factory.
- A headless random-legal-move simulation that plays full games to completion with a fixed seed, to catch state corruption, stranded aircraft, and infinite loops.

## Deliverables

- Repo with `engine/`, `data/` (map, units, scenarios), `ui/`, and `tests/` (or equivalent), a README with run instructions, and a short `ARCHITECTURE.md` explaining the action API and how an external agent would drive one full turn in Phase 2.
- Before writing code, give me a brief plan plus a proposed starting scenario for 4 players, and flag any rule ambiguities or adjacency judgment calls you had to make.
