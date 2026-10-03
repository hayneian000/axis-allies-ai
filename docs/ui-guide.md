# UI guide

The UI (`ui/index.html`, `ui/main.ts`, `ui/style.css`) is plain DOM + SVG
driving the engine through the action API. It keeps no game state beyond UI
drafts (selections, staged moves, steppers).

## Design tokens

`ui/style.css` defines the theme as CSS custom properties on `:root`. Use
tokens for every color — no hardcoded hex outside the token block.

| Token | Value | Use |
|-------|-------|-----|
| `--bg` / `--bg2` | `#14161c` / `#191d26` | App background, layered map backdrop |
| `--panel` / `--panel2` | `#202634` / `#262d3e` | Cards, dialogs, inspector |
| `--border` | `#313b50` | Dividers, card outlines |
| `--text` / `--muted` / `--faint` | `#edf1f7` / `#9aa5b8` / `#67718a` | Text hierarchy |
| `--accent` / `--accent-ink` / `--accent-soft` | `#5b8cff` / `#0a1022` / 14% wash | Primary actions, current player, selection |
| `--danger` / `--danger-soft` | `#ff5d5d` / 10% wash | Attacks, destructive actions |
| `--ok` / `--ok-soft` | `#43d68a` / 10% wash | Friendly moves, confirmations |
| `--warn` | `#ffb020` | Cautions |
| `--radius` | `10px` | Card/dialog corner radius |
| `--shadow` | `0 8px 28px rgba(0,0,0,.45)` | Dialog elevation |

Player colors live in `ui/main.ts` (distinct hues per player, used for
territory fills, roster dots, the topbar's current-player indicator).

## DOM conventions (the contract)

`tests/ui.test.ts` asserts on these — restyle freely, but don't rename or
restructure without updating the test (see [browser-testing](browser-testing.md)):

- Element ids: `#map .terr`, `#buy-infantry`, `#buy-remaining`,
  `#mv-infantry`, `#cas-attacker-apply`, `#modal-body`, `#modal-close`,
  `#endPhaseBtn`, `#newBtn`, `#tab-chat`, `#chatText`, `#chatSend`, …
- Button labels the test clicks: `Buy units…`, `Buy`, `Launch moves`,
  `No moves`, `Roll one round`, `Auto`.
- Move-destination buttons carry `data-dest="<territory-id>"`.
- Territory `fill` attributes encode ownership.

Two historical bugs to not reintroduce: `#game { display: flex }` and
`#chatwrap { display: flex }` overrode those elements' `hidden` attributes —
the guards `#game[hidden] { display: none }` / `#chatwrap[hidden]
{ display: none }` exist for a reason.

## Layout model

The app fills the viewport with no page scroll (laptop → ultrawide): a setup
screen, then a game shell with topbar (stat chips), phase stepper, roster +
map + inspector, and a footer with log/chat tabs and End Phase. Modals (shop,
move planner, battle) are popups over the board.

## Changing the UI

1. Keep the phase flow — the stepper order is
   purchase → combatMove → combat → nonCombat → mobilize; the engine enforces
   it, the UI must not fight it.
2. New interactive controls get ids and go into `tests/ui.test.ts` the same
   way existing ones did.
3. Run `npm test`, then `npm run screenshots` and eyeball the 8 captures
   against the last reviewed set in `docs/screenshots/`.
4. For visual changes worth reviewing, build a before/after contact sheet and
   put it in `docs/screenshots/` with a descriptive name (the UI-polish PR's
   `ui-polish-sheet1/2.svg` are the template).

## Accessibility / motion

Focus states are styled, touch targets on steppers are enlarged, and
`prefers-reduced-motion` disables transitions. Keep it that way.
