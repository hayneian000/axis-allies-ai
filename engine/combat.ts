/**
 * engine/combat.ts — Battle resolution: rounds, surprise strikes, casualties, bombardment, retreat, capture.
 */
import { CARGO_TYPES, addUnits, countAir, countLand, countSea, countUnits, describeUnits, emptyUnits, hasEnough, subUnits, undamagedBB, validCounts } from './units';
import { capitalsOf, fail, log, logEvent, requireCurrentAlive, requirePhase, rollDie, rollHits, usedKey, victoryCitiesHeld } from './core';
import { CARRIER_FIGHTERS, addPlayerSeaUnits, cargoOf, carrierSpare, carryCargoAlong, disembarkUnits, normalizeSeaZone, sinkTransportCargo } from './naval';
import { NAVAL_UNIT_TYPES, UNITS, ipcOf, isLand, isSea, landTerritoryIds, neighborsOf } from '../data/data';
import type { UnitType } from '../data/data';
import type { ActionResult, Battle, CombatRoundResult, GameState, UnitCounts } from './types';


// ------------------------------------------------------------- submarines ---

/**
 * A side's subs are eligible to submerge when it has subs in the fight and no
 * hostile destroyer is present (1942 2e p.28: a destroyer cancels Submersible
 * for all enemy submarines in the battle). Only the two fighting sides count;
 * coexisting third parties are not in the battle.
 */
function hasEligibleSubs(state: GameState, b: Battle, side: 'attacker' | 'defender'): boolean {
  const terr = state.territories[b.territoryId];
  if (side === 'attacker') {
    return b.attack.submarine > 0 && terr.units.destroyer === 0;
  }
  return terr.units.submarine > 0 && b.attack.destroyer === 0;
}


/**
 * The submerge decision state with ineligible sides auto-skipped. Pure
 * function of game state: no mutation, so it is safe to call on failure paths.
 */
function effectiveSubPhase(state: GameState, b: Battle): 'attacker' | 'defender' | 'done' {
  let p = b.subPhase;
  for (let i = 0; i < 2 && p !== 'done'; i++) {
    if (!hasEligibleSubs(state, b, p)) p = p === 'attacker' ? 'defender' : 'done';
  }
  return p;
}


/**
 * Which side must decide submarine submerges next in a sea battle, or null
 * when the decision is complete or not applicable. For the battle UI prompt.
 */
export function submergeTurn(state: GameState, territoryId: string): 'attacker' | 'defender' | null {
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b || !isSea(b.territoryId) || b.kind !== 'combat') return null;
  const p = effectiveSubPhase(state, b);
  return p === 'done' ? null : p;
}


/**
 * Submerge submarines instead of fighting (1942 2e p.29). Called once per
 * side per round, BEFORE any dice are rolled, attacker first. A submerged sub
 * is removed from the battle: it cannot fire or take hits for the rest of the
 * fight. Invalid actions never mutate state. Designed so a future LLM-agent
 * tool can call it directly.
 */
export function submergeSubs(
  state: GameState,
  playerId: number,
  territoryId: string,
  side: 'attacker' | 'defender',
  count: number,
): ActionResult {
  const phaseErr = requirePhase(state, ['combat']);
  if (phaseErr) return phaseErr;
  // The defender decides during the attacker's turn, so we only require the
  // decider to be alive — the side check below ensures the right player.
  if (!state.players[playerId]?.alive) return fail('eliminated', 'You are eliminated.');
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b) return fail('no_battle', `There is no open battle in ${territoryId}.`);
  if (!isSea(b.territoryId) || b.kind !== 'combat') {
    return fail('not_sea_battle', 'Submerging is only possible in a sea battle (1942 2e p.29).');
  }
  if (b.pendingAttacker > 0 || b.pendingDefender > 0) {
    return fail('casualties_pending', 'Choose casualties before submerging.');
  }
  if (side === 'attacker' && b.attackerId !== playerId) {
    return fail('not_attacker', 'Only the attacker decides attacker submerges.');
  }
  if (side === 'defender') {
    if (b.defenderId === null) return fail('no_defender', 'There is no defender to decide.');
    if (b.defenderId !== playerId) return fail('not_defender', 'Only the defender decides defender submerges.');
  }
  const due = effectiveSubPhase(state, b);
  if (due !== side) {
    return fail('wrong_order', 'Submerge decisions happen attacker-first, before any dice are rolled (1942 2e p.29).');
  }
  // 1942 2e p.28: an enemy destroyer in the battle cancels Submersible.
  const hostileDD = side === 'attacker'
    ? state.territories[b.territoryId].units.destroyer > 0
    : b.attack.destroyer > 0;
  if (hostileDD) {
    return fail('destroyer_present', 'Submarines cannot submerge with an enemy destroyer in the battle (1942 2e p.28).');
  }
  const eligible = side === 'attacker' ? b.attack.submarine : state.territories[b.territoryId].units.submarine;
  if (!Number.isInteger(count) || count < 0 || count > eligible) {
    return fail('bad_count', `Submerge count must be between 0 and ${eligible}.`);
  }
  if (side === 'attacker') {
    b.attack.submarine -= count;
    b.submergedA += count;
  } else {
    state.territories[b.territoryId].units.submarine -= count;
    b.submergedD += count;
  }
  b.subPhase = side === 'attacker' ? 'defender' : 'done';
  const who = side === 'attacker' ? state.players[b.attackerId].name : state.players[b.defenderId!].name;
  log(state, 'submerge', `${who} submerges ${count} submarine(s) in ${territoryId} instead of fighting.`);
  return { ok: true };
}


/** Hits broken down by scoring source, for the 1942 2e p.29 casualty rules:
 *  submarine hits can only sink sea units (never aircraft), and air-scored
 *  hits cannot sink submarines unless a friendly destroyer is in the battle. */
interface RollBreakdown {
  dice: number[];
  hits: number;
  subHits: number;
  airHits: number;
  otherHits: number;
}


function attackerRolls(state: GameState, atk: UnitCounts, excludeSubs: boolean): RollBreakdown {
  const dice: number[] = [];
  let subHits = 0;
  let airHits = 0;
  let otherHits = 0;
  const boosted = Math.min(atk.infantry, atk.artillery); // 1:1 artillery pairing
  for (let i = 0; i < atk.infantry; i++) {
    const v = i < boosted ? (UNITS.infantry.boostedAttack as number) : UNITS.infantry.attack;
    const d = rollDie(state);
    dice.push(d);
    if (d <= v) otherHits++;
  }
  const rest: Array<[UnitType, number, number, 'sub' | 'air' | 'other']> = [
    ['artillery', atk.artillery, UNITS.artillery.attack, 'other'],
    ['tank', atk.tank, UNITS.tank.attack, 'other'],
    ['fighter', atk.fighter, UNITS.fighter.attack, 'air'],
    ['bomber', atk.bomber, UNITS.bomber.attack, 'air'],
    ['submarine', excludeSubs ? 0 : atk.submarine, UNITS.submarine.attack, 'sub'],
    ['destroyer', atk.destroyer, UNITS.destroyer.attack, 'other'],
    ['cruiser', atk.cruiser, UNITS.cruiser.attack, 'other'],
    ['carrier', atk.carrier, UNITS.carrier.attack, 'other'],
    ['battleship', atk.battleship, UNITS.battleship.attack, 'other'],
  ];
  for (const [, n, v, src] of rest) {
    if (n <= 0 || v <= 0) continue; // transports have no combat value (1942 2e p.30)
    const r = rollHits(state, n, v);
    dice.push(...r.dice);
    if (src === 'sub') subHits += r.hits;
    else if (src === 'air') airHits += r.hits;
    else otherHits += r.hits;
  }
  return { dice, hits: subHits + airHits + otherHits, subHits, airHits, otherHits };
}


function defenderRolls(state: GameState, def: UnitCounts, excludeSubs: boolean): RollBreakdown {
  const dice: number[] = [];
  let subHits = 0;
  let airHits = 0;
  let otherHits = 0;
  const parts: Array<[number, number, 'sub' | 'air' | 'other']> = [
    [def.infantry, UNITS.infantry.defense, 'other'],
    [def.artillery, UNITS.artillery.defense, 'other'],
    [def.tank, UNITS.tank.defense, 'other'],
    [def.fighter, UNITS.fighter.defense, 'air'],
    [def.bomber, UNITS.bomber.defense, 'air'],
    [excludeSubs ? 0 : def.submarine, UNITS.submarine.defense, 'sub'],
    [def.destroyer, UNITS.destroyer.defense, 'other'],
    [def.cruiser, UNITS.cruiser.defense, 'other'],
    [def.carrier, UNITS.carrier.defense, 'other'],
    [def.battleship, UNITS.battleship.defense, 'other'],
  ];
  for (const [n, v, src] of parts) {
    if (n <= 0 || v <= 0) continue;
    const r = rollHits(state, n, v);
    dice.push(...r.dice);
    if (src === 'sub') subHits += r.hits;
    else if (src === 'air') airHits += r.hits;
    else otherHits += r.hits;
  }
  return { dice, hits: subHits + airHits + otherHits, subHits, airHits, otherHits };
}


/**
 * Apply submarine-scored hits immediately (1942 2e p.29): surprise-strike
 * casualties are removed before the general exchange with no return fire, and
 * in all cases submarines cannot hit air units — only sea units. Uses the
 * standard cheapest-first policy (transports last) restricted to sea units.
 */
function applySubHits(state: GameState, b: Battle, side: 'attacker' | 'defender', hits: number): void {
  if (hits <= 0) return;
  const seaOnly = (u: UnitCounts): UnitCounts => {
    const o = emptyUnits();
    for (const t of NAVAL_UNIT_TYPES) o[t] = u[t];
    return o;
  };
  if (side === 'defender') {
    const terr = state.territories[b.territoryId];
    const { removed, damaged } = autoCasualtyPolicy(
      seaOnly(terr.units),
      hits,
      undamagedBB(terr.units, b.damagedDefBB),
    );
    b.damagedDefBB += damaged;
    b.damagedDefBB = Math.max(0, b.damagedDefBB - Math.min(removed.battleship ?? 0, b.damagedDefBB));
    terr.units = subUnits(terr.units, removed);
    sinkTransportCargo(state, b, 'defender', removed.transport ?? 0);
    if (countUnits({ ...emptyUnits(), ...removed }) > 0 || damaged > 0) {
      log(state, 'casualties', `Submarine fire sinks ${describeUnits({ ...emptyUnits(), ...removed }, damaged)} (defender, ${b.territoryId}).`);
    }
  } else {
    const { removed, damaged } = autoCasualtyPolicy(
      seaOnly(b.attack),
      hits,
      undamagedBB(b.attack, b.damagedAttackBB),
    );
    b.damagedAttackBB += damaged;
    b.damagedAttackBB = Math.max(0, b.damagedAttackBB - Math.min(removed.battleship ?? 0, b.damagedAttackBB));
    b.attack = subUnits(b.attack, removed);
    sinkTransportCargo(state, b, 'attacker', removed.transport ?? 0);
    if (countUnits({ ...emptyUnits(), ...removed }) > 0 || damaged > 0) {
      log(state, 'casualties', `Submarine fire sinks ${describeUnits({ ...emptyUnits(), ...removed }, damaged)} (attacker, ${b.territoryId}).`);
    }
  }
}


function battleResult(state: GameState, b: Battle, extra?: Partial<CombatRoundResult>): CombatRoundResult {
  return {
    battleId: b.id,
    territoryId: b.territoryId,
    aaRolls: [],
    aaHits: 0,
    attackRolls: [],
    attackHits: 0,
    defenseRolls: [],
    defenseHits: 0,
    pendingAttacker: b.pendingAttacker,
    pendingDefender: b.pendingDefender,
    over: b.over,
    result: b.result,
    ...extra,
  };
}


export function resolveCombatRound(
  state: GameState,
  playerId: number,
  territoryId: string,
): ActionResult {
  const phaseErr = requirePhase(state, ['combat']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b) return fail('no_battle', `There is no open battle in ${territoryId}.`);
  if (b.attackerId !== playerId) return fail('not_attacker', 'Only the attacker resolves combat here.');
  if (b.pendingAttacker > 0 || b.pendingDefender > 0) {
    return fail('casualties_pending', 'Choose casualties before rolling another round.');
  }
  if (b.pendingDisembark) {
    return fail(
      'sea_battle_pending',
      `Resolve the sea battle in ${b.pendingDisembark.from} before fighting for ${territoryId}.`,
    );
  }

  // AA fire: once per battle, before the first exchange, at attacking aircraft.
  // Never at sea: AA guns cannot be in a sea zone (1942 2e p.27).
  const seaBattle = isSea(territoryId);
  let aaRolls: number[] = [];
  let aaHits = 0;
  if (!b.aaFired && !seaBattle) {
    b.aaFired = true;
    const aaCount = state.territories[territoryId].units.aa;
    const airCount = countAir(b.attack);
    if (aaCount > 0 && airCount > 0) {
      const r = rollHits(state, aaCount, 1);
      aaRolls = r.dice;
      aaHits = Math.min(r.hits, airCount);
      b.pendingAttacker += aaHits;
      b.attackerResolved = false;
      logEvent(state, 'aa_fire', `AA in ${territoryId} hits ${aaHits} aircraft (${aaRolls.join(',')}).`, {
        side: 'defense',
        dice: aaRolls,
        hits: aaHits,
      });
    }
  }

  if (b.kind === 'sbr') {
    if (!b.sbrStruck) {
      if (b.pendingAttacker > 0) {
        return { ok: true, combat: battleResult(state, b, { aaRolls, aaHits }) };
      }
      let damage = 0;
      const rolls: number[] = [];
      for (let i = 0; i < b.attack.bomber; i++) {
        const d = rollDie(state);
        rolls.push(d);
        damage += d;
      }
      // 1942 2e p.14: the rolled total becomes damage markers on the
      // target's industrial complex, NOT IPCs from the victim's bank. A
      // complex cannot carry more total damage than twice the IPC value
      // of its territory; any excess damage is not applied. Each marker
      // cuts the complex's mobilization capacity by one (p.21) until the
      // owner repairs it during a Purchase phase (p.10).
      const terr = state.territories[territoryId];
      const cap = 2 * ipcOf(territoryId);
      const before = terr.factoryDamage ?? 0;
      const applied = Math.min(damage, Math.max(0, cap - before));
      terr.factoryDamage = before + applied;
      b.sbrStruck = true;
      b.over = true;
      b.result = 'sbr_done';
      const truncated = applied < damage ? ` (${damage - applied} excess lost at the damage cap)` : '';
      logEvent(state, 'sbr', `${state.players[playerId].name} bombs ${territoryId} for ${damage} damage (${rolls.join(',')}): factory damage now ${terr.factoryDamage} of cap ${cap}${truncated}.`, {
        side: 'attack',
        dice: rolls,
        hits: damage,
      });
      return { ok: true, combat: battleResult(state, b, { aaRolls, aaHits, sbrDamage: damage }) };
    }
    return fail('no_battle', 'That raid is already over.');
  }

  const atk = battleResult(state, b);

  // Amphibious assault, step 2 (1942 2e p.15): battleship/cruiser bombardment.
  // Fires once, before the first land round, and only when no sea battle was
  // fought in the launch zone. Bombardment casualties still defend the first
  // land round, then are removed (tracked in b.bombardDoomed).
  let bombardRolls: number[] = [];
  let bombardHits = 0;
  if (!seaBattle && b.amphibiousFrom && !b.bombardDone && b.bombard) {
    b.bombardDone = true;
    const seaFight = state.battles.some(
      (x) => !x.over && x.territoryId === b.amphibiousFrom && isSea(x.territoryId),
    );
    const ships = b.bombard;
    if (!seaFight && (ships.battleship > 0 || ships.cruiser > 0)) {
      // Battleships hit on 4 or less, cruisers on 3 or less (p.15) — matching
      // their attack values, so UNITS attack profiles apply directly.
      const r1 = rollHits(state, ships.battleship, UNITS.battleship.attack);
      const r2 = rollHits(state, ships.cruiser, UNITS.cruiser.attack);
      bombardRolls = [...r1.dice, ...r2.dice];
      bombardHits = r1.hits + r2.hits;
      b.bombardDoomed = bombardHits;
      // Bombarding ships fought: they may not move in the non-combat phase.
      const buk = usedKey(b.amphibiousFrom, playerId);
      state.used[buk] = addUnits(state.used[buk] ?? emptyUnits(), {
        battleship: ships.battleship,
        cruiser: ships.cruiser,
      });
      logEvent(
        state,
        'bombard',
        `${state.players[playerId].name} bombards ${territoryId} from ${b.amphibiousFrom}: ${bombardHits} hit(s) (${bombardRolls.join(',')}).`,
        { side: 'attack', dice: bombardRolls, hits: bombardHits },
      );
    }
  }

  const a = { dice: [] as number[], hits: 0, subHits: 0, airHits: 0, otherHits: 0 };
  const d = { dice: [] as number[], hits: 0, subHits: 0, airHits: 0, otherHits: 0 };
  let surpriseARolls: number[] = [];
  let surpriseAHits = 0;
  let surpriseDRolls: number[] = [];
  let surpriseDHits = 0;
  // Subs that surprise-strike do not roll again in the general exchange.
  let subsFiredA = false;
  let subsFiredD = false;

  if (seaBattle && b.kind === 'combat') {
    // Submerge decisions precede all dice, attacker first (1942 2e p.29).
    const due = effectiveSubPhase(state, b);
    if (due !== 'done') {
      return fail(
        'submerge_pending',
        `${due === 'attacker' ? 'Attacker' : 'Defender'} must decide submarine submerges via submergeSubs before this round (1942 2e p.29).`,
      );
    }
    // Surprise strike (1942 2e p.29): subs on both sides fire before any other
    // units. Attacker subs roll first; their casualties are removed at once
    // and get no return fire. A destroyer cancels the enemy subs' strike (p.28).
    const terrNow = () => state.territories[territoryId].units;
    if (b.attack.submarine > 0 && terrNow().destroyer === 0) {
      subsFiredA = true;
      const r = rollHits(state, b.attack.submarine, UNITS.submarine.attack);
      surpriseARolls = r.dice;
      surpriseAHits = r.hits;
      applySubHits(state, b, 'defender', r.hits);
      logEvent(state, 'surprise', `Attacker subs surprise-strike in ${territoryId}: ${r.hits} hit(s) (${r.dice.join(',') || 'no dice'}).`, {
        side: 'attack',
        dice: r.dice,
        hits: r.hits,
      });
    }
    if (terrNow().submarine > 0 && b.attack.destroyer === 0) {
      subsFiredD = true;
      const r = rollHits(state, terrNow().submarine, UNITS.submarine.defense);
      surpriseDRolls = r.dice;
      surpriseDHits = r.hits;
      applySubHits(state, b, 'attacker', r.hits);
      logEvent(state, 'surprise', `Defender subs surprise-strike in ${territoryId}: ${r.hits} hit(s) (${r.dice.join(',') || 'no dice'}).`, {
        side: 'defense',
        dice: r.dice,
        hits: r.hits,
      });
    }
    // Surprise casualties get no return fire: a wiped side ends the battle now.
    if (countUnits(terrNow()) === 0 || countSea(b.attack) + countAir(b.attack) === 0) {
      evaluateBattleEnd(state, b);
      return {
        ok: true,
        combat: {
          ...battleResult(state, b),
          aaRolls,
          aaHits,
          attackRolls: a.dice,
          attackHits: a.hits,
          defenseRolls: d.dice,
          defenseHits: d.hits,
          pendingAttacker: b.pendingAttacker,
          pendingDefender: b.pendingDefender,
          over: b.over,
          result: b.result,
          bombardRolls,
          bombardHits,
          surpriseARolls,
          surpriseAHits,
          surpriseDRolls,
          surpriseDHits,
        },
      };
    }
  }

  // General exchange. Every unit fires simultaneously, so both sides' rolls
  // are computed before any casualties are applied.
  const ga = attackerRolls(state, b.attack, subsFiredA);
  const gd = defenderRolls(state, state.territories[territoryId].units, subsFiredD);
  a.dice = ga.dice; a.hits = ga.hits; a.airHits = ga.airHits; a.otherHits = ga.otherHits;
  d.dice = gd.dice; d.hits = gd.hits; d.airHits = gd.airHits; d.otherHits = gd.otherHits;
  // Submarine-scored hits can only sink sea units, never aircraft (1942 2e
  // p.29): applied immediately to sea units. (Deliberate simplification: the
  // owner does not choose which sea units these sink; cheapest-first applies.)
  applySubHits(state, b, 'defender', ga.subHits);
  applySubHits(state, b, 'attacker', gd.subHits);
  b.rounds++;
  b.pendingAttacker += d.airHits + d.otherHits;
  b.pendAtkAir = d.airHits;
  b.pendingDefender += a.airHits + a.otherHits;
  b.pendDefAir = a.airHits;
  b.attackerResolved = b.pendingAttacker === 0;
  b.defenderResolved = b.pendingDefender === 0;
  logEvent(state, 'combat_round', `${state.players[playerId].name} vs ${territoryId} round ${b.rounds}: attack ${a.hits}, defense ${d.hits}.`, {
    side: 'attack',
    dice: a.dice,
    hits: a.hits,
  });
  logEvent(state, 'combat_round', `${territoryId} defends round ${b.rounds}: ${d.hits} hits.`, {
    side: 'defense',
    dice: d.dice,
    hits: d.hits,
  });

  // Neutral garrisons never choose: apply the auto policy immediately.
  if (b.defenderId === null && b.pendingDefender > 0) {
    const { removed } = autoCasualtyPolicy(state.territories[territoryId].units, b.pendingDefender);
    state.territories[territoryId].units = subUnits(state.territories[territoryId].units, removed);
    log(state, 'casualties', `Neutral garrison in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...removed })}.`);
    b.pendingDefender = 0;
    b.defenderResolved = true;
  }

  if (b.attackerResolved && b.defenderResolved) {
    applyBombardDoom(state, b);
    evaluateBattleEnd(state, b);
  }
  return {
    ok: true,
    combat: {
      ...atk,
      aaRolls,
      aaHits,
      attackRolls: a.dice,
      attackHits: a.hits,
      defenseRolls: d.dice,
      defenseHits: d.hits,
      pendingAttacker: b.pendingAttacker,
      pendingDefender: b.pendingDefender,
      over: b.over,
      result: b.result,
      bombardRolls,
      bombardHits,
      surpriseARolls,
      surpriseAHits,
      surpriseDRolls,
      surpriseDHits,
    },
  };
}


/**
 * Cheapest first; transports last (1942 2e p.30); AA never (captured instead).
 * Undamaged battleships absorb hits first: the first hit damages rather than
 * destroying (1942 2e p.27). `undamagedBB` is the force's battleships minus
 * those already damaged in this combat.
 *
 * `airHits`: hits in this batch scored by air units. 1942 2e p.29 — they
 * cannot be assigned to submarines (the caller passes 0 when a friendly
 * destroyer cancelled that rule, p.28). They are satisfied from non-sub
 * units first; any excess is lost.
 */
export function autoCasualtyPolicy(
  force: UnitCounts,
  hits: number,
  undamagedBB = 0,
  blockedAirHits = 0,
): { removed: Partial<UnitCounts>; damaged: number } {
  const damaged = Math.min(hits, undamagedBB);
  let left = hits - damaged;
  // Blocked air hits (air vs subs without a friendly destroyer, 1942 2e p.29)
  // cannot be assigned at all and are lost.
  left -= Math.min(blockedAirHits, left);
  const order: UnitType[] = [
    'infantry',
    'artillery',
    'tank',
    'submarine',
    'destroyer',
    'fighter',
    'bomber',
    'cruiser',
    'carrier',
    'battleship',
    'transport',
  ];
  const removed: Partial<UnitCounts> = {};
  const pool: UnitCounts = { ...force };
  left = Math.min(left, countUnits({ ...pool, aa: 0 }));
  const takeCheapest = (n: number): void => {
    let need = n;
    for (const t of order) {
      if (need <= 0) break;
      const take = Math.min(pool[t], need);
      if (take > 0) {
        removed[t] = (removed[t] ?? 0) + take;
        pool[t] -= take;
        need -= take;
      }
    }
  };
  takeCheapest(left);
  return { removed, damaged };
}


/**
 * Split dialed battleship casualties into newly-damaged vs destroyed
 * (1942 2e p.27): each dialed BB absorbs one hit; undamaged ones are damaged,
 * already-damaged ones are destroyed by the second hit in the same combat.
 */
function splitBBCasualties(
  force: UnitCounts,
  damaged: number,
  dialedBB: number,
): { newlyDamaged: number; destroyed: number } {
  const newlyDamaged = Math.min(dialedBB, undamagedBB(force, damaged));
  return { newlyDamaged, destroyed: dialedBB - newlyDamaged };
}


/** Apply battleship damage/destruction from a casualty selection. Mutates `b`'s
 *  damage counters and returns the units to actually remove from the force. */
function applyBBCasualties(
  b: Battle,
  side: 'attacker' | 'defender',
  force: UnitCounts,
  units: Partial<UnitCounts>,
): Partial<UnitCounts> {
  const dialedBB = units.battleship ?? 0;
  if (dialedBB === 0) return units;
  const damagedKey = side === 'attacker' ? 'damagedAttackBB' : 'damagedDefBB';
  const { newlyDamaged, destroyed } = splitBBCasualties(force, b[damagedKey], dialedBB);
  b[damagedKey] += newlyDamaged;
  b[damagedKey] = Math.max(0, b[damagedKey] - destroyed);
  return { ...units, battleship: destroyed };
}


function validateCasualtySelection(
  force: UnitCounts,
  pending: number,
  units: Partial<UnitCounts>,
  airVsSub?: { airHits: number; blocked: boolean },
): ActionResult | null {
  if (!validCounts(units)) return fail('bad_count', 'Casualty counts must be non-negative integers.');
  if ((units.aa ?? 0) > 0) return fail('aa_spared', 'AA guns are captured, never taken as casualties.');
  if (!hasEnough(force, units)) return fail('too_few_units', 'You cannot lose units you do not have.');
  const selected = countUnits({ ...emptyUnits(), ...units });
  const required = Math.min(pending, countUnits({ ...force, aa: 0 }));
  if (selected !== required) {
    return fail('bad_casualties', `You must remove exactly ${required} unit(s) (${pending} hits).`);
  }
  // 1942 2e p.29: air-scored hits cannot sink submarines unless a destroyer
  // friendly to the air units is in the battle (caller sets blocked=false then).
  if (airVsSub?.blocked && (units.submarine ?? 0) > 0) {
    const maxSub = Math.max(0, required - airVsSub.airHits);
    if ((units.submarine ?? 0) > maxSub) {
      return fail(
        'air_vs_sub',
        `At most ${maxSub} submarine(s) can be lost here: air-scored hits cannot sink subs without a friendly destroyer in the battle (1942 2e p.29).`,
      );
    }
  }
  return null;
}


/**
 * 1942 2e p.29 air-vs-submarine casualty constraint for a pending pool:
 * returns the air-scored hits that are blocked from sinking subs, or 0 when
 * the rule doesn't apply (not a sea battle, no subs, no air, or the scorer
 * has a destroyer in the battle per p.28).
 */
function airVsSubBlocked(
  state: GameState,
  b: Battle,
  scorer: 'attacker' | 'defender',
  airHits: number,
): number {
  if (!isSea(b.territoryId) || b.kind !== 'combat' || airHits <= 0) return 0;
  const scorerForce = scorer === 'attacker' ? b.attack : state.territories[b.territoryId].units;
  const targetForce = scorer === 'attacker' ? state.territories[b.territoryId].units : b.attack;
  if (targetForce.submarine === 0) return 0;
  if (countAir(scorerForce) === 0) return 0;
  if (scorerForce.destroyer > 0) return 0; // p.28: destroyer cancels the rule
  return airHits;
}


export function chooseCasualties(
  state: GameState,
  playerId: number,
  territoryId: string,
  side: 'attacker' | 'defender',
  units: Partial<UnitCounts>,
): ActionResult {
  const phaseErr = requirePhase(state, ['combat']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b) return fail('no_battle', `There is no open battle in ${territoryId}.`);
  if (side === 'attacker') {
    if (b.attackerId !== playerId) return fail('not_attacker', 'Only the attacker chooses attacker casualties.');
    if (b.pendingAttacker === 0 || b.attackerResolved) return fail('none_pending', 'No attacker casualties pending.');
    const airBlocked = airVsSubBlocked(state, b, 'defender', b.pendAtkAir);
    const bad = validateCasualtySelection(b.attack, b.pendingAttacker, units, {
      airHits: b.pendAtkAir,
      blocked: airBlocked > 0,
    });
    if (bad) return bad;
    const toRemove = applyBBCasualties(b, 'attacker', b.attack, units);
    b.attack = subUnits(b.attack, toRemove);
    sinkTransportCargo(state, b, 'attacker', toRemove.transport ?? 0);
    b.pendingAttacker = 0;
    b.pendAtkAir = 0;
    b.attackerResolved = true;
    log(
      state,
      'casualties',
      `Attacker in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...toRemove }, b.damagedAttackBB)}.`,
    );
  } else {
    if (b.defenderId === null) return fail('auto', 'Neutral casualties are applied automatically.');
    if (b.pendingDefender === 0 || b.defenderResolved) return fail('none_pending', 'No defender casualties pending.');
    const def = state.territories[territoryId].units;
    const airBlocked = airVsSubBlocked(state, b, 'attacker', b.pendDefAir);
    const bad = validateCasualtySelection(def, b.pendingDefender, units, {
      airHits: b.pendDefAir,
      blocked: airBlocked > 0,
    });
    if (bad) return bad;
    const toRemove = applyBBCasualties(b, 'defender', def, units);
    state.territories[territoryId].units = subUnits(def, toRemove);
    sinkTransportCargo(state, b, 'defender', toRemove.transport ?? 0);
    b.pendingDefender = 0;
    b.pendDefAir = 0;
    b.defenderResolved = true;
    log(
      state,
      'casualties',
      `Defender in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...toRemove }, b.damagedDefBB)}.`,
    );
  }
  if (b.attackerResolved && b.defenderResolved) {
    applyBombardDoom(state, b);
    evaluateBattleEnd(state, b);
  }
  return { ok: true };
}


export function autoCasualties(
  state: GameState,
  playerId: number,
  territoryId: string,
  side: 'attacker' | 'defender',
): ActionResult {
  const phaseErr = requirePhase(state, ['combat']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b) return fail('no_battle', `There is no open battle in ${territoryId}.`);
  if (side === 'attacker') {
    if (b.attackerId !== playerId) return fail('not_attacker', 'Only the attacker applies attacker casualties.');
    if (b.pendingAttacker === 0 || b.attackerResolved) return fail('none_pending', 'No attacker casualties pending.');
    const { removed, damaged } = autoCasualtyPolicy(
      b.attack,
      b.pendingAttacker,
      undamagedBB(b.attack, b.damagedAttackBB),
      airVsSubBlocked(state, b, 'defender', b.pendAtkAir),
    );
    b.damagedAttackBB += damaged;
    b.damagedAttackBB = Math.max(0, b.damagedAttackBB - Math.min(removed.battleship ?? 0, b.damagedAttackBB));
    b.attack = subUnits(b.attack, removed);
    sinkTransportCargo(state, b, 'attacker', removed.transport ?? 0);
    b.pendingAttacker = 0;
    b.pendAtkAir = 0;
    b.attackerResolved = true;
    log(
      state,
      'casualties',
      `Attacker in ${territoryId} auto-loses ${describeUnits({ ...emptyUnits(), ...removed }, b.damagedAttackBB)}.`,
    );
  } else {
    if (b.pendingDefender === 0 || b.defenderResolved) return fail('none_pending', 'No defender casualties pending.');
    const def = state.territories[territoryId].units;
    const { removed, damaged } = autoCasualtyPolicy(
      def,
      b.pendingDefender,
      undamagedBB(def, b.damagedDefBB),
      airVsSubBlocked(state, b, 'attacker', b.pendDefAir),
    );
    b.damagedDefBB += damaged;
    b.damagedDefBB = Math.max(0, b.damagedDefBB - Math.min(removed.battleship ?? 0, b.damagedDefBB));
    state.territories[territoryId].units = subUnits(def, removed);
    sinkTransportCargo(state, b, 'defender', removed.transport ?? 0);
    b.pendingDefender = 0;
    b.pendDefAir = 0;
    b.defenderResolved = true;
    log(
      state,
      'casualties',
      `Defender in ${territoryId} auto-loses ${describeUnits({ ...emptyUnits(), ...removed }, b.damagedDefBB)}.`,
    );
  }
  if (b.attackerResolved && b.defenderResolved) {
    applyBombardDoom(state, b);
    evaluateBattleEnd(state, b);
  }
  return { ok: true };
}


/** Remove bombardment-doomed defenders after the first land round's own
 *  casualties resolve (1942 2e p.15: they defend first, then die). */
function applyBombardDoom(state: GameState, b: Battle): void {
  if (!b.bombardDoomed || b.bombardDoomed <= 0) return;
  const terr = state.territories[b.territoryId];
  const doomed = Math.min(b.bombardDoomed, countUnits({ ...terr.units, aa: 0 }));
  if (doomed > 0) {
    const { removed } = autoCasualtyPolicy(terr.units, doomed, undamagedBB(terr.units, b.damagedDefBB));
    terr.units = subUnits(terr.units, removed);
    b.damagedDefBB = Math.max(0, b.damagedDefBB - (removed.battleship ?? 0));
    log(state, 'bombard', `Bombardment claims ${describeUnits({ ...emptyUnits(), ...removed })} in ${b.territoryId}.`);
  }
  b.bombardDoomed = 0;
}


/**
 * Settle amphibious assaults that launched from a contested sea zone (1942 2e
 * p.15: sea battle first, then the offload). Called when a sea battle ends.
 * If the attacker cleared the zone, the earmarked cargo comes ashore into the
 * land battle. Otherwise the assault fizzles: cargo stays aboard retreating
 * transports, or died with them (sinkTransportCargo already handled that).
 * Land battles left with no attackers at all are removed.
 */
function settleAmphibiousAfterSeaBattle(state: GameState, zid: string, attackerWon: boolean): void {
  for (let i = state.battles.length - 1; i >= 0; i--) {
    const b = state.battles[i];
    if (b.over || !b.pendingDisembark || b.amphibiousFrom !== zid) continue;
    const pd = b.pendingDisembark;
    b.pendingDisembark = undefined;
    if (attackerWon) {
      const have = cargoOf(state.territories, zid, b.attackerId);
      const take: Partial<UnitCounts> = {};
      for (const t of CARGO_TYPES) take[t] = Math.min(pd.units[t], have[t]);
      if (countUnits({ ...emptyUnits(), ...take }) > 0) {
        const err = disembarkUnits(state.territories, zid, b.attackerId, take);
        if (!err) {
          b.attack = addUnits(b.attack, take);
          b.seaborne = addUnits(b.seaborne ?? emptyUnits(), take);
          log(state, 'amphibious', `${state.players[b.attackerId].name} offloads into ${b.territoryId} after clearing ${zid}.`);
        }
      }
    }
    if (countUnits(b.attack) === 0) {
      state.battles.splice(i, 1);
      log(state, 'amphibious', `Amphibious assault on ${b.territoryId} fizzles after the sea battle in ${zid}.`);
    }
  }
}


/**
 * 1942 2e (fighter "Land on Aircraft Carriers"): a fighter based on a
 * defending carrier must land on the same carrier if possible after the
 * battle. If that carrier was destroyed in combat, the fighter must try to
 * land elsewhere: a different friendly carrier in the same sea zone (already
 * counted — the excess is beyond all of them), then one space to a friendly
 * territory or carrier, or be destroyed.
 *
 * Auto-resolved here at battle end (documented simplification: the board
 * game has the owning player land them in the non-combat phase before other
 * moves; the priority order is identical).
 */
function settleDisplacedFighters(state: GameState, zid: string, defenderId: number | null): void {
  if (defenderId === null || !isSea(zid)) return;
  const z = state.territories[zid];
  if (z.owner !== defenderId) return;
  const keep = CARRIER_FIGHTERS * z.units.carrier;
  const excess = z.units.fighter - keep;
  if (excess <= 0) return;
  const me = state.players[defenderId].name;
  let placed = 0;
  // One space to a friendly land territory (no capacity limit ashore).
  for (const n of neighborsOf(zid)) {
    if (placed >= excess) break;
    if (!isLand(n) || state.territories[n].owner !== defenderId) continue;
    state.territories[n].units.fighter += excess - placed;
    placed = excess;
    log(state, 'carrier_land', `${me} lands ${excess} displaced fighter(s) in ${n} after losing a carrier in ${zid} (1942 2e).`);
  }
  // One space to a friendly carrier with spare capacity in an adjacent zone.
  for (const n of neighborsOf(zid)) {
    if (placed >= excess) break;
    if (!isSea(n)) continue;
    const move = Math.min(excess - placed, Math.max(0, carrierSpare(state.territories, n, defenderId)));
    if (move <= 0) continue;
    addPlayerSeaUnits(state.territories, n, defenderId, { fighter: move });
    placed += move;
    log(state, 'carrier_land', `${me} lands ${move} displaced fighter(s) on a carrier in ${n} after losing a carrier in ${zid} (1942 2e).`);
  }
  z.units.fighter = keep;
  const destroyed = excess - placed;
  if (destroyed > 0) {
    log(state, 'stranded', `${destroyed} fighter(s) had no carrier or friendly territory within reach and are lost (1942 2e).`);
  }
}


function evaluateBattleEnd(state: GameState, b: Battle): void {
  const terr = state.territories[b.territoryId];

  // Sea battle (1942 2e pp.27-30): no capture mechanics — the attacker seizes
  // the zone by clearing it. Surviving damaged battleships on either side are
  // repaired when the combat ends (p.27). Submerged subs return: to the zone
  // (attacker's, if it seizes it) or as coexisting foreigners.
  if (isSea(b.territoryId)) {
    const returnSubmerged = (attackerWon: boolean): void => {
      // The victor's subs resurface into the zone; the loser's lurk submerged
      // as coexisting foreigners (1942 2e p.29).
      if (attackerWon) {
        if (b.submergedA > 0) {
          terr.units = addUnits(terr.units, { submarine: b.submergedA });
          b.submergedA = 0;
        }
        if (b.submergedD > 0 && b.defenderId !== null) {
          terr.coexist = [
            ...(terr.coexist ?? []),
            { owner: b.defenderId, units: { ...emptyUnits(), submarine: b.submergedD } },
          ];
          b.submergedD = 0;
        } else {
          b.submergedD = 0;
        }
      } else {
        if (b.submergedD > 0) {
          terr.units = addUnits(terr.units, { submarine: b.submergedD });
          b.submergedD = 0;
        }
        if (b.submergedA > 0) {
          terr.coexist = [
            ...(terr.coexist ?? []),
            { owner: b.attackerId, units: { ...emptyUnits(), submarine: b.submergedA } },
          ];
          b.submergedA = 0;
        }
      }
      normalizeSeaZone(state.territories, b.territoryId);
    };
    const defForce = countUnits(terr.units);
    const atkSea = countSea(b.attack);
    const atkAir = countAir(b.attack);
    if (defForce === 0) {
      if (atkSea > 0) {
        const sea: Partial<UnitCounts> = {};
        for (const t of NAVAL_UNIT_TYPES) sea[t] = b.attack[t];
        terr.units = addUnits(terr.units, sea);
        b.attack = subUnits(b.attack, sea);
        terr.owner = b.attackerId;
        b.damagedAttackBB = 0;
        b.damagedDefBB = 0;
        returnSubmerged(true);
        settleAmphibiousAfterSeaBattle(state, b.territoryId, true);
        b.over = true;
        b.result = 'sea_taken';
        log(state, 'battle_end', `${state.players[b.attackerId].name} seizes ${b.territoryId}.`);
      } else {
        returnSubmerged(false);
        settleAmphibiousAfterSeaBattle(state, b.territoryId, false);
        b.over = true;
        b.result = 'air_only';
        log(state, 'battle_end', `Only aircraft survive over ${b.territoryId}; they must land.`);
      }
      b.pendingAttacker = 0;
      b.pendingDefender = 0;
      b.pendAtkAir = 0;
      b.pendDefAir = 0;
      return;
    }
    if (atkSea + atkAir === 0) {
      b.damagedAttackBB = 0;
      b.damagedDefBB = 0;
      returnSubmerged(false);
      settleAmphibiousAfterSeaBattle(state, b.territoryId, false);
      settleDisplacedFighters(state, b.territoryId, b.defenderId);
      b.over = true;
      b.result = 'defender_holds';
      b.pendingAttacker = 0;
      b.pendingDefender = 0;
      b.pendAtkAir = 0;
      b.pendDefAir = 0;
      log(state, 'battle_end', `${b.territoryId} holds against the attack.`);
      return;
    }
    // Both sides live on: reset for the next round.
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
    b.pendAtkAir = 0;
    b.pendDefAir = 0;
    b.attackerResolved = true;
    b.defenderResolved = true;
    b.subPhase = 'attacker';
    return;
  }

  const defNoAA = countUnits({ ...terr.units, aa: 0 });
  const atkLand = countLand(b.attack);
  const atkTotal = countUnits(b.attack);

  if (defNoAA === 0) {
    b.damagedAttackBB = 0;
    b.damagedDefBB = 0;
    if (atkLand > 0) {
      // Capture: surviving land stays; AA and factory transfer; air must still land.
      const land: Partial<UnitCounts> = {
        infantry: b.attack.infantry,
        artillery: b.attack.artillery,
        tank: b.attack.tank,
      };
      terr.units = addUnits(terr.units, land);
      b.attack = subUnits(b.attack, land);
      const prevOwner = terr.owner;
      resolveCapture(state, b.territoryId, b.attackerId, prevOwner);
      b.over = true;
      b.result = 'captured';
      log(state, 'battle_end', `${state.players[b.attackerId].name} captures ${b.territoryId}.`);
    } else {
      b.over = true;
      b.result = 'air_only';
      log(state, 'battle_end', `Only aircraft survive over ${b.territoryId}; no capture. They must land.`);
    }
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
    return;
  }
  if (atkTotal === 0) {
    b.damagedAttackBB = 0;
    b.damagedDefBB = 0;
    b.over = true;
    b.result = 'defender_holds';
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
    log(state, 'battle_end', `${b.territoryId} holds against the attack.`);
    return;
  }
  // Both sides live on: reset for the next round.
  b.pendingAttacker = 0;
  b.pendingDefender = 0;
  b.attackerResolved = true;
  b.defenderResolved = true;
}


// ----------------------------------------------------------------- capture ---

/**
 * Apply the consequences of `captorId` taking `terrId` from `prevOwner`:
 * ownership transfer, capital bank transfer, elimination, and win check.
 * The caller moves surviving units; this handles everything else.
 */
export function resolveCapture(
  state: GameState,
  terrId: string,
  captorId: number,
  prevOwner: number | null,
): void {
  const terr = state.territories[terrId];
  terr.owner = captorId;
  if (terr.factory) terr.factoryFresh = true;
  const captor = state.players[captorId];
  if (prevOwner === null || prevOwner === captorId) {
    log(state, 'capture', `${captor.name} captures neutral ${terrId}.`);
    return;
  }
  const victim = state.players[prevOwner];
  let detail = `${captor.name} captures ${terrId} from ${victim.name}.`;
  // Capturing ANY of the victim's capitals triggers the bank steal — for a
  // multi-capital seat (1942 seat 3) taking Washington steals the seat's
  // bank just as taking London does.
  if (capitalsOf(state, prevOwner).includes(terrId)) {
    captor.ipcs += victim.ipcs;
    detail += ` Capital taken! ${victim.ipcs} IPCs transfer to ${captor.name}.`;
    victim.ipcs = 0;
  }
  log(state, 'capture', detail);
  // Ships alone do not keep a player alive: elimination counts land only.
  const landLeft = landTerritoryIds().filter((t) => state.territories[t]?.owner === prevOwner).length;
  if (landLeft === 0) {
    victim.alive = false;
    log(state, 'eliminate', `${victim.name} is eliminated (no territories left).`);
  }
  checkWinByCapitals(state);
}


function checkWinByCapitals(state: GameState): void {
  // FFA project decision (Oct 3 2026): Majority of capitals held simultaneously wins.
  // For 4 players: 3 of 4. Scenario/map may override via capitalsToWin.
  // The count runs over the union of all seats' capitals — on the 1942
  // board that is five capitals (seat 3 owns two of them), so a majority
  // is 3 of 5 there.
  const holders = new Map<number, number>();
  const allCapitals = new Set(state.players.flatMap((p) => capitalsOf(state, p.id)));
  for (const cap of allCapitals) {
    const holder = state.territories[cap]?.owner;
    if (holder !== null && holder !== undefined) {
      holders.set(holder, (holders.get(holder) ?? 0) + 1);
    }
  }
  for (const [holder, count] of holders) {
    if (count >= state.capitalsToWin) {
      state.winner = holder;
      state.winReason = 'majority_capitals';
      state.phase = 'gameover';
      log(state, 'game_over', `${state.players[holder].name} controls ${count} capitals and wins!`);
      return;
    }
  }
}


/**
 * Victory cities (1942 2e standard victory, rulebook p.6): a side wins by
 * controlling 3 more victory cities than it started with (Axis 9, Allies
 * 10), checked "at the end of a complete round of play". The FFA deals the
 * +3 out per seat (scenario victoryCitiesToWin), and this check runs ONLY
 * at round end, from endPhase's turn wrap: a seat that crosses its target
 * mid-round but loses a city before the round ends does not win. Unlike
 * the capitals check above this is not a capture-time check, so it lives
 * here for symmetry but is called from actions.ts.
 *
 * Simultaneous qualifiers (possible when one seat's captures hand another
 * seat its target in the same round): the seat holding MORE victory
 * cities wins; still tied, the seat earlier in turn order wins.
 * Returns true when the game ended.
 */
export function checkWinByVictoryCities(state: GameState): boolean {
  const targets = state.victoryCitiesToWin;
  if (!targets || state.phase === 'gameover' || state.winner !== null) return false;
  const counts = state.players.map((p) => victoryCitiesHeld(state, p.id));
  const qualified = state.players
    .filter((p) => p.alive && counts[p.id] >= (targets[p.id] ?? Number.POSITIVE_INFINITY))
    .map((p) => p.id);
  if (qualified.length === 0) return false;
  qualified.sort(
    (a, b) => counts[b] - counts[a] || state.turnOrder.indexOf(a) - state.turnOrder.indexOf(b),
  );
  const winner = qualified[0];
  state.winner = winner;
  state.winReason = 'victory_cities';
  state.phase = 'gameover';
  log(
    state,
    'game_over',
    `${state.players[winner].name} holds ${counts[winner]} victory cities (target ${targets[winner]}) at the end of round ${state.round} and wins!`,
  );
  return true;
}


export function retreat(
  state: GameState,
  playerId: number,
  territoryId: string,
  toId: string,
): ActionResult {
  const phaseErr = requirePhase(state, ['combat']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  const b = state.battles.find((x) => x.territoryId === territoryId && !x.over);
  if (!b) return fail('no_battle', `There is no open battle in ${territoryId}.`);
  if (b.attackerId !== playerId) return fail('not_attacker', 'Only the attacker can retreat.');
  if (b.kind !== 'combat') return fail('no_retreat', 'Bombing raids cannot retreat; they leave after the strike.');
  if (b.rounds < 1) return fail('no_rounds', 'You must fight at least one round before retreating.');
  if (b.pendingAttacker > 0 || b.pendingDefender > 0) {
    return fail('casualties_pending', 'Choose casualties before retreating.');
  }
  if (b.pendingDisembark) {
    return fail(
      'sea_battle_pending',
      `Resolve the sea battle in ${b.pendingDisembark.from} before retreating from ${territoryId}.`,
    );
  }
  if (!b.origins.includes(toId)) return fail('bad_retreat', 'Units retreat to a territory they attacked from.');
  // Warships may withdraw into the open waters they sailed from: a sea zone
  // emptied by the attack itself reverts to owner null (1942 2e p.27).
  const destOwner = state.territories[toId]?.owner;
  const seaOpenWaterRetreat = isSea(territoryId) && isSea(toId) && destOwner === null;
  if (destOwner !== playerId && !seaOpenWaterRetreat) {
    return fail('bad_retreat', 'The retreat destination must still be yours.');
  }

  // Sea battle: warships withdraw to a friendly sea origin; cargo rides along.
  // Aircraft stay aloft and must land in the non-combat phase. Submerged
  // attacker subs withdraw with the fleet; the defender's resurface (p.29).
  if (isSea(territoryId)) {
    if (!isSea(toId)) return fail('bad_retreat', 'Warships retreat to a sea zone they attacked from.');
    const sea: Partial<UnitCounts> = {};
    for (const t of NAVAL_UNIT_TYPES) sea[t] = b.attack[t];
    state.territories[toId].units = addUnits(state.territories[toId].units, sea);
    if (b.submergedA > 0) {
      state.territories[toId].units = addUnits(state.territories[toId].units, { submarine: b.submergedA });
      b.submergedA = 0;
    }
    if (b.submergedD > 0) {
      state.territories[territoryId].units = addUnits(state.territories[territoryId].units, {
        submarine: b.submergedD,
      });
      b.submergedD = 0;
    }
    normalizeSeaZone(state.territories, toId);
    normalizeSeaZone(state.territories, territoryId);
    carryCargoAlong(state.territories, territoryId, toId, playerId, sea.transport ?? 0);
    settleDisplacedFighters(state, territoryId, b.defenderId);
    state.used[usedKey(toId, playerId)] = addUnits(state.used[usedKey(toId, playerId)] ?? emptyUnits(), sea);
    b.attack = subUnits(b.attack, sea);
    b.over = true;
    b.result = 'retreated';
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
    b.pendAtkAir = 0;
    b.pendDefAir = 0;
    settleAmphibiousAfterSeaBattle(state, territoryId, false);
    log(state, 'retreat', `${state.players[playerId].name} withdraws from ${territoryId} to ${toId}. Aircraft must still land.`);
    return { ok: true };
  }

  // Amphibious assault (1942 2e p.15): seaborne units cannot retreat. Overland
  // units may withdraw; if seaborne troops remain, the battle stays open.
  const seaborne = b.seaborne ?? emptyUnits();
  const seaborneLand = countLand(seaborne);
  if (b.amphibiousFrom && seaborneLand > 0) {
    if (toId === b.amphibiousFrom) {
      return fail('bad_retreat', 'Seaborne units cannot retreat (1942 2e p.15).');
    }
    const overland: Partial<UnitCounts> = {
      infantry: Math.max(0, b.attack.infantry - seaborne.infantry),
      artillery: Math.max(0, b.attack.artillery - seaborne.artillery),
      tank: Math.max(0, b.attack.tank - seaborne.tank),
    };
    state.territories[toId].units = addUnits(state.territories[toId].units, overland);
    state.used[toId] = addUnits(state.used[toId] ?? emptyUnits(), overland);
    b.attack = subUnits(b.attack, overland);
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
    if (countLand(b.attack) === 0 && countAir(b.attack) === 0) {
      b.over = true;
      b.result = 'retreated';
    }
    log(state, 'retreat', `${state.players[playerId].name} withdraws overland units from ${territoryId} to ${toId}; seaborne troops fight on.`);
    return { ok: true };
  }

  const land: Partial<UnitCounts> = {
    infantry: b.attack.infantry,
    artillery: b.attack.artillery,
    tank: b.attack.tank,
  };
  state.territories[toId].units = addUnits(state.territories[toId].units, land);
  state.used[toId] = addUnits(state.used[toId] ?? emptyUnits(), land);
  b.attack = subUnits(b.attack, land);
  b.over = true;
  b.result = 'retreated';
  b.pendingAttacker = 0;
  b.pendingDefender = 0;
  log(state, 'retreat', `${state.players[playerId].name} retreats from ${territoryId} to ${toId}. Aircraft must still land.`);
  return { ok: true };
}
