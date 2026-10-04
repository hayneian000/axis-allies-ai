# Canonical Rules — Axis & Allies AI

## Canonical Sources

This project follows **Axis & Allies 1942, Second Edition** (2012) as its
canonical ruleset, with simplifications noted below.

### Official Rulebook
**Axis & Allies 1942 Second Edition — Rulebook**  
https://gamers-hq.de/media/pdf/0c/2c/5f/A-A_1942_2ndEd_Rulebook_WEB.pdf

The complete official rules: turn sequence, unit profiles, combat, economy,
victory conditions. When in doubt, this document wins.

### Official FAQ & Errata
**Axis & Allies 1942, 2nd Edition — FAQ** (November 9, 2012)  
https://sup1rppclvpogpbbl9vro.vcmarry.top/files/rules/AA1942_2ndEdition_FAQ.pdf

Clarifications and corrections to the rulebook, including:
- Honolulu is a victory city (13 total, not 12)
- Germany starting income 41, UK 31 (not as printed)
- Armor costs 6 IPCs, not 5

### Digital Reference
**Axis & Allies 1942 Online FAQ** (Beamdog — official digital adaptation)  
https://www.beamdog.com/news/faq-axis-allies-1942-online/

Useful for phase naming and UI conventions. Note: the online version omits
optional rules.

---

## Project Scope — What We Simplify

This is a **simplified, free-for-all** adaptation, not a full 1942 2e simulation.

| 1942 2e Rule | Project Implementation |
|---|---|
| 5 powers, Axis vs Allies teams | 2–4 players, free-for-all |
| World map, sea zones, naval units | 26-territory continental US + 3 sea zones (Pacific, Gulf, Atlantic); full 1942 2e naval roster |
| 6-phase turn (purchase, combat move, combat, noncombat, mobilize, income) | Same 6 phases |
| Unit roster: inf, art, tank, fighter, bomber, AA, sub, destroyer, carrier, battleship, transport | Full roster: inf, art, tank, fighter, bomber, AA + transport, submarine, destroyer, cruiser, carrier, battleship |
| IPC income from territories | Same, GDP-weighted (61 total) |
| Victory: 9/10 victory cities | Majority of capitals held simultaneously (scenario-overridable via capitalsToWin), or highest income at 20-round cap |
| Research & technology | Omitted (not in 1942 2e base rules either) |
| Strategic bombing raids | Included: bombers may raid factory territories, AA fires first, 1d6 IPC damage |

### Rules We Follow Exactly
- **Turn sequence**: Purchase → Combat Move → Combat → Noncombat Move → Mobilize → Income
- **Combat**: Attacker/defender hit profiles per unit type, casualty selection, retreat rules
- **Movement**: Land units move 1 (tanks 2 with blitz), air units move per type, must land safely
- **AA fire**: Fires once per combat round at attacking air units
- **AA movement**: AA guns move ONLY in the noncombat phase (1942 2e p.30: "this is the only phase in which antiaircraft artillery units can move")
- **Artillery support**: Boosts paired infantry attack
- **Factory placement**: New units placed at owned factories, limited by territory IPC value
- **Strategic bombing raids**: Bombers may raid factory territories; AA fires first; 1d6 IPC damage to victim bank
- **Naval warfare (phase 1)**: Sea zones, transports/cargo, amphibious assaults, surface sea combat, battleship 2-hit tracking — see Naval appendix below

### FFA Adaptations (Ian's decisions)
- **Neutral territories**: Have garrisons that must be defeated before capture (blocks tank blitz). Default: 3 infantry; each map/scenario may customize via `neutralGarrison` or per-territory `neutrals`.
- **Capital capture**: Captor steals the victim's entire saved IPC bank (1942 2e p.20).
- **Victory**: Hold a majority of capitals simultaneously (3 of 4 on the current map). Scenarios may override via `capitalsToWin`.

---

## Appendix: Naval Rules (Navy Phase 1)

All citations are to the Axis & Allies 1942 Second Edition rulebook (2012).

### Sea zones
- The US map has three sea zones — **Pacific** (west coast), **Atlantic** (east coast), **Gulf of Mexico** (south) — linked Pacific↔Gulf↔Atlantic (the Gulf link is a Panama-canal abstraction).
- Sea zones are never owned, worth 0 IPCs, hold no garrisons, and are exempt from scenario coverage checks. Only sea units (and aircraft) operate in them.

### Unit profiles (p.27–30)
| Unit | Cost | A/D/M | Notes |
|---|---|---|---|
| Transport | 7 | 0/0/2 | No combat value; chosen as casualty last; cargo destroyed with it (p.30) |
| Submarine | 6 | 2/1/2 | Phase 2: data only in phase 1 |
| Destroyer | 8 | 2/2/2 | |
| Cruiser | 12 | 3/3/2 | Offshore bombardment (p.28) |
| Carrier | 14 | 1/2/2 | Phase 2/3: data only in phase 1 |
| Battleship | 20 | 4/4/2 | Two hits to destroy; offshore bombardment (p.27) |

### Movement (p.27)
- All sea units move 2 sea zones.
- A sea zone is **hostile** if it contains enemy surface warships (battleship, carrier, cruiser, destroyer). Lone submarines and transports neither make a zone hostile nor block movement.
- Ships may not transit hostile zones; aircraft fly over anything within range.

### Transports (pp.13, 30)
- Capacity: any **one** land unit plus one additional infantry (2 infantry, or infantry + tank/artillery/AA).
- May load in any friendly sea zone along the route (including the starting zone). Loading/offloading counts as the land unit's entire move.
- Cannot load or offload in a hostile sea zone; cannot offload into two territories in one turn; "bridging" (load + offload without the ship moving) is allowed.
- Combat-move loads must amphibiously assault; transports may not attack a hostile zone without an escorting warship.
- AA guns embark only in the noncombat phase (project rule, consistent with p.30's "only phase in which AA can move").

### Amphibious assaults (p.15)
Sequence: 1. sea combat (only if defending surface warships are present; lone subs/transports may be ignored), 2. battleship/cruiser bombardment — **only if no sea battle occurred** in the launch zone, at most one ship per offloaded land unit (battleships hit on 4-, cruisers on 3-; victims defend the first land round, then die), 3. land combat. Seaborne units cannot retreat.
- **Phase-1 simplification**: assaults launch from friendly sea zones only (the full sea-battle-then-assault sequencing arrives in phase 2).

### Battleship damage (p.27)
- First hit in a combat = damaged; second hit in the **same** combat = destroyed. A battleship that survives the combat is repaired immediately. Damage is tracked on the Battle object, never on persistent map state.

### Mobilization (p.21)
- Sea units mobilize into a sea zone adjacent to a territory with an eligible factory.
- **Phase-1 simplification**: into friendly or empty waters only (p.21 allows hostile waters; deferred).

### Phase-2 follow-ons (not in phase 1)
- Submarine abilities (surprise strikes, submerging, convoy disruption)
- Carrier fighter operations (launch/recover, carrier as landing spot)
- Full p.27 hostile-zone transit nuances for subs
- Sea-battle-then-amphibious-assault sequencing in a single turn
- Mobilization into hostile waters

---

## Test-Driven Approach

### Philosophy
Every rule in the engine must have a corresponding test that **fails if the
rule is broken**. Tests are the executable specification. When the rulebook
and the code disagree, the rulebook wins — fix the code, not the test.

### Test Organization
```
tests/
  combat.test.ts      — Hit profiles, casualty selection, retreat, AA fire
  economy.test.ts     — IPC income, purchase costs, factory limits
  movement.test.ts    — Legal moves, blitz, air landing, transport (N/A)
  purchase.test.ts    — Unit costs, IPC deduction, placement validation
  edge.test.ts        — Boundary conditions, invalid actions, error codes
  simulation.test.ts  — Full-game headless sims (bot vs bot, invariant checks)
  map.test.ts         — Territory graph, IPC totals, label data
  ui.test.ts          — Rendering, interactions (not rules logic)
```

### Writing a Rule Test
1. **Cite the source**: Comment with rulebook page/section, e.g. `// 1942 2e p.18: Tanks blitz`
2. **Test the rule, not the implementation**: Assert on game state, not internals
3. **Test both directions**: Valid action succeeds, invalid action fails with correct error code
4. **Use deterministic seeds**: `createGame({ seed: N })` for reproducibility

Example:
```typescript
// 1942 2e p.20: Artillery supports infantry (inf attacks at 2 when paired)
it('artillery boosts paired infantry attack', () => {
  const s = createGame({ numPlayers: 2, seed: 42 });
  // ... setup ...
  // Assert infantry hits on 2 or less when artillery present
});
```

### Coverage Requirements
- [ ] Every `export function` in `engine.ts` has direct unit tests
- [ ] Every error code (`ActionResult.code`) has a test triggering it
- [ ] Combat: all unit types, attacker/defender, with/without support
- [ ] Movement: all unit types, edge cases (stranded air, blocked paths)
- [ ] Economy: income calculation, purchase validation, factory capacity
- [ ] Game end: capital capture victory, turn-cap tiebreak

### Simulation Tests
`simulation.test.ts` runs full bot-vs-bot games to catch emergent rule
violations:
- No crashes over 100+ games with random seeds
- Invariants hold: IPC totals conserved, unit counts non-negative, turn counter advances
- Games terminate (victory or turn cap)

### When Rules Change
1. Update this file with the rulebook citation
2. Write the failing test first (red)
3. Implement the fix (green)
4. Verify all 95+ tests still pass (no regressions)
