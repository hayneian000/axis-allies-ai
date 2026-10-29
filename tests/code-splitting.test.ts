// Code-split boundary pins. Vitest isolates modules per test file, so
// this file sees data.ts in its fresh state: the America map loaded,
// the 1942 map not loaded, until ensureMapLoaded is called. That is the
// unit-level form of the bundle split (the build-output table in the PR
// is the other half: the 1942 JSON and the AI chunk leave the initial
// chunk). No test here imports ui/main or any AI module.
import { describe, expect, it } from 'vitest';
import {
  MAP,
  activeMapId,
  ensureMapLoaded,
  isMapLoaded,
  scenarioFor,
  seatNamesForMap,
  setActiveMap,
} from '../data/data';
import { saveMapId } from '../engine/engine';
import map1942Json from '../data/map-1942.json';
import scenario1942Json from '../data/scenario-1942.json';

describe('lazy 1942 map boundary', () => {
  it('starts with America loaded and the 1942 map unloaded', () => {
    expect(isMapLoaded('america')).toBe(true);
    expect(isMapLoaded('world1942')).toBe(false);
    expect(activeMapId()).toBe('america');
    expect(MAP.territories).toHaveLength(33);
    expect(seatNamesForMap('world1942')).toBeUndefined();
  });

  it('refuses a synchronous switch to the 1942 map before it loads', () => {
    expect(() => setActiveMap('world1942')).toThrow(/not loaded yet/);
    expect(activeMapId()).toBe('america');
  });

  it('loads data byte-identical to the static JSON files', async () => {
    await ensureMapLoaded('world1942');
    expect(isMapLoaded('world1942')).toBe(true);
    setActiveMap('world1942');
    expect(MAP.territories).toEqual(map1942Json.territories);
    expect(MAP).toEqual(map1942Json);
    expect(scenarioFor(4).seatNames).toEqual(scenario1942Json.seatNames);
    expect(scenarioFor(4).victoryCitiesToWin).toEqual(scenario1942Json.victoryCitiesToWin);
    setActiveMap('america');
    expect(activeMapId()).toBe('america');
  });

  it('identifies a save map without loading it (the load-path preload)', () => {
    expect(saveMapId(JSON.stringify({ mapId: 'world1942', version: 3 }))).toBe('world1942');
    expect(saveMapId(JSON.stringify({ mapId: 'america', version: 3 }))).toBe('america');
    expect(
      saveMapId(JSON.stringify({ version: 3, territories: { germany: {}, sz62: {} } })),
    ).toBe('world1942');
    expect(saveMapId('not json')).toBeNull();
  });
});
