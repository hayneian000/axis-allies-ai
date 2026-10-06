/**
 * engine/naval.ts — Sea-zone force management, transport cargo, and carrier capacity (1942 2e naval rules).
 */
import { CARGO_TYPES, addUnits, countUnits, emptyUnits, hasEnough, subUnits } from './units';
import { fail, log } from './core';
import { ALL_UNIT_TYPES, SURFACE_WARSHIP_TYPES, UNITS, isLand, isSea, neighborsOf, seaZoneIds } from '../data/data';
import type { UnitType } from '../data/data';
import type { ActionResult, Battle, GameState, TerritoryState, TransportLoad, UnitCounts } from './types';


/** Landing-legal spots: land territories owned at turn start and still owned,
 *  plus sea zones holding the player's carriers with spare fighter capacity
 *  (1942 2e p.27: fighters may land on friendly carriers; bombers never can). */
export function landingOptions(state: GameState, playerId: number): string[] {
  const land = state.ownedAtTurnStart.filter(
    (t) => isLand(t) && state.territories[t]?.owner === playerId,
  );
  const sea = seaZoneIds().filter((z) => carrierSpare(state.territories, z, playerId) > 0);
  return [...land, ...sea];
}


/** All forces in a sea zone: the primary occupant plus coexisting foreigners. */
export function seaZoneForces(z: TerritoryState): Array<{ owner: number | null; units: UnitCounts }> {
  const out: Array<{ owner: number | null; units: UnitCounts }> = [{ owner: z.owner, units: z.units }];
  for (const f of z.coexist ?? []) out.push(f);
  return out;
}


export function hasSurfaceWarships(u: UnitCounts): boolean {
  return SURFACE_WARSHIP_TYPES.some((t) => u[t] > 0);
}


/** Enemy destroyers in a sea zone (block submarine movement, 1942 2e p.29). */
export function hasHostileDestroyer(work: Record<string, TerritoryState>, zid: string, playerId: number): boolean {
  const z = work[zid];
  if (!z) return false;
  return seaZoneForces(z).some((f) => f.owner !== null && f.owner !== playerId && f.units.destroyer > 0);
}


/** Fighters per carrier (1942 2e p.27: "up to two fighters can be on a
 *  friendly aircraft carrier at a time"). */
export const CARRIER_FIGHTERS = 2;


/** The player's carriers and fighters in a sea zone (primary + coexist). */
export function playerCarrierForce(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
): { carriers: number; fighters: number } {
  let carriers = 0;
  let fighters = 0;
  for (const f of seaZoneForces(work[zid])) {
    if (f.owner === playerId) {
      carriers += f.units.carrier;
      fighters += f.units.fighter;
    }
  }
  return { carriers, fighters };
}


/** Spare fighter capacity on the player's carriers in a sea zone (1942 2e p.27). */
export function carrierSpare(work: Record<string, TerritoryState>, zid: string, playerId: number): number {
  const { carriers, fighters } = playerCarrierForce(work, zid, playerId);
  return CARRIER_FIGHTERS * carriers - fighters;
}


/** Add the player's units to their force in a sea zone (primary or coexist). */
export function addPlayerSeaUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
  units: Partial<UnitCounts>,
): void {
  const z = work[zid];
  if (z.owner === playerId) {
    z.units = addUnits(z.units, units);
    return;
  }
  const f = (z.coexist ?? []).find((f) => f.owner === playerId);
  if (f) f.units = addUnits(f.units, units);
  else z.coexist = [...(z.coexist ?? []), { owner: playerId, units: { ...emptyUnits(), ...units } }];
  normalizeSeaZone(work, zid);
}


/**
 * Keep the sea-zone owner invariant: `units`/`owner` hold the primary
 * occupant; `coexist` holds everyone else (one entry per owner, no empties,
 * never the owner). If the primary force is gone, promote the first
 * coexisting force.
 */
export function normalizeSeaZone(work: Record<string, TerritoryState>, zid: string): void {
  const z = work[zid];
  if (!z || !isSea(zid)) return;
  const merged: Array<{ owner: number; units: UnitCounts }> = [];
  for (const f of z.coexist ?? []) {
    if (countUnits(f.units) === 0) continue;
    const e = merged.find((m) => m.owner === f.owner);
    if (e) e.units = addUnits(e.units, f.units);
    else merged.push({ owner: f.owner, units: { ...f.units } });
  }
  // The owner's own coexisting units belong in the primary force.
  const ownIdx = z.owner !== null ? merged.findIndex((m) => m.owner === z.owner) : -1;
  if (ownIdx >= 0) {
    z.units = addUnits(z.units, merged[ownIdx].units);
    merged.splice(ownIdx, 1);
  }
  if (countUnits(z.units) === 0) {
    if (merged.length > 0) {
      const [first, ...rest] = merged;
      z.owner = first.owner;
      z.units = first.units;
      z.coexist = rest.length > 0 ? rest : undefined;
    } else {
      z.owner = null;
      z.coexist = undefined;
    }
  } else {
    z.coexist = merged.length > 0 ? merged : undefined;
  }
}


/** The current player's force in a sea zone, wherever it sits. */
export function playerSeaForce(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
): { units: UnitCounts; primary: boolean } {
  const z = work[zid];
  if (z.owner === playerId) return { units: z.units, primary: true };
  const f = (z.coexist ?? []).find((f) => f.owner === playerId);
  return { units: f ? f.units : emptyUnits(), primary: false };
}


/** Remove the player's units from a sea zone (from `units` or `coexist`). */
export function removeSeaUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
  units: Partial<UnitCounts>,
): void {
  const z = work[zid];
  if (z.owner === playerId) {
    z.units = subUnits(z.units, units);
  } else {
    const f = (z.coexist ?? []).find((f) => f.owner === playerId);
    if (f) f.units = subUnits(f.units, units);
  }
  normalizeSeaZone(work, zid);
}


/**
 * Settle the player's arriving ships into a sea zone known to hold no enemy
 * surface warships. If another player is the primary occupant (lone subs or
 * transports — 1942 2e p.29), their force becomes coexisting and the arriver
 * takes primary occupancy.
 */
export function arriveSeaZone(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
  units: Partial<UnitCounts>,
): void {
  const z = work[zid];
  if (z.owner !== null && z.owner !== playerId && countUnits(z.units) > 0) {
    z.coexist = [...(z.coexist ?? []), { owner: z.owner, units: { ...z.units } }];
    z.units = emptyUnits();
  }
  z.units = addUnits(z.units, units);
  // The arriver becomes the primary occupant (owner) of the zone.
  if (countUnits({ ...emptyUnits(), ...units }) > 0) z.owner = playerId;
  normalizeSeaZone(work, zid);
}


/**
 * Consolidate a sea zone around a battle defender: the defender's units
 * (wherever they sit) become `units`/`owner`; everyone else coexists.
 * While a sea battle is open, `territories[z].units` IS the defender's force.
 */
export function consolidateDefender(work: Record<string, TerritoryState>, zid: string, defenderId: number): void {
  const z = work[zid];
  const defUnits = emptyUnits();
  const rest: Array<{ owner: number; units: UnitCounts }> = [];
  for (const f of seaZoneForces(z)) {
    if (f.owner === defenderId) {
      for (const t of ALL_UNIT_TYPES) defUnits[t] += f.units[t];
    } else if (f.owner !== null && countUnits(f.units) > 0) {
      const e = rest.find((r) => r.owner === f.owner);
      if (e) e.units = addUnits(e.units, f.units);
      else rest.push({ owner: f.owner, units: { ...f.units } });
    }
  }
  z.owner = defenderId;
  z.units = defUnits;
  z.coexist = rest.length > 0 ? rest : undefined;
}


/**
 * Find a sea zone with a hostile destroyer that would intercept a submarine
 * sailing from `from` toward `to` (1942 2e p.29: entering such a zone ends
 * the sub's movement immediately). BFS up to 2 zones; returns the first
 * intercept found, or null.
 */
export function findDestroyerIntercept(
  work: Record<string, TerritoryState>,
  from: string,
  playerId: number,
): string | null {
  const seen = new Set<string>([from]);
  let frontier = [from];
  for (let step = 0; step < 2; step++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of neighborsOf(cur)) {
        if (!isSea(n) || seen.has(n)) continue;
        seen.add(n);
        if (hasHostileDestroyer(work, n, playerId)) return n;
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}


/** Combat power of a move's units (for the p.30 transport-escort rule). */
export function movePower(units: Partial<UnitCounts>): number {
  let power = 0;
  for (const t of ALL_UNIT_TYPES) {
    if ((units[t] ?? 0) > 0 && UNITS[t].attack > 0) power += units[t] ?? 0;
  }
  return power;
}


/** 1942 2e p.27: a sea zone is hostile to `playerId` when it holds surface
 *  warships (battleship, carrier, cruiser, destroyer) belonging to another
 *  player. Lone submarines and transports neither make it hostile nor block
 *  movement — that is the full rule, not a simplification. */
export function seaZoneHostileTo(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
): boolean {
  const z = work[zid];
  if (!z) return false;
  return seaZoneForces(z).some(
    (f) => f.owner !== null && f.owner !== playerId && hasSurfaceWarships(f.units),
  );
}


/** Land units currently aboard `owner`'s transports in a sea zone. */
export function cargoOf(work: Record<string, TerritoryState>, zid: string, owner: number): UnitCounts {
  const have = emptyUnits();
  for (const l of work[zid].cargo ?? []) {
    if (l.owner === owner) {
      for (const t of CARGO_TYPES) have[t] += l.units[t];
    }
  }
  return have;
}


/**
 * Load land units onto transports in a friendly sea zone (1942 2e p.30).
 * Capacity per transport: any one land unit plus one additional infantry.
 * Loads are repacked greedily; any packing is legal since loads are fungible.
 * `nTransports` is the loader's transport count in the zone (they may sit in
 * `coexist` rather than as the primary occupant).
 */
export function embarkUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  add: Partial<UnitCounts>,
  nTransports: number,
): ActionResult | null {
  for (const t of ALL_UNIT_TYPES) {
    if ((add[t] ?? 0) > 0 && !(CARGO_TYPES as UnitType[]).includes(t)) {
      return fail('bad_cargo', 'Transports carry land units only (infantry, artillery, tank, AA).');
    }
  }
  const want = emptyUnits();
  for (const t of CARGO_TYPES) want[t] = add[t] ?? 0;
  if (countUnits(want) === 0) return fail('empty_move', 'Nothing to load.');
  const zone = work[zid];
  const nT = nTransports;
  if (nT === 0) return fail('no_transport', 'No transports in that sea zone.');
  const total = addUnits(cargoOf(work, zid, owner), want);
  const nonInf = total.artillery + total.tank + total.aa;
  if (nonInf > nT || countUnits(total) > 2 * nT) {
    return fail(
      'no_capacity',
      `Transports there can carry ${2 * nT} units with at most ${nT} non-infantry.`,
    );
  }
  const rem = { ...total };
  const loads: TransportLoad[] = [];
  while (countUnits(rem) > 0) {
    const e = emptyUnits();
    for (const t of ['artillery', 'tank', 'aa'] as const) {
      if (rem[t] > 0) {
        e[t] += 1;
        rem[t] -= 1;
        break;
      }
    }
    while (rem.infantry > 0 && countUnits(e) < 2) {
      e.infantry += 1;
      rem.infantry -= 1;
    }
    if (countUnits(e) === 0) break; // safety; unreachable given the capacity check
    loads.push({ owner, units: e });
  }
  zone.cargo = [...(zone.cargo ?? []).filter((l) => l.owner !== owner), ...loads];
  return null;
}


/** Take land units off transports (for an amphibious assault or a friendly offload). */
export function disembarkUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  want: Partial<UnitCounts>,
): ActionResult | null {
  const loads = (work[zid].cargo ?? []).filter((l) => l.owner === owner);
  if (!hasEnough(cargoOf(work, zid, owner), want)) {
    return fail('no_cargo', 'Those units are not aboard your transports there.');
  }
  const rem: Partial<UnitCounts> = { ...want };
  const kept: TransportLoad[] = [];
  for (const l of loads) {
    const take: Partial<UnitCounts> = {};
    for (const t of CARGO_TYPES) {
      const n = Math.min(l.units[t], rem[t] ?? 0);
      if (n > 0) {
        take[t] = n;
        rem[t] = (rem[t] ?? 0) - n;
      }
    }
    const left = subUnits(l.units, take);
    if (countUnits(left) > 0) kept.push({ owner, units: left });
  }
  work[zid].cargo = [...(work[zid].cargo ?? []).filter((l) => l.owner !== owner), ...kept];
  return null;
}


/** Move up to `nTransports` cargo entries along with departing transports (fullest first). */
export function carryCargoAlong(
  work: Record<string, TerritoryState>,
  fromZ: string,
  toZ: string,
  owner: number,
  nTransports: number,
): void {
  const loads = (work[fromZ].cargo ?? [])
    .filter((l) => l.owner === owner)
    .sort((a, b) => countUnits(b.units) - countUnits(a.units));
  const moving = loads.slice(0, nTransports);
  const staying = loads.slice(nTransports);
  work[fromZ].cargo = [...(work[fromZ].cargo ?? []).filter((l) => l.owner !== owner), ...staying];
  work[toZ].cargo = [...(work[toZ].cargo ?? []), ...moving];
}


/**
 * Destroy `n` transports' worth of cargo when the transports die in combat
 * (1942 2e p.30: cargo is destroyed with its transport). Fullest loads first.
 * Returns the number of land units lost.
 */
export function destroyCargo(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  n: number,
): number {
  const loads = (work[zid].cargo ?? [])
    .filter((l) => l.owner === owner)
    .sort((a, b) => countUnits(b.units) - countUnits(a.units));
  const lost = loads.slice(0, n).reduce((s, l) => s + countUnits(l.units), 0);
  const kept = loads.slice(n);
  work[zid].cargo = [...(work[zid].cargo ?? []).filter((l) => l.owner !== owner), ...kept];
  return lost;
}


/** Destroy transport cargo when transports die in a sea battle (1942 2e p.30). */
export function sinkTransportCargo(
  state: GameState,
  b: Battle,
  side: 'attacker' | 'defender',
  nTransports: number,
): void {
  if (nTransports <= 0 || !isSea(b.territoryId)) return;
  const owner = side === 'attacker' ? b.attackerId : b.defenderId;
  if (owner === null || owner === undefined) return;
  const lost = destroyCargo(state.territories, b.territoryId, owner, nTransports);
  if (lost > 0) {
    log(state, 'sink', `${lost} embarked land unit(s) go down with their transports in ${b.territoryId}.`);
  }
}
