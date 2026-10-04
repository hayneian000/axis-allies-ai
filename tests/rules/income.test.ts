// Phase 6: Collect Income — 1942 2e p.24 (project-adapted: FFA, turn cap).
import { describe, expect, it } from 'vitest';
import { combatMove, incomeOf, purchase } from '../../engine/engine';
import { ipcOf, neighborsOf } from '../../data/data';
import { freshGame, gotoCombat, gotoCombatMove, noopTurn, resolveBattleAuto } from '../helpers';

/** Transfer smallest-first territories from the richer to the poorer player until incomes match. */
function equalizeIncomes(s: ReturnType<typeof freshGame>): void {
  for (let i = 0; i < 60; i++) {
    const i0 = incomeOf(s, 0);
    const i1 = incomeOf(s, 1);
    if (i0 === i1) return;
    const rich = i0 > i1 ? 0 : 1;
    const poor = 1 - rich;
    const diff = Math.abs(i0 - i1) / 2;
    const cand = Object.keys(s.territories)
      .filter(
        (t) =>
          s.territories[t].owner === rich &&
          s.players[rich].capital !== t &&
          ipcOf(t) <= diff,
      )
      .sort((a, b) => ipcOf(b) - ipcOf(a))[0];
    if (!cand) return;
    s.territories[cand].owner = poor;
  }
}

describe('collect income', () => {
  it('income equals the sum of owned territory IPC values', () => {
    // 1942 2e p.24: collect IPCs for every territory you control.
    const s = freshGame(2, 201);
    const pid = s.currentPlayer;
    const expected = Object.entries(s.territories)
      .filter(([, t]) => t.owner === pid)
      .reduce((sum, [tid]) => sum + ipcOf(tid), 0);
    expect(incomeOf(s, pid)).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('adds income to the bank at turn end', () => {
    // 1942 2e p.24: income is collected in the final phase of the turn.
    const s = freshGame(2, 202);
    const pid = s.currentPlayer;
    const income = incomeOf(s, pid);
    const bank = s.players[pid].ipcs;
    noopTurn(s);
    expect(s.players[pid].ipcs).toBe(bank + income);
  });

  it('carries unspent IPCs across turns', () => {
    // 1942 2e p.9: IPCs not spent are saved for future turns.
    const s = freshGame(2, 203);
    const pid = s.currentPlayer;
    const income = incomeOf(s, pid);
    s.players[pid].ipcs = 7;
    noopTurn(s); // pid collects
    expect(s.players[pid].ipcs).toBe(7 + income);
    while (s.currentPlayer !== pid || s.phase !== 'purchase') noopTurn(s);
    noopTurn(s); // pid collects again
    expect(s.players[pid].ipcs).toBe(7 + 2 * income);
  });

  it('collects zero income without holding your capital', () => {
    // Project rule (engine/RULES.md): a player who has lost their capital
    // collects no income until it is liberated.
    const s = freshGame(2, 204);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const bank = s.players[pid].ipcs;
    s.territories[s.players[pid].capital].owner = foe;
    noopTurn(s);
    expect(s.players[pid].ipcs).toBe(bank);
  });

  it('capital capture transfers the entire enemy bank (full steal)', () => {
    // 1942 2e p.20: capturing an enemy capital seizes that power's IPCs.
    // FFA decision (Oct 3 2026): full steal, no partial.
    const s = freshGame(2, 205);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const foeCap = s.players[foe].capital;
    // Rig: foe holds only an empty capital; pid holds an adjacent territory.
    for (const t of Object.keys(s.territories)) {
      if (s.territories[t].owner === foe && t !== foeCap) s.territories[t].owner = pid;
    }
    const unitKeys = Object.keys(s.territories[foeCap].units) as Array<
      keyof (typeof s.territories)[string]['units']
    >;
    for (const k of unitKeys) s.territories[foeCap].units[k] = 0;
    const origin = neighborsOf(foeCap).find((t) => s.territories[t].owner === pid)!;
    expect(origin, 'need pid-owned neighbor of foe capital').toBeDefined();
    s.territories[origin].units.tank = 3;
    s.players[foe].ipcs = 25;
    const pidBank = s.players[pid].ipcs;
    expect(combatMove(s, pid, [{ from: origin, to: foeCap, units: { tank: 3 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, foeCap);
    expect(s.territories[foeCap].owner).toBe(pid);
    expect(s.players[pid].ipcs).toBe(pidBank + 25);
    expect(s.players[foe].ipcs).toBe(0);
  });
});

describe('turn cap and tiebreaks', () => {
  it('defaults to a 20-round turn cap', () => {
    // Project scope (engine/RULES.md): FFA games end after 20 rounds.
    const s = freshGame(2, 206);
    expect(s.turnCap).toBe(20);
    expect(s.round).toBe(1);
  });

  it('awards the win to highest income at the turn cap', () => {
    // Project scope: no capital winner by round 20 -> highest income wins.
    const s = freshGame(2, 207);
    s.turnCap = 1;
    const richer = incomeOf(s, 0) >= incomeOf(s, 1) ? 0 : 1;
    noopTurn(s); // player A
    noopTurn(s); // player B -> round 2 > cap 1 -> game over
    expect(s.phase).toBe('gameover');
    expect(s.winReason).toBe('turn_cap');
    expect(s.winner).toBe(richer);
  });

  it('breaks income ties by bank, then by lowest player id', () => {
    // Engine rule (endByTurnCap): income desc, bank desc, player id asc.
    const rig = (seed: number, bank0: number, bank1: number) => {
      const s = freshGame(2, seed);
      s.turnCap = 1;
      // Neutralize a 1-IPC territory so the owned total is even, then balance.
      const oneIpc = Object.keys(s.territories).find(
        (t) => ipcOf(t) === 1 && s.territories[t].owner !== null && s.players[s.territories[t].owner!].capital !== t,
      )!;
      s.territories[oneIpc].owner = null;
      equalizeIncomes(s);
      expect(incomeOf(s, 0)).toBe(incomeOf(s, 1));
      s.players[0].ipcs = bank0;
      s.players[1].ipcs = bank1;
      noopTurn(s);
      noopTurn(s);
      expect(s.phase).toBe('gameover');
      expect(s.winReason).toBe('turn_cap');
      return s;
    };
    // Equal income, unequal bank -> richer bank wins.
    expect(rig(208, 5, 40).winner).toBe(1);
    expect(rig(209, 40, 5).winner).toBe(0);
    // Equal income and bank -> lowest player id wins.
    expect(rig(210, 10, 10).winner).toBe(0);
  });

  it('purchased-but-unplaced units do not count as income or bank', () => {
    // 1942 2e p.9: IPCs are spent at purchase time; the bank only grows at
    // income collection.
    const s = freshGame(2, 211);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 50;
    expect(purchase(s, pid, [{ type: 'tank', count: 2 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(50 - 12);
  });
});
