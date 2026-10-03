import { MAP, UNITS, centroid, ipcOf, neighborsOf, type UnitType } from '../data/data';
import {
  autoCasualties,
  chooseCasualties,
  combatMove,
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
  purchase,
  resolveCombatRound,
  retreat,
  sendMessage,
  serialize,
} from '../engine/engine';
import type { CombatMove, GameState, NonCombatMove, UnitCounts } from '../engine/types';

const SVGNS = 'http://www.w3.org/2000/svg';
const UNIT_ORDER: UnitType[] = ['infantry', 'artillery', 'tank', 'fighter', 'bomber', 'aa'];
const SHORT: Record<UnitType, string> = {
  infantry: 'inf',
  artillery: 'art',
  tank: 'tnk',
  fighter: 'ftr',
  bomber: 'bmb',
  aa: 'aa',
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
let draftMoves: CombatMove[] = [];
let draftNonCombat: NonCombatMove[] = [];
let draftMob: Array<{ territory: string; units: Partial<UnitCounts>; buildFactory?: boolean }> = [];
let selectedBattle: string | null = null;
let lastCombat: import('../engine/types').CombatRoundResult | null = null;
let modal: 'shop' | 'battle' | 'move' | null = null;
let lastLaunchMsg: string | null = null;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const svg = (): SVGSVGElement => $('map') as unknown as SVGSVGElement;

function showError(msg: string): void {
  $('error').textContent = msg;
}

// ------------------------------------------------------------ boot ---

function boot(): void {
  $('startBtn').addEventListener('click', () => {
    const numPlayers = parseInt(($('numPlayers') as HTMLSelectElement).value, 10);
    const seed = parseInt(($('seed') as HTMLInputElement).value, 10) || 1;
    S = createGame({ numPlayers, seed });
    draftMoves = [];
    draftNonCombat = [];
    draftMob = [];
    selectedBattle = null;
    lastCombat = null;
    sel = null;
    $('setup').hidden = true;
    $('game').hidden = false;
    render();
  });
  $('newBtn').addEventListener('click', () => {
    S = null;
    $('game').hidden = true;
    $('setup').hidden = false;
  });
  $('endPhaseBtn').addEventListener('click', () => {
    if (!S) return;
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
  ($('loadInput') as HTMLInputElement).addEventListener('change', (e) => {
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
    $('log').hidden = false;
    $('chatwrap').hidden = true;
  });
  $('tab-chat').addEventListener('click', () => {
    $('tab-chat').classList.add('active');
    $('tab-log').classList.remove('active');
    $('log').hidden = true;
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
    view = { x: 0, y: 0, k: 1 };
    applyView();
  });
  $('zin').addEventListener('click', () => zoomOnPoint({ x: VB_W / 2, y: VB_H / 2 }, 1.25));
  $('zout').addEventListener('click', () => zoomOnPoint({ x: VB_W / 2, y: VB_H / 2 }, 1 / 1.25));
  $('zreset').addEventListener('click', () => {
    view = { x: 0, y: 0, k: 1 };
    applyView();
  });
}

function ownerColor(state: GameState, owner: number | null): string {
  if (owner === null) return '#8a8f98';
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

function renderBanner(s: GameState): void {
  const me = s.players[s.currentPlayer];
  // Chips are pure styling: textContent stays byte-identical to before.
  const sep = '<span class="bsep"> — </span>';
  $('banner').innerHTML =
    s.phase === 'gameover'
      ? `<span class="bstat">Game over</span>${sep}<span class="bstat turn">${s.players[s.winner!].name} wins (${s.winReason})</span>`
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
const VB_W = 1000;
const VB_H = 470;
let view = { x: 0, y: 0, k: 1 };

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

/** One territory: tile + sheen + labels + badges + unit icons, in MAP order. */
function terrGroup(s: GameState, tid: string, inBattle: boolean, isDest: boolean): SVGElement {
  const t = MAP.territories.find((x) => x.id === tid)!;
  const st = s.territories[tid];
  const bb = bboxOf(t.points);
  const [lx, ly] = t.label;
  const g = svgEl('g', { class: 'tgroup', 'data-terr': tid });

  // Native tooltip + accessible summary + test hook for force contents.
  const tip = document.createElementNS(SVGNS, 'title');
  tip.textContent =
    `${DISPLAY_NAME[tid] ?? t.name} — ${st.owner === null ? 'neutral' : s.players[st.owner].name}` +
    ` — IPC ${ipcOf(tid)} — ${unitSummary(s, tid)}`;
  g.appendChild(tip);

  const pts = t.points.map((p) => p.join(',')).join(' ');
  // NOTE: `fill` stays the exact owner color (tests + roster legend key off it);
  // depth comes from the translucent gradient overlay below.
  const poly = svgEl('polygon', { points: pts, fill: ownerColor(s, st.owner) });
  let cls = 'terr';
  if (tid === sel) cls += ' selfrom';
  else if (isDest) cls += ' dest';
  if (inBattle) cls += ' battle';
  poly.setAttribute('class', cls);
  const isCap = s.players.some((p) => p.capital === tid);
  if (isCap) {
    poly.setAttribute('stroke', '#ffd700');
    poly.setAttribute('stroke-width', '3');
  }
  poly.addEventListener('click', (e) => onTerrClick(tid, e as MouseEvent));
  poly.addEventListener('mousemove', moveTip);
  poly.addEventListener('mouseleave', hideTip);
  g.appendChild(poly);
  g.appendChild(
    svgEl('polygon', { points: pts, fill: 'url(#sheen)', class: 'sheen', 'pointer-events': 'none' }),
  );

  // Name + owner stacked on the label anchor.
  const name = svgEl('text', {
    x: String(lx),
    y: String(ly - 12),
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

  // IPC value pill heading the label stack (bbox pinning collided with
  // names on short tiles like Oklahoma).
  const badge = svgEl('g', { class: 'ipcbadge', transform: `translate(${lx} ${ly - 27})` });
  badge.appendChild(svgEl('rect', { x: '-21', y: '-7', width: '42', height: '14', rx: '7', class: 'ipcpill' }));
  const bt = svgEl('text', { x: '0', y: '3.5', 'text-anchor': 'middle', 'font-size': '9.5', class: 'ipctext' });
  bt.textContent = `IPC ${ipcOf(tid)}`;
  badge.appendChild(bt);
  g.appendChild(badge);

  // Capital star pinned to the top-right corner.
  if (isCap) {
    const cap = svgEl('g', { class: 'capbadge', transform: `translate(${bb.x1 - 9} ${bb.y0 + 10})` });
    cap.appendChild(svgEl('circle', { cx: '0', cy: '0', r: '7.5', class: 'capring' }));
    const star = svgEl('text', { x: '0', y: '3.5', 'text-anchor': 'middle', 'font-size': '10', class: 'capstar' });
    star.textContent = '★';
    cap.appendChild(star);
    g.appendChild(cap);
  }

  const present = UNIT_ORDER.filter((u) => st.units[u] > 0);

  // Factory silhouette centered below the icon row (bbox corners often fall
  // outside organic shapes, leaving the glyph floating off-tile).
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
  // Top-light sheen for territory tiles; ocean backdrop gradient.
  const sheen = svgEl('linearGradient', { id: 'sheen', x1: '0', y1: '0', x2: '0', y2: '1' });
  sheen.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#ffffff', 'stop-opacity': '.26' }));
  sheen.appendChild(svgEl('stop', { offset: '.45', 'stop-color': '#ffffff', 'stop-opacity': '.05' }));
  sheen.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#000000', 'stop-opacity': '.16' }));
  defs.appendChild(sheen);
  const ocean = svgEl('linearGradient', { id: 'ocean', x1: '0', y1: '0', x2: '1', y2: '1' });
  ocean.appendChild(svgEl('stop', { offset: '0', 'stop-color': '#262c38' }));
  ocean.appendChild(svgEl('stop', { offset: '1', 'stop-color': '#1b1f28' }));
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

  const battles = new Set(openBattles(s).map((b) => b.territoryId));
  const dests = legalDestinations(s);
  for (const t of MAP.territories) {
    vport.appendChild(terrGroup(s, t.id, battles.has(t.id), dests.has(t.id)));
  }

  // Great Lakes water overlays: drawn above land, below labels/arrows;
  // pointer-events none so territory clicks pass through.
  for (const lake of MAP.lakes ?? []) {
    const tip = document.createElementNS(SVGNS, 'title');
    tip.textContent = lake.name;
    const el = svgEl('ellipse', {
      cx: String(lake.cx),
      cy: String(lake.cy),
      rx: String(lake.rx),
      ry: String(lake.ry),
      fill: '#3d6a8f',
      stroke: '#7fb3d9',
      'stroke-width': '1.5',
      'pointer-events': 'none',
      class: 'lake',
      transform: `rotate(${lake.rotate} ${lake.cx} ${lake.cy})`,
    });
    el.appendChild(tip);
    vport.appendChild(el);
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
    line.setAttribute('stroke-width', '3');
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
  document
    .getElementById('vport')
    ?.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
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
  const k2 = Math.min(6, Math.max(1, view.k * factor));
  if (k2 === 1) {
    view = { x: 0, y: 0, k: 1 };
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
  if (s.phase === 'combatMove') {
    for (const n of neighborsOf(sel)) out.add(n);
  } else if (s.phase === 'nonCombat') {
    for (const n of neighborsOf(sel)) {
      if (s.territories[n].owner === s.currentPlayer) out.add(n);
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
  }
  render();
  if (ripple) {
    const c = svgEl('circle', {
      cx: ripple.x.toFixed(1),
      cy: ripple.y.toFixed(1),
      r: '6',
      class: 'ripple',
      'pointer-events': 'none',
    });
    document.getElementById('vport')?.appendChild(c);
    window.setTimeout(() => c.remove(), 650);
  }
}

function stageMoveFromInspector(from: string, to: string): void {
  if (!S) return;
  if (S.phase === 'combatMove') {
    const viaEl = document.getElementById('mv-via') as HTMLInputElement | null;
    const sbrEl = document.getElementById('mv-sbr') as HTMLInputElement | null;
    const via = (viaEl?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    draftMoves.push({
      from,
      to,
      units: readUnits('mv'),
      ...(via.length > 0 ? { via } : {}),
      ...(sbrEl?.checked ? { sbr: true } : {}),
    });
  } else {
    draftNonCombat.push({ from, to, units: readUnits('nc') });
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
  const restore = (): void => {
    for (const [id, v] of Object.entries(saved)) {
      const n = document.getElementById(id) as HTMLInputElement | null;
      if (!n) continue;
      if (n.type === 'checkbox') n.checked = v.checked;
      else n.value = v.value;
    }
  };
  if (!sel) {
    el.textContent = 'Click a territory to inspect it.';
    return;
  }
  const t = s.territories[sel];
  const def = MAP.territories.find((x) => x.id === sel)!;
  const mine = t.owner === s.currentPlayer;
  const head = document.createElement('div');
  head.className = 'insp-head';
  const isCap = s.players.some((p) => p.capital === sel);
  head.innerHTML =
    `<strong>${DISPLAY_NAME[sel] ?? def.name}</strong> ` +
    `<span class="chip" style="background:${ownerColor(s, t.owner)}">${t.owner === null ? 'neutral' : s.players[t.owner].name}</span> ` +
    `<span>IPC ${ipcOf(sel)}</span>${isCap ? ' ★capital' : ''}${t.factory ? ' ⚙factory' : ''}`;
  el.appendChild(head);
  const units = document.createElement('div');
  units.className = 'insp-units';
  units.textContent = `Units here: ${describeUnits(t.units)}`;
  el.appendChild(units);

  const pid = s.currentPlayer;
  if (!mine) {
    const p = document.createElement('p');
    p.className = 'insp-hint';
    p.textContent =
      s.phase === 'combatMove'
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
  head.innerHTML =
    `<strong>${DISPLAY_NAME[tid] ?? def.name}</strong> — ${describeUnits(t.units)}` +
    (t.factory ? ' ⚙factory' : '');
  el.appendChild(head);
  const isCombat = s.phase === 'combatMove';
  const prefix = isCombat ? 'mv' : 'nc';
  const grid = document.createElement('div');
  grid.className = 'stepgrid';
  let any = false;
  for (const u of UNIT_ORDER) {
    if (u === 'aa' && isCombat) continue; // AA can't attack
    if (t.units[u] <= 0) continue;
    any = true;
    grid.appendChild(stepper(prefix, u, t.units[u]));
  }
  if (!any) {
    const p = document.createElement('p');
    p.textContent = 'No movable units here.';
    el.appendChild(p);
    return;
  }
  el.appendChild(grid);
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
  const dests = neighborsOf(tid).filter((n) =>
    isCombat ? true : s.territories[n].owner === pid,
  );
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
    btn.textContent = `${DISPLAY_NAME[d] ?? ddef.name} (${owner}, ${describeUnits(dt.units)}${dt.factory ? ', FAC' : ''})`;
    btn.addEventListener('click', () => {
      const n = countUnits({ ...emptyUnits(), ...readUnits(s.phase === 'combatMove' ? 'mv' : 'nc') });
      if (n === 0) {
        showError('Dial at least one unit before picking a destination.');
        return;
      }
      stageMoveFromInspector(tid, d);
      modal = null;
      showError('');
      render();
    });
    el.appendChild(btn);
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
    p.textContent = `${s.players[s.winner!].name} wins (${s.winReason}). Start a new game to play again.`;
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
    factory: 15,
  };
  const notes: Record<string, string> = {
    infantry: 'A1 D2 M1 (+artillery)',
    artillery: 'A2 D2 M1',
    tank: 'A3 D3 M2 blitz',
    fighter: 'A3 D4 M4',
    bomber: 'A4 D1 M6 SBR',
    aa: 'air defense, M1',
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
    const required = Math.min(
      pending,
      force.infantry + force.artillery + force.tank + force.fighter + force.bomber,
    );
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
    row.textContent = `${describeUnits({ ...emptyUnits(), ...m.units })}${m.buildFactory ? ' +factory' : ''} @ ${m.territory}`;
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
      draftMob.map((x) => ({ territory: x.territory, units: x.units, ...(x.buildFactory ? { buildFactory: true as const } : {}) })),
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
