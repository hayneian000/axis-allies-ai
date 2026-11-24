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

// Capitals on the 1942 board: five seats, five capitals, one per seat.
// united_kingdom belongs to seat 3 (UK) and eastern_united_states to
// seat 4 (US). Semantics, the same as any single-capital seat:
//  - capturing a seat's capital steals that seat's whole bank;
//  - the seat is purchase/income-blocked while it holds no capital;
//  - victory = hold a majority of all five board capitals (3).

function game1942(): GameState {
  setActiveMap('world1942');
  return createGame({ numPlayers: 5, seed: 7 });
}

afterEach(() => setActiveMap('america'));

// Code-split data: the 1942 map loads on demand, so preload it once
// per file; the sync setActiveMap calls below then work as before.
beforeAll(async () => {
  await ensureMapLoaded('world1942');
});

describe('registration', () => {
  it('each seat registers exactly one capital', () => {
    const s = game1942();
    expect(s.players[0].capitals).toEqual(['germany']);
    expect(s.players[1].capitals).toEqual(['russia']);
    expect(s.players[2].capitals).toEqual(['japan']);
    expect(s.players[3].capitals).toEqual(['united_kingdom']);
    expect(s.players[4].capitals).toEqual(['eastern_united_states']);
    expect(s.players[3].capital).toBe('united_kingdom');
    expect(s.players[4].capital).toBe('eastern_united_states');
    expect(capitalsOf(s, 3)).toEqual(['united_kingdom']);
    expect(capitalsOf(s, 4)).toEqual(['eastern_united_states']);
    expect(s.capitalsToWin).toBe(3);
  });

  it('seat chrome colors are the official nation colors on the 1942 board', () => {
    const s = game1942();
    expect(s.players.map((p) => p.color)).toEqual(['#5a5a5a', '#af2828', '#e87112', '#916400', '#5a5a00']);
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
  it('losing Washington blocks seat 4 (it has no second capital)', () => {
    const s = game1942();
    s.territories.eastern_united_states.owner = 0;
    expect(ownsCapital(s, 4)).toBe(false);
    s.currentPlayer = 4;
    expect(s.phase).toBe('purchase');
    const r = purchase(s, 4, [{ type: 'infantry', count: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_capital');
  });

  it('losing London blocks seat 3 the same way', () => {
    const s = game1942();
    s.territories.united_kingdom.owner = 0;
    expect(ownsCapital(s, 3)).toBe(false);
    s.currentPlayer = 3;
    const r = purchase(s, 3, [{ type: 'infantry', count: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_capital');
  });

  it('losing its only capital blocks income too', () => {
    const s = game1942();
    s.territories.eastern_united_states.owner = 0;
    expect(ownsCapital(s, 4)).toBe(false);
    // Income at end of mobilize is 0 despite holding income-bearing land.
    const bankBefore = s.players[4].ipcs;
    expect(incomeOf(s, 4)).toBeGreaterThan(0);
    s.currentPlayer = 4;
    s.phase = 'mobilize';
    const e = endPhase(s, 4);
    expect(e.ok, e.error).toBe(true);
    expect(s.players[4].ipcs).toBe(bankBefore);
  });

  it('with its capital held, income is collected normally', () => {
    const s = game1942();
    s.currentPlayer = 4;
    s.phase = 'mobilize';
    const bankBefore = s.players[4].ipcs;
    const e = endPhase(s, 4);
    expect(e.ok, e.error).toBe(true);
    expect(s.players[4].ipcs).toBe(bankBefore + incomeOf(s, 4));
  });
});

describe('bank steal', () => {
  it('capturing Washington steals seat 4’s bank', () => {
    const s = game1942();
    s.players[4].ipcs = 50;
    s.players[0].ipcs = 41;
    resolveCapture(s, 'eastern_united_states', 0, 4);
    expect(s.territories.eastern_united_states.owner).toBe(0);
    expect(s.players[0].ipcs).toBe(91);
    expect(s.players[4].ipcs).toBe(0);
  });

  it('capturing London steals seat 3’s bank too', () => {
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
    resolveCapture(s, 'eastern_united_states', 0, 4); // germany + Washington = 2
    expect(s.winner).toBeNull();
    expect(s.phase).not.toBe('gameover');
  });

  it('seat 4 holding its own capital plus two more wins', () => {
    const s = game1942();
    s.territories.japan.owner = 4;
    s.territories.united_kingdom.owner = 4;
    resolveCapture(s, 'india', 4, 3); // seat 4 captures from seat 3; re-check
    expect(s.winner).toBe(4);
  });
});
