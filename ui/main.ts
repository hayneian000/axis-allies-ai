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
  $('fb-phase').textContent =
    s.phase === 'gameover'
      ? `Game over — ${s.players[s.winner!].name} wins`
      : `Round ${s.round} — ${s.players[s.currentPlayer].name} — ${s.phase}`;
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
  $('banner').textContent =
    s.phase === 'gameover'
      ? `Game over — ${s.players[s.winner!].name} wins (${s.winReason})`
      : `Round ${s.round} — ${me.name}'s turn — phase: ${s.phase} — bank ${me.ipcs} IPCs — income ${incomeOf(s, s.currentPlayer)}`;
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
    d.style.borderLeft = `6px solid ${p.color}`;
    d.textContent = `${p.name}${p.alive ? '' : ' (OUT)'} — ${ownedTerritories(s, p.id).length} terr, ${p.ipcs} IPCs${ownsCapital(s, p.id) ? '' : ', NO CAPITAL'}`;
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
  m.appendChild(defs);

  const battles = new Set(openBattles(s).map((b) => b.territoryId));
  const dests = legalDestinations(s);
  for (const t of MAP.territories) {
    const st = s.territories[t.id];
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', t.points.map((p) => p.join(',')).join(' '));
    poly.setAttribute('fill', ownerColor(s, st.owner));
    let cls = 'terr';
    if (t.id === sel) cls += ' selfrom';
    else if (dests.has(t.id)) cls += ' dest';
    poly.setAttribute('class', cls);
    if (s.players.some((p) => p.capital === t.id)) {
      poly.setAttribute('stroke', '#ffd700');
      poly.setAttribute('stroke-width', '3');
    }
    poly.addEventListener('click', () => onTerrClick(t.id));
    m.appendChild(poly);
  }

  // Draft-move arrows under the labels.
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
    m.appendChild(line);
  }

  for (const t of MAP.territories) {
    const st = s.territories[t.id];
    const [lx, ly] = t.label;
    const isCap = s.players.some((p) => p.capital === t.id);
    const label = (text: string, dy: number, size: number, bold = false): void => {
      const el = document.createElementNS(SVGNS, 'text');
      el.setAttribute('x', String(lx));
      el.setAttribute('y', String(ly + dy));
      el.setAttribute('text-anchor', 'middle');
      el.setAttribute('font-size', String(size));
      if (bold) el.setAttribute('font-weight', 'bold');
      el.textContent = text;
      m.appendChild(el);
    };
    label(`${DISPLAY_NAME[t.id] ?? t.name}${isCap ? ' ★' : ''}${battles.has(t.id) ? ' ⚔' : ''}`, -8, 12, true);
    label(`IPC ${ipcOf(t.id)} · ${st.owner === null ? 'neutral' : s.players[st.owner].name}`, 6, 10);
    label(unitSummary(s, t.id), 20, 10.5);
  }
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

function onTerrClick(tid: string): void {
  if (!S || S.phase === 'gameover') return;
  const s = S;
  // Clicking your own territory in a move phase plans the move in a dialog.
  if (
    (s.phase === 'combatMove' || s.phase === 'nonCombat') &&
    s.territories[tid].owner === s.currentPlayer
  ) {
    sel = tid;
    modal = 'move';
    showError('');
    render();
    return;
  }
  sel = sel === tid ? null : tid;
  render();
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
  const isCap = s.players.some((p) => p.capital === sel);
  head.innerHTML =
    `<strong>${DISPLAY_NAME[sel] ?? def.name}</strong> ` +
    `<span class="chip" style="background:${ownerColor(s, t.owner)}">${t.owner === null ? 'neutral' : s.players[t.owner].name}</span> ` +
    `<span>IPC ${ipcOf(sel)}</span>${isCap ? ' ★capital' : ''}${t.factory ? ' ⚙factory' : ''}`;
  el.appendChild(head);
  const units = document.createElement('div');
  units.textContent = `Units here: ${describeUnits(t.units)}`;
  el.appendChild(units);

  const pid = s.currentPlayer;
  if (!mine) {
    const p = document.createElement('p');
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
  h.textContent =
    s.phase === 'gameover' ? 'Game over' : `${s.players[s.currentPlayer].name} — ${s.phase}`;
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
  open.addEventListener('click', () => {
    modal = 'shop';
    render();
  });
  el.appendChild(open);
}

function purchaseShopBody(s: GameState, el: HTMLElement): void {
  const pid = s.currentPlayer;
  const bank = s.players[pid].ipcs;
  const remainingLine = document.createElement('p');
  remainingLine.id = 'buy-remaining';
  el.appendChild(remainingLine);
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
  for (const t of types) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.innerHTML = `<strong>${t}</strong> <span class="dim">${costs[t]} IPC · ${notes[t]}</span>`;
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
  const total = document.createElement('p');
  const btn = document.createElement('button');
  btn.textContent = 'Buy';
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
  el.appendChild(total);
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
