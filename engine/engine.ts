import {
  MAP,
  UNITS,
  airDistance,
  areAdjacent,
  ipcOf,
  landPaths,
  neighborsOf,
  scenarioFor,
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
  UnitCounts,
} from './types';

export const PLAYER_COLORS = ['#6b7a3f', '#3e5a78', '#7e3b3b', '#b49b62'];
export const MAX_CHAT_LENGTH = 500;
export const DEFAULT_TURN_CAP = 20;
export const LAND_UNIT_TYPES: UnitType[] = ['infantry', 'artillery', 'tank'];
export const AIR_UNIT_TYPES: UnitType[] = ['fighter', 'bomber'];

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
  return { infantry: 0, artillery: 0, tank: 0, fighter: 0, bomber: 0, aa: 0 };
}

export function countUnits(u: UnitCounts): number {
  return u.infantry + u.artillery + u.tank + u.fighter + u.bomber + u.aa;
}

export function countLand(u: UnitCounts): number {
  return u.infantry + u.artillery + u.tank;
}

export function countAir(u: UnitCounts): number {
  return u.fighter + u.bomber;
}

export function addUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  return {
    infantry: a.infantry + (b.infantry ?? 0),
    artillery: a.artillery + (b.artillery ?? 0),
    tank: a.tank + (b.tank ?? 0),
    fighter: a.fighter + (b.fighter ?? 0),
    bomber: a.bomber + (b.bomber ?? 0),
    aa: a.aa + (b.aa ?? 0),
  };
}

function subUnits(a: UnitCounts, b: Partial<UnitCounts>): UnitCounts {
  return {
    infantry: a.infantry - (b.infantry ?? 0),
    artillery: a.artillery - (b.artillery ?? 0),
    tank: a.tank - (b.tank ?? 0),
    fighter: a.fighter - (b.fighter ?? 0),
    bomber: a.bomber - (b.bomber ?? 0),
    aa: a.aa - (b.aa ?? 0),
  };
}

function hasEnough(have: UnitCounts, need: Partial<UnitCounts>): boolean {
  return (
    (need.infantry ?? 0) <= have.infantry &&
    (need.artillery ?? 0) <= have.artillery &&
    (need.tank ?? 0) <= have.tank &&
    (need.fighter ?? 0) <= have.fighter &&
    (need.bomber ?? 0) <= have.bomber &&
    (need.aa ?? 0) <= have.aa
  );
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
    if (h.owner < 0 || h.owner >= numPlayers) throw new Error(`Bad owner for "${h.territory}".`);
    const units = emptyUnits();
    for (const [type, n] of Object.entries(h.units ?? {})) {
      if (!(type in units) || !Number.isInteger(n) || (n as number) < 0) {
        throw new Error(`Bad unit entry ${type}x${n} in "${h.territory}".`);
      }
      units[type as UnitType] = n as number;
    }
    state.territories[h.territory] = {
      owner: h.owner,
      units,
      factory: h.factory === true,
      factoryFresh: false,
    };
    covered.add(h.territory);
  }
  for (const [tid, units] of Object.entries(scenario.neutrals)) {
    if (!territoryDef(tid)) throw new Error(`Scenario references unknown territory "${tid}".`);
    const u = emptyUnits();
    for (const [type, n] of Object.entries(units ?? {})) {
      u[type as UnitType] = n as number;
    }
    state.territories[tid] = { owner: null, units: u, factory: false, factoryFresh: false };
    covered.add(tid);
  }
  if (covered.size !== MAP.territories.length) {
    throw new Error('Scenario does not cover every territory.');
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

/** Landing-legal territories: owned at turn start and still owned now. */
export function landingOptions(state: GameState, playerId: number): string[] {
  return state.ownedAtTurnStart.filter((t) => state.territories[t]?.owner === playerId);
}

export function openBattles(state: GameState): Battle[] {
  return state.battles.filter((b) => !b.over);
}

export function describeUnits(u: UnitCounts): string {
  const parts: string[] = [];
  if (u.infantry) parts.push(`${u.infantry}inf`);
  if (u.artillery) parts.push(`${u.artillery}art`);
  if (u.tank) parts.push(`${u.tank}tnk`);
  if (u.fighter) parts.push(`${u.fighter}ftr`);
  if (u.bomber) parts.push(`${u.bomber}bmb`);
  if (u.aa) parts.push(`${u.aa}aa`);
  return parts.join('+') || 'none';
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

  for (const move of moves) {
    if (!territoryDef(move.from)) return fail('unknown_territory', `Unknown territory "${move.from}".`);
    if (!territoryDef(move.to)) return fail('unknown_territory', `Unknown territory "${move.to}".`);
    if (!validCounts(move.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (countUnits({ ...emptyUnits(), ...move.units }) === 0) {
      return fail('empty_move', 'Each move must move at least one unit.');
    }
    if ((move.units.aa ?? 0) > 0) return fail('aa_no_attack', 'AA guns cannot move in the combat-move phase.');
    if (work[move.from].owner !== playerId) return fail('not_owner', `You do not hold ${move.from}.`);
    if (!hasEnough(work[move.from].units, move.units)) {
      return fail('too_few_units', `Not enough units in ${move.from}.`);
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
  if (ownedTerritories(state, prevOwner).length === 0) {
    victim.alive = false;
    log(state, 'eliminate', `${victim.name} is eliminated (no territories left).`);
  }
  checkWinByCapitals(state);
}

function checkWinByCapitals(state: GameState): void {
  // FFA Decision (Ian, Oct 3 2026): Majority of capitals held simultaneously wins.
  // For 4 players: 3 of 4. Map-specific victory conditions going forward.
  const holders = new Map<number, number>();
  for (const p of state.players) {
    const holder = state.territories[p.capital]?.owner;
    if (holder !== null && holder !== undefined) {
      holders.set(holder, (holders.get(holder) ?? 0) + 1);
    }
  }
  const majority = Math.floor(state.players.length / 2) + 1;
  for (const [holder, count] of holders) {
    if (count >= majority) {
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
  const rest: Array<[number, number]> = [
    [atk.artillery, UNITS.artillery.attack],
    [atk.tank, UNITS.tank.attack],
    [atk.fighter, UNITS.fighter.attack],
    [atk.bomber, UNITS.bomber.attack],
  ];
  for (const [n, v] of rest) {
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
  ];
  for (const [n, v] of parts) {
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
  let aaRolls: number[] = [];
  let aaHits = 0;
  if (!b.aaFired) {
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
    const removed = autoCasualtyPolicy(state.territories[territoryId].units, b.pendingDefender);
    state.territories[territoryId].units = subUnits(state.territories[territoryId].units, removed);
    log(state, 'casualties', `Neutral garrison in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...removed })}.`);
    b.pendingDefender = 0;
    b.defenderResolved = true;
  }

  if (b.attackerResolved && b.defenderResolved) {
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
    },
  };
}

/** Cheapest / lowest-defense first. AA is never a casualty (captured instead). */
export function autoCasualtyPolicy(force: UnitCounts, hits: number): Partial<UnitCounts> {
  const order: UnitType[] = ['infantry', 'artillery', 'tank', 'fighter', 'bomber'];
  const removed: Partial<UnitCounts> = {};
  let left = Math.min(hits, countUnits({ ...force, aa: 0 }));
  for (const t of order) {
    if (left <= 0) break;
    const take = Math.min(force[t], left);
    if (take > 0) {
      removed[t] = take;
      left -= take;
    }
  }
  return removed;
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
    b.attack = subUnits(b.attack, units);
    b.pendingAttacker = 0;
    b.attackerResolved = true;
    log(state, 'casualties', `Attacker in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...units })}.`);
  } else {
    if (b.defenderId === null) return fail('auto', 'Neutral casualties are applied automatically.');
    if (b.pendingDefender === 0 || b.defenderResolved) return fail('none_pending', 'No defender casualties pending.');
    const def = state.territories[territoryId].units;
    const bad = validateCasualtySelection(def, b.pendingDefender, units);
    if (bad) return bad;
    state.territories[territoryId].units = subUnits(def, units);
    b.pendingDefender = 0;
    b.defenderResolved = true;
    log(state, 'casualties', `Defender in ${territoryId} loses ${describeUnits({ ...emptyUnits(), ...units })}.`);
  }
  if (b.attackerResolved && b.defenderResolved) {
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
    const removed = autoCasualtyPolicy(b.attack, b.pendingAttacker);
    b.attack = subUnits(b.attack, removed);
    b.pendingAttacker = 0;
    b.attackerResolved = true;
    log(state, 'casualties', `Attacker in ${territoryId} auto-loses ${describeUnits({ ...emptyUnits(), ...removed })}.`);
  } else {
    if (b.pendingDefender === 0 || b.defenderResolved) return fail('none_pending', 'No defender casualties pending.');
    const def = state.territories[territoryId].units;
    const removed = autoCasualtyPolicy(def, b.pendingDefender);
    state.territories[territoryId].units = subUnits(def, removed);
    b.pendingDefender = 0;
    b.defenderResolved = true;
    log(state, 'casualties', `Defender in ${territoryId} auto-loses ${describeUnits({ ...emptyUnits(), ...removed })}.`);
  }
  if (b.attackerResolved && b.defenderResolved) {
    evaluateBattleEnd(state, b);
  }
  return { ok: true };
}

function evaluateBattleEnd(state: GameState, b: Battle): void {
  const terr = state.territories[b.territoryId];
  const defNoAA = countUnits({ ...terr.units, aa: 0 });
  const atkLand = countLand(b.attack);
  const atkTotal = countUnits(b.attack);

  if (defNoAA === 0) {
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
  if (!b.origins.includes(toId)) return fail('bad_retreat', 'Land units retreat to one territory they attacked from.');
  if (state.territories[toId]?.owner !== playerId) {
    return fail('bad_retreat', 'The retreat destination must still be yours.');
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
  return {
    infantry: Math.max(0, t.units.infantry - used.infantry),
    artillery: Math.max(0, t.units.artillery - used.artillery),
    tank: Math.max(0, t.units.tank - used.tank),
    fighter: t.units.fighter,
    bomber: t.units.bomber,
    aa: Math.max(0, t.units.aa - used.aa),
  };
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
    const base: UnitCounts = {
      infantry: Math.max(0, t.units.infantry - used.infantry),
      artillery: Math.max(0, t.units.artillery - used.artillery),
      tank: Math.max(0, t.units.tank - used.tank),
      fighter: t.units.fighter,
      bomber: t.units.bomber,
      aa: Math.max(0, t.units.aa - used.aa),
    };
    return addUnits(base, airAloft[terr] ?? emptyUnits());
  };

  for (const move of moves) {
    if (!territoryDef(move.from)) return fail('unknown_territory', `Unknown territory "${move.from}".`);
    if (!territoryDef(move.to)) return fail('unknown_territory', `Unknown territory "${move.to}".`);
    if (!validCounts(move.units)) return fail('bad_count', 'Unit counts must be non-negative integers.');
    if (countUnits({ ...emptyUnits(), ...move.units }) === 0) {
      return fail('empty_move', 'Each move must move at least one unit.');
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
      usedWork[move.from] = addUnits(usedWork[move.from] ?? emptyUnits(), {
        infantry: want.infantry ?? 0,
        artillery: want.artillery ?? 0,
        tank: want.tank ?? 0,
        aa: want.aa ?? 0,
      });
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
    state.territories[p.territory].units = addUnits(state.territories[p.territory].units, p.units);
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
  }
  if (!Array.isArray(data.players) || !Array.isArray(data.battles)) {
    throw new Error('Save file is missing game data.');
  }
  return data;
}
