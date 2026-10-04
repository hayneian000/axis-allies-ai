// Shared integration state between ui/main.ts (hot-seat UI) and the Phase 2
// AI modules (ui/aiLobby.ts, ui/aiGame.ts).
//
// main.ts owns: the game screen DOM, the global GameState, render().
// The AI modules own: the driver run, the spectator UI, seat error cards.
// Neither imports the other (no import cycles); both talk through `bridge`.

import type { GameState } from '../engine/types';

export interface PendingHumanTurn {
  playerId: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** UI callbacks owned by ui/main.ts, registered once at boot. */
export interface DriverUiHooks {
  /** Replace the global game state and reset transient UI (selection, drafts). */
  setGameState(s: GameState | null): void;
  /** Re-render the whole game screen. */
  refresh(): void;
  /** Hide setup, play the intro cinematic, then call back. */
  enterGame(onShown: () => void): void;
  /** Reveal the game screen (after the intro). */
  showGame(): void;
  /** Return to the setup screen. */
  showSetup(): void;
  /** Show a message in the action-bar error slot. */
  showError(msg: string): void;
}

export const bridge = {
  /** True while the Phase 2 driver owns the game loop. */
  driverActive: false,
  /** Set while a human seat's turn awaits the End-phase click. */
  pendingHuman: null as PendingHumanTurn | null,
  /** Abort the current driver run (wired by ui/aiGame.ts). */
  stopDriver: null as (() => void) | null,
  /** Registered by ui/main.ts at boot. */
  ui: null as DriverUiHooks | null,
};
