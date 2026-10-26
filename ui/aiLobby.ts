// Phase 2 lobby (M2): seat cards on the setup screen. Each seat is Human or
// AI; AI seats pick provider + model and supply a BYOK API key (stored via
// agents/keys.ts — never leaves the browser except to the provider's API).

import { buildSeats, validateSeats, type LobbySeatInput } from '../agents/lobby';
import { PROVIDERS, listModels, defaultModel } from '../agents/providers/index';
import { keyStore } from '../agents/keys';
import type { ProviderId } from '../agents/types';
import { seatNamesForMap, type MapId } from '../data/data';
import { startAiGame } from './aiGame';

export type AiMode = 'hotseat' | 'vsai' | 'aivai';

let mode: AiMode = 'hotseat';
export function getAiMode(): AiMode {
  return mode;
}

interface SeatUiState extends LobbySeatInput {
  name: string;
}

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
const DEFAULT_NAMES: Record<ProviderId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  meta: 'Meta AI',
};

let seats: SeatUiState[] = [];

/** Map chosen on the setup screen (tracked here because setActiveMap only
 *  happens at Commence; the lobby needs it earlier for seat defaults). */
let lobbyMap: MapId = 'america';

/** The default display name for a seat. A scenario that names its seats
 *  (1942: the powers) wins over the generic defaults, so an untouched
 *  lobby starts a 1942 game with Germany / USSR / Japan / UK + US at the
 *  table. Anything the user types replaces the default and sticks. */
function defaultName(i: number, kind: 'human' | 'ai', provider?: ProviderId): string {
  const named = seatNamesForMap(lobbyMap)?.[i];
  if (named) return named;
  if (kind === 'ai') return DEFAULT_NAMES[provider ?? 'anthropic'];
  return `Player ${i + 1}`;
}

/** True while a seat still carries any default name (generic, provider, or
 *  scenario power name) - i.e. the user has not renamed it. Only such
 *  seats are renamed by provider or map switches. */
function isDefaultName(name: string, i: number): boolean {
  return (
    name === `Player ${i + 1}` ||
    Object.values(DEFAULT_NAMES).includes(name) ||
    (seatNamesForMap('world1942')?.includes(name) ?? false)
  );
}

function el(tag: string, cls = '', text = ''): HTMLElement {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text) d.textContent = text;
  return d;
}

function activePlayerCount(): number {
  const active = document.querySelector<HTMLButtonElement>('.dogtag.active');
  return parseInt(active?.dataset.players ?? '4', 10);
}

function defaultSeat(i: number, n: number): SeatUiState {
  const aiDefault = mode === 'aivai' || (mode === 'vsai' && i > 0);
  if (!aiDefault) return { kind: 'human', name: defaultName(i, 'human') };
  const provider: ProviderId = 'anthropic';
  return {
    kind: 'ai',
    provider,
    model: defaultModel(provider),
    name: defaultName(i, 'ai', provider),
  };
}

function syncLobbyVisibility(): void {
  const lobby = document.getElementById('lobby');
  if (!lobby) return;
  lobby.hidden = mode === 'hotseat';
  if (mode !== 'hotseat') renderSeatCards();
}

function providerLabel(id: ProviderId): string {
  return PROVIDERS[id].label;
}

function refreshModels(card: HTMLElement, seat: SeatUiState): void {
  const modelSel = card.querySelector<HTMLSelectElement>('.seat-model');
  if (!modelSel || !seat.provider) return;
  modelSel.innerHTML = '';
  for (const m of listModels(seat.provider)) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelSel.appendChild(opt);
  }
  seat.model = defaultModel(seat.provider);
  modelSel.value = seat.model;
  // A provider switch renames the seat only while it still has a default
  // name (on the 1942 map the default is the power name, which the switch
  // therefore leaves alone).
  const i = seats.indexOf(seat);
  if (i >= 0 && isDefaultName(seat.name, i)) {
    seat.name = defaultName(i, 'ai', seat.provider);
    const nameInput = card.querySelector<HTMLInputElement>('.seat-name');
    if (nameInput) nameInput.value = seat.name;
  }
  refreshKeyStatus(card, seat);
}

function refreshKeyStatus(card: HTMLElement, seat: SeatUiState): void {
  const status = card.querySelector<HTMLElement>('.key-status');
  const clearBtn = card.querySelector<HTMLButtonElement>('.key-clear');
  if (!status || !seat.provider) return;
  const has = keyStore.hasKey(seat.provider);
  if (has) {
    status.textContent = '✓ Key saved on this device';
    status.classList.add('ok');
  } else {
    status.textContent = 'No key yet — required to start';
    status.classList.remove('ok');
  }
  if (clearBtn) clearBtn.hidden = !has;
}

function seatCard(i: number, seat: SeatUiState): HTMLElement {
  const card = el('div', 'seat-card');
  const head = el('div', 'seat-head');
  const nameInput = document.createElement('input');
  nameInput.className = 'seat-name';
  nameInput.value = seat.name;
  nameInput.maxLength = 24;
  nameInput.setAttribute('aria-label', `Seat ${i + 1} name`);
  nameInput.addEventListener('input', () => {
    seat.name = nameInput.value.trim() || defaultName(i, seat.kind, seat.provider);
  });
  const kindToggle = el('div', 'kind-toggle');
  const humanBtn = document.createElement('button');
  humanBtn.type = 'button';
  humanBtn.className = 'btn btn-steel' + (seat.kind === 'human' ? ' active-kind' : '');
  humanBtn.textContent = 'Human';
  const aiBtn = document.createElement('button');
  aiBtn.type = 'button';
  aiBtn.className = 'btn btn-steel' + (seat.kind === 'ai' ? ' active-kind' : '');
  aiBtn.textContent = 'AI';
  const setKind = (kind: 'human' | 'ai') => {
    seat.kind = kind;
    humanBtn.classList.toggle('active-kind', kind === 'human');
    aiBtn.classList.toggle('active-kind', kind === 'ai');
    const aiOpts = card.querySelector<HTMLElement>('.ai-opts');
    if (aiOpts) aiOpts.hidden = kind !== 'ai';
    if (kind === 'ai' && !seat.provider) {
      seat.provider = 'anthropic';
      seat.model = defaultModel(seat.provider);
      seat.name = defaultName(i, 'ai', seat.provider);
      nameInput.value = seat.name;
      refreshModels(card, seat);
    }
    validateLobby();
  };
  humanBtn.addEventListener('click', () => setKind('human'));
  aiBtn.addEventListener('click', () => setKind('ai'));
  kindToggle.append(humanBtn, aiBtn);
  head.append(nameInput, kindToggle);
  card.appendChild(head);

  const aiOpts = el('div', 'ai-opts');
  aiOpts.hidden = seat.kind !== 'ai';

  const provLabel = el('label', 'seat-field');
  provLabel.appendChild(el('span', '', 'Provider'));
  const provSel = document.createElement('select');
  provSel.className = 'seat-provider';
  for (const pid of PROVIDER_IDS) {
    const opt = document.createElement('option');
    opt.value = pid;
    opt.textContent = providerLabel(pid);
    provSel.appendChild(opt);
  }
  if (seat.provider) provSel.value = seat.provider;
  provSel.addEventListener('change', () => {
    seat.provider = provSel.value as ProviderId;
    refreshModels(card, seat);
    validateLobby();
  });
  provLabel.appendChild(provSel);

  const modelLabel = el('label', 'seat-field');
  modelLabel.appendChild(el('span', '', 'Model'));
  const modelSel = document.createElement('select');
  modelSel.className = 'seat-model';
  modelSel.addEventListener('change', () => {
    seat.model = modelSel.value;
    validateLobby();
  });
  modelLabel.appendChild(modelSel);

  const keyLabel = el('label', 'seat-field');
  keyLabel.appendChild(el('span', '', 'API key'));
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.className = 'seat-key';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = seat.provider === 'anthropic' ? 'sk-ant-…' : 'Paste key';
  const rememberLabel = el('label', 'remember-row');
  const remember = document.createElement('input');
  remember.type = 'checkbox';
  remember.className = 'seat-remember';
  remember.checked = true;
  rememberLabel.append(remember, el('span', '', 'Remember on this device'));
  const keyStatus = el('div', 'key-status');
  const saveKey = () => {
    if (!seat.provider) return;
    const v = keyInput.value;
    if (v.trim() === '') return;
    keyStore.saveKey(seat.provider, v, remember.checked);
    keyInput.value = '';
    keyInput.placeholder = 'Saved ✓ — paste to replace';
    refreshKeyStatus(card, seat);
    validateLobby();
  };
  keyInput.addEventListener('change', saveKey);
  remember.addEventListener('change', () => {
    // Re-persist or drop the persisted copy when the toggle flips.
    if (!seat.provider) return;
    const k = keyStore.getKey(seat.provider);
    if (k) keyStore.saveKey(seat.provider, k, remember.checked);
  });
  const clearKey = document.createElement('button');
  clearKey.type = 'button';
  clearKey.className = 'btn btn-steel key-clear';
  clearKey.textContent = 'Forget key';
  clearKey.addEventListener('click', () => {
    if (!seat.provider) return;
    keyStore.clearKey(seat.provider);
    keyInput.value = '';
    keyInput.placeholder = 'Paste key';
    refreshKeyStatus(card, seat);
    validateLobby();
  });
  keyLabel.append(keyInput, rememberLabel, keyStatus, clearKey);

  aiOpts.append(provLabel, modelLabel, keyLabel);
  card.appendChild(aiOpts);
  refreshModels(card, seat);
  return card;
}

function renderSeatCards(): void {
  const host = document.getElementById('seatcards');
  if (!host || mode === 'hotseat') return;
  const n = activePlayerCount();
  while (seats.length < n) seats.push(defaultSeat(seats.length, n));
  seats.length = n;
  host.innerHTML = '';
  seats.forEach((seat, i) => host.appendChild(seatCard(i, seat)));
  validateLobby();
}

function lobbyErrorBox(): HTMLElement | null {
  return document.getElementById('lobbyError');
}

function validateLobby(): void {
  const box = lobbyErrorBox();
  const startBtn = document.getElementById('startBtn') as HTMLButtonElement | null;
  if (!box || mode === 'hotseat') {
    if (startBtn) startBtn.disabled = false;
    return;
  }
  const names = seats.map((s) => s.name);
  let cfgs;
  try {
    cfgs = buildSeats(seats, names);
  } catch (e) {
    setLobbyError([e instanceof Error ? e.message : String(e)]);
    if (startBtn) startBtn.disabled = true;
    return;
  }
  const errors = validateSeats(cfgs);
  cfgs.forEach((c, i) => {
    if (c.kind === 'ai' && c.provider && !keyStore.hasKey(c.provider)) {
      errors.push(`Seat ${i + 1} (${names[i]}): no API key saved for ${providerLabel(c.provider)}.`);
    }
  });
  setLobbyError(errors);
  if (startBtn) startBtn.disabled = errors.length > 0;
}

function setLobbyError(errors: string[]): void {
  const box = lobbyErrorBox();
  if (!box) return;
  if (errors.length === 0) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  const ul = document.createElement('ul');
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = e;
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

/** Start-button entry point for AI modes (called from ui/main.ts). */
export function startAiGameFromLobby(): void {
  const names = seats.map((s) => s.name);
  let cfgs;
  try {
    cfgs = buildSeats(seats, names);
  } catch (e) {
    setLobbyError([e instanceof Error ? e.message : String(e)]);
    return;
  }
  const errors = validateSeats(cfgs);
  cfgs.forEach((c, i) => {
    if (c.kind === 'ai' && c.provider && !keyStore.hasKey(c.provider)) {
      errors.push(`Seat ${i + 1} (${names[i]}): no API key saved for ${providerLabel(c.provider)}.`);
    }
  });
  if (errors.length > 0) {
    setLobbyError(errors);
    return;
  }
  const seed = parseInt((document.getElementById('seed') as HTMLInputElement).value, 10) || 1;
  setLobbyError([]);
  startAiGame({ seats: cfgs, playerNames: names, seed });
}

/** Wire the setup screen. Called once from ui/main.ts boot(). */
export function initAiLobby(): void {
  document.querySelectorAll<HTMLButtonElement>('.mode-plaque').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-plaque').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mode = (btn.dataset.mode as AiMode) ?? 'hotseat';
      seats = [];
      syncLobbyVisibility();
      validateLobby();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.dogtag').forEach((t) => {
    t.addEventListener('click', () => renderSeatCards());
  });
  // Map folios: seat defaults follow the chosen map (1942 names its seats
  // for the powers). Seats the user renamed keep their names.
  document.querySelectorAll<HTMLButtonElement>('.map-folio[data-map]').forEach((f) => {
    f.addEventListener('click', () => {
      if (f.disabled) return;
      lobbyMap = (f.dataset.map as MapId | undefined) ?? 'america';
      seats.forEach((seat, i) => {
        if (isDefaultName(seat.name, i)) seat.name = defaultName(i, seat.kind, seat.provider);
      });
      renderSeatCards();
    });
  });
  syncLobbyVisibility();
}
