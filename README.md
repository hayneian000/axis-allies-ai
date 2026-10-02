# AI Axis & Allies — America (Phase 1)

Hot-seat Axis & Allies–style strategy game on a simplified 26-territory map of
the continental United States. 2–4 player free-for-all. No backend; state lives
in the browser with JSON export/import.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (20 LTS recommended)
- npm 9+ (ships with Node)
- A modern browser (Chrome, Edge, Firefox, or Safari)
- Git, if you want to clone / contribute

Check yours:

```bash
node --version   # want v18+
npm --version
```

## Getting set up

```bash
# 1. Clone the repo
git clone https://github.com/<you>/ai-axis-and-allies.git
cd ai-axis-and-allies

# 2. Install dependencies
npm install

# 3. Start the dev server, then open the printed URL
#    (usually http://localhost:5173) in a browser
npm run dev
```

Production build + preview:

```bash
npm run build
npm run preview  # serves dist/ at http://localhost:4173
```

## Scripts

| Command            | What it does                                  |
|--------------------|-----------------------------------------------|
| `npm run dev`      | Start the Vite dev server (`ui/`, port 5173)  |
| `npm run build`    | Type-check (`tsc --noEmit`) + build to `dist/`|
| `npm run preview`  | Serve the production build locally            |
| `npm test`         | Full test suite (engine, data, sim, UI)       |
| `npm run simulate` | Headless bot games played to an ending        |

## Test it

```bash
npm test                          # full suite (engine, data, simulation, UI)
npx vitest run tests/purchase.test.ts    # one phase at a time:
npx vitest run tests/movement.test.ts    # combat-move + non-combat
npx vitest run tests/combat.test.ts      # rounds, AA, casualties, retreat, SBR
npx vitest run tests/economy.test.ts     # mobilize, income, capitals, turn cap
npx vitest run tests/edge.test.ts        # boundary/invalid inputs for every action
npx vitest run tests/map.test.ts         # map + scenario data
npx vitest run tests/simulation.test.ts  # headless bot games to an ending
npx vitest run tests/ui.test.ts          # real DOM playthrough (jsdom)
npm run simulate                  # shorthand for the headless full-game sim
```

## Layout

- `engine/` — pure headless rules engine (`engine.ts`, `types.ts`). No UI, no I/O.
- `data/` — `map.json` (territories, IPC, adjacency, SVG layout), `units.json`
  (cost/attack/defense/move), `scenario-2p/3p/4p.json`, `data.ts` loader.
- `ui/` — plain DOM + SVG front end driving the engine through the action API.
- `tests/` — per-phase unit tests, headless simulation bot, jsdom UI playthrough.

See `ARCHITECTURE.md` for the action API and how a Phase 2 agent drives a turn.

## Rules (short)

Turn: purchase → combat move → combat → non-combat → mobilize → collect income.
Win by holding every capital in play; 20-round cap, then highest income
(tie: bank) wins. Capturing a capital transfers the victim's bank. No capital =
no purchases, no income. Aircraft must end non-combat on ground held since turn
start or they are lost. New or captured factories produce from next turn.

UI model (TripleA-inspired): the map shows US-shaped territories with owner
color, IPC, and units. A phase stepper tracks the turn. Click a territory to
inspect it; dial units with +/- steppers, then click a highlighted destination
to stage a move — staged moves preview as arrows (red = attack, green = move).
The purchase shop and battle resolution open as popup dialogs; End phase, Save,
and Load stay pinned in a bottom bar. The layout fills the viewport without
page scrolling, from laptop to ultrawide.

Note: the IPC table in the spec sums to **61**, not 64 — values kept as
specified. Four Corners point-contacts (CO–AZ, NM–UT) are not adjacency.

## Troubleshooting

- **Port 5173 already in use** — Vite will offer the next free port; use the URL
  it prints, or free the port first.
- **`npm install` fails** — delete `node_modules/` and `package-lock.json`, then
  `npm install` again. Make sure Node is v18+.
- **`npm run build` type errors** — run `npx tsc --noEmit` to see them; the
  build will not emit `dist/` until they pass.
- **Blank page in dev** — check the terminal running `npm run dev` and the
  browser devtools console for errors, then file an issue with both.
