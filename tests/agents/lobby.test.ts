// buildSeats / validateSeats: seat-config construction and validation for the lobby.
import { describe, expect, it } from 'vitest';
import { buildSeats, validateSeats } from '../../agents/lobby';

describe('buildSeats', () => {
  it('builds one SeatConfig per player, pairing seatIndex to playerId', () => {
    const seats = buildSeats(
      [
        { kind: 'human', name: 'Alex' },
        { kind: 'ai', provider: 'anthropic', model: 'claude-sonnet-5', name: 'Claude' },
      ],
      ['Alex', 'Claude'],
    );
    expect(seats).toHaveLength(2);
    expect(seats[0]).toEqual({ seatIndex: 0, playerId: 0, kind: 'human' });
    expect(seats[1]).toEqual({
      seatIndex: 1,
      playerId: 1,
      kind: 'ai',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      keySlot: 'anthropic',
    });
  });

  it('defaults the key slot to the provider id', () => {
    const [seat] = buildSeats([{ kind: 'ai', provider: 'meta', model: 'muse-spark-1.3' }], ['Meta']);
    expect(seat.keySlot).toBe('meta');
  });

  it('throws when seat count mismatches player names', () => {
    expect(() => buildSeats([{ kind: 'human' }], ['A', 'B'])).toThrow(/one seat per player/);
  });

  it('throws when an AI seat lacks provider or model', () => {
    expect(() => buildSeats([{ kind: 'ai', model: 'x' }], ['A'])).toThrow(/needs a provider/);
    expect(() => buildSeats([{ kind: 'ai', provider: 'openai' }], ['A'])).toThrow(/needs a model/);
  });

  it('supports 2-4 seats', () => {
    const inputs = Array.from({ length: 4 }, () => ({ kind: 'human' as const }));
    expect(buildSeats(inputs, ['a', 'b', 'c', 'd'])).toHaveLength(4);
  });
});

describe('validateSeats', () => {
  it('accepts all-human and mixed tables', () => {
    expect(validateSeats(buildSeats([{ kind: 'human' }, { kind: 'human' }], ['a', 'b']))).toEqual([]);
    expect(
      validateSeats(
        buildSeats(
          [
            { kind: 'human' },
            { kind: 'ai', provider: 'openai', model: 'gpt-5.6' },
          ],
          ['a', 'b'],
        ),
      ),
    ).toEqual([]);
  });

  it('rejects fewer than 2 seats', () => {
    expect(validateSeats([])).toContain('Need at least 2 seats for a game.');
  });

  it('flags AI seats missing provider or model', () => {
    const errors = validateSeats([
      { seatIndex: 0, playerId: 0, kind: 'human' },
      { seatIndex: 1, playerId: 1, kind: 'ai', model: '  ' },
    ]);
    expect(errors.some((e) => /missing a provider/.test(e))).toBe(true);
    expect(errors.some((e) => /missing a model/.test(e))).toBe(true);
  });
});
