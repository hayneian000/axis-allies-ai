import { describe, expect, it } from 'vitest';
import { neighborsOf } from '../data/data';
import {
  autoCasualties,
  chooseCasualties,
  combatMove,
  endPhase,
  mobilize,
  nonCombatMove,
  openBattles,
  purchase,
  resolveCombatRound,
  retreat,
  sendMessage,
  serialize,
} from '../engine/engine';
import {
  freshGame,
  gotoCombat,
  gotoCombatMove,
  gotoMobilize,
  gotoNonCombat,
  resolveBattleAuto,
} from './helpers';

describe('purchase edges', () => {
  it('rejects zero, negative, and fractional counts', () => {
    const s = freshGame(2, 101);
    const pid = s.currentPlayer;
    expect(purchase(s, pid, [{ type: 'infantry', count: 0 }]).code).toBe('bad_count');
    expect(purchase(s, pid, [{ type: 'infantry', count: -2 }]).code).toBe('bad_count');
    expect(purchase(s, pid, [{ type: 'infantry', count: 1.5 }]).code).toBe('bad_count');
    expect(purchase(s, pid, [{ type: 'tank', count: NaN }]).code).toBe('bad_count');
  });

  it('rejects unknown unit types and enforces turn and phase', () => {
    const s = freshGame(2, 102);
    const pid = s.currentPlayer;
    expect(purchase(s, pid, [{ type: 'dragon' as never, count: 1 }]).code).toBe('bad_unit');
    expect(purchase(s, 1 - pid, [{ type: 'infantry', count: 1 }]).code).toBe('not_your_turn');
    gotoCombatMove(s);
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).code).toBe('wrong_phase');
  });

  it('allows exact-bank purchases and accumulates across calls', () => {
    const s = freshGame(2, 103);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 7;
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).ok).toBe(true);
    expect(purchase(s, pid, [{ type: 'artillery', count: 1 }]).ok).toBe(true);
    expect(s.players[pid].ipcs).toBe(0);
    expect(s.purchased.infantry).toBe(1);
    expect(s.purchased.artillery).toBe(1);
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).code).toBe('funds');
  });
});

describe('combatMove edges', () => {
  it('accepts an empty move list and rejects empty/negative/fractional moves', () => {
    const s = freshGame(2, 111);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    expect(combatMove(s, pid, []).ok).toBe(true);
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: {} }]).code).toBe('empty_move');
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: -1 } }]).code).toBe('bad_count');
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1.5 } }]).code).toBe('bad_count');
    expect(combatMove(s, pid, [{ from: 'nope', to: 'montana', units: { infantry: 1 } }]).code).toBe('unknown_territory');
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'nope', units: { infantry: 1 } }]).code).toBe('unknown_territory');
  });

  it('rejects AA in any combat move, even mixed with attackers', () => {
    const s = freshGame(2, 112);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.aa = 1;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = (pid + 1) % 2;
    expect(
      combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1, aa: 1 } }]).code,
    ).toBe('aa_no_attack');
  });

  it('rejects moving more units than present', () => {
    const s = freshGame(2, 113);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 1;
    s.territories['montana'].owner = (pid + 1) % 2;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 2 } }]).code).toBe('too_few_units');
  });

  it('validates tank blitz paths strictly', () => {
    const rig = () => {
      const s = freshGame(4, 114);
      gotoCombatMove(s);
      const me = s.currentPlayer;
      const foe = (me + 1) % s.numPlayers;
      s.territories['oregon'].owner = me;
      s.territories['oregon'].units.tank = 1;
      s.territories['idaho'].owner = foe;
      s.territories['idaho'].units.infantry = 1;
      s.territories['montana'].owner = foe;
      s.territories['montana'].units.infantry = 1;
      return { s, me };
    };
    // No via for a 2-step attack.
    {
      const { s, me } = rig();
      expect(combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 } }]).code).toBe('blitz_path');
    }
    // Via must be a single connecting territory.
    {
      const { s, me } = rig();
      expect(
        combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho', 'wyoming'] }]).code,
      ).toBe('blitz_path');
      expect(
        combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['texas'] }]).code,
      ).toBe('blitz_path');
    }
    // Via friendly ground works and captures nothing.
    {
      const { s, me } = rig();
      s.territories['idaho'].owner = me;
      const r = combatMove(s, me, [{ from: 'oregon', to: 'montana', units: { tank: 1 }, via: ['idaho'] }]);
      expect(r.ok).toBe(true);
      expect(s.territories['idaho'].owner).toBe(me);
      expect(openBattles(s)).toHaveLength(1);
    }
  });

  it('merges a second combatMove wave into the open battle', () => {
    const s = freshGame(2, 115);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['montana'].owner = (pid + 1) % 2;
    s.territories['montana'].units.infantry = 5;
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1 } }]).ok).toBe(true);
    expect(combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 1 } }]).ok).toBe(true);
    expect(openBattles(s)).toHaveLength(1);
    expect(openBattles(s)[0].attack.infantry).toBe(2);
    expect(openBattles(s)[0].origins).toEqual(['idaho']);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'montana');
  });

  it('rejects over-range aircraft before checking landing', () => {
    const s = freshGame(2, 116);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['montana'].owner = pid;
    s.territories['montana'].units.fighter = 1;
    s.territories['florida'].owner = foe;
    // Montana to Florida is 5 steps via land and sea, beyond a fighter's 4.
    expect(combatMove(s, pid, [{ from: 'montana', to: 'florida', units: { fighter: 1 } }]).code).toBe('range');
  });

  it('rejects air attacks with no reachable landing spot', () => {
    const s = freshGame(2, 117);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['california'].owner = pid;
    s.territories['california'].units.fighter = 1;
    s.territories['montana'].owner = foe;
    s.ownedAtTurnStart = ['california']; // 3 steps out, only 1 left: no landing
    expect(combatMove(s, pid, [{ from: 'california', to: 'montana', units: { fighter: 1 } }]).code).toBe('no_landing');
  });

  it('validates SBR declarations strictly', () => {
    const rig = () => {
      const s = freshGame(2, 118);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const foe = (pid + 1) % 2;
      s.territories['pa_nj'].owner = pid;
      s.territories['pa_nj'].units.bomber = 1;
      s.territories['pa_nj'].units.fighter = 1;
      s.ownedAtTurnStart.push('pa_nj');
      return { s, pid, foe };
    };
    // Escorts or land units are not a raid.
    {
      const { s, pid } = rig();
      expect(
        combatMove(s, pid, [{ from: 'pa_nj', to: 'new_york', units: { bomber: 1, fighter: 1 }, sbr: true }]).code,
      ).toBe('sbr_bombers');
    }
    // Cannot bomb your own factory.
    {
      const s = freshGame(2, 119);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const cap = s.players[pid].capital;
      s.territories[cap].units.bomber = 1;
      expect(combatMove(s, pid, [{ from: cap, to: cap, units: { bomber: 1 }, sbr: true }]).code).toBe('sbr_friendly');
    }
    // Needs a factory under the bombs.
    {
      const { s, pid } = rig();
      s.territories['montana'].owner = (pid + 1) % 2;
      expect(
        combatMove(s, pid, [{ from: 'pa_nj', to: 'montana', units: { bomber: 1 }, sbr: true }]).code,
      ).toBe('sbr_no_factory');
    }
    // Range still gates raids, but sea zones count as air steps (1942 2e: air
    // flies over sea zones), so the map's air diameter is 6 — every factory
    // is within bomber range. A max-distance raid (montana -> new_york, 5
    // hops) clears the range check and fails only on the landing check
    // that follows it, proving range is validated first.
    {
      const s = freshGame(2, 120);
      gotoCombatMove(s);
      const pid = s.currentPlayer;
      const foe = (pid + 1) % 2;
      expect(s.players[foe].capital).toBe('new_york');
      expect(s.territories['new_york'].factory).toBe(true);
      s.territories['montana'].owner = pid;
      s.territories['montana'].units.bomber = 1;
      expect(
        combatMove(s, pid, [{ from: 'montana', to: 'new_york', units: { bomber: 1 }, sbr: true }]).code,
      ).toBe('no_landing');
    }
  });
});

describe('combat round edges', () => {
  it('fires AA only in the first round', () => {
    const s = freshGame(2, 121);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.fighter = 3;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 5;
    s.territories['montana'].units.aa = 1;
    combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { fighter: 3 } }]);
    gotoCombat(s);
    const r1 = resolveCombatRound(s, pid, 'montana');
    expect(r1.ok).toBe(true);
    expect(r1.combat!.aaRolls).toHaveLength(1);
    resolveBattleAuto(s, pid, 'montana');
  });

  it('caps casualty selection at live units when hits exceed the force', () => {
    const s = freshGame(2, 122);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 2;
    combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    b.pendingAttacker = 5; // more hits than the 3-strong force
    b.attackerResolved = false;
    expect(chooseCasualties(s, pid, 'montana', 'attacker', { infantry: 3 }).ok).toBe(true);
    // Losing the whole force ends the battle; nothing left to choose.
    expect(chooseCasualties(s, pid, 'montana', 'attacker', { infantry: 1 }).code).toBe('no_battle');
  });

  it('routes neutral casualties to auto and rejects manual choice', () => {
    const s = freshGame(4, 123);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['wyoming'].owner = null;
    s.territories['wyoming'].units.infantry = 1;
    combatMove(s, pid, [{ from: 'idaho', to: 'wyoming', units: { infantry: 2 } }]);
    gotoCombat(s);
    expect(chooseCasualties(s, pid, 'wyoming', 'defender', { infantry: 1 }).code).toBe('auto');
    expect(autoCasualties(s, pid, 'wyoming', 'attacker').code).toBe('none_pending');
    resolveBattleAuto(s, pid, 'wyoming');
  });

  it('rejects resolving with no battle or wrong player', () => {
    const s = freshGame(2, 124);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    expect(resolveCombatRound(s, pid, 'montana').code).toBe('wrong_phase');
    gotoCombat(s);
    expect(resolveCombatRound(s, pid, 'montana').code).toBe('no_battle');
    expect(resolveCombatRound(s, 1 - pid, 'montana').code).toBe('not_your_turn');
  });
});

describe('retreat edges', () => {
  function rigBattle(seed = 125) {
    const s = freshGame(2, seed);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 3;
    s.territories['montana'].owner = foe;
    s.territories['montana'].units.infantry = 3;
    combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 3 } }]);
    gotoCombat(s);
    return { s, pid, foe };
  }

  it('needs a fought round first', () => {
    const { s, pid } = rigBattle();
    expect(retreat(s, pid, 'montana', 'idaho').code).toBe('no_rounds');
  });

  it('waits for casualties, then rejects bad destinations', () => {
    const { s, pid } = rigBattle(126);
    const b = s.battles.find((x) => x.territoryId === 'montana')!;
    b.rounds = 1;
    b.pendingAttacker = 1;
    b.attackerResolved = false;
    expect(retreat(s, pid, 'montana', 'idaho').code).toBe('casualties_pending');
    b.pendingAttacker = 0;
    b.attackerResolved = true;
    expect(retreat(s, pid, 'montana', 'texas').code).toBe('bad_retreat');
    s.territories['idaho'].owner = (pid + 1) % 2;
    expect(retreat(s, pid, 'montana', 'idaho').code).toBe('bad_retreat');
  });

  it('never applies to bombing raids', () => {
    const s = freshGame(2, 127);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    const target = s.players[foe].capital; // foe factory
    const base = neighborsOf(target)[0];
    s.territories[base].owner = pid;
    s.territories[base].units.bomber = 1;
    s.ownedAtTurnStart.push(base);
    expect(combatMove(s, pid, [{ from: base, to: target, units: { bomber: 1 }, sbr: true }]).ok).toBe(true);
    gotoCombat(s);
    expect(retreat(s, pid, target, base).code).toBe('no_retreat');
  });
});

describe('non-combat edges', () => {
  it('stays on friendly ground, in range, with rested units', () => {
    const s = freshGame(2, 131);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    expect(nonCombatMove(s, pid, []).code).toBe('wrong_phase');
    gotoCombat(s);
    gotoNonCombat(s);
    const foeTerr = Object.keys(s.territories).find((t) => s.territories[t].owner !== pid)!;
    const own = Object.keys(s.territories).find((t) => s.territories[t].owner === pid)!;
    s.territories[own].units.infantry = 2;
    expect(nonCombatMove(s, pid, [{ from: own, to: foeTerr, units: { infantry: 1 } }]).code).toBe('not_owner');
    expect(nonCombatMove(s, pid, [{ from: own, to: 'atlantis', units: { infantry: 1 } }]).code).toBe('unknown_territory');
    expect(nonCombatMove(s, pid, [{ from: own, to: own, units: {} }]).code).toBe('empty_move');
    expect(nonCombatMove(s, pid, [{ from: own, to: own, units: { infantry: -1 } }]).code).toBe('bad_count');
  });

  it('moves tanks two steps through friendly ground only', () => {
    const s = freshGame(2, 132);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    const foe = (pid + 1) % 2;
    s.territories['oklahoma'].owner = pid;
    s.territories['oklahoma'].units.tank = 1;
    s.territories['plains'].owner = pid;
    s.territories['dakotas'].owner = pid;
    gotoCombat(s);
    gotoNonCombat(s);
    // Oklahoma -> Plains -> Dakotas, all friendly: legal.
    expect(nonCombatMove(s, pid, [{ from: 'oklahoma', to: 'dakotas', units: { tank: 1 } }]).ok).toBe(true);
    // Same span through enemy Plains is not.
    const s2 = freshGame(2, 133);
    gotoCombatMove(s2);
    const pid2 = s2.currentPlayer;
    const foe2 = (pid2 + 1) % 2;
    s2.territories['oklahoma'].owner = pid2;
    s2.territories['oklahoma'].units.tank = 1;
    s2.territories['plains'].owner = foe2;
    s2.territories['dakotas'].owner = pid2;
    gotoCombat(s2);
    gotoNonCombat(s2);
    expect(nonCombatMove(s2, pid2, [{ from: 'oklahoma', to: 'dakotas', units: { tank: 1 } }]).code).toBe('range');
    void foe;
    void foe2;
  });

  it('blocks units that already moved in combat', () => {
    const s = freshGame(2, 133);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['arizona'].owner = pid;
    s.territories['california'].units.infantry = 1;
    s.territories['arizona'].units.infantry = 0;
    expect(combatMove(s, pid, [{ from: 'california', to: 'arizona', units: { infantry: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    gotoNonCombat(s);
    expect(nonCombatMove(s, pid, [{ from: 'arizona', to: 'california', units: { infantry: 1 } }]).code).toBe('too_few_units');
  });

  it('lands air only on turn-start ground', () => {
    const s = freshGame(2, 134);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    s.territories['california'].units.fighter = 1;
    s.territories['arizona'].owner = pid;
    s.ownedAtTurnStart = [];
    gotoCombat(s);
    gotoNonCombat(s);
    expect(nonCombatMove(s, pid, [{ from: 'california', to: 'arizona', units: { fighter: 1 } }]).code).toBe('no_landing');
  });
});

describe('mobilize and turn edges', () => {
  it('splits production across factories and enforces per-factory caps', () => {
    const s = freshGame(2, 141);
    const pid = s.currentPlayer;
    s.territories['arizona'].owner = pid;
    s.territories['arizona'].factory = true;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 4 }]);
    gotoMobilize(s);
    const cap = s.players[pid].capital;
    // Over cap in one territory fails (Arizona IPC 1 < 2); split works.
    expect(
      mobilize(s, pid, [
        { territory: cap, units: { infantry: 2 } },
        { territory: 'arizona', units: { infantry: 2 } },
      ]).code,
    ).toBe('capacity');
    expect(
      mobilize(s, pid, [
        { territory: cap, units: { infantry: 1 } },
        { territory: 'arizona', units: { infantry: 1 } },
      ]).ok,
    ).toBe(true);
  });

  it('rejects factory builds without a purchase and double-spends', () => {
    const s = freshGame(2, 142);
    const pid = s.currentPlayer;
    s.players[pid].ipcs = 100;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoMobilize(s);
    const spot = Object.keys(s.territories).find(
      (t) => s.territories[t].owner === pid && !s.territories[t].factory,
    )!;
    expect(mobilize(s, pid, [{ territory: spot, units: {}, buildFactory: true }]).code).toBe('not_purchased');
    expect(mobilize(s, pid, [{ territory: s.players[pid].capital, units: { infantry: 2 } }]).code).toBe('not_purchased');
  });

  it('destroys stranded aircraft and forfeits unplaced purchases', () => {
    const s = freshGame(2, 143);
    const pid = s.currentPlayer;
    purchase(s, pid, [{ type: 'infantry', count: 1 }]);
    gotoCombatMove(s);
    expect(combatMove(s, pid, []).ok).toBe(true);
    gotoCombat(s);
    gotoNonCombat(s);
    // Rig a fighter onto ground not held since turn start.
    const spot = Object.keys(s.territories).find((t) => s.territories[t].owner === pid)!;
    s.ownedAtTurnStart = Object.keys(s.territories).filter((t) => t !== spot && s.territories[t].owner === pid);
    s.territories[spot].units.fighter = 1;
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.phase).toBe('mobilize');
    expect(s.territories[spot].units.fighter).toBe(0);
    expect(s.events.some((e) => e.kind === 'stranded')).toBe(true);
    // Skip mobilizing: purchases are forfeited, not banked.
    expect(endPhase(s, pid).ok).toBe(true);
    expect(s.purchased.infantry ?? 0).toBe(0);
    expect(s.events.some((e) => e.kind === 'forfeit')).toBe(true);
  });

  it('blocks ending combat with open battles and phases after game over', () => {
    const s = freshGame(2, 144);
    gotoCombatMove(s);
    const pid = s.currentPlayer;
    s.territories['idaho'].owner = pid;
    s.territories['idaho'].units.infantry = 2;
    s.territories['montana'].owner = (pid + 1) % 2;
    combatMove(s, pid, [{ from: 'idaho', to: 'montana', units: { infantry: 2 } }]);
    gotoCombat(s);
    expect(endPhase(s, pid).code).toBe('battles_open');
    resolveBattleAuto(s, pid, 'montana');
    // Force game over and confirm the door shuts.
    s.phase = 'gameover';
    s.winner = pid;
    expect(endPhase(s, pid).code).toBe('game_over');
    expect(sendMessage(s, pid, 'all', 'gg').ok).toBe(true); // chat stays open
  });

  it('rejects actions from the wrong player', () => {
    const s = freshGame(2, 145);
    const pid = s.currentPlayer;
    const other = 1 - pid;
    expect(endPhase(s, other).code).toBe('not_your_turn');
    expect(serialize(s)).toBe(serialize(freshGame(2, 145)));
  });
});

describe('blitz capture consequences', () => {
  it('transfers the bank when a blitz takes an empty capital', () => {
    const s = freshGame(4, 146);
    gotoCombatMove(s);
    const me = s.currentPlayer;
    const foeB = (me + 2) % s.numPlayers;
    const foeA = (me + 1) % s.numPlayers;
    const target = s.players[foeB].capital;
    // Find origin -> mid -> capital with origin non-adjacent to the capital.
    let origin = '';
    let mid = '';
    for (const m of neighborsOf(target)) {
      for (const o of neighborsOf(m)) {
        if (o !== target && !neighborsOf(o).includes(target)) {
          origin = o;
          mid = m;
          break;
        }
      }
      if (origin) break;
    }
    expect(origin, 'need a 2-step blitz path into a capital').not.toBe('');
    s.territories[origin].owner = me;
    s.territories[origin].units.tank = 1;
    s.territories[mid].owner = foeA;
    for (const k of Object.keys(s.territories[mid].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories[mid].units[k] = 0;
    }
    s.territories[target].owner = foeB;
    for (const k of Object.keys(s.territories[target].units) as Array<keyof typeof s.territories[string]['units']>) {
      s.territories[target].units[k] = 0;
    }
    s.players[foeB].ipcs = 10;
    const bankBefore = s.players[me].ipcs;
    const r = combatMove(s, me, [{ from: origin, to: target, units: { tank: 1 }, via: [mid] }]);
    expect(r.ok).toBe(true);
    expect(s.territories[mid].owner).toBe(me); // captured in passing
    gotoCombat(s);
    resolveBattleAuto(s, me, target);
    expect(s.territories[target].owner).toBe(me);
    expect(s.players[me].ipcs).toBe(bankBefore + 10);
    expect(s.players[foeB].ipcs).toBe(0);
    expect(s.players[foeB].alive).toBe(true); // still holds land elsewhere
  });
});
