# Style & Branding Guide — Axis & Allies, not Risk

## The one-line direction

**War room, not board-game café.** The visual reference is the 1942-edition
staff map — muted terrain, military color register, stencil type — not the
vibrant Milton Bradley classic (which is exactly what reads as "Risk").

A&A's own board history proves the point: the classic edition used largely
vibrant colors; the Revised went darker; the 1942/Anniversary editions use
realistic terrain with only *subtle hints of color* to show control. We follow
the 1942 direction.

---

## Color

### Player colors — military register, not primaries

Today: pure red / blue / green / orange floods. That is the single most
Risk-like thing on screen. Replace with desaturated military tones that stay
distinguishable:

| Player | Name | Hex | Notes |
|---|---|---|---|
| 1 | Olive Drab | `#6B7A3F` | US-army green; the "America" color |
| 2 | Slate Navy | `#3E5A78` | muted steel blue, not Risk blue |
| 3 | Burgundy | `#7E3B3B` | maroon register, A&A Soviet nod |
| 4 | Desert Tan | `#B49B62` | khaki/tan, A&A UK nod |
| Neutral | Field Gray | `#6E6E6A` | warm gray, recedes |

These echo the official A&A power colors (US green, German gray, UK tan,
Soviet maroon, Japan orange) without copying them — our game is a US
free-for-all, not WWII powers.

### Map base — parchment terrain

- **Land:** warm parchment/khaki `#C9B98A`→`#BFAE7E` gradient, with a subtle
  paper-grain/noise texture. One base for all land — control is shown by
  *tint*, not by repainting the territory.
- **Control tint:** player color washed over the parchment at ~30–35%
  opacity + a 2px border in the full player color. (This is the 1942-board
  convention: terrain first, control as annotation.)
- **Water:** deep slate-navy `#22303E`→`#1A2530`, near-black blue. Never
  bright or cyan. Lakes slightly lighter `#2E4256`.
- **Borders:** dark umber `#2A2419` at 1.5px between territories; player-color
  borders only on the outer edge of controlled groups is overkill — per-tile
  is fine.

### Chrome

- **Panels:** charcoal `#20242E` with 1px brass `#8A734D` keylines.
- **Accents:** brass/gold `#C9A227` for IPC values, capital stars, primary
  buttons. Brass = the "war room" metal.
- **Text:** warm off-white `#E8E2D2` (paper white, not blue-white).
- **Danger/attacks:** keep a restrained signal red `#A63A3A`, used sparingly
  (battle markers only).

---

## Typography

Two faces, no more:

- **Display:** a military stencil for headers, territory names, and the
  title. *Black Ops One* (Google Fonts, OFL) is the practical pick — real
  stencil cut, readable at map-label sizes.
- **Text/UI:** a condensed grotesque for everything else. *Barlow Condensed*
  (Google Fonts) has the technical-manual feel; *Inter* is the safe fallback.
- **Numbers:** tabular figures for all IPC values, unit counts, and banks
  (Barlow Condensed has them; otherwise `font-variant-numeric: tabular-nums`).
  IPC values are data — they should line up like a ledger.

Territory labels: small-caps stencil, dark umber ink `#2A2419` directly on
the parchment (no glow, no white text on bright fill — that was the Risk
look).

---

## Map treatment

- **IPC values** printed *on the territory* in the board's manner: small
  brass-on-umber lozenge, top-center of the tile — not a floating white pill.
- **Capitals:** keep the gold star, but render it as a roundel (circle in
  player color, brass star) pinned near the label, like a control marker.
- **Units:** keep the NATO symbols (they're the right language), but mount
  them as **cardboard chits**: rounded-square counter in buff `#D8C99A` with
  the symbol in umber and the count beside it. Nod to the physical game and
  to A&A's plastic chips (gray = 1, green = 3, red = 5 — we can tint chit
  edges by stack size later).
- **Battles:** crosshair/marker in signal red, not emoji.
- **Selection:** brass corner brackets on the tile, not a glow wash.
- **No:** drop shadows under tiles, glossy sheens, saturated gradients.

## Chrome & components

- Panels read as **operations-board furniture**: charcoal, brass keylines,
  stencil section headers ("PURCHASE", "COMBAT MOVE").
- Buttons are **metal plates**: flat brass for primary, dark steel for
  secondary, 2px radius max. No pill buttons, no blue-primary SaaS look.
- The phase stepper becomes a **campaign ribbon**: numbered brass tabs.
- Popups are **field orders**: paper-toned cards (`#D8C99A`) with umber text,
  pinned with a brass corner — dispatches, not tooltips.

## Motion

Restrained and mechanical. 120–180ms eases, no bounce, no spring. Map pans
like a heavy board sliding; selections click like a stamp. Sound: none
(unless we later add subtle mechanical clicks).

## Imagery / texture

- One subtle paper-grain overlay for land (SVG feTurbulence, low opacity).
- Optional: faint lat/long graticule on water, like a printed map.
- Compass rose in a water corner — the cheapest "this is a real map" signal
  there is.

---

## What we're removing (the Risk tells)

1. Flood-filled bright territories → tinted parchment
2. Pure red/blue/green/orange players → military register
3. White pill IPC badges → brass lozenges printed on-tile
4. Rounded SaaS buttons + blue primary → metal plates + brass
5. Clean geometric sans everywhere → stencil display + condensed text
6. Bright cyan-blue water → deep slate-navy
7. Glossy sheens and glows → matte paper

## Rollout

This is a reskin, not a rewrite. Suggested order:
1. Palette + map base (biggest single win)
2. Typography (fonts + label restyle)
3. Chits, lozenges, roundels (component pass)
4. Chrome/panels/buttons (furniture pass)
5. Texture + graticule + compass (finish)

Each step is independently shippable and screenshot-verifiable.
