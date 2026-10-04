// BYOK key store: client-side key slots, never persisted by adapters. Keys are never logged.

import type { ProviderId } from './types';

/** Minimal storage surface; localStorage satisfies this in browsers. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'meta'];

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

function slotKey(provider: ProviderId): string {
  return `aaa.byok.${provider}`;
}

export class KeyStore {
  /** Session-only keys (or all keys in memory-only mode). */
  private readonly memory = new Map<ProviderId, string>();

  constructor(private readonly storage: KeyStorage = defaultStorage()) {}

  /**
   * Save a key. `remember=false` keeps it session-only and never touches
   * persistent storage. Trimmed; an empty key clears the slot.
   */
  saveKey(provider: ProviderId, key: string, remember: boolean): void {
    const trimmed = key.trim();
    if (trimmed === '') {
      this.clearKey(provider);
      return;
    }
    this.memory.set(provider, trimmed);
    if (remember) {
      this.storage.setItem(slotKey(provider), trimmed);
    }
  }

  /** Session key first, then the remembered (persisted) slot. */
  getKey(provider: ProviderId): string | null {
    return this.memory.get(provider) ?? this.storage.getItem(slotKey(provider));
  }

  hasKey(provider: ProviderId): boolean {
    return this.getKey(provider) !== null;
  }

  clearKey(provider: ProviderId): void {
    this.memory.delete(provider);
    this.storage.removeItem(slotKey(provider));
  }

  clearAll(): void {
    for (const provider of PROVIDER_IDS) {
      this.clearKey(provider);
    }
  }
}

/** Shared singleton using the default storage backend. */
export const keyStore = new KeyStore();
