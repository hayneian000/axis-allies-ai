// The rules digest ships on every provider call as the model's view of the
// game. When the map or roster changes (e.g. the navy merge), a stale digest
// actively misleads every seat — so its key facts are pinned to data/ here.

import { describe, expect, it } from 'vitest';
import { ALL_UNIT_TYPES, MAP, UNITS } from '../../data/data';
import { RULES_DIGEST } from '../../agents/prompts';

describe('rules digest currency', () => {
  it('describes the current map, not a stale one', () => {
    expect(RULES_DIGEST).toContain(`${MAP.territories.length}-territory`);
    expect(RULES_DIGEST).not.toContain('no navy');
    for (const t of MAP.territories) {
      if (t.domain === 'sea') expect(RULES_DIGEST).toContain(t.id);
    }
  });

  it('lists every purchasable unit at its data-verified cost', () => {
    for (const u of ALL_UNIT_TYPES) {
      const want = u === 'aa' ? `AA gun ${UNITS[u].cost}` : `${u} ${UNITS[u].cost}`;
      expect(RULES_DIGEST).toContain(want);
    }
    expect(RULES_DIGEST).toContain(`factory ${UNITS.factory.cost}`);
  });
});
