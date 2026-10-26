// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { countUnits, createGame, playerSeaForce, seaZoneForces } from '../engine/engine';
import { scenarioFor, seaZoneIds, setActiveMap } from '../data/data';

/**
 * Sea-zone starting holdings (1942 scenario): createGame must place the
 * scenario's starting fleets into sea zones via the naval.ts sea-force
 * model (zone `owner`/`units` = the fleet's owner seat; fighters ride
 * carriers of the same owner), while land coverage still counts land
 * territories only.
 */

afterEach(() => {
  setActiveMap('america');
});

describe('createGame with the world1942 map active', () => {
  it('succeeds on scenario-1942 and places all 19 starting fleets', () => {
    setActiveMap('world1942');
    const s = createGame({ numPlayers: 4, seed: 1 });

    expect(Object.keys(s.territories)).toHaveLength(161);
    expect(s.players).toHaveLength(4);
    expect(s.players[3].capital).toBe('united_kingdom');

    const occupied = seaZoneIds().filter((z) =>
      seaZoneForces(s.territories[z]).some((f) => countUnits(f.units) > 0),
    );
    expect(occupied).toHaveLength(19);
    // Every fleet is a single owner's primary force: no coexist entries.
    for (const z of occupied) {
      expect(s.territories[z].coexist, z).toBeUndefined();
      expect(s.territories[z].owner, z).not.toBeNull();
    }

    // Spot checks against data/scenario-1942.json.
    const force = (z: string, owner: number) => playerSeaForce(s.territories, z, owner).units;
    expect(s.territories.sz4.owner).toBe(1);
    expect(force('sz4', 1)).toMatchObject({ submarine: 1 });
    expect(s.territories.sz5.owner).toBe(0);
    expect(force('sz5', 0)).toMatchObject({ transport: 1, submarine: 2, cruiser: 1 });
    expect(s.territories.sz35.owner).toBe(3);
    expect(force('sz35', 3)).toMatchObject({ carrier: 1, transport: 1, fighter: 1, cruiser: 1 });
    expect(s.territories.sz56.owner).toBe(3);
    expect(force('sz56', 3)).toMatchObject({ battleship: 1, destroyer: 1, transport: 1 });

    // Carrier + its fighters, same owner seat (Japan = seat 2).
    expect(s.territories.sz37.owner).toBe(2);
    expect(force('sz37', 2)).toMatchObject({ battleship: 1, carrier: 1, fighter: 2 });
    expect(s.territories.sz50.owner).toBe(2);
    expect(force('sz50', 2)).toMatchObject({ carrier: 1, cruiser: 1, fighter: 1 });

    // A sea zone with no holding stays uncontrolled, empty waters.
    expect(s.territories.sz1.owner).toBeNull();
    expect(countUnits(s.territories.sz1.units)).toBe(0);

    // Land setup: capitals hold factories; the board's neutrals are
    // impassable in 1942 2e, so they hold NO garrison (see
    // tests/impassable.test.ts for the full behavior suite).
    expect(s.territories.germany).toMatchObject({ owner: 0, factory: true });
    expect(s.territories.spain_portugal.owner).toBeNull();
    expect(countUnits(s.territories.spain_portugal.units)).toBe(0);
  });

  it('rejects a land unit in a sea holding', () => {
    setActiveMap('world1942');
    const scenario = scenarioFor(4);
    const sz4 = scenario.holdings.find((h) => h.territory === 'sz4')!;
    const original = sz4.units;
    sz4.units = { ...original, infantry: 1 };
    try {
      expect(() => createGame({ numPlayers: 4, seed: 1 })).toThrow(/cannot start at sea/);
    } finally {
      sz4.units = original;
    }
    // The unmutated scenario still starts cleanly afterwards.
    expect(() => createGame({ numPlayers: 4, seed: 1 })).not.toThrow();
  });
});

describe('createGame on the America map (unchanged)', () => {
  it('still starts every sea zone as empty uncontrolled waters', () => {
    const s = createGame({ numPlayers: 2, seed: 1 });
    expect(seaZoneIds().length).toBeGreaterThan(0);
    for (const z of seaZoneIds()) {
      expect(s.territories[z].owner, z).toBeNull();
      expect(countUnits(s.territories[z].units), z).toBe(0);
    }
  });
});
