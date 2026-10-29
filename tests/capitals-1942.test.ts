import { beforeAll,  afterEach, describe, expect, it  } from 'vitest';
import { ensureMapLoaded, setActiveMap } from '../data/data';
import {
  PLAYER_COLORS,
  capitalsOf,
  createGame,
  endPhase,
  incomeOf,
  ownsCapital,
  purchase,
  resolveCapture,
} from '../engine/engine';
import type { GameState } from '../engine/types';

// Multi-capital seats (1942 board): the board has five capitals but four
// seats. Seat 3 (British + Americans) registers BOTH united_kingdom and
// eastern_united_states as its capitals. Semantics:
//  - capturing ANY capital of a seat steals that seat's whole bank;
//  - the seat is purchase/income-blocked only while it holds NONE of its
//    capitals;
//  - victory = hold a majority of all five board capitals (3).

function game1942(): GameState {
  setActiveMap('world1942');
  return createGame({ numPlayers: 4, seed: 7 });
}

afterEach(() => setActiveMap('america'));

// Code-split data: the 1942 map loads on demand, so preload it once
// per file; the sync setActiveMap calls below then work as before.
beforeAll(async () => {
  await ensureMapLoaded('world1942');
});

describe('registration', () => {
  it('seat 3 registers both capitals; other seats register one', () => {
    const s = game1942();
    expect(s.players[0].capitals).toEqual(['germany']);
    expect(s.players[1].capitals).toEqual(['russia']);
    expect(s.players[2].capitals).toEqual(['japan']);
    expect(s.players[3].capitals).toEqual(['united_kingdom', 'eastern_united_states']);
    expect(s.players[3].capital).toBe('united_kingdom'); // primary
    expect(capitalsOf(s, 3)).toEqual(['united_kingdom', 'eastern_united_states']);
    expect(s.capitalsToWin).toBe(3);
  });

  it('seat chrome colors are the official nation colors on the 1942 board', () => {
    const s = game1942();
    expect(s.players.map((p) => p.color)).toEqual(['#5a5a5a', '#af2828', '#e87112', '#916400']);
  });

  it('America games keep single capitals and the classic seat colors', () => {
    setActiveMap('america');
    const s = createGame({ numPlayers: 2, seed: 7 });
    for (const p of s.players) {
      expect(p.capitals).toEqual([p.capital]);
      expect(p.color).toBe(PLAYER_COLORS[p.id]);
    }
  });
});

describe('purchase / income blocking', () => {
  it('losing Washington alone does NOT block seat 3 (London still held)', () => {
    const s = game1942();
    s.territories.eastern_united_states.owner = 0;
    expect(ownsCapital(s, 3)).toBe(true);
    s.currentPlayer = 3;
    expect(s.phase).toBe('purchase');
    const r = purchase(s, 3, [{ type: 'infantry', count: 1 }]);
    expect(r.ok, r.error).toBe(true);
  });

  it('losing London alone does NOT block seat 3 either', () => {
    const s = game1942();
    s.territories.united_kingdom.owner = 0;
    expect(ownsCapital(s, 3)).toBe(true);
  });

  it('losing BOTH capitals blocks purchase and income', () => {
    const s = game1942();
    s.territories.united_kingdom.owner = 0;
    s.territories.eastern_united_states.owner = 0;
    expect(ownsCapital(s, 3)).toBe(false);
    s.currentPlayer = 3;
    const r = purchase(s, 3, [{ type: 'infantry', count: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_capital');
    // Income at end of mobilize is 0 despite holding income-bearing land.
    const bankBefore = s.players[3].ipcs;
    expect(incomeOf(s, 3)).toBeGreaterThan(0);
    s.phase = 'mobilize';
    const e = endPhase(s, 3);
    expect(e.ok, e.error).toBe(true);
    expect(s.players[3].ipcs).toBe(bankBefore);
  });

  it('with one capital held, income is collected normally', () => {
    const s = game1942();
    s.territories.eastern_united_states.owner = 0;
    s.currentPlayer = 3;
    s.phase = 'mobilize';
    const bankBefore = s.players[3].ipcs;
    const e = endPhase(s, 3);
    expect(e.ok, e.error).toBe(true);
    expect(s.players[3].ipcs).toBe(bankBefore + incomeOf(s, 3));
  });
});

describe('bank steal', () => {
  it('capturing Washington steals seat 3\u2019s bank', () => {
    const s = game1942();
    s.players[3].ipcs = 50;
    s.players[0].ipcs = 41;
    resolveCapture(s, 'eastern_united_states', 0, 3);
    expect(s.territories.eastern_united_states.owner).toBe(0);
    expect(s.players[0].ipcs).toBe(91);
    expect(s.players[3].ipcs).toBe(0);
  });

  it('capturing London steals seat 3\u2019s bank too', () => {
    const s = game1942();
    s.players[3].ipcs = 50;
    s.players[2].ipcs = 30;
    resolveCapture(s, 'united_kingdom', 2, 3);
    expect(s.players[2].ipcs).toBe(80);
    expect(s.players[3].ipcs).toBe(0);
  });

  it('capturing a non-capital steals nothing', () => {
    const s = game1942();
    s.players[3].ipcs = 50;
    s.players[0].ipcs = 41;
    resolveCapture(s, 'india', 0, 3);
    expect(s.players[0].ipcs).toBe(41);
    expect(s.players[3].ipcs).toBe(50);
  });
});

describe('victory: majority of the five board capitals', () => {
  it('holding 3 of 5 capitals wins', () => {
    const s = game1942();
    s.territories.russia.owner = 0;
    s.territories.japan.owner = 0;
    // Seat 0 now holds germany + russia + japan; any capture re-checks.
    resolveCapture(s, 'india', 0, 3);
    expect(s.winner).toBe(0);
    expect(s.winReason).toBe('majority_capitals');
    expect(s.phase).toBe('gameover');
  });

  it('holding 2 of 5 does not win', () => {
    const s = game1942();
    resolveCapture(s, 'eastern_united_states', 0, 3); // germany + Washington = 2
    expect(s.winner).toBeNull();
    expect(s.phase).not.toBe('gameover');
  });

  it('seat 3 holding both of its own plus one more wins', () => {
    const s = game1942();
    s.territories.japan.owner = 3;
    resolveCapture(s, 'india', 3, 0); // seat 3 captures from seat 0; re-check
    expect(s.winner).toBe(3);
  });
});
