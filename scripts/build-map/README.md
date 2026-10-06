# Map build pipeline

Derives `data/map.json` from **real US boundary data** instead of hand-drawn
coordinates. One-time setup, then run:

```
npm i -D us-atlas topojson-client @turf/turf d3-geo
node scripts/build-map/build.mjs
```

## How it works

1. **Ground truth** — loads `us-atlas` states TopoJSON (pinned in
   devDependencies), converts to GeoJSON. No guessing what the US looks like.
2. **Assemble** — `territories.json` maps state names → territory ids.
   Each territory's states are unioned (turf). Adjacent territories share the
   *same* boundary geometry, so gaps are impossible by construction.
3. **Project** — d3-geo Albers, fit to the `viewBox` from `territories.json`.
4. **Simplify** — Douglas-Peucker in pixel space to the configured point
   budget (`simplify.tolerancePx`, `maxPoints`).
5. **Labels** — pole-of-inaccessibility (grid search for the interior point
   farthest from edges) so labels land inside their territory.
6. **Lakes** — Great Lakes polygons from Natural Earth (cached in `cache/`),
   projected identically. Real shapes, real positions.
7. **IPCs from GDP** — `gdp.json` holds BEA nominal GDP by state (2025
   vintage). Each territory's IPC is proportional to its share of total GDP,
   floored at 1, normalized by largest-remainder to exactly 61 (the
   game-economy invariant the tests pin). Refresh the BEA vintage to update
   the economy.
8. **Emit** — merges geometry + IPCs into `data/map.json`, preserving game
   metadata (ids, neighbors, regions). Only `points`, `label`, `lakes`, and
   `ipc` are replaced.

## Retargeting

A new map (different grouping, different region) = new `territories.json`
(+ a different source dataset in step 1). The pipeline stages are reusable.
`build.mjs` is intentionally a single readable script; split it when a second
map needs it.

## Config (`territories.json`)

- `viewBox` — output coordinate space
- `projection` — `type: "albers"`, `center`, `parallels`, `padding`
- `simplify` — `tolerancePx`, `minPoints`, `maxPoints`
- `territories[]` — `{ id, states[] }` (state names as in us-atlas)
- `lakes` — Natural Earth source URL, lake names, simplify tolerance

## World map pipeline (1942 Second Edition)

`build-world.mjs` + `world-territories.json` generate `data/map-1942.json`
(the 96-territory 1942 2e board) from Natural Earth 50m country boundaries.
Run: `npm run build:map1942` (needs `@turf/turf` and `d3-geo` installed).

How it differs from the US pipeline:

- **Source** — Natural Earth `ne_50m_admin_0_countries.geojson` (cached in
  `cache/`), keyed by `ADM0_A3`. No GDP stage: IPCs, owners, capitals, and
  victory cities come straight from the board inventory in the config.
- **Splits** — where the game divides a modern country (USSR republics,
  Chinas, Mexicos, Borneo, New Guinea…), the config hand-authors a `clip`
  polygon; the territory takes (countries ∩ clip). Each territory is
  differenced against already-claimed geometry sharing its countries, so
  there are no gaps or overlaps by construction.
- **Neighbors** — exact shared-segment matching in lon/lat space (no
  distance thresholds): shared NE borders and shared clip edges produce
  bit-identical vertices. `extraNeighbors`/`nonNeighbors` in the config patch
  the few cases geometry can't see (data gaps like Kaliningrad, islands
  sharing NE vertices across a strait). `wrapPairs` adds the board's
  horizontal wrap edges.
- **Projection** — d3-geo NaturalEarth1 (config-driven `projection.type`,
  switchable later), cut at the antimeridian.
- **Sea zones deferred** — the 65 numbered sea zones are pure game
  constructs with no geographic source; the pipeline ships land-only and
  preserves any existing sea zones in `data/map-1942.json` on rebuild (it
  never clobbers territories it didn't build).
