// Phase 2 game runner (M2): drives AI seats through agents/driver.ts in the
// browser, renders the spectator UI, and hands human turns to the existing
// hot-seat UI via the driver bridge (ui/driverBridge.ts).
//
// Negotiation is out of scope: send_message stays unwired for agents.

import { Agent, type ActResult, type AgentOptions } from '../agents/agent';
import {
  runGame,
  MaxRoundsExceeded,
  type DriverEvents,
  type SeatRuntime,
} from '../agents/driver';
import { getProvider } from '../agents/providers/index';
import { keyStore } from '../agents/keys';
import { MissingKeyError, classifyProviderError } from '../agents/errors';
import { emptyUsage } from '../agents/types';
import type { SeatConfig, PlayerUsage, ToolCall } from '../agents/types';
import { createGame } from '../engine/engine';
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
  return `${u.calls} calls · ${fmtTokens(u.inputTokens)} in / ${fmtTokens(u.outputTokens)} out · ${u.errors} errors`;
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
  };

  buildSpectatorPanel(config.seats, config.playerNames, ctrl);

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
  };

  try {
    const result = await runGame(state, runtimes, events);
    finishGame(result.state, result.rounds, runtimes, null);
  } catch (e) {
    if (e instanceof StoppedError) {
      if (aiHeaderStatus) aiHeaderStatus.textContent = 'Stopped by host.';
    } else if (e instanceof MaxRoundsExceeded) {
      finishGame(state, state.round, runtimes, 'Round cap reached — highest income wins.');
    } else {
      fatalCard(e);
    }
  } finally {
    bridge.driverActive = false;
    bridge.stopDriver = null;
    bridge.pendingHuman = null;
    document.body.classList.remove('ai-driving', 'ai-thinking');
    ui.refresh();
  }
}

function finishGame(
  state: GameState,
  rounds: number,
  runtimes: SeatRuntime[],
  note: string | null,
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
