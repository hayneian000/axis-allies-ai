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

The board JPEG is stitched from TripleA's `baseTiles` on their 256px grid and
cropped to 3500×2000, **base tiles only**. A relief blend was tried and
rejected: the relief tiles carry per-pixel alpha that the linear-light blend
formula ignores, so relief areas came out wrong. The tiles themselves are
**not committed** — fetch them from the `triplea-maps` repo
(`world_war_ii_v5_1942` map folder) if the JPEG ever needs regenerating.

## Five powers, four seats

The board has five powers; the game has four seats. The scenario merges
British + Americans into seat 3: both powers' territories, units, and income
belong to that seat. Banks are `[41, 24, 30, 73]` (Germans 41, Russians 24,
Japanese 30, British 31 + Americans 42 = 73). `capitals` still lists all five
board capitals; seat 3's registered capital is `united_kingdom`.

## Known gaps

- **Canals are data-only.** Panama (`sz19`↔`sz18`, requires `central_america`)
  and Suez (`sz17`↔`sz34`, requires `egypt` + `trans_jordan`) are declared in
  the map's `canals` array, but the engine does not yet enforce the control
  requirement during movement.
- **`eastern_united_states` is not a registered seat capital.** It is listed
  in the scenario's `capitals` (it is a board capital and a victory city), but
  no seat is registered to it — seat 3 plays from `united_kingdom`.

Tests: `tests/map-1942.test.ts` (counts, IPC sums, graph symmetry, board-space
bounds, canals, and the scenario merge).
