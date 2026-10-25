# Board-space map (1942 world map)

How the 1942 map's geometry works, and why it is not a geographic projection.

## What board space is

`data/map-1942.json` lives entirely in the coordinate space of the TripleA
`world_war_ii_v5_1942` board: **3500×2000**, declared as the map's `viewBox`
with `boardSpace: true`. In that space three TripleA artifacts share one
coordinate system, so they agree with each other exactly:

- **Raster = visual ground truth.** `ui/board-1942.jpg` is the board artwork.
  The UI draws it as the first child of the pan/zoom group, under the
  interaction polygons.
- **Polygons = interaction geometry.** Territory `points` and `label` anchors
  are TripleA's `polygons.txt` / `centers.txt` values, used as traced on that
  raster — clicks, owner tints, and unit chits line up with the printed board.
- **Names = UI text at TripleA's anchors.** The base artwork prints no
  territory names or sea-zone numbers (TripleA draws that text itself), so
  board mode renders them from `nameLabel` anchors — TripleA's
  `name_place.txt` values, a separate anchor set from the `centers.txt`
  unit points.
- **XML = adjacency and setup.** Neighbor lists, starting owners, unit
  placements, and starting PUs come from the TripleA game definition
  `WW2v5_1942_2nd.xml`. Names, IPCs, capitals, and victory cities come from
  our own metadata, verified against the physical board inventory.

There is **no warping into a geographic projection**. The previous pipeline
warped traced polygons into a Natural Earth projection with spline fits, and
the seams never looked right — borders were approximations of an
approximation. Board space removes the warp entirely: the artwork the player
sees *is* the coordinate system the data was traced in, so alignment is exact
by construction rather than by fitting.

## Sources and cache

Everything the build reads is cached under `scripts/build-map/cache/`:

- `cache/triplea/polygons.txt`, `cache/triplea/centers.txt`,
  `cache/triplea/name_place.txt`, `cache/triplea/WW2v5_1942_2nd.xml` — from
  the TripleA `world_war_ii_v5_1942` map package.
- `cache/territory-meta-1942.json` — our per-territory metadata (names, IPCs,
  owners, capitals, victory cities), keyed by territory id.

## Rebuilding

```sh
node scripts/build-map/build-board-space.mjs
```

Zero dependencies; it rewrites `data/map-1942.json` and
`data/scenario-1942.json` and throws on any unmapped TripleA territory name.

The board JPEG is stitched from TripleA's `baseTiles` on their 256px grid,
with the `reliefTiles` composited over them **source-over, using the relief
tiles' own per-pixel alpha**, then cropped to 3500×2000. That is how TripleA
itself stacks the layers (`map/map.properties`: `map.hasRelief=true`,
`map.mapBlends=true`). An earlier relief attempt was rejected because it
used a linear-light blend formula that ignored the relief alpha and
oversaturated; the source-over composite is the shipped art. The tiles
themselves are **not committed** — fetch them from the `triplea-maps` repo
(`world_war_ii_v5_1942` map folder) if the JPEG ever needs regenerating.

## Palette: official power colors

Controlled territories are tinted with the controlling power's official
color. The hexes come from the TripleA `world_war_ii_v5_1942`
`map/map.properties` player-color table, cross-checked against the physical
board (the TripleA base raster prints land uncolored, so it cannot be
sampled for owner colors):

| Power | Hex | Notes |
| --- | --- | --- |
| Germany | `#5a5a5a` | gray |
| USSR | `#af2828` | maroon (properties: Russians) |
| United Kingdom | `#916400` | tan (properties: British) |
| Japan | `#e87112` | orange. Deviation: `map.properties` lists Japanese gold `#e6b42d`, but the physical 1942 board prints Japan orange, so the board wins. |
| United States | `#5a5a00` | olive (properties: Americans) |
| Neutral | `#d8ba7c` | cream (the properties Impassable tan; the board's neutral cream) |

Seat chrome (turn banner, roster dots) uses the same table via the lead
nation of each seat: Germany, USSR, Japan, United Kingdom. The merged seat
still tints per original nation on the map — British holdings tan, American
holdings olive — and captures recolor to the capturer's lead nation.

## Five powers, four seats

The board has five powers; the game has four seats. The scenario merges
British + Americans into seat 3: both powers' territories, units, and income
belong to that seat. Banks are `[41, 24, 30, 73]` (Germans 41, Russians 24,
Japanese 30, British 31 + Americans 42 = 73).

Seat 3 is a **multi-capital seat**: the scenario registers both
`united_kingdom` (primary) and `eastern_united_states` as its capitals.
Capturing either one steals seat 3's whole bank (the usual capital rule);
the seat is purchase- and income-blocked only while it holds **none** of
its capitals. Victory is a majority of the board's five capitals
(`capitalsToWin` 3). The America map is unchanged: one capital per seat.

## Canals (enforced)

Panama (`sz19`↔`sz18`) requires the moving seat to control
`central_america`; Suez (`sz17`↔`sz34`) requires control of **both**
`egypt` and `trans_jordan`. Control is evaluated at move time. The rule
lives in the engine (`canalEdgeOpen`, consulted by naval movement
validation) and in the UI's legal-destination generation, so the fleet
move dialog never offers a canal route the engine would reject; a blocked
move fails with code `canal_closed`. Land and air movement never consult
canals. Tests: `tests/canals.test.ts` (engine) and
`tests/ui-canal-dialog.test.ts` (dialog generation).

## Labels, fit, and nudges

Board-mode labels render **above** the unit chits (still
`pointer-events: none`). Eleven crowded anchors carry an explicit
`nameNudge` in the map data (emitted by the build script from its
`NAME_NUDGES` table — France, Germany, Poland, Italy, Southern Europe,
Manchuria, Anhwei, Kiangsu, Kwangtung, Japan, India); every other anchor
is TripleA's untouched. Japan's name is nudged 150 units north, clear of
its starting stack. The initial board view fits the whole 3500×2000 board
with a margin (home zoom 0.93) so edge labels — Eastern United States,
Western United States, the sz21 number — are inside the frame at game
start; pan/zoom limits derive from that home view.

Tests: `tests/map-1942.test.ts` (counts, IPC sums, graph symmetry,
board-space bounds, canals, capitals, nudges, and the scenario merge),
`tests/capitals-1942.test.ts` (multi-capital semantics),
`tests/board-labels.test.ts` (label coverage and anchors).
