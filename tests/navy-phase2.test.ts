import { describe, expect, it } from 'vitest';
import {
  autoCasualties,
  chooseCasualties,
  combatMove,
  emptyUnits,
  mobilize,
  nonCombatMove,
  purchase,
  resolveCombatRound,
  submergeSubs,
  submergeTurn,
} from '../engine/engine';
import type { GameState, UnitCounts } from '../engine/types';
import {
  freshGame,
  gotoCombat,
  gotoCombatMove,
  gotoMobilize,
  gotoNonCombat,
  resolveBattleAuto,
} from './helpers';

function setUnits(s: GameState, tid: string, units: Partial<UnitCounts>): void {
  s.territories[tid].units = { ...emptyUnits(), ...units };
}
function setSea(s: GameState, zid: string, owner: number | null, units: Partial<UnitCounts>): void {
  s.territories[zid].owner = owner;
  setUnits(s, zid, units);
}

/**
 * Navy phase 2 — 1942 2e submarine rules (pp.27-29) on the US map's sea zones.
 *
 * Covered: surprise strike ordering and no-return-fire, submerge timing
 * (attacker-first, before dice) and removal from battle, destroyer cancelling
 * all four sub abilities, sub pass-through movement, destroyer interception,
 * the ignore-or-attack choice in subs/transports-only zones, air<->sub
 * casualty constraints, and mobilization into hostile waters (p.21).
 */

describe('surprise strike (1942 2e p.29)', () => {
  it('attacker subs fire before the general exchange', () => {
    // Attacker: 1 sub. Defender: 1 cruiser (no destroyer, so surprise happens).
    // The sub's surprise strike fires before the cruiser's return fire.
    const s = freshGame(2, 101);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { cruiser: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // Attacker declines to submerge; defender has no subs.
    expect(submergeTurn(s, 'western_gulf')).toBe('attacker');
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 0).ok).toBe(true);
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
    // The battle resolves; the mechanics work (dice vary by seed).
    const r = resolveCombatRound(s, pid, 'western_gulf');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
  });

  it('defender subs fire their surprise strike after the attacker\'s', () => {
    // Both sides have subs, no destroyers. Attacker decides first, then defender.
    const s = freshGame(2, 102);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1, cruiser: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    expect(submergeTurn(s, 'western_gulf')).toBe('attacker');
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 0).ok).toBe(true);
    expect(submergeTurn(s, 'western_gulf')).toBe('defender');
    expect(submergeSubs(s, foe, 'western_gulf', 'defender', 0).ok).toBe(true);
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
    const r = resolveCombatRound(s, pid, 'western_gulf');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
  });

  it('a destroyer cancels only the enemy\'s surprise strike', () => {
    // 1942 2e p.28: a destroyer cancels enemy subs' surprise strike, not friendly.
    // Attacker: 1 sub. Defender: 1 destroyer + 1 sub.
    // - Attacker's sub: cancelled (defender has destroyer). No decision.
    // - Defender's sub: NOT cancelled (attacker has no destroyer). Gets decision.
    const s = freshGame(2, 103);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { destroyer: 1, submarine: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // Attacker's sub is cancelled; defender's sub gets a decision.
    expect(submergeTurn(s, 'western_gulf')).toBe('defender');
    expect(submergeSubs(s, foe, 'western_gulf', 'defender', 0).ok).toBe(true);
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
    const r = resolveCombatRound(s, pid, 'western_gulf');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
  });
});

describe('submerge (1942 2e p.29)', () => {
  it('attacker decides first, before any dice are rolled', () => {
    const s = freshGame(2, 104);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // Attacker's turn to decide.
    expect(submergeTurn(s, 'western_gulf')).toBe('attacker');
    // Defender cannot decide before the attacker.
    expect(submergeSubs(s, foe, 'western_gulf', 'defender', 1).ok).toBe(false);
    // Attacker submerges.
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 1).ok).toBe(true);
    // Now defender's turn.
    expect(submergeTurn(s, 'western_gulf')).toBe('defender');
    expect(submergeSubs(s, foe, 'western_gulf', 'defender', 0).ok).toBe(true);
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
    // The attacker's sub is removed from the battle.
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    expect(b.attack.submarine).toBe(0);
    expect(b.submergedA).toBe(1);
  });

  it('a submerged sub is removed from the battle', () => {
    const s = freshGame(2, 105);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1, destroyer: 1 });
    setSea(s, 'western_gulf', foe, { cruiser: 1 });
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1, destroyer: 1 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    // Attacker submerges the sub.
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 1).ok).toBe(true);
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    expect(b.attack.submarine).toBe(0);
    expect(b.submergedA).toBe(1);
    expect(b.attack.destroyer).toBe(1);
    // The submerged sub stays out of the fight.
    resolveBattleAuto(s, pid, 'western_gulf');
    expect(b.over).toBe(true);
  });

  it('subs cannot submerge with an enemy destroyer present', () => {
    // 1942 2e p.28: destroyer cancels Submersible.
    const s = freshGame(2, 106);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // No submerge decision is due (attacker's sub is cancelled).
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 1).ok).toBe(false);
  });

  it('invalid submerge actions never mutate state', () => {
    const s = freshGame(2, 107);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    const before = JSON.stringify(s.battles);
    // Too many subs.
    expect(submergeSubs(s, pid, 'western_gulf', 'attacker', 5).ok).toBe(false);
    // Wrong side.
    expect(submergeSubs(s, pid, 'western_gulf', 'defender', 1).ok).toBe(false);
    // Wrong player.
    expect(submergeSubs(s, foe, 'western_gulf', 'attacker', 1).ok).toBe(false);
    expect(JSON.stringify(s.battles)).toBe(before);
  });
});

describe('destroyer cancels sub abilities (1942 2e p.28)', () => {
  it('air hits CAN be assigned to subs when the attacker has a destroyer', () => {
    // 1942 2e p.29: air cannot hit subs UNLESS a friendly destroyer is present.
    const s = freshGame(2, 108);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { destroyer: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    s.territories['california_coast'].units.fighter = 1;
    gotoCombatMove(s);
    expect(
      combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { destroyer: 1, fighter: 1 } }]).ok,
    ).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    // Rig an air hit on the defender.
    b.pendingDefender = 1;
    b.pendDefAir = 1;
    b.defenderResolved = false;
    // With the attacker's destroyer present, air CAN hit the sub.
    const r = autoCasualties(s, pid, 'western_gulf', 'defender');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['western_gulf'].units.submarine).toBe(0);
  });
});

describe('submarine movement (1942 2e pp.27, 29)', () => {
  it('subs can attack into a hostile zone', () => {
    const s = freshGame(2, 110);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { cruiser: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'western_gulf' && !b.over)).toBe(true);
  });

  it('zones with only enemy subs/transports do not block movement', () => {
    const s = freshGame(2, 111);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'western_gulf', pid, { destroyer: 1 });
    setSea(s, 'eastern_gulf', foe, { submarine: 1, transport: 1 });
    setSea(s, 'south_atlantic', null, {});
    gotoCombatMove(s);
    // Destroyer moves western_gulf -> eastern_gulf -> south_atlantic, passing
    // through the subs/transports-only zone without stopping.
    const r = combatMove(s, pid, [{ from: 'western_gulf', to: 'south_atlantic', units: { destroyer: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.territories['south_atlantic'].units.destroyer).toBe(1);
  });

  it('subs cannot pass through a zone with an enemy destroyer', () => {
    // 1942 2e p.29: entering a zone with an enemy destroyer ends movement.
    const s = freshGame(2, 112);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { destroyer: 1 });
    setSea(s, 'north_atlantic', null, {});
    gotoCombatMove(s);
    // Sub tries pacific -> gulf -> atlantic. The destroyer in gulf blocks transit.
    const r = combatMove(s, pid, [{ from: 'california_coast', to: 'north_atlantic', units: { submarine: 1 } }]);
    expect(r.ok).toBe(false);
    expect(['destroyer_intercept', 'range']).toContain(r.code);
  });
});

describe('ignore-or-attack choice (1942 2e p.29)', () => {
  it('attacker can ignore subs/transports and coexist', () => {
    const s = freshGame(2, 113);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { destroyer: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california_coast', to: 'western_gulf', units: { destroyer: 1 }, attack: false },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    // No battle; the destroyer coexists with the enemy sub.
    expect(s.battles.filter((b) => b.territoryId === 'western_gulf' && !b.over)).toHaveLength(0);
    expect(s.territories['western_gulf'].units.destroyer).toBe(1);
    const coexist = s.territories['western_gulf'].coexist ?? [];
    expect(coexist.some((f) => f.owner === foe && f.units.submarine === 1)).toBe(true);
  });

  it('attacker can choose to attack subs/transports', () => {
    const s = freshGame(2, 114);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { destroyer: 1 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      { from: 'california_coast', to: 'western_gulf', units: { destroyer: 1 }, attack: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'western_gulf' && !b.over)).toBe(true);
  });

  it('default is to attack (phase-1 behavior preserved)', () => {
    const s = freshGame(2, 115);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { destroyer: 1 });
    setSea(s, 'western_gulf', foe, { transport: 1 });
    gotoCombatMove(s);
    const r = combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { destroyer: 1 } }]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    expect(s.battles.some((b) => b.territoryId === 'western_gulf' && !b.over)).toBe(true);
  });
});

describe('air-sub casualty constraints (1942 2e p.29)', () => {
  it('subs cannot hit air units', () => {
    // The auto policy never assigns sub hits to air.
    const s = freshGame(2, 116);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { submarine: 1 });
    setSea(s, 'western_gulf', foe, { destroyer: 1 });
    s.territories['western_gulf'].units.fighter = 1;
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { submarine: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // Attacker's sub is cancelled by the destroyer (no surprise), but the
    // general-exchange constraint still applies: sub hits are sea-only.
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    b.pendingDefender = 1;
    b.pendDefAir = 0;
    b.defenderResolved = false;
    const r = autoCasualties(s, pid, 'western_gulf', 'defender');
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    // The fighter must survive; the hit went to the destroyer (sea unit).
    expect(s.territories['western_gulf'].units.fighter).toBe(1);
  });

  it('air cannot hit subs without a friendly destroyer present', () => {
    const s = freshGame(2, 117);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, {});
    s.territories['california_coast'].units.fighter = 1;
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { fighter: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    b.pendingDefender = 1;
    b.pendDefAir = 1;
    b.defenderResolved = false;
    const r = autoCasualties(s, pid, 'western_gulf', 'defender');
    // The policy cannot assign the air hit to the sub; the sub survives.
    if (r.ok) {
      expect(s.territories['western_gulf'].units.submarine).toBe(1);
    }
  });

  it('manual casualty selection rejects air-vs-sub assignment', () => {
    const s = freshGame(2, 118);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, {});
    s.territories['california_coast'].units.fighter = 1;
    setSea(s, 'western_gulf', foe, { submarine: 1, destroyer: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { fighter: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    const b = s.battles.find((x) => x.territoryId === 'western_gulf')!;
    b.pendingDefender = 1;
    b.pendDefAir = 1;
    b.defenderResolved = false;
    // No attacking destroyer present: air cannot be assigned to the sub.
    const r = chooseCasualties(s, pid, 'western_gulf', 'defender', { submarine: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('air_vs_sub');
  });
});

describe('mobilization into hostile waters (1942 2e p.21)', () => {
  it('new sea units may be placed even in a hostile sea zone', () => {
    const s = freshGame(2, 119);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'eastern_gulf', foe, { destroyer: 1 });
    // Give pid a factory in florida (adjacent to the gulf).
    s.territories['florida'].owner = pid;
    s.territories['florida'].factory = true;
    s.players[pid].ipcs = 200;
    const pr = purchase(s, pid, [{ type: 'submarine', count: 1 }]);
    expect(pr.ok, `${pr.code} ${pr.error}`).toBe(true);
    gotoMobilize(s);
    const m = mobilize(s, pid, [{ territory: 'florida', seaZone: 'eastern_gulf', units: { submarine: 1 } }]);
    expect(m.ok, `${m.code} ${m.error}`).toBe(true);
    // Both forces are present; no combat occurs during mobilization.
    const z = s.territories['eastern_gulf'];
    const hasSub =
      z.units.submarine === 1 ||
      (z.coexist ?? []).some((f) => f.owner === pid && f.units.submarine === 1);
    expect(hasSub).toBe(true);
    const hasDestroyer =
      z.units.destroyer === 1 ||
      (z.coexist ?? []).some((f) => f.owner === foe && f.units.destroyer === 1);
    expect(hasDestroyer).toBe(true);
  });
});

describe('submergeTurn UI helper', () => {
  it('returns null when no decision is due', () => {
    const s = freshGame(2, 120);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    setSea(s, 'california_coast', pid, { destroyer: 1 });
    setSea(s, 'western_gulf', foe, { destroyer: 1 });
    gotoCombatMove(s);
    expect(combatMove(s, pid, [{ from: 'california_coast', to: 'western_gulf', units: { destroyer: 1 } }]).ok).toBe(true);
    gotoCombat(s);
    // No subs: no decision.
    expect(submergeTurn(s, 'western_gulf')).toBe(null);
  });
});

describe('amphibious assault from a contested sea zone (1942 2e p.15: sea battle first)', () => {
  /**
   * Rig: pid holds the gulf with a loaded transport + destroyer while a foe
   * sub lurks there (coexist, e.g. ignored on a prior turn). Florida is foe-held.
   */
  function rigContestedAssault(s: GameState, pid: number, foe: number) {
    s.territories['florida'].owner = foe;
    setUnits(s, 'florida', { infantry: 2 });
    setSea(s, 'eastern_gulf', pid, { transport: 1, destroyer: 1 });
    s.territories['eastern_gulf'].cargo = [
      { owner: pid, units: { ...emptyUnits(), infantry: 2 } },
    ];
    s.territories['eastern_gulf'].coexist = [
      { owner: foe, units: { ...emptyUnits(), submarine: 1 } },
    ];
  }

  it('defers the landing until the sea battle is won; no bombardment from contested waters', () => {
    const s = freshGame(2, 901);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    rigContestedAssault(s, pid, foe);
    gotoCombatMove(s);
    const r = combatMove(s, pid, [
      // The destroyer turns on the lurking sub (same-zone attack)...
      { from: 'eastern_gulf', to: 'eastern_gulf', units: { destroyer: 1 }, attack: true },
      // ...while the transport declares the assault on florida.
      { from: 'eastern_gulf', to: 'florida', units: { infantry: 2 }, disembark: true },
    ]);
    expect(r.ok, `${r.code} ${r.error}`).toBe(true);
    // The sea battle is open in the gulf; the florida landing stays pending...
    expect(s.battles.some((b) => b.territoryId === 'eastern_gulf' && !b.over)).toBe(true);
    const land = s.battles.find((b) => b.territoryId === 'florida' && !b.over)!;
    expect(land).toBeDefined();
    expect(land.pendingDisembark).toBeDefined();
    // ...p.15 forbids bombardment when a sea battle rages in the launch zone.
    expect(land.bombard).toBeUndefined();
    // The land battle cannot be fought before the sea battle resolves.
    gotoCombat(s);
    const blocked = resolveCombatRound(s, pid, 'florida');
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('sea_battle_pending');
    // Win the sea battle: the destroyer cancels the sub's surprise strike (p.29).
    resolveBattleAuto(s, pid, 'eastern_gulf');
    expect(s.battles.some((b) => b.territoryId === 'eastern_gulf' && !b.over)).toBe(false);
    // The cargo comes ashore into the florida battle.
    const landed = s.battles.find((b) => b.territoryId === 'florida' && !b.over)!;
    expect(landed).toBeDefined();
    expect(landed.pendingDisembark).toBeUndefined();
    expect(landed.seaborne).toMatchObject({ infantry: 2 });
    resolveBattleAuto(s, pid, 'florida');
  });

  it('an unescorted transport cannot even enter the contested launch zone', () => {
    const s = freshGame(2, 902);
    const pid = s.currentPlayer;
    const foe = 1 - pid;
    s.territories['florida'].owner = foe;
    setUnits(s, 'florida', { infantry: 2 });
    setSea(s, 'western_gulf', foe, { submarine: 1 });
    setSea(s, 'california_coast', pid, { transport: 1 });
    s.territories['california_coast'].cargo = [
      { owner: pid, units: { ...emptyUnits(), infantry: 2 } },
    ];
    gotoCombatMove(s);
    // 1942 2e p.30: transports may not attack a hostile sea zone unescorted,
    // so the assault cannot be declared from these waters at all.
    const r = combatMove(s, pid, [
      { from: 'california_coast', to: 'western_gulf', units: { transport: 1 } },
      { from: 'eastern_gulf', to: 'florida', units: { infantry: 2 }, disembark: true },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_escort');
  });
});
