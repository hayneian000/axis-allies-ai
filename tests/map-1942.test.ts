import { describe, expect, it } from 'vitest';
import map1942 from '../data/map-1942.json';
import scenario1942 from '../data/scenario-1942.json';
import territoryMeta from '../scripts/build-map/cache/territory-meta-1942.json';

interface T1942 {
  id: string;
  name: string;
  ipc: number;
  domain: string;
  neighbors: string[];
  points: Array<[number, number]>;
  extraPolygons?: Array<Array<[number, number]>>;
  label: [number, number];
  nameLabel: [number, number];
  owner: string;
  neutral?: boolean;
  capital?: string;
  victoryCity?: string;
}

const TS = map1942.territories as unknown as T1942[];
const byId = new Map(TS.map((t) => [t.id, t]));

const NAVAL_OR_FIGHTER = new Set([
  'transport',
  'submarine',
  'destroyer',
  'cruiser',
  'carrier',
  'battleship',
  'fighter',
]);

describe('map-1942 data (Axis & Allies 1942 Second Edition board)', () => {
  it('has 96 land territories and 65 sea zones', () => {
    expect(TS).toHaveLength(161);
    expect(TS.filter((t) => t.domain === 'land')).toHaveLength(96);
    expect(TS.filter((t) => t.domain === 'sea')).toHaveLength(65);
  });

  it('per-power IPC sums match the inventory (USSR 24 / Germany 41 / UK 31 / Japan 30 / US 42)', () => {
    const sums: Record<string, number> = {};
    for (const t of TS) {
      if (t.neutral) {
        expect(t.ipc, `${t.id} neutral should be 0 IPC`).toBe(0);
        continue;
      }
      sums[t.owner] = (sums[t.owner] || 0) + t.ipc;
    }
    expect(sums['ussr']).toBe(24);
    expect(sums['germany']).toBe(41);
    expect(sums['uk']).toBe(31);
    expect(sums['japan']).toBe(30);
    expect(sums['us']).toBe(42);
  });

  it('has 5 capitals, 13 victory cities, 16 neutrals', () => {
    expect(TS.filter((t) => t.capital)).toHaveLength(5);
    expect(TS.filter((t) => t.victoryCity)).toHaveLength(13);
    expect(TS.filter((t) => t.neutral)).toHaveLength(16);
    const capIds = TS.filter((t) => t.capital).map((t) => t.id).sort();
    expect(capIds).toEqual(
      ['eastern_united_states', 'germany', 'japan', 'russia', 'united_kingdom'].sort(),
    );
  });

  it('neighbor graph is symmetric with zero dangling references', () => {
    for (const t of TS) {
      for (const n of t.neighbors) {
        expect(byId.has(n), `${t.id} neighbors unknown ${n}`).toBe(true);
        expect(
          byId.get(n)!.neighbors,
          `${t.id} -> ${n} is not reciprocated`,
        ).toContain(t.id);
      }
    }
  });

  it('horizontal wrap pairs are present as neighbor edges', () => {
    const wraps: Array<[string, string]> = (map1942 as any).wrapPairs || [];
    expect(wraps.length).toBeGreaterThan(0);
    for (const [a, b] of wraps) {
      expect(byId.get(a)!.neighbors, `wrap ${a} -> ${b}`).toContain(b);
      expect(byId.get(b)!.neighbors, `wrap ${b} -> ${a}`).toContain(a);
    }
  });

  it('spot-check key board adjacencies (TripleA XML, board space)', () => {
    // Adjacency comes from the TripleA WW2v5_1942_2nd.xml connection list,
    // which differs from the old geo-space map in a few places (noted inline).
    const must: Record<string, string[]> = {
      france: ['germany', 'italy', 'spain_portugal'],
      germany: ['france', 'poland', 'baltic_states'],
      // Board space: Manchuria borders Buryatia, not Soviet Far East / Russia.
      manchuria: ['buryatia_ssr', 'mongolia', 'kiangsu'],
      // Board space: Russia does NOT border Ukraine SSR directly.
      russia: ['vologda', 'west_russia', 'caucasus'],
      // Board space: Ukraine SSR DOES border Caucasus (unlike the geo map).
      ukraine_ssr: ['belorussia', 'poland', 'caucasus'],
      egypt: ['libya', 'trans_jordan'],
      japan: [], // island: no land neighbors
    };
    for (const [id, ns] of Object.entries(must)) {
      for (const n of ns) {
        expect(byId.get(id)!.neighbors, `${id} -> ${n}`).toContain(n);
      }
    }
    // Islands must be isolated (no false land bridges; sea neighbors are fine).
    // Board space: the United Kingdom DOES border Eire on the board, so it is
    // not in this list.
    for (const id of ['japan', 'okinawa']) {
      const landNs = byId.get(id)!.neighbors.filter((n) => byId.get(n)!.domain === 'land');
      expect(landNs, `${id} should have no land neighbors`).toHaveLength(0);
    }
    expect(byId.get('united_kingdom')!.neighbors).toContain('eire');
  });

  it('sea zones: 65 zones numbered 1-65 with board names', () => {
    const seas = TS.filter((t) => t.domain === 'sea');
    expect(seas).toHaveLength(65);
    for (let n = 1; n <= 65; n++) {
      const z = byId.get(`sz${n}`);
      expect(z, `sz${n} exists`).toBeDefined();
      expect(z!.name).toBe(`Sea Zone ${n}`);
      expect(z!.domain).toBe('sea');
      expect(z!.ipc, `sz${n} IPC`).toBe(0);
    }
  });

  it('sea zones: no isolated zones, neighbors are symmetric', () => {
    for (const z of TS.filter((t) => t.domain === 'sea')) {
      expect(z.neighbors.length, `${z.id} should have neighbors`).toBeGreaterThan(0);
      // At least one sea-sea neighbor (open water connects).
      const seaNs = z.neighbors.filter((n) => byId.get(n)!.domain === 'sea');
      expect(seaNs.length, `${z.id} should border another sea zone`).toBeGreaterThan(0);
    }
  });

  it('sea zones: sea-land adjacency sanity (amphibious assaults)', () => {
    // SZ5 (Baltic) borders the Scandinavian/German littoral.
    const sz5 = byId.get('sz5')!;
    for (const lid of ['norway', 'sweden', 'finland', 'germany']) {
      expect(sz5.neighbors, `sz5 -> ${lid}`).toContain(lid);
      expect(byId.get(lid)!.neighbors, `${lid} -> sz5`).toContain('sz5');
    }
    // SZ17 (E. Mediterranean) borders Egypt and Trans-Jordan (Suez).
    const sz17 = byId.get('sz17')!;
    for (const lid of ['egypt', 'trans_jordan']) {
      expect(sz17.neighbors, `sz17 -> ${lid}`).toContain(lid);
      expect(byId.get(lid)!.neighbors, `${lid} -> sz17`).toContain('sz17');
    }
    // SZ53 borders the Hawaiian Islands.
    const sz53 = byId.get('sz53')!;
    expect(sz53.neighbors, 'sz53 -> hawaiian_islands').toContain('hawaiian_islands');
    expect(byId.get('hawaiian_islands')!.neighbors, 'hawaiian_islands -> sz53').toContain('sz53');
    // SZ15 (W. Mediterranean) borders Southern Europe / North Africa.
    const sz15 = byId.get('sz15')!;
    expect(sz15.neighbors, 'sz15 -> italy').toContain('italy');
  });

  it('every territory has a valid polygon (≥4 points) and a label inside the viewBox', () => {
    const { width, height } = map1942.viewBox;
    for (const t of TS) {
      // Tiny islands simplify to 4 points; the pipeline warns below minPoints=5.
      expect(t.points.length, `${t.id} points`).toBeGreaterThanOrEqual(4);
      for (const ep of t.extraPolygons || []) {
        expect(ep.length, `${t.id} extraPolygon`).toBeGreaterThanOrEqual(4);
      }
      const [lx, ly] = t.label;
      expect(lx, `${t.id} label x`).toBeGreaterThanOrEqual(0);
      expect(lx, `${t.id} label x`).toBeLessThanOrEqual(width);
      expect(ly, `${t.id} label y`).toBeGreaterThanOrEqual(0);
      expect(ly, `${t.id} label y`).toBeLessThanOrEqual(height);
    }
  });

  it('display name matches the actual land/sea counts', () => {
    const land = TS.filter((t) => t.domain === 'land').length;
    const sea = TS.filter((t) => t.domain === 'sea').length;
    expect(map1942.name).toBe(
      `Axis & Allies 1942 Second Edition (${land} land territories + ${sea} sea zones)`,
    );
  });
});

describe('map-1942 board space (TripleA 3500x2000)', () => {
  it('declares the TripleA board-space viewBox and boardSpace flag', () => {
    expect(map1942.viewBox).toEqual({ width: 3500, height: 2000 });
    expect((map1942 as any).boardSpace).toBe(true);
  });

  it('canals are exactly Panama and Suez with their control requirements', () => {
    const canals = (map1942 as any).canals as Array<{
      id: string;
      zones: string[];
      requires: string[];
    }>;
    expect(canals).toHaveLength(2);
    const byCanalId = new Map(canals.map((c) => [c.id, c]));
    expect(byCanalId.get('panama')).toMatchObject({
      zones: ['sz19', 'sz18'],
      requires: ['central_america'],
    });
    expect(byCanalId.get('suez')).toMatchObject({
      zones: ['sz17', 'sz34'],
      requires: ['egypt', 'trans_jordan'],
    });
    // Canal zones are real sea zones and requirements are real land territories.
    for (const c of canals) {
      for (const z of c.zones) expect(byId.get(z)?.domain, `${c.id} zone ${z}`).toBe('sea');
      for (const r of c.requires) expect(byId.get(r)?.domain, `${c.id} requires ${r}`).toBe('land');
    }
  });

  it('every polygon point lies within the viewBox', () => {
    const { width, height } = map1942.viewBox;
    for (const t of TS) {
      const all = [...t.points, ...(t.extraPolygons || []).flat()];
      for (const [x, y] of all) {
        expect(x, `${t.id} point x`).toBeGreaterThanOrEqual(0);
        expect(x, `${t.id} point x`).toBeLessThanOrEqual(width);
        expect(y, `${t.id} point y`).toBeGreaterThanOrEqual(0);
        expect(y, `${t.id} point y`).toBeLessThanOrEqual(height);
      }
    }
  });

  it('every label lies inside or within ~40px of its own polygon bounding box', () => {
    // Labels are the centers.txt anchors traced on the TripleA raster. A few
    // anchors for thin/coastal territories sit just outside the polygon bbox
    // (worst observed: central_america, ~34px), so allow a 40px tolerance.
    for (const t of TS) {
      const xs = t.points.map((p) => p[0]);
      const ys = t.points.map((p) => p[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const [lx, ly] = t.label;
      const dx = Math.max(minX - lx, 0, lx - maxX);
      const dy = Math.max(minY - ly, 0, ly - maxY);
      expect(
        Math.hypot(dx, dy),
        `${t.id} label [${lx},${ly}] too far from bbox [${minX},${minY}]-[${maxX},${maxY}]`,
      ).toBeLessThanOrEqual(40);
    }
  });

  it('territory id set equals the territory-meta cache keys', () => {
    expect(TS.map((t) => t.id).sort()).toEqual(Object.keys(territoryMeta).sort());
  });

  it('every territory has a nameLabel anchor (TripleA name_place.txt) inside the viewBox', () => {
    const { width, height } = map1942.viewBox;
    for (const t of TS) {
      expect(t.nameLabel, `${t.id} nameLabel present`).toBeDefined();
      const [nx, ny] = t.nameLabel;
      expect(nx, `${t.id} nameLabel x`).toBeGreaterThanOrEqual(0);
      expect(nx, `${t.id} nameLabel x`).toBeLessThanOrEqual(width);
      expect(ny, `${t.id} nameLabel y`).toBeGreaterThanOrEqual(0);
      expect(ny, `${t.id} nameLabel y`).toBeLessThanOrEqual(height);
    }
    // Spot checks against the raw name_place.txt values (name anchors are
    // authored separately from the centers.txt unit anchors — e.g. sz5's
    // name sits in the Baltic, far from its unit center).
    expect(byId.get('germany')!.nameLabel).toEqual([990, 560]);
    expect(byId.get('united_kingdom')!.nameLabel).toEqual([773, 381]);
    expect(byId.get('russia')!.nameLabel).toEqual([1764, 349]);
    expect(byId.get('sz5')!.nameLabel).toEqual([1264, 297]);
    expect(byId.get('sz19')!.nameLabel).toEqual([138, 1382]);
  });
});

describe('scenario-1942 (four-seat merge of the five board powers)', () => {
  const holdings = scenario1942.holdings as Array<{
    territory: string;
    owner: number;
    factory?: boolean;
    units: Record<string, number>;
  }>;

  it('has 4 players, merged banks, and per-seat capitals covering all 5 board capitals', () => {
    expect(scenario1942.players).toBe(4);
    // Germans 41, Russians 24, Japanese 30, British 31 + Americans 42 = 73.
    expect(scenario1942.banks).toEqual([41, 24, 30, 73]);
    // One capitals entry per seat; seat 3 (British + Americans) lists both
    // of its capitals, primary first.
    expect(scenario1942.capitals).toHaveLength(4);
    expect(scenario1942.capitals[0]).toBe('germany');
    expect(scenario1942.capitals[1]).toBe('russia');
    expect(scenario1942.capitals[2]).toBe('japan');
    expect(scenario1942.capitals[3]).toEqual(['united_kingdom', 'eastern_united_states']);
    const flat = (scenario1942.capitals as Array<string | string[]>).flatMap((c) =>
      Array.isArray(c) ? c : [c],
    );
    expect([...flat].sort()).toEqual(
      ['eastern_united_states', 'germany', 'japan', 'russia', 'united_kingdom'].sort(),
    );
    expect(scenario1942.capitalsToWin).toBe(3);
  });

  it('name nudges exist only for the documented stack-collision territories', () => {
    const nudged = TS.filter((t) => (t as { nameNudge?: [number, number] }).nameNudge);
    expect(nudged.map((t) => t.id).sort()).toEqual(
      [
        'anhwei',
        'france',
        'germany',
        'india',
        'italy',
        'japan',
        'kiangsu',
        'kwangtung',
        'manchuria',
        'poland',
        'southern_europe',
      ].sort(),
    );
    // Raw nameLabel anchors stay exactly as name_place.txt authored them.
    expect(byId.get('japan')!.nameLabel).toEqual([2744, 728]);
    expect(byId.get('germany')!.nameLabel).toEqual([990, 560]);
    // Every nudged anchor stays inside the viewBox.
    const { width, height } = map1942.viewBox;
    for (const t of nudged) {
      const [dx, dy] = (t as unknown as { nameNudge: [number, number] }).nameNudge;
      const [nx, ny] = t.nameLabel;
      expect(nx + dx).toBeGreaterThanOrEqual(0);
      expect(nx + dx).toBeLessThanOrEqual(width);
      expect(ny + dy).toBeGreaterThanOrEqual(0);
      expect(ny + dy).toBeLessThanOrEqual(height);
    }
  });

  it('has 19 sea holdings carrying naval/fighter units only', () => {
    const seaHoldings = holdings.filter((h) => byId.get(h.territory)?.domain === 'sea');
    expect(seaHoldings).toHaveLength(19);
    for (const h of seaHoldings) {
      expect(h.factory, `${h.territory} sea holding must not have a factory`).toBeFalsy();
      for (const unit of Object.keys(h.units)) {
        expect(NAVAL_OR_FIGHTER.has(unit), `${h.territory} holds non-naval unit ${unit}`).toBe(true);
      }
    }
  });

  it('has 10 factory holdings, all on land', () => {
    const factories = holdings.filter((h) => h.factory);
    expect(factories).toHaveLength(10);
    for (const h of factories) {
      expect(byId.get(h.territory)?.domain, `${h.territory} factory on land`).toBe('land');
    }
  });

  it('every holding references a real territory and a valid seat', () => {
    for (const h of holdings) {
      expect(byId.has(h.territory), `holding for unknown territory ${h.territory}`).toBe(true);
      expect(h.owner, `${h.territory} owner seat`).toBeGreaterThanOrEqual(0);
      expect(h.owner, `${h.territory} owner seat`).toBeLessThan(scenario1942.players);
    }
  });
});
