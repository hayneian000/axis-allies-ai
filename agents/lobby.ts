// Seat configuration builder + validation for Phase 2 BYOK games.

import type { ProviderId, SeatConfig } from './types';

export interface LobbySeatInput {
  kind: 'human' | 'ai';
  provider?: ProviderId;
  model?: string;
  name?: string;
}

export function buildSeats(inputs: LobbySeatInput[], playerNames: string[]): SeatConfig[] {
  if (inputs.length !== playerNames.length) {
    throw new Error(
      `Lobby needs one seat per player: got ${inputs.length} seat(s) for ${playerNames.length} player(s).`,
    );
  }
  return inputs.map((input, i) => {
    if (input.kind === 'ai') {
      if (!input.provider) throw new Error(`Seat ${i}: an AI seat needs a provider.`);
      if (!input.model) throw new Error(`Seat ${i}: an AI seat needs a model.`);
      return {
        seatIndex: i,
        playerId: i,
        kind: 'ai',
        provider: input.provider,
        model: input.model,
        keySlot: input.provider,
      } satisfies SeatConfig;
    }
    return { seatIndex: i, playerId: i, kind: 'human' } satisfies SeatConfig;
  });
}

/**
 * Validate seat configs. Returns error strings; empty means valid.
 * Model registry membership is the providers chunk's job — here a model id
 * only needs to be a non-empty string. All-human tables are valid.
 */
export function validateSeats(seats: SeatConfig[]): string[] {
  const errors: string[] = [];
  if (seats.length < 2) errors.push('Need at least 2 seats for a game.');
  for (const s of seats) {
    if (s.kind !== 'ai') continue;
    if (!s.provider) errors.push(`Seat ${s.seatIndex}: AI seat is missing a provider.`);
    if (!s.model || s.model.trim() === '') {
      errors.push(`Seat ${s.seatIndex}: AI seat is missing a model.`);
    }
  }
  return errors;
}
