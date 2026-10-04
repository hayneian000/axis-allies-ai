// Provider adapter registry.

import type { ModelInfo, ProviderAdapter, ProviderId } from '../types';
import { anthropicAdapter } from './anthropic';
import { metaAdapter } from './meta';
import { openaiAdapter } from './openai';

/** All supported providers, keyed by id. */
export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  meta: metaAdapter,
};

/** Look up a provider adapter; throws on unknown ids. */
export function getProvider(id: ProviderId): ProviderAdapter {
  const adapter = PROVIDERS[id];
  if (!adapter) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return adapter;
}

/** Curated default model for a provider. */
export function defaultModel(providerId: ProviderId): string {
  const model = getProvider(providerId).models.find((m) => m.default);
  if (!model) {
    throw new Error(`No default model configured for provider: ${providerId}`);
  }
  return model.id;
}

/** Curated model list for a provider. */
export function listModels(providerId: ProviderId): ModelInfo[] {
  return getProvider(providerId).models;
}
