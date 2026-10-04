// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGame, ownsCapital, serialize } from '../../engine/engine';
import { freshGame } from '../helpers';

/**
 * Game Setup — 1942 2e p.6-8
 * 
 * Tests for initial game state: player count, starting IPCs,
 * capital assignment, turn order, and scenario validation.
 */
describe('game setup', () => {
  it('rejects invalid player counts (1942 2e: 2-5 players, project: 2-4)', () => {
    expect(() => createGame({ numPlayers: 1 })).toThrow();
    expect(() => createGame({ numPlayers: 5 })).toThrow();
    expect(() => createGame({ numPlayers: 0 })).toThrow();
  });

  it('accepts 2, 3, and 4 players', () => {
    for (const n of [2, 3, 4]) {
      const s = createGame({ numPlayers: n, seed: 1 });
      expect(s.players).toHaveLength(n);
    }
  });

  it('sets starting IPCs to 10 per player (scenario)', () => {
    const s = freshGame(4, 42);
    expect(s.players.map((p) => p.ipcs)).toEqual([10, 10, 10, 10]);
  });

  it('assigns capitals with factories to each player (1942 2e p.8)', () => {
    const s = freshGame(4, 42);
    for (const p of s.players) {
      expect(s.territories[p.capital].factory).toBe(true);
      expect(s.territories[p.capital].owner).toBe(p.id);
      expect(ownsCapital(s, p.id)).toBe(true);
    }
  });

  it('shuffles turn order deterministically by seed', () => {
    const s1 = freshGame(4, 42);
    const s2 = freshGame(4, 42);
    expect(s1.turnOrder).toEqual(s2.turnOrder);
    
    const s3 = freshGame(4, 99);
    // Different seed, likely different order (not guaranteed, but probable)
    expect(s3.turnOrder.slice().sort()).toEqual([0, 1, 2, 3]);
  });

  it('starts in purchase phase (1942 2e p.9: turn begins with purchase)', () => {
    const s = freshGame(2, 1);
    expect(s.phase).toBe('purchase');
  });

  it('same seed produces identical game state (determinism)', () => {
    const s1 = freshGame(4, 42);
    const s2 = freshGame(4, 42);
    expect(serialize(s1)).toBe(serialize(s2));
  });
});
