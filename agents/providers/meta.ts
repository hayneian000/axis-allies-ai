// Meta Llama API adapter (OpenAI-compatible endpoint). Model IDs verified 2026-10-03.

import type { CompleteRequest, CompleteResponse, ModelInfo, ProviderAdapter } from '../types';
import { openAiCompatComplete } from './openai';

// Use the OpenAI-compatible endpoint: the native /v1 endpoint returns a different
// `completion_message` response shape, while /compat/v1 returns the standard `choices` shape.
export const LLAMA_BASE_URL = 'https://api.llama.com/compat/v1';

const MODELS: ModelInfo[] = [
  { id: 'Llama-4-Maverick-17B-128E-Instruct-FP8', label: 'Llama 4 Maverick', default: true },
  { id: 'Llama-4-Scout-17B-16E-Instruct-FP8', label: 'Llama 4 Scout' },
  { id: 'Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' },
];

export const metaAdapter: ProviderAdapter = {
  id: 'meta',
  label: 'Meta',
  endpoint: `${LLAMA_BASE_URL}/chat/completions`,
  models: MODELS,
  complete(req: CompleteRequest): Promise<CompleteResponse> {
    // NOTE: Llama tool-calling quality varies by model; live-key verification of
    // tool-call round-trips against this endpoint is still needed before relying on it.
    return openAiCompatComplete(LLAMA_BASE_URL, req);
  },
};
