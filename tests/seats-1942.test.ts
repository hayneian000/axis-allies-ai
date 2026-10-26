// 1942 seat identity: the scenario names its seats (the powers) and fixes
// the turn order (1942 2e power order). America free-for-all games keep
// generic names and the seeded shuffle.
import { afterEach, describe, expect, it } from 'vitest';
import { scenarioFor, setActiveMap } from '../data/data';
import { createGame } from '../engine/engine';

afterEach(() => setActiveMap('america'));

describe('1942 seats and turn order', () => {
  it('names players from the scenario seat names', () => {
    setActiveMap('world1942');
    const s = createGame({ numPlayers: 4, seed: 7 });
    expect(s.players.map((p) => p.name)).toEqual(scenarioFor(4).seatNames);
    expect(s.players.map((p) => p.name)).toEqual(['Germany', 'USSR', 'Japan', 'UK + US']);
  });

  it('plays in the fixed scenario order for every seed, Germany first', () => {
    setActiveMap('world1942');
    for (const seed of [1, 7, 42, 99, 123456]) {
      const s = createGame({ numPlayers: 4, seed });
      expect(s.turnOrder).toEqual(scenarioFor(4).turnOrder);
      expect(s.turnOrder).toEqual([0, 1, 2, 3]);
      expect(s.currentPlayer).toBe(0);
      expect(s.players[s.currentPlayer].name).toBe('Germany');
    }
  });

  it('announces the power order in the game-start log', () => {
    setActiveMap('world1942');
    const s = createGame({ numPlayers: 4, seed: 7 });
    const start = s.events.find((e) => e.kind === 'game_start');
    expect(start?.detail).toContain('Germany, USSR, Japan, UK + US');
  });

  it('caller-supplied names win, per seat, over the scenario names', () => {
    setActiveMap('world1942');
    const full = createGame({
      numPlayers: 4,
      seed: 7,
      playerNames: ['Ana', 'Bo', 'Cy', 'Di'],
    });
    expect(full.players.map((p) => p.name)).toEqual(['Ana', 'Bo', 'Cy', 'Di']);
    // The fixed order does not follow the names; it is the seats' order.
    expect(full.turnOrder).toEqual([0, 1, 2, 3]);

    const partial = createGame({ numPlayers: 4, seed: 7, playerNames: ['', 'Bo'] });
    expect(partial.players.map((p) => p.name)).toEqual(['Germany', 'Bo', 'Japan', 'UK + US']);
  });
});

describe('America seats and turn order (unchanged)', () => {
  it('keeps generic names and a shuffled order', () => {
    setActiveMap('america');
    const s = createGame({ numPlayers: 3, seed: 7 });
    expect(s.players.map((p) => p.name)).toEqual(['Player 1', 'Player 2', 'Player 3']);
    expect([...s.turnOrder].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('the shuffle actually varies who leads across seeds', () => {
    setActiveMap('america');
    const leaders = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      leaders.add(createGame({ numPlayers: 4, seed }).turnOrder[0]);
    }
    expect(leaders.size).toBeGreaterThan(1);
  });
});
