#!/usr/bin/env node
/**
 * Sea zone builder for the 1942 map: 65 sea zones as a TRUE tiling of the
 * ocean (viewBox minus land polygons).
 *
 * Method:
 *  1. Voronoi cells of the 65 zone centers (cache/sea-zones.json `center`,
 *     taken from the prior build's label points — guaranteed inside each
 *     zone's ocean area), computed over the FULL viewBox via d3-voronoi's
 *     extent clipping. The 65 cells tile the viewBox exactly: no gaps, no
 *     overlaps, no manual rectangles.
 *  2. Each cell is clipped to the ocean by differencing the land polygons.
 *     Clipping only cuts where land overlaps, so sea-sea shared edges stay
 *     bit-identical between neighbors.
 *  3. No simplification pass: Voronoi cells are already minimal polygons,
 *     and the clipped edges follow the land build's already-simplified
 *     coastlines. Coordinates are rounded to 0.1px (deterministic, so
 *     shared edges stay identical).
 *  4. Labels via turf pointOnFeature on the largest piece.
 *
 * Neighbors (computed geometrically every build; geometry wins):
 *  - sea-sea: two zones are neighbors iff their clipped polygons share at
 *    least one boundary segment (>0.5px total, mirroring the land pipeline).
 *  - sea-land: a zone borders a land territory iff its (pre-clip) Voronoi
 *    cell overlaps that territory's polygon (>1px²). Since sea = cell − land,
 *    this is exactly the set of land the zone touches.
 * The cache keeps the TripleA-derived adjacency as reference/provenance; the
 * build logs a diff against it for review.
 *
 * Exported as buildSeaZones(landTerritories) for build-world.mjs.
 */
import { difference, featureCollection, pointOnFeature, intersect } from '@turf/turf';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { voronoi } = require('d3-voronoi');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'cache', 'sea-zones.json'), 'utf8'),
);
const WORLD_CONFIG = JSON.parse(
  fs.readFileSync(path.join(HERE, 'world-territories.json'), 'utf8'),
);
const VB_W = WORLD_CONFIG.viewBox.width;
const VB_H = WORLD_CONFIG.viewBox.height;

const ringAreaPx = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
};
const polyAreaPx = (geom) => {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let a = 0;
  for (const p of polys) {
    a += ringAreaPx(p[0]);
    for (let h = 1; h < p.length; h++) a -= ringAreaPx(p[h]);
  }
  return a;
};
const bboxOfRing = (ring) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};
const bboxOverlap = (a, b) =>
  !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
// Same segment-key technique as the land pipeline: identical endpoints
// (after rounding) => shared boundary segment. Point contacts share no segment.
const segKey = (a, b) => {
  const r = (x) => Math.round(x * 1e6);
  const k1 = r(a[0]) + ',' + r(a[1]), k2 = r(b[0]) + ',' + r(b[1]);
  return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
};
const segLen = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const asFeature = (ring) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const r3 = (x) => Math.round(x * 1000) / 1000;
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Build sea zone territories.
 * @param {Array} landTerritories - land territory objects (points in px, with extraPolygons)
 * @returns {Array} sea territory objects
 */
export function buildSeaZones(landTerritories) {
  if (CACHE.seaZones.length !== 65) {
    throw new Error(`expected 65 sea zones in cache, got ${CACHE.seaZones.length}`);
  }

  // ---- 1. Voronoi tiling of the full viewBox ----
  const centers = CACHE.seaZones.map((z) => z.center);
  const rawCells = voronoi().extent([[0, 0], [VB_W, VB_H]])(centers).polygons();
  if (rawCells.length !== 65) throw new Error(`voronoi produced ${rawCells.length} cells`);
  // d3-voronoi cells are unclosed; close + round to 3 decimals for stable keys.
  const cells = rawCells.map((poly) => {
    const ring = poly.map(([x, y]) => [r3(x), r3(y)]);
    ring.push([ring[0][0], ring[0][1]]);
    return ring;
  });

  // ---- 2. Land pieces (for ocean clipping) ----
  const landPieces = []; // {terrId, ring (closed), bbox}
  for (const t of landTerritories) {
    for (const ring of [t.points, ...(t.extraPolygons || [])]) {
      const closed = ring.map(([x, y]) => [x, y]);
      closed.push([closed[0][0], closed[0][1]]);
      landPieces.push({ terrId: t.id, ring: closed, bbox: bboxOfRing(closed) });
    }
  }

  // ---- 3. Clip each cell to the ocean ----
  // Note: where a land island sits fully inside a cell, difference() yields a
  // polygon with a hole. Holes are dropped (the sea polygon covers the island),
  // matching the established data behavior; islands are tiny and their labels
  // render above. Hole areas are tracked for the coverage accounting below.
  const seaPolys = []; // per zone: array of closed rings (rounded 0.1), largest first
  let holeAreaTotal = 0;
  for (let i = 0; i < cells.length; i++) {
    const zid = CACHE.seaZones[i].id;
    let cellFeat = asFeature(cells[i]);
    const cb = bboxOfRing(cells[i]);
    for (const lp of landPieces) {
      if (!bboxOverlap(cb, lp.bbox)) continue;
      const d = difference(featureCollection([cellFeat, asFeature(lp.ring)]));
      if (!d) { cellFeat = null; break; } // cell fully covered (shouldn't happen)
      cellFeat = d;
    }
    if (!cellFeat) throw new Error(`sea: ${zid} has no ocean area after clipping`);
    const polys = cellFeat.geometry.type === 'Polygon'
      ? [cellFeat.geometry.coordinates]
      : cellFeat.geometry.coordinates;
    const kept = [];
    for (const p of polys) {
      for (let h = 1; h < p.length; h++) holeAreaTotal += ringAreaPx(p[h]);
      const r = p[0].map(([x, y]) => [r1(x), r1(y)]);
      if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) {
        r.push([r[0][0], r[0][1]]);
      }
      if (r.length >= 4 && ringAreaPx(r) >= 1) kept.push(r);
    }
    if (kept.length === 0) throw new Error(`sea: ${zid} has no ocean area after sliver drop`);
    kept.sort((a, b) => ringAreaPx(b) - ringAreaPx(a));
    seaPolys.push(kept);
  }

  // ---- 4. Sea-sea adjacency: shared boundary segments ----
  const segSets = seaPolys.map((polys) => {
    const s = new Map(); // segKey -> length
    for (const ring of polys) {
      for (let k = 0; k < ring.length - 1; k++) {
        const key = segKey(ring[k], ring[k + 1]);
        s.set(key, (s.get(key) || 0) + segLen(ring[k], ring[k + 1]));
      }
    }
    return s;
  });
  const seaBboxes = seaPolys.map((polys) => {
    const b = [1e9, 1e9, -1e9, -1e9];
    for (const ring of polys) {
      const rb = bboxOfRing(ring);
      b[0] = Math.min(b[0], rb[0]); b[1] = Math.min(b[1], rb[1]);
      b[2] = Math.max(b[2], rb[2]); b[3] = Math.max(b[3], rb[3]);
    }
    return b;
  });
  const seaSea = CACHE.seaZones.map(() => new Set());
  for (let i = 0; i < 65; i++) {
    for (let j = i + 1; j < 65; j++) {
      if (!bboxOverlap(seaBboxes[i], seaBboxes[j])) continue;
      const si = segSets[i], sj = segSets[j];
      const [small, big] = si.size <= sj.size ? [si, sj] : [sj, si];
      let sharedLen = 0;
      for (const [key, len] of small) {
        if (big.has(key)) sharedLen += Math.min(len, big.get(key));
      }
      if (sharedLen > 0.5) {
        seaSea[i].add(CACHE.seaZones[j].id);
        seaSea[j].add(CACHE.seaZones[i].id);
      }
    }
  }

  // ---- 5. Sea-land adjacency: pre-clip cell overlaps land ----
  const seaLand = CACHE.seaZones.map(() => new Set());
  const cellBboxes = cells.map(bboxOfRing);
  const cellFeats = cells.map(asFeature);
  for (let i = 0; i < 65; i++) {
    for (const lp of landPieces) {
      if (!bboxOverlap(cellBboxes[i], lp.bbox)) continue;
      const inter = intersect(featureCollection([cellFeats[i], asFeature(lp.ring)]));
      if (inter && polyAreaPx(inter.geometry) > 1) {
        seaLand[i].add(lp.terrId);
      }
    }
  }

  // ---- 6. Geometric self-checks ----
  // By construction: cells tile the viewBox exactly; each cell minus land =
  // its sea zone. So Σ sea areas should equal ocean area plus the dropped
  // hole areas (islands covered by sea), minus rounding noise.
  const landArea = landPieces.reduce((s, lp) => s + ringAreaPx(lp.ring), 0);
  const oceanArea = VB_W * VB_H - landArea;
  const seaArea = seaPolys.reduce((s, polys) => s + polys.reduce((a, r) => a + ringAreaPx(r), 0), 0);
  const expected = oceanArea + holeAreaTotal;
  const coverageGap = Math.abs(seaArea - expected) / oceanArea;
  console.log(`  sea tiling: ocean ${oceanArea.toFixed(0)}px² + holes ${holeAreaTotal.toFixed(0)}px² = expected ${expected.toFixed(0)}px², got ${seaArea.toFixed(0)}px² (diff ${(coverageGap * 100).toFixed(3)}%)`);
  if (coverageGap > 0.005) {
    throw new Error(`sea tiling area differs from expected by ${(coverageGap * 100).toFixed(2)}%`);
  }
  // No sea-sea area overlaps (bbox-prefiltered pairwise).
  let overlapArea = 0;
  for (let i = 0; i < 65; i++) {
    for (let j = i + 1; j < 65; j++) {
      if (!bboxOverlap(seaBboxes[i], seaBboxes[j])) continue;
      for (const ri of seaPolys[i]) {
        for (const rj of seaPolys[j]) {
          const inter = intersect(featureCollection([asFeature(ri), asFeature(rj)]));
          if (inter) overlapArea += polyAreaPx(inter.geometry);
        }
      }
    }
  }
  console.log(`  sea-sea overlap: ${overlapArea.toFixed(1)}px²`);
  if (overlapArea > 100) throw new Error(`sea zones overlap by ${overlapArea.toFixed(0)}px²`);

  // ---- 7. Diff vs TripleA reference adjacency (informational) ----
  let seaDiff = 0, landDiff = 0;
  CACHE.seaZones.forEach((z, i) => {
    const refSea = new Set(z.tripleASeaNeighbors || []);
    const gotSea = seaSea[i];
    for (const n of gotSea) if (!refSea.has(n)) seaDiff++;
    for (const n of refSea) if (!gotSea.has(n)) seaDiff++;
    const refLand = new Set(z.tripleALandNeighbors || []);
    const gotLand = seaLand[i];
    for (const n of gotLand) if (!refLand.has(n)) landDiff++;
    for (const n of refLand) if (!gotLand.has(n)) landDiff++;
  });
  console.log(`  adjacency vs TripleA reference: ${seaDiff} sea-sea diffs, ${landDiff} sea-land diffs (geometry wins)`);

  // ---- 8. Emit ----
  const seas = [];
  CACHE.seaZones.forEach((z, i) => {
    const polys = seaPolys[i];
    const main = polys[0];
    let label;
    if (z.label) {
      // Explicit label override (e.g. sz5 in the Baltic, not its northern piece).
      label = z.label;
    } else {
      try {
        const pf = pointOnFeature(asFeature(main));
        label = [Math.round(pf.geometry.coordinates[0]), Math.round(pf.geometry.coordinates[1])];
      } catch {
        const bb = bboxOfRing(main);
        label = [Math.round((bb[0] + bb[2]) / 2), Math.round((bb[1] + bb[3]) / 2)];
      }
    }
    const neighbors = [...new Set([...seaSea[i], ...seaLand[i]])].sort();
    seas.push({
      id: z.id,
      name: z.name,
      domain: 'sea',
      ipc: 0,
      neighbors,
      points: main,
      ...(polys.length > 1 ? { extraPolygons: polys.slice(1) } : {}),
      label,
    });
  });
  return seas;
}
