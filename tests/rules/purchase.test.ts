// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createGame,
  endPhase,
  incomeOf,
  ownsCapital,
  purchase,
  serialize,
} from '../../engine/engine';
import { freshGame } from '../helpers';

/**
 * Phase 1: Purchase Units — 1942 2e p.9-11
 *
 * Unit costs (1942 2e p.9):
 * - Infantry: 3 IPCs
 * - Artillery: 4 IPCs
 * - Tank: 6 IPCs
 * - Fighter: 10 IPCs
 * - Bomber: 12 IPCs
 * - AA Gun: 5 IPCs
 */
describe('purchase phase', () => {
  // 1942 2e p.9: Unit costs table
  it('charges correct IPCs per unit type', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    
    // Infantry: 3
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 3);
  });

  it('rejects overspending (1942 2e p.10: cannot spend more than IPCs)', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const before = serialize(s);
    expect(purchase(s, pid, [{ type: 'infantry', count: 99 }]).code).toBe('funds');
    expect(serialize(s)).toBe(before); // State unchanged on failure
  });

  it('rejects invalid unit types', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    expect(
      purchase(s, pid, [{ type: 'tank', count: 1 }, { type: 'unknown' as never, count: 1 }]).code,
    ).toBe('bad_unit');
  });

  it('deducts IPCs immediately on purchase (1942 2e p.10)', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 6);
    expect(s.purchased.infantry).toBe(2);
  });

  it('allows purchasing zero units (pass)', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    expect(purchase(s, pid, []).ok).toBe(true);
  });

  // 1942 2e p.10: If you lose your capital, you cannot purchase new units
  it('blocks purchases without a capital but allows passing', () => {
    const s = freshGame(2, 2);
    const pid = s.currentPlayer;
    s.territories[s.players[pid].capital].owner = 1 - pid;
    expect(ownsCapital(s, pid)).toBe(false);
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).code).toBe('no_capital');
    expect(purchase(s, pid, []).ok).toBe(true);
  });

  it('ends purchase phase advancing to combat move', () => {
    const s = freshGame(2, 3);
    const pid = s.currentPlayer;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.phase).toBe('combatMove');
  });

  // 1942 2e p.11: IPC income based on territory values
  it('computes income from owned territory IPC values', () => {
    const s = freshGame(4, 4);
    expect(incomeOf(s, 0)).toBe(13);
  });

  // Boundary: exact IPCs
  it('allows purchase with exact IPCs available', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 6; // Exactly 2 infantry
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(0);
  });

  // Boundary: one over
  it('rejects purchase one IPC over budget', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 5; // Need 6 for 2 infantry
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).code).toBe('funds');
  });
});
