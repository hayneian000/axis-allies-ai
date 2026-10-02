import { describe, expect, it } from 'vitest';
import { createGame, endPhase, incomeOf, ownsCapital, purchase, serialize } from '../engine/engine';
import { freshGame } from './helpers';

describe('purchase phase', () => {
  it('rejects bad player counts', () => {
    expect(() => createGame({ numPlayers: 1 })).toThrow();
    expect(() => createGame({ numPlayers: 5 })).toThrow();
  });

  it('sets up scenario banks, capitals with factories, and a shuffled turn order', () => {
    const s = freshGame(4, 42);
    expect(s.players.map((p) => p.ipcs)).toEqual([10, 10, 10, 10]);
    for (const p of s.players) {
      expect(s.territories[p.capital].factory).toBe(true);
      expect(s.territories[p.capital].owner).toBe(p.id);
      expect(ownsCapital(s, p.id)).toBe(true);
    }
    expect(s.turnOrder.slice().sort()).toEqual([0, 1, 2, 3]);
    expect(s.phase).toBe('purchase');
    // Same seed replays identically.
    expect(serialize(s)).toBe(serialize(freshGame(4, 42)));
  });

  it('spends IPCs into the mobilize pool and rejects overspending', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const bank = s.players[pid].ipcs;
    const before = serialize(s);
    expect(purchase(s, pid, [{ type: 'infantry', count: 99 }]).code).toBe('funds');
    expect(purchase(s, pid, [{ type: 'tank', count: 1 }, { type: 'unknown' as never, count: 1 }]).code).toBe('bad_unit');
    expect(serialize(s)).toBe(before);
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(bank - 6);
    expect(s.purchased.infantry).toBe(2);
  });

  it('blocks purchases without a capital but allows passing', () => {
    const s = freshGame(2, 2);
    const pid = s.currentPlayer;
    s.territories[s.players[pid].capital].owner = 1 - pid;
    expect(ownsCapital(s, pid)).toBe(false);
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).code).toBe('no_capital');
    expect(purchase(s, pid, []).ok).toBe(true);
  });

  it('ends purchase with turn-start snapshots', () => {
    const s = freshGame(2, 3);
    const pid = s.currentPlayer;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.phase).toBe('combatMove');
    expect(s.ownedAtTurnStart.length).toBeGreaterThan(0);
    expect(s.turnStartFactories).toContain(s.players[pid].capital);
  });

  it('computes income from owned IPC values', () => {
    const s = freshGame(4, 4);
    // West: WA2+OR1+CA5+ID1+NVUT2+AZ2 = 13.
    expect(incomeOf(s, 0)).toBe(13);
  });
});
