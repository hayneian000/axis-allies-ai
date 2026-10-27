// Cumulative mobilize capacity: a factory's per-turn production limit
// (1942 2e p.21/p.23) applies to the whole mobilize phase, not to each
// mobilize() call - split calls cannot exceed it. Placements are tracked
// in GameState.mobilizedThisPhase, keyed by the producing factory.
import { describe, expect, it } from 'vitest';
import { deserialize, endPhase, mobilize, purchase, serialize } from '../engine/engine';
import { ipcOf, isSea, neighborsOf } from '../data/data';
import { freshGame, gotoMobilize, noopTurn } from './helpers';

describe('cumulative mobilize capacity', () => {
  it('enforces capacity across split calls at an undamaged factory', () => {
    // 1942 2e p.23: an industrial complex mobilizes at most its territory's
    // IPC value in units per turn - however the placements are split.
    const s = freshGame(2, 201);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    const before = s.territories[cap].units.infantry;
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    // Call 1: part of capacity.
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc - 1 } }]).ok).toBe(true);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: capIpc - 1 });
    // Call 2: exactly the remainder - the phase total hits capacity exactly.
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: capIpc });
    // Call 3: one more unit for that factory exceeds the per-turn limit.
    const over = mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('capacity');
    // Total actually placed equals capacity exactly; the extra purchased
    // unit is still in the pool (it forfeits when the phase ends).
    expect(s.territories[cap].units.infantry).toBe(before + capIpc);
    expect(s.purchased.infantry).toBe(1);
  });

  it('enforces the damage-reduced capacity cumulatively (factory_damaged)', () => {
    // 1942 2e p.21: each damage marker cuts capacity by one; the reduced
    // cap is also cumulative across split calls.
    const s = freshGame(2, 202);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const reduced = ipcOf(cap) - 2;
    s.territories[cap].factoryDamage = 2;
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: reduced + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: reduced - 1 } }]).ok).toBe(true);
    const over = mobilize(s, pid, [{ territory: cap, units: { infantry: 2 } }]);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('factory_damaged');
    // Exactly the remaining slot still fits.
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: reduced });
  });

  it('counts sea-zone placements cumulatively against the producing factory', () => {
    // 1942 2e p.21: sea units mobilized into an adjacent sea zone count
    // against their producing complex's capacity like any other unit.
    const s = freshGame(2, 203);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    const sea = neighborsOf(cap).find((t) => isSea(t))!;
    expect(sea).toBeDefined();
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'transport', count: capIpc + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(
      mobilize(s, pid, [{ territory: cap, seaZone: sea, units: { transport: capIpc - 1 } }]).ok,
    ).toBe(true);
    expect(mobilize(s, pid, [{ territory: cap, seaZone: sea, units: { transport: 1 } }]).ok).toBe(
      true,
    );
    const over = mobilize(s, pid, [{ territory: cap, seaZone: sea, units: { transport: 1 } }]);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('capacity');
    expect(s.territories[sea].units.transport).toBe(capIpc);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: capIpc });
  });

  it('resets the tracker when the next mobilize phase is entered', () => {
    const s = freshGame(2, 204);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc } }]).ok).toBe(true);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: capIpc });
    // End the turn; the other player takes a quiet turn.
    expect(endPhase(s, pid).ok).toBe(true);
    noopTurn(s);
    expect(s.currentPlayer).toBe(pid);
    expect(s.phase).toBe('purchase');
    // Same player, next turn: buy again and enter mobilize - the tracker
    // started clean, so the factory can again produce its full capacity.
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc }]).ok).toBe(true);
    gotoMobilize(s);
    expect(s.mobilizedThisPhase).toEqual({});
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc } }]).ok).toBe(true);
  });

  it('preserves the tracker across a save/load round trip mid-phase', () => {
    const s = freshGame(2, 205);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc - 1 } }]).ok).toBe(true);

    const loaded = deserialize(serialize(s));
    expect(loaded.phase).toBe('mobilize');
    expect(loaded.mobilizedThisPhase).toEqual({ [cap]: capIpc - 1 });
    // Beyond the remaining capacity: rejected on the loaded state too.
    const over = mobilize(loaded, pid, [{ territory: cap, units: { infantry: 2 } }]);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('capacity');
    // Exactly the remainder: fine.
    expect(mobilize(loaded, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
    expect(loaded.mobilizedThisPhase).toEqual({ [cap]: capIpc });
  });

  it('loads a legacy save without the field (backfilled) and plays', () => {
    const s = freshGame(2, 206);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc }]).ok).toBe(true);
    gotoMobilize(s);
    // Strip the field to simulate a save from before cumulative tracking.
    const raw = JSON.parse(serialize(s)) as Record<string, unknown>;
    delete raw.mobilizedThisPhase;
    const loaded = deserialize(JSON.stringify(raw));
    expect(loaded.mobilizedThisPhase).toEqual({});
    expect(mobilize(loaded, pid, [{ territory: cap, units: { infantry: capIpc } }]).ok).toBe(true);
    expect(loaded.mobilizedThisPhase).toEqual({ [cap]: capIpc });
  });

  it('a rejected over-capacity call leaves the tracker unchanged', () => {
    const s = freshGame(2, 207);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = ipcOf(cap);
    s.players[pid].ipcs = 500;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 1 }]).ok).toBe(true);
    gotoMobilize(s);
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc - 1 } }]).ok).toBe(true);
    const before = { ...s.mobilizedThisPhase };
    const over = mobilize(s, pid, [{ territory: cap, units: { infantry: 2 } }]);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('capacity');
    // Tracker and purchase pool are exactly as before the rejected call.
    expect(s.mobilizedThisPhase).toEqual(before);
    expect(s.purchased.infantry).toBe(2);
    // ...so the legal remainder call still succeeds afterwards.
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: 1 } }]).ok).toBe(true);
    expect(s.mobilizedThisPhase).toEqual({ [cap]: capIpc });
  });
});
