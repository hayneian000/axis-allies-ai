// Phase 2 game runner (M2+M3): drives AI seats through agents/driver.ts in
// the browser, renders the spectator UI, and hands human turns to the
// existing hot-seat UI via the driver bridge (ui/driverBridge.ts).
//
// M3 diplomacy: the driver opens a freeform-talk window each round (see
// agents/diplomacy.ts). This module renders the diplomacy panel (threads,
// budget meters, human compose box), wires the human "done talking" handoff,
// and offers the end-of-game JSON dump.

import { Agent, type ActResult, type AgentOptions } from '../agents/agent';
import {
  runGame,
  MaxRoundsExceeded,
  type DriverEvents,
  type SeatRuntime,
} from '../agents/driver';
import {
  buildDiplomacyDump,
  DIPLOMACY_BUDGET_PER_ROUND,
  DiplomacyLedger,
  isPrivateMessage,
} from '../agents/diplomacy';
import { getProvider } from '../agents/providers/index';
import { keyStore } from '../agents/keys';
import { MissingKeyError, classifyProviderError } from '../agents/errors';
import { emptyUsage } from '../agents/types';
import type { SeatConfig, PlayerUsage, ToolCall } from '../agents/types';
import { createGame, sendMessage } from '../engine/engine';
import type { GameState, Phase } from '../engine/types';
import { bridge } from './driverBridge';

export interface AiGameConfig {
  seats: SeatConfig[];
  playerNames: string[];
  seed: number;
}

class StoppedError extends Error {
  constructor(msg = 'Driver stopped') {
    super(msg);
    this.name = 'StoppedError';
  }
}

interface RunControl {
  paused: boolean;
  stopped: boolean;
  setPaused(p: boolean): void;
  stop(): void;
  waitIfPaused(): Promise<void>;
}

function makeRunControl(): RunControl {
  const ctrl: RunControl = {
    paused: false,
    stopped: false,
    setPaused(p: boolean) {
      ctrl.paused = p;
    },
    stop() {
      ctrl.stopped = true;
    },
    async waitIfPaused(): Promise<void> {
      // Pause takes effect between phases (each act() is one provider call).
      while (ctrl.paused && !ctrl.stopped) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (ctrl.stopped) throw new StoppedError();
    },
  };
  return ctrl;
}

type FailureChoice = 'retry' | 'skip' | 'pass-rest';

interface SeatUiEvents {
  onThought(
    pid: number,
    phase: Phase,
    text: string,
    toolCalls: ToolCall[],
    usage: PlayerUsage,
  ): void;
  onFailure(pid: number, err: unknown): Promise<FailureChoice>;
}

let skipSeq = 0;
function endPhaseResult(text: string): ActResult {
  return {
    toolCalls: [{ id: `ui-skip-${++skipSeq}`, name: 'end_phase', arguments: {} }],
    text,
    usage: emptyUsage(),
  };
}

/**
 * One AI seat with UI concerns layered on: pause gating, seat-level failure
 * handling (the game never dies because one key does), and thought events
 * for the spectator panel. Provider failures surface as a host decision —
 * retry / skip phase / pass rest of game — instead of an exception.
 */
class UiAgent extends Agent {
  private passRest = false;

  constructor(
    opts: AgentOptions,
    private readonly pid: number,
    private readonly providerId: string,
    private readonly providerLabel: string,
    private readonly ctrl: RunControl,
    private readonly seatUi: SeatUiEvents,
  ) {
    super(opts);
  }

  override async act(state: GameState, phase: Phase): Promise<ActResult> {
    if (this.passRest) {
      return endPhaseResult('Seat replaced with a passing commander — ending phase.');
    }
    for (;;) {
      await this.ctrl.waitIfPaused();
      try {
        const r = await super.act(state, phase);
        this.seatUi.onThought(this.pid, phase, r.text, r.toolCalls, this.usage);
        return r;
      } catch (err) {
        if (err instanceof StoppedError) throw err;
        const choice = await this.seatUi.onFailure(this.pid, err);
        if (choice === 'retry') continue;
        if (choice === 'pass-rest') this.passRest = true;
        return endPhaseResult(
          choice === 'pass-rest'
            ? 'Seat replaced with a passing commander — ending phase.'
            : 'Phase skipped by host — ending phase.',
        );
      }
    }
  }

  /**
   * Diplomacy-window counterpart of act(): same pause gating and seat-level
   * failure handling. On host skip, the seat leaves diplomacy voluntarily.
   */
  override async diplomacyAct(state: GameState, budgetRemaining: number): Promise<ActResult> {
    if (this.passRest) {
      return dipDoneResult('Seat replaced with a passing commander — leaving diplomacy.');
    }
    for (;;) {
      await this.ctrl.waitIfPaused();
      try {
        return await super.diplomacyAct(state, budgetRemaining);
      } catch (err) {
        if (err instanceof StoppedError) throw err;
        const choice = await this.seatUi.onFailure(this.pid, err);
        if (choice === 'retry') continue;
        if (choice === 'pass-rest') this.passRest = true;
        return dipDoneResult('Diplomacy skipped by host.');
      }
    }
  }
}

function dipDoneResult(text: string): ActResult {
  return {
    toolCalls: [{ id: `ui-dipskip-${++skipSeq}`, name: 'end_diplomacy', arguments: {} }],
    text,
    usage: emptyUsage(),
  };
}

// ---------------------------------------------------------- spectator ---

function el(tag: string, cls = '', text = ''): HTMLElement {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text) d.textContent = text;
  return d;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function fmtUsage(u: PlayerUsage): string {
  const base = `${u.calls} calls · ${fmtTokens(u.inputTokens)} in / ${fmtTokens(u.outputTokens)} out · ${u.errors} errors`;
  const d = u.diplomacy;
  if (d && (d.calls > 0 || d.inputTokens > 0 || d.outputTokens > 0)) {
    return `${base} · dip ${d.calls} calls ${fmtTokens(d.inputTokens + d.outputTokens)} tok`;
  }
  return base;
}

interface SeatCard {
  root: HTMLElement;
  status: HTMLElement;
  usage: HTMLElement;
  rationale: HTMLElement;
  tools: HTMLElement;
}

const seatCards = new Map<number, SeatCard>();
let aiFeed: HTMLElement | null = null;
let aiHeaderStatus: HTMLElement | null = null;
let pauseBtn: HTMLButtonElement | null = null;

function providerChip(seat: SeatConfig): string {
  if (seat.kind !== 'ai') return 'Human';
  const adapter = getProvider(seat.provider!);
  return `${adapter.label} · ${seat.model}`;
}

function buildSpectatorPanel(seats: SeatConfig[], playerNames: string[], ctrl: RunControl): void {
  seatCards.clear();
  const host = document.getElementById('ai');
  if (!host) return;
  host.innerHTML = '';

  const head = el('div', 'ai-head panel');
  const title = el('span', 'stencil-head', 'AI Commanders');
  aiHeaderStatus = el('span', 'ai-head-status', 'Starting…');
  pauseBtn = document.createElement('button');
  pauseBtn.className = 'btn btn-steel';
  pauseBtn.textContent = 'Pause';
  pauseBtn.addEventListener('click', () => {
    ctrl.setPaused(!ctrl.paused);
    pauseBtn!.textContent = ctrl.paused ? 'Resume' : 'Pause';
    if (aiHeaderStatus) aiHeaderStatus.textContent = ctrl.paused ? 'Paused — resumes between phases.' : 'Running…';
  });
  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn btn-steel';
  stopBtn.textContent = 'Stop';
  stopBtn.addEventListener('click', () => {
    stopAiGame();
    if (aiHeaderStatus) aiHeaderStatus.textContent = 'Stopped by host.';
  });
  head.append(title, aiHeaderStatus, pauseBtn, stopBtn);
  host.appendChild(head);

  const list = el('div', 'ai-seats');
  seats.forEach((seat, i) => {
    const card = el('div', 'ai-seat panel');
    const name = playerNames[i] ?? `Player ${i + 1}`;
    const dot = el('span', 'pdot');
    // Player colors come from the live game state; set on first update.
    dot.dataset.pid = String(i);
    const headRow = el('div', 'ai-seat-head');
    headRow.append(dot, el('strong', '', name), el('span', 'chip', providerChip(seat)));
    const status = el('div', 'ai-seat-status', seat.kind === 'ai' ? 'Waiting…' : 'Human seat');
    const usage = el('div', 'ai-seat-usage', seat.kind === 'ai' ? fmtUsage(emptyUsage()) : '');
    card.append(headRow, status, usage);
    if (seat.kind === 'ai') {
      const det = document.createElement('details');
      det.className = 'ai-rationale';
      const sum = document.createElement('summary');
      sum.textContent = 'Rationale';
      const rtext = el('div', 'ai-text');
      const rtools = el('div', 'ai-tools');
      det.append(sum, rtext, rtools);
      card.appendChild(det);
      seatCards.set(i, { root: card, status, usage, rationale: rtext, tools: rtools });
    }
    list.appendChild(card);
  });
  host.appendChild(list);

  const actPanel = el('div', 'ai-activity panel');
  actPanel.appendChild(el('h4', 'stencil-head', 'Activity'));
  aiFeed = el('div', 'ai-feed');
  actPanel.appendChild(aiFeed);
  host.appendChild(actPanel);

  // Reveal the AI tab and wire its button (once).
  const tabBtn = document.getElementById('tab-ai') as HTMLButtonElement;
  tabBtn.hidden = false;
  tabBtn.onclick = () => showAiTab();
  showAiTab();
}

function showAiTab(): void {
  for (const id of ['tab-log', 'tab-chat', 'tab-ai']) {
    document.getElementById(id)!.classList.toggle('active', id === 'tab-ai');
  }
  (document.getElementById('log') as HTMLElement).hidden = true;
  (document.getElementById('chatwrap') as HTMLElement).hidden = true;
  (document.getElementById('aiwrap') as HTMLElement).hidden = false;
}

function setSeatStatus(pid: number, text: string): void {
  seatCards.get(pid)?.status && (seatCards.get(pid)!.status.textContent = text);
}

function feed(html: string): void {
  if (!aiFeed) return;
  const d = document.createElement('div');
  d.innerHTML = html;
  aiFeed.prepend(d);
  while (aiFeed.children.length > 40) aiFeed.lastChild?.remove();
}

// -------------------------------------------------------- diplomacy ---

type DipFilter = 'all' | 'public' | 'private';

let dipLedger: DiplomacyLedger | null = null;
let dipState: GameState | null = null;
let dipSeats: SeatConfig[] = [];
let dipNames: string[] = [];
let dipFilter: DipFilter = 'all';
let dipStatus: HTMLElement | null = null;
let dipFeedEl: HTMLElement | null = null;
let dipBudgetsEl: HTMLElement | null = null;
let dipCompose: HTMLElement | null = null;
let dipTo: HTMLSelectElement | null = null;
let dipText: HTMLInputElement | null = null;
let dipComposePid: number | null = null;
let dipDoneResolve: (() => void) | null = null;

/**
 * Spectator view shows ALL traffic with private messages labeled "private".
 * (Open decision from the spec — flippable to recipient-filtered later.)
 */
function buildDiplomacyPanel(): void {
  const host = document.getElementById('ai');
  if (!host) return;
  const panel = el('div', 'ai-diplomacy panel');
  const head = el('div', 'ai-dip-head');
  head.appendChild(el('h4', 'stencil-head', 'Diplomacy'));
  dipStatus = el('span', 'ai-dip-status', 'No window open.');
  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn btn-steel';
  dlBtn.textContent = 'Download diplomacy JSON';
  dlBtn.title = 'Download the full diplomacy record (messages, spend, result)';
  dlBtn.addEventListener('click', () => downloadDiplomacyDump());
  head.append(dipStatus, dlBtn);
  panel.appendChild(head);

  const filters = el('div', 'dip-filters');
  (['all', 'public', 'private'] as DipFilter[]).forEach((f) => {
    const b = document.createElement('button');
    b.className = 'btn btn-steel' + (f === dipFilter ? ' active' : '');
    b.textContent = f[0].toUpperCase() + f.slice(1);
    b.addEventListener('click', () => {
      dipFilter = f;
      for (const x of filters.querySelectorAll('button')) x.classList.remove('active');
      b.classList.add('active');
      renderDiplomacy();
    });
    filters.appendChild(b);
  });
  panel.appendChild(filters);

  dipBudgetsEl = el('div', 'dip-budgets');
  panel.appendChild(dipBudgetsEl);

  dipFeedEl = el('div', 'dip-feed');
  panel.appendChild(dipFeedEl);

  dipCompose = el('div', 'dip-compose');
  dipCompose.hidden = true;
  dipTo = document.createElement('select');
  dipText = document.createElement('input');
  dipText.type = 'text';
  dipText.maxLength = 500;
  dipText.placeholder = 'Message… (500 chars max)';
  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-brass';
  sendBtn.textContent = 'Send';
  sendBtn.addEventListener('click', () => sendHumanDipMessage());
  dipText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendHumanDipMessage();
  });
  const doneBtn = document.createElement('button');
  doneBtn.className = 'btn btn-steel';
  doneBtn.textContent = 'Done talking';
  doneBtn.addEventListener('click', () => resolveHumanDiplomacy());
  dipCompose.append(dipTo, dipText, sendBtn, doneBtn);
  panel.appendChild(dipCompose);

  host.appendChild(panel);
}

function renderDiplomacy(): void {
  if (!dipState || !dipFeedEl || !dipBudgetsEl) return;
  // Budget meters: spectators see all four; players see their own (here: all).
  dipBudgetsEl.innerHTML = '';
  const round = dipState.round;
  dipSeats.forEach((seat, pid) => {
    const name = dipNames[pid] ?? `Player ${pid + 1}`;
    const row = el('div', 'dip-budget');
    if (seat.kind === 'human') {
      row.textContent = `${name}: no budget (human)`;
    } else {
      const spent = dipLedger?.spendFor(pid, round) ?? 0;
      const remaining = Math.max(0, DIPLOMACY_BUDGET_PER_ROUND - spent);
      const bar = el('span', 'dip-bar');
      const fill = el('span', 'dip-bar-fill');
      fill.style.width = `${(remaining / DIPLOMACY_BUDGET_PER_ROUND) * 100}%`;
      bar.appendChild(fill);
      row.append(el('span', '', `${name}: ${remaining} / ${DIPLOMACY_BUDGET_PER_ROUND} tokens`), bar);
    }
    dipBudgetsEl!.appendChild(row);
  });

  dipFeedEl.innerHTML = '';
  const msgs = dipState.chatLog.slice(-80).filter((m) => {
    const priv = isPrivateMessage(m.recipients);
    return dipFilter === 'all' || (dipFilter === 'public' && !priv) || (dipFilter === 'private' && priv);
  });
  for (const m of msgs) {
    const d = el('div', 'dip-msg');
    const priv = isPrivateMessage(m.recipients);
    const tag = priv ? el('span', 'chip chip-priv', 'private') : null;
    const color = dipState.players.find((p) => p.name === m.sender)?.color ?? '#999';
    d.innerHTML = `<span class="pdot" style="background:${color}"></span><b></b> <span class="dip-to"></span>: <span class="dip-text"></span> <span class="dip-round"></span>`;
    (d.querySelector('b') as HTMLElement).textContent = m.sender;
    (d.querySelector('.dip-to') as HTMLElement).textContent = `→ ${m.recipients}`;
    (d.querySelector('.dip-text') as HTMLElement).textContent = m.text;
    (d.querySelector('.dip-round') as HTMLElement).textContent = `· r${m.round}`;
    if (tag) d.prepend(tag);
    dipFeedEl.appendChild(d);
  }
  dipFeedEl.scrollTop = dipFeedEl.scrollHeight;
}

/** Human compose box: shown only during that human's diplomacy turn. */
function setHumanDipCompose(pid: number | null): void {
  dipComposePid = pid;
  const compose = dipCompose;
  const toSel = dipTo;
  const textInput = dipText;
  const s = dipState;
  if (!compose || !toSel || !textInput || !s) return;
  compose.hidden = pid === null;
  if (pid === null) return;
  toSel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'All (public)';
  toSel.appendChild(all);
  s.players.forEach((p) => {
    if (p.id === pid || !p.alive) return;
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = `${p.name} (private)`;
    toSel.appendChild(o);
  });
  textInput.value = '';
  textInput.focus();
}

function sendHumanDipMessage(): void {
  if (dipComposePid === null || !dipState || !dipTo || !dipText) return;
  const text = dipText.value.trim();
  if (!text) return;
  const r = sendMessage(dipState, dipComposePid, dipTo.value, text);
  if (!r.ok) {
    feed(`<span class="bad">Message rejected [${escapeHtml(r.code ?? 'error')}]</span>`);
    return;
  }
  const m = dipState.chatLog[dipState.chatLog.length - 1];
  dipLedger?.recordMessage({
    round: dipState.round,
    senderId: dipComposePid,
    sender: m.sender,
    recipients: m.recipients,
    text: m.text,
    tokens: 0, // humans spend no budget
  });
  dipText.value = '';
  renderDiplomacy();
}

function resolveHumanDiplomacy(): void {
  setHumanDipCompose(null);
  const r = dipDoneResolve;
  dipDoneResolve = null;
  r?.();
}

/** Driver hook: a human seat's turn in the diplomacy window. */
function onHumanDiplomacyTurn(state: GameState, pid: number): Promise<void> {
  setHumanDipCompose(pid);
  if (dipStatus) dipStatus.textContent = `${dipNames[pid] ?? `Player ${pid + 1}`} is talking…`;
  bridge.ui?.refresh();
  return new Promise<void>((resolve, reject) => {
    dipDoneResolve = resolve;
    bridge.pendingDiplomacy = {
      playerId: pid,
      resolve: () => {
        setHumanDipCompose(null);
        dipDoneResolve = null;
        resolve();
      },
      reject: (err: Error) => {
        setHumanDipCompose(null);
        dipDoneResolve = null;
        reject(err);
      },
    };
  });
}

function downloadDiplomacyDump(): void {
  if (!dipLedger || !dipState) {
    feed('<span class="bad">No diplomacy record yet.</span>');
    return;
  }
  const dump = buildDiplomacyDump({
    ledger: dipLedger,
    state: dipState,
    seats: dipSeats,
    playerNames: dipNames,
  });
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `diplomacy-${dump.gameId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  feed('<b>Diplomacy JSON</b> downloaded.');
}

// ---------------------------------------------------------- error card ---

function ensureErrorOverlay(): HTMLElement {
  let ov = document.getElementById('seaterr');
  if (ov) return ov;
  ov = el('div', '', '');
  ov.id = 'seaterr';
  ov.hidden = true;
  ov.innerHTML = `
    <div class="seaterr-card field-order">
      <h3 class="stencil-head">⚠ Commander down — <span id="se-name"></span></h3>
      <p id="se-headline" class="se-headline"></p>
      <p id="se-guidance" class="se-guidance"></p>
      <div id="se-keyrow" class="se-keyrow" hidden>
        <input id="se-key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste new API key" />
        <button id="se-keysaveretry" class="btn btn-brass">Save &amp; retry</button>
      </div>
      <div class="se-actions">
        <button id="se-retry" class="btn btn-brass">Retry</button>
        <button id="se-editkey" class="btn btn-steel">Edit key</button>
        <button id="se-skip" class="btn btn-steel">Skip phase</button>
        <button id="se-passrest" class="btn btn-steel">Pass rest of game</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  return ov;
}

/** Show the seat error card; resolves with the host's decision. */
function askFailureChoice(
  seatName: string,
  providerLabel: string,
  err: unknown,
  saveKey: (key: string) => void,
): Promise<FailureChoice> {
  const ov = ensureErrorOverlay();
  const classified = classifyProviderError(err, providerLabel);
  (document.getElementById('se-name') as HTMLElement).textContent = seatName;
  (document.getElementById('se-headline') as HTMLElement).textContent = classified.headline;
  (document.getElementById('se-guidance') as HTMLElement).textContent = classified.guidance;
  const keyrow = document.getElementById('se-keyrow') as HTMLElement;
  keyrow.hidden = true;
  (document.getElementById('se-key') as HTMLInputElement).value = '';
  ov.hidden = false;

  return new Promise<FailureChoice>((resolve) => {
    const done = (c: FailureChoice) => {
      ov.hidden = true;
      resolve(c);
    };
    (document.getElementById('se-retry') as HTMLButtonElement).onclick = () => done('retry');
    (document.getElementById('se-skip') as HTMLButtonElement).onclick = () => done('skip');
    (document.getElementById('se-passrest') as HTMLButtonElement).onclick = () => done('pass-rest');
    (document.getElementById('se-editkey') as HTMLButtonElement).onclick = () => {
      keyrow.hidden = false;
      (document.getElementById('se-key') as HTMLInputElement).focus();
    };
    (document.getElementById('se-keysaveretry') as HTMLButtonElement).onclick = () => {
      const v = (document.getElementById('se-key') as HTMLInputElement).value;
      if (v.trim() !== '') saveKey(v);
      done('retry');
    };
  });
}

// ------------------------------------------------------------------ run ---

/** Abort the current driver run (idempotent). The run's finally block tears down. */
export function stopAiGame(): void {
  if (!bridge.driverActive) return;
  bridge.stopDriver?.();
}

export function startAiGame(config: AiGameConfig): void {
  const ui = bridge.ui;
  if (!ui) throw new Error('Driver UI hooks not registered (main.ts boot incomplete).');
  const state = createGame({
    numPlayers: config.seats.length,
    seed: config.seed,
    playerNames: config.playerNames,
  });
  ui.setGameState(state);
  ui.enterGame(() => {
    ui.showGame();
    void runAiGame(state, config);
  });
}

async function runAiGame(state: GameState, config: AiGameConfig): Promise<void> {
  const ui = bridge.ui!;
  const ctrl = makeRunControl();
  bridge.driverActive = true;
  document.body.classList.add('ai-driving');
  bridge.stopDriver = () => {
    ctrl.stop();
    const p = bridge.pendingHuman;
    bridge.pendingHuman = null;
    p?.reject(new StoppedError());
    const d = bridge.pendingDiplomacy;
    bridge.pendingDiplomacy = null;
    d?.reject(new StoppedError());
  };

  buildSpectatorPanel(config.seats, config.playerNames, ctrl);

  // Diplomacy state for the panel (ledger also passed to the driver so the
  // UI's budget meters read live spend).
  dipLedger = new DiplomacyLedger();
  dipState = state;
  dipSeats = config.seats;
  dipNames = config.playerNames;
  buildDiplomacyPanel();
  renderDiplomacy();

  const seatUi: SeatUiEvents = {
    onThought: (pid, phase, text, toolCalls, usage) => {
      const card = seatCards.get(pid);
      if (!card) return;
      card.status.textContent = `Decided — ${phase}`;
      card.usage.textContent = fmtUsage(usage);
      card.rationale.textContent = text.length > 900 ? text.slice(0, 900) + '…' : text || '(no rationale)';
      card.tools.innerHTML = '';
      for (const tc of toolCalls.slice(0, 12)) {
        const chip = el('span', 'chip', tc.name);
        chip.title = JSON.stringify(tc.arguments).slice(0, 300);
        card.tools.appendChild(chip);
      }
      // Player color dots resolve once the state exists.
      const dot = card.root.querySelector<HTMLElement>('.pdot');
      if (dot && state.players[pid]) dot.style.background = state.players[pid].color;
    },
    onFailure: (pid, err) => {
      const seat = config.seats[pid];
      const name = config.playerNames[pid] ?? `Player ${pid + 1}`;
      setSeatStatus(pid, '⚠ error — awaiting host');
      feed(`<span class="pdot" style="background:${state.players[pid]?.color ?? '#999'}"></span><b>${escapeHtml(name)}</b> provider error — card open`);
      return askFailureChoice(name, getProvider(seat.provider!).label, err, (key) => {
        keyStore.saveKey(seat.provider!, key, true);
        setSeatStatus(pid, 'Key updated — retrying…');
      }).then((choice) => {
        if (choice === 'retry') setSeatStatus(pid, 'Retrying…');
        return choice;
      });
    },
  };

  const runtimes: SeatRuntime[] = config.seats.map((seat) => {
    if (seat.kind !== 'ai') return { seat };
    const providerId = seat.provider!;
    const adapter = getProvider(providerId);
    const agent = new UiAgent(
      {
        playerId: seat.playerId,
        provider: adapter,
        model: seat.model!,
        getApiKey: () => {
          const k = keyStore.getKey(providerId);
          if (!k) throw new MissingKeyError(providerId);
          return k;
        },
      },
      seat.playerId,
      providerId,
      adapter.label,
      ctrl,
      seatUi,
    );
    return { seat, agent };
  });

  const events: DriverEvents = {
    onPhase: (s, pid, phase) => {
      const name = config.playerNames[pid] ?? `Player ${pid + 1}`;
      for (const [id] of seatCards) {
        if (id !== pid) setSeatStatus(id, config.seats[id].kind === 'ai' ? 'Waiting…' : 'Human seat');
      }
      if (config.seats[pid].kind === 'ai') {
        setSeatStatus(pid, `Thinking… (${phase})`);
        document.body.classList.add('ai-thinking');
      } else {
        document.body.classList.remove('ai-thinking');
      }
      if (aiHeaderStatus) {
        aiHeaderStatus.textContent =
          s.phase === 'gameover' ? 'Game over.' : `Round ${s.round} — ${name} — ${phase}`;
      }
      ui.refresh();
    },
    onToolCall: (pid, name, ok, code) => {
      const seatName = config.playerNames[pid] ?? `Player ${pid + 1}`;
      const color = state.players[pid]?.color ?? '#999';
      feed(
        `<span class="pdot" style="background:${color}"></span><b>${escapeHtml(seatName)}</b> ` +
          `${escapeHtml(name)} ${ok ? '<span class="ok">✓</span>' : `<span class="bad">✗ [${escapeHtml(code ?? 'error')}]</span>`}`,
      );
    },
    onHumanTurn: (_s, pid, phase) => {
      document.body.classList.remove('ai-thinking');
      setSeatStatus(pid, `🎖 Your move — ${phase}`);
      if (aiHeaderStatus) {
        aiHeaderStatus.textContent = `Round ${state.round} — ${(config.playerNames[pid] ?? `Player ${pid + 1}`)} to move (you)`;
      }
      ui.showError('');
      ui.refresh();
      return new Promise<void>((resolve, reject) => {
        bridge.pendingHuman = { playerId: pid, resolve, reject };
      });
    },
    onHumanDiplomacy: (s, pid) => onHumanDiplomacyTurn(s, pid),
    onDiplomacyMessage: () => {
      renderDiplomacy();
    },
    onDiplomacyWindow: (s, round, open) => {
      if (dipStatus) {
        dipStatus.textContent = open
          ? `Window open — round ${round}. Talk freely; budgets apply.`
          : `Window closed — round ${round}.`;
      }
      renderDiplomacy();
    },
    onDiplomacyToolCall: (pid, name, ok, code) => {
      const seatName = config.playerNames[pid] ?? `Player ${pid + 1}`;
      const color = state.players[pid]?.color ?? '#999';
      feed(
        `<span class="pdot" style="background:${color}"></span><b>${escapeHtml(seatName)}</b> ` +
          `diplomacy ${escapeHtml(name)} ${ok ? '<span class="ok">✓</span>' : `<span class="bad">✗ [${escapeHtml(code ?? 'error')}]</span>`}`,
      );
      renderDiplomacy();
    },
  };

  try {
    const result = await runGame(state, runtimes, events, { diplomacy: { ledger: dipLedger } });
    finishGame(result.state, result.rounds, runtimes, null, result.diplomacy);
  } catch (e) {
    if (e instanceof StoppedError) {
      if (aiHeaderStatus) aiHeaderStatus.textContent = 'Stopped by host.';
    } else if (e instanceof MaxRoundsExceeded) {
      // Even on round cap, the diplomacy record is worth dumping.
      console.log('DIPLOMACY_DUMP', JSON.stringify(buildDiplomacyDump({
        ledger: dipLedger,
        state,
        seats: config.seats,
        playerNames: config.playerNames,
      })));
      finishGame(state, state.round, runtimes, 'Round cap reached — highest income wins.', dipLedger);
    } else {
      fatalCard(e);
    }
  } finally {
    bridge.driverActive = false;
    bridge.stopDriver = null;
    bridge.pendingHuman = null;
    bridge.pendingDiplomacy = null;
    document.body.classList.remove('ai-driving', 'ai-thinking');
    setHumanDipCompose(null);
    dipDoneResolve = null;
    ui.refresh();
  }
}

function finishGame(
  state: GameState,
  rounds: number,
  runtimes: SeatRuntime[],
  note: string | null,
  ledger: DiplomacyLedger | null,
): void {
  document.body.classList.remove('ai-thinking');
  const winner = state.winner !== null ? state.players[state.winner].name : '—';
  if (aiHeaderStatus) {
    aiHeaderStatus.textContent = `Game over — ${winner} wins (${rounds} rounds).${note ? ' ' + note : ''}`;
  }
  // Final usage accounting on every seat card.
  runtimes.forEach((rt) => {
    if (rt.agent) {
      const card = seatCards.get(rt.seat.playerId);
      if (card) card.usage.textContent = fmtUsage(rt.agent.usage);
      setSeatStatus(rt.seat.playerId, 'Done');
    }
  });
  feed(`<b>Game over</b> — ${escapeHtml(winner)} wins after ${rounds} rounds.`);
  // The diplomacy record is the raw material for later analysis: log it for
  // headless runs and leave the download button in the diplomacy panel.
  if (ledger) {
    const dump = buildDiplomacyDump({
      ledger,
      state,
      seats: dipSeats,
      playerNames: dipNames,
    });
    console.log('DIPLOMACY_DUMP', JSON.stringify(dump));
    feed(
      `<b>Diplomacy record</b> — ${dump.diplomacy.messages.length} messages, ` +
        `use “Download diplomacy JSON” above to save it.`,
    );
  }
  renderDiplomacy();
}

function fatalCard(e: unknown): void {
  document.body.classList.remove('ai-thinking');
  const msg = e instanceof Error ? e.message : String(e);
  if (aiHeaderStatus) aiHeaderStatus.textContent = 'Driver failed.';
  const host = document.getElementById('ai');
  if (!host) return;
  const card = el('div', 'ai-fatal field-order');
  card.innerHTML = `<h3 class="stencil-head">⚠ Driver failure</h3><p></p>`;
  (card.querySelector('p') as HTMLElement).textContent =
    `The game loop hit an unexpected error and stopped: ${msg}. ` +
    `Your map state is preserved — use Save in the footer to keep it.`;
  host.prepend(card);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
