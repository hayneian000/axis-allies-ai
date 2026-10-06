import { describe, expect, it } from 'vitest';
import map1942 from '../data/map-1942.json';

interface T1942 {
  id: string;
  name: string;
  ipc: number;
  domain: string;
  neighbors: string[];
  points: Array<[number, number]>;
  extraPolygons?: Array<Array<[number, number]>>;
  label: [number, number];
  owner: string;
  neutral?: boolean;
  capital?: string;
  victoryCity?: string;
}

const TS = map1942.territories as unknown as T1942[];
const byId = new Map(TS.map((t) => [t.id, t]));

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

  it('neighbor graph is symmetric', () => {
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

  it('spot-check key board adjacencies', () => {
    const must: Record<string, string[]> = {
      france: ['germany', 'italy', 'spain_portugal'],
      germany: ['france', 'poland', 'baltic_states'],
      manchuria: ['soviet_far_east', 'mongolia', 'russia'],
      russia: ['vologda', 'west_russia', 'ukraine_ssr'],
      // Note: ukraine_ssr does NOT border caucasus (Sea of Azov between them).
      ukraine_ssr: ['russia', 'poland', 'belorussia'],
      egypt: ['libya', 'trans_jordan'],
      japan: [], // island: no land neighbors
      united_kingdom: [], // island: no land neighbors
    };
    for (const [id, ns] of Object.entries(must)) {
      for (const n of ns) {
        expect(byId.get(id)!.neighbors, `${id} -> ${n}`).toContain(n);
      }
    }
    // Islands must be isolated (no false land bridges; sea neighbors are fine).
    for (const id of ['japan', 'united_kingdom', 'eire', 'okinawa']) {
      const landNs = byId.get(id)!.neighbors.filter((n) => byId.get(n)!.domain === 'land');
      expect(landNs, `${id} should have no land neighbors`).toHaveLength(0);
    }
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
