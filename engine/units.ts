/**
 * engine/units.ts — Pure unit-count arithmetic and unit-type lists. No GameState, no side effects.
 */
import { ALL_UNIT_TYPES, NAVAL_UNIT_TYPES, SURFACE_WARSHIP_TYPES } from '../data/data';
import type { UnitType } from '../data/data';
import type { UnitCounts } from './types';

export const LAND_UNIT_TYPES: UnitType[] = ['infantry', 'artillery', 'tank'];

export const AIR_UNIT_TYPES: UnitType[] = ['fighter', 'bomber'];

export const SEA_UNIT_TYPES: UnitType[] = [...NAVAL_UNIT_TYPES];


// --------------------------------------------------------------- naval ---

/** Land unit types a transport can carry (1942 2e p.30). */
export const CARGO_TYPES: UnitType[] = ['infantry', 'artillery', 'tank', 'aa'];


const SHORT: Record<UnitType, string> = {
  infantry: 'inf',
  artillery: 'art',
  tank: 'tnk',
  fighter: 'ftr',
  bomber: 'bmb',
  aa: 'aa',
  transport: 'trn',
  submarine: 'sub',
  destroyer: 'dd',
  cruiser: 'ca',
  carrier: 'cv',
  battleship: 'bb',
};


// ---------------------------------------------------------------- units ---

export function emptyUnits(): UnitCounts {
  const u = {} as UnitCounts;
  for (const t of ALL_UNIT_TYPES) u[t] = 0;
  return u;
}


export function countUnits(u: UnitCounts): number {
  let s = 0;
  for (const t of ALL_UNIT_TYPES) s += u[t];
  return s;
}


export function countLand(u: UnitCounts): number {
  return u.infantry + u.artillery + u.tank;
}


export function countAir(u: UnitCounts): number {
  return u.fighter + u.bomber;
}


/** Naval units (transport, submarine, destroyer, cruiser, carrier, battleship). */
export function countSea(u: UnitCounts): number {
  let s = 0;
  for (const t of NAVAL_UNIT_TYPES) s += u[t];
  return s;
}


/** Surface warships (1942 2e p.27): battleship, carrier, cruiser, destroyer. */
export function countSurfaceWarfare(u: UnitCounts): number {
  let s = 0;
  for (const t of SURFACE_WARSHIP_TYPES) s += u[t];
  return s;
}


export function addUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  const r = { ...a };
  for (const t of ALL_UNIT_TYPES) r[t] = a[t] + (b[t] ?? 0);
  return r;
}


export function subUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  const r = { ...a };
  for (const t of ALL_UNIT_TYPES) r[t] = a[t] - (b[t] ?? 0);
  return r;
}


export function hasEnough(have: UnitCounts, need: Partial<UnitCounts>): boolean {
  for (const t of ALL_UNIT_TYPES) {
    if ((need[t] ?? 0) > have[t]) return false;
  }
  return true;
}


export function validCounts(u: Partial<UnitCounts>): boolean {
  return Object.values(u).every((v) => v === undefined || (Number.isInteger(v) && v >= 0));
}


/** Undamaged battleships in a force: candidates to absorb hits (1942 2e p.27). */
export function undamagedBB(force: UnitCounts, damaged: number): number {
  return Math.max(0, force.battleship - damaged);
}


export function describeUnits(u: UnitCounts, damagedBB = 0): string {
  const parts: string[] = [];
  for (const t of ALL_UNIT_TYPES) {
    if (u[t] <= 0) continue;
    if (t === 'battleship' && damagedBB > 0) parts.push(`${u[t]}bb(${damagedBB}dmg)`);
    else parts.push(`${u[t]}${SHORT[t]}`);
  }
  return parts.join('+') || 'none';
}
