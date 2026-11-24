import { beforeAll,  afterEach, describe, expect, it  } from 'vitest';
import { activeMapId, ensureMapLoaded, setActiveMap } from '../data/data';
import { createGame, deserialize, serialize } from '../engine/engine';

// Saves record the map they were made on (GameState.mapId, set by
// createGame); deserialize restores that map before validating, so a
// 1942 save loads from a fresh page (America active by default) and an
// America save loads while the 1942 map is active.
afterEach(() => setActiveMap('america'));

// Code-split data: the 1942 map loads on demand, so preload it once
// per file; the sync setActiveMap calls below then work as before.
beforeAll(async () => {
  await ensureMapLoaded('world1942');
});

describe('save/load map restore', () => {
  it('records the active map id in new game state', () => {
    setActiveMap('america');
    expect(createGame({ numPlayers: 2, seed: 1 }).mapId).toBe('america');
    setActiveMap('world1942');
    expect(createGame({ numPlayers: 5, seed: 1 }).mapId).toBe('world1942');
  });

  it('restores a 1942 save while the America map is active', () => {
    setActiveMap('world1942');
    const json = serialize(createGame({ numPlayers: 5, seed: 7 }));
    expect(JSON.parse(json).mapId).toBe('world1942');
    setActiveMap('america');
    const restored = deserialize(json);
    expect(activeMapId()).toBe('world1942');
    expect(restored.territories.germany).toBeDefined();
    expect(restored.territories.sz62).toBeDefined();
    expect(serialize(restored)).toBe(json);
  });

  it('restores an America save while the 1942 map is active', () => {
    setActiveMap('america');
    const json = serialize(createGame({ numPlayers: 2, seed: 7 }));
    setActiveMap('world1942');
    const restored = deserialize(json);
    expect(activeMapId()).toBe('america');
    expect(restored.territories.california).toBeDefined();
    expect(serialize(restored)).toBe(json);
  });

  it('round-trips 1942 power names and the fixed turn order', () => {
    setActiveMap('world1942');
    const s = createGame({ numPlayers: 5, seed: 7 });
    const json = serialize(s);
    setActiveMap('america');
    const restored = deserialize(json);
    expect(restored.players.map((p) => p.name)).toEqual(['Germany', 'USSR', 'Japan', 'UK', 'US']);
    expect(restored.turnOrder).toEqual([0, 1, 2, 3, 4]);
    expect(restored.currentPlayer).toBe(0);
    expect(serialize(restored)).toBe(json);
  });

  it('infers the map for a legacy save without a mapId field', () => {
    setActiveMap('world1942');
    const data = JSON.parse(serialize(createGame({ numPlayers: 5, seed: 7 })));
    delete data.mapId;
    setActiveMap('america');
    const restored = deserialize(JSON.stringify(data));
    expect(activeMapId()).toBe('world1942');
    expect(restored.numPlayers).toBe(5);
  });
  it('loads a legacy 4-seat 1942 save (merged UK + US seat) unchanged', () => {
    setActiveMap('world1942');
    const data = JSON.parse(serialize(createGame({ numPlayers: 5, seed: 7 })));
    // Rebuild the pre-split save shape: seat 4 (US) folds back into
    // seat 3, which held both Allied capitals and the combined bank.
    const uk = data.players[3];
    const us = data.players[4];
    data.players = [
      ...data.players.slice(0, 3),
      {
        ...uk,
        name: 'UK + US',
        ipcs: uk.ipcs + us.ipcs,
        capitals: ['united_kingdom', 'eastern_united_states'],
      },
    ];
    data.numPlayers = 4;
    data.turnOrder = [0, 1, 2, 3];
    data.victoryCitiesToWin = [6, 5, 6, 8];
    delete data.aiSeats;
    for (const t of Object.values(data.territories) as Array<{ owner: number | null }>) {
      if (t.owner === 4) t.owner = 3;
    }
    const json = JSON.stringify(data);
    setActiveMap('america');
    const restored = deserialize(json);
    expect(restored.numPlayers).toBe(4);
    expect(restored.players.map((p) => p.name)).toEqual(['Germany', 'USSR', 'Japan', 'UK + US']);
    expect(restored.players[3].capitals).toEqual(['united_kingdom', 'eastern_united_states']);
    expect(restored.victoryCitiesToWin).toEqual([6, 5, 6, 8]);
    expect(serialize(restored)).toBe(json);
  });
});
