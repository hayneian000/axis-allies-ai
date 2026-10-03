# Browser testing

The UI is tested at two layers. They complement each other — neither replaces
the other.

| Layer | Where | Speed | What it proves |
|-------|-------|-------|----------------|
| jsdom playthrough | `tests/ui.test.ts`, runs in `npm test` | ~1s | Game logic wiring: buttons call the right engine actions, dialogs open, validation errors surface, state re-renders |
| Real-browser harness | `scripts/screenshots.mjs`, run via `npm run screenshots` | ~40s | The app actually renders: layout, styling, SVG map, modals, and visual regressions — captured as PNGs you can eyeball |

## The jsdom layer (CI-friendly)

`tests/ui.test.ts` loads `ui/index.html` into jsdom, imports `ui/main.ts`, and
plays a deterministic game: 2 players, seed 7. It clicks through buying,
staging an attack via the SVG map, fighting the battle dialog (roll + Auto
casualties), finishing the turn, deploying, and sending a chat message.

**Contract the UI must keep:** the test asserts on element ids (`#map .terr`,
`#buy-infantry`, `#buy-remaining`, `#mv-infantry`, `#modal-body
button[data-dest="…"]`, `#cas-attacker-apply`, …), button labels
(`Buy units…`, `Launch moves`, `Roll one round`, …), territory `fill`
attributes, and banner text patterns. Styling changes are fine; renaming or
restructuring those hooks is not. If you add a new dialog or control, extend
this test the same way.

**What jsdom can't do:** layout, paint, real pointer events, or "does this
actually look right". That's the harness's job.

## The screenshot harness

`scripts/screenshots.mjs` launches headless Chromium (via `playwright-core`),
loads the built app, and replays the same 2-player / seed-7 playthrough as the
jsdom test — but with a real renderer — capturing 8 PNGs:

1. `01-setup.png` — setup screen
2. `02-board-purchase.png` — board in the purchase phase
3. `03-shop.png` — purchase modal with a cart dialed
4. `04-move-dialog.png` — "Plan move" dialog
5. `05-staged.png` — staged attack arrow on the map
6. `06-battle.png` — battle dialog after one rolled round
7. `07-chat.png` — chat tab with a sent message
8. `08-mobilize.png` — mobilize phase with the deploy inspector open

Output goes to `screenshots/` (gitignored) by default; pass a directory as the
first argument to change it.

```bash
npm run screenshots                  # writes screenshots/*.png
npm run screenshots -- /tmp/shots    # custom output dir
```

### Prerequisites

- `playwright-core` (devDependency — installed with `npm install`)
- A Chromium binary. The script checks `CHROME_PATH`, then common install
  locations (macOS, Linux, Windows). If none is found it tells you how to get
  one: `npx playwright install chromium` (downloads browsers on demand; the
  npm package itself never bundles one).

### The `single.html` trick

The harness does **not** use `vite preview`. Two things make a plain
`file://` load the reliable choice:

1. **Localhost is blocked.** Recent Chromium builds enforce Local Network
   Access checks that reject `http://localhost:…` navigations from automation
   contexts (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`). `file://` sidesteps
   this entirely.
2. **ES modules hate `file://`.** The Vite build emits a separate `.js`/`.css`
   pair, and module scripts plus subresources are CORS-blocked under `file://`.

So the script builds with `npx vite build --base ./` and then inlines both
assets into `dist/single.html`: the JS bundle inside `<script type="module">`,
the CSS inside `<style>`. One self-contained file, zero network requests.

Implementation note: the inlining uses a replacer *function* in
`String.replace`, not a replacement string — the minified bundle contains `$`
sequences (`$'`, `$&`) that `replace` would otherwise interpret as patterns and
corrupt the output. If you touch this code, keep the function form.

### Determinism notes

- **Seed 7, 2 players → Player 2 moves first.** Turn order is seeded, so the
  "current player" in screenshots is Player 2 (blue), not Player 1. The attack
  in the script is montana → idaho, computed from `data/scenario-2p.json`
  holdings — if the scenario changes, recompute the pair.
- **The shop modal stays open after Buy** (same phase), so the script closes it
  via `#modal-close` before continuing.
- **Entering combat with open battles auto-opens the battle dialog** (see
  `boot()` in `ui/main.ts`), so the script goes straight to "Roll one round".
- **Escape doesn't close modals** — only `#modal-close` or the backdrop click.

### Adding a scenario

Copy one of the step blocks in `scripts/screenshots.mjs`: navigate state with
the same selectors the jsdom test uses, `waitForTimeout` after each render,
`screenshot()` at the interesting moment. Keep each capture deterministic
(fixed seed, fixed clicks) so diffs mean something.

### Reviewed screenshots

Finished review sets live in `docs/screenshots/` — currently the two
before/after contact sheets from the UI polish review
(`ui-polish-sheet1.svg`, `ui-polish-sheet2.svg`), embedded in PR #1's
description. Put new review sets there with a descriptive name.

### Future: CI

Not wired up yet. The natural shape: a GitHub Actions job that installs
Playwright's Chromium, runs `npm run screenshots`, and uploads the PNGs as a
workflow artifact on every PR. The jsdom suite stays the fast blocking check;
the screenshots stay human-reviewed.
