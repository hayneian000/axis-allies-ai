#!/usr/bin/env node
/**
 * Sea zone builder for the 1942 map: 65 official board sea zones from
 * TripleA's world_war_ii_v5_1942 polygons (traced from the physical board).
 *
 * Method:
 *  1. Load TripleA sea zone polygons warped to our 1600x840 projection
 *     (cache/triplea-sea-polygons.json, via Delaunay piecewise-affine warp
 *     from TripleA's 3500x2000 map using 161 land+sea control points).
 *  2. Clip each polygon to the ocean (viewBox minus land polygons) so sea
 *     zones abut our coastlines exactly: no overlap with land, no gaps.
 *  3. Sea-sea adjacency uses TripleA's official board adjacency
 *     (cache/sea-zones.json `tripleASeaNeighbors`) — NOT geometric proximity,
 *     which can create false adjacencies across land.
 *  4. Sea-land adjacency is computed geometrically: a zone borders the land
 *     territories its clipped polygon actually touches.
 *  5. Canal connections (Panama: sz19<->sz18, Suez: sz17<->sz34) are recorded
 *     in the map data `canals` array with their control requirements, but
 *     are NOT added to `neighbors` — they require engine-level conditional
 *     enforcement (see data.ts MapData.canals).
 *  6. Polar/dead-space: TripleA's zones only cover the board's ocean areas.
 *     Far Arctic/Antarctic beyond the zones renders as plain backdrop.
 *
 * Exported as buildSeaZones(landTerritories) for build-world.mjs.
 */
import { difference, featureCollection, pointOnFeature, intersect } from '@turf/turf';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'cache', 'sea-zones.json'), 'utf8'),
);
const TRIPLEA_POLYS = JSON.parse(
  fs.readFileSync(path.join(HERE, 'cache', 'triplea-sea-polygons.json'), 'utf8'),
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
const asFeature = (ring) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [ring] },
});
const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Build sea zone territories from TripleA board polygons.
 * @param {Array} landTerritories - land territory objects (points in px, with extraPolygons)
 * @returns {{seas: Array, canals: Array}} sea territories and canal definitions
 */
export function buildSeaZones(landTerritories) {
  if (CACHE.seaZones.length !== 65) {
    throw new Error(`expected 65 sea zones in cache, got ${CACHE.seaZones.length}`);
  }

  // ---- 1. Load TripleA polygons (already warped to our projection) ----
  const zonePolys = {}; // n -> array of rings
  for (const z of CACHE.seaZones) {
    const n = String(z.n);
    const polys = TRIPLEA_POLYS[n];
    if (!polys) throw new Error(`missing TripleA polygon for sea zone ${n}`);
    zonePolys[z.id] = polys.map((ring) => {
      const r = ring.map(([x, y]) => [r1(x), r1(y)]);
      if (r[0][0] !== r[r.length-1][0] || r[0][1] !== r[r.length-1][1]) {
        r.push([r[0][0], r[0][1]]);
      }
      return r;
    });
  }

  // ---- 2. Land pieces (for ocean clipping) ----
  const landPieces = [];
  for (const t of landTerritories) {
    for (const ring of [t.points, ...(t.extraPolygons || [])]) {
      const closed = ring.map(([x, y]) => [x, y]);
      closed.push([closed[0][0], closed[0][1]]);
      landPieces.push({ terrId: t.id, ring: closed, bbox: bboxOfRing(closed) });
    }
  }

  // ---- 3. Clip each TripleA polygon to the ocean ----
  // First clip to viewBox, then difference with land.
  const viewBoxRing = [[0,0],[VB_W,0],[VB_W,VB_H],[0,VB_H],[0,0]];
  const viewBoxFeat = asFeature(viewBoxRing);
  const seaPolys = {}; // id -> array of rings (largest first)
  for (const z of CACHE.seaZones) {
    const zid = z.id;
    const clipped = [];
    for (const ring of zonePolys[zid]) {
      let feat = asFeature(ring);
      // Clip to viewBox
      const vbClip = intersect(featureCollection([feat, viewBoxFeat]));
      if (!vbClip) continue;
      feat = vbClip;
      const rb = bboxOfRing(ring);
      for (const lp of landPieces) {
        if (!bboxOverlap(rb, lp.bbox)) continue;
        const d = difference(featureCollection([feat, asFeature(lp.ring)]));
        if (!d) { feat = null; break; }
        feat = d;
      }
      if (!feat) continue;
      const polys = feat.geometry.type === 'Polygon'
        ? [feat.geometry.coordinates]
        : feat.geometry.coordinates;
      for (const p of polys) {
        const r = p[0].map(([x, y]) => [r1(x), r1(y)]);
        if (r[0][0] !== r[r.length-1][0] || r[0][1] !== r[r.length-1][1]) {
          r.push([r[0][0], r[0][1]]);
        }
        if (r.length >= 4 && ringAreaPx(r) >= 5) clipped.push(r);
      }
    }
    if (clipped.length === 0) {
      throw new Error(`sea: ${zid} has no ocean area after clipping`);
    }
    clipped.sort((a, b) => ringAreaPx(b) - ringAreaPx(a));
    seaPolys[zid] = clipped;
  }

  // ---- 4. Sea-sea adjacency: TripleA official (from cache) ----
  const seaSea = {};
  for (const z of CACHE.seaZones) {
    seaSea[z.id] = new Set(z.tripleASeaNeighbors || []);
  }

  // ---- 5. Sea-land adjacency: TripleA official (from cache) ----
  // The cache's tripleALandNeighbors was derived from TripleA's board data.
  // We verify each land neighbor exists in our data.
  const seaLand = {};
  const landIds = new Set(landTerritories.map((t) => t.id));
  for (const z of CACHE.seaZones) {
    seaLand[z.id] = new Set();
    for (const lid of z.tripleALandNeighbors || []) {
      if (landIds.has(lid)) {
        seaLand[z.id].add(lid);
      } else {
        console.warn(`  sea ${z.id}: TripleA land neighbor ${lid} not in our land data`);
      }
    }
  }

  // ---- 6. Canals (conditional, not in neighbors) ----
  const canals = [
    {
      id: 'panama',
      zones: ['sz19', 'sz18'],
      requires: ['central_america'],
      description: 'Panama Canal: traversable only by the power controlling Central America',
    },
    {
      id: 'suez',
      zones: ['sz17', 'sz34'],
      requires: ['egypt', 'trans_jordan'],
      description: 'Suez Canal: traversable only by the power controlling both Egypt and Trans-Jordan',
    },
  ];

  // ---- 7. Emit ----
  const seas = [];
  for (const z of CACHE.seaZones) {
    const zid = z.id;
    const polys = seaPolys[zid];
    const main = polys[0];
    let label;
    if (z.label) {
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
    const neighbors = [...new Set([...seaSea[zid], ...seaLand[zid]])].sort();
    seas.push({
      id: zid,
      name: z.name,
      domain: 'sea',
      ipc: 0,
      neighbors,
      points: main,
      ...(polys.length > 1 ? { extraPolygons: polys.slice(1) } : {}),
      label,
    });
  }
  return { seas, canals };
}
