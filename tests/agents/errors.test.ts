// classifyProviderError: failure classes for the seat-level error card.
import { describe, expect, it } from 'vitest';
import { classifyProviderError, MissingKeyError } from '../../agents/errors';

describe('classifyProviderError', () => {
  it('classifies missing keys', () => {
    const c = classifyProviderError(new MissingKeyError('anthropic'), 'Anthropic');
    expect(c.kind).toBe('missing-key');
    expect(c.guidance).toContain('Anthropic');
  });

  it('classifies 401/403 as auth', () => {
    for (const msg of [
      'Anthropic API error: 401 Unauthorized',
      'OpenAI-compatible API error at https://x: 403 Forbidden',
    ]) {
      const c = classifyProviderError(new Error(msg), 'Meta');
      expect(c.kind).toBe('auth');
      expect(c.headline).toContain('401/403');
    }
  });

  it('classifies 429 and 529 as rate-limit', () => {
    expect(classifyProviderError(new Error('API error: 429 Too Many Requests')).kind).toBe('rate-limit');
    expect(classifyProviderError(new Error('API error: 529 Overloaded')).kind).toBe('rate-limit');
  });

  it('classifies 400 as bad-request', () => {
    const c = classifyProviderError(new Error('API error: 400 Bad Request'));
    expect(c.kind).toBe('bad-request');
  });

  it('classifies fetch failures as network', () => {
    const c = classifyProviderError(new TypeError('Failed to fetch'));
    expect(c.kind).toBe('network');
  });

  it('falls back to unknown with the message preserved', () => {
    const c = classifyProviderError(new Error('weird: flux capacitor'));
    expect(c.kind).toBe('unknown');
    expect(c.guidance).toContain('flux capacitor');
  });

  it('handles non-Error throws', () => {
    expect(classifyProviderError('401 nope').kind).toBe('auth');
    expect(classifyProviderError(null).kind).toBe('unknown');
  });
});
