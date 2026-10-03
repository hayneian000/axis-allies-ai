# Map build pipeline

Derives `data/map.json` from **real US boundary data** instead of hand-drawn
coordinates. Run with:

```
npm run build:map
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
7. **Emit** — merges geometry into `data/map.json`, preserving game metadata
   (ids, neighbors, IPC, regions, domain) from the existing file. Only
   `points`, `label`, and `lakes` are replaced.

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
