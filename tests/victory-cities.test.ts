// @vitest-environment node
import { beforeAll,  afterEach, describe, expect, it  } from 'vitest';
import { scenarioFor, ensureMapLoaded, setActiveMap, victoryCityTargets, type ScenarioDef } from '../data/data';
import {
  createGame,
  deserialize,
  endPhase,
  resolveCapture,
  serialize,
  summarizeState,
  victoryCitiesHeld,
} from '../engine/engine';
import type { GameState } from '../engine/types';

// Victory cities (1942 World scenario): the 1942 2e standard victory
// (rulebook p.6 - control 3 more victory cities than you started with,
// Axis 9 / Allies 10 as side totals) dealt out per seat for the
// free-for-all: each seat's target is its starting count + 3 (Germany 6,
// USSR 5, Japan 6, UK + US 8). Evaluated ONLY at the end of a complete
// round. The capitals win stays immediate and unchanged.
//
// Territory ids of the board's 13 victory cities, by starting seat:
//   Germany (0): germany (Berlin), france (Paris), italy (Rome)
//   USSR (1): russia (Moscow), karelia_ssr (Leningrad)
//   Japan (2): japan (Tokyo), kiangsu (Shanghai), philippine_islands (Manila)
//   UK + US (3): united_kingdom (London), india (Calcutta),
//     eastern_united_states (Washington), western_united_states (San
//     Francisco), hawaiian_islands (Honolulu)
// Tests flip owners directly (the victory.test.ts style): a flip alone
// runs no capture logic, so the capitals check stays out of the way and
// the round-end VC check is what is exercised.

function game1942(seed = 7): GameState {
  setActiveMap('world1942');
  return createGame({ numPlayers: 4, seed });
}

afterEach(() => setActiveMap('america'));

function give(s: GameState, tid: string, pid: number): void {
  s.territories[tid].owner = pid;
}

/** Finish the current seat's turn with bare phase advances (no actions). */
function endTurn(s: GameState): void {
  const pid = s.currentPlayer;
  let guard = 6;
  while (s.currentPlayer === pid && s.phase !== 'gameover' && guard-- > 0) {
    const r = endPhase(s, pid);
    expect(r.ok, `endPhase ${s.phase} for seat ${pid}: ${r.code} ${r.error}`).toBe(true);
  }
}

/** Play one complete round (every seat takes one bare turn). */
function playRound(s: GameState): void {
  for (let i = 0; i < s.numPlayers; i++) endTurn(s);
}

// Code-split data: the 1942 map loads on demand, so preload it once
// per file; the sync setActiveMap calls below then work as before.
beforeAll(async () => {
  await ensureMapLoaded('world1942');
});

describe('victory cities: setup', () => {
  it('1942 game carries the per-seat targets; starting counts are 3/2/3/5', () => {
    const s = game1942();
    expect(s.victoryCitiesToWin).toEqual([6, 5, 6, 8]);
    expect(s.players.map((p) => victoryCitiesHeld(s, p.id))).toEqual([3, 2, 3, 5]);
  });

  it('America games carry no victory-city win path', () => {
    setActiveMap('america');
    const s = createGame({ numPlayers: 2, seed: 1 });
    expect(s.victoryCitiesToWin).toBeNull();
    expect(scenarioFor(2).victoryCitiesToWin).toBeUndefined();
  });

  it('victoryCityTargets normalizes a bare number and rejects bad arrays', () => {
    const bare = {
      players: 4,
      capitals: [],
      banks: [],
      holdings: [],
      neutrals: {},
      victoryCitiesToWin: 7,
    } as unknown as ScenarioDef;
    expect(victoryCityTargets(bare, 4)).toEqual([7, 7, 7, 7]);
    const none = { ...bare, victoryCitiesToWin: undefined } as unknown as ScenarioDef;
    expect(victoryCityTargets(none, 4)).toBeNull();
    const short = { ...bare, victoryCitiesToWin: [6, 5] } as unknown as ScenarioDef;
    expect(() => victoryCityTargets(short, 4)).toThrow(/victoryCitiesToWin/);
  });
});

describe('victory cities: round-end check', () => {
  it('a seat at its target when the round ends wins with victory_cities', () => {
    const s = game1942();
    // Germany 3 + Shanghai, Manila, Calcutta = 6 (its target).
    give(s, 'kiangsu', 0);
    give(s, 'philippine_islands', 0);
    give(s, 'india', 0);
    expect(victoryCitiesHeld(s, 0)).toBe(6);
    playRound(s);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.winReason).toBe('victory_cities');
    // The win is a round-1 win: the round counter never advanced past it.
    expect(s.round).toBe(1);
    const over = s.events.filter((e) => e.kind === 'game_over');
    expect(over).toHaveLength(1);
    expect(over[0].detail).toContain('Germany');
    expect(over[0].detail).toContain('6 victory cities');
    expect(over[0].detail).toContain('target 6');
  });

  it('holding the target mid-round does not end the game until the round completes', () => {
    const s = game1942();
    give(s, 'kiangsu', 0);
    give(s, 'philippine_islands', 0);
    give(s, 'india', 0);
    // Germany sits at its target from the start; its own turn ending must
    // not end the game, nor the next two seats' turns.
    endTurn(s); // Germany
    expect(s.phase).not.toBe('gameover');
    expect(s.winner).toBeNull();
    endTurn(s); // USSR
    expect(s.winner).toBeNull();
    endTurn(s); // Japan
    expect(s.winner).toBeNull();
    endTurn(s); // UK + US - the round completes here
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.winReason).toBe('victory_cities');
  });

  it('losing a city before the round ends cancels the win', () => {
    const s = game1942();
    give(s, 'kiangsu', 0);
    give(s, 'philippine_islands', 0);
    give(s, 'india', 0);
    endTurn(s); // Germany
    endTurn(s); // USSR
    // Mid-round: Calcutta is retaken before the round completes.
    give(s, 'india', 3);
    expect(victoryCitiesHeld(s, 0)).toBe(5);
    endTurn(s); // Japan
    endTurn(s); // UK + US - round ends with Germany below target
    expect(s.winner).toBeNull();
    expect(s.phase).toBe('purchase');
    expect(s.round).toBe(2);
  });

  it('thresholds are per-seat: the USSR wins at 5, Germany does not', () => {
    const ussr = game1942();
    // USSR 2 + Paris, Rome, Shanghai = 5 (its target).
    give(ussr, 'france', 1);
    give(ussr, 'italy', 1);
    give(ussr, 'kiangsu', 1);
    expect(victoryCitiesHeld(ussr, 1)).toBe(5);
    playRound(ussr);
    expect(ussr.winner).toBe(1);
    expect(ussr.winReason).toBe('victory_cities');

    const germany = game1942();
    // Germany 3 + Shanghai, Manila = 5 - one short of its target of 6.
    give(germany, 'kiangsu', 0);
    give(germany, 'philippine_islands', 0);
    expect(victoryCitiesHeld(germany, 0)).toBe(5);
    playRound(germany);
    expect(germany.winner).toBeNull();
    expect(germany.round).toBe(2);
  });

  it('simultaneous qualifiers: the seat holding more victory cities wins', () => {
    const s = game1942();
    // Germany reaches exactly its target: its own 3 + Shanghai, Manila,
    // Calcutta = 6.
    give(s, 'kiangsu', 0);
    give(s, 'philippine_islands', 0);
    give(s, 'india', 0);
    // Japan overshoots to 7: Tokyo + Moscow, Leningrad, London,
    // Washington, San Francisco, Honolulu. (Disjoint sets: all 13 victory
    // cities are held by one of the two qualifiers.)
    give(s, 'russia', 2);
    give(s, 'karelia_ssr', 2);
    give(s, 'united_kingdom', 2);
    give(s, 'eastern_united_states', 2);
    give(s, 'western_united_states', 2);
    give(s, 'hawaiian_islands', 2);
    expect(victoryCitiesHeld(s, 0)).toBe(6);
    expect(victoryCitiesHeld(s, 2)).toBe(7);
    playRound(s);
    expect(s.winner).toBe(2);
    expect(s.winReason).toBe('victory_cities');
  });

  it('simultaneous qualifiers tied on count: earlier turn order wins', () => {
    const s = game1942();
    // Germany 6 (its own 3 + Shanghai, Manila, Calcutta) and Japan 6
    // (Tokyo + Moscow, Leningrad, London, Washington, San Francisco)
    // qualify at the same round end.
    give(s, 'kiangsu', 0);
    give(s, 'philippine_islands', 0);
    give(s, 'india', 0);
    give(s, 'russia', 2);
    give(s, 'karelia_ssr', 2);
    give(s, 'united_kingdom', 2);
    give(s, 'eastern_united_states', 2);
    give(s, 'western_united_states', 2);
    expect(victoryCitiesHeld(s, 0)).toBe(6);
    expect(victoryCitiesHeld(s, 2)).toBe(6);
    playRound(s);
    // Germany sits earlier in the fixed turn order [0, 1, 2, 3].
    expect(s.winner).toBe(0);
    expect(s.winReason).toBe('victory_cities');
  });

  it('the capitals win still fires immediately, mid-round, on the 1942 board', () => {
    const s = game1942();
    expect(s.victoryCitiesToWin).toEqual([6, 5, 6, 8]);
    // Germany takes Moscow: 2 of 5 capitals, no win yet.
    s.territories.russia.owner = 0;
    resolveCapture(s, 'russia', 0, 1);
    expect(s.winner).toBeNull();
    // Germany takes Tokyo: 3 of 5 capitals - the game ends on the spot,
    // in the purchase phase of round 1, with no round-end check involved.
    s.territories.japan.owner = 0;
    resolveCapture(s, 'japan', 0, 2);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
    expect(s.winReason).toBe('majority_capitals');
    expect(s.round).toBe(1);
  });
});

describe('victory cities: America has no VC path', () => {
  it('an America game plays full rounds with no VC state and no VC win', () => {
    setActiveMap('america');
    const s = createGame({ numPlayers: 2, seed: 3 });
    expect(s.victoryCitiesToWin).toBeNull();
    playRound(s);
    playRound(s);
    expect(s.winner).toBeNull();
    expect(s.round).toBe(3);
    expect(summarizeState(s, s.currentPlayer)).not.toContain('Victory cities');
  });
});

describe('victory cities: brief and saves', () => {
  it('the agent brief lists per-seat VC counts, targets, and round-end timing', () => {
    const s = game1942();
    const brief = summarizeState(s, 0);
    expect(brief).toContain('Victory cities');
    expect(brief).toContain('Germany 3/6');
    expect(brief).toContain('USSR 2/5');
    expect(brief).toContain('Japan 3/6');
    expect(brief).toContain('UK + US 5/8');
    expect(brief).toContain('end of a complete round');
  });

  it('save/load round trip preserves the VC thresholds and counts', () => {
    const s = game1942();
    give(s, 'india', 0);
    const json = serialize(s);
    setActiveMap('america');
    const restored = deserialize(json);
    expect(restored.victoryCitiesToWin).toEqual([6, 5, 6, 8]);
    expect(victoryCitiesHeld(restored, 0)).toBe(4);
    expect(serialize(restored)).toBe(json);
  });

  it('a legacy save without the field gets the targets backfilled from its scenario', () => {
    const s = game1942();
    const data = JSON.parse(serialize(s));
    delete data.victoryCitiesToWin;
    setActiveMap('america');
    const restored = deserialize(JSON.stringify(data));
    expect(restored.victoryCitiesToWin).toEqual([6, 5, 6, 8]);

    setActiveMap('america');
    const a = JSON.parse(serialize(createGame({ numPlayers: 2, seed: 5 })));
    delete a.victoryCitiesToWin;
    const restoredAmerica = deserialize(JSON.stringify(a));
    expect(restoredAmerica.victoryCitiesToWin).toBeNull();
  });
});
