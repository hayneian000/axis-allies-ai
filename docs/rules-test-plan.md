# Comprehensive Rules Test Plan — Axis & Allies AI

**Source:** Axis & Allies 1942 Second Edition Rulebook + FAQ/Errata  
**Scope:** Project-adapted rules (land/air only, FFA, US map)  
**Approach:** Black-box tests against `engine/` API. No UI. No implementation details.

---

## Architecture Requirement

Game logic lives in `engine/` (pure functions, no DOM). UI lives in `ui/` (renders state, dispatches actions). Tests import only from `engine/` and `data/`.

```
engine/
  engine.ts    — All game logic, pure functions
  types.ts     — GameState, UnitCounts, ActionResult, etc.
  RULES.md     — Canonical sources (already exists)

tests/
  rules/                    — NEW: rulebook-driven tests
    setup.test.ts           — Game creation, initial state
    purchase.test.ts        — Phase 1 (consolidate existing)
    combat-move.test.ts     — Phase 2 movement validation
    combat.test.ts          — Phase 3 resolution (consolidate existing)
    noncombat.test.ts       — Phase 4
    mobilize.test.ts        — Phase 5
    income.test.ts          — Phase 6
    victory.test.ts         — Win conditions
    units/
      infantry.test.ts      — Unit-specific rules
      artillery.test.ts     — Support, pairing
      tank.test.ts          — Blitz, movement
      fighter.test.ts       — Air movement, landing
      bomber.test.ts        — Air movement, landing, SBR (N/A)
      aa.test.ts            — AA fire timing, limits
```

Existing tests (`combat.test.ts`, `economy.test.ts`, etc.) get **migrated** into this structure with rulebook citations added.

---

## Phase 1: Purchase Units (1942 2e p.9–11)

### Unit Costs
| Unit | Cost | Attack | Defense | Move |
|------|------|--------|---------|------|
| Infantry | 3 | 1 (2 w/art) | 2 | 1 |
| Artillery | 4 | 2 | 2 | 1 |
| Tank | 6 | 3 | 3 | 2 |
| Fighter | 10 | 3 | 4 | 4 |
| Bomber | 12 | 4 | 1 | 6 |
| AA Gun | 5 | — | — | 1 |

### Tests
- [ ] Each unit costs correct IPCs (all 6 types)
- [ ] Cannot purchase if IPCs insufficient (exact error code)
- [ ] Can purchase zero units (pass)
- [ ] Can save IPCs (unspent carries to next turn)
- [ ] Purchasing deducts IPCs immediately (not at mobilize)
- [ ] Cannot purchase more units than total factory capacity allows
- [ ] Purchase with exact IPCs (boundary: cost == IPCs)
- [ ] Purchase one over budget (boundary: cost == IPCs + 1)
- [ ] Multiple unit types in single purchase
- [ ] IPCs cannot go negative

### Edge Cases
- [ ] Purchase after capital lost (income reduced, can still purchase with saved IPCs)
- [ ] Purchase with 0 IPCs and 0 saved (must pass)
- [ ] Large purchase (stress: 20+ units)

---

## Phase 2: Combat Movement (1942 2e p.12–15)

### Movement Allowances
- Infantry, Artillery, AA: 1 territory
- Tank: 2 territories
- Fighter: 4 territories
- Bomber: 6 territories

### Tests — Land Units
- [ ] Infantry moves 1 into friendly territory
- [ ] Infantry moves 1 into hostile territory (combat)
- [ ] Infantry cannot move 2
- [ ] Artillery moves 1 (same as infantry)
- [ ] AA gun moves 1 in combat phase (can move, but cannot fire offensively)
- [ ] Tank moves 1
- [ ] Tank moves 2 through friendly territories
- [ ] Tank blitz: moves 2 through unoccupied hostile territory to second territory
- [ ] Tank blitz: first territory must be unoccupied (no combat)
- [ ] Tank cannot blitz through occupied hostile territory
- [ ] Tank cannot blitz through friendly-neutral? (define: unowned = hostile for FFA)
- [ ] Units cannot move through impassable (none on US map, but test the check)
- [ ] Cannot move out of territory after combat declared there? (units committed)

### Tests — Air Units
- [ ] Fighter moves up to 4
- [ ] Bomber moves up to 6
- [ ] Fighter cannot move 5
- [ ] Air units must have legal landing spot after combat move
- [ ] Legal landing: friendly territory (not newly captured this turn)
- [ ] Illegal: no landing spot → move rejected
- [ ] Air can fly over hostile territories (no AA fire during movement, only in combat)
- [ ] Air can participate in multiple? No — one combat per turn
- [ ] Fighter with 1 move left must be able to land

### Tests — Combat Declaration
- [ ] Moving into hostile territory declares combat (adds to openBattles)
- [ ] Moving into friendly territory does not declare combat
- [ ] Moving into neutral territory declares combat vs 2-inf garrison
- [ ] Neutral garrison must be fully defeated before capture
- [ ] Tank cannot blitz through neutral (garrison blocks — occupied)
- [ ] Multiple attackers to same territory (combined combat)
- [ ] Attacker can choose order of combat resolution
- [ ] Cannot combat move after combat phase begins (phase enforcement)

### Edge Cases
- [ ] Tank blitz into territory with only AA (AA doesn't block blitz? — lone AA removed)
- [ ] Air unit with exactly enough movement to reach and land (boundary)
- [ ] Air unit one short of landing (rejected)
- [ ] Circular movement (A→B→A) — allowed? (should be, if movement permits)
- [ ] Moving all units out of capital (legal, but risky)
- [ ] Combat move from multiple origins to single target

---

## Phase 3: Conduct Combat (1942 2e p.16–22)

### Combat Sequence (per territory)
1. AA fire (if defender has AA and attacker has air)
2. Attacker rolls (one die per unit, hits on ≤ attack value)
3. Defender assigns casualties
4. Defender rolls (one die per unit, hits on ≤ defense value)
5. Attacker assigns casualties
6. Remove casualties
7. Attacker may retreat (to adjacent friendly territory)
8. Repeat until one side eliminated or attacker retreats

### Tests — AA Fire
- [ ] AA fires only if attacker has air units
- [ ] AA fires only in first round of combat
- [ ] Each AA fires up to 3 shots (one per attacking air unit, max 3)
- [ ] AA hits on 1 (1942 2e: AA hits on 1)
- [ ] AA casualties removed before regular combat
- [ ] AA does not fire at ground units
- [ ] Multiple AA: each fires separately
- [ ] AA with no air attacker: does not fire
- [ ] Lone AA (no other defending units): removed without combat if territory attacked

### Tests — Hit Profiles
- [ ] Infantry attacks on 1, defends on 2
- [ ] Artillery attacks on 2, defends on 2
- [ ] Tank attacks on 3, defends on 3
- [ ] Fighter attacks on 3, defends on 4
- [ ] Bomber attacks on 4, defends on 1
- [ ] Artillery-supported infantry attacks on 2 (one-to-one pairing)
- [ ] Two infantry, one artillery: only one infantry boosted
- [ ] Two artillery, one infantry: infantry boosted (excess artillery attacks normally)
- [ ] Artillery with no infantry: attacks at 2 (no penalty)

### Tests — Casualty Selection
- [ ] Attacker chooses own casualties (via chooseCasualties)
- [ ] Defender chooses own casualties
- [ ] Cannot select more casualties than hits
- [ ] Cannot select units not present
- [ ] AA can be taken as casualty (defender's choice, but usually last)
- [ ] autoCasualties follows sensible priority (cheapest first? — document the policy)

### Tests — Retreat
- [ ] Attacker may retreat after any full combat round
- [ ] Attacker cannot retreat before first round completes
- [ ] Retreat to adjacent friendly territory (not hostile, not newly captured)
- [ ] All attacking units retreat together (or can split? — 1942 2e: all retreat to same territory)
- [ ] Cannot retreat from amphibious assault (N/A — no navy, but test the guard)
- [ ] Defender cannot retreat
- [ ] Retreat with air units: air can retreat to different landing spot?

### Tests — Combat Resolution
- [ ] Attacker wins: territory captured, surviving units remain
- [ ] Defender wins: territory held, attacker eliminated or retreated
- [ ] Mutual annihilation: territory becomes unowned? (or defender holds with 0 units?)
- [ ] Captured territory's AA: what happens? (1942 2e: captured if surviving?)
- [ ] Captured factory: cannot use this turn
- [ ] Multiple combat rounds: state persists correctly

### Edge Cases
- [ ] 1 infantry vs 1 infantry (simplest combat)
- [ ] 20 units vs 20 units (stress, performance)
- [ ] All air attack vs AA + ground
- [ ] Bomber alone vs infantry (bomber defends at 1)
- [ ] Fighter defends at 4 (best defender)
- [ ] Zero-round combat (attacker retreats immediately? — not allowed, must complete round 1)
- [ ] Combat with 0 attacking units (should not happen — validation)

---

## Phase 4: Noncombat Movement (1942 2e p.22–23)

### Tests
- [ ] Land units can move to friendly territories
- [ ] Cannot move into hostile territories (combat is over)
- [ ] Tanks can move 2 in noncombat
- [ ] Air units must land (if not already)
- [ ] Air units can move full allowance in noncombat
- [ ] AA can move in noncombat
- [ ] Units that fought cannot move (already used movement? — 1942 2e: units that moved in combat cannot move again)
- [ ] Units that did not move in combat can move now

### Edge Cases
- [ ] Stranded air: fighter that cannot reach friendly territory → destroyed
- [ ] Bomber with no landing → destroyed
- [ ] Air unit lands in territory that was captured this turn? (1942 2e: NO — must be friendly at turn start)
- [ ] Moving into territory vacated by combat move

---

## Phase 5: Mobilize New Units (1942 2e p.23–24)

### Tests
- [ ] Place purchased units at owned factories
- [ ] Factory capacity = territory IPC value (max units per turn)
- [ ] Cannot exceed capacity
- [ ] Cannot place at factory captured this turn
- [ ] Can place at original factory (capital)
- [ ] Can split placement across multiple factories
- [ ] AA can be placed at factory
- [ ] Unplaced units: lost? (1942 2e: must place or lose — test the rule)

### Edge Cases
- [ ] Factory territory with IPC 1: only 1 unit per turn
- [ ] California IPC 8: up to 8 units
- [ ] No factories owned: cannot mobilize (units lost?)
- [ ] Capital captured: can still mobilize at other factories

---

## Phase 6: Collect Income (1942 2e p.24)

### Tests
- [ ] Income = sum of owned territory IPC values
- [ ] IPCs added to player's total
- [ ] Saved IPCs carry over
- [ ] Capturing capital: steal ALL enemy IPCs (full steal per 1942 2e)
- [ ] Losing capital: cannot collect income? (1942 2e: still collect, but can't purchase? — verify)
- [ ] Liberating capital: restore?

### Victory Check
- [ ] Control majority of capitals simultaneously → immediate victory (3/4 on current map)
- [ ] Victory condition is map-specific (defined in map data, not hardcoded)
- [ ] 20-round cap reached → highest income wins
- [ ] Tiebreak: what if income tied? (define rule)

---

## Cross-Phase Integration

### Turn Sequence Enforcement
- [ ] Cannot combat move during purchase phase
- [ ] Cannot purchase during combat phase
- [ ] Cannot mobilize before combat resolved
- [ ] endPhase advances correctly through all 6 phases
- [ ] endPhase at income wraps to next player's purchase

### State Invariants (after every action)
- [ ] IPCs never negative
- [ ] Unit counts never negative
- [ ] Territory owners are valid player IDs or null
- [ ] Total IPCs in game conserved (except income phase adds)
- [ ] No units in impossible locations

### Simulation Tests
- [ ] 100 bot-vs-bot games complete without crash
- [ ] 100 games with different seeds produce different outcomes
- [ ] No game exceeds turn cap without resolution
- [ ] Performance: full game < 5 seconds

---

## FFA-Specific Rules (Project Decisions — Locked Oct 3 2026)

- **No teams:** Every other player is hostile.
- **Neutral garrisons:** Each neutral territory defends with 2 infantry. Must be
  defeated in combat before capture. Blocks tank blitzing.
- **Capital IPC theft:** Full steal (1942 2e). Attacker takes all saved IPCs.
- **Victory:** Majority of capitals held simultaneously (3/4 on current map).
  Map-specific victory conditions going forward.
- **AA movement:** Per 1942 2e — can reposition in combat phase, never fires offensively.
- **Turn order:** Fixed rotation, no bidding.
- **Diplomacy/chat** has no mechanical effect (Phase 2 requirement).

---

## Test Quality Standards

1. **Cite the rule**: Every test has a comment with rulebook page, e.g. `// 1942 2e p.18`
2. **Test the rule, not the code**: Assert on `GameState`, not internals
3. **Both directions**: Valid succeeds, invalid fails with correct `code`
4. **Deterministic**: Use `seed` for reproducibility
5. **Independent**: No test depends on another test's state
6. **Fast**: Unit tests < 100ms each; full suite < 10 seconds

---

## Migration Plan

1. **New structure**: Create `tests/rules/` with phase-based files
2. **Migrate existing**: Move tests from `combat.test.ts` → `rules/combat.test.ts`, add citations
3. **Fill gaps**: Write new tests for uncovered rules (checklist above)
4. **Delete old**: Remove original files after migration verified
5. **CI**: Ensure `npm test` runs new structure

### Estimated Coverage
- Current: ~95 tests, good mechanical coverage, sparse citations
- Target: 150+ tests, every rule cited, every edge case covered
- Effort: 2–3 focused sessions

---

## Open Questions — RESOLVED (Ian, Oct 3 2026)

1. **Neutral garrisons**: ~~Do neutral territories defend? If so, with what?~~  
   **Decision:** Yes — neutrals are well defended. Each neutral territory has a
   2-infantry garrison that must be defeated in combat before capture.
   Blitzing through neutrals is not allowed (they are occupied).

2. **Capital IPC theft**: ~~Full steal (1942 2e) or partial?~~  
   **Decision:** Full steal, per 1942 2e rules. Capturing a capital transfers
   all of the victim's saved IPCs to the attacker.

3. **Victory**: ~~All capitals simultaneously, or cumulative captures?~~  
   **Decision:** Majority of capitals held **simultaneously** wins.
   For the current 4-capital map: 3 out of 4. Victory conditions will be
   map-specific going forward.

4. **AA movement**: ~~Can AA move in combat phase? (1942 2e: yes, but cannot fire offensively)~~  
   **Decision:** Follow real rules — AA can reposition during combat movement
   but never fires offensively.

5. **Tank blitz through neutrals**: ~~Allowed if unoccupied?~~  
   **Decision:** Moot — neutrals have garrisons (see #1), so they are occupied
   and block blitzing. Tanks must defeat the garrison first.
