/**
 * Fog-of-war opening cinematic — vintage war-table edition.
 *
 * Generic and scenario-agnostic: works with any map by using the territory
 * graph (BFS distances from the starting player's capital) and the map's
 * own label coordinates. No hardcoded positions.
 *
 * Visual language matches the game's art: aged parchment, spreading ink,
 * wax seals, typewriter serif. No sci-fi elements.
 *
 * Sequence:
 *   1. Parchment (0.8s) — aged paper fades in with grain, "SURVEYING THE THEATER OF WAR"
 *   2. Wax seal (1.6s) — starting player's capital stamped with a wax seal
 *   3. Ink spread (2.8s) — ink bleeds outward; territories reveal in
 *      BFS-distance order from the capital with organic roughened edges
 *   4. Handoff (0.6s) — overlay fades, game UI takes over
 *
 * Responsive: all sizing uses viewport-relative units (vw/vh/vmin) and the
 * SVG scales to fit. Looks right on any desktop monitor size.
 *
 * Skippable: click, Space, or Escape jumps to the end.
 * Tests: set (window as any).__SKIP_INTRO__ = true to bypass the cinematic.
 */

import { MAP, neighborsOf } from '../data/data';
import type { GameState } from '../engine/types';

const PARCHMENT_MS = 800;
const SEAL_MS = 1600;
const INK_MS = 2800;
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
    <svg id="intro-map" viewBox="0 0 ${MAP.viewBox.width} ${MAP.viewBox.height}" aria-hidden="true">
      <defs>
        <filter id="intro-ink-roughen" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.015" numOctaves="3" result="noise"/>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="8"/>
        </filter>
        <radialGradient id="intro-seal-grad" cx="35%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#b03030"/>
          <stop offset="60%" stop-color="#8b1a1a"/>
          <stop offset="100%" stop-color="#5e0f0f"/>
        </radialGradient>
        <radialGradient id="intro-wash-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#4a3728" stop-opacity="0.35"/>
          <stop offset="70%" stop-color="#4a3728" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="#4a3728" stop-opacity="0"/>
        </radialGradient>
        <filter id="intro-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.25  0 0 0 0 0.2  0 0 0 0 0.12  0 0 0 0.5 0"/>
          <feComposite operator="over" in2="SourceGraphic"/>
        </filter>
      </defs>
    </svg>
    <div id="intro-grain"></div>
    <div id="intro-vignette"></div>
    <div id="intro-text"></div>
    <div id="intro-skip">click or press space to skip</div>
  `;
  document.body.appendChild(overlay);

  const svg = overlay.querySelector<SVGSVGElement>('#intro-map')!;
  const textEl = overlay.querySelector<HTMLElement>('#intro-text')!;

  // Draw all territories as blank parchment, initially invisible via CSS.
  // On reveal they fade in with roughened ink edges.
  // NOTE: do NOT set inline opacity here — the .intro-revealed CSS class
  // must be able to override it, and inline styles beat classes.
  const terrEls = new Map<string, SVGGElement>();
  for (const t of MAP.territories) {
    const g = svgEl('g', {
      class: 'intro-terr',
      'data-terr': t.id,
      filter: 'url(#intro-ink-roughen)',
    }) as SVGGElement;
    const pts = t.points.map((p) => p.join(',')).join(' ');
    g.appendChild(svgEl('polygon', {
      points: pts,
      fill: '#d8c49a',
      stroke: '#3a2e1f',
      'stroke-width': '1.5',
    }));
    for (const extra of t.extraPolygons ?? []) {
      const epts = extra.map((p) => p.join(',')).join(' ');
      g.appendChild(svgEl('polygon', {
        points: epts,
        fill: '#d8c49a',
        stroke: '#3a2e1f',
        'stroke-width': '1.5',
      }));
    }
    svg.appendChild(g);
    terrEls.set(t.id, g);
  }

  // Ink wash: soft sepia bloom expanding from the capital, like ink in water
  const wash = svgEl('circle', {
    cx: String(cx), cy: String(cy), r: '20',
    fill: 'url(#intro-wash-grad)',
    class: 'intro-wash',
  }) as unknown as HTMLElement;
  wash.style.opacity = '0';
  svg.appendChild(wash as unknown as SVGElement);

  // Wax seal on the capital.
  // NOTE: the translate lives on the outer <g>; the stamp animation (CSS
  // transform) lives on the inner <g>. A CSS transform would override the
  // SVG transform attribute if they were on the same element, causing the
  // seal to jump to the SVG origin mid-animation.
  const sealSize = 26;
  const sealPos = svgEl('g', {
    transform: `translate(${cx},${cy})`,
  });
  const seal = svgEl('g', { class: 'intro-seal' });
  seal.appendChild(svgEl('circle', {
    r: String(sealSize),
    fill: 'url(#intro-seal-grad)',
  }));
  seal.appendChild(svgEl('circle', {
    r: String(sealSize - 5),
    fill: 'none',
    stroke: '#5e0f0f',
    'stroke-width': '2',
    opacity: '0.7',
  }));
  seal.appendChild(svgEl('circle', {
    r: String(sealSize - 10),
    fill: 'none',
    stroke: '#d08080',
    'stroke-width': '1',
    opacity: '0.5',
  }));
  // Star emboss in the seal (capital marker)
  const star = svgEl('path', {
    d: 'M0,-8 L2.4,-2.6 L8,-2.5 L3.6,1.2 L5,6.5 L0,3.2 L-5,6.5 L-3.6,1.2 L-8,-2.5 L-2.4,-2.6 Z',
    fill: '#e8a0a0',
    opacity: '0.8',
  });
  seal.appendChild(star);
  sealPos.appendChild(seal);
  (sealPos as unknown as HTMLElement).style.opacity = '0';
  svg.appendChild(sealPos);

  let done = false;
  const timers: number[] = [];
  const finish = () => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    cleanupKeys();
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
  window.addEventListener('keydown', skip);
  const cleanupKeys = () => window.removeEventListener('keydown', skip);

  // --- Phase 1: Parchment ---
  textEl.textContent = 'Surveying the Theater of War';
  overlay.classList.add('intro-parchment');

  // --- Phase 2: Wax seal stamps onto the capital ---
  timers.push(window.setTimeout(() => {
    textEl.textContent = '';
    (sealPos as unknown as HTMLElement).style.opacity = '1';
    seal.classList.add('intro-seal-stamp');
  }, PARCHMENT_MS));

  // --- Phase 3: Ink spreads outward in BFS order ---
  timers.push(window.setTimeout(() => {
    wash.style.opacity = '1';
    (wash as unknown as SVGElement).classList.add('intro-wash-expand');

    const perStep = INK_MS / (maxDist + 1);
    for (const [tid, d] of distances) {
      const g = terrEls.get(tid);
      if (!g) continue;
      timers.push(window.setTimeout(() => {
        g.classList.add('intro-revealed');
      }, d * perStep));
    }

    textEl.textContent = 'Theater Surveyed';
    textEl.classList.add('intro-complete-text');
  }, PARCHMENT_MS + SEAL_MS));

  // --- Phase 4: Handoff ---
  timers.push(window.setTimeout(() => {
    textEl.textContent = '';
    finish();
  }, PARCHMENT_MS + SEAL_MS + INK_MS));

  // Safety: ensure cleanup even if something goes wrong
  timers.push(window.setTimeout(() => {
    if (!done) finish();
  }, PARCHMENT_MS + SEAL_MS + INK_MS + 2000));
}
