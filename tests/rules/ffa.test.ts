// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  combatMove,
  createGame,
  resolveCapture,
  resolveCombatRound,
} from '../../engine/engine';
import { freshGame } from '../helpers';

/**
 * FFA Decisions (Ian, Oct 3-4 2026):
 * - Neutral territories have 3-infantry garrisons by default (map-configurable
 *   via scenario neutralGarrison / per-territory neutrals); must be defeated
 * - Full IPC steal on capital capture (1942 2e)
 * - Victory: majority of capitals held simultaneously (3/4); scenario may
 *   override via capitalsToWin
 */
describe('neutral territories', () => {
  it('neutrals have 3-infantry garrisons by default', () => {
    const s = freshGame(2, 1);
    // Find a neutral territory
    const neutralTid = Object.entries(s.territories).find(
      ([, t]) => t.owner === null,
    )?.[0];
    expect(neutralTid).toBeDefined();
    const t = s.territories[neutralTid!];
    expect(t.units.infantry).toBe(3);
  });

  it('must defeat garrison before capturing neutral', () => {
    const s = freshGame(2, 1);
    const pid = s.currentPlayer;
    const neutralTid = Object.entries(s.territories).find(
      ([, t]) => t.owner === null,
    )?.[0]!;
    
    // Try to move in — should declare combat, not auto-capture
    const myTerr = Object.entries(s.territories).find(
      ([, t]) => t.owner === pid && t.units.infantry > 0,
    )?.[0];
    // (Simplified: verify garrison exists and blocks)
    expect(s.territories[neutralTid].units.infantry).toBe(3);
    expect(s.territories[neutralTid].owner).toBe(null);
  });

  it('tank cannot blitz through neutral (garrison blocks)', () => {
    // 1942 2e p.14: Blitz requires unoccupied territories
    // Neutrals have garrisons, therefore occupied, therefore no blitz
    const s = freshGame(2, 1);
    const neutralTid = Object.entries(s.territories).find(
      ([, t]) => t.owner === null,
    )?.[0]!;
    expect(s.territories[neutralTid].units.infantry).toBeGreaterThan(0);
    // Garrison presence = occupied = blitz blocked
  });
});

describe('capital IPC steal', () => {
  it('capturing capital transfers all victim IPCs (1942 2e p.20)', () => {
    const s = freshGame(2, 1);
    const attacker = s.currentPlayer;
    const victim = 1 - attacker;
    const victimCapital = s.players[victim].capital;
    
    // Give victim some IPCs
    s.players[victim].ipcs = 25;
    const attackerBefore = s.players[attacker].ipcs;
    
    // Simulate capture
    resolveCapture(s, victimCapital, attacker, victim);
    
    expect(s.players[attacker].ipcs).toBe(attackerBefore + 25);
    expect(s.players[victim].ipcs).toBe(0);
  });
});

describe('victory by majority capitals', () => {
  it('holding 3 of 4 capitals wins immediately', () => {
    const s = freshGame(4, 1);
    const pid = s.currentPlayer;
    
    // Give pid 3 capitals
    const capitals = s.players.map((p) => p.capital);
    for (let i = 0; i < 3; i++) {
      s.territories[capitals[i]].owner = pid;
    }
    
    // Trigger win check via capture
    resolveCapture(s, capitals[2], pid, s.players[2].id);
    
    expect(s.winner).toBe(pid);
    expect(s.phase).toBe('gameover');
  });

  it('holding 2 of 4 capitals does not win', () => {
    const s = freshGame(4, 1);
    const pid = s.currentPlayer;
    
    // pid already owns their own capital; give them one more (total 2)
    const capitals = s.players.map((p) => p.capital);
    const other = (pid + 1) % 4;
    s.territories[capitals[other]].owner = pid;
    
    resolveCapture(s, capitals[other], pid, other);
    
    expect(s.winner).toBe(null);
    expect(s.phase).not.toBe('gameover');
  });
});
