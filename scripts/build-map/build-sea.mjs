#!/usr/bin/env node
/**
 * Sea zone builder for the 1942 map: turns the adapted sea polygons
 * (cache/sea-zones.json — our-px polygons clipped to the ocean, plus
 * TripleA-derived adjacency) into data/map-1942.json sea territories.
 *
 * Geometry: 65 sea zones built via Voronoi of TripleA sea-zone centers
 * (adapted to our projection), clipped to the ocean (viewBox minus land),
 * with manual rectangles for zones the transform misplaced. See
 * cache/sea-zones.json provenance in scripts/build-map/README if present.
 *
 * Neighbors: sea-sea and sea-land adjacency from TripleA's v5_1942 map
 * topology (boundary-distance in TripleA space + explicit wrap pairs),
 * mapped to our territory ids. Independent of the geometric adaptation.
 *
 * Exported as buildSeaZones(landTerritories) for build-world.mjs.
 */
import { simplify, pointOnFeature } from '@turf/turf';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'cache', 'sea-zones.json'), 'utf8'),
);

const ringAreaPx = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
};
const bboxOf = (ring) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

/**
 * Build sea zone territories.
 * @param {Array} landTerritories - land territory objects (for neighbor wiring context)
 * @returns {Array} sea territory objects
 */
export function buildSeaZones(landTerritories) {
  const seas = [];
  for (const z of CACHE.seaZones) {
    // Simplify each polygon, drop slivers.
    const simpPolys = [];
    for (const ring of z.polygons) {
      if (ringAreaPx(ring) < 200) continue;
      const f = simplify(
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
        { tolerance: 1.5, highQuality: false },
      );
      const r = f.geometry.coordinates[0].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      if (r.length >= 4 && ringAreaPx(r) >= 200) simpPolys.push(r);
    }
    if (simpPolys.length === 0) {
      throw new Error(`sea: ${z.id} has no polygons after simplify`);
    }
    simpPolys.sort((a, b) => ringAreaPx(b) - ringAreaPx(a));
    const main = simpPolys[0];
    // Label: point on surface (guaranteed inside the main polygon).
    let label;
    try {
      const pf = pointOnFeature({
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [main] },
      });
      label = [Math.round(pf.geometry.coordinates[0]), Math.round(pf.geometry.coordinates[1])];
    } catch {
      const bb = bboxOf(main);
      label = [Math.round((bb[0] + bb[2]) / 2), Math.round((bb[1] + bb[3]) / 2)];
    }
    const neighbors = [...new Set([...z.seaNeighbors, ...z.landNeighbors])].sort();
    seas.push({
      id: z.id,
      name: z.name,
      domain: 'sea',
      ipc: 0,
      neighbors,
      points: main,
      ...(simpPolys.length > 1 ? { extraPolygons: simpPolys.slice(1) } : {}),
      label,
    });
  }
  if (seas.length !== 65) {
    throw new Error(`expected 65 sea zones, got ${seas.length}`);
  }
  return seas;
}
