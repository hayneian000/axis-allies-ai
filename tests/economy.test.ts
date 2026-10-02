import { describe, expect, it } from 'vitest';
import {
  combatMove,
  deserialize,
  endPhase,
  incomeOf,
  mobilize,
  ownsCapital,
  purchase,
  sendMessage,
  serialize,
  summarizeState,
  wordCount,
} from '../engine/engine';
import { ipcOf, neighborsOf } from '../data/data';
import { freshGame, gotoCombat, gotoCombatMove, gotoMobilize, noopTurn, resolveBattleAuto } from './helpers';

describe('mobilize and factories', () => {
  it('places purchased units up to each factory territory IPC value', () => {
    const s = freshGame(2, 61);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const capIpc = { california: 5, texas: 5, great_lakes: 5, 'new_york': 4 }[cap] ?? 3;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: capIpc + 2 }]).ok).toBe(true);
    gotoMobilize(s);
    // Over capacity in one territory fails cleanly.
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc + 2 } }]).code).toBe('capacity');
    expect(mobilize(s, pid, [{ territory: cap, units: { infantry: capIpc } }]).ok).toBe(true);
    expect(s.purchased.infantry).toBe(2);
  });

  it('rejects mobilizing at territories without usable factories', () => {
    const s = freshGame(2, 62);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoMobilize(s);
    const plain = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory,
    )!;
    expect(mobilize(s, pid, [{ territory: plain, units: { infantry: 1 } }]).code).toBe('no_factory');
  });

  it('fresh factories produce from next turn, not the turn they appear', () => {
    const s = freshGame(2, 77);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'factory', count: 1 }, { type: 'infantry', count: 2 }]);
    gotoMobilize(s);
    const spot = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory && ipcOf(t) >= 2,
    )!;
    // Units cannot deploy at the new site in the same mobilize step.
    expect(mobilize(s, pid, [{ territory: spot, units: { infantry: 2 }, buildFactory: true }]).code).toBe('no_factory');
    expect(mobilize(s, pid, [{ territory: spot, units: {}, buildFactory: true }]).ok).toBe(true);
    expect(s.territories[spot].factoryFresh).toBe(true);
    // Next turn the factory is online.
    endPhase(s, pid); // collect + advance
    while (s.currentPlayer !== pid || s.phase !== 'purchase') noopTurn(s);
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 2 }]);
    gotoMobilize(s);
    expect(s.territories[spot].factoryFresh).toBe(false);
    expect(mobilize(s, pid, [{ territory: spot, units: { infantry: 2 } }]).ok).toBe(true);
  });

  it('captured factories produce from next turn', () => {
    const s = freshGame(2, 78);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 2 }]);
    gotoCombatMove(s);
    // Rig a non-capital factory on foe ground, adjacent to pid ground.
    let origin = '';
    let target = '';
    for (const t of Object.keys(s.territories)) {
      if (s.territories[t].owner !== pid) continue;
      const foeNeighbor = neighborsOf(t).find(
        (n) => s.territories[n].owner === foe && s.players[foe].capital !== n,
      );
      if (foeNeighbor) {
        origin = t;
        target = foeNeighbor;
        break;
      }
    }
    expect(target, 'need adjacent foe territory').not.toBe('');
    expect(s.players[foe].capital).not.toBe(target);
    s.territories[target].factory = true;
    s.territories[target].factoryFresh = false;
    for (const k of Object.keys(s.territories[target].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories[target].units[k] = 0;
    }
    s.territories[origin].units.tank = 3;
    expect(combatMove(s, pid, [{ from: origin, to: target, units: { tank: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, target);
    expect(s.territories[target].owner).toBe(pid);
    expect(s.territories[target].factoryFresh).toBe(true);
    gotoMobilize(s);
    // Same-turn deployment at the captured factory is rejected.
    expect(mobilize(s, pid, [{ territory: target, units: { infantry: 2 } }]).code).toBe('no_factory');
  });

  it('builds new factories only on owned IPC>=2 territory without one', () => {
    const s = freshGame(2, 63);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'factory', count: 1 }]);
    gotoMobilize(s);
    const cap = s.players[pid].capital;
    expect(mobilize(s, pid, [{ territory: cap, units: {}, buildFactory: true }]).code).toBe('has_factory');
    // An IPC-1 territory is always rejected.
    const cheap = Object.keys(s.territories).find((t) => ipcOf(t) < 2)!;
    s.territories[cheap].owner = pid;
    s.territories[cheap].factory = false;
    expect(mobilize(s, pid, [{ territory: cheap, units: {}, buildFactory: true }]).code).toBe('low_ipc');
    // A good spot works and starts fresh (unusable until next turn).
    const spot = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory && ipcOf(t) >= 2,
    )!;
    expect(mobilize(s, pid, [{ territory: spot, units: {}, buildFactory: true }]).ok).toBe(true);
    expect(s.territories[spot].factory).toBe(true);
    expect(s.territories[spot].factoryFresh).toBe(true);
  });
});

describe('income, capitals, elimination', () => {
  it('collects income on turn end and zero without a capital', () => {
    const s = freshGame(2, 65);
    const pid = s.currentPlayer;
    const income = incomeOf(s, pid);
    expect(income).toBeGreaterThan(0);
    const bank = s.players[pid].ipcs;
    noopTurn(s);
    expect(s.players[pid].ipcs).toBe(bank + income);
    // Strip the capital: collection drops to zero.
    const s2 = freshGame(2, 66);
    const p2 = s2.currentPlayer;
    const bankBefore = s2.players[p2].ipcs;
    s2.territories[s2.players[p2].capital].owner = (p2 + 1) % 2;
    expect(ownsCapital(s2, p2)).toBe(false);
    noopTurn(s2);
    expect(s2.players[p2].ipcs).toBe(bankBefore);
  });

  it('transfers the bank on capital capture and eliminates wiped players', () => {
    const s = freshGame(2, 67);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const foeCap = s.players[foe].capital;
    // Rig: foe holds only an empty capital; pid holds an adjacent territory with tanks.
    for (const t of Object.keys(s.territories)) {
      if (s.territories[t].owner === foe && t !== foeCap) s.territories[t].owner = pid;
    }
    for (const k of Object.keys(s.territories[foeCap].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories[foeCap].units[k] = 0;
    }
    const origin = neighborsOf(foeCap).find((t) => s.territories[t].owner === pid)!;
    expect(origin, 'need pid-owned neighbor of foe capital').toBeDefined();
    s.territories[origin].units.tank = 3;
    const foeBank = s.players[foe].ipcs;
    const pidBank = s.players[pid].ipcs;
    expect(foeBank).toBeGreaterThan(0);
    expect(combatMove(s, pid, [{ from: origin, to: foeCap, units: { tank: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, foeCap);
    const b = s.battles.find((x) => x.territoryId === foeCap)!;
    expect(b.result).toBe('captured');
    expect(s.territories[foeCap].owner).toBe(pid);
    expect(s.players[pid].ipcs).toBe(pidBank + foeBank);
    expect(s.players[foe].ipcs).toBe(0);
    expect(s.players[foe].alive).toBe(false);
    // pid now holds every capital in play -> immediate win.
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(pid);
  });

  it('caps the game at the turn limit with income then bank tiebreak', () => {
    const s = freshGame(2, 69);
    s.turnCap = 1;
    noopTurn(s); // player A: round stays 1
    expect(s.phase).toBe('purchase');
    noopTurn(s); // player B: wraps to round 2 > cap 1 -> game over
    expect(s.phase).toBe('gameover');
    expect(s.winner).not.toBeNull();
    expect(s.winReason).toBe('turn_cap');
  });
});

describe('persistence, chat, summary', () => {
  it('round-trips a mid-combat game through JSON', () => {
    const s = freshGame(3, 71);
    const pid = s.currentPlayer;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoCombatMove(s);
    combatMove(s, pid, []);
    gotoCombat(s);
    sendMessage(s, pid, 'all', 'hello');
    const json = serialize(s);
    const restored = deserialize(json);
    expect(restored).toEqual(s);
    expect(serialize(restored)).toBe(json);
  });

  it('rejects corrupt saves and bad chat', () => {
    expect(() => deserialize('{"version": 1}')).toThrow();
    expect(() => deserialize('nope')).toThrow();
    const s = freshGame(2, 72);
    expect(sendMessage(s, 0, 'all', '   ').code).toBe('bad_message');
    expect(sendMessage(s, 9, 'all', 'hi').code).toBe('unknown_player');
    expect(sendMessage(s, 0, 'all', 'ok').ok).toBe(true);
    expect(s.chatLog).toHaveLength(1);
  });

  it('summarizes under 800 words with owners, IPCs, units, banks, capitals', () => {
    const s = freshGame(4, 73);
    const text = summarizeState(s, s.currentPlayer);
    expect(wordCount(text)).toBeLessThan(800);
    expect(text).toContain('Bank');
    expect(text).toContain('capital');
    expect(text).toContain('california');
  });
});
