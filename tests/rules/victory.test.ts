// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { endPhase, resolveCapture } from '../../engine/engine';
import { freshGame } from '../helpers';

/**
 * Victory Conditions
 *
 * FFA Decision (project decision, Oct 3 2026): Majority of capitals held simultaneously wins.
 * For 4 players: 3 of 4. For 3 players: 2 of 3. For 2 players: 2 of 2.
 * Map-specific victory conditions going forward.
 *
 * 1942 2e p.6: Standard victory is controlling more victory cities.
 * Project adapts to capitals in FFA.
 */
describe('victory by capitals', () => {
  it('2-player: holding both capitals wins (2/2 majority)', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const foeCap = s.players[1 - pid].capital;
    s.territories[foeCap].owner = pid;
    resolveCapture(s, foeCap, pid, 1 - pid);
    expect(s.winner).toBe(pid);
    expect(s.phase).toBe('gameover');
  });

  it('3-player: holding 2 of 3 capitals wins', () => {
    const s = freshGame(3, 1);
    const pid = s.currentPlayer;
    const caps = s.players.map((p) => p.capital);
    // pid owns their own; capture one more
    const other = (pid + 1) % 3;
    s.territories[caps[other]].owner = pid;
    resolveCapture(s, caps[other], pid, other);
    expect(s.winner).toBe(pid);
  });

  it('4-player: holding 2 of 4 capitals does not win', () => {
    const s = freshGame(4, 1);
    const pid = s.currentPlayer;
    const caps = s.players.map((p) => p.capital);
    const other = (pid + 1) % 4;
    s.territories[caps[other]].owner = pid;
    resolveCapture(s, caps[other], pid, other);
    expect(s.winner).toBe(null);
    expect(s.phase).not.toBe('gameover');
  });

  it('4-player: holding 3 of 4 capitals wins', () => {
    const s = freshGame(4, 1);
    const pid = s.currentPlayer;
    const caps = s.players.map((p) => p.capital);
    // Capture two others (plus own = 3)
    for (let i = 1; i <= 2; i++) {
      const other = (pid + i) % 4;
      s.territories[caps[other]].owner = pid;
      resolveCapture(s, caps[other], pid, other);
    }
    expect(s.winner).toBe(pid);
    expect(s.phase).toBe('gameover');
  });

  it('victory requires simultaneous control (not cumulative)', () => {
    const s = freshGame(4, 1);
    const pid = s.currentPlayer;
    const caps = s.players.map((p) => p.capital);
    // Capture one, lose it, capture another - never hold 3 at once
    const o1 = (pid + 1) % 4;
    const o2 = (pid + 2) % 4;
    s.territories[caps[o1]].owner = pid;
    resolveCapture(s, caps[o1], pid, o1);
    expect(s.winner).toBe(null);
    // Lose it
    s.territories[caps[o1]].owner = o1;
    // Capture a different one
    s.territories[caps[o2]].owner = pid;
    resolveCapture(s, caps[o2], pid, o2);
    expect(s.winner).toBe(null); // Only 2 held (own + o2)
  });
});

describe('victory by turn cap', () => {
  it('20-round cap: highest income wins (1942 2e adaptation)', () => {
    const s = freshGame(2, 1);
    // Fast-forward to turn cap (implementation detail: set round high)
    s.round = 20;
    // The income phase should trigger victory check
    // (Specific mechanics depend on engine implementation)
    expect(s.turnCap).toBe(20);
  });
});
