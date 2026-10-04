// KeyStore behavior tests: save/get/clear/hasKey/clearAll, memory-only mode, node default.
import { describe, expect, it } from 'vitest';
import { KeyStore, keyStore, type KeyStorage } from '../../agents/keys';

/** Map-backed fake for the injectable storage backend. */
function fakeStorage(): KeyStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage: KeyStorage = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
  return Object.assign(storage, { map });
}

describe('KeyStore with injected storage', () => {
  it('saves, gets, and checks keys', () => {
    const store = new KeyStore(fakeStorage());
    expect(store.hasKey('anthropic')).toBe(false);
    store.saveKey('anthropic', 'key-abc', true);
    expect(store.getKey('anthropic')).toBe('key-abc');
    expect(store.hasKey('anthropic')).toBe(true);
  });

  it('persists to storage when remember=true', () => {
    const storage = fakeStorage();
    const store = new KeyStore(storage);
    store.saveKey('openai', 'key-xyz', true);
    expect(storage.map.get('aaa.byok.openai')).toBe('key-xyz');
  });

  it('never touches injected storage when remember=false (memory-only)', () => {
    const storage = fakeStorage();
    const store = new KeyStore(storage);
    store.saveKey('openai', 'session-key', false);
    expect(store.getKey('openai')).toBe('session-key');
    expect(store.hasKey('openai')).toBe(true);
    expect(storage.map.size).toBe(0);
  });

  it('falls back to the remembered slot when memory is empty', () => {
    const storage = fakeStorage();
    storage.setItem('aaa.byok.meta', 'remembered-key');
    const store = new KeyStore(storage);
    expect(store.getKey('meta')).toBe('remembered-key');
    expect(store.hasKey('meta')).toBe(true);
  });

  it('trims keys before saving', () => {
    const store = new KeyStore(fakeStorage());
    store.saveKey('anthropic', '  spaced-key  ', true);
    expect(store.getKey('anthropic')).toBe('spaced-key');
  });

  it('treats an empty string as clear', () => {
    const storage = fakeStorage();
    const store = new KeyStore(storage);
    store.saveKey('anthropic', 'key-abc', true);
    store.saveKey('anthropic', '   ', true);
    expect(store.hasKey('anthropic')).toBe(false);
    expect(storage.map.has('aaa.byok.anthropic')).toBe(false);
  });

  it('clears memory and storage on clearKey', () => {
    const storage = fakeStorage();
    const store = new KeyStore(storage);
    store.saveKey('meta', 'k1', true);
    store.clearKey('meta');
    expect(store.getKey('meta')).toBeNull();
    expect(storage.map.has('aaa.byok.meta')).toBe(false);
  });

  it('clearAll wipes every provider slot', () => {
    const storage = fakeStorage();
    const store = new KeyStore(storage);
    store.saveKey('anthropic', 'a', true);
    store.saveKey('openai', 'b', false);
    store.saveKey('meta', 'c', true);
    store.clearAll();
    expect(store.hasKey('anthropic')).toBe(false);
    expect(store.hasKey('openai')).toBe(false);
    expect(store.hasKey('meta')).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it('keeps provider slots separate', () => {
    const store = new KeyStore(fakeStorage());
    store.saveKey('anthropic', 'key-a', true);
    store.saveKey('openai', 'key-o', true);
    expect(store.getKey('anthropic')).toBe('key-a');
    expect(store.getKey('openai')).toBe('key-o');
  });
});

describe('default keyStore export in node', () => {
  it('falls back to in-memory storage without crashing', () => {
    // node has no localStorage; this must not throw.
    keyStore.saveKey('meta', 'node-key', false);
    expect(keyStore.getKey('meta')).toBe('node-key');
    expect(keyStore.hasKey('meta')).toBe(true);
    keyStore.clearKey('meta');
    expect(keyStore.hasKey('meta')).toBe(false);
  });
});
