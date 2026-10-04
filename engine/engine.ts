import {
  ALL_UNIT_TYPES,
  MAP,
  NAVAL_UNIT_TYPES,
  SURFACE_WARSHIP_TYPES,
  UNITS,
  airDistance,
  areAdjacent,
  ipcOf,
  isLand,
  isSea,
  landPaths,
  landTerritoryIds,
  neighborsOf,
  scenarioFor,
  seaReachable,
  seaZoneIds,
  territoryDef,
  type UnitType,
} from '../data/data';
import type {
  ActionResult,
  Battle,
  BattleResult,
  ChatMessage,
  CombatMove,
  CombatRoundResult,
  GameState,
  MobilizePlacement,
  NonCombatMove,
  Phase,
  PurchaseItem,
  TerritoryState,
  TransportLoad,
  UnitCounts,
} from './types';

export const PLAYER_COLORS = ['#6b7a3f', '#3e5a78', '#7e3b3b', '#b49b62'];
export const MAX_CHAT_LENGTH = 500;
export const DEFAULT_TURN_CAP = 20;
export const LAND_UNIT_TYPES: UnitType[] = ['infantry', 'artillery', 'tank'];
export const AIR_UNIT_TYPES: UnitType[] = ['fighter', 'bomber'];
export const SEA_UNIT_TYPES: UnitType[] = [...NAVAL_UNIT_TYPES];

function fail(code: string, error: string): ActionResult {
  return { ok: false, code, error };
}

// ------------------------------------------------------------------ RNG ---

/** Mulberry32 step. Mutates state.rngState so the stream is serializable. */
export function rand(state: GameState): number {
  let t = (state.rngState += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rollDie(state: GameState): number {
  return 1 + Math.floor(rand(state) * 6);
}

function shuffle<T>(state: GameState, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- units ---

export function emptyUnits(): UnitCounts {
  const u = {} as UnitCounts;
  for (const t of ALL_UNIT_TYPES) u[t] = 0;
  return u;
}

export function countUnits(u: UnitCounts): number {
  let s = 0;
  for (const t of ALL_UNIT_TYPES) s += u[t];
  return s;
}

export function countLand(u: UnitCounts): number {
  return u.infantry + u.artillery + u.tank;
}

export function countAir(u: UnitCounts): number {
  return u.fighter + u.bomber;
}

/** Naval units (transport, submarine, destroyer, cruiser, carrier, battleship). */
export function countSea(u: UnitCounts): number {
  let s = 0;
  for (const t of NAVAL_UNIT_TYPES) s += u[t];
  return s;
}

/** Surface warships (1942 2e p.27): battleship, carrier, cruiser, destroyer. */
export function countSurfaceWarfare(u: UnitCounts): number {
  let s = 0;
  for (const t of SURFACE_WARSHIP_TYPES) s += u[t];
  return s;
}

export function addUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  const r = { ...a };
  for (const t of ALL_UNIT_TYPES) r[t] = a[t] + (b[t] ?? 0);
  return r;
}

function subUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  const r = { ...a };
  for (const t of ALL_UNIT_TYPES) r[t] = a[t] - (b[t] ?? 0);
  return r;
}

function hasEnough(have: UnitCounts, need: Partial<UnitCounts>): boolean {
  for (const t of ALL_UNIT_TYPES) {
    if ((need[t] ?? 0) > have[t]) return false;
  }
  return true;
}

function validCounts(u: Partial<UnitCounts>): boolean {
  return Object.values(u).every((v) => v === undefined || (Number.isInteger(v) && v >= 0));
}

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
    version: 2,
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

  const covered = new Set<string>();
  for (const h of scenario.holdings) {
    const def = territoryDef(h.territory);
    if (!def) throw new Error(`Scenario references unknown territory "${h.territory}".`);
    if (def.domain === 'sea') throw new Error(`Scenario holding "${h.territory}" is a sea zone.`);
    if (h.owner < 0 || h.owner >= numPlayers) throw new Error(`Bad owner for "${h.territory}".`);
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
  // Sea zones are never owned, never garrisoned, and exempt from scenario
  // coverage: they start as uncontrolled waters.
  for (const zid of seaZoneIds()) {
    state.territories[zid] = {
      owner: null,
      units: emptyUnits(),
      factory: false,
      factoryFresh: false,
      cargo: [],
    };
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

// ---------------------------------------------------------------- helpers ---

export function logEvent(
  state: GameState,
  kind: string,
  detail: string,
  rolls?: { side: string; dice: number[]; hits: number },
): void {
  state.events.push({
    seq: state.events.length + 1,
    round: state.round,
    player: state.currentPlayer,
    kind,
    detail,
    ...(rolls ? { rolls } : {}),
  });
}

function log(state: GameState, kind: string, detail: string): void {
  logEvent(state, kind, detail);
}

export function ownedTerritories(state: GameState, playerId: number): string[] {
  return Object.keys(state.territories).filter((t) => state.territories[t].owner === playerId);
}

export function incomeOf(state: GameState, playerId: number): number {
  return ownedTerritories(state, playerId).reduce((sum, t) => sum + ipcOf(t), 0);
}

export function ownsCapital(state: GameState, playerId: number): boolean {
  return state.territories[state.players[playerId].capital]?.owner === playerId;
}

function requirePhase(state: GameState, phases: Phase[]): ActionResult | null {
  if (!phases.includes(state.phase)) {
    return fail('wrong_phase', `Action not allowed in phase "${state.phase}".`);
  }
  return null;
}

function requireCurrentAlive(state: GameState, playerId: number): ActionResult | null {
  if (playerId !== state.currentPlayer) {
    return fail('not_your_turn', `It is ${state.players[state.currentPlayer].name}'s turn.`);
  }
  if (!state.players[playerId].alive) return fail('eliminated', 'You are eliminated.');
  return null;
}

/** Landing-legal territories: owned at turn start and still owned now.
 *  Land only — in navy phase 1 fighters cannot land at sea (no carriers yet). */
export function landingOptions(state: GameState, playerId: number): string[] {
  return state.ownedAtTurnStart.filter(
    (t) => isLand(t) && state.territories[t]?.owner === playerId,
  );
}

export function openBattles(state: GameState): Battle[] {
  return state.battles.filter((b) => !b.over);
}

const SHORT: Record<UnitType, string> = {
  infantry: 'inf',
  artillery: 'art',
  tank: 'tnk',
  fighter: 'ftr',
  bomber: 'bmb',
  aa: 'aa',
  transport: 'trn',
  submarine: 'sub',
  destroyer: 'dd',
  cruiser: 'ca',
  carrier: 'cv',
  battleship: 'bb',
};

export function describeUnits(u: UnitCounts, damagedBB = 0): string {
  const parts: string[] = [];
  for (const t of ALL_UNIT_TYPES) {
    if (u[t] <= 0) continue;
    if (t === 'battleship' && damagedBB > 0) parts.push(`${u[t]}bb(${damagedBB}dmg)`);
    else parts.push(`${u[t]}${SHORT[t]}`);
  }
  return parts.join('+') || 'none';
}

// --------------------------------------------------------------- naval ---

/** Land unit types a transport can carry (1942 2e p.30). */
const CARGO_TYPES: UnitType[] = ['infantry', 'artillery', 'tank', 'aa'];

/** Phase 1 simplification: a sea zone is hostile to `playerId` when another
 *  player controls it. The full 1942 2e rule (p.27) — lone submarines and
 *  transports neither make a zone hostile nor block movement — arrives with
 *  submarine mechanics in navy phase 2. */
function seaZoneHostileTo(
  work: Record<string, TerritoryState>,
  zid: string,
  playerId: number,
): boolean {
  // 1942 2e p.27: a sea zone is hostile only if it contains enemy surface
  // warships (battleship, carrier, cruiser, destroyer). Lone submarines and
  // transports neither make it hostile nor block movement. (Phase 1: sub and
  // carrier abilities are data-only, but the hostility rule applies.)
  const z = work[zid];
  if (!z) return false;
  const o = z.owner;
  if (o === null || o === undefined || o === playerId) return false;
  return SURFACE_WARSHIP_TYPES.some((t) => z.units[t] > 0);
}

/** Land units currently aboard `owner`'s transports in a sea zone. */
function cargoOf(work: Record<string, TerritoryState>, zid: string, owner: number): UnitCounts {
  const have = emptyUnits();
  for (const l of work[zid].cargo ?? []) {
    if (l.owner === owner) {
      for (const t of CARGO_TYPES) have[t] += l.units[t];
    }
  }
  return have;
}

/**
 * Load land units onto transports in a friendly sea zone (1942 2e p.30).
 * Capacity per transport: any one land unit plus one additional infantry.
 * Loads are repacked greedily; any packing is legal since loads are fungible.
 */
function embarkUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  add: Partial<UnitCounts>,
): ActionResult | null {
  for (const t of ALL_UNIT_TYPES) {
    if ((add[t] ?? 0) > 0 && !(CARGO_TYPES as UnitType[]).includes(t)) {
      return fail('bad_cargo', 'Transports carry land units only (infantry, artillery, tank, AA).');
    }
  }
  const want = emptyUnits();
  for (const t of CARGO_TYPES) want[t] = add[t] ?? 0;
  if (countUnits(want) === 0) return fail('empty_move', 'Nothing to load.');
  const zone = work[zid];
  const nT = zone.units.transport;
  if (nT === 0) return fail('no_transport', 'No transports in that sea zone.');
  const total = addUnits(cargoOf(work, zid, owner), want);
  const nonInf = total.artillery + total.tank + total.aa;
  if (nonInf > nT || countUnits(total) > 2 * nT) {
    return fail(
      'no_capacity',
      `Transports there can carry ${2 * nT} units with at most ${nT} non-infantry.`,
    );
  }
  const rem = { ...total };
  const loads: TransportLoad[] = [];
  while (countUnits(rem) > 0) {
    const e = emptyUnits();
    for (const t of ['artillery', 'tank', 'aa'] as const) {
      if (rem[t] > 0) {
        e[t] += 1;
        rem[t] -= 1;
        break;
      }
    }
    while (rem.infantry > 0 && countUnits(e) < 2) {
      e.infantry += 1;
      rem.infantry -= 1;
    }
    if (countUnits(e) === 0) break; // safety; unreachable given the capacity check
    loads.push({ owner, units: e });
  }
  zone.cargo = [...(zone.cargo ?? []).filter((l) => l.owner !== owner), ...loads];
  return null;
}

/** Take land units off transports (for an amphibious assault or a friendly offload). */
function disembarkUnits(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  want: Partial<UnitCounts>,
): ActionResult | null {
  const loads = (work[zid].cargo ?? []).filter((l) => l.owner === owner);
  if (!hasEnough(cargoOf(work, zid, owner), want)) {
    return fail('no_cargo', 'Those units are not aboard your transports there.');
  }
  const rem: Partial<UnitCounts> = { ...want };
  const kept: TransportLoad[] = [];
  for (const l of loads) {
    const take: Partial<UnitCounts> = {};
    for (const t of CARGO_TYPES) {
      const n = Math.min(l.units[t], rem[t] ?? 0);
      if (n > 0) {
        take[t] = n;
        rem[t] = (rem[t] ?? 0) - n;
      }
    }
    const left = subUnits(l.units, take);
    if (countUnits(left) > 0) kept.push({ owner, units: left });
  }
  work[zid].cargo = [...(work[zid].cargo ?? []).filter((l) => l.owner !== owner), ...kept];
  return null;
}

/** Move up to `nTransports` cargo entries along with departing transports (fullest first). */
function carryCargoAlong(
  work: Record<string, TerritoryState>,
  fromZ: string,
  toZ: string,
  owner: number,
  nTransports: number,
): void {
  const loads = (work[fromZ].cargo ?? [])
    .filter((l) => l.owner === owner)
    .sort((a, b) => countUnits(b.units) - countUnits(a.units));
  const moving = loads.slice(0, nTransports);
  const staying = loads.slice(nTransports);
  work[fromZ].cargo = [...(work[fromZ].cargo ?? []).filter((l) => l.owner !== owner), ...staying];
  work[toZ].cargo = [...(work[toZ].cargo ?? []), ...moving];
}

/**
 * Destroy `n` transports' worth of cargo when the transports die in combat
 * (1942 2e p.30: cargo is destroyed with its transport). Fullest loads first.
 * Returns the number of land units lost.
 */
function destroyCargo(
  work: Record<string, TerritoryState>,
  zid: string,
  owner: number,
  n: number,
): number {
  const loads = (work[zid].cargo ?? [])
    .filter((l) => l.owner === owner)
    .sort((a, b) => countUnits(b.units) - countUnits(a.units));
  const lost = loads.slice(0, n).reduce((s, l) => s + countUnits(l.units), 0);
  const kept = loads.slice(n);
  work[zid].cargo = [...(work[zid].cargo ?? []).filter((l) => l.owner !== owner), ...kept];
  return lost;
}

/** Undamaged battleships in a force: candidates to absorb hits (1942 2e p.27). */
function undamagedBB(force: UnitCounts, damaged: number): number {
  return Math.max(0, force.battleship - damaged);
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
    usedWork[terr] = addUnits(usedWork[terr] ?? emptyUnits(), u);
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
   * Returns null on success, an ActionResult failure otherwise.
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

    // --- sea -> sea: fleet movement or sea attack ---
    if (fromSea && toSea) {
      if (move.embark || move.disembark) return fail('bad_move', 'embark/disembark are for land/sea transfers.');
      if (landN > 0 || aaN > 0) return fail('no_land_at_sea', 'Only naval and air units operate at sea.');
      const destOwner = work[move.to].owner;
      const hostile = destOwner !== null && destOwner !== playerId;
      // Ships move up to 2 sea zones without crossing hostile waters (p.27);
      // aircraft fly over anything within their move value.
      if (seaN > 0) {
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
      if (!hasEnough(work[move.from].units, units)) {
        return fail('too_few_units', `Not enough units in ${move.from}.`);
      }
      if (hostile) {
        // 1942 2e p.30: transports may not attack without an escorting combat unit.
        let power = 0;
        for (const t of ALL_UNIT_TYPES) {
          if ((units[t] ?? 0) > 0 && UNITS[t].attack > 0) power += units[t] ?? 0;
        }
        if (power === 0) return fail('no_escort', 'Transports may not attack unescorted (1942 2e p.30).');
        const b = getBattle(move.to, destOwner, 'combat');
        if ('ok' in b) return b;
        b.attack = addUnits(b.attack, units);
        if (!b.origins.includes(move.from)) b.origins.push(move.from);
      } else {
        work[move.to].units = addUnits(work[move.to].units, units);
        if (seaN > 0 && work[move.to].owner === null) work[move.to].owner = playerId;
      }
      work[move.from].units = subUnits(work[move.from].units, units);
      const nTrn = units.transport ?? 0;
      if (nTrn > 0) carryCargoAlong(work, move.from, move.to, playerId, nTrn);
      if (countSea(work[move.from].units) === 0) work[move.from].owner = null;
      markUsed(move.from, units);
      return null;
    }

    // --- land -> sea: embark land units onto transports ---
    if (!fromSea && toSea) {
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
      const err = embarkUnits(work, move.to, playerId, units);
      if (err) return err;
      work[move.from].units = subUnits(work[move.from].units, units);
      markUsed(move.from, units);
      return null;
    }

    // --- sea -> land: disembark. In the combat-move phase this is always an
    // amphibious assault (1942 2e p.15); friendly offloads wait for non-combat.
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
    // Phase 1: the launch zone must already be friendly. The full 1942 2e
    // sequence (sea battle then assault from the same zone in one turn)
    // needs cross-battle ordering; it arrives in navy phase 2.
    if (seaZoneHostileTo(work, move.from, playerId)) {
      return fail('hostile_waters', 'Amphibious assaults launch from a friendly sea zone in phase 1.');
    }
    const err = disembarkUnits(work, move.from, playerId, units);
    if (err) return err;
    const b = getBattle(move.to, destOwner, 'combat');
    if ('ok' in b) return b;
    b.attack = addUnits(b.attack, units);
    if (!b.origins.includes(move.from)) b.origins.push(move.from);
    b.amphibiousFrom = move.from;
    b.seaborne = addUnits(b.seaborne ?? emptyUnits(), units);
    return null;
  };

  for (const move of moves) {
    if (!territoryDef(move.from)) return fail('unknown_territory', `Unknown territory "${move.from}".`);
    if (!territoryDef(move.to)) return fail('unknown_territory', `Unknown territory "${move.to}".`);
    if (!validCounts(move.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (countUnits({ ...emptyUnits(), ...move.units }) === 0) {
      return fail('empty_move', 'Each move must move at least one unit.');
    }
    if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);

    // Any leg at sea takes the naval path (fleet movement, sea attack, embark/disembark).
    if (isSea(move.from) || isSea(move.to)) {
      const err = navalCombatMove(move, playerId);
      if (err) return err;
      continue;
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

  // Amphibious bombardment eligibility (1942 2e p.15): battleships and cruisers
  // in the launch zone may shell the target when no sea battle was fought
  // there, at most one ship per offloaded land unit. Decided here from final
  // positions, so supporting ships may move in during the same combat move.
  for (const wb of workBattles) {
    if (!wb.amphibiousFrom) continue;
    const z = work[wb.amphibiousFrom];
    const seaborneLand = countLand(wb.seaborne ?? emptyUnits());
    const n = Math.min(z.units.battleship + z.units.cruiser, seaborneLand);
    const nbb = Math.min(z.units.battleship, n);
    wb.bombard = { battleship: nbb, cruiser: n - nbb };
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
  if (victim.capital === terrId) {
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
  // FFA Decision (Ian, Oct 3 2026): Majority of capitals held simultaneously wins.
  // For 4 players: 3 of 4. Scenario/map may override via capitalsToWin.
  const holders = new Map<number, number>();
  for (const p of state.players) {
    const holder = state.territories[p.capital]?.owner;
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

// ------------------------------------------------------------------ combat ---

function rollHits(state: GameState, count: number, value: number): { dice: number[]; hits: number } {
  const dice: number[] = [];
  let hits = 0;
  for (let i = 0; i < count; i++) {
    const d = rollDie(state);
    dice.push(d);
    if (d <= value) hits++;
  }
  return { dice, hits };
}

function attackerRolls(state: GameState, atk: UnitCounts): { dice: number[]; hits: number } {
  const dice: number[] = [];
  let hits = 0;
  const boosted = Math.min(atk.infantry, atk.artillery); // 1:1 artillery pairing
  for (let i = 0; i < atk.infantry; i++) {
    const v = i < boosted ? (UNITS.infantry.boostedAttack as number) : UNITS.infantry.attack;
    const d = rollDie(state);
    dice.push(d);
    if (d <= v) hits++;
  }
  const rest: Array<[UnitType, number, number]> = [
    ['artillery', atk.artillery, UNITS.artillery.attack],
    ['tank', atk.tank, UNITS.tank.attack],
    ['fighter', atk.fighter, UNITS.fighter.attack],
    ['bomber', atk.bomber, UNITS.bomber.attack],
    ['submarine', atk.submarine, UNITS.submarine.attack],
    ['destroyer', atk.destroyer, UNITS.destroyer.attack],
    ['cruiser', atk.cruiser, UNITS.cruiser.attack],
    ['carrier', atk.carrier, UNITS.carrier.attack],
    ['battleship', atk.battleship, UNITS.battleship.attack],
  ];
  for (const [, n, v] of rest) {
    if (n <= 0 || v <= 0) continue; // transports have no combat value (1942 2e p.30)
    const r = rollHits(state, n, v);
    dice.push(...r.dice);
    hits += r.hits;
  }
  return { dice, hits };
}

function defenderRolls(state: GameState, def: UnitCounts): { dice: number[]; hits: number } {
  const dice: number[] = [];
  let hits = 0;
  const parts: Array<[number, number]> = [
    [def.infantry, UNITS.infantry.defense],
    [def.artillery, UNITS.artillery.defense],
    [def.tank, UNITS.tank.defense],
    [def.fighter, UNITS.fighter.defense],
    [def.bomber, UNITS.bomber.defense],
    [def.submarine, UNITS.submarine.defense],
    [def.destroyer, UNITS.destroyer.defense],
    [def.cruiser, UNITS.cruiser.defense],
    [def.carrier, UNITS.carrier.defense],
    [def.battleship, UNITS.battleship.defense],
  ];
  for (const [n, v] of parts) {
    if (n <= 0 || v <= 0) continue;
    const r = rollHits(state, n, v);
    dice.push(...r.dice);
    hits += r.hits;
  }
  return { dice, hits };
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
      const victim = b.defenderId;
      if (victim !== null) {
        state.players[victim].ipcs = Math.max(0, state.players[victim].ipcs - damage);
      }
      b.sbrStruck = true;
      b.over = true;
      b.result = 'sbr_done';
      logEvent(state, 'sbr', `${state.players[playerId].name} bombs ${territoryId} for ${damage} IPC damage (${rolls.join(',')}).`, {
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
      state.used[b.amphibiousFrom] = addUnits(state.used[b.amphibiousFrom] ?? emptyUnits(), {
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

  const a = attackerRolls(state, b.attack);
  const d = defenderRolls(state, state.territories[territoryId].units);
  b.rounds++;
  b.pendingAttacker += d.hits;
  b.pendingDefender += a.hits;
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
    },
  };
}

/**
 * Cheapest first; transports last (1942 2e p.30); AA never (captured instead).
 * Undamaged battleships absorb hits first: the first hit damages rather than
 * destroying (1942 2e p.27). `undamagedBB` is the force's battleships minus
 * those already damaged in this combat.
 */
export function autoCasualtyPolicy(
  force: UnitCounts,
  hits: number,
  undamagedBB = 0,
): { removed: Partial<UnitCounts>; damaged: number } {
  const damaged = Math.min(hits, undamagedBB);
  let left = hits - damaged;
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
  left = Math.min(left, countUnits({ ...force, aa: 0 }));
  for (const t of order) {
    if (left <= 0) break;
    const take = Math.min(force[t], left);
    if (take > 0) {
      removed[t] = take;
      left -= take;
    }
  }
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

/** Destroy transport cargo when transports die in a sea battle (1942 2e p.30). */
function sinkTransportCargo(
  state: GameState,
  b: Battle,
  side: 'attacker' | 'defender',
  nTransports: number,
): void {
  if (nTransports <= 0 || !isSea(b.territoryId)) return;
  const owner = side === 'attacker' ? b.attackerId : b.defenderId;
  if (owner === null || owner === undefined) return;
  const lost = destroyCargo(state.territories, b.territoryId, owner, nTransports);
  if (lost > 0) {
    log(state, 'sink', `${lost} embarked land unit(s) go down with their transports in ${b.territoryId}.`);
  }
}

function validateCasualtySelection(
  force: UnitCounts,
  pending: number,
  units: Partial<UnitCounts>,
): ActionResult | null {
  if (!validCounts(units)) return fail('bad_count', 'Casualty counts must be non-negative integers.');
  if ((units.aa ?? 0) > 0) return fail('aa_spared', 'AA guns are captured, never taken as casualties.');
  if (!hasEnough(force, units)) return fail('too_few_units', 'You cannot lose units you do not have.');
  const selected = countUnits({ ...emptyUnits(), ...units });
  const required = Math.min(pending, countUnits({ ...force, aa: 0 }));
  if (selected !== required) {
    return fail('bad_casualties', `You must remove exactly ${required} unit(s) (${pending} hits).`);
  }
  return null;
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
    const bad = validateCasualtySelection(b.attack, b.pendingAttacker, units);
    if (bad) return bad;
    const toRemove = applyBBCasualties(b, 'attacker', b.attack, units);
    b.attack = subUnits(b.attack, toRemove);
    sinkTransportCargo(state, b, 'attacker', toRemove.transport ?? 0);
    b.pendingAttacker = 0;
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
    const bad = validateCasualtySelection(def, b.pendingDefender, units);
    if (bad) return bad;
    const toRemove = applyBBCasualties(b, 'defender', def, units);
    state.territories[territoryId].units = subUnits(def, toRemove);
    sinkTransportCargo(state, b, 'defender', toRemove.transport ?? 0);
    b.pendingDefender = 0;
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
    );
    b.damagedAttackBB += damaged;
    b.damagedAttackBB = Math.max(0, b.damagedAttackBB - Math.min(removed.battleship ?? 0, b.damagedAttackBB));
    b.attack = subUnits(b.attack, removed);
    sinkTransportCargo(state, b, 'attacker', removed.transport ?? 0);
    b.pendingAttacker = 0;
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
    );
    b.damagedDefBB += damaged;
    b.damagedDefBB = Math.max(0, b.damagedDefBB - Math.min(removed.battleship ?? 0, b.damagedDefBB));
    state.territories[territoryId].units = subUnits(def, removed);
    sinkTransportCargo(state, b, 'defender', removed.transport ?? 0);
    b.pendingDefender = 0;
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

function evaluateBattleEnd(state: GameState, b: Battle): void {
  const terr = state.territories[b.territoryId];

  // Sea battle (1942 2e pp.27-30): no capture mechanics — the attacker seizes
  // the zone by clearing it. Surviving damaged battleships on either side are
  // repaired when the combat ends (p.27).
  if (isSea(b.territoryId)) {
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
        b.over = true;
        b.result = 'sea_taken';
        log(state, 'battle_end', `${state.players[b.attackerId].name} seizes ${b.territoryId}.`);
      } else {
        b.over = true;
        b.result = 'air_only';
        log(state, 'battle_end', `Only aircraft survive over ${b.territoryId}; they must land.`);
      }
      b.pendingAttacker = 0;
      b.pendingDefender = 0;
      return;
    }
    if (atkSea + atkAir === 0) {
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
  if (!b.origins.includes(toId)) return fail('bad_retreat', 'Units retreat to a territory they attacked from.');
  // Warships may withdraw into the open waters they sailed from: a sea zone
  // emptied by the attack itself reverts to owner null (1942 2e p.27).
  const destOwner = state.territories[toId]?.owner;
  const seaOpenWaterRetreat = isSea(territoryId) && isSea(toId) && destOwner === null;
  if (destOwner !== playerId && !seaOpenWaterRetreat) {
    return fail('bad_retreat', 'The retreat destination must still be yours.');
  }

  // Sea battle: warships withdraw to a friendly sea origin; cargo rides along.
  // Aircraft stay aloft and must land in the non-combat phase.
  if (isSea(territoryId)) {
    if (!isSea(toId)) return fail('bad_retreat', 'Warships retreat to a sea zone they attacked from.');
    const sea: Partial<UnitCounts> = {};
    for (const t of NAVAL_UNIT_TYPES) sea[t] = b.attack[t];
    state.territories[toId].units = addUnits(state.territories[toId].units, sea);
    carryCargoAlong(state.territories, territoryId, toId, playerId, sea.transport ?? 0);
    state.used[toId] = addUnits(state.used[toId] ?? emptyUnits(), sea);
    b.attack = subUnits(b.attack, sea);
    b.over = true;
    b.result = 'retreated';
    b.pendingAttacker = 0;
    b.pendingDefender = 0;
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
    const used = usedWork[terr] ?? emptyUnits();
    const base = emptyUnits();
    for (const u of ALL_UNIT_TYPES) {
      base[u] = u === 'fighter' || u === 'bomber' ? t.units[u] : Math.max(0, t.units[u] - used[u]);
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
    usedWork[terr] = addUnits(usedWork[terr] ?? emptyUnits(), add);
  };

  /**
   * Naval leg of a non-combat move (1942 2e pp.13, 30): fleet repositioning
   * and transport ferrying ("bridging"), all within friendly waters.
   * Returns null on success, an ActionResult failure otherwise.
   */
  const navalNonCombatMove = (move: NonCombatMove, playerId: number): ActionResult | null => {
    const fromSea = isSea(move.from);
    const toSea = isSea(move.to);
    const units = move.units;
    const full = { ...emptyUnits(), ...units };
    const seaN = countSea(full);
    const landN = countLand(full);
    const airN = countAir(full);
    const aaN = units.aa ?? 0;
    const zoneFriendly = (z: string): boolean => {
      const o = work[z].owner;
      return o === null || o === playerId;
    };

    // --- sea -> sea: reposition the fleet ---
    if (fromSea && toSea) {
      if (move.embark || move.disembark) return fail('bad_move', 'embark/disembark are for land/sea transfers.');
      if (landN > 0 || airN > 0 || aaN > 0) {
        return fail('no_air_land_at_sea', 'Only naval units reposition at sea.');
      }
      if (!zoneFriendly(move.to)) return fail('not_owner', 'Non-combat moves stay in friendly waters.');
      const reach = seaReachable(move.from, UNITS.transport.move, (z) => zoneFriendly(z));
      if (!reach.has(move.to)) {
        return fail('range', `Ships in ${move.from} cannot reach ${move.to} (2 friendly sea zones).`);
      }
      if (!hasEnough(avail(move.from), units)) {
        return fail('too_few_units', `Not enough available units in ${move.from}.`);
      }
      work[move.from].units = subUnits(work[move.from].units, units);
      work[move.to].units = addUnits(work[move.to].units, units);
      if (seaN > 0 && work[move.to].owner === null) work[move.to].owner = playerId;
      const nTrn = units.transport ?? 0;
      if (nTrn > 0) carryCargoAlong(work, move.from, move.to, playerId, nTrn);
      if (countSea(work[move.from].units) === 0) work[move.from].owner = null;
      markNonCombatUsed(move.from, units);
      return null;
    }

    // --- land -> sea: embark land units onto transports ---
    if (!fromSea && toSea) {
      if (!move.embark) return fail('embark_flag', 'Loading transports requires embark: true.');
      if (seaN > 0 || airN > 0) return fail('bad_cargo', 'Only land units embark onto transports.');
      if (!zoneFriendly(move.to)) return fail('not_owner', 'Non-combat moves stay in friendly waters.');
      if (!areAdjacent(move.from, move.to)) {
        return fail('range', 'Transports load from an adjacent coastal territory.');
      }
      if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);
      if (!hasEnough(avail(move.from), units)) {
        return fail('too_few_units', `Not enough available units in ${move.from}.`);
      }
      const err = embarkUnits(work, move.to, playerId, units);
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
    if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);
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
    const fromOwned = work[move.from].owner === playerId;
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
    // Aircraft must end on a legal landing spot (owned at turn start, still owned).
    if (countAir({ ...emptyUnits(), ...move.units }) > 0 && !landingOptions(state, playerId).includes(move.to)) {
      return fail('no_landing', `${move.to} is not a legal landing spot (must be owned since turn start).`);
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
      work[move.from].units = subUnits(work[move.from].units, want);
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
        if ((p.units[t] ?? 0) > 0 && !(NAVAL_UNIT_TYPES as UnitType[]).includes(t)) {
          return fail('bad_unit', `Only naval units mobilize into sea zones (not ${t}).`);
        }
      }
      // Phase 1: no mobilizing into hostile waters. 1942 2e p.21 permits it,
      // but multi-owner sea zones arrive with fuller naval rules in phase 2.
      const zOwner = state.territories[p.seaZone].owner;
      if (zOwner !== null && zOwner !== playerId) {
        return fail('hostile_waters', 'Phase 1: mobilize into friendly or empty waters only.');
      }
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
    state.territories[target].units = addUnits(state.territories[target].units, p.units);
    if (p.seaZone && countSea(state.territories[p.seaZone].units) > 0) {
      state.territories[p.seaZone].owner = playerId;
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
      // Aircraft not on a legal landing spot are lost.
      const legal = new Set(landingOptions(state, playerId));
      let lost = 0;
      for (const [tid, terr] of Object.entries(state.territories)) {
        if (terr.owner !== playerId) continue;
        if (legal.has(tid)) continue;
        lost += terr.units.fighter + terr.units.bomber;
        terr.units.fighter = 0;
        terr.units.bomber = 0;
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

// --------------------------------------------------------------------- chat ---

export function sendMessage(
  state: GameState,
  senderId: number,
  recipients: string,
  text: string,
): ActionResult {
  const sender = state.players[senderId];
  if (!sender) return fail('unknown_player', `Unknown player ${senderId}.`);
  if (typeof recipients !== 'string' || recipients.trim() === '') {
    return fail('bad_recipients', 'Recipients must be a non-empty string ("all" or player names).');
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('bad_message', 'Message text must be non-empty.');
  }
  if (text.length > MAX_CHAT_LENGTH) {
    return fail('message_too_long', `Messages are limited to ${MAX_CHAT_LENGTH} characters.`);
  }
  const msg: ChatMessage = {
    sender: sender.name,
    recipients: recipients.trim(),
    text: text.trim(),
    round: state.round,
  };
  state.chatLog.push(msg);
  log(state, 'chat', `${sender.name} -> ${msg.recipients}: ${msg.text}`);
  return { ok: true };
}

// --------------------------------------------------------------- summarize ---

function fmtUnits(u: UnitCounts): string {
  const s = describeUnits(u);
  return s === 'none' ? 'empty' : s;
}

export function summarizeState(state: GameState, playerId: number): string {
  const me = state.players[playerId];
  if (!me) return 'Unknown player.';
  const lines: string[] = [];
  lines.push(`Round ${state.round}, ${state.players[state.currentPlayer].name} to move (phase ${state.phase}). You are ${me.name}. Bank ${me.ipcs}, income ${incomeOf(state, playerId)}.`);
  for (const p of state.players) {
    const terrs = ownedTerritories(state, p.id).length;
    const cap = state.territories[p.capital];
    const capStatus = cap.owner === p.id ? 'holds capital' : cap.owner === null ? 'capital neutral' : `capital held by ${state.players[cap.owner].name}`;
    const factories = Object.keys(state.territories).filter(
      (t) => state.territories[t].owner === p.id && state.territories[t].factory,
    );
    lines.push(`${p.name}${p.alive ? '' : ' (OUT)'}: ${terrs} terr, bank ${p.ipcs}, income ${incomeOf(state, p.id)}, ${capStatus}, factories [${factories.join(',') || 'none'}].`);
  }
  const mine = ownedTerritories(state, playerId)
    .map((t) => `${t}(${ipcOf(t)}):${fmtUnits(state.territories[t].units)}${state.territories[t].factory ? '+FAC' : ''}`)
    .join(' ');
  lines.push(`Yours: ${mine}`);
  const others = Object.keys(state.territories)
    .filter((t) => state.territories[t].owner !== playerId)
    .map((t) => {
      const s = state.territories[t];
      const owner = s.owner === null ? 'neutral' : state.players[s.owner].name;
      return `${t}(${ipcOf(t)},${owner}):${fmtUnits(s.units)}`;
    })
    .join(' ');
  lines.push(`Others: ${others}`);
  for (const b of state.battles) {
    lines.push(`Battle ${b.territoryId} (${b.kind}): atk ${fmtUnits(b.attack)} vs def ${fmtUnits(state.territories[b.territoryId].units)}${b.over ? ` over=${b.result}` : ''}.`);
  }
  if (state.winner !== null) lines.push(`Winner: ${state.players[state.winner].name} (${state.winReason}).`);
  return lines.join(' ');
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).length;
}

// ------------------------------------------------------------- persistence ---

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

export function deserialize(json: string): GameState {
  const data = JSON.parse(json) as GameState;
  if (!data || data.version !== 2) throw new Error('Unsupported save version.');
  for (const t of MAP.territories) {
    const s = data.territories?.[t.id];
    if (!s || s.owner === undefined || !s.units) {
      throw new Error(`Save file has invalid data for territory "${t.id}".`);
    }
    // Saves from before navy phase 1 lack the cargo manifest.
    if (!Array.isArray(s.cargo)) s.cargo = [];
    for (const u of ALL_UNIT_TYPES) {
      if (s.units[u] === undefined) s.units[u] = 0;
    }
  }
  if (!Array.isArray(data.players) || !Array.isArray(data.battles)) {
    throw new Error('Save file is missing game data.');
  }
  // Saves from before navy phase 1 lack the naval battle fields.
  for (const b of data.battles) {
    if (b.bombardDone === undefined) b.bombardDone = false;
    if (b.bombardDoomed === undefined) b.bombardDoomed = 0;
    if (b.damagedAttackBB === undefined) b.damagedAttackBB = 0;
    if (b.damagedDefBB === undefined) b.damagedDefBB = 0;
  }
  return data;
}
