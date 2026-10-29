/**
 * engine/meta.ts — Chat, state summaries for agents/prompts, and save/load serialization.
 */
import { describeUnits } from './units';
import { MAX_CHAT_LENGTH, fail, incomeOf, log, ownedTerritories, victoryCitiesHeld } from './core';
import { ALL_UNIT_TYPES, MAP, activeMapId, ipcOf, isImpassable, scenarioFor, setActiveMap, victoryCityTargets, type MapId } from '../data/data';
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
    const capStatus = (p.capitals ?? [p.capital])
      .map((cid) => {
        const cap = state.territories[cid];
        return cap.owner === p.id
          ? `holds capital ${cid}`
          : cap.owner === null
            ? `capital ${cid} neutral`
            : `capital ${cid} held by ${state.players[cap.owner].name}`;
      })
      .join(', ');
    const factories = Object.keys(state.territories)
      .filter((t) => state.territories[t].owner === p.id && state.territories[t].factory)
      .map((t) => {
        const dmg = state.territories[t].factoryDamage ?? 0;
        return dmg > 0 ? `${t} (damage ${dmg}, capacity ${Math.max(0, ipcOf(t) - dmg)} of ${ipcOf(t)})` : t;
      });
    lines.push(`${p.name}${p.alive ? '' : ' (OUT)'}: ${terrs} terr, bank ${p.ipcs}, income ${incomeOf(state, p.id)}, ${capStatus}, factories [${factories.join(',') || 'none'}].`);
  }
  const myDamaged = Object.keys(state.territories).filter(
    (t) =>
      state.territories[t].owner === playerId &&
      state.territories[t].factory &&
      (state.territories[t].factoryDamage ?? 0) > 0,
  );
  if (myDamaged.length > 0) {
    const desc = myDamaged
      .map((t) => {
        const dmg = state.territories[t].factoryDamage;
        return `${t}: damage ${dmg}, mobilization capacity ${Math.max(0, ipcOf(t) - dmg)} of ${ipcOf(t)}`;
      })
      .join('; ');
    lines.push(
      `Your damaged factories: ${desc}. Damage does not reduce income. Repair with the repair tool during your purchase phase at 1 IPC per damage marker (you hold ${me.ipcs} IPCs).`,
    );
  }
  if (state.victoryCitiesToWin) {
    const targets = state.victoryCitiesToWin;
    const counts = state.players
      .map((p) => `${p.name} ${victoryCitiesHeld(state, p.id)}/${targets[p.id]}`)
      .join(', ');
    lines.push(
      `Victory cities (held/target): ${counts}. Victory on victory cities is decided only at the end of a complete round: a seat at or above its target when the round ends wins.`,
    );
  }
  const mine = ownedTerritories(state, playerId)
    .map((t) => `${t}(${ipcOf(t)}):${fmtUnits(state.territories[t].units)}${state.territories[t].factory ? '+FAC' : ''}${(state.territories[t].factoryDamage ?? 0) > 0 ? `(dmg${state.territories[t].factoryDamage})` : ''}`)
    .join(' ');
  lines.push(`Yours: ${mine}`);
  const others = Object.keys(state.territories)
    .filter((t) => state.territories[t].owner !== playerId)
    .map((t) => {
      const s = state.territories[t];
      const owner =
        s.owner === null ? (isImpassable(t) ? 'impassable' : 'neutral') : state.players[s.owner].name;
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


/** Which map a save belongs to: the recorded mapId, or — for saves made
 *  before saves carried one — inferred from territory ids unique to a map. */
function mapIdOfSave(data: GameState): MapId | null {
  if (data.mapId === 'america' || data.mapId === 'world1942') return data.mapId;
  const ids = Object.keys(data.territories ?? {});
  if (ids.includes('germany') || ids.includes('sz62')) return 'world1942';
  if (ids.includes('california') || ids.includes('new_york')) return 'america';
  return null;
}

/** Which map a save belongs to, without validating it. Returns null for
 *  unparseable text or saves that name no recognizable map; callers use
 *  this to preload the save's map (data/ensureMapLoaded) before calling
 *  deserialize, which still restores the map synchronously when loaded. */
export function saveMapId(json: string): MapId | null {
  let data: GameState;
  try {
    data = JSON.parse(json) as GameState;
  } catch {
    return null;
  }
  return mapIdOfSave(data);
}

export function deserialize(json: string): GameState {
  const data = JSON.parse(json) as GameState;
  if (!data || data.version !== 3) throw new Error('Unsupported save version.');
  // Restore the save's own map before validating against it: territory ids
  // differ per map, so validating a 1942 save under the America map (the
  // default) fails on the first territory. The map must already be loaded
  // (the UI load path preloads it via saveMapId + ensureMapLoaded); a
  // 1942 save arriving unloaded throws the data layer's not-loaded error
  // instead of validating against the wrong map.
  const want = mapIdOfSave(data);
  if (want && want !== activeMapId()) setActiveMap(want);
  for (const t of MAP.territories) {
    const s = data.territories?.[t.id];
    if (!s || s.owner === undefined || !s.units) {
      throw new Error(`Save file has invalid data for territory "${t.id}".`);
    }
    // Saves from before navy phase 1 lack the cargo manifest.
    if (!Array.isArray(s.cargo)) s.cargo = [];
    // Saves from before factory damage lack the damage-marker count.
    if (typeof s.factoryDamage !== 'number') s.factoryDamage = 0;
    for (const u of ALL_UNIT_TYPES) {
      if (s.units[u] === undefined) s.units[u] = 0;
    }
  }
  if (!Array.isArray(data.players) || !Array.isArray(data.battles)) {
    throw new Error('Save file is missing game data.');
  }
  // Saves from before multi-capital seats lack the per-seat capital list.
  for (const p of data.players) {
    if (!Array.isArray(p.capitals) || p.capitals.length === 0) p.capitals = [p.capital];
  }
  // Saves from before the victory-cities win path lack the per-seat
  // targets; restore them from the save's own scenario (null on maps
  // whose scenarios declare none). The map was restored above, so
  // scenarioFor sees the save's scenario.
  if (data.victoryCitiesToWin === undefined) {
    data.victoryCitiesToWin = victoryCityTargets(scenarioFor(data.numPlayers), data.numPlayers);
  }
  // Saves from before cumulative mobilize-capacity tracking lack the
  // per-phase placement counts; start clean. A legacy save made
  // mid-mobilize-phase therefore treats units already placed this phase
  // as unplaced - the same accepted migration edge as the backfills
  // above (their units are on the board; only the count is forgotten).
  if (typeof data.mobilizedThisPhase !== 'object' || data.mobilizedThisPhase === null) {
    data.mobilizedThisPhase = {};
  }
  // Saves from before AI-aware saves lack the seat table: leave it
  // undefined (all-human). A present-but-malformed table (wrong length,
  // bad kinds, misaligned seat indices) is normalized to undefined, never
  // a load failure - a corrupt seats field must not break loading an
  // otherwise valid game. Valid tables are rebuilt through a pick list,
  // so no field outside SeatConfig (and in particular no key material a
  // hand-edited save might smuggle in) survives into the live state.
  if (data.aiSeats !== undefined) {
    const seats = data.aiSeats as unknown;
    const valid =
      Array.isArray(seats) &&
      seats.length === data.numPlayers &&
      seats.every(
        (s, i) =>
          !!s &&
          typeof s === 'object' &&
          (s.kind === 'human' || s.kind === 'ai') &&
          s.seatIndex === i &&
          s.playerId === i,
      );
    if (!valid) {
      data.aiSeats = undefined;
    } else {
      data.aiSeats = (seats as Array<Record<string, unknown>>).map((s) => ({
        seatIndex: s.seatIndex as number,
        playerId: s.playerId as number,
        kind: s.kind as 'human' | 'ai',
        ...(typeof s.provider === 'string'
          ? { provider: s.provider as import('../agents/types').ProviderId }
          : {}),
        ...(typeof s.model === 'string' ? { model: s.model } : {}),
        ...(typeof s.keySlot === 'string' ? { keySlot: s.keySlot } : {}),
      }));
    }
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
