#!/usr/bin/env node
/**
 * Board-space pipeline for the 1942 world map.
 *
 * Emits data/map-1942.json + data/scenario-1942.json entirely in TripleA's
 * 3500x2000 board space (no projection warp): polygons and label centers are
 * used exactly as traced on the TripleA board raster, adjacency / setup come
 * from the TripleA game XML, and names / IPCs / owners / capitals / victory
 * cities come from our own canonical metadata (extracted from the previous
 * map-1942 data, which was verified against the physical board inventory in
 * ~/workspace/map-1942/inventory.md).
 *
 * Inputs (all local, see cache/):
 *   cache/triplea/polygons.txt        TripleA territory polygons (board space)
 *   cache/triplea/centers.txt         TripleA label centers (board space)
 *   cache/triplea/WW2v5_1942_2nd.xml  TripleA game definition (connections,
 *                                     territory owners, unit setup, starting PUs)
 *   cache/territory-meta-1942.json    Our per-territory metadata, keyed by our
 *                                     territory id, in canonical (prev-file) order
 *
 * Usage: node scripts/build-map/build-board-space.mjs
 * Zero dependencies; the XML is parsed by hand (the file uses a small, flat
 * subset: territory / connection / territoryOwner / unitPlacement /
 * resourceGiven elements with plain attributes).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TRIPLEA = path.join(HERE, 'cache', 'triplea');
const META_PATH = path.join(HERE, 'cache', 'territory-meta-1942.json');
const MAP_OUT = path.join(ROOT, 'data', 'map-1942.json');
const SCENARIO_OUT = path.join(ROOT, 'data', 'scenario-1942.json');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}
function fail(msg) {
  throw new Error(msg);
}

// ------------------------------------------------------------------ inputs --
const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const metaIds = Object.keys(meta); // insertion order == prev-file territory order
const polygonsText = fs.readFileSync(path.join(TRIPLEA, 'polygons.txt'), 'utf8');
const centersText = fs.readFileSync(path.join(TRIPLEA, 'centers.txt'), 'utf8');
const xml = fs.readFileSync(path.join(TRIPLEA, 'WW2v5_1942_2nd.xml'), 'utf8');

// ------------------------------------------- constants copied from prev file --
// Verbatim from the previous map-1942 data (prev-map-1942.json): the map name
// string and the canal definitions are board metadata, not TripleA data.
const MAP_NAME = 'Axis & Allies 1942 Second Edition (96 land territories + 65 sea zones)';
const CANALS = [
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

// ------------------------------------------------------------- name mapping --
// TripleA territory name -> our id. Sea zones are "N Sea Zone" -> szN. Land
// names are matched by normalization (lowercase, strip periods, collapse any
// run of non-alphanumerics to a single space, trim) against the meta names,
// which came from the previous map-1942 file. Anything that still does not
// match must be listed in OVERRIDES; the script throws on unmapped names.
const OVERRIDES = {
  // TripleA spells it "Equador"; the board (and our data) uses "Ecuador".
  'Colombia Equador': 'colombia_ecuador',
};
const overridesUsed = new Set();

function normalizeName(s) {
  return s.toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const metaByNormName = new Map();
for (const [id, m] of Object.entries(meta)) {
  const k = normalizeName(m.name);
  assert(!metaByNormName.has(k), `duplicate normalized meta name "${k}"`);
  metaByNormName.set(k, id);
}

const unmapped = new Set();
function nameToId(name) {
  const sea = name.match(/^(\d+) Sea Zone$/);
  if (sea) return `sz${sea[1]}`;
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, name)) {
    overridesUsed.add(name);
    return OVERRIDES[name];
  }
  const id = metaByNormName.get(normalizeName(name));
  if (!id) {
    unmapped.add(name);
    return null;
  }
  return id;
}

// --------------------------------------------------------------- polygons.txt --
// One territory per line: `Name  < (x,y) (x,y) ... >  < ... > ...` where each
// <...> group is one disjoint polygon piece, in 3500x2000 board coordinates.
function polygonArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(a) / 2;
}

const polygonsById = new Map(); // id -> pieces, largest first
for (const line of polygonsText.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const lt = line.indexOf('<');
  assert(lt > 0, `polygons.txt line without a polygon group: ${line.slice(0, 60)}`);
  const name = line.slice(0, lt).trim();
  const id = nameToId(name);
  if (!id) continue; // collected in `unmapped`; thrown below
  const pieces = [];
  for (const g of line.matchAll(/<([^>]*)>/g)) {
    const pts = [];
    for (const p of g[1].matchAll(/\((-?\d+),(-?\d+)\)/g)) {
      pts.push([parseInt(p[1], 10), parseInt(p[2], 10)]);
    }
    if (pts.length >= 3) pieces.push(pts);
  }
  assert(pieces.length > 0, `no polygon pieces parsed for "${name}"`);
  pieces.sort((a, b) => polygonArea(b) - polygonArea(a));
  assert(!polygonsById.has(id), `duplicate polygons for id "${id}"`);
  polygonsById.set(id, pieces);
}

// ---------------------------------------------------------------- centers.txt --
// One territory per line: `Name  (x,y)`.
const centersById = new Map();
for (const line of centersText.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const m = line.match(/^(.*?)\s*\((-?\d+),(-?\d+)\)\s*$/);
  assert(m, `unparseable centers.txt line: ${line.slice(0, 60)}`);
  const id = nameToId(m[1].trim());
  if (!id) continue;
  assert(!centersById.has(id), `duplicate center for id "${id}"`);
  centersById.set(id, [parseInt(m[2], 10), parseInt(m[3], 10)]);
}

// ------------------------------------------------------------------- the XML --
const xmlTerritoryNames = [];
const xmlWaterByName = new Map();
for (const m of xml.matchAll(/<territory\s+name="([^"]+)"([^>]*)\/>/g)) {
  xmlTerritoryNames.push(m[1]);
  xmlWaterByName.set(m[1], /water="true"/.test(m[2]));
}

const connections = []; // [nameA, nameB]
for (const m of xml.matchAll(/<connection\s+t1="([^"]+)"\s+t2="([^"]+)"\s*\/>/g)) {
  connections.push([m[1], m[2]]);
}

// <initialize><ownerInitialize>: land territories NOT listed here are Neutral.
const xmlOwnerByName = new Map(); // territory name -> power name
for (const m of xml.matchAll(/<territoryOwner\s+territory="([^"]+)"\s+owner="([^"]+)"\s*\/>/g)) {
  xmlOwnerByName.set(m[1], m[2]);
}

const unitPlacements = []; // {unitType, territory, quantity, owner}
for (const m of xml.matchAll(/<unitPlacement\s+unitType="([^"]+)"\s+territory="([^"]+)"\s+quantity="(\d+)"\s+owner="([^"]+)"\s*\/>/g)) {
  unitPlacements.push({ unitType: m[1], territory: m[2], quantity: parseInt(m[3], 10), owner: m[4] });
}

const pusByPlayer = new Map(); // power name -> starting PUs
for (const m of xml.matchAll(/<resourceGiven\s+player="([^"]+)"\s+resource="([^"]+)"\s+quantity="(\d+)"\s*\/>/g)) {
  if (m[2] === 'PUs') pusByPlayer.set(m[1], parseInt(m[3], 10));
}

// Every name referenced anywhere in the XML must resolve to one of our ids.
for (const n of xmlTerritoryNames) nameToId(n);
for (const [a, b] of connections) { nameToId(a); nameToId(b); }
for (const n of xmlOwnerByName.keys()) nameToId(n);
for (const p of unitPlacements) nameToId(p.territory);
if (unmapped.size > 0) {
  fail(`Unmapped TripleA territory names (${unmapped.size}): ${[...unmapped].sort().join(' | ')}. Add them to OVERRIDES in build-board-space.mjs.`);
}
assert(xmlTerritoryNames.length === 161, `XML defines ${xmlTerritoryNames.length} territories, expected 161`);
const xmlIds = xmlTerritoryNames.map((n) => nameToId(n));
assert(new Set(xmlIds).size === 161, 'XML territory names do not map to 161 distinct ids');
for (const id of xmlIds) {
  const isWater = xmlWaterByName.get(xmlTerritoryNames[xmlIds.indexOf(id)]);
  assert((meta[id].domain === 'sea') === isWater, `XML water flag disagrees with meta domain for "${id}"`);
  assert(polygonsById.has(id), `no polygons for "${id}"`);
  assert(centersById.has(id), `no label center for "${id}"`);
}
assert(polygonsById.size === 161, `polygons.txt covers ${polygonsById.size} ids, expected 161`);
assert(centersById.size === 161, `centers.txt covers ${centersById.size} ids, expected 161`);

// ------------------------------------------------------------- map-1942.json --
const adjacency = new Map(metaIds.map((id) => [id, new Set()]));
for (const [a, b] of connections) {
  const ia = nameToId(a);
  const ib = nameToId(b);
  adjacency.get(ia).add(ib);
  adjacency.get(ib).add(ia);
}

// Horizontal wrap: connections whose label centers sit on opposite board
// edges (x differing by more than half the 3500-wide board) cross the seam.
const wrapPairs = [];
{
  const seen = new Set();
  for (const [a, b] of connections) {
    const ia = nameToId(a);
    const ib = nameToId(b);
    if (Math.abs(centersById.get(ia)[0] - centersById.get(ib)[0]) > 1750) {
      const pair = [ia, ib].sort();
      const key = pair.join('|');
      if (!seen.has(key)) {
        seen.add(key);
        wrapPairs.push(pair);
      }
    }
  }
  wrapPairs.sort((p, q) => p.join('|').localeCompare(q.join('|')));
}

const territories = metaIds.map((id) => {
  const m = meta[id];
  const pieces = polygonsById.get(id);
  const [points, ...rest] = pieces;
  const neighbors = [...adjacency.get(id)].sort();
  const label = centersById.get(id);
  let t;
  if (m.domain === 'land') {
    t = {
      id,
      name: m.name,
      states: m.states,
      region: m.region,
      neighbors,
      ipc: m.ipc,
      domain: 'land',
      points,
    };
    if (rest.length > 0) t.extraPolygons = rest;
    t.label = label;
    t.owner = m.owner;
    if (m.capital !== undefined) t.capital = m.capital;
    if (m.victoryCity !== undefined) t.victoryCity = m.victoryCity;
    t.neutral = m.neutral;
  } else {
    t = {
      id,
      name: m.name,
      domain: 'sea',
      ipc: m.ipc,
      neighbors,
      points,
    };
    if (rest.length > 0) t.extraPolygons = rest;
    t.label = label;
  }
  return t;
});

const mapOut = {
  name: MAP_NAME,
  viewBox: { width: 3500, height: 2000 },
  boardSpace: true,
  territories,
  wrapPairs,
  canals: CANALS,
};

// --- map assertions (all must pass or nothing is written) ---
{
  const land = territories.filter((t) => t.domain === 'land');
  const sea = territories.filter((t) => t.domain === 'sea');
  assert(land.length === 96, `land count ${land.length} !== 96`);
  assert(sea.length === 65, `sea count ${sea.length} !== 65`);

  const ipcByOwner = {};
  for (const t of land) ipcByOwner[t.owner] = (ipcByOwner[t.owner] ?? 0) + t.ipc;
  const expectedIpc = { ussr: 24, germany: 41, uk: 31, japan: 30, us: 42 };
  for (const [owner, sum] of Object.entries(expectedIpc)) {
    assert(ipcByOwner[owner] === sum, `IPC sum for ${owner}: ${ipcByOwner[owner]} !== ${sum}`);
  }

  assert(land.filter((t) => t.capital !== undefined).length === 5, 'capitals !== 5');
  assert(land.filter((t) => t.victoryCity !== undefined).length === 13, 'victory cities !== 13');
  assert(land.filter((t) => t.neutral).length === 16, 'neutrals !== 16');

  const byId = new Map(territories.map((t) => [t.id, t]));
  for (const t of territories) {
    for (const n of t.neighbors) {
      assert(byId.has(n), `dangling neighbor id "${n}" on "${t.id}"`);
      assert(byId.get(n).neighbors.includes(t.id), `asymmetric neighbors: ${t.id} -> ${n} but not back`);
    }
  }
  const emittedIds = new Set(territories.map((t) => t.id));
  assert(
    emittedIds.size === metaIds.length && metaIds.every((id) => emittedIds.has(id)),
    'emitted id set differs from the prev-file (meta) id set',
  );
}

// --------------------------------------------------------- scenario-1942.json --
// Five powers, four seats: UK and US share seat 3.
const POWER_TO_SEAT = { Germans: 0, Russians: 1, Japanese: 2, British: 3, Americans: 3 };
const META_OWNER_TO_POWER = {
  ussr: 'Russians',
  germany: 'Germans',
  uk: 'British',
  japan: 'Japanese',
  us: 'Americans',
  neutral: 'Neutral',
};
const UNIT_MAP = {
  infantry: 'infantry',
  artillery: 'artillery',
  armour: 'tank',
  fighter: 'fighter',
  bomber: 'bomber',
  aaGun: 'aa',
  transport: 'transport',
  submarine: 'submarine',
  destroyer: 'destroyer',
  cruiser: 'cruiser',
  carrier: 'carrier',
  battleship: 'battleship',
};
const NAVAL_TYPES = new Set(['transport', 'submarine', 'destroyer', 'cruiser', 'carrier', 'battleship']);

// XML owner per land territory (absent from ownerInitialize == Neutral), and a
// cross-check that the XML agrees with our board-verified meta owners.
const xmlOwnerById = new Map();
for (const id of metaIds) {
  if (meta[id].domain !== 'land') continue;
  const power = xmlOwnerByName.get(xmlTerritoryNames[xmlIds.indexOf(id)]) ?? 'Neutral';
  xmlOwnerById.set(id, power);
  assert(
    META_OWNER_TO_POWER[meta[id].owner] === power,
    `owner mismatch for "${id}": meta says ${meta[id].owner}, XML says ${power}`,
  );
}
const xmlNameById = new Map(xmlIds.map((id, i) => [id, xmlTerritoryNames[i]]));
for (const id of metaIds) {
  if (meta[id].domain !== 'land') continue;
  const power = xmlOwnerByName.get(xmlNameById.get(id)) ?? 'Neutral';
  assert(xmlOwnerById.get(id) === power, `internal owner inconsistency for "${id}"`);
}

const oddities = [];
// holdings: id -> Map(seat -> holding)
const holdingsById = new Map();
function holdingFor(id, seat) {
  if (!holdingsById.has(id)) holdingsById.set(id, new Map());
  const bySeat = holdingsById.get(id);
  if (!bySeat.has(seat)) bySeat.set(seat, { territory: id, owner: seat, units: {} });
  return bySeat.get(seat);
}

// A holding for every power-owned land territory, even if the XML places no
// units there (units {}).
for (const id of metaIds) {
  if (meta[id].domain !== 'land') continue;
  const power = xmlOwnerById.get(id);
  if (power !== 'Neutral') holdingFor(id, POWER_TO_SEAT[power]);
}

for (const p of unitPlacements) {
  const id = nameToId(p.territory);
  assert(id, `placement territory "${p.territory}" did not map`);
  assert(
    Object.prototype.hasOwnProperty.call(POWER_TO_SEAT, p.owner),
    `placement owner "${p.owner}" is not one of the five powers`,
  );
  const seat = POWER_TO_SEAT[p.owner];
  if (p.unitType === 'factory') {
    if (meta[id].domain === 'sea') {
      oddities.push(`factory placement in sea zone ${id} by ${p.owner} ignored`);
      continue;
    }
    if (p.quantity !== 1) oddities.push(`factory quantity ${p.quantity} in ${id} (treated as one factory)`);
    holdingFor(id, seat).factory = true;
    continue;
  }
  const unit = UNIT_MAP[p.unitType];
  assert(unit, `unresolved XML unitType "${p.unitType}"`);
  const h = holdingFor(id, seat);
  h.units[unit] = (h.units[unit] ?? 0) + p.quantity;
  if (meta[id].domain === 'land') {
    if (NAVAL_TYPES.has(unit)) oddities.push(`naval unit ${unit} placed on land ${id} by ${p.owner}`);
    const terrPower = xmlOwnerById.get(id);
    if (terrPower !== p.owner) {
      oddities.push(`${unit} x${p.quantity} in ${id} owned by ${p.owner}, but the territory is owned by ${terrPower}`);
    }
  } else if (!NAVAL_TYPES.has(unit) && unit !== 'fighter') {
    oddities.push(`non-naval unit ${unit} placed in sea zone ${id} by ${p.owner}`);
  }
}

const holdings = [];
for (const id of metaIds) {
  const bySeat = holdingsById.get(id);
  if (!bySeat) continue;
  for (const seat of [...bySeat.keys()].sort((a, b) => a - b)) {
    const h = bySeat.get(seat);
    // Stable key order: territory, owner, factory?, units (matches scenario-4p.json).
    const out = { territory: h.territory, owner: h.owner };
    if (h.factory) out.factory = true;
    out.units = h.units;
    holdings.push(out);
  }
}

const neutrals = {};
for (const id of metaIds) {
  if (meta[id].domain === 'land' && xmlOwnerById.get(id) === 'Neutral') neutrals[id] = null;
}
assert(Object.keys(neutrals).length === 16, `scenario neutrals ${Object.keys(neutrals).length} !== 16`);

// Banks: XML resourceInitialize starting PUs when present (seat 3 combines
// British + Americans), else board incomes.
let banks;
let bankSource;
if (['Germans', 'Russians', 'Japanese', 'British', 'Americans'].every((p) => pusByPlayer.has(p))) {
  banks = [
    pusByPlayer.get('Germans'),
    pusByPlayer.get('Russians'),
    pusByPlayer.get('Japanese'),
    pusByPlayer.get('British') + pusByPlayer.get('Americans'),
  ];
  bankSource = `XML resourceInitialize starting PUs (Germans ${pusByPlayer.get('Germans')}, Russians ${pusByPlayer.get('Russians')}, Japanese ${pusByPlayer.get('Japanese')}, British ${pusByPlayer.get('British')} + Americans ${pusByPlayer.get('Americans')} combined into seat 3)`;
} else {
  banks = [41, 24, 30, 73];
  bankSource = 'board incomes (the XML has no complete resourceInitialize; seat 3 = UK 31 + US 42)';
}

const scenarioOut = {
  players: 4,
  capitals: ['germany', 'russia', 'japan', 'united_kingdom', 'eastern_united_states'],
  capitalsToWin: 3,
  banks,
  holdings,
  neutrals,
  neutralGarrison: { infantry: 3 },
  note:
    'Axis & Allies 1942 Second Edition setup converted from the TripleA WW2v5_1942_2nd.xml. ' +
    'The board has five powers but this scenario has four seats: Germans = seat 0, Russians = seat 1, ' +
    'Japanese = seat 2, and British + Americans are combined into seat 3 (both powers\' territories and ' +
    'starting units belong to seat 3). capitals lists all five board capitals in seat order; seat 3\'s ' +
    'capital is united_kingdom and eastern_united_states is the fifth entry (the combined seat\'s second ' +
    `capital). Banks: ${bankSource}. ` +
    'Sea-zone holdings carry the naval starting units from the XML; land holdings cover every ' +
    'power-owned territory. Neutral territories use the default 3-infantry garrison.',
};

// --- scenario validation + totals ---
const unitsPerSeat = [0, 0, 0, 0];
const factoriesPerSeat = [0, 0, 0, 0];
for (const h of holdings) {
  for (const n of Object.values(h.units)) unitsPerSeat[h.owner] += n;
  if (h.factory) factoriesPerSeat[h.owner] += 1;
}
const seaHoldings = holdings.filter((h) => meta[h.territory].domain === 'sea');
const landHoldings = holdings.length - seaHoldings.length;

// -------------------------------------------------------------------- write --
fs.writeFileSync(MAP_OUT, `${JSON.stringify(mapOut, null, 1)}\n`);
fs.writeFileSync(SCENARIO_OUT, `${JSON.stringify(scenarioOut, null, 2)}\n`);

console.log('build-board-space: OK');
console.log(`  mapped 161/161 TripleA territories (polygons + centers + XML)`);
console.log(`  OVERRIDES used: ${overridesUsed.size > 0 ? [...overridesUsed].map((n) => `"${n}" -> ${OVERRIDES[n]}`).join(', ') : '(none)'}`);
console.log(`  map: 96 land + 65 sea, IPC ussr 24 / germany 41 / uk 31 / japan 30 / us 42, 5 capitals, 13 VCs, 16 neutrals`);
console.log(`  wrap pairs (${wrapPairs.length}): ${wrapPairs.map((p) => p.join(' <-> ')).join('; ')}`);
console.log(`  scenario: ${holdings.length} holdings (${landHoldings} land + ${seaHoldings.length} sea), 16 neutrals (null = default garrison)`);
console.log(`  units per seat: [${unitsPerSeat.join(', ')}], factories per seat: [${factoriesPerSeat.join(', ')}]`);
console.log(`  banks: [${banks.join(', ')}] from ${bankSource}`);
console.log(`  oddities: ${oddities.length > 0 ? oddities.join(' | ') : '(none)'}`);
console.log(`  wrote ${path.relative(ROOT, MAP_OUT)} and ${path.relative(ROOT, SCENARIO_OUT)}`);
