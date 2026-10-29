// Autosave: the current game, written to storage as it progresses, so
// closing the tab no longer loses it. The intro screen offers Resume
// (plus Discard) for the stored game.
//
// Storage surface mirrors agents/keys.ts (KeyStorage, localStorage in
// browsers, memory elsewhere) and is injectable for tests. The record
// shape is { savedAt, save } where save is exactly serialize(state)
// output - the payload stays parseable by deserialize, so there is no
// second save format and a manual save file and an autosave are the same
// thing. Nothing here ever holds key material: saves carry seat configs
// only (see GameState.aiSeats), never API keys.

import { serialize } from '../engine/engine';
import type { GameState } from '../engine/types';
import type { KeyStorage } from '../agents/keys';

export const AUTOSAVE_KEY = 'aaa.autosave';

export interface AutosaveRecord {
  savedAt: string;
  /** serialize(state) output, ready for deserialize. */
  save: string;
}

export interface AutosavePeek {
  round: number;
  mapId: string | undefined;
}

function createMemoryStorage(): KeyStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** localStorage in browsers; in-memory Map elsewhere (e.g. node tests). */
function defaultStorage(): KeyStorage {
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return createMemoryStorage();
}

/** Parse a stored record; null for anything missing, corrupt, or misshaped. Never throws. */
function parseRecord(raw: string | null): AutosaveRecord | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<AutosaveRecord>;
    if (typeof data.savedAt !== 'string' || typeof data.save !== 'string') return null;
    return { savedAt: data.savedAt, save: data.save };
  } catch {
    return null;
  }
}

export interface AutosaveStore {
  saveAutosave(state: GameState): void;
  loadAutosave(): AutosaveRecord | null;
  clearAutosave(): void;
  peekAutosave(): AutosavePeek | null;
  recordGameState(state: GameState): void;
}

export function createAutosaveStore(storage: KeyStorage = defaultStorage()): AutosaveStore {
  return {
    saveAutosave(state: GameState): void {
      const record: AutosaveRecord = { savedAt: new Date().toISOString(), save: serialize(state) };
      storage.setItem(AUTOSAVE_KEY, JSON.stringify(record));
    },

    loadAutosave(): AutosaveRecord | null {
      return parseRecord(storage.getItem(AUTOSAVE_KEY));
    },

    clearAutosave(): void {
      storage.removeItem(AUTOSAVE_KEY);
    },

    peekAutosave(): AutosavePeek | null {
      const record = parseRecord(storage.getItem(AUTOSAVE_KEY));
      if (!record) return null;
      try {
        const data = JSON.parse(record.save) as Partial<GameState>;
        if (typeof data.round !== 'number') return null;
        return { round: data.round, mapId: data.mapId };
      } catch {
        return null;
      }
    },

    /**
     * The single hook every call site uses: a finished game clears the
     * autosave (nothing to resume), any other state overwrites it.
     */
    recordGameState(state: GameState): void {
      if (state.phase === 'gameover') {
        storage.removeItem(AUTOSAVE_KEY);
      } else {
        const record: AutosaveRecord = {
          savedAt: new Date().toISOString(),
          save: serialize(state),
        };
        storage.setItem(AUTOSAVE_KEY, JSON.stringify(record));
      }
    },
  };
}

/** Shared singleton using the default storage backend. */
const defaultStore = createAutosaveStore();

export function saveAutosave(state: GameState): void {
  defaultStore.saveAutosave(state);
}

export function loadAutosave(): AutosaveRecord | null {
  return defaultStore.loadAutosave();
}

export function clearAutosave(): void {
  defaultStore.clearAutosave();
}

export function peekAutosave(): AutosavePeek | null {
  return defaultStore.peekAutosave();
}

export function recordGameState(state: GameState): void {
  defaultStore.recordGameState(state);
}
