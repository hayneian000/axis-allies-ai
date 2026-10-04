/**
 * Fog-of-war opening cinematic.
 *
 * Generic and scenario-agnostic: works with any map by using the territory
 * graph (BFS distances from the starting player's capital) and the map's
 * own label coordinates. No hardcoded positions.
 *
 * Sequence:
 *   1. Blackout (0.7s) — pure black, faint static/grid, "ESTABLISHING UPLINK" text
 *   2. Heartbeat (1.8s) — starting player's capital pulses 3x, ring expands
 *   3. Shockwave (2.8s) — reveal wave expands outward; territories fade in
 *      in BFS-distance order from the capital
 *   4. Handoff (0.6s) — overlay fades, game UI takes over
 *
 * Skippable: click, Space, or Escape jumps to the end.
 * Tests: set (window as any).__SKIP_INTRO__ = true to bypass the cinematic.
 */

import { MAP, neighborsOf } from '../data/data';
import type { GameState } from '../engine/types';

const BLACKOUT_MS = 700;
const HEARTBEAT_MS = 1800;
const SHOCKWAVE_MS = 2800;
const HANDOFF_MS = 600;

/** BFS distances from a territory, over the map neighbor graph. */
function bfsDistances(from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nb of neighborsOf(cur)) {
      if (!dist.has(nb)) {
        dist.set(nb, dist.get(cur)! + 1);
        queue.push(nb);
      }
    }
  }
  // Unreachable territories (shouldn't happen) get max distance + 1
  const maxD = Math.max(0, ...dist.values());
  for (const t of MAP.territories) {
    if (!dist.has(t.id)) dist.set(t.id, maxD + 1);
  }
  return dist;
}

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * Play the fog-of-war intro. Calls onDone when the cinematic finishes
 * (or is skipped). The game state is already created; this only handles
 * the visual sequence before the main UI takes over.
 */
export function playIntro(state: GameState, onDone: () => void): void {
  // Test hook: bypass the cinematic entirely.
  if ((window as unknown as Record<string, unknown>).__SKIP_INTRO__) {
    onDone();
    return;
  }
  const capital = state.players[state.currentPlayer].capital;
  const capTerr = MAP.territories.find((t) => t.id === capital);
  if (!capTerr) {
    onDone();
    return;
  }
  const [cx, cy] = capTerr.label;
  const distances = bfsDistances(capital);
  const maxDist = Math.max(...distances.values());

  // --- Build overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'intro-overlay';
  overlay.innerHTML = `
    <svg id="intro-map" viewBox="0 0 1000 470" aria-hidden="true"></svg>
    <div id="intro-static"></div>
    <div id="intro-text"></div>
    <div id="intro-skip">click or press space to skip</div>
  `;
  document.body.appendChild(overlay);

  const svg = overlay.querySelector<SVGSVGElement>('#intro-map')!;
  const textEl = overlay.querySelector<HTMLElement>('#intro-text')!;

  // Draw all territories, initially fully fogged (opacity 0)
  const terrEls = new Map<string, SVGElement>();
  for (const t of MAP.territories) {
    const g = svgEl('g', { class: 'intro-terr', 'data-terr': t.id });
    const pts = t.points.map((p) => p.join(',')).join(' ');
    g.appendChild(svgEl('polygon', {
      points: pts,
      fill: '#2a2a3a',
      stroke: '#555566',
      'stroke-width': '1',
    }));
    for (const extra of t.extraPolygons ?? []) {
      const epts = extra.map((p) => p.join(',')).join(' ');
      g.appendChild(svgEl('polygon', {
        points: epts,
        fill: '#2a2a3a',
        stroke: '#555566',
        'stroke-width': '1',
      }));
    }
    // Fog cover: black rect over this territory's bbox, fades out on reveal
    g.style.opacity = '0';
    svg.appendChild(g);
    terrEls.set(t.id, g);
  }

  // Capital marker (pulsing dot)
  const capDot = svgEl('circle', {
    cx: String(cx), cy: String(cy), r: '10',
    fill: '#ff4444', class: 'intro-capdot',
  });
  (capDot as unknown as HTMLElement).style.opacity = '0';
  svg.appendChild(capDot);

  // Shockwave ring
  const ring = svgEl('circle', {
    cx: String(cx), cy: String(cy), r: '10',
    fill: 'none', stroke: '#ffcc44', 'stroke-width': '3',
    class: 'intro-ring',
  });
  (ring as unknown as HTMLElement).style.opacity = '0';
  svg.appendChild(ring);

  let done = false;
  let timers: number[] = [];
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    overlay.classList.add('intro-done');
    setTimeout(() => {
      overlay.remove();
      onDone();
    }, HANDOFF_MS);
  };

  // Skip handlers
  const skip = (e: Event) => {
    if (e instanceof KeyboardEvent && e.code !== 'Space' && e.code !== 'Escape') return;
    e.preventDefault();
    finish();
  };
  overlay.addEventListener('click', skip);
  window.addEventListener('keydown', skip, { once: false });
  const cleanupKeys = () => window.removeEventListener('keydown', skip);

  // --- Phase 1: Blackout ---
  textEl.textContent = 'ESTABLISHING UPLINK';
  overlay.classList.add('intro-blackout');

  // --- Phase 2: Heartbeat ---
  timers.push(window.setTimeout(() => {
    textEl.textContent = '';
    (capDot as unknown as HTMLElement).style.opacity = '1';
    capDot.classList.add('intro-heartbeat');
  }, BLACKOUT_MS));

  // --- Phase 3: Shockwave reveal ---
  timers.push(window.setTimeout(() => {
    capDot.classList.remove('intro-heartbeat');
    (ring as unknown as HTMLElement).style.opacity = '1';
    ring.classList.add('intro-shockwave');

    // Reveal territories in BFS order
    const perStep = SHOCKWAVE_MS / (maxDist + 1);
    for (const [tid, d] of distances) {
      const g = terrEls.get(tid);
      if (!g) continue;
      timers.push(window.setTimeout(() => {
        g.classList.add('intro-revealed');
      }, d * perStep));
    }

    // Capital label flash
    textEl.textContent = 'TERRITORY SCAN COMPLETE';
    textEl.classList.add('intro-scan-text');
  }, BLACKOUT_MS + HEARTBEAT_MS));

  // --- Phase 4: Handoff ---
  timers.push(window.setTimeout(() => {
    textEl.textContent = '';
    cleanupKeys();
    finish();
  }, BLACKOUT_MS + HEARTBEAT_MS + SHOCKWAVE_MS));

  // Safety: ensure cleanup even if something goes wrong
  timers.push(window.setTimeout(() => {
    cleanupKeys();
    if (!done) finish();
  }, BLACKOUT_MS + HEARTBEAT_MS + SHOCKWAVE_MS + 2000));
}
