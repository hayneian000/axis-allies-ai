export interface UnitCounts {
  infantry: number;
  artillery: number;
  tank: number;
  fighter: number;
  bomber: number;
  aa: number;
}

export type PurchasableType =
  | 'infantry'
  | 'artillery'
  | 'tank'
  | 'fighter'
  | 'bomber'
  | 'aa'
  | 'factory';

export interface PurchaseItem {
  type: PurchasableType;
  count: number;
}

export interface TerritoryState {
  /** null = neutral (unowned). */
  owner: number | null;
  units: UnitCounts;
  factory: boolean;
  /** True when built or captured this turn: cannot produce until next turn. */
  factoryFresh: boolean;
}

export interface PlayerState {
  id: number;
  name: string;
  color: string;
  alive: boolean;
  /** IPC bank. */
  ipcs: number;
  capital: string;
}

export type Phase = 'purchase' | 'combatMove' | 'combat' | 'nonCombat' | 'mobilize' | 'gameover';

export type BattleKind = 'combat' | 'sbr';
export type BattleResult =
  | 'captured'
  | 'defender_holds'
  | 'air_only'
  | 'retreated'
  | 'sbr_done';

export interface Battle {
  id: number;
  territoryId: string;
  attackerId: number;
  /** null = neutral garrison. */
  defenderId: number | null;
  kind: BattleKind;
  /** Attacker units currently in the territory (air stays here until landed). */
  attack: UnitCounts;
  /** Origin territories of the attacking land units (retreat targets). */
  origins: string[];
  aaFired: boolean;
  sbrStruck: boolean;
  rounds: number;
  pendingAttacker: number;
  pendingDefender: number;
  attackerResolved: boolean;
  defenderResolved: boolean;
  over: boolean;
  result: BattleResult | null;
}

export interface CombatMove {
  from: string;
  to: string;
  units: Partial<UnitCounts>;
  /** Intermediate stops for a 2-step tank move (blitz path). */
  via?: string[];
  /** Strategic bombing raid (bombers only, factory target). */
  sbr?: boolean;
}

export interface NonCombatMove {
  from: string;
  to: string;
  units: Partial<UnitCounts>;
}

export interface MobilizePlacement {
  /** Factory territory doing the producing (must be a turn-start factory). */
  territory: string;
  units: Partial<UnitCounts>;
  /** Also build a purchased factory in this territory (owned, IPC>=2, no factory). */
  buildFactory?: boolean;
}

export interface GameEvent {
  seq: number;
  round: number;
  player: number;
  kind: string;
  detail: string;
  rolls?: { side: string; dice: number[]; hits: number };
}

export interface ChatMessage {
  sender: string;
  recipients: string;
  text: string;
  round: number;
}

export interface GameState {
  version: 2;
  seed: number;
  rngState: number;
  numPlayers: number;
  turnOrder: number[];
  orderIndex: number;
  round: number;
  players: PlayerState[];
  territories: Record<string, TerritoryState>;
  currentPlayer: number;
  phase: Phase;
  /** Purchased units awaiting mobilization. */
  purchased: Partial<Record<PurchasableType, number>>;
  /** Territories the current player owned when their turn started (landing rule). */
  ownedAtTurnStart: string[];
  /** Factory territories usable for mobilization this turn (turn-start only). */
  turnStartFactories: string[];
  /** Units per territory that already moved/attacked (may not non-combat move). */
  used: Record<string, UnitCounts>;
  battles: Battle[];
  nextBattleId: number;
  turnCap: number;
  winner: number | null;
  winReason: string | null;
  events: GameEvent[];
  chatLog: ChatMessage[];
}

export interface CombatRoundResult {
  battleId: number;
  territoryId: string;
  aaRolls: number[];
  aaHits: number;
  attackRolls: number[];
  attackHits: number;
  defenseRolls: number[];
  defenseHits: number;
  pendingAttacker: number;
  pendingDefender: number;
  over: boolean;
  result: BattleResult | null;
  sbrDamage?: number;
}

/** Result returned by every action. Invalid actions never mutate state. */
export interface ActionResult {
  ok: boolean;
  code?: string;
  error?: string;
  combat?: CombatRoundResult;
}
