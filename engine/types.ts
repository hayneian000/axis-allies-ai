export interface UnitCounts {
  infantry: number;
  artillery: number;
  tank: number;
  fighter: number;
  bomber: number;
  aa: number;
  /** Naval units (1942 2e). Submarine/carrier mechanics arrive in navy phase 2+. */
  transport: number;
  submarine: number;
  destroyer: number;
  cruiser: number;
  carrier: number;
  battleship: number;
}

export type PurchasableType =
  | 'infantry'
  | 'artillery'
  | 'tank'
  | 'fighter'
  | 'bomber'
  | 'aa'
  | 'transport'
  | 'submarine'
  | 'destroyer'
  | 'cruiser'
  | 'carrier'
  | 'battleship'
  | 'factory';

export interface PurchaseItem {
  type: PurchasableType;
  count: number;
}

/** Land units riding on a transport. One entry per transport load.
 *  1942 2e p.30: capacity is any one land unit plus one additional infantry
 *  (i.e. 2 infantry, or infantry + tank/artillery/AA). Cargo cannot fight at
 *  sea and is destroyed if its transport is destroyed. */
export interface TransportLoad {
  owner: number;
  units: UnitCounts;
}

export interface TerritoryState {
  /** null = neutral (unowned) on land; null = uncontrolled waters at sea. */
  owner: number | null;
  units: UnitCounts;
  factory: boolean;
  /** True when built or captured this turn: cannot produce until next turn. */
  factoryFresh: boolean;
  /** Transport cargo manifest. Meaningful only for sea zones. */
  cargo: TransportLoad[];
  /** Foreign forces coexisting in a sea zone without a battle (1942 2e p.29:
   *  ignored submarines/transports, or forces mobilized into hostile waters
   *  per p.21). `units`/`owner` always hold the primary occupant; each entry
   *  here is one other owner's units. Never used on land. */
  coexist?: Array<{ owner: number; units: UnitCounts }>;
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
  | 'sbr_done'
  /** Attacker cleared a sea zone of defenders. */
  | 'sea_taken';

export interface Battle {
  id: number;
  territoryId: string;
  attackerId: number;
  /** null = neutral garrison. */
  defenderId: number | null;
  kind: BattleKind;
  /** Attacker units currently in the territory (air stays here until landed). */
  attack: UnitCounts;
  /** Origin territories of the attacking units (retreat targets). */
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
  // --- Amphibious assault (1942 2e p.15) ---
  /** Sea zone the assault launched from. Set on the land battle. */
  amphibiousFrom?: string;
  /** Land units in `attack` that came off transports: cannot retreat (p.15). */
  seaborne?: UnitCounts;
  /** Battleships/cruisers eligible for pre-invasion bombardment, decided at
   *  combat-move time: only when no sea battle occurred in the launch zone,
   *  at most one ship per offloaded land unit (p.15). */
  bombard?: { battleship: number; cruiser: number };
  bombardDone: boolean;
  /** Defender units doomed by bombardment: they still defend the first land
   *  round, then are removed (p.15). */
  bombardDoomed: number;
  // --- Battleship damage (1942 2e p.27) ---
  /** Damaged (not destroyed) battleships still fighting. First hit in a
   *  combat damages; second hit in the SAME combat destroys; survivors are
   *  repaired when the combat ends. Tracked on the battle, not the map. */
  damagedAttackBB: number;
  damagedDefBB: number;
  // --- Submarines (1942 2e pp.28-29) ---
  /** Submerge decision state. Each sea-battle round, subs decide whether to
   *  submerge before any dice are rolled, attacker first (p.29). */
  subPhase: 'attacker' | 'defender' | 'done';
  /** Subs that submerged: out of the fight for the rest of this battle (p.29). */
  submergedA: number;
  submergedD: number;
  /** Amphibious cargo awaiting the launch zone's sea-battle outcome. When an
   *  assault launches from a contested sea zone, the offload happens only if
   *  the attacker clears the zone (1942 2e p.15). */
  pendingDisembark?: { from: string; units: UnitCounts };
  /** Air-scored portion of the pending hits. 1942 2e p.29: air hits cannot be
   *  assigned to submarines unless a friendly destroyer is in the battle. */
  pendAtkAir: number;
  pendDefAir: number;
}

export interface CombatMove {
  from: string;
  to: string;
  units: Partial<UnitCounts>;
  /** Intermediate stops for a 2-step tank move (blitz path). */
  via?: string[];
  /** Strategic bombing raid (bombers only, factory target). */
  sbr?: boolean;
  /** Load land units from a coastal territory onto transports in an adjacent
   *  sea zone (from=land, to=sea). */
  embark?: boolean;
  /** Unload transport cargo into an adjacent land territory (from=sea,
   *  to=land). Hostile target in combatMove = amphibious assault. */
  disembark?: boolean;
  /** Sea zones only: attack ignored enemy submarines/transports instead of
   *  coexisting with them (1942 2e p.29). Also enables a from==to move that
   *  opens a battle with forces already sharing the zone. */
  attack?: boolean;
}

export interface NonCombatMove {
  from: string;
  to: string;
  units: Partial<UnitCounts>;
  /** Load land units onto transports (from=land, to=sea). */
  embark?: boolean;
  /** Unload transport cargo into an adjacent FRIENDLY land territory. */
  disembark?: boolean;
}

export interface MobilizePlacement {
  /** Factory territory doing the producing (must be a turn-start factory). */
  territory: string;
  units: Partial<UnitCounts>;
  /** Also build a purchased factory in this territory (owned, IPC>=2, no factory). */
  buildFactory?: boolean;
  /** Target sea zone for naval units: must be adjacent to `territory`.
   *  1942 2e p.21: sea units mobilize into a sea zone adjacent to an
   *  eligible industrial complex. */
  seaZone?: string;
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
  version: 3;
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
  /** Capitals a player must hold simultaneously to win (scenario-overridable, defaults to majority). */
  capitalsToWin: number;
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
  /** Bombardment dice from an amphibious assault's pre-invasion shelling. */
  bombardRolls?: number[];
  bombardHits?: number;
  /** Submarine surprise-strike dice (1942 2e p.29): fired before the general
   *  exchange, casualties removed with no return fire. */
  surpriseARolls?: number[];
  surpriseAHits?: number;
  surpriseDRolls?: number[];
  surpriseDHits?: number;
}

/** Result returned by every action. Invalid actions never mutate state. */
export interface ActionResult {
  ok: boolean;
  code?: string;
  error?: string;
  combat?: CombatRoundResult;
}
