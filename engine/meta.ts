/**
 * engine/meta.ts — Chat, state summaries for agents/prompts, and save/load serialization.
 */
import { describeUnits } from './units';
import { MAX_CHAT_LENGTH, fail, incomeOf, log, ownedTerritories } from './core';
import { ALL_UNIT_TYPES, MAP, ipcOf } from '../data/data';
import type { ActionResult, ChatMessage, GameState, UnitCounts } from './types';


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
  if (!data || data.version !== 3) throw new Error('Unsupported save version.');
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
