/**
 * engine/engine.ts — public engine API (barrel).
 *
 * The engine is split into focused modules; this file re-exports everything
 * so existing imports (`from '../engine/engine'`) keep working unchanged.
 *
 * Module map:
 *   units.ts   — pure unit-count arithmetic and unit-type lists
 *   core.ts    — RNG, dice, results, logging, validation, state readers
 *   naval.ts   — sea-zone forces, transport cargo, carrier capacity
 *   combat.ts  — battle resolution, casualties, submerge, capture
 *   actions.ts — the six phases + game setup
 *   meta.ts    — chat, summaries, serialization
 */
export * from './units';
export * from './core';
export * from './naval';
export * from './combat';
export * from './actions';
export * from './meta';
