// Seat configuration builder + validation for Phase 2 BYOK games.

import { PROVIDERS } from './providers/index';
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

export interface DerivedRuntimeSeats {
  /** Seats to actually run this session (copies; the input is untouched). */
  seats: SeatConfig[];
  /** Seat indices that were AI in the save but run as human this session. */
  downgraded: number[];
}

/**
 * Turn a saved seat table into the seats for this session. Pure and
 * side-effect free: an AI seat whose provider is unknown to the registry
 * or has no saved key becomes a human seat for this session only. The
 * input array and its entries are never mutated, and the downgrade is
 * never written back into state.aiSeats - the save keeps its AI seats,
 * so a later session with the key present resumes them as AI.
 */
export function deriveRuntimeSeats(
  savedSeats: SeatConfig[],
  hasKey: (provider: ProviderId) => boolean,
): DerivedRuntimeSeats {
  const seats: SeatConfig[] = [];
  const downgraded: number[] = [];
  for (const saved of savedSeats) {
    if (saved.kind !== 'ai') {
      seats.push({ ...saved });
      continue;
    }
    const known = !!saved.provider && saved.provider in PROVIDERS;
    if (!known || !hasKey(saved.provider!)) {
      downgraded.push(saved.seatIndex);
      seats.push({ seatIndex: saved.seatIndex, playerId: saved.playerId, kind: 'human' });
      continue;
    }
    seats.push({ ...saved });
  }
  return { seats, downgraded };
}
