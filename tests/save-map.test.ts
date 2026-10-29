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
    expect(createGame({ numPlayers: 4, seed: 1 }).mapId).toBe('world1942');
  });

  it('restores a 1942 save while the America map is active', () => {
    setActiveMap('world1942');
    const json = serialize(createGame({ numPlayers: 4, seed: 7 }));
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
    const s = createGame({ numPlayers: 4, seed: 7 });
    const json = serialize(s);
    setActiveMap('america');
    const restored = deserialize(json);
    expect(restored.players.map((p) => p.name)).toEqual(['Germany', 'USSR', 'Japan', 'UK + US']);
    expect(restored.turnOrder).toEqual([0, 1, 2, 3]);
    expect(restored.currentPlayer).toBe(0);
    expect(serialize(restored)).toBe(json);
  });

  it('infers the map for a legacy save without a mapId field', () => {
    setActiveMap('world1942');
    const data = JSON.parse(serialize(createGame({ numPlayers: 4, seed: 7 })));
    delete data.mapId;
    setActiveMap('america');
    const restored = deserialize(JSON.stringify(data));
    expect(activeMapId()).toBe('world1942');
    expect(restored.numPlayers).toBe(4);
  });
});
