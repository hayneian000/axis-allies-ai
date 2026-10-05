import { describe, expect, it } from 'vitest';
import { MAP, neighborsOf, scenarioFor } from '../data/data';

describe('map data', () => {
  it('has 26 land territories and 3 sea zones', () => {
    expect(MAP.territories).toHaveLength(29);
    const land = MAP.territories.filter((t) => t.domain === 'land');
    const sea = MAP.territories.filter((t) => t.domain === 'sea');
    expect(land).toHaveLength(26);
    expect(sea).toHaveLength(3);
    expect(sea.map((t) => t.id).sort()).toEqual(['atlantic', 'gulf', 'pacific']);
  });

  it('sea zones are worth 0 IPCs and touch coastal land', () => {
    for (const t of MAP.territories.filter((x) => x.domain === 'sea')) {
      expect(t.ipc).toBe(0);
      const coastal = t.neighbors.filter(
        (n) => MAP.territories.find((x) => x.id === n)!.domain === 'land',
      );
      expect(coastal.length, `${t.id} should border coastal land`).toBeGreaterThan(0);
    }
    // Spot-checks: pacific borders the west coast, atlantic the east, gulf the south.
    expect(neighborsOf('pacific')).toContain('california');
    expect(neighborsOf('atlantic')).toContain('new_york');
    expect(neighborsOf('gulf')).toContain('texas');
    // Sea zones link to each other via the gulf (Panama-canal abstraction).
    expect(neighborsOf('pacific')).toContain('gulf');
    expect(neighborsOf('atlantic')).toContain('gulf');
  });

  it('sums to 61 IPCs (spec table arithmetic; spec text says 64)', () => {
    const total = MAP.territories.reduce((s, t) => s + t.ipc, 0);
    expect(total).toBe(61);
  });

  it('has symmetric adjacency with no self-loops or unknown ids', () => {
    const ids = new Set(MAP.territories.map((t) => t.id));
    for (const t of MAP.territories) {
      expect(t.neighbors).not.toContain(t.id);
      for (const n of t.neighbors) {
        expect(ids.has(n)).toBe(true);
        expect(neighborsOf(n), `${t.id} lists ${n} but not vice versa`).toContain(t.id);
      }
    }
  });

  it('is fully connected across land and sea', () => {
    const visited = new Set<string>([MAP.territories[0].id]);
    const queue = [...visited];
    while (queue.length > 0) {
      for (const n of neighborsOf(queue.pop()!)) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    expect(visited.size).toBe(29);
  });

  it('does not treat Four Corners point-contacts as adjacency', () => {
    expect(neighborsOf('colorado')).not.toContain('arizona');
    expect(neighborsOf('new_mexico')).not.toContain('nevada_utah');
    expect(neighborsOf('colorado')).toContain('new_mexico');
    expect(neighborsOf('arizona')).toContain('new_mexico');
  });

  it('uses organic polygons (5+ points) for recognizable coastlines', () => {
    for (const t of MAP.territories) {
      expect(t.points.length, `${t.id} needs 5+ points`).toBeGreaterThanOrEqual(5);
    }
  });

  it('lays every polygon and label inside the viewBox', () => {
    for (const t of MAP.territories) {
      expect(t.points.length).toBeGreaterThanOrEqual(3);
      for (const [x, y] of t.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(MAP.viewBox.width);
        expect(y).toBeLessThanOrEqual(MAP.viewBox.height);
      }
      const [lx, ly] = t.label;
      expect(lx).toBeGreaterThanOrEqual(0);
      expect(ly).toBeGreaterThanOrEqual(0);
      expect(lx).toBeLessThanOrEqual(MAP.viewBox.width);
      expect(ly).toBeLessThanOrEqual(MAP.viewBox.height);
    }
  });
});

describe('scenarios', () => {
  for (const n of [2, 3, 4]) {
    it(`scenario ${n}p covers all 26 territories exactly once`, () => {
      const s = scenarioFor(n);
      const seen = new Set<string>();
      for (const h of s.holdings) {
        expect(seen.has(h.territory)).toBe(false);
        seen.add(h.territory);
      }
      for (const tid of Object.keys(s.neutrals)) {
        expect(seen.has(tid)).toBe(false);
        seen.add(tid);
      }
      expect(seen.size).toBe(26);
    });

    it(`scenario ${n}p gives every capital a factory`, () => {
      const s = scenarioFor(n);
      s.capitals.forEach((cap, i) => {
        const h = s.holdings.find((x) => x.territory === cap);
        expect(h, `${cap} must be player-owned`).toBeDefined();
        expect(h!.owner).toBe(i);
        expect(h!.factory).toBe(true);
      });
    });

    it(`scenario ${n}p holdings are contiguous per player`, () => {
      const s = scenarioFor(n);
      const ownerOf = (tid: string): number | null => {
        const h = s.holdings.find((x) => x.territory === tid);
        return h ? h.owner : null;
      };
      for (let p = 0; p < n; p++) {
        const mine = s.holdings.filter((h) => h.owner === p).map((h) => h.territory);
        expect(mine.length).toBeGreaterThan(0);
        const visited = new Set<string>([mine[0]]);
        const queue = [mine[0]];
        while (queue.length > 0) {
          for (const nb of neighborsOf(queue.pop()!)) {
            if (!visited.has(nb) && ownerOf(nb) === p) {
              visited.add(nb);
              queue.push(nb);
            }
          }
        }
        expect(visited.size, `player ${p} holdings not contiguous`).toBe(mine.length);
      }
    });

    it(`scenario ${n}p neutral garrisons are 3 infantry by default (no air/factories)`, () => {
      const s = scenarioFor(n);
      for (const [tid, u] of Object.entries(s.neutrals)) {
        // null means "use scenario neutralGarrison default" (3 infantry)
        const g = u ?? s.neutralGarrison ?? { infantry: 3 };
        const total = (g.infantry ?? 0) + (g.artillery ?? 0) + (g.tank ?? 0);
        expect(total, tid).toBeGreaterThanOrEqual(1);
        expect(total, tid).toBeLessThanOrEqual(4);
        expect(g.fighter ?? 0).toBe(0);
        expect(g.bomber ?? 0).toBe(0);
        expect(g.aa ?? 0).toBe(0);
      }
    });
  }
});
