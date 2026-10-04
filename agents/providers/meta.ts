// Meta Model API adapter (OpenAI-compatible endpoint).
//
// NOTE: this is the Meta *Model API* (https://api.meta.ai), which serves Muse
// Spark models and is what Meta's current developer console (dev.meta.ai)
// issues API keys for — NOT the Llama API (https://api.llama.com), a separate
// product with separate keys. A dev.meta.ai key 401s on api.llama.com.
//
// Endpoint, model catalog, and tool calling verified live 2026-10-04:
// GET /v1/models with a dev.meta.ai key lists muse-spark-1.3 (default),
// muse-spark-1.3-contributor, muse-spark-1.2, muse-spark-1.2-contributor,
// muse-spark-1.1, sam-3.1, muse-image-1.0, muse-voice-transcribe-1.0, and a
// tool-calling chat/completions round-trip succeeded on muse-spark-1.3.

import type { CompleteRequest, CompleteResponse, ModelInfo, ProviderAdapter } from '../types';
import { openAiCompatComplete } from './openai';

export const META_BASE_URL = 'https://api.meta.ai/v1';

const MODELS: ModelInfo[] = [
  { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', default: true },
  { id: 'muse-spark-1.2', label: 'Muse Spark 1.2' },
  { id: 'muse-spark-1.1', label: 'Muse Spark 1.1' },
  // Deliberately skipped for v1: contributor variants (Meta may train on
  // them), voice/image models (not chat), sam-3.1 (segmentation, not chat).
];

export const metaAdapter: ProviderAdapter = {
  id: 'meta',
  label: 'Meta',
  endpoint: `${META_BASE_URL}/chat/completions`,
  models: MODELS,
  complete(req: CompleteRequest): Promise<CompleteResponse> {
    // Dialect notes (verified live 2026-10-04):
    // - If a token cap is ever sent, prefer max_completion_tokens over
    //   max_tokens on this API.
    // - Meta ends long *non-streaming* requests with HTTP 504; streaming is
    //   exempt. Non-streaming is fine for MVP turn sizes, but a streaming
    //   adapter will be needed before long games or tournaments.
    return openAiCompatComplete(META_BASE_URL, req);
  },
};
