// Phase 5: Mobilize New Units — 1942 2e pp. 23–24 (project-adapted: land/air only, FFA).
import { describe, expect, it } from 'vitest';
import { endPhase, mobilize, purchase } from '../../engine/engine';
import { ipcOf } from '../../data/data';
import { freshGame, gotoMobilize } from '../helpers';

describe('mobilize new units', () => {
  it('places purchased units at an owned factory', () => {
    // 1942 2e p.23: new units are mobilized at industrial complexes you own.
    const s = freshGame(2, 101);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const before = s.territories[cap].units.infantry;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: 2 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 2 } }]).ok).toBe(true);
    expect(s.territories[cap].units.infantry).toBe(before + 2);
    expect(s.purchased.infantry ?? 0).toBe(0);
  });

  it('is rejected outside the mobilize phase', () => {
    // 1942 2e p.8: turn sequence — mobilization happens only in its phase.
    const s = freshGame(2, 102);
    const pid = s.currentPlayer;
    expect(s.phase).toBe('purchase');
    expect(mobilize(s, pid, []).code).toBe('wrong_phase');
  });

  it('limits placement to the territory IPC value (capacity)', () => {
    // 1942 2e p.23: an industrial complex can mobilize a number of units per
    // turn up to the IPC value of its territory.
    const s = freshGame(2, 103);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc }]).ok).toBe(true);
    gotoMobilize(s);
    // Exactly at capacity: allowed (boundary).
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc } }]).ok).toBe(true);
  });

  it('rejects placement above capacity', () => {
    // 1942 2e p.23: cannot exceed the territory IPC value in one turn.
    const s = freshGame(2, 104);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc + 1 } }]).code).toBe('capacity');
    // Failed placement leaves the purchase pool untouched.
    expect(s.purchased.infantry).toBe(capIpc + 1);
  });

  it('rejects placement at a territory with no factory', () => {
    // 1942 2e p.23: units mobilize only at industrial complexes.
    const s = freshGame(2, 105);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoMobilize(s);
    const plain = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory,
    )!;
    expect(mobilize(s, pid, [{ territory: plain, units: { infantry: 1 } }]).code).toBe('no_factory');
  });

  it('rejects placement at a territory owned by someone else', () => {
    // 1942 2e p.23: you mobilize at YOUR industrial complexes.
    const s = freshGame(2, 106);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoMobilize(s);
    const foeTerr = Object.keys(s.territories).find((t) => s.territories[t].owner !== pid)!;
    expect(mobilize(s, pid, [{ territory: foeTerr, units: { infantry: 1 } }]).code).toBe('not_owner');
  });

  it('rejects placing more units than were purchased', () => {
    // 1942 2e p.9: you can only mobilize units you paid for in the purchase phase.
    const s = freshGame(2, 107);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 2 }]);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 3 } }]).code).toBe('not_purchased');
  });

  it('cannot deploy at a factory built this turn (fresh factories wait)', () => {
    // 1942 2e p.24: a newly built industrial complex cannot mobilize units
    // until the next turn.
    const s = freshGame(2, 108);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 2 }]);
    gotoMobilize(s);
    const cap = s.players[pid].capital;
    // Simulate a factory built this turn: fresh, excluded from usable capacity.
    s.territories[cap].factoryFresh = true;
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 2 } }]).code).toBe('no_factory');
  });

  it('cannot deploy at a factory captured this turn', () => {
    // 1942 2e p.23–24: a captured industrial complex produces from next turn.
    const s = freshGame(2, 109);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 2 }]);
    gotoMobilize(s);
    // Simulate a factory captured this turn: owned now, but not a turn-start factory.
    const other = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && t !== s.players[pid].capital,
    )!;
    s.territories[other].factory = true;
    s.territories[other].factoryFresh = true;
    expect(s.turnStartFactories).not.toContain(other);
    expect(mobilize(s, pid, [{ territory: other, units: { infantry: 2 } }]).code).toBe('no_factory');
  });

  it('splits placement across multiple owned factories', () => {
    // 1942 2e p.23: each complex mobilizes up to its own territory's IPC value.
    const s = freshGame(2, 110);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    const other = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && t !== cap && ipcOf(t) >= 2,
    )!;
    // Second factory online since an earlier turn.
    s.territories[other].factory = true;
    s.territories[other].factoryFresh = false;
    const otherBefore = s.territories[other].units.infantry;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 2 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(
      mobilize(s, pid, [
        { territory: cap, units: { infantry: capIpc } },
        { territory: other, units: { infantry: 2 } },
      ]).ok,
    ).toBe(true);
    expect(s.territories[other].units.infantry).toBe(otherBefore + 2);
    expect(s.purchased.infantry ?? 0).toBe(0);
  });

  it('forfeits units that cannot be placed when the phase ends', () => {
    // 1942 2e p.24 (project rule): purchased units that cannot be mobilized
    // are lost when mobilization ends.
    const s = freshGame(2, 111);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const before = s.territories[cap].units.infantry;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 3 }]);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
    expect(endPhase(s, pid).ok).toBe(true); // mobilize -> income + next player
    expect(s.purchased.infantry ?? 0).toBe(0);
    expect(s.territories[cap].units.infantry).toBe(before + 1);
  });
});
