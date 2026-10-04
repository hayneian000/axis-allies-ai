#!/usr/bin/env node
/**
 * Map build pipeline: derives data/map.json from real US boundary data.
 *
 *   1. Load us-atlas states TopoJSON -> GeoJSON (ground truth, no hand-drawing)
 *   2. Union states per territory (territories.json) -> shared borders coincide,
 *      gaps impossible by construction
 *   3. Project with d3-geo Albers into the viewBox
 *   4. Simplify (Douglas-Peucker) to a point budget
 *   5. Label placement via pole-of-inaccessibility
 *   6. Real Great Lakes polygons from Natural Earth (same projection)
 *   7. Merge geometry into data/map.json, preserving game metadata
 *      (ids, neighbors, IPC, regions) from the existing file
 *
 * Usage: npm run build:map
 * To retarget (new grouping, new region): edit territories.json.
 */
import { feature } from 'topojson-client';
import { union, simplify, area, booleanPointInPolygon } from '@turf/turf';
import { geoAlbers } from 'd3-geo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(HERE, 'territories.json'), 'utf8'));
const { width: W, height: H } = config.viewBox;
const PAD = config.projection.padding;

// ---------------------------------------------------------------- states ---
const us = require('us-atlas/states-10m.json');
const SKIP = new Set([
  'Alaska', 'Hawaii', 'Puerto Rico', 'American Samoa', 'Guam',
  'Commonwealth of the Northern Mariana Islands', 'United States Virgin Islands',
]);
const states = feature(us, us.objects.states).features.filter(
  (f) => !SKIP.has(f.properties.name),
);
const byName = new Map(states.map((s) => [s.properties.name, s]));
console.log(`loaded ${states.length} states`);

// ------------------------------------------------------------- projection ---
const allFc = { type: 'FeatureCollection', features: states };
const project = geoAlbers()
  .center(config.projection.center)
  .parallels(config.projection.parallels)
  .fitExtent(
    [[PAD, PAD], [W - PAD, H - PAD]],
    allFc,
  );
const px = ([lon, lat]) => {
  const [x, y] = project([lon, lat]);
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
};
const projectRing = (ring) => ring.map(px);
const projectGeom = (geom) => {
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: geom.coordinates.map(projectRing) };
  return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(projectRing)) };
};
// All significant polygons of a (multi)polygon by area, largest first.
// Territories are NOT always contiguous (e.g. Michigan has two peninsulas).
// Polygons smaller than 2% of the largest are dropped as noise/islands.
function allPolygons(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const withArea = polys.map((p) => ({
    poly: p,
    area: area({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p } }),
  }));
  withArea.sort((a, b) => b.area - a.area);
  const largest = withArea[0]?.area ?? 0;
  return withArea
    .filter((x) => x.area >= largest * 0.02)
    .map((x) => x.poly); // each: [exterior, ...holes]
}
/** Pole of inaccessibility: grid search for the interior point farthest from edges.
 *  All in pixel space (Euclidean). */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function polylabel(ring) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const poly = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  const distToEdge = (x, y) => {
    let d = 1e9;
    for (let i = 0; i < ring.length - 1; i++) {
      const dd = distToSegment(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
      if (dd < d) d = dd;
    }
    return d;
  };
  let best = null, bestD = -1;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = minX + (maxX - minX) * (i / steps);
      const y = minY + (maxY - minY) * (j / steps);
      const pt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, y] } };
      if (!booleanPointInPolygon(pt, poly)) continue;
      const d = distToEdge(x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best ?? [(minX + maxX) / 2, (minY + maxY) / 2];
}
const simpTol = config.simplify.tolerancePx;
function simplifyRing(ring) {
  const f = simplify(
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
    { tolerance: simpTol, highQuality: false },
  );
  return f.geometry.coordinates[0].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

// ------------------------------------------------------------ territories ---
const built = [];
for (const t of config.territories) {
  const feats = t.states.map((name) => {
    const s = byName.get(name);
    if (!s) throw new Error(`state not found: ${name}`);
    return s;
  });
  let merged;
  if (feats.length === 1) {
    merged = { type: 'Feature', properties: {}, geometry: feats[0].geometry };
  } else {
    const fc = { type: 'FeatureCollection', features: feats.map((f, i) => ({ type: 'Feature', properties: { i }, geometry: f.geometry })) };
    merged = union(fc);
  }
  if (!merged) throw new Error(`union failed for ${t.id}`);
  const projected = projectGeom(merged.geometry);
  const polys = allPolygons(projected);
  const poly = polys[0];
  let ring = simplifyRing(poly[0]);
  // enforce point budget
  let tol = simpTol;
  while (ring.length > config.simplify.maxPoints && tol < 20) {
    tol *= 1.5;
    const f = simplify(
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [poly[0]] } },
      { tolerance: tol, highQuality: false },
    );
    ring = f.geometry.coordinates[0].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  if (ring.length < config.simplify.minPoints) {
    console.warn(`  ${t.id}: only ${ring.length} points after simplify`);
  }
  const [lx, ly] = polylabel(ring);
  const label = [Math.round(lx), Math.round(ly)];
  const entry = { id: t.id, points: ring, label };
  // Extra disjoint polygons (e.g. Michigan's Upper Peninsula) — simplified separately.
  if (polys.length > 1) {
    entry.extraPolygons = polys.slice(1).map((p) => simplifyRing(p[0]));
    console.log(`  ${t.id}: ${ring.length} pts + ${entry.extraPolygons.length} extra polygon(s)`);
  } else {
    console.log(`  ${t.id}: ${ring.length} pts`);
  }
  built.push(entry);
}

// ------------------------------------------------------------------ lakes ---
let lakes = [];
try {
  const cachePath = path.join(CACHE, 'ne_110m_lakes.geojson');
  let lakesGj;
  if (fs.existsSync(cachePath)) {
    lakesGj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log('lakes: from cache');
  } else {
    console.log('lakes: fetching Natural Earth…');
    const res = await fetch(config.lakes.source);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lakesGj = await res.json();
    fs.writeFileSync(cachePath, JSON.stringify(lakesGj));
  }
  for (const name of config.lakes.names) {
    const f = lakesGj.features.find(
      (x) => x.properties && x.properties.name === name,
    );
    if (!f) { console.warn(`  lake not found: ${name}`); continue; }
    const projected = projectGeom(f.geometry);
    const poly = largestPolygon(projected);
    const ring = simplify(
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [poly[0]] } },
      { tolerance: config.lakes.simplifyTolerancePx, highQuality: false },
    ).geometry.coordinates[0].map(([x, y]) => [Math.round(x), Math.round(y)]);
    lakes.push({ name, points: ring });
    console.log(`  lake ${name}: ${ring.length} pts`);
  }
} catch (e) {
  console.warn('lakes: skipped —', e.message);
}

// --------------------------------------------------------------------- IPC ---
// Derive IPCs from real economic data (BEA state GDP). Each territory's IPC
// is proportional to its share of total GDP, floored at 1, normalized via
// largest-remainder to TOTAL_IPC so the game-economy invariant holds.
const TOTAL_IPC = 61;
const gdp = JSON.parse(fs.readFileSync(path.join(HERE, 'gdp.json'), 'utf8'));
const gdpByTerritory = new Map();
let gdpTotal = 0;
for (const t of config.territories) {
  let g = 0;
  for (const name of t.states) {
    const v = gdp.values[name];
    if (v == null) throw new Error(`GDP missing for ${name}`);
    g += v;
  }
  gdpByTerritory.set(t.id, g);
  gdpTotal += g;
}
const ipcExact = new Map();
for (const [id, g] of gdpByTerritory) ipcExact.set(id, (g / gdpTotal) * TOTAL_IPC);
// floor at 1, then largest remainder to hit TOTAL_IPC exactly
const ipcFloor = new Map();
let assigned = 0;
for (const [id, exact] of ipcExact) {
  const f = Math.max(1, Math.floor(exact));
  ipcFloor.set(id, f);
  assigned += f;
}
let remainder = TOTAL_IPC - assigned;
if (remainder !== 0) {
  const byFrac = [...ipcExact.entries()]
    .map(([id, exact]) => [id, exact - Math.floor(exact)])
    .sort((a, b) => remainder > 0 ? b[1] - a[1] : a[1] - b[1]);
  for (let i = 0; i < Math.abs(remainder); i++) {
    const id = byFrac[i % byFrac.length][0];
    ipcFloor.set(id, ipcFloor.get(id) + Math.sign(remainder));
  }
}
for (const [id, ipc] of ipcFloor) {
  console.log(`  ipc ${id}: ${ipc} (gdp $${(gdpByTerritory.get(id) / 1000).toFixed(1)}B)`);
}
const ipcSum = [...ipcFloor.values()].reduce((a, b) => a + b, 0);
if (ipcSum !== TOTAL_IPC) throw new Error(`IPC sum ${ipcSum} != ${TOTAL_IPC}`);

// ------------------------------------------------------------------- emit ---
const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/map.json'), 'utf8'));
const prevById = new Map(prev.territories.map((t) => [t.id, t]));
const territories = built.map((b) => {
  const p = prevById.get(b.id);
  if (!p) throw new Error(`no metadata for ${b.id}`);
  return { ...p, points: b.points, label: b.label, ipc: ipcFloor.get(b.id) };
});
const out = { ...prev, territories, lakes };
fs.writeFileSync(path.join(ROOT, 'data/map.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote data/map.json (${territories.length} territories, ${lakes.length} lakes)`);
