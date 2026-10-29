// The rules digest ships on every provider call as the model's view of the
// game. When the map or roster changes (e.g. the navy merge), a stale digest
// actively misleads every seat — so its key facts are pinned to data/ here.
// The digest is built per map: the America assertions pin the default game,
// the 1942 assertions pin the world board (seat names and fixed order,
// victory count, canals, impassable neutrals).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_UNIT_TYPES,
  MAP,
  UNITS,
  canalList,
  scenarioFor,
  ensureMapLoaded,
  setActiveMap,
} from '../../data/data';
import {
  RULES_DIGEST,
  buildPhasePrompt,
  buildRulesDigest,
  buildStaticReference,
  buildSystemPrompt,
  staticReferenceCacheKey,
} from '../../agents/prompts';

afterEach(() => setActiveMap('america'));

// Code-split data: the 1942 map loads on demand, so preload it once per
// file; the sync setActiveMap calls below then work as before.
beforeAll(async () => {
  await ensureMapLoaded('world1942');
});

function expectUnitCosts(digest: string): void {
  for (const u of ALL_UNIT_TYPES) {
    const want = u === 'aa' ? `AA gun ${UNITS[u].cost}` : `${u} ${UNITS[u].cost}`;
    expect(digest).toContain(want);
  }
  expect(digest).toContain(`factory ${UNITS.factory.cost}`);
}

describe('rules digest currency (America)', () => {
  it('describes the current map, not a stale one', () => {
    expect(RULES_DIGEST).toContain(`${MAP.territories.length}-territory`);
    expect(RULES_DIGEST).not.toContain('no navy');
    for (const t of MAP.territories) {
      if (t.domain === 'sea') expect(RULES_DIGEST).toContain(t.id);
    }
  });

  it('lists every purchasable unit at its data-verified cost', () => {
    expectUnitCosts(RULES_DIGEST);
  });

  it('buildRulesDigest on the default map reproduces the snapshot', () => {
    expect(buildRulesDigest()).toBe(RULES_DIGEST);
    expect(buildRulesDigest()).toContain('neutral garrison');
    expect(buildRulesDigest()).not.toContain('IMPASSABLE');
  });

  it('describes SBR as factory damage markers, never a bank tax', () => {
    expect(RULES_DIGEST).toContain('damage markers');
    expect(RULES_DIGEST).toContain("twice its territory's IPC value");
    expect(RULES_DIGEST).toContain('repair tool at 1 IPC per marker');
    expect(RULES_DIGEST).not.toContain("victim's bank");
    expect(RULES_DIGEST).not.toContain('IPC damage to the victim');
  });
});

describe('rules digest on the 1942 world map', () => {
  it('describes the 1942 map, pinned to data', () => {
    setActiveMap('world1942');
    const d = buildRulesDigest();
    const sea = MAP.territories.filter((t) => t.domain === 'sea');
    const land = MAP.territories.filter((t) => t.domain !== 'sea');
    expect(d).toContain(
      `${MAP.territories.length} territories (${land.length} land territories + ${sea.length} sea zones)`,
    );
    expect(d).not.toContain('continental-US');
    // America sea-zone ids are not the 1942 board's geography.
    expect(d).not.toContain('pacific_nw');
    expect(d).not.toContain('western_gulf');
  });

  it('states victory from the scenario capitals data', () => {
    setActiveMap('world1942');
    const s = scenarioFor(4);
    const total = s.capitals.reduce((n, c) => n + (Array.isArray(c) ? c.length : 1), 0);
    const d = buildRulesDigest();
    expect(d).toContain(`${s.capitalsToWin} of ${total}`);
    expect(d).not.toContain('3 of 4');
  });

  it('names the seats and states the fixed turn order', () => {
    setActiveMap('world1942');
    const s = scenarioFor(4);
    const d = buildRulesDigest();
    for (const name of s.seatNames ?? []) expect(d).toContain(name);
    expect(d).toContain('fixed order every round');
    expect(d).toContain('no shuffle');
  });

  it('states the victory-cities win from the scenario data', () => {
    setActiveMap('world1942');
    const s = scenarioFor(4);
    const targets = s.victoryCitiesToWin as number[];
    const cities = MAP.territories.filter((t) => t.victoryCity);
    const d = buildRulesDigest();
    expect(d).toContain('VICTORY CITIES');
    expect(d).toContain(`${cities.length} victory cities`);
    for (const c of cities) expect(d).toContain(c.victoryCity);
    // Per-seat targets, named from the scenario seat names.
    for (let i = 0; i < targets.length; i++) {
      expect(d).toContain(`${(s.seatNames ?? [])[i]} ${targets[i]}`);
    }
    // Round-end timing, not mid-round.
    expect(d).toContain('END of a complete round');
  });

  it('explains the two-capital seat from the scenario data', () => {
    setActiveMap('world1942');
    const s = scenarioFor(4);
    const multi = s.capitals
      .map((c, i) => ({ caps: Array.isArray(c) ? c : [c], name: (s.seatNames ?? [])[i] }))
      .find((x) => x.caps.length > 1)!;
    const d = buildRulesDigest();
    expect(d).toContain(multi.name);
    for (const cap of multi.caps) expect(d).toContain(cap);
    expect(d).toContain('NEITHER capital');
  });

  it('states neutrals are impassable and lists them from data', () => {
    setActiveMap('world1942');
    const d = buildRulesDigest();
    expect(d).toContain('IMPASSABLE');
    const impassable = MAP.territories.filter((t) => t.neutral);
    expect(impassable.length).toBeGreaterThan(0);
    for (const t of impassable) expect(d).toContain(t.id);
    expect(d).not.toContain('neutral garrison');
  });

  it('covers the canals from data', () => {
    setActiveMap('world1942');
    const d = buildRulesDigest();
    expect(canalList().length).toBe(2);
    for (const c of canalList()) {
      expect(d).toContain(c.description);
      for (const z of c.zones) expect(d).toContain(z);
    }
  });

  it('keeps the shared unit roster at data-verified costs', () => {
    setActiveMap('world1942');
    expectUnitCosts(buildRulesDigest());
  });

  it('system prompt and cache key follow the active map', () => {
    setActiveMap('world1942');
    const sys = buildSystemPrompt({ playerName: 'Germany' });
    expect(sys).toContain(buildRulesDigest());
    expect(sys).toContain(buildStaticReference());
    expect(sys).toContain('germany (');
    const key1942 = staticReferenceCacheKey();
    setActiveMap('america');
    expect(staticReferenceCacheKey()).not.toBe(key1942);
    expect(buildSystemPrompt({ playerName: 'Player 1' })).toContain(RULES_DIGEST);
  });

  it('combat-move phase guidance is map-scoped', () => {
    setActiveMap('world1942');
    const cm1942 = buildPhasePrompt({ phase: 'combatMove', stateBrief: 'X' });
    expect(cm1942).toContain('impassable');
    expect(cm1942).not.toContain('neutral garrisons');
    setActiveMap('america');
    const cmAmerica = buildPhasePrompt({ phase: 'combatMove', stateBrief: 'X' });
    expect(cmAmerica).toContain('neutral garrisons');
  });

  it('describes SBR as factory damage markers, never a bank tax', () => {
    setActiveMap('world1942');
    const d = buildRulesDigest();
    expect(d).toContain('damage markers');
    expect(d).toContain("twice its territory's IPC value");
    expect(d).toContain('repair tool at 1 IPC per marker');
    expect(d).not.toContain("victim's bank");
    expect(d).not.toContain('IPC damage to the victim');
  });
});
