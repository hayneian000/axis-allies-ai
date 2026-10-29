// AI-aware saves + autosave (ui/autosave.ts, GameState.aiSeats,
// deriveRuntimeSeats). Save version stays 3; saves never carry key material.

import { describe, expect, it } from 'vitest';
import { setActiveMap } from '../data/data';
import { createGame, deserialize, serialize } from '../engine/engine';
import type { GameState } from '../engine/types';
import { KeyStore, type KeyStorage } from '../agents/keys';
import { deriveRuntimeSeats } from '../agents/lobby';
import type { SeatConfig } from '../agents/types';
import { AUTOSAVE_KEY, createAutosaveStore } from '../ui/autosave';

function memoryStorage(): KeyStorage & { raw(): string | null } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    raw: () => map.get(AUTOSAVE_KEY) ?? null,
  };
}

const AI_SEATS: SeatConfig[] = [
  { seatIndex: 0, playerId: 0, kind: 'human' },
  { seatIndex: 1, playerId: 1, kind: 'ai', provider: 'meta', model: 'muse-spark-1.3', keySlot: 'meta' },
];

function freshGame(seats?: SeatConfig[]): GameState {
  setActiveMap('america');
  return createGame({ numPlayers: 2, seed: 1, seats });
}

describe('aiSeats in saves', () => {
  it('survives a serialize/deserialize round trip, as a copy', () => {
    const input = AI_SEATS.map((s) => ({ ...s }));
    const state = freshGame(input);
    expect(state.aiSeats).toEqual(AI_SEATS);
    // Later caller mutation of the input must not rewrite the game.
    input[1].model = 'tampered';
    expect(state.aiSeats?.[1].model).toBe('muse-spark-1.3');
    const json = serialize(state);
    expect(JSON.parse(json).aiSeats).toEqual(AI_SEATS);
    const restored = deserialize(json);
    expect(restored.aiSeats).toEqual(AI_SEATS);
    expect(serialize(restored)).toBe(json);
  });

  it('is absent when createGame gets no seats, and loads as all-human', () => {
    const state = freshGame();
    expect(state.aiSeats).toBeUndefined();
    expect('aiSeats' in JSON.parse(serialize(state))).toBe(false);
    const restored = deserialize(serialize(state));
    expect(restored.aiSeats).toBeUndefined();
  });

  it('loads a legacy v3 save fixture without the field', () => {
    const data = JSON.parse(serialize(freshGame(AI_SEATS))) as Record<string, unknown>;
    delete data.aiSeats;
    const restored = deserialize(JSON.stringify(data));
    expect(restored.aiSeats).toBeUndefined();
    expect(restored.numPlayers).toBe(2);
    expect(restored.players.map((p) => p.name)).toEqual(['Player 1', 'Player 2']);
  });

  it.each([
    ['wrong length', [{ seatIndex: 0, playerId: 0, kind: 'human' }]],
    ['bad kind', [
      { seatIndex: 0, playerId: 0, kind: 'human' },
      { seatIndex: 1, playerId: 1, kind: 'robot' },
    ]],
    ['not an array', 'human'],
    ['misaligned seat indices', [
      { seatIndex: 1, playerId: 1, kind: 'human' },
      { seatIndex: 0, playerId: 0, kind: 'human' },
    ]],
  ])('malformed aiSeats (%s) loads as all-human without throwing', (_label, bad) => {
    const data = JSON.parse(serialize(freshGame())) as Record<string, unknown>;
    data.aiSeats = bad;
    let restored: GameState | undefined;
    expect(() => {
      restored = deserialize(JSON.stringify(data));
    }).not.toThrow();
    expect(restored!.aiSeats).toBeUndefined();
    expect(restored!.players.length).toBe(2);
  });
});

describe('no key material in saves', () => {
  it('serialized AI games contain neither a stored key nor key-like fields', () => {
    const storage = memoryStorage();
    const keys = new KeyStore(storage);
    const dummy = 'sk-DUMMY-KEY-12345-do-not-use';
    keys.saveKey('meta', dummy, true);
    expect(keys.hasKey('meta')).toBe(true);
    const json = serialize(freshGame(AI_SEATS));
    expect(json).not.toContain(dummy);
    expect(json).not.toContain('sk-DUMMY');
  });

  it('deserialize strips smuggled key fields from a hand-edited save', () => {
    const dummy = 'sk-DUMMY-KEY-12345-do-not-use';
    const data = JSON.parse(serialize(freshGame(AI_SEATS))) as {
      aiSeats: Array<Record<string, unknown>>;
    };
    data.aiSeats[1].key = dummy;
    data.aiSeats[1].apiKey = dummy;
    const restored = deserialize(JSON.stringify(data));
    expect(serialize(restored)).not.toContain(dummy);
    expect(restored.aiSeats?.[1]).not.toHaveProperty('key');
    expect(restored.aiSeats?.[1]).not.toHaveProperty('apiKey');
  });
});

describe('deriveRuntimeSeats', () => {
  it('leaves seats unchanged when every key is present, without mutating input', () => {
    const before = JSON.stringify(AI_SEATS);
    const { seats, downgraded } = deriveRuntimeSeats(AI_SEATS, () => true);
    expect(seats).toEqual(AI_SEATS);
    expect(downgraded).toEqual([]);
    expect(JSON.stringify(AI_SEATS)).toBe(before);
    expect(seats[0]).not.toBe(AI_SEATS[0]);
  });

  it('downgrades only the keyless seat, session-only', () => {
    const { seats, downgraded } = deriveRuntimeSeats(AI_SEATS, (p) => p !== 'meta');
    expect(downgraded).toEqual([1]);
    expect(seats[0]).toEqual({ seatIndex: 0, playerId: 0, kind: 'human' });
    expect(seats[1]).toEqual({ seatIndex: 1, playerId: 1, kind: 'human' });
    // The input still says AI: the downgrade was never written back.
    expect(AI_SEATS[1].kind).toBe('ai');
  });

  it('downgrades unknown providers without consulting the key store', () => {
    const weird = [
      { seatIndex: 0, playerId: 0, kind: 'human' },
      { seatIndex: 1, playerId: 1, kind: 'ai', provider: 'bogus', model: 'x' },
    ] as unknown as SeatConfig[];
    const { seats, downgraded } = deriveRuntimeSeats(weird, (p) => {
      if ((p as string) === 'bogus') throw new Error('must not be asked about unknown providers');
      return true;
    });
    expect(downgraded).toEqual([1]);
    expect(seats[1].kind).toBe('human');
  });
});

describe('autosave store (injected memory storage)', () => {
  it('saves, loads, and clears a round trip', () => {
    const store = createAutosaveStore(memoryStorage());
    const state = freshGame(AI_SEATS);
    expect(store.loadAutosave()).toBeNull();
    store.saveAutosave(state);
    const rec = store.loadAutosave();
    expect(rec).not.toBeNull();
    expect(rec!.save).toBe(serialize(state));
    expect(Number.isNaN(Date.parse(rec!.savedAt))).toBe(false);
    store.clearAutosave();
    expect(store.loadAutosave()).toBeNull();
  });

  it('recordGameState writes a playable save mid-game and clears on gameover', () => {
    const store = createAutosaveStore(memoryStorage());
    const state = freshGame(AI_SEATS);
    state.round = 3;
    store.recordGameState(state);
    const rec = store.loadAutosave();
    expect(rec).not.toBeNull();
    const restored = deserialize(rec!.save);
    expect(restored.round).toBe(3);
    expect(restored.phase).toBe('purchase');
    expect(restored.aiSeats).toEqual(AI_SEATS);
    // A finished game has nothing to resume, even over an old record.
    state.phase = 'gameover';
    store.recordGameState(state);
    expect(store.loadAutosave()).toBeNull();
  });

  it('corrupt payloads return null, never throw', () => {
    const storage = memoryStorage();
    const store = createAutosaveStore(storage);
    storage.setItem(AUTOSAVE_KEY, 'not json{{{');
    expect(store.loadAutosave()).toBeNull();
    expect(store.peekAutosave()).toBeNull();
    storage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: 5, save: 42 }));
    expect(store.loadAutosave()).toBeNull();
    expect(store.peekAutosave()).toBeNull();
    storage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: 'x', save: '{}' }));
    expect(store.peekAutosave()).toBeNull();
  });

  it('peek returns round and mapId for the Resume label', () => {
    const store = createAutosaveStore(memoryStorage());
    const state = freshGame(AI_SEATS);
    state.round = 5;
    store.saveAutosave(state);
    expect(store.peekAutosave()).toEqual({ round: 5, mapId: 'america' });
  });
});
