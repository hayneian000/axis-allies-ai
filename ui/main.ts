import { MAP, NAVAL_UNIT_TYPES, UNITS, activeMapId, airDistance, boardTintHex, canalBetween, centroid, ipcOf, isImpassable, neighborsOf, pointInPolygon, setActiveMap, type MapId, type TerritoryDef, type UnitType } from '../data/data';
import boardUrl from './board-1942.jpg';
import { playIntro } from './intro';
import {
  autoCasualties,
  canalEdgeOpen,
  capitalsOf,
  chooseCasualties,
  combatMove,
  countAir,
  countLand,
  countSea,
  countUnits,
  createGame,
  describeUnits,
  deserialize,
  emptyUnits,
  endPhase,
  incomeOf,
  mobilize,
  nonCombatMove,
  openBattles,
  ownedTerritories,
  ownsCapital,
  PLAYER_COLORS,
  purchase,
  resolveCombatRound,
  retreat,
  sendMessage,
  serialize,
  submergeSubs,
  submergeTurn,
  victoryCitiesHeld,
} from '../engine/engine';
import type { CombatMove, GameState, NonCombatMove, TerritoryState, UnitCounts } from '../engine/types';
import { bridge } from './driverBridge';
import { initAiLobby, getAiMode, startAiGameFromLobby } from './aiLobby';

const SVGNS = 'http://www.w3.org/2000/svg';
const UNIT_ORDER: UnitType[] = [
  'infantry',
  'artillery',
  'tank',
  'fighter',
  'bomber',
  'aa',
  'transport',
  'submarine',
  'destroyer',
  'cruiser',
  'carrier',
  'battleship',
];
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
const DISPLAY_NAME: Record<string, string> = {
  pa_nj: 'PA+NJ',
  new_england: 'N.England',
  upper_midwest: 'Upper MW',
  nevada_utah: 'NV+UT',
  new_mexico: 'N.Mexico',
  gulf_south: 'Gulf S.',
  mid_atlantic: 'Mid-Atl.',
  great_lakes: 'Gt.Lakes',
  appalachia: 'Appalachia',
  heartland: 'Heartland',
  southeast: 'Southeast',
};
const STEPS: Array<{ id: string; label: string }> = [
  { id: 'purchase', label: 'Buy' },
  { id: 'combatMove', label: 'Attack' },
  { id: 'combat', label: 'Battle' },
  { id: 'nonCombat', label: 'Move' },
  { id: 'mobilize', label: 'Deploy' },
];

let S: GameState | null = null;
let sel: string | null = null;
/** Last click client coords, for popup positioning. */
let selClick: { x: number; y: number } | null = null;
let draftMoves: CombatMove[] = [];
let draftNonCombat: NonCombatMove[] = [];
let draftMob: Array<{ territory: string; units: Partial<UnitCounts>; buildFactory?: boolean; seaZone?: string }> = [];
let selectedBattle: string | null = null;
let lastCombat: import('../engine/types').CombatRoundResult | null = null;
let modal: 'shop' | 'battle' | 'move' | null = null;
let lastLaunchMsg: string | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const svg = (): SVGSVGElement => $('map') as unknown as SVGSVGElement;

// ------------------------------------------------------------ maps ---
// Active-map contract from data/data.ts:
//   export let MAP (live binding), setActiveMap(id: MapId),
//   activeMapId(), and scenarioFor() honoring the active map.
// MAP is read fresh on every render, so a setActiveMap() swap is picked
// up by all rendering below without any cache invalidation here.

/** True when the active map is a board-space map (1942: the board JPEG is
 *  the terrain artwork and the polygons are only an interaction layer). */
function isBoardSpace(): boolean {
  return MAP.boardSpace === true;
}

/** Design-system button factory. variant: 'brass' (primary) or 'steel' (default). */
function mkButton(label: string, variant: 'brass' | 'steel' = 'steel'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant === 'brass') b.classList.add('btn-brass');
  return b;
}

function showError(msg: string): void {
  $('error').textContent = msg;
}

// ------------------------------------------------------------ boot ---

function resetTransientUi(): void {
  draftMoves = [];
  draftNonCombat = [];
  draftMob = [];
  selectedBattle = null;
  lastCombat = null;
  sel = null;
  modal = null;
  showError('');
}

function boot(): void {
  // Dog-tag player count selection
  let numPlayers = 4;
  const dogtags = Array.from(document.querySelectorAll<HTMLButtonElement>('.dogtag'));
  for (const tag of dogtags) {
    tag.addEventListener('click', () => {
      dogtags.forEach((t) => t.classList.remove('active'));
      tag.classList.add('active');
      numPlayers = parseInt(tag.dataset.players ?? '4', 10);
    });
  }
  const forceFourPlayers = (): void => {
    numPlayers = 4;
    const four = dogtags.find((t) => t.dataset.players === '4');
    // Clicking (not just class-toggling) also fires the AI lobby's own
    // dogtag listener, so its seat cards rebuild for 4 players.
    if (four && !four.classList.contains('active')) four.click();
    else dogtags.forEach((t) => t.classList.toggle('active', t === four));
  };

  // Map folio selection (the mode plaques have their own handlers in
  // aiLobby.ts; the folios had none). Locked folios are disabled and
  // never fire.
  let selectedMap: MapId = 'america';
  const folios = Array.from(document.querySelectorAll<HTMLButtonElement>('.map-folio[data-map]'));
  for (const folio of folios) {
    folio.addEventListener('click', () => {
      if (folio.disabled) return;
      folios.forEach((f) => f.classList.remove('active'));
      folio.classList.add('active');
      selectedMap = (folio.dataset.map as MapId | undefined) ?? 'america';
      // The 1942 scenario is 4-seat only.
      if (selectedMap === 'world1942') forceFourPlayers();
    });
  }

  // Viewport starts from whichever map data is active at boot.
  syncFromMap();

  $('startBtn').addEventListener('click', () => {
    // Map choice first — BEFORE any game creation, in every mode: the
    // data layer (MAP / scenarioFor), the viewport, and (for 1942) the
    // player count all follow the selected folio.
    if (selectedMap === 'world1942') forceFourPlayers();
    setActiveMap(selectedMap);
    syncFromMap();
    // Phase 2: AI modes are owned by the lobby (ui/aiLobby.ts).
    if (getAiMode() !== 'hotseat') {
      startAiGameFromLobby();
      return;
    }
    const seed = parseInt(($('seed') as HTMLInputElement).value, 10) || 1;
    S = createGame({ numPlayers, seed });
    syncFromMap();
    resetTransientUi();
    // A previous AI game may have revealed the AI tab; hot-seat hides it.
    $('tab-ai').hidden = true;
    $('setup').hidden = true;
    // Fog-of-war cinematic, then reveal the game UI.
    playIntro(S, () => {
      $('game').hidden = false;
      render();
    });
  });
  $('newBtn').addEventListener('click', () => {
    // Abort a Phase 2 driver run before tearing down the screens.
    if (bridge.driverActive) bridge.stopDriver?.();
    S = null;
    $('game').hidden = true;
    $('setup').hidden = false;
  });
  $('endPhaseBtn').addEventListener('click', () => {
    if (!S) return;
    // While the driver runs AI seats, the button is inert — the driver ends
    // phases itself. During a human seat's turn it works as usual and hands
    // control back to the driver.
    if (bridge.driverActive && !bridge.pendingHuman) {
      showError('The AI commanders are deliberating — your turn will come.');
      return;
    }
    const r = endPhase(S, S.currentPlayer);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      showError('');
      selectedBattle = null;
      lastCombat = null;
      lastLaunchMsg = null;
      // Battles can't hide: entering combat with open fights pops the dialog.
      if (S.phase === 'combat' && openBattles(S).length > 0) {
        modal = 'battle';
        selectedBattle = openBattles(S)[0].territoryId;
      }
    }
    render();
    if (bridge.pendingHuman) {
      const p = bridge.pendingHuman;
      bridge.pendingHuman = null;
      p.resolve();
    }
  });
  $('saveBtn').addEventListener('click', () => {
    if (!S) return;
    const blob = new Blob([serialize(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `aaa-save-round${S.round}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  ($('setupLoadInput') as HTMLInputElement).addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        S = deserialize(text);
        sel = null;
        draftMoves = [];
        draftNonCombat = [];
        draftMob = [];
        selectedBattle = null;
        lastCombat = null;
        $('setup').hidden = true;
        $('game').hidden = false;
        showError('');
        syncFromMap();
        render();
      } catch (err) {
        showError(`Load failed: ${(err as Error).message}`);
      }
    });
  });
  $('chatSend').addEventListener('click', () => {
    if (!S) return;
    const input = $('chatText') as HTMLInputElement;
    const r = sendMessage(S, S.currentPlayer, 'all', input.value);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      input.value = '';
      showError('');
    }
    render();
  });
  $('tab-log').addEventListener('click', () => {
    $('tab-log').classList.add('active');
    $('tab-chat').classList.remove('active');
    $('tab-ai').classList.remove('active');
    $('log').hidden = false;
    $('chatwrap').hidden = true;
    $('aiwrap').hidden = true;
  });
  $('tab-chat').addEventListener('click', () => {
    $('tab-chat').classList.add('active');
    $('tab-log').classList.remove('active');
    $('tab-ai').classList.remove('active');
    $('log').hidden = true;
    $('aiwrap').hidden = true;
    $('chatwrap').hidden = false;
  });
  $('modal-close').addEventListener('click', () => {
    modal = null;
    render();
  });
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) {
      modal = null;
      render();
    }
  });
  // Map pan/zoom. View state lives in `view` and survives re-renders.
  const map = svg();
  map.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const w = e as WheelEvent;
      zoomOnPoint(svgPoint(w.clientX, w.clientY), w.deltaY > 0 ? 1 / 1.15 : 1.15);
    },
    { passive: false },
  );
  let panning = false;
  let panMoved = false;
  let panX = 0;
  let panY = 0;
  let panSuppress = false;
  map.addEventListener('pointerdown', (e) => {
    panning = true;
    panMoved = false;
    panX = (e as PointerEvent).clientX;
    panY = (e as PointerEvent).clientY;
  });
  window.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - panX;
    const dy = e.clientY - panY;
    if (!panMoved && Math.abs(dx) + Math.abs(dy) < 4) return;
    panMoved = true;
    const r = map.getBoundingClientRect();
    const px = r.width > 0 ? Math.min(r.width / VB_W, r.height / VB_H) * view.k : 1;
    view.x += dx / px;
    view.y += dy / px;
    panX = e.clientX;
    panY = e.clientY;
    applyView();
  });
  window.addEventListener('pointerup', () => {
    if (panMoved) {
      panSuppress = true;
      window.setTimeout(() => {
        panSuppress = false;
      }, 0);
    }
    panning = false;
  });
  // A drag-pan must not also fire the territory click underneath it.
  map.addEventListener(
    'click',
    (e) => {
      if (panSuppress) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true,
  );
  map.addEventListener('dblclick', (e) => {
    e.preventDefault();
    view = homeView();
    applyView();
  });
  $('zin').addEventListener('click', () => zoomOnPoint({ x: VB_W / 2, y: VB_H / 2 }, 1.25));
  $('zout').addEventListener('click', () => zoomOnPoint({ x: VB_W / 2, y: VB_H / 2 }, 1 / 1.25));
  $('zreset').addEventListener('click', () => {
    view = homeView();
    applyView();
  });

  // ---- Phase 2 driver integration ----
  // The AI modules (ui/aiLobby.ts, ui/aiGame.ts) never import this module;
  // they talk to it through the bridge registered here.
  bridge.ui = {
    setGameState: (s) => {
      S = s;
      resetTransientUi();
    },
    refresh: () => render(),
    enterGame: (onShown) => {
      $('setup').hidden = true;
      if (S) playIntro(S, onShown);
      else onShown();
    },
    showGame: () => {
      $('game').hidden = false;
    },
    showSetup: () => {
      $('game').hidden = true;
      $('setup').hidden = false;
    },
    showError: (m) => showError(m),
  };
  initAiLobby();
}

function ownerColor(state: GameState, owner: number | null): string {
  if (owner === null) return '#6e6e6a';
  return state.players[owner].color;
}

// ------------------------------------------------------------ render ---

function render(): void {
  if (!S) return;
  renderBanner(S);
  renderSteps(S);
  renderRoster(S);
  renderMap(S);
  renderInspector(S);
  renderPhasePanel(S);
  renderLog(S);
  renderChat(S);
  renderFooter(S);
  renderModal(S);
}

function renderFooter(s: GameState): void {
  const dot = (c: string): string => `<span class="pdot" style="background:${c}"></span>`;
  $('fb-phase').innerHTML =
    s.phase === 'gameover'
      ? `${dot(s.players[s.winner!].color)}Game over — ${s.players[s.winner!].name} wins`
      : `${dot(s.players[s.currentPlayer].color)}Round ${s.round} — ${s.players[s.currentPlayer].name} — ${s.phase}`;
}

// ------------------------------------------------------------ modal ---

function renderModal(s: GameState): void {
  // Stale dialogs follow the game, never linger over the wrong phase.
  if (modal === 'shop' && s.phase !== 'purchase') modal = null;
  if (modal === 'battle' && s.phase !== 'combat') modal = null;
  if (
    modal === 'move' &&
    ((s.phase !== 'combatMove' && s.phase !== 'nonCombat') ||
      !sel ||
      s.territories[sel].owner !== s.currentPlayer)
  ) {
    modal = null;
  }
  const root = $('modal');
  const body = $('modal-body');
  if (!modal) {
    root.hidden = true;
    body.innerHTML = '';
    return;
  }
  // Preserve in-progress dialog inputs across re-renders.
  const saved: Record<string, { value: string; checked: boolean }> = {};
  body.querySelectorAll('input').forEach((node) => {
    const i = node as HTMLInputElement;
    if (i.id) saved[i.id] = { value: i.value, checked: i.checked === true };
  });
  $('modal-title').textContent =
    modal === 'shop' ? 'Buy units' : modal === 'battle' ? 'Battles' : 'Plan move';
  body.oninput = null;
  body.innerHTML = '';
  if (modal === 'shop') purchaseShopBody(s, body);
  else if (modal === 'battle') battleModalBody(s, body);
  else moveDialogBody(s, body);
  for (const [id, v] of Object.entries(saved)) {
    const n = document.getElementById(id) as HTMLInputElement | null;
    if (!n) continue;
    if (n.type === 'checkbox') n.checked = v.checked;
    else n.value = v.value;
  }
  // Re-run live totals after restoring values.
  body.dispatchEvent(new Event('input', { bubbles: true }));
  root.hidden = false;
}

/** Friendly text for the engine's winReason codes (shown in the banner
 *  and the game-over panel). Unknown codes print as-is. */
const WIN_REASON_TEXT: Record<string, string> = {
  majority_capitals: 'majority of capitals',
  victory_cities: 'victory cities',
  turn_cap: 'highest income at the turn cap',
};

function winReasonText(reason: string | null): string {
  return reason ? (WIN_REASON_TEXT[reason] ?? reason) : '';
}

function renderBanner(s: GameState): void {
  const me = s.players[s.currentPlayer];
  // Chips are pure styling: textContent stays byte-identical to before.
  const sep = '<span class="bsep"> — </span>';
  $('banner').innerHTML =
    s.phase === 'gameover'
      ? `<span class="bstat">Game over</span>${sep}<span class="bstat turn">${s.players[s.winner!].name} wins (${winReasonText(s.winReason)})</span>`
      : `<span class="bstat">Round ${s.round}</span>${sep}` +
        `<span class="bstat turn">${me.name}'s turn</span>${sep}` +
        `<span class="bstat">phase: ${s.phase}</span>${sep}` +
        `<span class="bstat econ">bank ${me.ipcs} IPCs</span>${sep}` +
        `<span class="bstat econ">income ${incomeOf(s, s.currentPlayer)}</span>`;
}

function renderSteps(s: GameState): void {
  const bar = $('steps');
  bar.innerHTML = '';
  const order = STEPS.map((x) => x.id);
  const cur = order.indexOf(s.phase);
  for (const st of STEPS) {
    const i = order.indexOf(st.id);
    const d = document.createElement('span');
    d.className = 'step' + (st.id === s.phase ? ' cur' : i < cur ? ' done' : '');
    d.textContent = `${i + 1}. ${st.label}`;
    bar.appendChild(d);
  }
}

function renderRoster(s: GameState): void {
  const el = $('roster');
  el.innerHTML = '';
  for (const p of s.players) {
    const d = document.createElement('div');
    d.className = 'p' + (p.id === s.currentPlayer && s.phase !== 'gameover' ? ' cur' : '');
    d.innerHTML =
      `<span class="pdot" style="background:${p.color}"></span>` +
      `<span class="pinfo"><strong>${p.name}</strong>` +
      `<span class="dim">${ownedTerritories(s, p.id).length} terr · ${p.ipcs} IPCs` +
      `${s.victoryCitiesToWin ? ` · VC ${victoryCitiesHeld(s, p.id)}/${s.victoryCitiesToWin[p.id]}` : ''}` +
      `${ownsCapital(s, p.id) ? '' : ' · NO CAPITAL'}</span></span>` +
      (p.alive ? '' : '<span class="out">OUT</span>');
    el.appendChild(d);
  }
}

const UNIT_NAMES: Record<UnitType, string> = {
  infantry: 'Infantry',
  artillery: 'Artillery',
  tank: 'Tank',
  fighter: 'Fighter',
  bomber: 'Bomber',
  aa: 'AA gun',
  transport: 'Transport',
  submarine: 'Submarine',
  destroyer: 'Destroyer',
  cruiser: 'Cruiser',
  carrier: 'Carrier',
  battleship: 'Battleship',
};

/** Full force table (both sides always visible in the battle dialog). */
function unitRows(u: UnitCounts): string {
  return (
    '<table class="forces-table">' +
    UNIT_ORDER.map((t) => `<tr><td>${UNIT_NAMES[t]}</td><td>×${u[t]}</td></tr>`).join('') +
    '</table>'
  );
}

function unitSummary(s: GameState, tid: string): string {
  const t = s.territories[tid];
  const parts: string[] = [];
  for (const u of UNIT_ORDER) {
    if (t.units[u] > 0) parts.push(`${t.units[u]}${SHORT[u]}`);
  }
  if (t.factory) parts.push(t.factoryFresh ? '(new)' : 'FAC');
  return parts.join(' ') || '—';
}

// ------------------------------------------------------------ map view ---
// Pan/zoom state persists across renders; applied to the #vport group.
// The viewport size is NOT hardcoded: it follows MAP.viewBox (America
// 1000x470, 1942 board space 3500x2000). Every consumer below (zoom,
// client->svg mapping, clamp, pan) reads VB_W/VB_H, so syncing those
// two lets is all a map switch needs.
let VB_W = 1000;
let VB_H = 470;
let view = { x: 0, y: 0, k: 1 };
let syncedViewBox = '';

/** Board-space fit: the 1942 board's edge labels (Central America at
 *  x=10, the United States names at both wrap edges, sz21 at the bottom)
 *  are authored ON the board edge and their text overflows the 3500x2000
 *  frame, so an exact 1:1 fit clips them at the panel edge. The home view
 *  therefore fits the board at 93%, centered — the whole board plus its
 *  edge text sits inside the panel, letterboxed by the ocean backdrop.
 *  Other maps home at exactly 1:1 (their labels stay inside the frame). */
const BOARD_FIT_K = 0.93;

function homeView(): { x: number; y: number; k: number } {
  if (!isBoardSpace()) return { x: 0, y: 0, k: 1 };
  const k = BOARD_FIT_K;
  return { x: (VB_W - VB_W * k) / 2, y: (VB_H - VB_H * k) / 2, k };
}

function minZoom(): number {
  return isBoardSpace() ? BOARD_FIT_K : 1;
}

/** Pull VB_W/VB_H + the #map viewBox attribute from the active MAP.
 *  Called at init and whenever a game starts/restarts (and at the top
 *  of renderMap, which covers the AI-driver and load-game paths).
 *  Switching dimensions resets pan/zoom so a stale America transform
 *  can never strand the much larger board off-screen. */
function syncFromMap(): void {
  const w = MAP.viewBox?.width || 1000;
  const h = MAP.viewBox?.height || 470;
  const key = `${w}x${h}`;
  const dimsChanged = key !== syncedViewBox;
  VB_W = w;
  VB_H = h;
  const m = document.getElementById('map') as unknown as SVGSVGElement | null;
  if (m) {
    m.setAttribute('viewBox', `0 0 ${w} ${h}`);
    m.classList.toggle('board-mode', isBoardSpace());
    m.dataset.boardSpace = isBoardSpace() ? 'true' : 'false';
    m.dataset.map = activeMapId();
  }
  if (dimsChanged) {
    syncedViewBox = key;
    view = homeView();
    if (document.getElementById('vport')) applyView();
  }
}

function svgEl(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function bboxOf(points: Array<[number, number]>): {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

// NATO-style unit frames in a 15x11 box at the origin. Strokes use <path>,
// never <line>: `#map line` is reserved for draft-move arrows.
const ICON_W = 15;
const ICON_H = 11;

function drawUnitIcon(g: SVGElement, t: UnitType): void {
  g.appendChild(
    svgEl('rect', {
      x: '0',
      y: '0',
      width: String(ICON_W),
      height: String(ICON_H),
      rx: '2',
      class: 'uframe',
    }),
  );
  if (t === 'infantry') {
    g.appendChild(svgEl('path', { d: 'M2.5,2.5 L12.5,8.5 M12.5,2.5 L2.5,8.5', class: 'uink' }));
  } else if (t === 'artillery') {
    g.appendChild(svgEl('circle', { cx: '7.5', cy: '5.5', r: '2.6', class: 'uinkfill' }));
  } else if (t === 'tank') {
    g.appendChild(svgEl('ellipse', { cx: '7.5', cy: '5.5', rx: '4.6', ry: '3', class: 'uink' }));
  } else if (t === 'fighter') {
    g.appendChild(svgEl('path', { d: 'M7.5,1.5 L12.5,9.5 L7.5,7.2 L2.5,9.5 Z', class: 'uinkfill' }));
  } else if (t === 'bomber') {
    g.appendChild(svgEl('path', { d: 'M1.5,8.5 L7.5,2 L13.5,8.5 L7.5,6.6 Z', class: 'uinkfill' }));
  } else if (t === 'transport') {
    // hull with deck line
    g.appendChild(svgEl('path', { d: 'M2,7 L13,7 L11,10 L4,10 Z M2,7 L2,4 L13,4 L13,7', class: 'uink' }));
  } else if (t === 'submarine') {
    // submerged ellipse + conning tower
    g.appendChild(svgEl('ellipse', { cx: '7.5', cy: '7', rx: '5.5', ry: '2.4', class: 'uink' }));
    g.appendChild(svgEl('rect', { x: '6', y: '2.6', width: '3', height: '2.6', class: 'uinkfill' }));
  } else if (t === 'destroyer') {
    // sleek hull with bow
    g.appendChild(svgEl('path', { d: 'M1.5,8.5 L11,8.5 L13.5,6 L11,3.5 L1.5,3.5 Z M4,3.5 L4,1.8 M8,3.5 L8,1.8', class: 'uink' }));
  } else if (t === 'cruiser') {
    // hull with twin turrets
    g.appendChild(svgEl('path', { d: 'M1.5,9 L12,9 L13.5,6.5 L12,4 L1.5,4 Z', class: 'uink' }));
    g.appendChild(svgEl('circle', { cx: '5', cy: '6.5', r: '1.4', class: 'uinkfill' }));
    g.appendChild(svgEl('circle', { cx: '9.5', cy: '6.5', r: '1.4', class: 'uinkfill' }));
  } else if (t === 'carrier') {
    // flat flight deck
    g.appendChild(svgEl('path', { d: 'M1.5,5.5 L13.5,5.5 L12,9.5 L3,9.5 Z M7.5,5.5 L7.5,2.5', class: 'uink' }));
  } else if (t === 'battleship') {
    // heavy hull with twin turrets
    g.appendChild(svgEl('path', { d: 'M1,9.5 L12.5,9.5 L14,6.5 L12.5,3.5 L1,3.5 Z', class: 'uink' }));
    g.appendChild(svgEl('circle', { cx: '4.5', cy: '6.5', r: '1.5', class: 'uinkfill' }));
    g.appendChild(svgEl('circle', { cx: '8.5', cy: '6.5', r: '1.5', class: 'uinkfill' }));
  } else {
    // aa: flak dome + barrel
    g.appendChild(svgEl('path', { d: 'M2.5,9.5 A5,5 0 0 1 12.5,9.5 M7.5,9.5 L11,2.5', class: 'uink' }));
  }
}

// Classic factory silhouette in a 15x11 box at the origin.
function drawFactory(g: SVGElement, fresh: boolean): void {
  g.appendChild(
    svgEl('path', {
      d: 'M1,10 L1,4 L4,4 L4,1.5 L6.5,1.5 L6.5,4 L9.5,4 L9.5,2 L12,2 L12,4 L14,4 L14,10 Z',
      class: fresh ? 'facglyph fresh' : 'facglyph',
    }),
  );
}

/** Label layout: pipeline anchors adjusted for stack fit + collision.
 *  Returns map tid -> {x, y} label anchor. */
function layoutLabels(): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  for (const t of MAP.territories) pos.set(t.id, { x: t.label[0], y: t.label[1] });
  // Board space: names sit at the authored name_place anchors and unit
  // markers exactly on the authored label points, so there is no label
  // stack to fit or de-conflict.
  if (isBoardSpace()) return pos;
  const bbOf = (tid: string) => bboxOf(MAP.territories.find((t) => t.id === tid)!.points);

  // Keep the label stack (IPC pill spans ~39px above anchor) inside the tile.
  // Sea zones use compact labels and keep their authored anchors.
  for (const t of MAP.territories) {
    if (t.domain === 'sea') continue;
    const bb = bbOf(t.id);
    const p = pos.get(t.id)!;
    if (p.y - 39 < bb.y0) p.y = bb.y0 + 39;
    if (p.y + 34 > bb.y1 && bb.y1 - bb.y0 > 70) p.y = bb.y1 - 34;
  }

  // Push apart anchors that are closer than MIN_SEP, clamped to their tiles.
  // Northeast cluster (new_england, new_york, pa_nj) has tiny tiles; allow
  // labels to overflow bounds slightly so they can achieve separation.
  const MIN_SEP = 80;
  const clampToBb = (tid: string, p: { x: number; y: number }) => {
    const bb = bbOf(tid);
    // Allow 16px overflow for small territories (< 120px wide) to de-conflict labels
    const margin = (bb.x1 - bb.x0) < 120 ? -16 : 8;
    p.x = Math.min(bb.x1 - margin, Math.max(bb.x0 + margin, p.x));
    p.y = Math.min(bb.y1 - margin, Math.max(bb.y0 + margin, p.y));
  };
  for (let iter = 0; iter < 6; iter++) {
    let moved = false;
    for (let i = 0; i < MAP.territories.length; i++) {
      for (let j = i + 1; j < MAP.territories.length; j++) {
        const a = MAP.territories[i], b = MAP.territories[j];
        const pa = pos.get(a.id)!, pb = pos.get(b.id)!;
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const d = Math.hypot(dx, dy);
        if (d < MIN_SEP && d > 0.01) {
          const push = (MIN_SEP - d) / 2;
          const nx = dx / d, ny = dy / d;
          pa.x -= nx * push; pa.y -= ny * push;
          pb.x += nx * push; pb.y += ny * push;
          clampToBb(a.id, pa); clampToBb(b.id, pb);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  // Manual de-conflict for the northeast cluster: tiny tiles need explicit offsets.
  const neNudges: Record<string, [number, number]> = {
    new_england: [12, -8],  // push NE
    new_york: [-10, 6],     // push SW
    pa_nj: [-6, 10],        // push S
  };
  for (const [tid, [dx, dy]] of Object.entries(neNudges)) {
    const p = pos.get(tid);
    if (p) { p.x += dx; p.y += dy; }
  }

  return pos;
}

/** Embarked land units aboard transports in a sea zone, as a short string. */
function cargoSummary(s: GameState, tid: string): string {
  const loads = s.territories[tid].cargo ?? [];
  if (loads.length === 0) return '';
  const agg: Partial<UnitCounts> = {};
  for (const l of loads) {
    for (const u of UNIT_ORDER) {
      if (l.units[u] > 0) agg[u] = (agg[u] ?? 0) + l.units[u];
    }
  }
  const parts = UNIT_ORDER.filter((u) => (agg[u] ?? 0) > 0).map((u) => `${agg[u]}${SHORT[u]}`);
  return `cargo: ${parts.join(' ')}`;
}

/** Sea zone tile: deep-water fill, dashed outline when uncontrolled, solid
 *  player-colored outline when a fleet holds it. Clickable like land. */
function seaTile(
  s: GameState,
  tid: string,
  t: TerritoryDef,
  st: TerritoryState,
  inBattle: boolean,
  isDest: boolean,
): SVGElement {
  const g = svgEl('g', { class: 'tgroup', 'data-terr': tid });
  const tip = document.createElementNS(SVGNS, 'title');
  const ctrl = st.owner === null ? 'open waters' : `${s.players[st.owner].name} waters`;
  const cargo = cargoSummary(s, tid);
  tip.textContent = `${t.name} (sea zone) — ${ctrl} — ${unitSummary(s, tid)}${cargo ? ` — ${cargo}` : ''}`;
  g.appendChild(tip);
  const pts = t.points.map((p) => p.join(',')).join(' ');
  const ownerHex = st.owner === null ? '#7fb3d9' : PLAYER_COLORS[st.owner % PLAYER_COLORS.length];
  // Board space: controlled waters tint with the occupying seat's
  // official nation color (subtler than land — see the board-mode CSS);
  // open waters keep the pale blue.
  const boardHex = st.owner === null ? '#7fb3d9' : boardTintHex(t, st.owner);
  let cls = 'terr sea';
  if (tid === sel) cls += ' selfrom';
  else if (isDest) cls += ' dest';
  if (inBattle) cls += ' battle';
  const attrs: Record<string, string> = {
    points: pts,
    // Board space: the artwork is the water — the polygon is an
    // interaction layer carrying the owner tint (its fill-opacity is
    // set by the #map.board-mode CSS).
    fill: isBoardSpace() ? boardHex : '#2e5a7d',
    stroke: isBoardSpace() ? boardHex : ownerHex,
    'stroke-width': st.owner === null ? '1.5' : '2.5',
  };
  if (st.owner === null) attrs['stroke-dasharray'] = '7 4';
  const base = svgEl('polygon', attrs);
  base.setAttribute('class', cls);
  base.setAttribute('data-owner', st.owner === null ? 'null' : String(st.owner));
  base.addEventListener('click', (e) => onTerrClick(tid, e as MouseEvent));
  base.addEventListener('mousemove', moveTip);
  base.addEventListener('mouseleave', hideTip);
  g.appendChild(base);
  return g;
}

/** Land tile: parchment base + control tint wash + player-colored boundary.
 *  War-map look per docs/style-guide.md; ownership via `data-owner`. */
function terrTile(s: GameState, tid: string, inBattle: boolean, isDest: boolean): SVGElement {
  const t = MAP.territories.find((x) => x.id === tid)!;
  const st = s.territories[tid];
  if (t.domain === 'sea') return seaTile(s, tid, t, st, inBattle, isDest);
  const g = svgEl('g', { class: 'tgroup', 'data-terr': tid });

  // Native tooltip + accessible summary + test hook for force contents.
  const tip = document.createElementNS(SVGNS, 'title');
  tip.textContent =
    `${DISPLAY_NAME[tid] ?? t.name} — ${st.owner === null ? (isImpassable(tid) ? 'impassable' : 'neutral') : s.players[st.owner].name}` +
    ` — IPC ${ipcOf(tid)} — ${unitSummary(s, tid)}`;
  g.appendChild(tip);

  const pts = t.points.map((p) => p.join(',')).join(' ');
  const ownerHex = st.owner === null ? '#6e6e6a' : PLAYER_COLORS[st.owner % PLAYER_COLORS.length];
  const board = isBoardSpace();
  // Board space: the tint IS the territory's color on the printed board —
  // the official color of the nation holding it (data.ts boardTintHex:
  // original nation's color while its own seat holds it, the capturer's
  // lead nation after a capture, cream for neutrals), at the solid
  // fill-opacity set by the board-mode CSS.
  const boardHex = boardTintHex(t, st.owner);
  const base = svgEl('polygon', {
    points: pts,
    // Board space: interaction layer over the board JPEG carrying the
    // official-color control tint. America keeps its parchment base +
    // tint wash below.
    fill: board ? boardHex : 'var(--paper, #c9b98a)',
    stroke: board ? boardHex : ownerHex,
    'stroke-width': '2',
  });
  let cls = 'terr';
  if (tid === sel) cls += ' selfrom';
  else if (isDest) cls += ' dest';
  if (inBattle) cls += ' battle';
  base.setAttribute('class', cls);
  base.setAttribute('data-owner', st.owner === null ? 'null' : String(st.owner));
  base.addEventListener('click', (e) => onTerrClick(tid, e as MouseEvent));
  base.addEventListener('mousemove', moveTip);
  base.addEventListener('mouseleave', hideTip);
  g.appendChild(base);
  // Extra disjoint polygons (e.g. Michigan's Upper Peninsula) — same styling, no separate click handling.
  for (const extra of t.extraPolygons ?? []) {
    const epts = extra.map((p) => p.join(',')).join(' ');
    g.appendChild(
      svgEl('polygon', {
        points: epts,
        fill: board ? boardHex : 'var(--paper, #c9b98a)',
        stroke: board ? boardHex : ownerHex,
        'stroke-width': '2',
        class: cls,
        'data-owner': st.owner === null ? 'null' : String(st.owner),
      }),
    );
    if (!board) {
      g.appendChild(
        svgEl('polygon', {
          points: epts,
          fill: ownerHex,
          'fill-opacity': '0.35',
          'pointer-events': 'none',
        }),
      );
    }
  }
  // Control tint wash — player color at ~35% over parchment.
  // (Skipped in board space: the base polygon already carries the
  // owner tint, and a second wash would obscure the artwork.)
  if (!board) {
    g.appendChild(
      svgEl('polygon', {
        points: pts,
        fill: ownerHex,
        'fill-opacity': '0.35',
        'pointer-events': 'none',
      }),
    );
  }
  return g;
}

/** Compact sea-zone label: name + controller + ship icons. No IPC pill —
 *  sea zones produce nothing. Anchors are authored in open water, so the
 *  land label stack-fit pass skips sea zones. */
function seaLabels(
  s: GameState,
  tid: string,
  t: TerritoryDef,
  st: TerritoryState,
  inBattle: boolean,
  lx: number,
  ly: number,
): SVGElement {
  const g = svgEl('g', { class: 'tlabels sealabels', 'data-terr': tid, 'pointer-events': 'none' });
  const name = svgEl('text', {
    x: String(lx),
    y: String(ly - 8),
    'text-anchor': 'middle',
    'font-size': '12',
    class: 'tname seafont',
  });
  name.textContent = `${t.name}${inBattle ? ' ⚔' : ''}`;
  g.appendChild(name);
  const ctrl = svgEl('text', {
    x: String(lx),
    y: String(ly + 4),
    'text-anchor': 'middle',
    'font-size': '10',
    class: 'towner seafont',
  });
  ctrl.textContent = st.owner === null ? 'open waters' : s.players[st.owner].name;
  g.appendChild(ctrl);
  const present = UNIT_ORDER.filter((u) => st.units[u] > 0);
  if (present.length > 0) {
    const gap = 5;
    const slots = present.map((u) => ({ u, w: ICON_W + 3 + String(st.units[u]).length * 6 }));
    const rowW = slots.reduce((sum, x) => sum + x.w, 0) + gap * (slots.length - 1);
    const row = svgEl('g', {
      class: 'uicons',
      transform: `translate(${(lx - rowW / 2).toFixed(1)} ${ly + 10})`,
    });
    let cx = 0;
    for (const sl of slots) {
      const ig = svgEl('g', { class: 'uicon', 'data-unit': sl.u, transform: `translate(${cx} 0)` });
      drawUnitIcon(ig, sl.u);
      const count = svgEl('text', { x: String(ICON_W + 2.5), y: '9.5', 'font-size': '9', class: 'ucount' });
      count.textContent = String(st.units[sl.u]);
      ig.appendChild(count);
      row.appendChild(ig);
      cx += sl.w + gap;
    }
    g.appendChild(row);
  }
  const cargo = cargoSummary(s, tid);
  if (cargo) {
    const ct = svgEl('text', {
      x: String(lx),
      y: String(ly + 34),
      'text-anchor': 'middle',
      'font-size': '9',
      class: 'seafont dim',
    });
    ct.textContent = `(${cargo})`;
    g.appendChild(ct);
  }
  // Carrier fighter capacity (1942 2e p.27: two fighters per carrier).
  if (st.units.carrier > 0) {
    const cap = svgEl('text', {
      x: String(lx),
      y: String(ly + 24),
      'text-anchor': 'middle',
      'font-size': '9',
      class: 'seafont dim',
    });
    cap.textContent = `carriers ${st.units.carrier} — fighters ${st.units.fighter}/${2 * st.units.carrier}`;
    g.appendChild(cap);
  }
  // Coexisting foreign forces (ignored subs, mobilized-into-hostile ships).
  const co = st.coexist ?? [];
  if (co.length > 0) {
    const cot = svgEl('text', {
      x: String(lx),
      y: String(ly + 46),
      'text-anchor': 'middle',
      'font-size': '9',
      class: 'seafont dim',
    });
    cot.textContent = co.map((f) => `${s.players[f.owner].name}: ${describeUnits(f.units)}`).join(' | ');
    g.appendChild(cot);
  }
  return g;
}

/** Board-space name text size: the name anchors come from TripleA's
 *  name_place.txt, authored for this exact artwork; long names step
 *  down a size or two so they stay inside their territories. */
function boardNameSize(name: string): number {
  if (name.length > 20) return 25;
  if (name.length > 14) return 29;
  return 34;
}

/** Board-space labels, in two layers. TripleA's base artwork prints NO
 *  territory names or sea-zone numbers (TripleA draws that text itself
 *  from name_place.txt), so board mode renders the names here, at the
 *  name_place anchors (t.nameLabel): land names in dark ink with a
 *  light halo, the IPC value on a smaller second line, and sea zones
 *  as a bare zone number in light text. What renders at the territory's
 *  label point is the dynamic state the artwork cannot know: unit
 *  icons + counts (land and sea) and the factory indicator. Icon rows
 *  are scaled up (BOARD_UNIT_SCALE) because board coordinates are ~3.5x
 *  the America map's — unscaled 15px chits would be unreadable at
 *  full-board zoom. Sea zones also keep their dynamic aux lines
 *  (cargo, carrier capacity, coexisting forces), which are game state,
 *  not artwork.
 *
 *  Layering: renderMap draws every territory's MARKERS (unit chits,
 *  factory badge, sea aux lines) first and every territory's NAMES in a
 *  second pass, so a name is never painted under a neighboring stack.
 *  The handful of names whose anchor still sits directly on their own
 *  stack carry a data-driven `nameNudge` (build script's NAME_NUDGES
 *  table) that moves them into open space. Both layers are
 *  pointer-events: none. */
const BOARD_UNIT_SCALE = 3;

/** Name layer (drawn last, above all unit chits): the territory name +
 *  IPC line, or the sea-zone number, at the name_place anchor plus the
 *  territory's optional nameNudge. */
function boardNames(
  s: GameState, tid: string, inBattle: boolean, lx: number, ly: number,
): SVGElement {
  const t = MAP.territories.find((x) => x.id === tid)!;
  const g = svgEl('g', {
    class: t.domain === 'sea' ? 'tlabels sealabels boardlabels' : 'tlabels boardlabels',
    'data-terr': tid,
    'pointer-events': 'none',
  });
  // Name text at the name_place anchor (falls back to the label point
  // for any map that predates nameLabel), shifted by the optional
  // data-driven nudge for stack-collision territories.
  const [ax, ay] = t.nameLabel ?? [lx, ly];
  const nx = ax + (t.nameNudge?.[0] ?? 0);
  const ny = ay + (t.nameNudge?.[1] ?? 0);
  if (t.domain === 'sea') {
    const num = svgEl('text', {
      x: String(nx),
      y: String(ny),
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': '40',
      class: 'board-seanum',
    });
    num.textContent = tid.replace(/^sz/, '');
    g.appendChild(num);
  } else {
    const size = boardNameSize(t.name);
    const nm = svgEl('text', {
      x: String(nx),
      y: String(ny + Math.round(size * 0.35)),
      'text-anchor': 'middle',
      'font-size': String(size),
      class: 'board-tname',
    });
    nm.textContent = `${DISPLAY_NAME[tid] ?? t.name}${inBattle ? ' ⚔' : ''}`;
    g.appendChild(nm);
    const ipc = ipcOf(tid);
    if (ipc > 0) {
      const ip = svgEl('text', {
        x: String(nx),
        y: String(ny + Math.round(size * 0.35) + size + 4),
        'text-anchor': 'middle',
        'font-size': '24',
        class: 'board-ipc',
      });
      ip.textContent = `IPC ${ipc}`;
      g.appendChild(ip);
    }
  }
  return g;
}

/** Marker layer (drawn before the name layer): unit icon row + counts
 *  at the centers.txt label point, the factory badge, and — for sea
 *  zones — the dynamic aux lines (cargo, carrier capacity, coexisting
 *  forces). */
function boardMarkers(
  s: GameState, tid: string, inBattle: boolean, lx: number, ly: number,
): SVGElement {
  const t = MAP.territories.find((x) => x.id === tid)!;
  const st = s.territories[tid];
  const g = svgEl('g', {
    class: t.domain === 'sea' ? 'tlabels sealabels boardmarkers' : 'tlabels boardmarkers',
    'data-terr': tid,
    'pointer-events': 'none',
  });
  const present = UNIT_ORDER.filter((u) => st.units[u] > 0);
  let below = ly;
  if (present.length > 0) {
    const gap = 5;
    const slots = present.map((u) => ({ u, w: ICON_W + 3 + String(st.units[u]).length * 6 }));
    const rowW = slots.reduce((sum, x) => sum + x.w, 0) + gap * (slots.length - 1);
    const row = svgEl('g', {
      class: 'uicons',
      transform:
        `translate(${(lx - (rowW * BOARD_UNIT_SCALE) / 2).toFixed(1)} ` +
        `${(ly - (ICON_H * BOARD_UNIT_SCALE) / 2).toFixed(1)}) scale(${BOARD_UNIT_SCALE})`,
    });
    let cx = 0;
    for (const sl of slots) {
      const ig = svgEl('g', { class: 'uicon', 'data-unit': sl.u, transform: `translate(${cx} 0)` });
      drawUnitIcon(ig, sl.u);
      const count = svgEl('text', { x: String(ICON_W + 2.5), y: '9.5', 'font-size': '9', class: 'ucount' });
      count.textContent = String(st.units[sl.u]);
      ig.appendChild(count);
      row.appendChild(ig);
      cx += sl.w + gap;
    }
    g.appendChild(row);
    below = ly + (ICON_H * BOARD_UNIT_SCALE) / 2;
  }
  // Factory indicator (kept from the America rendering).
  if (t.domain !== 'sea' && st.factory) {
    const fac = svgEl('g', {
      class: 'facbadge',
      transform:
        `translate(${(lx - (15 * BOARD_UNIT_SCALE) / 2).toFixed(1)} ${(below + 6).toFixed(1)}) ` +
        `scale(${BOARD_UNIT_SCALE})`,
    });
    drawFactory(fac, st.factoryFresh);
    g.appendChild(fac);
    below += 6 + 11 * BOARD_UNIT_SCALE;
  }
  if (t.domain === 'sea') {
    const aux: string[] = [];
    const cargo = cargoSummary(s, tid);
    if (cargo) aux.push(`(${cargo})`);
    if (st.units.carrier > 0) {
      aux.push(`carriers ${st.units.carrier} — fighters ${st.units.fighter}/${2 * st.units.carrier}`);
    }
    const co = st.coexist ?? [];
    if (co.length > 0) {
      aux.push(co.map((f) => `${s.players[f.owner].name}: ${describeUnits(f.units)}`).join(' | '));
    }
    aux.forEach((line, i) => {
      const tx = svgEl('text', {
        x: String(lx),
        y: String(below + 34 + i * 34),
        'text-anchor': 'middle',
        'font-size': '28',
        class: 'seafont board-aux',
      });
      tx.textContent = line;
      g.appendChild(tx);
    });
  }
  return g;
}

/** Labels, badges, unit icons — drawn in a layer above water. */
function terrLabels(
  s: GameState, tid: string, inBattle: boolean, lx: number, ly: number,
): SVGElement {
  const t = MAP.territories.find((x) => x.id === tid)!;
  const st = s.territories[tid];
  if (t.domain === 'sea') return seaLabels(s, tid, t, st, inBattle, lx, ly);
  const bb = bboxOf(t.points);
  const g = svgEl('g', { class: 'tlabels', 'data-terr': tid, 'pointer-events': 'none' });
  const isCap = s.players.some((p) => capitalsOf(s, p.id).includes(tid));

  // Name + owner stacked on the label anchor, with breathing room below the IPC lozenge.
  const name = svgEl('text', {
    x: String(lx),
    y: String(ly - 10),
    'text-anchor': 'middle',
    'font-size': '12',
    class: 'tname',
  });
  name.textContent = `${DISPLAY_NAME[tid] ?? t.name}${isCap ? ' ★' : ''}${inBattle ? ' ⚔' : ''}`;
  g.appendChild(name);
  const owner = svgEl('text', {
    x: String(lx),
    y: String(ly + 1),
    'text-anchor': 'middle',
    'font-size': '10',
    class: 'towner',
  });
  owner.textContent = st.owner === null ? 'neutral' : s.players[st.owner].name;
  g.appendChild(owner);

  // IPC lozenge heading the label stack: brass value on umber.
  // Positioned with clear gap above the name (badge spans ly-39 to ly-25, name at ly-10).
  const badge = svgEl('g', { class: 'ipcbadge', transform: `translate(${lx} ${ly - 32})` });
  badge.appendChild(svgEl('rect', { x: '-21', y: '-7', width: '42', height: '14', rx: '0', class: 'ipcpill' }));
  const bt = svgEl('text', { x: '0', y: '3.5', 'text-anchor': 'middle', 'font-size': '9.5', class: 'ipctext' });
  bt.textContent = `IPC ${ipcOf(tid)}`;
  badge.appendChild(bt);
  g.appendChild(badge);

  // Capital roundel: player-colored disc with brass star.
  if (isCap) {
    const ownerHex = st.owner === null ? '#6e6e6a' : PLAYER_COLORS[st.owner % PLAYER_COLORS.length];
    const candidates: Array<[number, number]> = [
      [lx + 32, ly - 32], [lx - 32, ly - 32], [lx + 32, ly - 10], [lx - 32, ly - 10],
    ];
    const spot = candidates.find(([cx, cy]) => pointInPolygon([cx, cy], t.points)) ?? [lx, ly - 32];
    const cap = svgEl('g', { class: 'capbadge', transform: `translate(${spot[0]} ${spot[1]})` });
    cap.appendChild(svgEl('circle', { cx: '0', cy: '0', r: '7.5', fill: ownerHex, class: 'capring' }));
    const star = svgEl('text', { x: '0', y: '3.5', 'text-anchor': 'middle', 'font-size': '10', class: 'capstar' });
    star.textContent = '★';
    cap.appendChild(star);
    g.appendChild(cap);
  }

  const present = UNIT_ORDER.filter((u) => st.units[u] > 0);

  // Factory silhouette centered below the icon row.
  if (st.factory) {
    const fy = present.length > 0 ? ly + 22 : ly + 8;
    const fac = svgEl('g', { class: 'facbadge', transform: `translate(${lx - 7.5} ${fy})` });
    drawFactory(fac, st.factoryFresh);
    g.appendChild(fac);
  }

  // Unit icon row, centered under the owner line, shrunk to fit narrow tiles.
  if (present.length > 0) {
    const gap = 5;
    const slots = present.map((u) => ({ u, w: ICON_W + 3 + String(st.units[u]).length * 6 }));
    const rowW = slots.reduce((sum, x) => sum + x.w, 0) + gap * (slots.length - 1);
    const avail = Math.max(30, bb.x1 - bb.x0 - 6);
    const sc = Math.min(1, avail / rowW);
    const row = svgEl('g', {
      class: 'uicons',
      transform: `translate(${(lx - (rowW * sc) / 2).toFixed(1)} ${ly + 8}) scale(${sc.toFixed(3)})`,
    });
    let cx = 0;
    for (const sl of slots) {
      const ig = svgEl('g', { class: 'uicon', 'data-unit': sl.u, transform: `translate(${cx} 0)` });
      drawUnitIcon(ig, sl.u);
      const count = svgEl('text', { x: String(ICON_W + 2.5), y: '9.5', 'font-size': '9', class: 'ucount' });
      count.textContent = String(st.units[sl.u]);
      ig.appendChild(count);
      row.appendChild(ig);
      cx += sl.w + gap;
    }
    g.appendChild(row);
  }
  return g;
}

function renderMap(s: GameState): void {
  // The active map may have been switched since the last render (start
  // button, AI driver, loaded save) — viewport + board mode follow it.
  syncFromMap();
  const board = isBoardSpace();
  const m = svg();
  m.innerHTML = '';
  const defs = document.createElementNS(SVGNS, 'defs');
  for (const [id, color] of [['arr-red', '#ff5252'], ['arr-green', '#69f0ae']] as const) {
    const marker = document.createElementNS(SVGNS, 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
    path.setAttribute('fill', color);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  // Slate-navy ocean backdrop gradient.
  const ocean = svgEl('linearGradient', { id: 'ocean', x1: '0', y1: '0', x2: '1', y2: '1' });
  ocean.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#22303e' }));
  ocean.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#1a2530' }));
  defs.appendChild(ocean);
  m.appendChild(defs);

  // Static ocean backdrop (outside pan/zoom).
  m.appendChild(
    svgEl('rect', {
      x: '0',
      y: '0',
      width: String(VB_W),
      height: String(VB_H),
      fill: 'url(#ocean)',
      class: 'ocean',
    }),
  );

  const vport = svgEl('g', {
    id: 'vport',
    transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
  });
  m.appendChild(vport);

  // Board space: the board JPEG is the terrain artwork. It is the
  // FIRST child inside the pan/zoom group so it transforms together
  // with the interaction polygons drawn over it.
  if (board) {
    vport.appendChild(
      svgEl('image', {
        href: boardUrl,
        x: '0',
        y: '0',
        width: String(VB_W),
        height: String(VB_H),
        preserveAspectRatio: 'none',
        'pointer-events': 'none',
        class: 'board-art',
      }),
    );
  }

  const battles = new Set(openBattles(s).map((b) => b.territoryId));
  const dests = legalDestinations(s);
  // Layer 1: land tiles.
  for (const t of MAP.territories) {
    vport.appendChild(terrTile(s, t.id, battles.has(t.id), dests.has(t.id)));
  }

  // Layer 2: water overlays — above land, below labels; pointer-events none
  // so territory clicks pass through. (Skipped in board space: lakes
  // are part of the board artwork.)
  for (const lake of board ? [] : MAP.lakes ?? []) {
    const pts = lake.points.map((p) => p.join(',')).join(' ');
    const tip = document.createElementNS(SVGNS, 'title');
    tip.textContent = lake.name;
    const poly = svgEl('polygon', {
      points: pts,
      fill: '#3d6a8f',
      stroke: '#7fb3d9',
      'stroke-width': '1.5',
      'pointer-events': 'none',
      class: 'lake',
    });
    poly.appendChild(tip);
    vport.appendChild(poly);
  }

  // Layer 3: labels, badges, unit icons — above water.
  // Board space renders name text at the name_place anchors (the
  // artwork prints none) plus the dynamic markers (units + factory),
  // in two passes: all markers first, then all names, so names are
  // never painted under a neighboring territory's unit stack.
  const layout = layoutLabels();
  if (board) {
    for (const t of MAP.territories) {
      const p = layout.get(t.id)!;
      vport.appendChild(boardMarkers(s, t.id, battles.has(t.id), p.x, p.y));
    }
    for (const t of MAP.territories) {
      const p = layout.get(t.id)!;
      vport.appendChild(boardNames(s, t.id, battles.has(t.id), p.x, p.y));
    }
  } else {
    for (const t of MAP.territories) {
      const p = layout.get(t.id)!;
      vport.appendChild(terrLabels(s, t.id, battles.has(t.id), p.x, p.y));
    }
  }

  // Draft-move arrows above the tiles.
  const drafts: Array<{ from: string; to: string; hostile: boolean }> = [
    ...draftMoves.map((d) => ({
      from: d.from,
      to: d.to,
      hostile: s.territories[d.to].owner !== s.currentPlayer,
    })),
    ...draftNonCombat.map((d) => ({ from: d.from, to: d.to, hostile: false })),
  ];
  for (const d of drafts) {
    const a = centroid(MAP.territories.find((t) => t.id === d.from)!.points);
    const b = centroid(MAP.territories.find((t) => t.id === d.to)!.points);
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('stroke', d.hostile ? '#ff5252' : '#69f0ae');
    // Board coordinates are ~3.5x America's — arrows scale with them.
    line.setAttribute('stroke-width', board ? '10' : '3');
    line.setAttribute('marker-end', d.hostile ? 'url(#arr-red)' : 'url(#arr-green)');
    line.setAttribute('pointer-events', 'none');
    vport.appendChild(line);
  }
}

// ------------------------------------------------------------ map chrome ---
function moveTip(e: Event): void {
  const me = e as MouseEvent;
  const tip = document.getElementById('maptip');
  const host = document.getElementById('mapcol');
  if (!tip || !host) return;
  const g = (me.currentTarget as Element | null)?.parentNode as Element | null;
  tip.textContent = g?.querySelector('title')?.textContent ?? '';
  tip.hidden = false;
  const r = host.getBoundingClientRect();
  tip.style.left = `${me.clientX - r.left + 14}px`;
  tip.style.top = `${me.clientY - r.top + 12}px`;
}

function hideTip(): void {
  const tip = document.getElementById('maptip');
  if (tip) tip.hidden = true;
}

function applyView(): void {
  clampView();
  document
    .getElementById('vport')
    ?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
}

/** Keep the map from scrolling away: the transformed viewBox must always
 *  cover the viewport (with a small margin). */
function clampView(): void {
  // px of overscroll allowed beyond the map edge (120 on the America
  // map; scales with the viewport so the 3500-wide board gets a
  // proportionally similar allowance).
  const M = Math.max(120, Math.round(VB_W * 0.12));
  const minX = VB_W - view.k * VB_W - M;
  const maxX = M;
  const minY = VB_H - view.k * VB_H - M;
  const maxY = M;
  view.x = Math.min(maxX, Math.max(minX, view.x));
  view.y = Math.min(maxY, Math.max(minY, view.y));
}

/** Client-pixel point mapped into viewBox units (letterboxed `meet` fit). */
function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
  const r = svg().getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { x: VB_W / 2, y: VB_H / 2 };
  const sc = Math.min(r.width / VB_W, r.height / VB_H);
  const ox = r.left + (r.width - VB_W * sc) / 2;
  const oy = r.top + (r.height - VB_H * sc) / 2;
  return { x: (clientX - ox) / sc, y: (clientY - oy) / sc };
}

function zoomOnPoint(p: { x: number; y: number }, factor: number): void {
  const k2 = Math.min(6, Math.max(minZoom(), view.k * factor));
  if (k2 === minZoom()) {
    view = homeView();
  } else {
    view = {
      x: p.x - ((p.x - view.x) * k2) / view.k,
      y: p.y - ((p.y - view.y) * k2) / view.k,
      k: k2,
    };
  }
  applyView();
}

/** Territories to highlight as legal destinations for the current selection. */
function legalDestinations(s: GameState): Set<string> {
  const out = new Set<string>();
  if (!sel || s.phase === 'gameover') return out;
  if (s.territories[sel].owner !== s.currentPlayer) return out;
  const pid = s.currentPlayer;
  const from = sel;
  // A closed canal edge is not a legal destination highlight either
  // (canalBetween is undefined for ordinary edges and for maps without
  // canals, so this only bites on the 1942 board's two canal edges).
  const canalShut = (n: string): boolean =>
    !!canalBetween(from, n) && !canalEdgeOpen(s.territories, from, n, pid);
  if (s.phase === 'combatMove') {
    for (const n of neighborsOf(sel)) if (!canalShut(n) && !isImpassable(n)) out.add(n);
  } else if (s.phase === 'nonCombat') {
    for (const n of neighborsOf(sel)) {
      if (canalShut(n) || isImpassable(n)) continue;
      const o = s.territories[n].owner;
      // Friendly waters (empty or yours) are legal naval destinations.
      if (s.territories[n] && MAP.territories.find((t) => t.id === n)?.domain === 'sea') {
        if (o === null || o === pid) out.add(n);
      } else if (o === pid) {
        out.add(n);
      }
    }
  }
  return out;
}

function onTerrClick(tid: string, e?: MouseEvent): void {
  if (!S || S.phase === 'gameover') return;
  const s = S;
  // Sample the ripple point before render() rebuilds the map.
  let ripple: { x: number; y: number } | null = null;
  if (e) {
    const r = svg().getBoundingClientRect();
    if (r.width > 0) {
      const p = svgPoint(e.clientX, e.clientY);
      ripple = { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
    }
  }
  // Clicking your own territory in a move phase plans the move in a dialog.
  if (
    (s.phase === 'combatMove' || s.phase === 'nonCombat') &&
    s.territories[tid].owner === s.currentPlayer
  ) {
    sel = tid;
    modal = 'move';
    showError('');
  } else {
    sel = sel === tid ? null : tid;
    selClick = e ? { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY } : null;
  }
  render();
  if (ripple) {
    const c = svgEl('circle', {
      cx: ripple.x.toFixed(1),
      cy: ripple.y.toFixed(1),
      r: isBoardSpace() ? '21' : '6',
      class: 'ripple',
      'pointer-events': 'none',
    });
    document.getElementById('vport')?.appendChild(c);
    window.setTimeout(() => c.remove(), 650);
  }
}

function stageMoveFromInspector(
  from: string,
  to: string,
  unitPrefix: string,
  opts?: { embark?: boolean; disembark?: boolean },
): void {
  if (!S) return;
  const units = readUnits(unitPrefix);
  if (S.phase === 'combatMove') {
    const viaEl = document.getElementById('mv-via') as HTMLInputElement | null;
    const sbrEl = document.getElementById('mv-sbr') as HTMLInputElement | null;
    const atkEl = document.getElementById(`${unitPrefix}-attack`) as HTMLInputElement | null;
    const via = (viaEl?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    draftMoves.push({
      from,
      to,
      units,
      ...(via.length > 0 ? { via } : {}),
      ...(sbrEl?.checked ? { sbr: true } : {}),
      ...(atkEl && !atkEl.checked ? { attack: false } : {}),
      ...(opts?.embark ? { embark: true } : {}),
      ...(opts?.disembark ? { disembark: true } : {}),
    });
  } else {
    draftNonCombat.push({
      from,
      to,
      units,
      ...(opts?.embark ? { embark: true } : {}),
      ...(opts?.disembark ? { disembark: true } : {}),
    });
  }
}

// ------------------------------------------------------ inspector ---

/** Stepper: [-] [editable count] [+], ids preserved so drafts survive re-renders. */
function stepper(prefix: string, t: UnitType, max = 99): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'stepper';
  const minus = document.createElement('button');
  minus.textContent = '−';
  minus.title = `less ${t}`;
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.min = '0';
  inp.max = String(max);
  inp.value = '0';
  inp.id = `${prefix}-${t}`;
  inp.title = t;
  const plus = document.createElement('button');
  plus.textContent = '+';
  plus.title = `more ${t}`;
  const clamp = (): void => {
    let v = parseInt(inp.value, 10) || 0;
    v = Math.max(0, Math.min(max, v));
    inp.value = String(v);
  };
  const notify = (): void => {
    // Programmatic .value changes don't fire 'input' on their own, but the
    // purchase cart (and other live UI) listens for it.
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  };
  minus.addEventListener('click', () => {
    inp.value = String((parseInt(inp.value, 10) || 0) - 1);
    clamp();
    notify();
  });
  plus.addEventListener('click', () => {
    inp.value = String((parseInt(inp.value, 10) || 0) + 1);
    clamp();
    notify();
  });
  inp.addEventListener('change', clamp);
  const lab = document.createElement('span');
  lab.className = 'ulab';
  lab.textContent = SHORT[t];
  wrap.append(minus, inp, plus, lab);
  return wrap;
}

function readUnits(prefix: string): Partial<UnitCounts> {
  const u: Partial<UnitCounts> = {};
  for (const t of UNIT_ORDER) {
    const el = document.getElementById(`${prefix}-${t}`) as HTMLInputElement | null;
    const n = el ? parseInt(el.value, 10) || 0 : 0;
    if (n > 0) u[t] = n;
  }
  return u;
}

function renderInspector(s: GameState): void {
  const el = $('selinfo');
  // Preserve draft inputs across re-renders (map clicks rebuild this panel).
  const saved: Record<string, { value: string; checked: boolean }> = {};
  el.querySelectorAll('input').forEach((node) => {
    const i = node as HTMLInputElement;
    if (i.id) saved[i.id] = { value: i.value, checked: i.checked === true };
  });
  el.innerHTML = '';
  if (!sel) return;
  // Popup close button.
  const close = document.createElement('button');
  close.className = 'insp-close';
  close.textContent = '×';
  close.title = 'Close';
  close.addEventListener('click', () => {
    sel = null;
    render();
  });
  el.appendChild(close);
  // Position near the click, clamped inside the map column.
  const mapcol = $('mapcol').getBoundingClientRect();
  if (selClick) {
    const pw = 300, ph = 220; // approx popup size for clamping
    let px = selClick.x - mapcol.left + 12;
    let py = selClick.y - mapcol.top + 12;
    px = Math.min(Math.max(8, px), Math.max(8, mapcol.width - pw));
    py = Math.min(Math.max(8, py), Math.max(8, mapcol.height - ph));
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
  } else {
    el.style.left = '12px';
    el.style.top = '12px';
  }
  const restore = (): void => {
    for (const [id, v] of Object.entries(saved)) {
      const n = document.getElementById(id) as HTMLInputElement | null;
      if (!n) continue;
      if (n.type === 'checkbox') n.checked = v.checked;
      else n.value = v.value;
    }
  };
  const t = s.territories[sel];
  const def = MAP.territories.find((x) => x.id === sel)!;
  const mine = t.owner === s.currentPlayer;
  const head = document.createElement('div');
  head.className = 'insp-head';
  const selId = sel;
  const isCap = selId !== null && s.players.some((p) => capitalsOf(s, p.id).includes(selId));
  const impassable = isImpassable(sel);
  const ownerLabel =
    t.owner === null
      ? def.domain === 'sea'
        ? 'open waters'
        : impassable
          ? 'impassable'
          : 'neutral'
      : s.players[t.owner].name;
  head.innerHTML =
    `<strong>${DISPLAY_NAME[sel] ?? def.name}</strong> ` +
    `<span class="chip" style="background:${ownerColor(s, t.owner)}">${ownerLabel}</span> ` +
    `<span>${def.domain === 'sea' ? 'sea zone' : `IPC ${ipcOf(sel)}`}</span>${isCap ? ' ★capital' : ''}${def.victoryCity ? ` ◆victory city: ${def.victoryCity}` : ''}${t.factory ? ' ⚙factory' : ''}`;
  el.appendChild(head);
  const units = document.createElement('div');
  units.className = 'insp-units';
  units.textContent = impassable
    ? 'Impassable (1942 2e): no units may enter, land here, or fly over.'
    : `Units here: ${describeUnits(t.units)}`;
  el.appendChild(units);
  const cargo = cargoSummary(s, sel);
  if (cargo) {
    const c = document.createElement('div');
    c.className = 'insp-units dim';
    c.textContent = `Embarked — ${cargo}`;
    el.appendChild(c);
  }

  const pid = s.currentPlayer;
  if (!mine) {
    const p = document.createElement('p');
    p.className = 'insp-hint';
    p.textContent = impassable
      ? 'Impassable territory: it can never be entered, captured, or overflown.'
      : s.phase === 'combatMove'
        ? 'Enemy ground — dial units at one of your territories, then click here to attack.'
        : 'Not yours.';
    el.appendChild(p);
    restore();
    return;
  }
  if (s.phase === 'combatMove' || s.phase === 'nonCombat') {
    const p = document.createElement('p');
    p.className = 'insp-hint';
    p.textContent =
      s.phase === 'combatMove'
        ? 'Attack or reposition from here.'
        : 'Reposition within your ground from here.';
    el.appendChild(p);
    const open = document.createElement('button');
    open.textContent = 'Plan move…';
    open.addEventListener('click', () => {
      modal = 'move';
      render();
    });
    el.appendChild(open);
  } else if (s.phase === 'mobilize') {
    mobilizeInspector(s, el, sel);
  }
  restore();
}

function moveDialogBody(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const tid = sel!;
  const t = s.territories[tid];
  const def = MAP.territories.find((x) => x.id === tid)!;
  const head = document.createElement('p');
  head.className = 'insp-head';
  const cargo = cargoSummary(s, tid);
  head.innerHTML =
    `<strong>${DISPLAY_NAME[tid] ?? def.name}</strong> — ${describeUnits(t.units)}` +
    (t.factory ? ' ⚙factory' : '') +
    (cargo ? ` <span class="dim">(${cargo})</span>` : '');
  el.appendChild(head);
  const isCombat = s.phase === 'combatMove';
  const prefix = isCombat ? 'mv' : 'nc';
  if (def.domain === 'sea') {
    seaMoveDialogBody(s, el, tid, isCombat, prefix);
    return;
  }
  // Aircraft left aloft over a finished battle here (non-combat phase) are
  // dialable alongside the units on the ground — the engine lands aloft
  // air first. Without this, the phase panel's "land this air" instruction
  // cannot be followed from a land territory (the sea dialog already
  // handles the carrier case).
  const aloft: Partial<UnitCounts> = {};
  if (!isCombat) {
    for (const b of s.battles) {
      if (b.territoryId === tid && b.attackerId === pid && b.over) {
        if (b.attack.fighter) aloft.fighter = (aloft.fighter ?? 0) + b.attack.fighter;
        if (b.attack.bomber) aloft.bomber = (aloft.bomber ?? 0) + b.attack.bomber;
      }
    }
  }
  const aloftN = (aloft.fighter ?? 0) + (aloft.bomber ?? 0);
  const grid = document.createElement('div');
  grid.className = 'stepgrid';
  let any = false;
  for (const u of UNIT_ORDER) {
    if (u === 'aa' && isCombat) continue; // AA can't attack
    const availHere = t.units[u] + (aloft[u] ?? 0);
    if (availHere <= 0) continue;
    any = true;
    grid.appendChild(stepper(prefix, u, availHere));
  }
  if (!any) {
    const p = document.createElement('p');
    p.textContent = 'No movable units here.';
    el.appendChild(p);
    return;
  }
  el.appendChild(grid);
  if (aloftN > 0) {
    const p = document.createElement('p');
    p.textContent = `${aloftN} aircraft aloft over the finished battle here — dial them above and pick a landing spot.`;
    el.appendChild(p);
  }
  if (isCombat) {
    const viaLab = document.createElement('label');
    viaLab.textContent = 'Via (tank blitz) ';
    const viaInp = document.createElement('input');
    viaInp.type = 'text';
    viaInp.id = 'mv-via';
    viaInp.placeholder = 'optional';
    viaLab.appendChild(viaInp);
    el.appendChild(viaLab);
    const sbrLab = document.createElement('label');
    const sbrBox = document.createElement('input');
    sbrBox.type = 'checkbox';
    sbrBox.id = 'mv-sbr';
    sbrLab.append(' SBR (bombers vs factory) ', sbrBox);
    el.appendChild(sbrLab);
  }
  const h = document.createElement('p');
  h.innerHTML = '<strong>Send to:</strong>';
  el.appendChild(h);
  // Destinations: adjacent territories, plus — when aircraft are based
  // here (on the ground or aloft) — every territory within their range.
  // Adjacent-only lists would strand land-based air (e.g. a bomber on an
  // island territory could never reach a target); the engine validates
  // the exact per-unit range and landing feasibility when moves launch.
  let airRange = 0;
  for (const u of ['fighter', 'bomber'] as const) {
    if (t.units[u] + (aloft[u] ?? 0) > 0) airRange = Math.max(airRange, UNITS[u].move);
  }
  const destIds = new Set(neighborsOf(tid));
  if (airRange > 0) {
    for (const d of MAP.territories) {
      if (d.id !== tid && airDistance(tid, d.id) <= airRange) destIds.add(d.id);
    }
  }
  const dests = [...destIds].filter((n) => {
    if (isImpassable(n)) return false; // never offered: engine rejects them too
    const dd = MAP.territories.find((x) => x.id === n)!;
    if (isCombat) return true;
    if (dd.domain === 'sea') {
      const o = s.territories[n].owner;
      return o === null || o === pid;
    }
    return s.territories[n].owner === pid;
  });
  if (dests.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No destinations in range from here.';
    el.appendChild(p);
    return;
  }
  for (const d of dests) {
    const dt = s.territories[d];
    const ddef = MAP.territories.find((x) => x.id === d)!;
    const btn = document.createElement('button');
    btn.dataset.dest = d;
    const owner = dt.owner === null ? 'neutral' : dt.owner === pid ? 'yours' : s.players[dt.owner].name;
    const embarkTag = ddef.domain === 'sea' ? ' (embark)' : '';
    const dist = airDistance(tid, d);
    const rangeTag = dist > 1 ? ` · ${dist} away` : '';
    btn.textContent = `${DISPLAY_NAME[d] ?? ddef.name}${embarkTag} (${owner}, ${describeUnits(dt.units)}${dt.factory ? ', FAC' : ''})${rangeTag}`;
    btn.addEventListener('click', () => {
      const units = readUnits(s.phase === 'combatMove' ? 'mv' : 'nc');
      const full = { ...emptyUnits(), ...units };
      const n = countUnits(full);
      if (n === 0) {
        showError('Dial at least one unit before picking a destination.');
        return;
      }
      // Air-only moves to a sea zone are attacks (1942 2e), not embarkation.
      const airOnly = countAir(full) > 0 && countSea(full) === 0 && countLand(full) === 0;
      stageMoveFromInspector(tid, d, s.phase === 'combatMove' ? 'mv' : 'nc', {
        ...(ddef.domain === 'sea' && !airOnly ? { embark: true } : {}),
      });
      modal = null;
      showError('');
      render();
    });
    el.appendChild(btn);
  }
}

/** Move dialog for a sea zone you control: fleet movement plus cargo offload. */
function seaMoveDialogBody(
  s: GameState,
  el: HTMLElement,
  tid: string,
  isCombat: boolean,
  prefix: string,
): void {
  const pid = s.currentPlayer;
  const t = s.territories[tid];
  const grid = document.createElement('div');
  grid.className = 'stepgrid';
  let any = false;
  for (const u of NAVAL_UNIT_TYPES) {
    if (t.units[u] <= 0) continue;
    any = true;
    grid.appendChild(stepper(prefix, u, t.units[u]));
  }
  if (any) {
    const h = document.createElement('p');
    h.innerHTML = '<strong>Fleet — send to:</strong>';
    el.appendChild(h);
    el.appendChild(grid);
    // Ignore-or-attack choice (1942 2e p.29): when ending movement in a zone
    // with only enemy subs/transports, choose to attack or coexist.
    if (isCombat) {
      const atkLab = document.createElement('label');
      const atkBox = document.createElement('input');
      atkBox.type = 'checkbox';
      atkBox.id = `${prefix}-attack`;
      atkBox.checked = true;
      atkLab.append(' Attack subs/transports (uncheck to ignore & coexist) ', atkBox);
      el.appendChild(atkLab);
    }
    // Destinations: adjacent zones, plus zones two steps away reached
    // through non-hostile water (ships move up to 2 sea zones; hostile
    // transit is barred but the destination itself may be hostile —
    // 1942 2e p.27; the engine applies the exact per-unit rules,
    // including submarine/destroyer exceptions, when moves launch).
    // Canal edges (Panama, Suez) are offered only while the canal is
    // open to this seat — the same canalEdgeOpen rule the engine
    // validates with, so the dialog never offers a route the engine
    // would reject as canal_closed.
    const destSet = new Set(
      neighborsOf(tid).filter(
        (n) =>
          MAP.territories.find((x) => x.id === n)?.domain === 'sea' &&
          canalEdgeOpen(s.territories, tid, n, pid),
      ),
    );
    const hostileZone = (z: string): boolean => {
      const o = s.territories[z].owner;
      return o !== null && o !== pid;
    };
    for (const n1 of [...destSet]) {
      if (hostileZone(n1)) continue;
      for (const n2 of neighborsOf(n1)) {
        if (
          MAP.territories.find((x) => x.id === n2)?.domain === 'sea' &&
          canalEdgeOpen(s.territories, n1, n2, pid)
        ) {
          destSet.add(n2);
        }
      }
    }
    const dests = [...destSet];
    for (const d of dests) {
      const ddef = MAP.territories.find((x) => x.id === d)!;
      const dt = s.territories[d];
      const btn = document.createElement('button');
      const owner = dt.owner === null ? 'open waters' : dt.owner === pid ? 'yours' : s.players[dt.owner].name;
      const hostile = dt.owner !== null && dt.owner !== pid;
      btn.textContent = `${ddef.name} (${owner}${hostile ? ', ATTACK' : ''}, ${describeUnits(dt.units)})`;
      btn.addEventListener('click', () => {
        const n = countUnits({ ...emptyUnits(), ...readUnits(prefix) });
        if (n === 0) {
          showError('Dial at least one ship before picking a destination.');
          return;
        }
        stageMoveFromInspector(tid, d, prefix);
        modal = null;
        showError('');
        render();
      });
      el.appendChild(btn);
    }
  } else {
    const p = document.createElement('p');
    p.textContent = 'No ships here.';
    el.appendChild(p);
  }
  // Fighters (1942 2e p.27): launch from the carrier to attack or reposition.
  // Includes fighters aloft over a finished battle here — they must land.
  const aloftF = s.battles
    .filter((b) => b.territoryId === tid && b.attackerId === pid)
    .reduce((sum, b) => sum + b.attack.fighter, 0);
  const dialableF = t.units.fighter + aloftF;
  if (dialableF > 0) {
    const fh = document.createElement('p');
    fh.innerHTML = '<strong>Fighters — launch:</strong>';
    el.appendChild(fh);
    const fgrid = document.createElement('div');
    fgrid.className = 'stepgrid';
    fgrid.appendChild(stepper(`${prefix}-air`, 'fighter', dialableF));
    el.appendChild(fgrid);
    const stageAir = (d: string) => {
      const nF = readUnits(`${prefix}-air`).fighter ?? 0;
      if (nF === 0) {
        showError('Dial fighters before picking a target.');
        return;
      }
      const mv = { from: tid, to: d, units: { fighter: nF } };
      if (s.phase === 'combatMove') draftMoves.push(mv);
      else draftNonCombat.push(mv);
      modal = null;
      showError('');
      render();
    };
    // Fighter launch destinations: adjacent, plus anything within
    // fighter range (carrier strikes are not limited to the next zone).
    const airDestIds = new Set(neighborsOf(tid));
    for (const d of MAP.territories) {
      if (d.id !== tid && airDistance(tid, d.id) <= UNITS.fighter.move) airDestIds.add(d.id);
    }
    const airDests = [...airDestIds].filter((n) => {
      if (isImpassable(n)) return false; // fighters may not strike or cross it
      const dd = MAP.territories.find((x) => x.id === n)!;
      if (dd.domain === 'sea') return true;
      const o = s.territories[n].owner;
      return isCombat ? o !== pid : o === pid;
    });
    for (const d of airDests) {
      const ddef = MAP.territories.find((x) => x.id === d)!;
      const dt = s.territories[d];
      const btn = document.createElement('button');
      const owner =
        dt.owner === null
          ? ddef.domain === 'sea'
            ? 'open waters'
            : 'neutral'
          : dt.owner === pid
            ? 'yours'
            : s.players[dt.owner].name;
      const tag = ddef.domain === 'sea' ? '' : isCombat && owner !== 'yours' ? ', STRIKE' : '';
      btn.textContent = `✈ ${DISPLAY_NAME[d] ?? ddef.name} (${owner}${tag})`;
      btn.addEventListener('click', () => stageAir(d));
      el.appendChild(btn);
    }
  }
  // Cargo ashore: offload embarked land units into adjacent coastal territory.
  const loads = (t.cargo ?? []).filter((l) => l.owner === pid);
  if (loads.length > 0) {
    const h = document.createElement('p');
    h.innerHTML = '<strong>Cargo ashore — offload to:</strong>';
    el.appendChild(h);
    const cgrid = document.createElement('div');
    cgrid.className = 'stepgrid';
    const agg: Partial<UnitCounts> = {};
    for (const l of loads) {
      for (const u of UNIT_ORDER) {
        if (l.units[u] > 0) agg[u] = (agg[u] ?? 0) + l.units[u];
      }
    }
    for (const u of UNIT_ORDER) {
      if ((agg[u] ?? 0) <= 0) continue;
      cgrid.appendChild(stepper('cg', u, agg[u]!));
    }
    el.appendChild(cgrid);
    const lands = neighborsOf(tid).filter((n) => {
      if (isImpassable(n)) return false; // no amphibious offload into impassable ground
      const dd = MAP.territories.find((x) => x.id === n)!;
      if (dd.domain !== 'land') return false;
      const o = s.territories[n].owner;
      return isCombat ? o !== pid : o === pid;
    });
    for (const d of lands) {
      const ddef = MAP.territories.find((x) => x.id === d)!;
      const dt = s.territories[d];
      const owner = dt.owner === null ? 'neutral' : dt.owner === pid ? 'yours' : s.players[dt.owner].name;
      const btn = document.createElement('button');
      btn.textContent = `${DISPLAY_NAME[d] ?? ddef.name} (${owner}${isCombat && owner !== 'yours' ? ', INVASION' : ''}, ${describeUnits(dt.units)})`;
      btn.addEventListener('click', () => {
        const units = readUnits('cg');
        if (countUnits({ ...emptyUnits(), ...units }) === 0) {
          showError('Dial cargo units before picking a landing.');
          return;
        }
        stageMoveFromInspector(tid, d, 'cg', { disembark: true });
        modal = null;
        showError('');
        render();
      });
      el.appendChild(btn);
    }
  }
}

function mobilizeInspector(s: GameState, el: HTMLElement, tid: string): void {
  const pid = s.currentPlayer;
  const pool = Object.entries(s.purchased).filter(([, n]) => (n ?? 0) > 0);
  if (pool.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Nothing purchased. End the phase to collect income.';
    el.appendChild(p);
    return;
  }
  const t = s.territories[tid];
  const p = document.createElement('p');
  p.textContent = `Deploy here from pool: ${pool.map(([u, n]) => `${n}x${u}`).join(', ')}.`;
  el.appendChild(p);
  // Only usable factories offer unit steppers; only eligible ground offers a
  // factory build. Anything else is info text, so an illegal deployment
  // cannot even be staged.
  const usable =
    s.turnStartFactories.includes(tid) && t.factory && !t.factoryFresh;
  const buildable = !t.factory && ipcOf(tid) >= 2 && (s.purchased.factory ?? 0) > 0;
  if (!usable && !buildable) {
    const p2 = document.createElement('p');
    p2.textContent = t.factory
      ? 'This factory was built or captured this turn — it produces from next turn.'
      : 'No usable factory here. Units deploy at your turn-start factories; new factories go on IPC 2+ ground.';
    el.appendChild(p2);
    return;
  }
  if (usable) {
    // Cap steppers by pool and by remaining capacity after staged placements.
    const staged = draftMob
      .filter((d) => d.territory === tid)
      .reduce((sum, d) => sum + countUnits({ ...emptyUnits(), ...d.units }), 0);
    const capLeft = Math.max(0, ipcOf(tid) - staged);
    const grid = document.createElement('div');
    grid.className = 'stepgrid';
    for (const u of UNIT_ORDER) {
      const have = Math.min(s.purchased[u] ?? 0, capLeft);
      if (have <= 0) continue;
      grid.appendChild(stepper('mob', u, have));
    }
    el.appendChild(grid);
    if (capLeft <= 0) {
      const p2 = document.createElement('p');
      p2.textContent = 'Capacity here is fully spoken for by staged placements.';
      el.appendChild(p2);
    }
  }
  if (buildable) {
    const facLab = document.createElement('label');
    const facBox = document.createElement('input');
    facBox.type = 'checkbox';
    facBox.id = 'mob-factory';
    facLab.append(' Build factory here ', facBox);
    el.appendChild(facLab);
  }
  // Fleet deployment: purchased naval units go to an adjacent sea zone
  // (1942 2e p.21), counting against this factory's capacity. Fighters may
  // deploy onto a carrier there (existing or mobilized this phase).
  if (usable) {
    const seaPool = [...NAVAL_UNIT_TYPES, 'fighter' as UnitType].filter((u) => (s.purchased[u] ?? 0) > 0);
    const seaDests = neighborsOf(tid).filter(
      (n) => MAP.territories.find((x) => x.id === n)?.domain === 'sea',
    );
    if (seaPool.length > 0 && seaDests.length > 0) {
      const fh = document.createElement('p');
      fh.innerHTML = '<strong>Fleet — deploy dialed naval units (fighters need a carrier) to:</strong>';
      el.appendChild(fh);
      for (const z of seaDests) {
        const zdef = MAP.territories.find((x) => x.id === z)!;
        const zt = s.territories[z];
        const zb = document.createElement('button');
        const zowner = zt.owner === null ? 'open waters' : zt.owner === pid ? 'yours' : s.players[zt.owner].name;
        zb.textContent = `${zdef.name} (${zowner})`;
        zb.addEventListener('click', () => {
          const units = readUnits('mob');
          const naval: Partial<UnitCounts> = {};
          for (const u of [...NAVAL_UNIT_TYPES, 'fighter' as UnitType]) {
            if ((units[u] ?? 0) > 0) naval[u] = units[u];
          }
          if (countUnits({ ...emptyUnits(), ...naval }) === 0) {
            showError('Dial naval units (or fighters for a carrier) above before picking a sea zone.');
            return;
          }
          draftMob.push({ territory: tid, seaZone: z, units: naval });
          // Clear the deployed steppers so a later "Stage deployment" can't
          // double-count the same purchased units.
          for (const u of [...NAVAL_UNIT_TYPES, 'fighter' as UnitType]) {
            const inp = document.getElementById(`mob-${u}`) as HTMLInputElement | null;
            if (inp) inp.value = '0';
          }
          showError('');
          render();
        });
        el.appendChild(zb);
      }
    }
  }
  const add = document.createElement('button');
  add.textContent = 'Stage deployment';
  add.addEventListener('click', () => {
    const facBox = document.getElementById('mob-factory') as HTMLInputElement | null;
    const units = readUnits('mob');
    if (countUnits({ ...emptyUnits(), ...units }) === 0 && !facBox?.checked) {
      showError('Dial units or tick the factory build before staging.');
      return;
    }
    draftMob.push({
      territory: tid,
      units,
      ...(facBox?.checked ? { buildFactory: true } : {}),
    });
    showError('');
    render();
  });
  el.appendChild(add);
}

// ------------------------------------------------------ phase panels ---

function renderPhasePanel(s: GameState): void {
  const el = $('phasepanel');
  el.oninput = null;
  el.innerHTML = '';
  const h = document.createElement('h3');
  h.innerHTML =
    s.phase === 'gameover'
      ? 'Game over'
      : `<span class="pdot" style="background:${s.players[s.currentPlayer].color}"></span>${s.players[s.currentPlayer].name} — ${s.phase}`;
  el.appendChild(h);
  if (s.phase === 'purchase') purchasePanel(s, el);
  else if (s.phase === 'combatMove') combatMovePanel(s, el);
  else if (s.phase === 'combat') combatPanel(s, el);
  else if (s.phase === 'nonCombat') nonCombatPanel(s, el);
  else if (s.phase === 'mobilize') mobilizePanel(s, el);
  else {
    const p = document.createElement('p');
    p.textContent = `${s.players[s.winner!].name} wins (${winReasonText(s.winReason)}). Start a new game to play again.`;
    el.appendChild(p);
  }
}

function purchasePanel(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const bank = s.players[pid].ipcs;
  const bankLine = document.createElement('p');
  bankLine.innerHTML = `<strong>Bank: ${bank} IPCs.</strong> Units arrive at Deploy step.`;
  el.appendChild(bankLine);
  const entries = Object.entries(s.purchased).filter(([, n]) => (n ?? 0) > 0);
  const pool = document.createElement('p');
  pool.textContent = `To deploy: ${entries.map(([t, n]) => `${n}x${t}`).join(', ') || 'nothing yet'}.`;
  el.appendChild(pool);
  if (!ownsCapital(s, pid)) {
    const p = document.createElement('p');
    p.textContent = 'Your capital is enemy-held: no purchases, no income. End the phase.';
    el.appendChild(p);
    return;
  }
  const open = document.createElement('button');
  open.textContent = 'Buy units…';
  open.className = 'btn-primary';
  open.addEventListener('click', () => {
    modal = 'shop';
    render();
  });
  el.appendChild(open);
}

function purchaseShopBody(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const bank = s.players[pid].ipcs;
  const costs: Record<string, number> = {
    infantry: 3,
    artillery: 4,
    tank: 6,
    fighter: 10,
    bomber: 12,
    aa: 5,
    transport: 7,
    submarine: 6,
    destroyer: 8,
    cruiser: 12,
    carrier: 14,
    battleship: 20,
    factory: 15,
  };
  const notes: Record<string, string> = {
    infantry: 'A1 D2 M1 (+artillery)',
    artillery: 'A2 D2 M1',
    tank: 'A3 D3 M2 blitz',
    fighter: 'A3 D4 M4',
    bomber: 'A4 D1 M6 SBR',
    aa: 'air defense, M1',
    transport: 'M2 sea, carries 1 land + 1 inf',
    submarine: 'A2 D1 M2 sea, surprise strike, submerges',
    destroyer: 'A2 D2 M2 sea',
    cruiser: 'A3 D3 M2 sea, bombards',
    carrier: 'A1 D2 M2 sea, carries 2 fighters',
    battleship: 'A4 D4 M2 sea, 2 hits, bombards',
    factory: 'needs IPC 2+ land',
  };
  const types = [...UNIT_ORDER, 'factory'] as const;
  const table = document.createElement('table');
  table.className = 'shop-table';
  for (const t of types) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.innerHTML = `<span class="uname">${t}</span><span class="ucost">${costs[t]} IPC</span><span class="dim">${notes[t]}</span>`;
    const td2 = document.createElement('td');
    if (t === 'factory') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.value = '0';
      inp.id = 'buy-factory';
      inp.className = 'tinynum';
      td2.appendChild(inp);
    } else {
      td2.appendChild(stepper('buy', t, 99));
    }
    tr.append(td1, td2);
    table.appendChild(tr);
  }
  el.appendChild(table);
  const cartbar = document.createElement('div');
  cartbar.className = 'cartbar';
  const total = document.createElement('span');
  const remainingLine = document.createElement('span');
  remainingLine.id = 'buy-remaining';
  remainingLine.className = 'remaining';
  cartbar.append(total, remainingLine);
  const btn = document.createElement('button');
  btn.textContent = 'Buy';
  btn.className = 'btn-primary';
  const cartValue = (t: string): number =>
    parseInt((document.getElementById(`buy-${t}`) as HTMLInputElement)?.value, 10) || 0;
  const cartTotal = (): number => types.reduce((sum, t) => sum + cartValue(t) * costs[t], 0);
  // You can't dial a cart you can't afford: the edited field is pulled back
  // first, then the rest in shop order, until the total fits the bank.
  const enforceAffordability = (edited?: string): void => {
    const ids = edited ? [edited, ...types.filter((t) => t !== edited)] : [...types];
    while (cartTotal() > bank) {
      const id = ids.find((t) => cartValue(t) > 0);
      if (!id) break;
      const inp = document.getElementById(`buy-${id}`) as HTMLInputElement;
      inp.value = String(cartValue(id) - 1);
    }
  };
  const refresh = (edited?: string): void => {
    enforceAffordability(edited);
    const sum = cartTotal();
    total.textContent = `Cart total: ${sum} IPCs.`;
    remainingLine.textContent = `Remaining after purchase: ${bank - sum} IPCs.`;
    // Tighten stepper ceilings so [+] stops at what the bank covers.
    for (const t of types) {
      const inp = document.getElementById(`buy-${t}`) as HTMLInputElement | null;
      if (!inp) continue;
      const others = sum - cartValue(t) * costs[t];
      inp.max = String(Math.max(0, Math.floor((bank - others) / costs[t])));
    }
    btn.disabled = sum === 0;
  };
  el.appendChild(cartbar);
  // Assigned (not added): renderPhasePanel rebuilds this panel's contents on
  // every render, and addEventListener would stack stale closures with old
  // bank snapshots on the persistent panel node.
  el.oninput = (e) => {
    const target = e.target as HTMLElement | null;
    refresh(target?.id?.startsWith('buy-') ? target.id.slice(4) : undefined);
  };
  refresh();
  btn.addEventListener('click', () => {
    const items: Array<{ type: (typeof types)[number]; count: number }> = [];
    for (const t of types) {
      const n = cartValue(t);
      if (n > 0) items.push({ type: t, count: n });
    }
    const r = purchase(S!, pid, items);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else showError('');
    render();
  });
  el.appendChild(btn);
}

function draftList(
  el: HTMLElement,
  label: string,
  moves: Array<{ from: string; to: string }>,
  onClear: () => void,
): void {
  const d = document.createElement('div');
  d.className = 'moves';
  const h = document.createElement('strong');
  h.textContent = `${label} (${moves.length})`;
  d.appendChild(h);
  for (const m of moves) {
    const row = document.createElement('div');
    row.textContent = `${m.from} → ${m.to}`;
    d.appendChild(row);
  }
  if (moves.length > 0) {
    const c = document.createElement('button');
    c.textContent = 'Clear';
    c.addEventListener('click', onClear);
    d.appendChild(c);
  }
  el.appendChild(d);
}

function combatMovePanel(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const p = document.createElement('p');
  p.textContent = 'Click one of your territories to plan a move in a dialog. Arrows preview staged moves.';
  el.appendChild(p);
  draftList(el, 'Staged moves', draftMoves.map((m) => ({ from: m.from, to: m.to })), () => {
    draftMoves = [];
    render();
  });
  const confirm = document.createElement('button');
  confirm.textContent = 'Launch moves';
  confirm.className = 'btn-primary';
  confirm.addEventListener('click', () => {
    const r = combatMove(S!, pid, draftMoves);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      showError('');
      draftMoves = [];
      sel = null;
    }
    render();
  });
  el.appendChild(confirm);
  const none = document.createElement('button');
  none.textContent = 'No moves';
  none.addEventListener('click', () => {
    const r = combatMove(S!, pid, []);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else showError('');
    render();
  });
  el.appendChild(none);
}

function combatPanel(s: GameState, el: HTMLElement): void {
  const battles = openBattles(s);
  if (battles.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'No open battles. End the phase when ready.';
    el.appendChild(p);
    return;
  }
  const open = document.createElement('button');
  open.textContent = `Battles (${battles.length})`;
  open.addEventListener('click', () => {
    modal = 'battle';
    selectedBattle = battles[0].territoryId;
    lastCombat = null;
    render();
  });
  el.appendChild(open);
  const p = document.createElement('p');
  p.textContent = 'Resolve each battle: roll, assign casualties, retreat or fight on.';
  el.appendChild(p);
}

function battleModalBody(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const battles = openBattles(s);
  if (battles.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'All battles resolved. Close and end the phase when ready.';
    el.appendChild(p);
    return;
  }
  const list = document.createElement('div');
  list.className = 'battle-list';
  for (const b of battles) {
    const btn = document.createElement('button');
    const defName = b.defenderId === null ? 'neutral' : s.players[b.defenderId].name;
    btn.textContent = `${b.territoryId} (${b.kind}) atk ${describeUnits(b.attack)} vs ${defName} ${describeUnits(s.territories[b.territoryId].units)}`;
    if (b.territoryId === selectedBattle) btn.disabled = true;
    btn.addEventListener('click', () => {
      selectedBattle = b.territoryId;
      lastCombat = null;
      render();
    });
    list.appendChild(btn);
  }
  el.appendChild(list);
  const tid = battles.some((x) => x.territoryId === selectedBattle)
    ? selectedBattle!
    : battles[0].territoryId;
  selectedBattle = tid;
  const b = battles.find((x) => x.territoryId === tid)!;
  const defName = b.defenderId === null ? 'neutral garrison' : s.players[b.defenderId].name;

  // Force panels: both sides always visible.
  const forces = document.createElement('div');
  forces.className = 'forces';
  const atkPanel = document.createElement('div');
  atkPanel.className = 'force atk';
  const atkPending = b.pendingAttacker > 0 ? ` <span class="hits">−${b.pendingAttacker}</span>` : '';
  atkPanel.innerHTML =
    `<strong>Attacker — ${s.players[b.attackerId].name}${atkPending}</strong>` +
    unitRows(b.attack);
  const defPanel = document.createElement('div');
  defPanel.className = 'force def';
  const defUnits = s.territories[tid].units;
  const defPending = b.pendingDefender > 0 ? ` <span class="hits">−${b.pendingDefender}</span>` : '';
  defPanel.innerHTML =
    `<strong>Defender — ${defName}${defPending}</strong>` + unitRows(defUnits);
  const vs = document.createElement('div');
  vs.className = 'vs';
  vs.textContent = `⚔ round ${b.rounds + 1}`;
  forces.append(atkPanel, vs, defPanel);
  el.appendChild(forces);

  // Submerge decision (1942 2e p.29): attacker first, before any dice.
  const due = submergeTurn(s, tid);
  if (due) {
    const subP = document.createElement('div');
    subP.className = 'submerge-prompt';
    const sideName = due === 'attacker' ? s.players[b.attackerId].name : defName;
    const nSubs = due === 'attacker' ? b.attack.submarine : s.territories[tid].units.submarine;
    subP.innerHTML = `<strong>🚇 ${sideName} (${due})</strong>: submerge submarines instead of fighting? ` +
      `(${nSubs} sub(s) eligible; decide before any dice are rolled, attacker first.)`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(nSubs);
    input.value = '0';
    input.className = 'submerge-count';
    const btn = document.createElement('button');
    btn.textContent = `Decide (${due})`;
    btn.className = 'btn-primary';
    btn.addEventListener('click', () => {
      const count = Math.max(0, Math.min(nSubs, parseInt(input.value || '0', 10)));
      const decider = due === 'attacker' ? b.attackerId : b.defenderId!;
      const r = submergeSubs(S!, decider, tid, due, count);
      if (!r.ok) showError(`${r.code}: ${r.error}`);
      else showError('');
      render();
    });
    subP.append(input, btn);
    el.appendChild(subP);
  }

  // Amphibious bombardment status (1942 2e p.15).
  if (b.amphibiousFrom && !b.bombardDone && b.bombard) {
    const sh = b.bombard;
    if (sh.battleship > 0 || sh.cruiser > 0) {
      const bp = document.createElement('p');
      bp.className = 'dim';
      bp.textContent = `🚢 Bombardment ready: ${sh.battleship} battleship(s) + ${sh.cruiser} cruiser(s) shell the beach before the first land round.`;
      el.appendChild(bp);
    }
  }
  if (b.damagedAttackBB > 0 || b.damagedDefBB > 0) {
    const dp = document.createElement('p');
    dp.className = 'dim';
    dp.textContent =
      `Damaged battleships still fighting — attacker ${b.damagedAttackBB}, defender ${b.damagedDefBB}. ` +
      `Dialing a battleship as a casualty damages it first; the 2nd hit in this combat sinks it (1942 2e p.27).`;
    el.appendChild(dp);
  }

  const roll = document.createElement('button');
  roll.textContent = 'Roll one round';
  roll.className = 'btn-primary';
  roll.disabled = b.pendingAttacker > 0 || b.pendingDefender > 0;
  roll.addEventListener('click', () => {
    const r = resolveCombatRound(S!, pid, tid);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      showError('');
      lastCombat = r.combat!;
    }
    render();
  });
  el.appendChild(roll);

  if (lastCombat && lastCombat.territoryId === tid) {
    const c = lastCombat;
    const dice = document.createElement('div');
    dice.className = 'dice';
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const show = (label: string, rolls: number[], hits: number): void => {
      const row = document.createElement('div');
      row.className = 'dicerow';
      const lab = document.createElement('span');
      lab.textContent = `${label} (${hits} hit${hits === 1 ? '' : 's'}): `;
      row.appendChild(lab);
      for (const d of rolls) {
        const s = document.createElement('span');
        s.className = 'die';
        s.textContent = faces[d - 1];
        row.appendChild(s);
      }
      if (rolls.length === 0) {
        const s = document.createElement('span');
        s.className = 'dim';
        s.textContent = 'no dice';
        row.appendChild(s);
      }
      dice.appendChild(row);
    };
    if (c.aaRolls.length > 0) show('AA flak', c.aaRolls, c.aaHits);
    if (c.bombardRolls && c.bombardRolls.length > 0) {
      show('🚢 Bombardment', c.bombardRolls, c.bombardHits ?? 0);
    }
    // Submarine surprise strike (1942 2e p.29): fired before the general exchange.
    if (c.surpriseARolls && c.surpriseARolls.length > 0) {
      show('🚇 Surprise (attacker subs)', c.surpriseARolls, c.surpriseAHits ?? 0);
    }
    if (c.surpriseDRolls && c.surpriseDRolls.length > 0) {
      show('🚇 Surprise (defender subs)', c.surpriseDRolls, c.surpriseDHits ?? 0);
    }
    if (c.sbrDamage !== undefined) {
      const p = document.createElement('div');
      p.className = 'sbrhit';
      p.textContent = `💥 Bombing raid: ${c.sbrDamage} IPC damage`;
      dice.appendChild(p);
    } else {
      show('Attack', c.attackRolls, c.attackHits);
      show('Defense', c.defenseRolls, c.defenseHits);
    }
    el.appendChild(dice);
  }

  for (const side of ['attacker', 'defender'] as const) {
    const pending = side === 'attacker' ? b.pendingAttacker : b.pendingDefender;
    if (pending === 0) continue;
    if (side === 'defender' && b.defenderId === null) continue;
    const force = side === 'attacker' ? b.attack : s.territories[tid].units;
    // You can only lose what you have: cap the total at min(hits, live units).
    let liveNoAA = 0;
    for (const u of UNIT_ORDER) {
      if (u === 'aa') continue; // AA is captured, never a casualty
      liveNoAA += force[u];
    }
    const required = Math.min(pending, liveNoAA);
    const box = document.createElement('div');
    box.className = 'casualties';
    const title = document.createElement('strong');
    title.textContent = `${side === 'attacker' ? 'Attacker' : 'Defender'} loses ${required} — dial casualties: `;
    box.appendChild(title);
    for (const t of UNIT_ORDER) {
      if (t === 'aa') continue; // AA is captured, never a casualty
      box.appendChild(stepper(`cas-${side}`, t, Math.min(force[t], required)));
    }
    const count = document.createElement('span');
    count.id = `cas-${side}-count`;
    count.className = 'dim';
    box.appendChild(count);
    const apply = document.createElement('button');
    apply.textContent = 'Apply';
    apply.id = `cas-${side}-apply`;
    apply.addEventListener('click', () => {
      const r = chooseCasualties(S!, pid, tid, side, readUnits(`cas-${side}`));
      if (!r.ok) showError(`${r.code}: ${r.error}`);
      else showError('');
      render();
    });
    const auto = document.createElement('button');
    auto.textContent = 'Auto';
    auto.addEventListener('click', () => {
      const r = autoCasualties(S!, pid, tid, side);
      if (!r.ok) showError(`${r.code}: ${r.error}`);
      else showError('');
      render();
    });
    box.append(apply, auto);
    el.appendChild(box);
    const refreshCas = (): void => {
      let sum = 0;
      for (const t of UNIT_ORDER) {
        if (t === 'aa') continue;
        const n = parseInt((document.getElementById(`cas-${side}-${t}`) as HTMLInputElement)?.value, 10) || 0;
        sum += Math.max(0, Math.min(n, force[t]));
      }
      count.textContent = ` ${sum}/${required}`;
      apply.disabled = sum !== required;
    };
    box.oninput = refreshCas;
    refreshCas();
  }

  if (b.kind === 'combat' && b.rounds >= 1 && b.pendingAttacker === 0 && b.pendingDefender === 0) {
    const box = document.createElement('div');
    box.innerHTML = '<strong>Retreat land units to: </strong>';
    const select = document.createElement('select');
    select.id = 'retreat-to';
    for (const o of b.origins) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      select.appendChild(opt);
    }
    const go = document.createElement('button');
    go.textContent = 'Retreat';
    go.addEventListener('click', () => {
      const r = retreat(S!, pid, tid, (document.getElementById('retreat-to') as HTMLSelectElement).value);
      if (!r.ok) showError(`${r.code}: ${r.error}`);
      else showError('');
      render();
    });
    box.append(select, go);
    el.appendChild(box);
  }
}

function nonCombatPanel(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const unlanded: string[] = [];
  for (const b of s.battles) {
    const air = (b.attack.fighter ?? 0) + (b.attack.bomber ?? 0);
    if (air > 0) unlanded.push(`${air} air over ${b.territoryId}`);
  }
  for (const [tid, t] of Object.entries(s.territories)) {
    if (t.owner !== pid) continue;
    if (s.ownedAtTurnStart.includes(tid)) continue;
    const air = t.units.fighter + t.units.bomber;
    if (air > 0) unlanded.push(`${air} air in ${tid} (must land)`);
  }
  const p = document.createElement('p');
  p.textContent =
    unlanded.length > 0
      ? `Land this air: ${unlanded.join('; ')}. Open its move dialog and pick a landing spot.`
      : 'Click a territory to plan a move in a dialog. Green arrows preview.';
  el.appendChild(p);
  draftList(el, 'Staged moves', draftNonCombat.map((m) => ({ from: m.from, to: m.to })), () => {
    draftNonCombat = [];
    render();
  });
  const confirm = document.createElement('button');
  confirm.textContent = 'Fly / march';
  confirm.className = 'btn-primary';
  confirm.addEventListener('click', () => {
    const r = nonCombatMove(S!, pid, draftNonCombat);
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      showError('');
      draftNonCombat = [];
      sel = null;
    }
    render();
  });
  el.appendChild(confirm);
}

function mobilizePanel(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const p = document.createElement('p');
  p.textContent = 'Click a factory territory, dial units from the pool in the inspector, stage, then deploy all.';
  el.appendChild(p);
  const d = document.createElement('div');
  d.className = 'moves';
  const h = document.createElement('strong');
  h.textContent = `Staged deployments (${draftMob.length})`;
  d.appendChild(h);
  for (const m of draftMob) {
    const row = document.createElement('div');
    const where = m.seaZone
      ? `${m.seaZone} (via ${m.territory} factory)`
      : m.territory;
    row.textContent = `${describeUnits({ ...emptyUnits(), ...m.units })}${m.buildFactory ? ' +factory' : ''} @ ${where}`;
    d.appendChild(row);
  }
  if (draftMob.length > 0) {
    const c = document.createElement('button');
    c.textContent = 'Clear';
    c.addEventListener('click', () => {
      draftMob = [];
      render();
    });
    d.appendChild(c);
  }
  el.appendChild(d);
  const confirm = document.createElement('button');
  confirm.textContent = 'Deploy';
  confirm.className = 'btn-primary';
  confirm.addEventListener('click', () => {
    const r = mobilize(
      S!,
      pid,
      draftMob.map((x) => ({
        territory: x.territory,
        units: x.units,
        ...(x.buildFactory ? { buildFactory: true as const } : {}),
        ...(x.seaZone ? { seaZone: x.seaZone } : {}),
      })),
    );
    if (!r.ok) showError(`${r.code}: ${r.error}`);
    else {
      showError('');
      draftMob = [];
    }
    render();
  });
  el.appendChild(confirm);
}

function renderLog(s: GameState): void {
  const el = $('log');
  el.innerHTML = '';
  for (const e of s.events.slice(-200)) {
    const d = document.createElement('div');
    d.textContent = `#${e.seq} r${e.round} ${e.detail}`;
    el.appendChild(d);
  }
  el.scrollTop = el.scrollHeight;
}

function renderChat(s: GameState): void {
  const el = $('chat');
  el.innerHTML = '';
  for (const m of s.chatLog.slice(-50)) {
    const d = document.createElement('div');
    d.textContent = `[r${m.round}] ${m.sender} -> ${m.recipients}: ${m.text}`;
    el.appendChild(d);
  }
  el.scrollTop = el.scrollHeight;
}

boot();
