// Provider failure classification for the seat-level error UI.
// Pure logic: no DOM, no network. Tested in tests/agents/errors.test.ts.

/** Machine-readable failure classes surfaced to the host. */
export type ProviderFailureKind =
  | 'missing-key'
  | 'auth'
  | 'rate-limit'
  | 'network'
  | 'bad-request'
  | 'unknown';

export interface ClassifiedFailure {
  kind: ProviderFailureKind;
  /** Short headline for the error card. */
  headline: string;
  /** One line of actionable guidance. */
  guidance: string;
}

/**
 * Classify a provider-call failure into something the host can act on.
 * `providerLabel` (e.g. "Anthropic") is used in guidance text when given.
 */
export function classifyProviderError(err: unknown, providerLabel?: string): ClassifiedFailure {
  const where = providerLabel ? ` for ${providerLabel}` : '';
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  if (name === 'MissingKeyError' || name === 'MissingApiKeyError' || /no api key/i.test(message)) {
    return {
      kind: 'missing-key',
      headline: 'No API key saved for this seat',
      guidance: `Enter a key${where} on the seat card (or below), then retry. The game is paused until you decide.`,
    };
  }
  if (/\b401\b|\b403\b/.test(message)) {
    return {
      kind: 'auth',
      headline: `Key rejected${where} (401/403)`,
      guidance:
        'The provider refused this key. It may be expired, revoked, or issued for a different product — then retry.',
    };
  }
  if (/\b429\b/.test(message)) {
    return {
      kind: 'rate-limit',
      headline: `Rate limited${where} (429)`,
      guidance: 'The provider is throttling this key. Wait a moment, then retry.',
    };
  }
  if (/\b529\b/.test(message)) {
    return {
      kind: 'rate-limit',
      headline: `Provider overloaded${where} (529)`,
      guidance: 'The provider is overloaded. Wait a moment, then retry.',
    };
  }
  if (/\b400\b/.test(message)) {
    return {
      kind: 'bad-request',
      headline: `Request rejected${where} (400)`,
      guidance:
        'The provider did not like the request shape. Retry once; if it persists, skip the phase or pass the seat.',
    };
  }
  if (
    name === 'TypeError' ||
    /failed to fetch|networkerror|load failed|econnrefused|enotfound|etimedout|network request failed/i.test(
      message,
    )
  ) {
    return {
      kind: 'network',
      headline: 'Network error',
      guidance: 'Could not reach the provider. Check your connection, then retry.',
    };
  }
  return {
    kind: 'unknown',
    headline: 'Provider error',
    guidance: message ? `The provider call failed: ${message}` : 'The provider call failed for an unknown reason.',
  };
}

/** Error thrown when a seat has no usable key at call time. */
export class MissingKeyError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(`No API key saved for provider "${providerId}".`);
    this.name = 'MissingKeyError';
    this.providerId = providerId;
  }
}
