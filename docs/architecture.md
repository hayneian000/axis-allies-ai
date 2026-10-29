# Architecture

## Separation

- **`engine/`** is pure TypeScript: no DOM, no network, no clock. Every state
  change goes through one exported action function that validates first and
  returns `{ ok: true, ... }` or `{ ok: false, code, error }`. Failures never
  mutate state (covered by serialize-before/after tests).
- **`data/`** owns all tunable content: map graph + IPC + SVG rects
  (`map.json`), unit stats (`units.json`), starting setups (`scenario-*.json`).
  Balance changes are JSON edits; scenarios are validated at load (full
  coverage, contiguous holdings, factory on every capital).
- **`ui/`** renders `GameState` and calls the same action functions below. It
  keeps no game state of its own beyond UI drafts (move lists, selections).

## State

`GameState` is a plain JSON-serializable object (`serialize`/`deserialize`,
version-checked). Seeded RNG lives in `state.rngState` (mulberry32), so a seed
replays a game exactly. `events` is append-only (every action and dice roll);
`chatLog` carries `{ sender, recipients, text, round }` for Phase 2.

## Saves and autosave

Save format is version 3 and unchanged by this feature: `serialize` is
`JSON.stringify(state)`, and `deserialize` backfills fields older saves
lack (cargo, factory damage, victory-city targets, mobilize counts) and
normalizes a missing or malformed `aiSeats` field to undefined (all-human)
instead of failing the load. `GameState.aiSeats` is the full seat table
(human seats as kind 'human' entries, AI seats as kind 'ai' with provider
and model), recorded by `createGame` when the caller passes seats; it is
what makes a loaded AI game resume as an AI game. Seat configs carry no
key material - keys live only in `agents/keys.ts` - so no serialized save
(manual or autosave) can contain an API key, and `deserialize` rebuilds
seat entries through a pick list that drops any other field.

`ui/autosave.ts` stores `{ savedAt, save }` under `aaa.autosave`, where
`save` is `serialize(state)` output (no second save format). The hook is
`recordGameState(state)`: it writes after every successful state-mutating
action (hot-seat handlers in `ui/main.ts`, driver `onPhase` /
successful `onToolCall` / diplomacy events in `ui/aiGame.ts`) and clears
on `gameover`; a finished game has nothing to resume. The setup screen
reads it through `peekAutosave()` (round + map for the Resume label) and
offers Resume/Discard; a corrupt record returns null, hides the buttons,
and is cleared, never a crash.

Resume semantics (`ui/aiGame.ts resumeAiGame`, `agents/driver.ts`
`opts.resume`): the saved state drives the game directly - no intro, no
`createGame`. `deriveRuntimeSeats` (pure, in `agents/lobby.ts`) turns the
saved table into session seats, downgrading AI seats with an unknown
provider or no saved key to human for this session only; the downgrade is
never written back, and a visible notice goes to the activity feed, the
spectator header, the error bar, and a persistent panel banner. The
driver runs the current turn phase-aware (it skips, never re-ends, the
phases already passed) and skips the current round's diplomacy window,
which already ran before the save. Not persisted: AI conversation history
(a resumed seat starts fresh and sees the full board brief) and diplomacy
token budgets (the driver-side ledger restarts for the current round).
Undo/redo is out of scope.

Key per-turn bookkeeping: `ownedAtTurnStart` (aircraft landing rule),
`turnStartFactories` (mobilize capacity = territory IPC, new/captured factories
excluded), `used` (units that moved/attacked and may not move again, except
landing aircraft), `mobilizedThisPhase` (units already placed this mobilize
phase per factory, so the per-turn cap holds across split mobilize calls;
reset when the mobilize phase is entered), `battles` (open + finished this
turn).

## Action API (also the Phase 2 tool set)

| Function | Phase | Notes |
|---|---|---|
| `purchase(items)` | purchase | Deducts IPCs to a mobilize pool. Empty list passes. Blocked without capital. |
| `repair(tid, points)` | purchase | Pays 1 IPC per damage marker to remove SBR damage from an own factory (1942 2e p.10). Partial repairs allowed; also exposed as an agent tool. |
| `combatMove(moves)` | combatMove | All-or-nothing: validated on a copy, then committed. Supports `via` (tank blitz, captures empty ground in passing) and `sbr` (bombers vs factories). AA may not move here. |
| `resolveCombatRound(tid)` | combat | AA fires first (once, at air, hit on 1), then simultaneous exchange. Artillery boosts paired infantry 1:1. Neutral garrisons auto-lose. Sets pending casualties. |
| `chooseCasualties(tid, side, units)` | combat | Exact-count selection, AA never selectable. |
| `autoCasualties(tid, side)` | combat | Policy: infantry → artillery → tank → fighter → bomber. Phase 2 uses this to skip choice. |
| `retreat(tid, toId)` | combat | Attacker only, after ≥1 round, land to one origin. Air stays to land later. |
| `nonCombatMove(moves)` | nonCombat | Friendly ground only; air must end on turn-start ground. |
| `mobilize(placements)` | mobilize | Per-factory caps = territory IPC minus factory damage markers (SBR, 1942 2e p.14/p.21), enforced cumulatively across all calls in the phase (`mobilizedThisPhase`); new factories need IPC ≥ 2 ground. Unplaced purchases are forfeited. |
| `endPhase()` | any | purchase → combatMove → combat → nonCombat (stranded air destroyed) → mobilize → income + next player (or turn-cap ending). |
| `sendMessage(from, to, text)` | any | Appends to `chatLog` + event. |
| `summarizeState(pid)` | — | <800-word board brief for LLM prompts. |

Capture needs surviving land; AA/factory transfer; capital capture moves the
bank; wiping a player eliminates them; holding all capitals wins immediately.

## How a Phase 2 agent drives one turn

1. Read `summarizeState(myId)` (+ full state for unit positions).
2. `purchase(...)` within bank; `endPhase()`.
3. Build the **full** move list (bot example: `tests/simulation.test.ts`,
   `botCombatMove`) and call `combatMove(moves)` once; `endPhase()`.
4. Per battle: `resolveCombatRound`, then `autoCasualties` (or
   `chooseCasualties` with its own policy); `retreat` if losing; repeat.
5. `endPhase()`; `nonCombatMove` landing all air; `endPhase()`;
   `mobilize(...)`; `endPhase()` (income auto-collected).
6. Negotiation rides on `sendMessage`/`chatLog` at any point.

## Testing hooks (per-phase and e2e)

- `tests/purchase|movement|combat|economy.test.ts` — one file per phase group,
  with `tests/helpers.ts` (`gotoPhase`, `resolveBattleAuto`, `noopTurn`).
- `tests/simulation.test.ts` — headless random-policy bot plays 2/3/4-player
  seeded games to `gameover`, asserting invariants every turn
  (`npm run simulate`).
- `tests/ui.test.ts` — jsdom playthrough: starts a game, buys, declares an
  attack by clicking the SVG map, fights it in the combat panel, finishes the
  turn, chats.
