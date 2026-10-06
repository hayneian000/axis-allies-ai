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
  it('has 96 land territories and 0 sea zones (sea zones deferred)', () => {
    expect(TS).toHaveLength(96);
    expect(TS.filter((t) => t.domain === 'land')).toHaveLength(96);
    expect(TS.filter((t) => t.domain === 'sea')).toHaveLength(0);
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
    // Islands must be isolated (no false land bridges).
    for (const id of ['japan', 'united_kingdom', 'eire', 'okinawa']) {
      expect(byId.get(id)!.neighbors, `${id} should have no land neighbors`).toHaveLength(0);
    }
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
