#!/usr/bin/env node
/**
 * Sea zone generator: derives geographically accurate sea-zone polygons for
 * the America map by subtracting the US landmass from ocean regions.
 *
 *   1. Load us-atlas states (same ground truth as build.mjs), union to land.
 *   2. For each sea zone, take its lon/lat region and turf.difference out the
 *      land -> water polygon that traces the real coastline.
 *   3. Project with the same d3-geo Albers as build.mjs, clip to the viewBox,
 *      simplify, and place labels via pole-of-inaccessibility.
 *   4. Emit { id, points, label } JSON for merging into data/map.json.
 *
 * Usage: node scripts/build-map/seazones.mjs > /tmp/seazones.json
 */
import { feature } from 'topojson-client';
import { union, difference, simplify } from '@turf/turf';
import { geoAlbers } from 'd3-geo';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'territories.json'), 'utf8'));
const { width: W, height: H } = config.viewBox;
const PAD = config.projection.padding;

// --- land mass (same as build.mjs) -----------------------------------------
const us = require('us-atlas/states-10m.json');
const SKIP = new Set([
  'Alaska', 'Hawaii', 'Puerto Rico', 'American Samoa', 'Guam',
  'Commonwealth of the Northern Mariana Islands', 'United States Virgin Islands',
]);
const states = feature(us, us.objects.states).features.filter(
  (f) => !SKIP.has(f.properties.name),
);
let land = union({ type: 'FeatureCollection', features: states });

// --- projection (same as build.mjs) -----------------------------------------
const allFc = { type: 'FeatureCollection', features: states };
const project = geoAlbers()
  .center(config.projection.center)
  .parallels(config.projection.parallels)
  .fitExtent([[PAD, PAD], [W - PAD, H - PAD]], allFc);
const px = ([lon, lat]) => {
  const [x, y] = project([lon, lat]);
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
};

// --- sea zone regions (lon/lat boxes, non-overlapping) ------------------------
// Dividers follow state lines: 42N (OR/CA), 38.5N (NJ/DE), 33N (NC/SC),
// -89 (LA/MS). Boxes extend into the ocean; land is differenced out.
const ZONES = [
  { id: 'pacific_nw',       name: 'Pacific Northwest', box: [[-128, 42], [-121, 42], [-121, 50], [-128, 50]] },
  { id: 'california_coast', name: 'California Coast',  box: [[-128, 32], [-114, 32], [-114, 42], [-128, 42]] },
  { id: 'north_atlantic',   name: 'North Atlantic',    box: [[-76, 38.5], [-63, 38.5], [-63, 47], [-76, 47]] },
  { id: 'mid_atlantic_waters', name: 'Mid-Atlantic Waters', box: [[-79, 33], [-69, 33], [-69, 38.5], [-79, 38.5]] },
  { id: 'south_atlantic',   name: 'South Atlantic',    box: [[-84, 25], [-72, 25], [-72, 33], [-84, 33]] },
  { id: 'western_gulf',     name: 'Western Gulf',      box: [[-99, 24], [-89, 24], [-89, 31], [-99, 31]] },
  { id: 'eastern_gulf',     name: 'Eastern Gulf',      box: [[-89, 24], [-80, 24], [-80, 31], [-89, 31]] },
];

const boxPoly = (box) => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: [[...box, box[0]]] },
});

function largestRing(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  polys.sort((a, b) => ringArea(b[0]) - ringArea(a[0]));
  return polys[0][0];
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++)
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a / 2);
}
// Pole of inaccessibility (grid search), pixel space.
function polylabel(ring) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const seg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let bx = 0, by = 0, bd = -1;
  const step = 4;
  for (let y = minY; y <= maxY; y += step)
    for (let x = minX; x <= maxX; x += step) {
      if (!inside(x, y)) continue;
      let d = 1e9;
      for (let i = 0; i < ring.length - 1; i++)
        d = Math.min(d, seg(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]));
      if (d > bd) { bd = d; bx = x; by = y; }
    }
  return [Math.round(bx * 10) / 10, Math.round(by * 10) / 10];
}

const out = [];
for (const z of ZONES) {
  const region = boxPoly(z.box);
  const water = difference({ type: 'FeatureCollection', features: [region, land] });
  if (!water) { console.error(`no water for ${z.id}`); continue; }
  // Project to pixel space.
  const proj = (geom) => {
    if (geom.type === 'Polygon')
      return { type: 'Polygon', coordinates: geom.coordinates.map((r) => r.map(px)) };
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map((r) => r.map(px))) };
  };
  const pgeom = proj(water.geometry);
  let ring = largestRing(pgeom);
  // Clip to viewBox.
  ring = ring.map(([x, y]) => [
    Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y)),
  ]);
  // Simplify (tolerance in px).
  const simp = simplify(
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
    { tolerance: 2, highQuality: false },
  );
  const sring = simp.geometry.coordinates[0].map(([x, y]) => [
    Math.round(x * 10) / 10, Math.round(y * 10) / 10,
  ]);
  out.push({ id: z.id, name: z.name, points: sring, label: polylabel(sring) });
  console.error(`${z.id}: ${sring.length} points`);
}
console.log(JSON.stringify(out, null, 1));
