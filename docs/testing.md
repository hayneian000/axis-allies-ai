# Testing

```bash
npm test                          # full suite: 93 tests, ~7s
npx vitest run tests/combat.test.ts   # one file at a time
npm run simulate                  # headless bot games only
npm run test:watch                # watch mode
```

## Layers

| File | What it is | What it proves |
|------|------------|----------------|
| `tests/purchase.test.ts` | Setup + purchase phase | Player-count validation, scenario banks, capitals with factories, shuffled turn order, IPC spending/overspend, no-capital blocking, turn-start snapshots, income computation |
| `tests/movement.test.ts` | combatMove + nonCombatMove | All-or-nothing validation (state untouched on failure), battle creation, tank blitz through empty ground, blitz blocked through occupied, aircraft range/landing, friendly-only repositioning, attacked units can't move again (AA excepted) |
| `tests/combat.test.ts` | Rounds, AA, casualties, retreat | AA fires first at air (hit on 1), simultaneous exchange, artillery pairs infantry 1:1, neutral garrisons auto-lose, pending casualties, exact-count `chooseCasualties`, retreat rules |
| `tests/economy.test.ts` | mobilize, income, capitals, endgame | Per-factory IPC caps, fresh/captured factories produce next turn, new factories on IPC≥2 ground, income collection, capital capture transfers the bank, elimination, 20-round cap with income→bank tiebreak, JSON save/load round-trip mid-combat, corrupt-save rejection, chat validation, `summarizeState` under 800 words |
| `tests/edge.test.ts` | Boundary/invalid inputs for every action | The no-mutation guarantee: each failure is checked with serialize-before/after — the engine must never partially apply |
| `tests/map.test.ts` | Data validation | 26 territories, IPC sums to 61, symmetric adjacency, connected graph, Four Corners point-contacts excluded, polygons inside the viewBox; per scenario: full coverage, contiguous holdings, factory on every capital, small neutral garrisons |
| `tests/simulation.test.ts` | Headless bot, full games | Random-policy bot plays 2/3/4-player games (seeds 1, 2) to `gameover`, asserting invariants every turn — no state corruption, no stranded aircraft, no infinite loops |
| `tests/ui.test.ts` | jsdom playthrough | Starts a game, buys through the shop, declares an attack by clicking the SVG map, fights it in the combat panel, finishes the turn, sends chat. See [browser-testing](browser-testing.md) for the DOM contract it enforces |
| `tests/helpers.ts` | Shared fixtures | `freshGame`, `gotoPhase` (never crosses turns), `resolveBattleAuto`, `noopTurn` |

## Conventions

- **Engine failures are return values, not throws.** Every invalid action
  returns `{ ok: false, code, error }`. Tests assert the `code` and that state
  didn't change.
- **Seeds are load-bearing.** Scenario tests use fixed seeds; the sim uses
  `seed * 100 + numPlayers`. If a sim seed starts failing, investigate the
  engine change — don't just bump the seed.
- **Balance changes are data changes.** New scenario or unit tweak → update
  `data/*.json` and let `map.test.ts` validate it. If a test encodes a value
  the data changed on purpose, update the test and say why in the commit.
- **`npm run simulate` output is a smoke signal.** It prints
  `players/seed: rounds, battles, captures, sbrs, stranded, winner` per game.
  `stranded` should stay 0; `battles` should stay > 0.

## What's not covered here

Visual rendering and layout — that's the real-browser harness, documented in
[browser-testing.md](browser-testing.md). The jsdom suite proves wiring; the
screenshots prove it looks right.
