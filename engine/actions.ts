/**
 * engine/actions.ts — The six game phases plus game setup: createGame, purchase, combatMove, nonCombatMove, mobilize, endPhase.
 */
import { AIR_UNIT_TYPES, CARGO_TYPES, LAND_UNIT_TYPES, addUnits, countAir, countLand, countSea, countUnits, describeUnits, emptyUnits, hasEnough, subUnits, validCounts } from './units';
import { DEFAULT_TURN_CAP, PLAYER_COLORS, fail, incomeOf, log, openBattles, ownedTerritories, ownsCapital, requireCurrentAlive, requirePhase, shuffle, usedKey } from './core';
import { CARRIER_FIGHTERS, addPlayerSeaUnits, arriveSeaZone, cargoOf, carrierSpare, carryCargoAlong, consolidateDefender, destroyCargo, disembarkUnits, embarkUnits, findDestroyerIntercept, hasHostileDestroyer, hasSurfaceWarships, landingOptions, movePower, normalizeSeaZone, playerCarrierForce, playerSeaForce, removeSeaUnits, seaZoneForces, seaZoneHostileTo } from './naval';
import { resolveCapture } from './combat';
import { ALL_UNIT_TYPES, NAVAL_UNIT_TYPES, UNITS, activeMapId, airDistance, areAdjacent, ipcOf, isSea, landPaths, landTerritoryIds, scenarioFor, seaReachable, seaZoneIds, territoryDef } from '../data/data';
import type { UnitType } from '../data/data';
import type { ActionResult, CombatMove, GameState, MobilizePlacement, NonCombatMove, PurchaseItem, TerritoryState, UnitCounts } from './types';


// ----------------------------------------------------------------- setup ---

export interface CreateGameOptions {
  numPlayers: number;
  playerNames?: string[];
  seed?: number;
}


export function createGame(opts: CreateGameOptions): GameState {
  const { numPlayers } = opts;
  if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new Error('numPlayers must be 2, 3, or 4');
  }
  const scenario = scenarioFor(numPlayers);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const state: GameState = {
    version: 3,
    mapId: activeMapId(),
    seed,
    rngState: seed >>> 0,
    numPlayers,
    turnOrder: [],
    orderIndex: 0,
    round: 1,
    players: [],
    territories: {},
    currentPlayer: 0,
    phase: 'purchase',
    purchased: {},
    ownedAtTurnStart: [],
    turnStartFactories: [],
    used: {},
    battles: [],
    nextBattleId: 1,
    turnCap: DEFAULT_TURN_CAP,
    capitalsToWin: scenario.capitalsToWin ?? (Math.floor(numPlayers / 2) + 1),
    winner: null,
    winReason: null,
    events: [],
    chatLog: [],
  };

  const names = opts.playerNames ?? [];
  for (let i = 0; i < numPlayers; i++) {
    state.players.push({
      id: i,
      name: names[i] || `Player ${i + 1}`,
      color: PLAYER_COLORS[i],
      alive: true,
      ipcs: scenario.banks[i] ?? 0,
      capital: scenario.capitals[i],
    });
  }
  state.turnOrder = shuffle(state, state.players.map((p) => p.id));

  /** Sea holdings validated in the loop below; placed after the sea zones
   *  are initialized (1942 scenario starting fleets). */
  const seaHoldings: Array<{ territory: string; owner: number; units: UnitCounts }> = [];

  const covered = new Set<string>();
  for (const h of scenario.holdings) {
    const def = territoryDef(h.territory);
    if (!def) throw new Error(`Scenario references unknown territory "${h.territory}".`);
    if (h.owner < 0 || h.owner >= numPlayers) throw new Error(`Bad owner for "${h.territory}".`);
    if (def.domain === 'sea') {
      // Sea holding: a starting fleet. Units must be naval types or
      // fighters (carrier air); every unit belongs to the holding's owner
      // seat. Collected here and placed below, once the sea zones exist.
      // Sea holdings do not count toward land coverage.
      const units = emptyUnits();
      for (const [type, n] of Object.entries(h.units ?? {})) {
        if (!(type in units) || !Number.isInteger(n) || (n as number) < 0) {
          throw new Error(`Bad unit entry ${type}x${n} in "${h.territory}".`);
        }
        if (!(NAVAL_UNIT_TYPES as string[]).includes(type) && type !== 'fighter') {
          throw new Error(
            `Unit "${type}" cannot start at sea ("${h.territory}"): sea holdings take naval units and fighters only.`,
          );
        }
        units[type as UnitType] = n as number;
      }
      seaHoldings.push({ territory: h.territory, owner: h.owner, units });
      continue;
    }
    const units = emptyUnits();
    for (const [type, n] of Object.entries(h.units ?? {})) {
      if (!(type in units) || !Number.isInteger(n) || (n as number) < 0) {
        throw new Error(`Bad unit entry ${type}x${n} in "${h.territory}".`);
      }
      if ((NAVAL_UNIT_TYPES as string[]).includes(type)) {
        throw new Error(`Naval unit "${type}" cannot start on land ("${h.territory}").`);
      }
      units[type as UnitType] = n as number;
    }
    state.territories[h.territory] = {
      owner: h.owner,
      units,
      factory: h.factory === true,
      factoryFresh: false,
      cargo: [],
    };
    covered.add(h.territory);
  }
  // Neutral garrison default (Ian, Oct 4 2026): 3 infantry unless the
  // scenario specifies otherwise, per-territory or via neutralGarrison.
  const defaultGarrison: Partial<Record<UnitType, number>> =
    scenario.neutralGarrison ?? { infantry: 3 };
  for (const [tid, units] of Object.entries(scenario.neutrals)) {
    const def = territoryDef(tid);
    if (!def) throw new Error(`Scenario references unknown territory "${tid}".`);
    if (def.domain === 'sea') throw new Error(`Scenario neutral "${tid}" is a sea zone.`);
    const u = emptyUnits();
    const garrison = units ?? defaultGarrison;
    for (const [type, n] of Object.entries(garrison)) {
      if ((NAVAL_UNIT_TYPES as string[]).includes(type)) {
        throw new Error(`Naval unit "${type}" cannot garrison land ("${tid}").`);
      }
      u[type as UnitType] = n as number;
    }
    state.territories[tid] = { owner: null, units: u, factory: false, factoryFresh: false, cargo: [] };
    covered.add(tid);
  }
  // Sea zones are never owned via land holdings, never garrisoned, and
  // exempt from scenario coverage: they start as uncontrolled waters.
  for (const zid of seaZoneIds()) {
    state.territories[zid] = {
      owner: null,
      units: emptyUnits(),
      factory: false,
      factoryFresh: false,
      cargo: [],
    };
  }
  // Place the starting fleets. addPlayerSeaUnits follows the naval.ts
  // sea-force model exactly: the fleet becomes the zone's primary force
  // (`owner`/`units`), or a `coexist` entry when another owner's fleet
  // already holds the zone. `covered` still counts land territories only.
  for (const sh of seaHoldings) {
    addPlayerSeaUnits(state.territories, sh.territory, sh.owner, sh.units);
  }
  if (covered.size !== landTerritoryIds().length) {
    throw new Error('Scenario does not cover every land territory.');
  }
  for (const p of state.players) {
    if (!state.territories[p.capital]?.factory) {
      throw new Error(`Capital ${p.capital} has no factory.`);
    }
  }

  state.currentPlayer = state.turnOrder[0];
  log(state, 'game_start', `Game started. Turn order: ${state.turnOrder.map((id) => state.players[id].name).join(', ')}.`);
  return state;
}


// --------------------------------------------------------------- purchase ---

export function purchase(state: GameState, playerId: number, items: PurchaseItem[]): ActionResult {
  const phaseErr = requirePhase(state, ['purchase']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  if (!ownsCapital(state, playerId)) {
    if (items.length > 0) return fail('no_capital', 'You cannot purchase while your capital is enemy-held.');
    return { ok: true };
  }
  let cost = 0;
  for (const item of items) {
    const stats = item.type === 'factory' ? { cost: 15 } : UNITS[item.type as keyof typeof UNITS];
    if (!stats) return fail('bad_unit', `Unknown unit type "${item.type}".`);
    if (!Number.isInteger(item.count) || item.count < 1) {
      return fail('bad_count', 'Purchase counts must be positive integers.');
    }
    cost += stats.cost * item.count;
  }
  if (cost > state.players[playerId].ipcs) {
    return fail('funds', `That costs ${cost} IPCs; you hold ${state.players[playerId].ipcs}.`);
  }
  state.players[playerId].ipcs -= cost;
  for (const item of items) {
    state.purchased[item.type] = (state.purchased[item.type] ?? 0) + item.count;
  }
  log(state, 'purchase', `${state.players[playerId].name} spends ${cost} IPCs: ${items.map((i) => `${i.count}x${i.type}`).join(', ') || 'nothing'}.`);
  return { ok: true };
}


// ------------------------------------------------------------ combat move ---

interface WorkBattle {
  territoryId: string;
  defenderId: number | null;
  kind: 'combat' | 'sbr';
  attack: UnitCounts;
  origins: string[];
  /** Set when reinforcing an already-open battle from an earlier combatMove call. */
  existingId?: number;
  /** Sea zone an amphibious assault launched from (1942 2e p.15). */
  amphibiousFrom?: string;
  /** Land units in `attack` that came off transports (cannot retreat). */
  seaborne?: UnitCounts;
  /** Bombardment ships decided at combat-move time (p.15). */
  bombard?: { battleship: number; cruiser: number };
  /** Amphibious cargo earmarked but not yet offloaded (contested launch zone). */
  pendingDisembark?: { from: string; units: UnitCounts };
}


function blitzCapture(
  work: Record<string, TerritoryState>,
  blitzes: Array<{ terr: string; prevOwner: number | null }>,
  terr: string,
  captorId: number,
): void {
  const prevOwner = work[terr].owner;
  work[terr].owner = captorId;
  if (work[terr].factory) work[terr].factoryFresh = true;
  blitzes.push({ terr, prevOwner });
}


export function combatMove(state: GameState, playerId: number, moves: CombatMove[]): ActionResult {
  const phaseErr = requirePhase(state, ['combatMove']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;

  // Validate everything against a working copy: any failure rejects the whole action.
  const work: Record<string, TerritoryState> = JSON.parse(JSON.stringify(state.territories));
  const usedWork: Record<string, UnitCounts> = {};
  const markUsed = (terr: string, u: Partial<UnitCounts>) => {
    const k = usedKey(terr, playerId);
    usedWork[k] = addUnits(usedWork[k] ?? emptyUnits(), u);
  };
  // Preload the attacker's already-open battles so a second combatMove call
  // reinforces them instead of opening duplicates. All-or-nothing still holds:
  // these are copies, written back only on success.
  const workBattles: WorkBattle[] = state.battles
    .filter((bb) => !bb.over && bb.attackerId === playerId)
    .map((bb) => ({
      territoryId: bb.territoryId,
      defenderId: bb.defenderId,
      kind: bb.kind,
      attack: { ...bb.attack },
      origins: [...bb.origins],
      existingId: bb.id,
    }));
  const blitzes: Array<{ terr: string; prevOwner: number | null }> = [];
  const landing = landingOptions(state, playerId);
  /** Amphibious cargo earmarked by disembark moves, per launch zone (so two
   *  moves cannot double-count the same manifest). */
  const earmarked: Record<string, UnitCounts> = {};
  /** Fighters that rode ships into a sea zone earlier in this combat-move
   *  batch. 1942 2e (fighter "Land on Aircraft Carriers"): a fighter must be
   *  launched from the carrier's ORIGINAL position to participate in combat —
   *  it cannot ride a ship and then attack from the new position. */
  const seaFighterArrivals: Record<string, number> = {};

  const getBattle = (tid: string, defenderId: number | null, kind: 'combat' | 'sbr'): WorkBattle | ActionResult => {
    const existing = workBattles.find((b) => b.territoryId === tid);
    if (existing) {
      if (existing.kind !== kind) return fail('mixed_battle', 'Cannot mix a bombing raid and an attack on one territory.');
      if (existing.defenderId !== defenderId) return fail('mixed_battle', 'Battle ownership changed mid-move.');
      return existing;
    }
    const b: WorkBattle = { territoryId: tid, defenderId, kind, attack: emptyUnits(), origins: [] };
    workBattles.push(b);
    return b;
  };

  /**
   * Naval leg of a combat move (1942 2e, sea units pp.27-30): fleet movement,
   * sea attacks, transport embark/disembark, and amphibious assault declaration.
   * Submarines get their p.29 movement rules; ignored subs/transports coexist
   * via `coexist` until attacked. Returns null on success, an ActionResult
   * failure otherwise.
   */
  const navalCombatMove = (move: CombatMove, playerId: number): ActionResult | null => {
    const fromSea = isSea(move.from);
    const toSea = isSea(move.to);
    const units = move.units;
    const full = { ...emptyUnits(), ...units };
    const seaN = countSea(full);
    const landN = countLand(full);
    const airN = countAir(full);
    const aaN = units.aa ?? 0;

    // --- from==to: open a battle with forces already sharing the zone ---
    // (1942 2e p.29: a force that ignored subs/transports may attack them on
    // a later turn; likewise the ignored subs may strike back.)
    if (fromSea && toSea && move.from === move.to) {
      if (!move.attack) {
        return fail('attack_flag', 'Opening a battle with forces already in this sea zone requires attack: true.');
      }
      if (landN > 0 || aaN > 0) return fail('no_land_at_sea', 'Only naval and air units operate at sea.');
      const pf = playerSeaForce(work, move.to, playerId);
      if (!hasEnough(pf.units, units)) {
        return fail('too_few_units', `Not enough of your units in ${move.to}.`);
      }
      if (movePower(units) === 0) return fail('no_escort', 'Transports may not attack unescorted (1942 2e p.30).');
      const z = work[move.to];
      const enemies = seaZoneForces(z).filter(
        (f) => f.owner !== null && f.owner !== playerId && countUnits(f.units) > 0,
      );
      if (enemies.length === 0) return fail('no_enemy', `No enemy forces in ${move.to} to attack.`);
      // One defender per battle (simplification): the primary occupant first.
      const def = enemies.find((f) => f.owner === z.owner) ?? enemies[0];
      const defenderId = def.owner as number;
      removeSeaUnits(work, move.to, playerId, units);
      consolidateDefender(work, move.to, defenderId);
      const b = getBattle(move.to, defenderId, 'combat');
      if ('ok' in b) return b;
      b.attack = addUnits(b.attack, units);
      if (!b.origins.includes(move.to)) b.origins.push(move.to);
      markUsed(move.to, units);
      return null;
    }

    // --- sea -> sea: fleet movement or sea attack ---
    if (fromSea && toSea) {
      if (move.embark || move.disembark) return fail('bad_move', 'embark/disembark are for land/sea transfers.');
      if (landN > 0 || aaN > 0) return fail('no_land_at_sea', 'Only naval and air units operate at sea.');
      const pf = playerSeaForce(work, move.from, playerId);
      if (!hasEnough(pf.units, units)) {
        return fail('too_few_units', `Not enough of your units in ${move.from}.`);
      }
      // Range. Submarines treat hostile zones as friendly but a hostile
      // destroyer ends their movement immediately (1942 2e p.29); other ships
      // cannot transit hostile waters at all (p.27).
      const nSubs = units.submarine ?? 0;
      const otherSeaN = seaN - nSubs;
      if (nSubs > 0) {
        const reach = seaReachable(move.from, UNITS.submarine.move, (z) =>
          z === move.to ? true : !hasHostileDestroyer(work, z, playerId),
        );
        if (!reach.has(move.to)) {
          const intercept = findDestroyerIntercept(work, move.from, playerId);
          if (intercept) {
            return fail(
              'destroyer_intercept',
              `An enemy destroyer in ${intercept} intercepts the submarine: it must end its movement there (1942 2e p.29).`,
            );
          }
          return fail('range', `Submarines in ${move.from} cannot reach ${move.to}.`);
        }
      }
      if (otherSeaN > 0) {
        const reach = seaReachable(move.from, UNITS.transport.move, (z) =>
          z === move.to ? true : !seaZoneHostileTo(work, z, playerId),
        );
        if (!reach.has(move.to)) {
          return fail(
            'range',
            `Ships in ${move.from} cannot reach ${move.to} (2 sea zones, no hostile transit).`,
          );
        }
      }
      for (const t of AIR_UNIT_TYPES) {
        const n = units[t] ?? 0;
        if (n === 0) continue;
        const dist = airDistance(move.from, move.to);
        if (dist > UNITS[t].move) return fail('range', `Aircraft in ${move.from} cannot reach ${move.to}.`);
        const remaining = UNITS[t].move - dist;
        if (!landing.some((l) => airDistance(move.to, l) <= remaining)) {
          return fail('no_landing', `Aircraft attacking ${move.to} cannot reach a legal landing spot.`);
        }
      }
      // Enemy forces at the destination (combined primary + coexisting).
      const dz = work[move.to];
      const enemies = seaZoneForces(dz).filter(
        (f) => f.owner !== null && f.owner !== playerId && countUnits(f.units) > 0,
      );
      const surfaceFoe = enemies.find((f) => hasSurfaceWarships(f.units));
      const subTransFoes = enemies.filter((f) => !hasSurfaceWarships(f.units));
      removeSeaUnits(work, move.from, playerId, units);
      const nTrn = units.transport ?? 0;
      if (nTrn > 0) carryCargoAlong(work, move.from, move.to, playerId, nTrn);
      if ((units.fighter ?? 0) > 0) {
        seaFighterArrivals[move.to] = (seaFighterArrivals[move.to] ?? 0) + (units.fighter ?? 0);
      }
      if (surfaceFoe) {
        // Hostile waters: sea battle (1942 2e p.27).
        if (movePower(units) === 0) return fail('no_escort', 'Transports may not attack unescorted (1942 2e p.30).');
        const defenderId = surfaceFoe.owner as number;
        consolidateDefender(work, move.to, defenderId);
        const b = getBattle(move.to, defenderId, 'combat');
        if ('ok' in b) return b;
        b.attack = addUnits(b.attack, units);
        if (!b.origins.includes(move.from)) b.origins.push(move.from);
      } else if (subTransFoes.length > 0) {
        // 1942 2e p.29: the mover chooses to attack the subs/transports or
        // ignore them. Default is attack (phase-1 behavior); set attack: false
        // to ignore and coexist.
        if (move.attack ?? true) {
          // Declared attack on the ignored subs/transports.
          if (movePower(units) === 0) return fail('no_escort', 'Transports may not attack unescorted (1942 2e p.30).');
          const def = subTransFoes.find((f) => f.owner === dz.owner) ?? subTransFoes[0];
          const defenderId = def.owner as number;
          consolidateDefender(work, move.to, defenderId);
          const b = getBattle(move.to, defenderId, 'combat');
          if ('ok' in b) return b;
          b.attack = addUnits(b.attack, units);
          if (!b.origins.includes(move.from)) b.origins.push(move.from);
        } else {
          // Ignore (1942 2e p.29): coexist; the enemy subs/transports yield
          // primary occupancy to the arriver.
          arriveSeaZone(work, move.to, playerId, units);
        }
      } else {
        arriveSeaZone(work, move.to, playerId, units);
      }
      normalizeSeaZone(work, move.from);
      markUsed(move.from, units);
      return null;
    }

    // --- land -> sea: embark land units onto transports ---
    if (!fromSea && toSea) {
      // Air attack on a sea zone (1942 2e: aircraft strike ships normally).
      // Fighters and bombers fly from land; they need no embark flag.
      if (!move.embark && airN > 0 && seaN === 0 && landN === 0 && aaN === 0) {
        if (move.sbr) return fail('bad_move', 'Bombing raids target factories, not sea zones.');
        if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);
        for (const t of AIR_UNIT_TYPES) {
          const n = units[t] ?? 0;
          if (n === 0) continue;
          const dist = airDistance(move.from, move.to);
          if (dist > UNITS[t].move) return fail('range', `Aircraft in ${move.from} cannot reach ${move.to}.`);
          const remaining = UNITS[t].move - dist;
          if (!landing.some((l) => airDistance(move.to, l) <= remaining)) {
            return fail('no_landing', `Aircraft attacking ${move.to} cannot reach a legal landing spot.`);
          }
        }
        if (!hasEnough(work[move.from].units, units)) {
          return fail('too_few_units', `Not enough units in ${move.from}.`);
        }
        work[move.from].units = subUnits(work[move.from].units, units);
        markUsed(move.from, units);
        const dz = work[move.to];
        const enemies = seaZoneForces(dz).filter(
          (f) => f.owner !== null && f.owner !== playerId && countUnits(f.units) > 0,
        );
        if (enemies.length === 0) return fail('no_enemy', `No enemy forces in ${move.to} to attack.`);
        const surfaceFoe = enemies.find((f) => hasSurfaceWarships(f.units));
        const def = surfaceFoe ?? enemies[0];
        const defenderId = def.owner as number;
        consolidateDefender(work, move.to, defenderId);
        const b = getBattle(move.to, defenderId, 'combat');
        if ('ok' in b) return b;
        b.attack = addUnits(b.attack, units);
        if (!b.origins.includes(move.from)) b.origins.push(move.from);
        return null;
      }
      if (!move.embark) return fail('embark_flag', 'Loading transports requires embark: true.');
      if (move.sbr) return fail('bad_move', 'Bombing raids cannot embark.');
      if (seaN > 0 || airN > 0) return fail('bad_cargo', 'Only land units embark onto transports.');
      if (aaN > 0) return fail('aa_no_attack', 'AA guns load onto transports in the non-combat phase only.');
      if (!areAdjacent(move.from, move.to)) {
        return fail('range', 'Transports load from an adjacent coastal territory.');
      }
      if (seaZoneHostileTo(work, move.to, playerId)) {
        return fail('hostile_waters', 'Cannot load transports in a hostile sea zone (1942 2e p.30).');
      }
      if (!hasEnough(work[move.from].units, units)) {
        return fail('too_few_units', `Not enough units in ${move.from}.`);
      }
      const nT = playerSeaForce(work, move.to, playerId).units.transport;
      const err = embarkUnits(work, move.to, playerId, units, nT);
      if (err) return err;
      work[move.from].units = subUnits(work[move.from].units, units);
      markUsed(move.from, units);
      return null;
    }

    // --- sea -> land: carrier-based fighter attack (1942 2e p.27). Fighters
    // launch from the carrier's sea zone to strike land in range, then land
    // in the non-combat phase like any other attacking aircraft.
    if (fromSea && !toSea && !move.disembark && airN > 0 && seaN === 0 && landN === 0 && aaN === 0) {
      if (move.embark) return fail('bad_move', 'embark is for land/sea transfers.');
      if (move.sbr) return fail('bad_move', 'Only bombers fly strategic bombing raids.');
      if ((units.bomber ?? 0) > 0) {
        return fail('no_bomber_at_sea', 'Bombers cannot base on carriers; only fighters operate from sea zones.');
      }
      const nF = units.fighter ?? 0;
      if (nF === 0) return fail('empty_move', 'Each move must move at least one unit.');
      // Launch rule (1942 2e, fighter "Land on Aircraft Carriers"): fighters
      // must launch from the carrier's ORIGINAL position — fighters that rode
      // a ship into this zone earlier in this combat move cannot attack.
      const arrived = seaFighterArrivals[move.from] ?? 0;
      const pfFighters = playerSeaForce(work, move.from, playerId).units.fighter;
      if (nF > pfFighters - arrived) {
        return fail(
          'must_launch',
          'Fighters must launch from the carrier\u2019s original sea zone to attack (1942 2e); fighters that rode a ship this phase cannot attack from the new position.',
        );
      }
      const dist = airDistance(move.from, move.to);
      if (dist > UNITS.fighter.move) {
        return fail('range', `Fighters in ${move.from} cannot reach ${move.to}.`);
      }
      const remaining = UNITS.fighter.move - dist;
      if (!landing.some((l) => airDistance(move.to, l) <= remaining)) {
        return fail('no_landing', `Fighters attacking ${move.to} cannot reach a legal landing spot.`);
      }
      const destOwner = work[move.to].owner;
      if (destOwner === playerId) {
        return fail('friendly_attack', 'Land fighters on friendly territory in the non-combat phase.');
      }
      removeSeaUnits(work, move.from, playerId, units);
      normalizeSeaZone(work, move.from);
      markUsed(move.from, units);
      const b = getBattle(move.to, destOwner, 'combat');
      if ('ok' in b) return b;
      b.attack = addUnits(b.attack, units);
      return null;
    }

    // --- sea -> land: amphibious assault. The offload is earmarked here and
    // settled at commit: immediate from a friendly launch zone, deferred
    // until the sea battle resolves from a contested one (1942 2e p.15).
    if (!move.disembark) return fail('disembark_flag', 'Leaving a transport requires disembark: true.');
    for (const t of ALL_UNIT_TYPES) {
      if ((units[t] ?? 0) > 0 && !(CARGO_TYPES as UnitType[]).includes(t)) {
        return fail('bad_cargo', 'Only embarked land units disembark.');
      }
    }
    if (!areAdjacent(move.from, move.to)) {
      return fail('range', 'Transports offload into an adjacent coastal territory.');
    }
    const destOwner = work[move.to].owner;
    if (destOwner === playerId) {
      return fail('friendly_offload', 'Offloading into friendly territory happens in the non-combat phase.');
    }
    const b = getBattle(move.to, destOwner, 'combat');
    if ('ok' in b) return b;
    // One launch zone per assault (simplification).
    if (b.amphibiousFrom && b.amphibiousFrom !== move.from) {
      return fail('multi_launch', 'An amphibious assault launches from a single sea zone.');
    }
    // Cargo availability, net of earmarks by earlier moves in this action.
    const availCargo = subUnits(cargoOf(work, move.from, playerId), earmarked[move.from] ?? emptyUnits());
    if (!hasEnough(availCargo, units)) {
      return fail('no_cargo', 'Those units are not aboard your transports there.');
    }
    earmarked[move.from] = addUnits(earmarked[move.from] ?? emptyUnits(), units);
    b.amphibiousFrom = move.from;
    b.pendingDisembark = { from: move.from, units: { ...earmarked[move.from] } };
    if (!b.origins.includes(move.from)) b.origins.push(move.from);
    return null;
  };

  for (const move of moves) {
    if (!territoryDef(move.from)) return fail('unknown_territory', `Unknown territory "${move.from}".`);
    if (!territoryDef(move.to)) return fail('unknown_territory', `Unknown territory "${move.to}".`);
    if (!validCounts(move.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (countUnits({ ...emptyUnits(), ...move.units }) === 0) {
      return fail('empty_move', 'Each move must move at least one unit.');
    }

    // Any leg at sea takes the naval path (fleet movement, sea attack, embark/disembark).
    if (isSea(move.from) || isSea(move.to)) {
      if (isSea(move.from)) {
        // The player's force may sit in `coexist` (ignored subs, or ships
        // mobilized into hostile waters) rather than as primary occupant.
        const pf = playerSeaForce(work, move.from, playerId);
        if (countUnits(pf.units) === 0) {
          return fail('not_owner', `You have no forces in ${move.from}.`);
        }
      } else if (work[move.from].owner !== playerId) {
        return fail('not_owner', `You do not hold ${move.from}.`);
      }
      const err = navalCombatMove(move, playerId);
      if (err) return err;
      continue;
    }
    if (work[move.from].owner !== playerId) {
      return fail('not_owner', `You do not hold ${move.from}.`);
    }

    if ((move.units.aa ?? 0) > 0) return fail('aa_no_attack', 'AA guns cannot move in the combat-move phase.');
    if (!hasEnough(work[move.from].units, move.units)) {
      return fail('too_few_units', `Not enough units in ${move.from}.`);
    }
    if (countSea({ ...emptyUnits(), ...move.units }) > 0) {
      return fail('no_navy_on_land', 'Naval units move at sea: sea zone to sea zone.');
    }

    const landN =
      (move.units.infantry ?? 0) + (move.units.artillery ?? 0) + (move.units.tank ?? 0);
    const airN = (move.units.fighter ?? 0) + (move.units.bomber ?? 0);

    if (move.sbr) {
      // Strategic bombing raid: bombers only, factory target, then a landing check.
      if (landN > 0 || (move.units.fighter ?? 0) > 0 || (move.units.bomber ?? 0) < 1) {
        return fail('sbr_bombers', 'A bombing raid must consist of bombers only.');
      }
      if (work[move.to].owner === playerId) return fail('sbr_friendly', 'Cannot bomb your own territory.');
      if (!work[move.to].factory) return fail('sbr_no_factory', 'Bombing raids target factory territories.');
      const dist = airDistance(move.from, move.to);
      if (dist > UNITS.bomber.move) return fail('range', 'Target is beyond bomber range.');
      const remaining = UNITS.bomber.move - dist;
      if (!landing.some((l) => airDistance(move.to, l) <= remaining)) {
        return fail('no_landing', 'Bombers cannot reach a legal landing spot after the raid.');
      }
      work[move.from].units = subUnits(work[move.from].units, move.units);
      markUsed(move.from, move.units);
      const b = getBattle(move.to, work[move.to].owner, 'sbr');
      if ('ok' in b) return b;
      b.attack = addUnits(b.attack, move.units);
      continue;
    }

    const destOwner = work[move.to].owner;
    if (destOwner === playerId) {
      // Friendly repositioning (no battle). Land moves 1 (tanks 2 through friendly).
      for (const t of LAND_UNIT_TYPES) {
        const n = move.units[t] ?? 0;
        if (n === 0) continue;
        if (t === 'tank') {
          const ok =
            areAdjacent(move.from, move.to) ||
            landPaths(move.from, 2, (id) => work[id].owner === playerId, () => false).some(
              (p) => p[p.length - 1] === move.to,
            );
          if (!ok) return fail('range', `Tank in ${move.from} cannot reach ${move.to}.`);
        } else if (!areAdjacent(move.from, move.to)) {
          return fail('range', `${t} moves 1 territory; ${move.from} to ${move.to} is not adjacent.`);
        }
      }
      for (const t of AIR_UNIT_TYPES) {
        const n = move.units[t] ?? 0;
        if (n > 0 && airDistance(move.from, move.to) > UNITS[t].move) {
          return fail('range', `Aircraft in ${move.from} cannot reach ${move.to}.`);
        }
      }
      work[move.from].units = subUnits(work[move.from].units, move.units);
      work[move.to].units = addUnits(work[move.to].units, move.units);
      markUsed(move.from, move.units);
      markUsed(move.to, move.units);
      continue;
    }

    // Attack on an enemy or neutral territory.
    if ((move.units.infantry ?? 0) > 0 || (move.units.artillery ?? 0) > 0) {
      if (!areAdjacent(move.from, move.to)) {
        return fail('range', 'Infantry and artillery attack only adjacent territories.');
      }
    }
    if ((move.units.tank ?? 0) > 0) {
      if (!areAdjacent(move.from, move.to)) {
        // Blitz path: exactly one intermediate stop, friendly or empty-enemy.
        const via = move.via ?? [];
        if (via.length !== 1) {
          return fail('blitz_path', 'A 2-step tank attack must declare its via territory.');
        }
        const [mid] = via;
        if (!areAdjacent(move.from, mid) || !areAdjacent(mid, move.to)) {
          return fail('blitz_path', 'The via territory must connect origin to target.');
        }
        const midOwner = work[mid].owner;
        if (midOwner !== playerId) {
          if (countUnits(work[mid].units) > 0) {
            return fail('blocked', 'Tanks cannot blitz through an occupied enemy territory.');
          }
          // Blitz: capture the empty enemy territory in passing.
          blitzCapture(work, blitzes, mid, playerId);
        }
      }
    }
    for (const t of AIR_UNIT_TYPES) {
      const n = move.units[t] ?? 0;
      if (n === 0) continue;
      const dist = airDistance(move.from, move.to);
      if (dist > UNITS[t].move) return fail('range', `Aircraft in ${move.from} cannot reach ${move.to}.`);
      const remaining = UNITS[t].move - dist;
      if (!landing.some((l) => airDistance(move.to, l) <= remaining)) {
        return fail('no_landing', `Aircraft attacking ${move.to} cannot reach a legal landing spot.`);
      }
    }
    work[move.from].units = subUnits(work[move.from].units, move.units);
    markUsed(move.from, move.units);
    const b = getBattle(move.to, work[move.to].owner, 'combat');
    if ('ok' in b) return b;
    b.attack = addUnits(b.attack, move.units);
    if (landN > 0 && !b.origins.includes(move.from)) b.origins.push(move.from);
  }

  // Amphibious offloads (1942 2e p.15). From a friendly launch zone the cargo
  // comes ashore at once; from a contested zone (a sea battle is being fought
  // there) the offload waits for the sea battle's outcome, and no bombardment
  // is allowed. Bombardment eligibility is decided here from final positions,
  // so supporting ships may move in during the same combat move.
  for (const wb of workBattles) {
    if (!wb.amphibiousFrom || !wb.pendingDisembark) continue;
    const lz = wb.amphibiousFrom;
    const hostile = seaZoneHostileTo(work, lz, playerId);
    const seaBattleOpen =
      workBattles.some((x) => x !== wb && x.territoryId === lz && isSea(x.territoryId)) ||
      state.battles.some(
        (x) => !x.over && x.territoryId === lz && isSea(x.territoryId) && x.attackerId === playerId,
      );
    if (hostile && !seaBattleOpen) {
      return fail(
        'hostile_waters',
        `Amphibious assaults cannot launch from hostile ${lz} without fighting for it (1942 2e p.15).`,
      );
    }
    if (seaBattleOpen) {
      // Contested: the offload stays pending until the sea battle resolves;
      // p.15 forbids bombardment when a sea battle occurs in the launch zone.
      wb.bombard = undefined;
      continue;
    }
    // Friendly launch: offload now.
    const pd = wb.pendingDisembark;
    const err = disembarkUnits(work, lz, playerId, pd.units);
    if (err) return err; // unreachable: earmarked cargo was validated per-move
    wb.attack = addUnits(wb.attack, pd.units);
    wb.seaborne = addUnits(wb.seaborne ?? emptyUnits(), pd.units);
    wb.pendingDisembark = undefined;
    const pf = playerSeaForce(work, lz, playerId);
    const seaborneLand = countLand(wb.seaborne ?? emptyUnits());
    const n = Math.min(pf.units.battleship + pf.units.cruiser, seaborneLand);
    const nbb = Math.min(pf.units.battleship, n);
    wb.bombard = { battleship: nbb, cruiser: n - nbb };
  }

  // 1942 2e p.30: enemy transports left ignored in a sea zone are destroyed
  // automatically at the end of the Combat Move phase by combat-capable units
  // present. (This counts as a sea combat for the destroyers: they are marked
  // used.) Only when the enemy has transports alone — subs may be ignored freely.
  for (const zid of seaZoneIds()) {
    const z = work[zid];
    if (workBattles.some((wb) => wb.territoryId === zid)) continue;
    const owner = z.owner;
    if (owner === null || owner === undefined) continue;
    const hunters: Partial<UnitCounts> = {};
    for (const t of ALL_UNIT_TYPES) {
      if (t === 'transport') continue;
      if ((z.units[t] ?? 0) > 0 && (UNITS[t].sea || UNITS[t].air)) hunters[t] = z.units[t];
    }
    if (countUnits({ ...emptyUnits(), ...hunters }) === 0) continue;
    const kept: Array<{ owner: number; units: UnitCounts }> = [];
    let sunk = 0;
    for (const f of z.coexist ?? []) {
      if (f.owner === owner) {
        kept.push(f);
        continue;
      }
      const enemyOther = countUnits(f.units) - f.units.transport;
      if (f.units.transport > 0 && enemyOther === 0) {
        sunk += f.units.transport;
        const lost = destroyCargo(work, zid, f.owner, f.units.transport);
        log(
          state,
          'sink',
          `${state.players[owner].name}'s forces destroy ${f.units.transport} ignored transport(s) in ${zid}${lost > 0 ? ` (${lost} embarked unit(s) lost)` : ''} (1942 2e p.30).`,
        );
      } else {
        kept.push(f);
      }
    }
    if (sunk > 0) {
      z.coexist = kept.length > 0 ? kept : undefined;
      normalizeSeaZone(work, zid);
      const k = usedKey(zid, owner);
      usedWork[k] = addUnits(usedWork[k] ?? emptyUnits(), hunters);
    }
  }

  // Commit.
  state.territories = work;
  for (const [terr, u] of Object.entries(usedWork)) {
    state.used[terr] = addUnits(state.used[terr] ?? emptyUnits(), u);
  }
  for (const wb of workBattles) {
    if (wb.existingId !== undefined) {
      const live = state.battles.find((bb) => bb.id === wb.existingId)!;
      live.attack = wb.attack;
      live.origins = [...new Set(wb.origins)];
      if (wb.seaborne) live.seaborne = addUnits(live.seaborne ?? emptyUnits(), wb.seaborne);
      if (wb.amphibiousFrom) live.amphibiousFrom = wb.amphibiousFrom;
      if (wb.bombard) live.bombard = wb.bombard;
      if (wb.pendingDisembark) {
        live.pendingDisembark = {
          from: wb.pendingDisembark.from,
          units: addUnits(live.pendingDisembark?.units ?? emptyUnits(), wb.pendingDisembark.units),
        };
      }
      continue;
    }
    state.battles.push({
      id: state.nextBattleId++,
      territoryId: wb.territoryId,
      attackerId: playerId,
      defenderId: wb.defenderId,
      kind: wb.kind,
      attack: wb.attack,
      origins: wb.origins,
      aaFired: false,
      sbrStruck: false,
      rounds: 0,
      pendingAttacker: 0,
      pendingDefender: 0,
      attackerResolved: true,
      defenderResolved: true,
      over: false,
      result: null,
      amphibiousFrom: wb.amphibiousFrom,
      seaborne: wb.seaborne,
      bombard: wb.bombard,
      bombardDone: false,
      bombardDoomed: 0,
      damagedAttackBB: 0,
      damagedDefBB: 0,
      subPhase: 'attacker',
      submergedA: 0,
      submergedD: 0,
      pendAtkAir: 0,
      pendDefAir: 0,
      pendingDisembark: wb.pendingDisembark,
    });
  }
  for (const bl of blitzes) {
    log(state, 'blitz', `${state.players[playerId].name} blitzes through ${bl.terr}.`);
    resolveCapture(state, bl.terr, playerId, bl.prevOwner);
    if (state.phase === 'gameover') break;
  }
  if (workBattles.length > 0) {
    log(
      state,
      'combat_move',
      `${state.players[playerId].name} attacks ${workBattles.map((b) => `${b.territoryId} (${describeUnits(b.attack)})`).join(', ')}.`,
    );
  } else {
    log(state, 'combat_move', `${state.players[playerId].name} makes no combat moves.`);
  }
  return { ok: true };
}


// ---------------------------------------------------------- non-combat move ---

function availableForNonCombat(state: GameState, terrId: string): UnitCounts {
  const t = state.territories[terrId];
  const used = state.used[terrId] ?? emptyUnits();
  const out = emptyUnits();
  for (const u of ALL_UNIT_TYPES) {
    out[u] = u === 'fighter' || u === 'bomber' ? t.units[u] : Math.max(0, t.units[u] - used[u]);
  }
  return out;
}


export function nonCombatMove(state: GameState, playerId: number, moves: NonCombatMove[]): ActionResult {
  const phaseErr = requirePhase(state, ['nonCombat']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;

  const work: Record<string, TerritoryState> = JSON.parse(JSON.stringify(state.territories));
  const usedWork: Record<string, UnitCounts> = JSON.parse(JSON.stringify(state.used));
  // Air left in finished battles is "in the air" over that territory until landed.
  const airAloft: Record<string, UnitCounts> = {};
  for (const b of state.battles) {
    if (!b.over) return fail('battles_open', 'Finish all combat before non-combat movement.');
    const air = { ...emptyUnits(), fighter: b.attack.fighter, bomber: b.attack.bomber };
    if (countAir(air) > 0) {
      airAloft[b.territoryId] = addUnits(airAloft[b.territoryId] ?? emptyUnits(), air);
    }
    if (countLand(b.attack) > 0) {
      return fail('stuck_land', `Attacking land units are stranded in ${b.territoryId}.`);
    }
  }
  const avail = (terr: string): UnitCounts => {
    const t = work[terr];
    if (!t) return emptyUnits();
    // Sea zones: the player's own force (primary or coexisting), minus what
    // that player already used. Land: as before.
    const mine = isSea(terr) ? playerSeaForce(work, terr, playerId).units : t.units;
    const used = usedWork[usedKey(terr, playerId)] ?? emptyUnits();
    const base = emptyUnits();
    for (const u of ALL_UNIT_TYPES) {
      base[u] = u === 'fighter' || u === 'bomber' ? mine[u] : Math.max(0, mine[u] - used[u]);
    }
    return addUnits(base, airAloft[terr] ?? emptyUnits());
  };

  /** Mark non-air units as spent (they may not move again this turn). */
  const markNonCombatUsed = (terr: string, u: Partial<UnitCounts>): void => {
    const add: Partial<UnitCounts> = {};
    for (const t of ALL_UNIT_TYPES) {
      if (t === 'fighter' || t === 'bomber') continue;
      if ((u[t] ?? 0) > 0) add[t] = u[t];
    }
    const k = usedKey(terr, playerId);
    usedWork[k] = addUnits(usedWork[k] ?? emptyUnits(), add);
  };

  /**
   * Naval leg of a non-combat move (1942 2e pp.13, 30): fleet repositioning
   * and transport ferrying ("bridging"), all within friendly waters.
   * Returns null on success, an ActionResult failure otherwise.
   */
  /**
   * Fighters landing on friendly carriers (1942 2e p.27: "up to two fighters
   * can be on a friendly aircraft carrier at a time"). Handles non-combat
   * repositioning onto a carrier, both from land and from another sea zone
   * (including fighters aloft over a finished battle). Bombers can never
   * land at sea.
   */
  const landFightersOnCarrier = (move: NonCombatMove, playerId: number): ActionResult | null => {
    const units = move.units;
    const nF = units.fighter ?? 0;
    if ((units.bomber ?? 0) > 0) {
      return fail('no_bomber_at_sea', 'Bombers cannot land on carriers; only fighters.');
    }
    if (nF === 0) return fail('empty_move', 'Each move must move at least one unit.');
    if (seaZoneHostileTo(work, move.to, playerId)) {
      return fail('not_owner', 'Non-combat moves stay out of hostile waters.');
    }
    const dist = airDistance(move.from, move.to);
    if (dist > UNITS.fighter.move) {
      return fail('range', `Fighters in ${move.from} cannot reach ${move.to}.`);
    }
    if (carrierSpare(work, move.to, playerId) < nF) {
      return fail(
        'no_carrier_capacity',
        `${move.to} has no free carrier capacity for ${nF} fighter(s) (1942 2e p.27: two per carrier).`,
      );
    }
    const fromSea = isSea(move.from);
    if (!fromSea) {
      const fromOwned = work[move.from].owner === playerId;
      const aloftF = airAloft[move.from]?.fighter ?? 0;
      if (!fromOwned && aloftF === 0) return fail('not_owner', `You do not hold ${move.from}.`);
      if (!fromOwned && nF > aloftF) {
        return fail('too_few_units', `Not enough aircraft aloft over ${move.from}.`);
      }
    }
    if (!hasEnough(avail(move.from), units)) {
      return fail('too_few_units', `Not enough available fighters in ${move.from}.`);
    }
    // Take aloft fighters first, then fighters on the ground / aboard.
    const want = { ...units };
    const aloft = airAloft[move.from];
    if (aloft) {
      const take = Math.min(aloft.fighter, want.fighter ?? 0);
      aloft.fighter -= take;
      want.fighter = (want.fighter ?? 0) - take;
      if (countAir(aloft) === 0) delete airAloft[move.from];
    }
    if (fromSea) {
      removeSeaUnits(work, move.from, playerId, want);
      normalizeSeaZone(work, move.from);
    } else {
      work[move.from].units = subUnits(work[move.from].units, want);
    }
    addPlayerSeaUnits(work, move.to, playerId, units);
    return null;
  };

  const navalNonCombatMove = (move: NonCombatMove, playerId: number): ActionResult | null => {
    const fromSea = isSea(move.from);
    const toSea = isSea(move.to);
    const units = move.units;
    const full = { ...emptyUnits(), ...units };
    const seaN = countSea(full);
    const landN = countLand(full);
    const airN = countAir(full);
    const aaN = units.aa ?? 0;

    // --- sea -> sea: reposition the fleet ---
    if (fromSea && toSea) {
      if (move.embark || move.disembark) return fail('bad_move', 'embark/disembark are for land/sea transfers.');
      if (landN > 0 || aaN > 0) {
        return fail('no_air_land_at_sea', 'Only naval units reposition at sea.');
      }
      if (airN > 0) {
        // Fighters landing on carriers (1942 2e p.27); bombers never land at sea.
        return landFightersOnCarrier(move, playerId);
      }
      // No ending in hostile waters. Subs may transit hostile zones (but not
      // hostile destroyers); other ships may not (1942 2e p.29).
      if (seaZoneHostileTo(work, move.to, playerId)) {
        return fail('not_owner', 'Non-combat moves stay out of hostile waters.');
      }
      const pf = playerSeaForce(work, move.from, playerId);
      if (!hasEnough(pf.units, units)) {
        return fail('too_few_units', `Not enough of your units in ${move.from}.`);
      }
      const nSubs = units.submarine ?? 0;
      const otherSeaN = seaN - nSubs;
      if (nSubs > 0) {
        const reach = seaReachable(move.from, UNITS.submarine.move, (z) =>
          z === move.to ? true : !hasHostileDestroyer(work, z, playerId),
        );
        if (!reach.has(move.to)) {
          const intercept = findDestroyerIntercept(work, move.from, playerId);
          if (intercept) {
            return fail(
              'destroyer_intercept',
              `An enemy destroyer in ${intercept} blocks the submarine's non-combat movement (1942 2e p.29).`,
            );
          }
          return fail('range', `Submarines in ${move.from} cannot reach ${move.to}.`);
        }
      }
      if (otherSeaN > 0) {
        const reach = seaReachable(move.from, UNITS.transport.move, (z) => !seaZoneHostileTo(work, z, playerId));
        if (!reach.has(move.to)) {
          return fail('range', `Ships in ${move.from} cannot reach ${move.to} (2 non-hostile sea zones).`);
        }
      }
      if (!hasEnough(avail(move.from), units)) {
        return fail('too_few_units', `Not enough available units in ${move.from}.`);
      }
      removeSeaUnits(work, move.from, playerId, units);
      arriveSeaZone(work, move.to, playerId, units);
      const nTrn = units.transport ?? 0;
      if (nTrn > 0) carryCargoAlong(work, move.from, move.to, playerId, nTrn);
      markNonCombatUsed(move.from, units);
      return null;
    }

    // --- land -> sea: fighters flying out to land on a carrier (1942 2e p.27) ---
    if (!fromSea && toSea && airN > 0 && seaN === 0 && landN === 0 && aaN === 0) {
      return landFightersOnCarrier(move, playerId);
    }

    // --- land -> sea: embark land units onto transports ---
    if (!fromSea && toSea) {
      if (!move.embark) return fail('embark_flag', 'Loading transports requires embark: true.');
      if (seaN > 0 || airN > 0) return fail('bad_cargo', 'Only land units embark onto transports.');
      if (seaZoneHostileTo(work, move.to, playerId)) {
        return fail('not_owner', 'Non-combat moves stay out of hostile waters.');
      }
      if (!areAdjacent(move.from, move.to)) {
        return fail('range', 'Transports load from an adjacent coastal territory.');
      }
      if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);
      if (!hasEnough(avail(move.from), units)) {
        return fail('too_few_units', `Not enough available units in ${move.from}.`);
      }
      const nT = playerSeaForce(work, move.to, playerId).units.transport;
      const err = embarkUnits(work, move.to, playerId, units, nT);
      if (err) return err;
      work[move.from].units = subUnits(work[move.from].units, units);
      markNonCombatUsed(move.from, units);
      return null;
    }

    // --- sea -> land: offload into a FRIENDLY coastal territory ("bridging", p.30) ---
    for (const t of ALL_UNIT_TYPES) {
      if ((units[t] ?? 0) > 0 && !(CARGO_TYPES as UnitType[]).includes(t)) {
        return fail('bad_cargo', 'Only embarked land units disembark.');
      }
    }
    if (!move.disembark) return fail('disembark_flag', 'Leaving a transport requires disembark: true.');
    if (!areAdjacent(move.from, move.to)) {
      return fail('range', 'Transports offload into an adjacent coastal territory.');
    }
    if (work[move.to].owner !== playerId) {
      return fail('not_owner', 'Non-combat offloads go to territory you hold.');
    }
    if (countUnits(playerSeaForce(work, move.from, playerId).units) === 0) {
      return fail('not_owner', `You have no forces in ${move.from}.`);
    }
    const err = disembarkUnits(work, move.from, playerId, units);
    if (err) return err;
    work[move.to].units = addUnits(work[move.to].units, units);
    markNonCombatUsed(move.to, units);
    return null;
  };

  for (const move of moves) {
    if (!territoryDef(move.from)) return fail('unknown_territory', `Unknown territory "${move.from}".`);
    if (!territoryDef(move.to)) return fail('unknown_territory', `Unknown territory "${move.to}".`);
    if (!validCounts(move.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (countUnits({ ...emptyUnits(), ...move.units }) === 0) {
      return fail('empty_move', 'Each move must move at least one unit.');
    }
    // Naval legs (any side at sea) take the naval path — except aircraft
    // landing from a sea battle, which use the normal air rules below.
    const fromSea = isSea(move.from);
    const toSea = isSea(move.to);
    const legFull = { ...emptyUnits(), ...move.units };
    const airOnlyLeg =
      countAir(legFull) > 0 &&
      countSea(legFull) === 0 &&
      countLand(legFull) === 0 &&
      (move.units.aa ?? 0) === 0;
    if ((fromSea || toSea) && !(airOnlyLeg && fromSea && !toSea)) {
      const err = navalNonCombatMove(move, playerId);
      if (err) return err;
      continue;
    }
    if (work[move.to].owner !== playerId) {
      return fail('not_owner', 'Non-combat moves stay inside your own territories.');
    }
    // Sea sources: the player's force may sit in `coexist` (not primary).
    const fromOwned = isSea(move.from)
      ? countUnits(playerSeaForce(work, move.from, playerId).units) > 0
      : work[move.from].owner === playerId;
    const fromAloft = airAloft[move.from];
    if (!fromOwned && !fromAloft) {
      return fail('not_owner', `You do not hold ${move.from}.`);
    }
    if (!fromOwned && countLand({ ...emptyUnits(), ...move.units }) > 0) {
      return fail('not_owner', 'Only aircraft can leave a contested territory.');
    }
    if (!hasEnough(avail(move.from), move.units)) {
      return fail('too_few_units', `Not enough available units in ${move.from}.`);
    }
    // Range: land 1 (tanks 2 through friendly), air up to its move value.
    for (const t of LAND_UNIT_TYPES) {
      const n = move.units[t] ?? 0;
      if (n === 0) continue;
      if (t === 'tank') {
        const ok =
          areAdjacent(move.from, move.to) ||
          landPaths(move.from, 2, (id) => work[id].owner === playerId, () => false).some(
            (p) => p[p.length - 1] === move.to,
          );
        if (!ok) return fail('range', `Tank in ${move.from} cannot reach ${move.to}.`);
      } else if (!areAdjacent(move.from, move.to)) {
        return fail('range', `${t} moves 1 territory in non-combat.`);
      }
    }
    for (const t of AIR_UNIT_TYPES) {
      const n = move.units[t] ?? 0;
      if (n > 0 && airDistance(move.from, move.to) > UNITS[t].move) {
        return fail('range', `Aircraft in ${move.from} cannot reach ${move.to}.`);
      }
    }
    // Aircraft must end on a legal landing spot: land owned since turn start,
    // or a sea zone with a friendly carrier with spare capacity (p.27).
    if (countAir({ ...emptyUnits(), ...move.units }) > 0 && !landingOptions(state, playerId).includes(move.to)) {
      return fail('no_landing', `${move.to} is not a legal landing spot.`);
    }
    // Apply: take aloft air first, then units on the ground.
    const want = { ...move.units };
    const aloft = airAloft[move.from];
    if (aloft) {
      for (const t of AIR_UNIT_TYPES) {
        const take = Math.min(aloft[t], want[t] ?? 0);
        aloft[t] -= take;
        want[t] = (want[t] ?? 0) - take;
      }
      if (countAir(aloft) === 0) delete airAloft[move.from];
    }
    if (fromOwned) {
      if (isSea(move.from)) {
        removeSeaUnits(work, move.from, playerId, want);
        normalizeSeaZone(work, move.from);
      } else {
        work[move.from].units = subUnits(work[move.from].units, want);
      }
      markNonCombatUsed(move.from, want);
    } else if (countUnits({ ...emptyUnits(), ...want }) > 0) {
      return fail('too_few_units', `Not enough aircraft aloft over ${move.from}.`);
    }
    work[move.to].units = addUnits(work[move.to].units, move.units);
  }

  state.territories = work;
  state.used = usedWork;
  // Write back surviving aloft air into the finished battles.
  for (const b of state.battles) {
    const left = airAloft[b.territoryId];
    b.attack.fighter = left?.fighter ?? 0;
    b.attack.bomber = left?.bomber ?? 0;
  }
  if (moves.length > 0) {
    log(state, 'noncombat', `${state.players[playerId].name} repositions: ${moves.map((m) => `${describeUnits({ ...emptyUnits(), ...m.units })} ${m.from}->${m.to}`).join(', ')}.`);
  } else {
    log(state, 'noncombat', `${state.players[playerId].name} makes no non-combat moves.`);
  }
  return { ok: true };
}


// ---------------------------------------------------------------- mobilize ---

export function mobilize(state: GameState, playerId: number, placements: MobilizePlacement[]): ActionResult {
  const phaseErr = requirePhase(state, ['mobilize']);
  if (phaseErr) return phaseErr;
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;

  // Capacity comes from turn-start factories the player still holds.
  // Fresh factories (built or captured this turn) produce from next turn.
  const caps: Record<string, number> = {};
  for (const terr of state.turnStartFactories) {
    const t = state.territories[terr];
    if (t.owner === playerId && t.factory && !t.factoryFresh) caps[terr] = ipcOf(terr);
  }
  const pool: Record<string, number> = { ...(state.purchased as Record<string, number>) };
  const need: Record<string, number> = {};
  const newFactories: string[] = [];
  // Carrier capacity accounting for fighters mobilized into sea zones
  // (1942 2e p.21: fighters may be placed on a new or existing carrier).
  const fighterSeaPlaced: Record<string, number> = {};
  const carrierSeaPlaced: Record<string, number> = {};

  for (const p of placements) {
    if (!territoryDef(p.territory)) return fail('unknown_territory', `Unknown territory "${p.territory}".`);
    if (state.territories[p.territory].owner !== playerId) {
      return fail('not_owner', `You do not hold ${p.territory}.`);
    }
    if (!validCounts(p.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (p.buildFactory) {
      if ((pool.factory ?? 0) < 1) return fail('not_purchased', 'You did not purchase a factory.');
      if (state.territories[p.territory].factory) return fail('has_factory', `${p.territory} already has a factory.`);
      if (ipcOf(p.territory) < 2) return fail('low_ipc', 'Factories require a territory with IPC value 2+.');
      pool.factory -= 1;
      newFactories.push(p.territory);
    }
    const count = countUnits({ ...emptyUnits(), ...p.units });
    if (count > 0) {
      if (caps[p.territory] === undefined) {
        return fail('no_factory', `${p.territory} has no usable factory (built this turn or lost).`);
      }
      need[p.territory] = (need[p.territory] ?? 0) + count;
    }
    if (p.seaZone) {
      // Naval mobilization (1942 2e p.21): sea units enter play in a sea zone
      // adjacent to the producing industrial complex, counting against its
      // production capacity like any other unit.
      if (!isSea(p.seaZone)) return fail('bad_sea_zone', `${p.seaZone} is not a sea zone.`);
      if (p.buildFactory) return fail('bad_factory', 'Factories are built on land.');
      if (!areAdjacent(p.territory, p.seaZone)) {
        return fail('not_adjacent', `${p.seaZone} is not adjacent to ${p.territory}.`);
      }
      for (const t of ALL_UNIT_TYPES) {
        const n = p.units[t] ?? 0;
        if (n > 0 && !(NAVAL_UNIT_TYPES as UnitType[]).includes(t) && t !== 'fighter') {
          return fail('bad_unit', `Only naval units (and fighters onto carriers) mobilize into sea zones (not ${t}).`);
        }
      }
      // 1942 2e p.21: fighters may be placed on a friendly carrier in the sea
      // zone — an existing carrier or one mobilized in this same phase.
      // Capacity is two fighters per carrier (p.27).
      carrierSeaPlaced[p.seaZone] = (carrierSeaPlaced[p.seaZone] ?? 0) + (p.units.carrier ?? 0);
      const nF = p.units.fighter ?? 0;
      if (nF > 0) {
        const { carriers, fighters } = playerCarrierForce(state.territories, p.seaZone, playerId);
        const spare =
          CARRIER_FIGHTERS * (carriers + (carrierSeaPlaced[p.seaZone] ?? 0)) -
          fighters -
          (fighterSeaPlaced[p.seaZone] ?? 0);
        if (spare < nF) {
          return fail(
            'no_carrier_capacity',
            `${p.seaZone} has no free carrier capacity for ${nF} fighter(s) (1942 2e p.27: two per carrier).`,
          );
        }
        fighterSeaPlaced[p.seaZone] = (fighterSeaPlaced[p.seaZone] ?? 0) + nF;
      }
      // 1942 2e p.21: new sea units may enter play even in a hostile sea zone;
      // no combat occurs (the Conduct Combat phase is over). Existing
      // occupants become coexisting foreigners.
    }
  }
  for (const [terr, n] of Object.entries(need)) {
    if (n > (caps[terr] ?? 0)) {
      return fail('capacity', `${terr} can mobilize at most ${caps[terr]} units (its IPC value).`);
    }
  }
  const totals: Record<string, number> = {};
  for (const p of placements) {
    for (const [type, n] of Object.entries(p.units)) {
      totals[type] = (totals[type] ?? 0) + (n ?? 0);
    }
  }
  for (const [type, n] of Object.entries(totals)) {
    if (n > (pool[type] ?? 0)) return fail('not_purchased', `You did not purchase ${n}x ${type}.`);
    pool[type] -= n;
  }

  for (const p of placements) {
    const target = p.seaZone ?? p.territory;
    if (p.seaZone) {
      const z = state.territories[p.seaZone];
      const zOwner = z.owner;
      if (zOwner !== null && zOwner !== playerId && countUnits(z.units) > 0) {
        // 1942 2e p.21: mobilizing into hostile waters. The current occupants
        // become coexisting foreigners; no combat occurs.
        z.coexist = [...(z.coexist ?? []), { owner: zOwner, units: { ...z.units } }];
        z.units = emptyUnits();
        z.owner = playerId;
      }
    }
    state.territories[target].units = addUnits(state.territories[target].units, p.units);
    if (p.seaZone) {
      normalizeSeaZone(state.territories, p.seaZone);
      if (countSea(state.territories[p.seaZone].units) > 0 && state.territories[p.seaZone].owner === null) {
        state.territories[p.seaZone].owner = playerId;
      }
    }
  }
  for (const terr of newFactories) {
    state.territories[terr].factory = true;
    state.territories[terr].factoryFresh = true;
  }
  state.purchased = pool;
  const placedDesc = placements
    .map((p) => `${describeUnits({ ...emptyUnits(), ...p.units })}${p.buildFactory ? '+factory' : ''} @${p.territory}`)
    .join(', ');
  log(state, 'mobilize', `${state.players[playerId].name} mobilizes ${placedDesc || 'nothing'}.`);
  return { ok: true };
}


// ---------------------------------------------------------------- end phase ---

export function endPhase(state: GameState, playerId: number): ActionResult {
  const turnErr = requireCurrentAlive(state, playerId);
  if (turnErr) return turnErr;
  const me = state.players[playerId];

  switch (state.phase) {
    case 'purchase': {
      // Factories built or captured on an earlier turn come online now.
      for (const t of Object.values(state.territories)) t.factoryFresh = false;
      state.ownedAtTurnStart = ownedTerritories(state, playerId);
      state.turnStartFactories = state.ownedAtTurnStart.filter((t) => state.territories[t].factory);
      state.used = {};
      state.phase = 'combatMove';
      log(state, 'phase', `${me.name} ends purchase (bank ${me.ipcs}). Combat-move phase.`);
      return { ok: true };
    }
    case 'combatMove': {
      state.phase = 'combat';
      const n = openBattles(state).length;
      log(state, 'phase', `${me.name} ends combat movement (${n} battle(s)). Combat phase.`);
      return { ok: true };
    }
    case 'combat': {
      const open = openBattles(state);
      if (open.length > 0) return fail('battles_open', `${open.length} battle(s) still unresolved.`);
      state.phase = 'nonCombat';
      log(state, 'phase', `${me.name} ends combat. Non-combat movement (land all aircraft).`);
      return { ok: true };
    }
    case 'nonCombat': {
      // Aircraft not on a legal landing spot are lost. Sea zones are handled
      // by carrier capacity (1942 2e p.27), not the all-or-nothing land rule:
      // fighters may remain up to two per friendly carrier; bombers can never
      // base at sea.
      const legal = new Set(landingOptions(state, playerId));
      let lost = 0;
      for (const [tid, terr] of Object.entries(state.territories)) {
        if (isSea(tid)) continue;
        if (terr.owner !== playerId) continue;
        if (legal.has(tid)) continue;
        lost += terr.units.fighter + terr.units.bomber;
        terr.units.fighter = 0;
        terr.units.bomber = 0;
      }
      for (const zid of seaZoneIds()) {
        const z = state.territories[zid];
        let carriers = 0;
        let fighters = 0;
        for (const f of seaZoneForces(z)) {
          if (f.owner !== playerId) continue;
          carriers += f.units.carrier;
          fighters += f.units.fighter;
        }
        if (carriers === 0 && fighters === 0) {
          // Still clear any of the player's bombers caught at sea.
          for (const f of seaZoneForces(z)) {
            if (f.owner !== playerId) continue;
            lost += f.units.bomber;
            f.units.bomber = 0;
          }
          continue;
        }
        const keep = Math.min(fighters, CARRIER_FIGHTERS * carriers);
        let toRemove = fighters - keep;
        const forces: UnitCounts[] = [];
        for (const f of z.coexist ?? []) if (f.owner === playerId) forces.push(f.units);
        if (z.owner === playerId) forces.push(z.units);
        for (const u of forces) {
          if (toRemove <= 0) break;
          const cut = Math.min(u.fighter, toRemove);
          u.fighter -= cut;
          toRemove -= cut;
        }
        let bomberLost = 0;
        for (const u of forces) {
          bomberLost += u.bomber;
          u.bomber = 0;
        }
        lost += fighters - keep + bomberLost;
        normalizeSeaZone(state.territories, zid);
      }
      for (const b of state.battles) {
        lost += b.attack.fighter + b.attack.bomber;
        b.attack.fighter = 0;
        b.attack.bomber = 0;
      }
      state.battles = [];
      if (lost > 0) log(state, 'stranded', `${lost} aircraft had no legal landing and are lost.`);
      state.phase = 'mobilize';
      log(state, 'phase', `${me.name} ends non-combat movement. Mobilize purchased units.`);
      return { ok: true };
    }
    case 'mobilize': {
      const leftovers = Object.entries(state.purchased).filter(([, n]) => (n ?? 0) > 0);
      if (leftovers.length > 0) {
        log(state, 'forfeit', `${me.name} cannot place ${leftovers.map(([t, n]) => `${n}x${t}`).join(', ')}; they are lost.`);
      }
      state.purchased = {};
      const income = ownsCapital(state, playerId) ? incomeOf(state, playerId) : 0;
      me.ipcs += income;
      log(state, 'income', `${me.name} collects ${income} IPCs (bank ${me.ipcs}).`);

      // Advance to the next living player.
      let nextIdx = state.orderIndex;
      for (let step = 1; step <= state.numPlayers; step++) {
        const idx = (state.orderIndex + step) % state.numPlayers;
        if (state.players[state.turnOrder[idx]].alive) {
          nextIdx = idx;
          break;
        }
      }
      const wrapped = nextIdx <= state.orderIndex;
      state.orderIndex = nextIdx;
      state.currentPlayer = state.turnOrder[nextIdx];
      if (wrapped) state.round++;
      if (state.round > state.turnCap) {
        return endByTurnCap(state);
      }
      state.phase = 'purchase';
      state.ownedAtTurnStart = [];
      state.turnStartFactories = [];
      state.used = {};
      log(state, 'turn_start', `${state.players[state.currentPlayer].name} begins round ${state.round} (bank ${state.players[state.currentPlayer].ipcs}).`);
      return { ok: true };
    }
    case 'gameover':
      return fail('game_over', 'The game is over.');
  }
}


function endByTurnCap(state: GameState): ActionResult {
  // Highest income wins; ties broken by bank, then lowest player id.
  const ranked = state.players
    .filter((p) => p.alive)
    .map((p) => ({ id: p.id, income: incomeOf(state, p.id), bank: p.ipcs }))
    .sort((a, b) => b.income - a.income || b.bank - a.bank || a.id - b.id);
  const winner = ranked[0]?.id ?? 0;
  state.winner = winner;
  state.winReason = 'turn_cap';
  state.phase = 'gameover';
  log(state, 'game_over', `Turn cap (${state.turnCap} rounds) reached. ${state.players[winner].name} wins on income (${ranked[0]?.income}, bank ${ranked[0]?.bank}).`);
  return { ok: true };
}
