#!/usr/bin/env node
/**
 * World map build pipeline: derives data/map-1942.json (Axis & Allies 1942
 * Second Edition board) from real Natural Earth country boundaries.
 *
 *   1. Load Natural Earth 50m admin_0 countries (ground truth, no hand-drawing)
 *   2. Per territory (world-territories.json): union its countries, intersect
 *      optional hand-drawn divider clips, difference against everything already
 *      claimed -> shared borders coincide, gaps/overlaps impossible by
 *      construction. Order matters only within a shared-country group: the
 *      last territory sharing a country takes the remainder with no clip.
 *   3. Pre-rotate longitudes and split rings at the cut meridian (mid-Pacific
 *      for rotate [0, 0]) so direct point projection never streaks across the map
 *   4. Project with d3-geo NaturalEarth1 into the viewBox
 *   5. Simplify (Douglas-Peucker) to a point budget
 *   6. Label placement via pole-of-inaccessibility
 *   7. Neighbors computed geometrically (shared border > 0.5px; point contacts
 *      don't count) + explicit horizontal wrap pairs
 *   8. Emit data/map-1942.json in the data/map.json schema, preserving any
 *      sea zones a later stage adds (a land rebuild must not clobber them)
 *
 * Usage: npm run build:map1942
 * IPCs/owners/capitals/victory cities come from the inventory
 * (~/workspace/map-1942/inventory.md), NOT from GDP data.
 */
import {
  union, intersect, difference, simplify, area,
  booleanPointInPolygon, featureCollection,
} from '@turf/turf';
import { geoNaturalEarth1 } from 'd3-geo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeaZones } from './build-sea.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(HERE, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const config = JSON.parse(fs.readFileSync(path.join(HERE, 'world-territories.json'), 'utf8'));
const { width: W, height: H } = config.viewBox;
const PAD = config.projection.padding;
const ROT = config.projection.rotate || [0, 0];
// Pre-rotation shifts the map cut: rotate [-80, 0] would put the board's
// North-America cut at 180. Currently [0, 0]: standard mid-Pacific cut.

// ------------------------------------------------------------- utilities ---
const wrapLon = (lon) => {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Keep +180 as +180 (not -180): a ring touching the cut meridian must not
  // be torn across the map by the wrap.
  return (w === -180 && lon > 0) ? 180 : w;
};
/** Make consecutive ring points differ by <= 180deg (fixes antimeridian jumps). */
function unwrapRing(ring) {
  const out = [ring[0].slice()];
  for (let i = 1; i < ring.length; i++) {
    let [lon, lat] = ring[i];
    const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, lat]);
  }
  return out;
}
const closeRing = (pts) => {
  const r = pts.map((p) => p.slice());
  const f = r[0], l = r[r.length - 1];
  if (f[0] !== l[0] || f[1] !== l[1]) r.push(f.slice());
  return r;
};
/** Split a ring wherever it crosses the cut meridian (unwrapped space). */
function splitRingAtMeridian(ring, cut) {
  const pts = ring.slice(0, -1);
  const n = pts.length;
  const cross = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const EPS = 1e-9;
    const sa = a[0] - cut > EPS, sb = b[0] - cut > EPS;
    if (sa !== sb && Math.abs(a[0] - b[0]) < 180) {
      const t = (cut - a[0]) / (b[0] - a[0]);
      cross.push({ edge: i, pt: [cut, a[1] + t * (b[1] - a[1])] });
    }
  }
  if (cross.length < 2) return [closeRing(pts)];
  const pieces = [];
  const m = cross.length;
  for (let k = 0; k < m; k++) {
    const c0 = cross[k], c1 = cross[(k + 1) % m];
    const piece = [c0.pt];
    let i = (c0.edge + 1) % n;
    const end = (c1.edge + 1) % n;
    while (i !== end) {
      piece.push(pts[i]);
      i = (i + 1) % n;
    }
    piece.push(c1.pt);
    pieces.push(closeRing(piece));
  }
  return pieces.filter((p) => p.length >= 4);
}
const ringAreaPx = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
};
const segLen = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
const geomLength = (g) => {
  let len = 0;
  const walk = (coords) => {
    for (const ring of coords) for (let i = 0; i < ring.length - 1; i++)
      len += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  };
  if (!g) return 0;
  if (g.type === 'LineString') walk([g.coordinates]);
  else if (g.type === 'MultiLineString') walk(g.coordinates);
  else if (g.type === 'GeometryCollection')
    for (const x of g.geometries) len += geomLength(x);
  return len;
};
const geomArea = (g) => {
  let a = 0;
  if (!g) return 0;
  if (g.type === 'Polygon') a += ringAreaPx(g.coordinates[0]);
  else if (g.type === 'MultiPolygon')
    for (const p of g.coordinates) a += ringAreaPx(p[0]);
  else if (g.type === 'GeometryCollection')
    for (const x of g.geometries) a += geomArea(x);
  return a;
};

// ------------------------------------------------------------------ land ---
const ls = config.landSource;
const cachePath = path.join(HERE, ls.file);
let landGj;
if (fs.existsSync(cachePath)) {
  landGj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  console.log('land: from cache');
} else {
  console.log('land: fetching Natural Earth…');
  const res = await fetch(ls.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  landGj = await res.json();
  fs.writeFileSync(cachePath, JSON.stringify(landGj));
}
const byCode = new Map();
for (const f of landGj.features) {
  if (ls.skip.includes(f.properties[ls.key])) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  byCode.set(f.properties[ls.key], polys.map((p) => [unwrapRing(p[0]), ...p.slice(1).map(unwrapRing)]));
}
for (const t of config.territories) {
  for (const c of t.countries || []) {
    if (!byCode.has(c)) throw new Error(`territory ${t.id}: unknown country code ${c}`);
  }
}
console.log(`land: ${byCode.size} countries`);

const asFeature = (polys) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'MultiPolygon', coordinates: polys },
});
// Claimed geometry per country code: a territory is differenced against each
// prior piece's ORIGINAL geometry (not a merged union), so shared borders keep
// bit-identical vertices for the exact neighbor matching below.
const claimedByCountry = new Map(); // code -> Feature[]
const built = []; // { cfg, lonlatPolys }
for (const t of config.territories) {
  const countryPolys = (t.countries || []).flatMap((c) => byCode.get(c));
  let geom;
  if (countryPolys.length === 0) {
    throw new Error(`territory ${t.id}: no countries`);
  } else if (countryPolys.length === 1 && !t.clip) {
    geom = asFeature(countryPolys);
  } else {
    let base;
    if (countryPolys.length === 1) {
      base = asFeature(countryPolys);
    } else {
      // Do NOT turf-union: union rewrites vertices, breaking exact
      // shared-segment neighbor matching. Keep a MultiPolygon with the
      // original vertices (a faint internal line may render; accuracy wins).
      base = asFeature(countryPolys);
    }
    if (t.clip) {
      // Normalize: clip must be an array of rings; tolerate a bare ring.
      const rings = (typeof t.clip[0][0] === 'number') ? [t.clip] : t.clip;
      const clipFeat = {
        type: 'Feature', properties: {},
        geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [unwrapRing(closeRing(r))]) },
      };
      const piece = intersect(featureCollection([base, clipFeat]));
      if (!piece) {
        // Tiny island not present in Natural Earth: use the clip box directly.
        console.warn(`  ${t.id}: clip matched no country geometry, using raw clip polygon`);
        geom = clipFeat;
      } else {
        const pc = piece.geometry.type === 'Polygon' ? [piece.geometry.coordinates] : piece.geometry.coordinates;
        geom = asFeature(pc);
      }
    } else {
      geom = base;
    }
  }
  const prior = (t.countries || []).flatMap((c) => claimedByCountry.get(c) || []);
  if (prior.length > 0) {
    let rest = geom;
    for (const p of prior) {
      const d = difference(featureCollection([rest, p]));
      if (!d) throw new Error(`territory ${t.id}: nothing left after differencing claimed`);
      rest = d;
    }
    const rc = rest.geometry.type === 'Polygon' ? [rest.geometry.coordinates] : rest.geometry.coordinates;
    geom = asFeature(rc);
  }
  const gc0 = geom.geometry.type === 'Polygon' ? [geom.geometry.coordinates] : geom.geometry.coordinates;
  // extras: additional (countries, clip) regions unioned into this territory
  // (e.g. Kaliningrad for germany). Concatenated, not turf-unioned, to keep
  // original vertices for neighbor matching.
  let allPolys = gc0;
  for (const ex of t.extras || []) {
    const exPolys = (ex.countries || []).flatMap((c) => byCode.get(c));
    if (exPolys.length === 0) throw new Error(`territory ${t.id}: extras no countries`);
    let exGeom = asFeature(exPolys);
    if (ex.clip) {
      const rings = (typeof ex.clip[0][0] === 'number') ? [ex.clip] : ex.clip;
      const clipFeat = {
        type: 'Feature', properties: {},
        geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [unwrapRing(closeRing(r))]) },
      };
      const piece = intersect(featureCollection([exGeom, clipFeat]));
      if (!piece) throw new Error(`territory ${t.id}: extras empty clip intersection`);
      const pc = piece.geometry.type === 'Polygon' ? [piece.geometry.coordinates] : piece.geometry.coordinates;
      exGeom = asFeature(pc);
    }
    const exPrior = (ex.countries || []).flatMap((c) => claimedByCountry.get(c) || []);
    if (exPrior.length > 0) {
      let rest = exGeom;
      for (const p of exPrior) {
        const d = difference(featureCollection([rest, p]));
        if (!d) throw new Error(`territory ${t.id}: extras nothing left after differencing`);
        rest = d;
      }
      const rc = rest.geometry.type === 'Polygon' ? [rest.geometry.coordinates] : rest.geometry.coordinates;
      exGeom = asFeature(rc);
    }
    const exGc = exGeom.geometry.type === 'Polygon' ? [exGeom.geometry.coordinates] : exGeom.geometry.coordinates;
    allPolys = allPolys.concat(exGc);
    for (const c of ex.countries || []) {
      const arr = claimedByCountry.get(c) || [];
      arr.push(exGeom);
      claimedByCountry.set(c, arr);
    }
  }
  const gc = allPolys;
  for (const c of t.countries || []) {
    const arr = claimedByCountry.get(c) || [];
    arr.push(geom);
    claimedByCountry.set(c, arr);
  }
  built.push({ cfg: t, lonlatPolys: gc });
  console.log(`  ${t.id}: ${gc.length} polygon(s)`);
}

// --------------------------------------------------------------- neighbors ---
// Exact shared-border detection in lon/lat space (pre-projection, pre-split).
// Two territories are neighbors iff they share at least one boundary SEGMENT
// (identical endpoints after rounding). Shared NE borders and shared clip edges
// produce identical vertices through the turf ops; point contacts share only a
// vertex (no segment); narrow straits share nothing. No distance thresholds.
const segKey = (a, b) => {
  const r = (x) => Math.round(x * 1e6);
  const k1 = r(a[0]) + ',' + r(a[1]), k2 = r(b[0]) + ',' + r(b[1]);
  return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
};
const bboxLL = (polys) => {
  const a = [1e9, 1e9, -1e9, -1e9];
  for (const p of polys) for (const r of p) for (const [x, y] of r) {
    if (x < a[0]) a[0] = x; if (y < a[1]) a[1] = y;
    if (x > a[2]) a[2] = x; if (y > a[3]) a[3] = y;
  }
  return a;
};
const bboxesLL = built.map((e) => bboxLL(e.lonlatPolys));
const segSets = built.map((e) => {
  const s = new Set();
  for (const poly of e.lonlatPolys) for (const ring of poly)
    for (let i = 0; i < ring.length - 1; i++) s.add(segKey(ring[i], ring[i + 1]));
  return s;
});
const neighborSets = built.map(() => new Set());
let pairCount = 0;
for (let i = 0; i < built.length; i++) {
  for (let j = i + 1; j < built.length; j++) {
    const [ax0, ay0, ax1, ay1] = bboxesLL[i];
    const [bx0, by0, bx1, by1] = bboxesLL[j];
    if (ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0) continue;
    pairCount++;
    const setI = segSets[i];
    let shared = false;
    outer:
    for (const poly of built[j].lonlatPolys) {
      for (const ring of poly) {
        for (let k = 0; k < ring.length - 1; k++) {
          if (setI.has(segKey(ring[k], ring[k + 1]))) { shared = true; break outer; }
        }
      }
    }
    if (shared) {
      neighborSets[i].add(built[j].cfg.id);
      neighborSets[j].add(built[i].cfg.id);
    }
  }
}
console.log(`neighbor pairs tested: ${pairCount}`);
// Explicit horizontal wrap pairs (board edges; harmless duplicates when the
// pair is already geometrically adjacent).
// Declared adjacency overrides: extraNeighbors add true board adjacencies the
// geometric pass misses (data gaps, clip artifacts); nonNeighbors remove false
// positives (islands sharing NE vertices across a strait). Each is documented
// in world-territories.json.
{
  const idSet = new Set(built.map((e) => e.cfg.id));
  const idx = (id) => built.findIndex((e) => e.cfg.id === id);
  for (const [a, b] of config.wrapPairs || []) {
    if (!idSet.has(a) || !idSet.has(b)) {
      console.warn(`  wrap pair ${a} x ${b}: id not found (sea zones deferred?)`);
      continue;
    }
    const ia = idx(a), ib = idx(b);
    neighborSets[ia].add(b);
    neighborSets[ib].add(a);
  }
  for (const [a, b] of config.extraNeighbors || []) {
    if (!idSet.has(a) || !idSet.has(b)) throw new Error(`extraNeighbors: unknown id ${a} / ${b}`);
    neighborSets[idx(a)].add(b);
    neighborSets[idx(b)].add(a);
  }
  for (const [a, b] of config.nonNeighbors || []) {
    if (!idSet.has(a) || !idSet.has(b)) throw new Error(`nonNeighbors: unknown id ${a} / ${b}`);
    neighborSets[idx(a)].delete(b);
    neighborSets[idx(b)].delete(a);
  }
}

// ------------------------- pre-rotate + split at the cut meridian ---------
// The map is cut at data-lon cutData (standard: 180, mid-Pacific). Pre-rotate
// longitudes so the cut sits at 180, split rings there, then project with an
// unrotated projection. Each split piece is wrapped back to [-180, 180] so
// direct point projection never streaks across the map.
const wrapped = built.map(({ cfg, lonlatPolys }) => {
  const shiftRing = (ring) => {
    const pre = ring.map(([lo, la]) => [lo + ROT[0], la]);
    const mean = pre.reduce((s, p) => s + p[0], 0) / pre.length;
    const k = Math.round(-mean / 360);
    return unwrapRing(pre.map(([lo, la]) => [lo + k * 360, la]));
  };
  const finish = (pieces) => pieces.map((p) => p.map(([lo, la]) => [wrapLon(lo), la]));
  const polys = [];
  for (const poly of lonlatPolys) {
    const extPieces = finish(splitRingAtMeridian(shiftRing(poly[0]), 180));
    const holePieces = [];
    for (const h of poly.slice(1)) {
      holePieces.push(...finish(splitRingAtMeridian(shiftRing(h), 180)));
    }
    const withHoles = extPieces.map((e) => [e]);
    for (const hp of holePieces) {
      const pt = {
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: hp[0] },
      };
      let placed = false;
      for (const wh of withHoles) {
        if (booleanPointInPolygon(pt, {
          type: 'Feature', properties: {},
          geometry: { type: 'Polygon', coordinates: [wh[0]] },
        })) { wh.push(hp); placed = true; break; }
      }
      if (!placed) console.warn(`  ${cfg.id}: orphan hole piece dropped`);
    }
    polys.push(...withHoles);
  }
  return { cfg, polys };
});

// ------------------------------------------------------------ projection ---
const project = geoNaturalEarth1()
  .fitExtent(
    [[PAD, PAD], [W - PAD, H - PAD]],
    {
      type: 'FeatureCollection',
      features: wrapped.flatMap((s) => s.polys.map((p) => ({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: p },
      }))),
    },
  );
const px = ([lon, lat]) => {
  const [x, y] = project([lon, lat]);
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
};
const projectRing = (ring) => ring.map(px);

/** Pole of inaccessibility: grid search for the interior point farthest from edges (pixel space). */
function polylabel(ring) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const poly = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  let best = null, bestD = -1;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = minX + (maxX - minX) * (i / steps);
      const y = minY + (maxY - minY) * (j / steps);
      const pt = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, y] } };
      if (!booleanPointInPolygon(pt, poly)) continue;
      let d = 1e9;
      for (let k = 0; k < ring.length - 1; k++) {
        const dd = segLen(x, y, ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1]);
        if (dd < d) d = dd;
      }
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

const projected = [];
for (const { cfg, polys } of wrapped) {
  const pxPolys = polys.map((p) => p.map(projectRing));
  // Dissolve adjacent pieces into unified outlines so no internal borders
  // render between merged countries. Runs AFTER neighbor detection (above),
  // which needs the original shared-border vertices — vertex rewriting here
  // is harmless. Truly disjoint pieces (islands) stay separate.
  let dissolvedGeoms;
  if (pxPolys.length === 1) {
    dissolvedGeoms = [pxPolys[0]];
  } else {
    const feats = pxPolys.map((p) => ({
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: p },
    }));
    const dissolved = union(featureCollection(feats));
    if (!dissolved) throw new Error(`${cfg.id}: dissolve failed`);
    dissolvedGeoms = dissolved.geometry.type === 'Polygon'
      ? [dissolved.geometry.coordinates]
      : dissolved.geometry.coordinates;
  }
  // All significant polygons, largest first; <2% of largest dropped.
  const withArea = dissolvedGeoms.map((p) => ({ poly: p, area: ringAreaPx(p[0]) }));
  withArea.sort((a, b) => b.area - a.area);
  const largest = withArea[0]?.area ?? 0;
  const kept = withArea.filter((x) => x.area >= largest * 0.02);
  const simp = (ring) => {
    let r = simplifyRing(ring);
    let tol = simpTol;
    while (r.length > config.simplify.maxPoints && tol < 20) {
      tol *= 1.5;
      const f = simplify(
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
        { tolerance: tol, highQuality: false },
      );
      r = f.geometry.coordinates[0].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    }
    return r;
  };
  const main = simp(kept[0].poly[0]);
  if (main.length < config.simplify.minPoints) {
    console.warn(`  ${cfg.id}: only ${main.length} points after simplify`);
  }
  const [lx, ly] = polylabel(main);
  const entry = {
    cfg,
    points: main,
    label: [Math.round(lx), Math.round(ly)],
  };
  if (kept.length > 1) {
    entry.extraPolygons = kept.slice(1).map((k) => simp(k.poly[0]));
    console.log(`  ${cfg.id}: ${main.length} pts + ${entry.extraPolygons.length} extra polygon(s)`);
  } else {
    console.log(`  ${cfg.id}: ${main.length} pts`);
  }
  projected.push(entry);
}

// -------------------------------------------------------------- assertions ---
const EXPECTED_IPC = { ussr: 24, germany: 41, uk: 31, japan: 30, us: 42 };
const ipcByOwner = {};
for (const e of projected) {
  const o = e.cfg.owner;
  ipcByOwner[o] = (ipcByOwner[o] || 0) + (o === 'neutral' ? 0 : e.cfg.ipc);
}
for (const [o, v] of Object.entries(EXPECTED_IPC)) {
  if (ipcByOwner[o] !== v) throw new Error(`IPC sum for ${o}: ${ipcByOwner[o]} != ${v}`);
}
if (projected.length !== 96) throw new Error(`expected 96 territories, got ${projected.length}`);
const neutrals = projected.filter((e) => e.cfg.neutral);
if (neutrals.length !== 16) throw new Error(`expected 16 neutrals, got ${neutrals.length}`);
const capitals = projected.filter((e) => e.cfg.capital);
if (capitals.length !== 5) throw new Error(`expected 5 capitals, got ${capitals.length}`);
const vcs = projected.filter((e) => e.cfg.victoryCity);
if (vcs.length !== 13) throw new Error(`expected 13 victory cities, got ${vcs.length}`);
for (const e of projected) {
  if (e.points.length < 3) throw new Error(`${e.cfg.id}: degenerate polygon`);
}
console.log('assertions passed: 96 territories, IPC 24/41/31/30/42, 16 neutral, 5 capitals, 13 VCs');

// ------------------------------------------------------------------- emit ---
const prevPath = path.join(ROOT, 'data/map-1942.json');
let prev = null;
if (fs.existsSync(prevPath)) prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
const territories = projected.map((e, i) => ({
  id: e.cfg.id,
  name: e.cfg.name,
  states: (e.cfg.countries || []).join(','),
  region: e.cfg.region,
  neighbors: [...neighborSets[i]].sort(),
  ipc: e.cfg.ipc,
  domain: 'land',
  points: e.points,
  ...(e.extraPolygons ? { extraPolygons: e.extraPolygons } : {}),
  label: e.label,
  owner: e.cfg.owner,
  ...(e.cfg.capital ? { capital: e.cfg.capital } : {}),
  ...(e.cfg.victoryCity ? { victoryCity: e.cfg.victoryCity } : {}),
  neutral: !!e.cfg.neutral,
}));
// Build the 65 sea zones (adapted polygons clipped to our ocean).
const seaTerritories = buildSeaZones(territories);
// Wire sea<->land adjacency both ways.
{
  const byId = new Map(territories.map((t) => [t.id, t]));
  for (const s of seaTerritories) {
    for (const lid of s.neighbors) {
      const lt = byId.get(lid);
      if (lt && !lt.neighbors.includes(s.id)) lt.neighbors.push(s.id);
    }
  }
  for (const t of territories) t.neighbors.sort();
}
territories.push(...seaTerritories);
// Preserve territories a land+sea rebuild doesn't own (safety net for
// hand-added territories; rebuilt sea zone ids are already present).
if (prev) {
  const rebuiltIds = new Set(territories.map((t) => t.id));
  for (const t of prev.territories) {
    if (!rebuiltIds.has(t.id)) territories.push(t);
  }
}
// Sea zone assertions.
{
  const ids = new Set(territories.map((t) => t.id));
  const seas = territories.filter((t) => t.domain === 'sea');
  if (seas.length !== 65) throw new Error(`expected 65 sea zones, got ${seas.length}`);
  for (const s of seas) {
    if (s.ipc !== 0) throw new Error(`${s.id}: sea zone IPC must be 0`);
    for (const n of s.neighbors) {
      if (!ids.has(n)) throw new Error(`${s.id}: dangling neighbor ${n}`);
    }
  }
  for (const t of territories) {
    for (const n of t.neighbors) {
      if (!ids.has(n)) throw new Error(`${t.id}: dangling neighbor ${n}`);
    }
  }
}
const landCount = territories.filter((t) => t.domain !== 'sea').length;
const seaCount = territories.length - landCount;
const out = {
  name: `Axis & Allies 1942 Second Edition (${landCount} land territories + ${seaCount} sea zones)`,
  viewBox: { ...config.viewBox },
  regions: config.regions,
  territories,
  wrapPairs: config.wrapPairs,
  canals: config.canals,
};
fs.writeFileSync(prevPath, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote data/map-1942.json (${territories.length} territories)`);
