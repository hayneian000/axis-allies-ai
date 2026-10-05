// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  autoCasualties,
  autoCasualtyPolicy,
  combatMove,
  emptyUnits,
  mobilize,
  nonCombatMove,
  openBattles,
  purchase,
  resolveCombatRound,
  retreat,
} from '../engine/engine';
import type { GameState, UnitCounts } from '../engine/types';
import { UNITS, isSea, neighborsOf } from '../data/data';
import {
  freshGame,
  gotoCombat,
  gotoCombatMove,
  gotoMobilize,
  gotoNonCombat,
  resolveBattleAuto,
} from './helpers';

/**
 * Navy phase 1 — 1942 2e naval rules on the US map's three sea zones
 * (pacific, gulf, atlantic).
 *
 * Covered: 2-zone ship movement, hostile-zone rules (surface warships only),
 * transport capacity/loading/offloading/bridging, amphibious assaults with
 * offshore bombardment, sea combat, battleship 2-hit tracking,
 * transports-chosen-last, cargo destruction, mobilization into sea zones, and
 * sea-zone setup exemptions.
 *
 * Phase-1 simplifications under test: submarines and carriers are data-only
 * (they fight as plain 2/1 and 1/2 units); amphibious assaults launch from
 * friendly sea zones only; mobilization is into friendly or empty waters.
 *
 * Rigging convention (matches tests/rules): the board is rigged BEFORE
 * gotoCombatMove; `pid` is s.currentPlayer (always 0 in freshGame).
 */

/** Zero a territory's units, then set the given ones. */
function setUnits(s: GameState, tid: string, units: Partial<UnitCounts>): void {
  s.territories[tid].units = { ...emptyUnits(), ...units };
}

/** Give a sea zone an owner (null = open waters) and ships. */
function setSea(s: GameState, zid: string, owner: number | null, units: Partial<UnitCounts>): void {
  s.territories[zid].owner = owner;
  setUnits(s, zid, units);
}

/** Total embarked units of one type in a sea zone. */
function cargoN(s: GameState, zid: string, owner: number, type: keyof UnitCounts): number {
  let n = 0;
  for (const l of s.territories[zid].cargo ?? []) {
    if (l.owner === owner) n += l.units[type];
  }
  return n;
}

describe('naval movement (1942 2e p.27)', () => {
  it('ships move up to 2 sea zones', () => {
    // 1942 2e p.27: all sea units move 2 sea zones.
    const s = freshGame(2, 301);
    const pid = s.currentPlayer;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'atlantic', units: { destroyer: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['atlantic'].units.destroyer).toBe(1);
    expect(s.territories['pacific'].units.destroyer).toBe(0);
    // A fleet entering open waters claims the zone; the emptied zone is open again.
    expect(s.territories['atlantic'].owner).toBe(pid);
    expect(s.territories['pacific'].owner).toBe(null);
  });

  it('ships cannot sail directly into a land territory', () => {
    const s = freshGame(2, 302);
    const pid = s.currentPlayer;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    s.territories['california'].owner = pid;
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'california', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('disembark_flag');
  });

  it('a hostile sea zone blocks ship transit', () => {
    // 1942 2e p.27: a zone is hostile if it holds enemy surface warships.
    const s = freshGame(2, 303);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'atlantic', units: { destroyer: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('range');
  });

  it('lone enemy transports and subs neither make a zone hostile nor block movement', () => {
    // 1942 2e p.27: subs and transports alone do not make a zone hostile.
    // (Full submarine rules arrive in navy phase 2; here they are data-only.)
    const s = freshGame(2, 304);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    setSea(s, 'gulf', foe, { transport: 1, submarine: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'atlantic', units: { destroyer: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['atlantic'].units.destroyer).toBe(1);
  });

  it('transports may not attack a hostile sea zone unescorted', () => {
    // 1942 2e p.30: a transport may not attack without an escorting warship.
    const s = freshGame(2, 305);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { transport: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { transport: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_escort');
  });

  it('an escorted transport may enter a hostile sea zone and fight', () => {
    const s = freshGame(2, 306);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { transport: 1, destroyer: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'pacific', to: 'gulf', units: { transport: 1, destroyer: 1 } },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(openBattles(s).some((b) => b.territoryId === 'gulf')).toBe(true);
  });

  it('ships reposition between friendly sea zones in non-combat', () => {
    const s = freshGame(2, 307);
    const pid = s.currentPlayer;
    setSea(s, 'pacific', pid, { cruiser: 1 });
    gotoCombatMove(s);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { cruiser: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['gulf'].units.cruiser).toBe(1);
  });
});

describe('transport loading (1942 2e pp.13, 30)', () => {
  it('loads two infantry onto one transport', () => {
    // 1942 2e p.30: capacity is one land unit plus one additional infantry.
    const s = freshGame(2, 311);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 2 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { infantry: 2 }, embark: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['california'].units.infantry).toBe(0);
    expect(cargoN(s, 'pacific', pid, 'infantry')).toBe(2);
  });

  it('loads one infantry plus one tank', () => {
    const s = freshGame(2, 312);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1, tank: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { infantry: 1, tank: 1 }, embark: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(cargoN(s, 'pacific', pid, 'infantry')).toBe(1);
    expect(cargoN(s, 'pacific', pid, 'tank')).toBe(1);
  });

  it('cannot overload a transport', () => {
    const s = freshGame(2, 313);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1, tank: 2 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    // Two non-infantry exceed one transport's capacity.
    const r = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { tank: 2 }, embark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_capacity');
    // Three infantry exceed the two-unit cap too.
    setUnits(s, 'california', { infantry: 3 });
    const r2 = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { infantry: 3 }, embark: true },
    ]);
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe('no_capacity');
  });

  it('cannot load when no transport is present', () => {
    const s = freshGame(2, 314);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1 });
    setSea(s, 'pacific', pid, {});
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { infantry: 1 }, embark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_transport');
  });

  it('cannot load in a hostile sea zone', () => {
    // 1942 2e p.30: transports may not load in a hostile sea zone.
    const s = freshGame(2, 315);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['florida'].owner = pid;
    setUnits(s, 'florida', { infantry: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1, transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'florida', to: 'gulf', units: { infantry: 1 }, embark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('hostile_waters');
  });

  it('AA guns cannot embark during combat movement', () => {
    // Project rule (matches 1942 2e movement): AA moves in non-combat only.
    const s = freshGame(2, 316);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { aa: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california', to: 'pacific', units: { aa: 1 }, embark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('aa_no_attack');
  });

  it('loading requires the embark flag', () => {
    const s = freshGame(2, 317);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california', to: 'pacific', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('embark_flag');
  });

  it('cargo sails with its transport', () => {
    const s = freshGame(2, 318);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 2 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california', to: 'pacific', units: { infantry: 2 }, embark: true }]).ok,
    ).toBe(true);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { transport: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(cargoN(s, 'gulf', pid, 'infantry')).toBe(2);
    expect(cargoN(s, 'pacific', pid, 'infantry')).toBe(0);
  });
});

describe('transport offload and bridging (1942 2e p.30)', () => {
  it('bridges: loads and offloads without the transport moving', () => {
    // 1942 2e p.30: a transport may load and offload without moving ("bridging").
    const s = freshGame(2, 321);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california', to: 'pacific', units: { infantry: 1 }, embark: true }]).ok,
    ).toBe(true);
    gotoNonCombat(s);
    const r = nonCombatMove(s, pid, [
      { from: 'pacific', to: 'california', units: { infantry: 1 }, disembark: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['california'].units.infantry).toBe(1);
    expect(s.territories['pacific'].units.transport).toBe(1);
    expect(cargoN(s, 'pacific', pid, 'infantry')).toBe(0);
  });

  it('combat offload into friendly territory is rejected', () => {
    // In the combat-move phase a disembark is always an assault (p.15);
    // friendly ferrying waits for non-combat.
    const s = freshGame(2, 322);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california', to: 'pacific', units: { infantry: 1 }, embark: true }]).ok,
    ).toBe(true);
    const r = combatMove(s, pid, [
      { from: 'pacific', to: 'california', units: { infantry: 1 }, disembark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('friendly_offload');
  });

  it('offloading requires the disembark flag', () => {
    const s = freshGame(2, 323);
    const pid = s.currentPlayer;
    s.territories['california'].owner = pid;
    setUnits(s, 'california', { infantry: 1 });
    setSea(s, 'pacific', pid, { transport: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california', to: 'pacific', units: { infantry: 1 }, embark: true }]).ok,
    ).toBe(true);
    const r = combatMove(s, pid, [{ from: 'pacific', to: 'california', units: { infantry: 1 } }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('disembark_flag');
  });
});

describe('amphibious assaults (1942 2e p.15)', () => {
  /** Rig an invasion: pid holds the gulf with a loaded transport; florida is foe-held. */
  function rigInvasion(s: GameState, pid: number, foe: number, escorts: Partial<UnitCounts> = {}) {
    s.territories['florida'].owner = foe;
    setUnits(s, 'florida', { infantry: 2 });
    setSea(s, 'gulf', pid, { transport: 1, ...escorts });
    s.territories['gulf'].cargo = [
      { owner: pid, units: { ...emptyUnits(), infantry: 2 } },
    ];
  }

  it('declares an assault with bombardment ships and seaborne troops', () => {
    const s = freshGame(2, 331);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, { battleship: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    const b = openBattles(s).find((x) => x.territoryId === 'florida')!;
    expect(b).toBeDefined();
    expect(b.amphibiousFrom).toBe('gulf');
    expect(b.seaborne).toMatchObject({ infantry: 2 });
    // One bombarding ship per offloaded land unit (p.15).
    expect(b.bombard).toEqual({ battleship: 1, cruiser: 0 });
  });

  it('bombardment is capped at one ship per offloaded land unit', () => {
    const s = freshGame(2, 332);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, { battleship: 2, cruiser: 2 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true }]).ok,
    ).toBe(true);
    const b = openBattles(s).find((x) => x.territoryId === 'florida')!;
    const ships = b.bombard!;
    expect(ships.battleship + ships.cruiser).toBe(2);
  });

  it('bombardment fires before the first land round and its victims still defend', () => {
    // 1942 2e p.15: bombardment casualties fire back in the first land
    // round, then are removed.
    const s = freshGame(2, 333);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, { battleship: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true }]).ok,
    ).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'florida')!;
    const r = resolveCombatRound(s, pid, 'florida');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(b.bombardDone).toBe(true);
    expect(s.events.some((e) => e.kind === 'bombard')).toBe(true);
    // Bombardment victims defended this round: the defender still rolled.
    const combat = r.combat!;
    expect(combat.defenseRolls.length).toBeGreaterThan(0);
    const doomed = b.bombardDoomed;
    const defenderHitsTaken = combat.pendingDefender;
    // Resolve the round's casualties: the doomed die after defending (p.15).
    if (b.pendingAttacker > 0) expect(autoCasualties(s, pid, 'florida', 'attacker').ok).toBe(true);
    if (!b.over && b.pendingDefender > 0) {
      expect(autoCasualties(s, pid, 'florida', 'defender').ok).toBe(true);
    }
    // The defender lost one infantry to combat and the doomed one to
    // bombardment, so the attacker captures: had the doomed survived, the
    // battle would still be open.
    expect(doomed).toBeGreaterThan(0);
    expect(defenderHitsTaken).toBeGreaterThan(0);
    expect(b.result).toBe('captured');
    expect(s.territories['florida'].owner).toBe(pid);
  });

  it('no bombardment when a sea battle rages in the launch zone', () => {
    // 1942 2e p.15: bombardment happens only if no sea battle was fought.
    // Phase 1 launches assaults from friendly zones only, so the concurrent
    // sea battle is rigged directly onto the battle list.
    const s = freshGame(2, 334);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, { battleship: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true }]).ok,
    ).toBe(true);
    s.battles.push({
      id: s.nextBattleId++,
      territoryId: 'gulf',
      attackerId: foe,
      defenderId: pid,
      kind: 'combat',
      attack: { ...emptyUnits(), destroyer: 1 },
      origins: ['atlantic'],
      aaFired: false,
      sbrStruck: false,
      rounds: 0,
      pendingAttacker: 0,
      pendingDefender: 0,
      attackerResolved: true,
      defenderResolved: true,
      over: false,
      result: null,
      bombardDone: false,
      bombardDoomed: 0,
      damagedAttackBB: 0,
      damagedDefBB: 0,
      subPhase: 'attacker',
      submergedA: 0,
      submergedD: 0,
      pendAtkAir: 0,
      pendDefAir: 0,
    });
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'florida')!;
    expect(b.bombard).toEqual({ battleship: 1, cruiser: 0 });
    const r = resolveCombatRound(s, pid, 'florida');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(b.bombardDoomed).toBe(0);
    expect(s.events.some((e) => e.kind === 'bombard')).toBe(false);
  });

  it('seaborne units cannot retreat', () => {
    // 1942 2e p.15: troops that came off transports fight to the death.
    const s = freshGame(2, 335);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, {});
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true }]).ok,
    ).toBe(true);
    gotoCombat(s);
    expect(resolveCombatRound(s, pid, 'florida').ok).toBe(true);
    const b = s.battles.find((x) => x.territoryId === 'florida' && !x.over);
    if (b) {
      // Clear casualties so retreat is legal to attempt.
      if (b.pendingAttacker > 0) expect(autoCasualties(s, pid, 'florida', 'attacker').ok).toBe(true);
      if (b.pendingDefender > 0) expect(autoCasualties(s, pid, 'florida', 'defender').ok).toBe(true);
      const r = retreat(s, pid, 'florida', 'gulf');
      expect(r.ok).toBe(false);
      expect(r.code).toBe('bad_retreat');
    }
  });

  it('overland attackers can retreat from an amphibious assault while seaborne fight on', () => {
    const s = freshGame(2, 336);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigInvasion(s, pid, foe, {});
    // An overland column joins from neighboring gulf_south.
    s.territories['gulf_south'].owner = pid;
    setUnits(s, 'gulf_south', { tank: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [
        { from: 'gulf', to: 'florida', units: { infantry: 2 }, disembark: true },
        { from: 'gulf_south', to: 'florida', units: { tank: 1 } },
      ]).ok,
    ).toBe(true);
    gotoCombat(s);
    expect(resolveCombatRound(s, pid, 'florida').ok).toBe(true);
    const b = s.battles.find((x) => x.territoryId === 'florida' && !x.over);
    if (b) {
      if (b.pendingAttacker > 0) expect(autoCasualties(s, pid, 'florida', 'attacker').ok).toBe(true);
      if (b.pendingDefender > 0) expect(autoCasualties(s, pid, 'florida', 'defender').ok).toBe(true);
      const r = retreat(s, pid, 'florida', 'gulf_south');
      expect(r.ok, `${r.code} ${r.error}`).toBe(true);
      // The tank withdrew; the seaborne infantry fight on.
      expect(s.territories['gulf_south'].units.tank).toBe(1);
      const b2 = s.battles.find((x) => x.territoryId === 'florida' && !x.over)!;
      expect(b2.attack.infantry).toBeGreaterThan(0);
      expect(b2.attack.tank).toBe(0);
    }
  });

  it('an assault cannot launch from hostile waters', () => {
    // Phase-1 simplification of 1942 2e p.15 sequencing: the launch zone
    // must already be friendly (no concurrent sea-battle-then-assault).
    const s = freshGame(2, 337);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['florida'].owner = foe;
    setUnits(s, 'florida', { infantry: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1, transport: 1 });
    s.territories['gulf'].cargo = [{ owner: pid, units: { ...emptyUnits(), infantry: 1 } }];
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'gulf', to: 'florida', units: { infantry: 1 }, disembark: true },
    ]);
    expect(r.ok).toBe(false);
    // Either not_owner (zone still foe-held) or hostile_waters: both reject.
    expect(['not_owner', 'hostile_waters']).toContain(r.code);
  });
});

describe('sea combat (1942 2e pp.27-28)', () => {
  it('resolves a destroyer duel and the winner takes the zone', () => {
    const s = freshGame(2, 341);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { destroyer: 2 });
    setSea(s, 'gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { destroyer: 2 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'gulf');
    const b = s.battles.find((x) => x.territoryId === 'gulf')!;
    expect(b.over).toBe(true);
    // One side holds the zone afterwards.
    const pidWon = b.result === 'sea_taken' && s.territories['gulf'].owner === pid;
    const foeWon = s.territories['gulf'].owner === foe;
    expect(pidWon || foeWon).toBe(true);
  });

  it('warships can withdraw from a sea battle to a friendly sea origin', () => {
    const s = freshGame(2, 342);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    setSea(s, 'gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { destroyer: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    expect(resolveCombatRound(s, pid, 'gulf').ok).toBe(true);
    const b = s.battles.find((x) => x.territoryId === 'gulf' && !x.over);
    if (b) {
      if (b.pendingAttacker > 0) expect(autoCasualties(s, pid, 'gulf', 'attacker').ok).toBe(true);
      if (b.pendingDefender > 0) expect(autoCasualties(s, pid, 'gulf', 'defender').ok).toBe(true);
      const r = retreat(s, pid, 'gulf', 'pacific');
      expect(r.ok, `${r.code} ${r.error}`).toBe(true);
      expect(s.territories['pacific'].units.destroyer).toBe(1);
    }
  });

  it('a lone transport caught at sea is destroyed without a fight', () => {
    // 1942 2e p.30: transports have no combat value.
    const s = freshGame(2, 343);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { destroyer: 1 });
    setSea(s, 'gulf', foe, { transport: 1 });
    s.territories['gulf'].cargo = [{ owner: foe, units: { ...emptyUnits(), infantry: 2 } }];
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { destroyer: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    resolveBattleAuto(s, pid, 'gulf');
    expect(s.territories['gulf'].units.transport).toBe(0);
    // Cargo is destroyed with its transport (p.30).
    expect(cargoN(s, 'gulf', foe, 'infantry')).toBe(0);
  });
});

describe('battleship two-hit tracking (1942 2e p.27)', () => {
  it('the first hit damages, the second hit in the same combat destroys', () => {
    const force = { ...emptyUnits(), battleship: 1 };
    expect(autoCasualtyPolicy(force, 1, 1)).toEqual({ removed: {}, damaged: 1 });
    expect(autoCasualtyPolicy(force, 2, 1)).toEqual({ removed: { battleship: 1 }, damaged: 1 });
  });

  it('damage is tracked on the battle through autoCasualties', () => {
    const s = freshGame(2, 352);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { battleship: 1 });
    setSea(s, 'gulf', foe, { destroyer: 2 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { battleship: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'gulf')!;
    // Force one attacker hit through the casualty flow.
    b.pendingAttacker = 1;
    b.attackerResolved = false;
    expect(autoCasualties(s, pid, 'gulf', 'attacker').ok).toBe(true);
    expect(b.attack.battleship).toBe(1);
    expect(b.damagedAttackBB).toBe(1);
    // A second hit in the same combat sinks her.
    b.pendingAttacker = 1;
    b.attackerResolved = false;
    expect(autoCasualties(s, pid, 'gulf', 'attacker').ok).toBe(true);
    expect(b.attack.battleship).toBe(0);
    expect(b.damagedAttackBB).toBe(0);
  });

  it('a battleship that survives the combat is repaired', () => {
    // 1942 2e p.27: a battleship surviving with one hit is repaired at once.
    const s = freshGame(2, 353);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { battleship: 1 });
    setSea(s, 'gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { battleship: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'gulf')!;
    b.pendingAttacker = 1;
    b.attackerResolved = false;
    expect(autoCasualties(s, pid, 'gulf', 'attacker').ok).toBe(true);
    expect(b.damagedAttackBB).toBe(1);
    resolveBattleAuto(s, pid, 'gulf');
    expect(b.over).toBe(true);
    // The surviving battleship keeps no damage counter into the next combat.
    expect(b.damagedAttackBB).toBe(0);
  });
});

describe('transports are chosen last (1942 2e p.30)', () => {
  it('autoCasualtyPolicy spends warships before transports', () => {
    const force = { ...emptyUnits(), transport: 2, destroyer: 1, infantry: 1 };
    expect(autoCasualtyPolicy(force, 1, 0)).toEqual({ removed: { infantry: 1 }, damaged: 0 });
    expect(autoCasualtyPolicy(force, 2, 0)).toEqual({
      removed: { infantry: 1, destroyer: 1 },
      damaged: 0,
    });
    // Only when nothing else remains do transports die.
    expect(autoCasualtyPolicy(force, 4, 0)).toEqual({
      removed: { infantry: 1, destroyer: 1, transport: 2 },
      damaged: 0,
    });
  });

  it('autoCasualties keeps transports afloat while warships remain', () => {
    const s = freshGame(2, 362);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'pacific', pid, { transport: 1, destroyer: 1 });
    setSea(s, 'gulf', foe, { destroyer: 3 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'pacific', to: 'gulf', units: { transport: 1, destroyer: 1 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'gulf')!;
    b.pendingAttacker = 1;
    b.attackerResolved = false;
    expect(autoCasualties(s, pid, 'gulf', 'attacker').ok).toBe(true);
    expect(b.attack.destroyer).toBe(0);
    expect(b.attack.transport).toBe(1);
  });
});

describe('mobilizing the fleet (1942 2e p.21)', () => {
  it('purchases and floats naval units', () => {
    const s = freshGame(2, 371);
    const pid = s.currentPlayer;
    expect(UNITS.transport.cost).toBe(7);
    expect(UNITS.submarine.cost).toBe(6);
    expect(UNITS.destroyer.cost).toBe(8);
    expect(UNITS.cruiser.cost).toBe(12);
    expect(UNITS.carrier.cost).toBe(14);
    expect(UNITS.battleship.cost).toBe(20);
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'destroyer', count: 1 }]).ok).toBe(true);
    expect(s.purchased.destroyer).toBe(1);
  });

  it('mobilizes sea units into a factory-adjacent sea zone', () => {
    // 1942 2e p.21: sea units mobilize into a sea zone adjacent to a
    // territory with an industrial complex.
    const s = freshGame(2, 372);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const sz = neighborsOf(cap).find(isSea)!;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'destroyer', count: 1 }]).ok).toBe(true);
    gotoMobilize(s);
    const r = mobilize(s, pid, [{ territory: cap, units: { destroyer: 1 }, seaZone: sz }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories[sz].units.destroyer).toBe(1);
    expect(s.territories[sz].owner).toBe(pid);
  });

  it('rejects land units mobilized into a sea zone', () => {
    const s = freshGame(2, 373);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const sz = neighborsOf(cap).find(isSea)!;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'infantry', count: 1 }]).ok).toBe(true);
    gotoMobilize(s);
    const r = mobilize(s, pid, [{ territory: cap, units: { infantry: 1 }, seaZone: sz }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad_unit');
  });

  it('rejects mobilizing into a non-adjacent sea zone', () => {
    const s = freshGame(2, 374);
    const pid = s.currentPlayer;
    const cap = s.players[pid].capital;
    const far = ['pacific', 'gulf', 'atlantic'].find((z) => !neighborsOf(cap).includes(z))!;
    s.players[pid].ipcs = 100;
    expect(purchase(s, pid, [{ type: 'destroyer', count: 1 }]).ok).toBe(true);
    gotoMobilize(s);
    const r = mobilize(s, pid, [{ territory: cap, units: { destroyer: 1 }, seaZone: far }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_adjacent');
  });
});

describe('sea-zone setup exemptions', () => {
  it('sea zones never hold garrisons, owners, or IPCs', () => {
    for (const n of [2, 3, 4]) {
      const s = freshGame(n, 381);
      for (const zid of ['pacific', 'gulf', 'atlantic']) {
        const t = s.territories[zid];
        expect(t.owner).toBe(null);
        expect(t.units).toEqual(emptyUnits());
        expect(t.cargo ?? []).toEqual([]);
      }
    }
  });

  it('unit roster carries the full 1942 2e naval line', () => {
    // Stats verified against the official 1942 2e rulebook (Oct 2026).
    expect([UNITS.transport.attack, UNITS.transport.defense, UNITS.transport.move]).toEqual([0, 0, 2]);
    expect([UNITS.destroyer.attack, UNITS.destroyer.defense]).toEqual([2, 2]);
    expect([UNITS.cruiser.attack, UNITS.cruiser.defense]).toEqual([3, 3]);
    expect([UNITS.battleship.attack, UNITS.battleship.defense]).toEqual([4, 4]);
    // Submarines and carriers are data-only in phase 1 (abilities in phase 2).
    expect(UNITS.submarine.move).toBe(2);
    expect(UNITS.carrier.move).toBe(2);
  });
});
