// Cheap local "is there anything to do?" checks. The driver consults these
// before each AI phase: a phase with provably no legal actions is ended
// directly with no LLM call.
//
// Every check is CONSERVATIVE: it may report "has actions" when a perfect
// rules analysis would find none (a missed skip costs one wasted call), but
// it must never report "no actions" when a legal action exists (a wrongful
// skip silently drops agency). The workhorse is optimistic reachability —
// any legal move's destination is inside the optimistic set, so an empty
// optimistic set proves no legal move exists.

import { airDistance, isSea, neighborsOf, seaZoneIds, UNITS } from '../data/data';
import { addUnits, countAir, countSea, emptyUnits } from '../engine/units';
import { ownsCapital, playerSeaForce } from '../engine/engine';
import type { GameState, TerritoryState, UnitCounts } from '../engine/types';

export interface Affordance {
  has: boolean;
  /** Human-readable why (used for skip events / logs). */
  reason: string;
}

const yes = (reason = 'actions available'): Affordance => ({ has: true, reason });
const no = (reason: string): Affordance => ({ has: false, reason });

function alive(state: GameState, pid: number): boolean {
  return !!state.players[pid]?.alive;
}

/** Land territories owned by the player. */
function ownedLand(state: GameState, pid: number): Array<[string, TerritoryState]> {
  const out: Array<[string, TerritoryState]> = [];
  for (const [tid, t] of Object.entries(state.territories)) {
    if (!isSea(tid) && t.owner === pid) out.push([tid, t]);
  }
  return out;
}

/** The player's total sea-zone force (primary + coexisting), all zones. */
function seaForceTotal(state: GameState, pid: number): UnitCounts {
  let total = emptyUnits();
  for (const zid of seaZoneIds()) {
    total = addUnits(total, playerSeaForce(state.territories, zid, pid).units);
  }
  return total;
}

/**
 * Land territories within `move` land-steps of `from`, never crossing sea.
 * Optimistic: paths may cross any land territory regardless of owner (a
 * superset of the paths the engine allows, so "none found" is proof).
 */
function landInRange(from: string, move: number): string[] {
  const seen = new Set<string>([from]);
  let frontier = [from];
  const out: string[] = [];
  for (let d = 0; d < move; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of neighborsOf(cur)) {
        if (seen.has(n) || isSea(n)) continue;
        seen.add(n);
        out.push(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return out;
}

/** Cheapest unit the purchase tool can buy (infantry). */
function cheapestUnitCost(): number {
  return Math.min(
    UNITS.infantry.cost,
    UNITS.artillery.cost,
    UNITS.tank.cost,
    UNITS.fighter.cost,
    UNITS.bomber.cost,
    UNITS.aa.cost,
  );
}

/**
 * Purchase: the only legal non-empty purchase needs the capital held and a
 * bank that covers the cheapest unit. (Engine: `no_capital` / `funds`.)
 * Repair is also a purchase-phase action: 1 IPC removes one damage marker
 * from your own factory, and unlike unit purchases it stays legal while
 * your capital is enemy-held, so a damaged factory plus 1 IPC in the bank
 * is always "has actions".
 */
export function purchaseAffordance(state: GameState, pid: number): Affordance {
  if (!alive(state, pid)) return no('player not alive');
  const bank = state.players[pid].ipcs;
  const hasDamagedFactory = Object.values(state.territories).some(
    (t) => t.owner === pid && t.factory && (t.factoryDamage ?? 0) > 0,
  );
  if (hasDamagedFactory && bank >= 1) {
    return yes('damaged factory can be repaired (1 IPC per damage marker)');
  }
  if (!ownsCapital(state, pid)) return no('capital enemy-held: the engine rejects any purchase');
  const cheapest = cheapestUnitCost();
  if (bank < cheapest) return no(`bank ${bank} IPCs < cheapest unit (${cheapest})`);
  return yes();
}

/**
 * Combat move: skip only when no attack or SBR is geometrically possible.
 * Sea units (even transports) are an instant "has actions" — sea battles and
 * amphibious assaults need the engine's full naval rules to rule out, which
 * is not cheap. AA guns can never attack, so they don't count.
 */
export function combatMoveAffordance(state: GameState, pid: number): Affordance {
  if (!alive(state, pid)) return no('player not alive');
  if (countSea(seaForceTotal(state, pid)) > 0) {
    return yes('naval forces present: sea-battle / amphibious options need engine validation');
  }
  for (const [tid, t] of ownedLand(state, pid)) {
    const u = t.units;
    const landRanges: Array<[number, number]> = [
      [u.infantry, UNITS.infantry.move],
      [u.artillery, UNITS.artillery.move],
      [u.tank, UNITS.tank.move],
    ];
    for (const [count, move] of landRanges) {
      if (count > 0 && landInRange(tid, move).some((n) => state.territories[n]?.owner !== pid)) {
        return yes();
      }
    }
    // Air attacks and strategic bombing raids: any hostile/neutral
    // territory in air range (the engine's own airDistance metric).
    const airRanges: Array<[number, number]> = [
      [u.fighter, UNITS.fighter.move],
      [u.bomber, UNITS.bomber.move],
    ];
    for (const [count, move] of airRanges) {
      if (count === 0) continue;
      for (const [oid, ot] of Object.entries(state.territories)) {
        if (ot.owner !== pid && airDistance(tid, oid) <= move) return yes();
      }
    }
  }
  return no('no attack-capable unit can reach a hostile/neutral territory');
}

/**
 * Non-combat move: skip only when nothing can move AND nothing must move.
 * Aircraft left aloft over this turn's battles must land or be lost at
 * phase end, so any aloft air forces the call. Air/sea units are an instant
 * "has actions" — carrier landing and naval repositioning rules are too
 * intricate for a cheap proof. Land units need an optimistic friendly
 * destination.
 */
export function nonCombatAffordance(state: GameState, pid: number): Affordance {
  if (!alive(state, pid)) return no('player not alive');
  // Battles are all resolved by now (auto-resolve), but attacking aircraft
  // stay "aloft" in the battle record until landed in non-combat.
  for (const b of state.battles) {
    if (b.attackerId === pid && (b.attack.fighter > 0 || b.attack.bomber > 0)) {
      return yes('aircraft aloft over battles must land or be lost');
    }
  }
  if (countSea(seaForceTotal(state, pid)) > 0) return yes('fleet can reposition');
  const land = ownedLand(state, pid);
  if (land.some(([, t]) => countAir(t.units) > 0)) return yes('aircraft can reposition');
  for (const [tid, t] of land) {
    const u = t.units;
    const landMoves: Array<[number, number]> = [
      [u.infantry, UNITS.infantry.move],
      [u.artillery, UNITS.artillery.move],
      [u.tank, UNITS.tank.move],
      [u.aa, UNITS.aa.move],
    ];
    for (const [count, move] of landMoves) {
      if (count > 0 && landInRange(tid, move).some((n) => state.territories[n]?.owner === pid)) {
        return yes();
      }
    }
  }
  return no('no unit has a legal non-combat destination and no aircraft are aloft');
}

/** Mobilize is only skippable when the purchase pool is empty (engine forfeits leftovers anyway). */
export function hasPurchasedUnits(state: GameState): boolean {
  return Object.values(state.purchased ?? {}).some((n) => (n ?? 0) > 0);
}

/** Dispatch to the per-phase check (mobilize = purchase pool non-empty). */
export function phaseHasActions(
  state: GameState,
  pid: number,
  phase: 'purchase' | 'combatMove' | 'nonCombat' | 'mobilize',
): Affordance {
  switch (phase) {
    case 'purchase':
      return purchaseAffordance(state, pid);
    case 'combatMove':
      return combatMoveAffordance(state, pid);
    case 'nonCombat':
      return nonCombatAffordance(state, pid);
    case 'mobilize':
      return hasPurchasedUnits(state) ? yes() : no('nothing purchased this turn');
  }
}
