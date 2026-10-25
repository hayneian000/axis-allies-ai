// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import indexHtml from '../ui/index.html?raw';

// Full-turn UI replay on the 1942 board-space map (seed 7, Japan first),
// mirroring the real-browser click-through. Regression coverage for two
// playability fixes:
//  - aircraft left aloft over a finished LAND battle can be landed from
//    that territory's move dialog (previously no stepper existed, so the
//    phase panel's "land this air" instruction could not be followed);
//  - move dialogs offer in-range air destinations, not just adjacent
//    territories (previously a bomber on Japan could reach nothing).

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  expect(e, `#${id} exists`).not.toBeNull();
  return e as T;
}

function setNum(id: string, v: number): void {
  const inp = el<HTMLInputElement>(id);
  inp.value = String(v);
  // The shop cart recomputes on input events (stepper +/- do the same).
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickButton(text: string, root: ParentNode = document): void {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const btns = [...root.querySelectorAll('button')].filter((b) => norm(b.textContent ?? '') === norm(text));
  expect(btns, `button "${text}"`).toHaveLength(1);
  btns[0].click();
}

function clickButtonContaining(substr: string, root: ParentNode = document): void {
  const btns = [...root.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes(substr));
  expect(btns, `button containing "${substr}"`).toHaveLength(1);
  btns[0].click();
}

function banner(): string {
  return el('banner').textContent ?? '';
}

function clickTerr(tid: string): void {
  const poly = document.querySelector(`#map g.tgroup[data-terr="${tid}"] polygon.terr`);
  expect(poly, `tile for ${tid}`).not.toBeNull();
  poly!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function modalBody(): HTMLElement {
  return el('modal-body');
}

function resolveBattles(): void {
  for (let i = 0; i < 200; i++) {
    if (el('modal').hidden) return;
    const body = modalBody();
    if ((body.textContent ?? '').includes('All battles resolved')) return;
    const subBtn = body.querySelector<HTMLButtonElement>('.submerge-prompt button');
    if (subBtn) {
      const inp = body.querySelector<HTMLInputElement>('.submerge-prompt input')!;
      inp.value = '0';
      subBtn.click();
      continue;
    }
    const auto = [...body.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Auto' && !b.disabled,
    );
    if (auto) {
      auto.click();
      continue;
    }
    const roll = [...body.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Roll one round',
    );
    if (roll && !roll.disabled) {
      roll.click();
      continue;
    }
    throw new Error(`battle dialog stalled at iteration ${i}: ${body.textContent?.slice(0, 200)}`);
  }
  throw new Error('battle resolution exceeded 200 iterations');
}

beforeAll(async () => {
  const body = (indexHtml as string).match(/<body>([\s\S]*)<\/body>/)![1].replace(
    /<script[\s\S]*?<\/script>/,
    '',
  );
  document.body.innerHTML = body;
  (window as unknown as Record<string, unknown>).__SKIP_INTRO__ = true;
  await import('../ui/main');
  document.querySelector<HTMLButtonElement>('.map-folio[data-map="world1942"]')!.click();
  el<HTMLInputElement>('seed').value = '7';
  el<HTMLButtonElement>('startBtn').click();
});

describe('1942 UI full turn (seed 7, Japan)', () => {
  it('purchases, attacks on land and sea, and resolves both battles', () => {
    expect(el('game').hidden).toBe(false);
    expect(banner()).toContain('Player 3');
    expect(banner()).toContain('phase: purchase');
    expect(banner()).toContain('bank 30 IPCs');

    // Purchase: submarine + destroyer + 4 infantry + 1 artillery = 30 IPC.
    clickButton('Buy units…');
    setNum('buy-submarine', 1);
    setNum('buy-destroyer', 1);
    setNum('buy-infantry', 4);
    setNum('buy-artillery', 1);
    clickButton('Buy', modalBody());
    expect(el('error').textContent).toBe('');
    expect(banner()).toContain('bank 0 IPCs');
    el('modal-close').click();

    el('endPhaseBtn').click();
    expect(banner()).toContain('phase: combatMove');

    // Land attack: Manchuria (3 inf + 1 ftr) -> Anhwei.
    clickTerr('manchuria');
    setNum('mv-infantry', 3);
    setNum('mv-fighter', 1);
    modalBody().querySelector<HTMLButtonElement>('button[data-dest="anhwei"]')!.click();
    // Naval attack: sz44 submarine -> sz53 (US carrier group).
    clickTerr('sz44');
    setNum('mv-submarine', 1);
    clickButtonContaining('Sea Zone 53', modalBody());
    clickButton('Launch moves', el('phasepanel'));
    expect(el('error').textContent).toBe('');

    el('endPhaseBtn').click();
    expect(banner()).toContain('phase: combat');
    expect(el('modal').hidden).toBe(false); // battle dialog auto-opens
    resolveBattles();
    expect(el('error').textContent).toBe('');
    // Anhwei captured from Player 4 (log line), sz53 held.
    expect(el('log').textContent).toContain('Player 3 captures anhwei');
    el('modal-close').click();
  });

  it('lands the aloft fighter and makes a range-2 bomber move in noncombat', () => {
    el('endPhaseBtn').click();
    expect(banner()).toContain('phase: nonCombat');
    expect(el('phasepanel').textContent).toContain('air over anhwei');

    // The aloft fighter must be dialable in Anhwei's own move dialog.
    clickTerr('anhwei');
    expect(document.getElementById('nc-fighter'), 'aloft fighter stepper').not.toBeNull();
    setNum('nc-fighter', 1);
    modalBody().querySelector<HTMLButtonElement>('button[data-dest="manchuria"]')!.click();

    // Japan -> Manchuria is 2 steps: only offered with in-range air dests.
    clickTerr('japan');
    const bomberDest = modalBody().querySelector<HTMLButtonElement>('button[data-dest="manchuria"]');
    expect(bomberDest, 'range-2 destination for the Japan bomber').not.toBeNull();
    setNum('nc-bomber', 1);
    bomberDest!.click();

    clickButton('Fly / march', el('phasepanel'));
    expect(el('error').textContent).toBe('');
    expect(el('log').textContent).toContain('1ftr anhwei->manchuria');
    expect(el('log').textContent).toContain('1bmb japan->manchuria');
  });

  it('deploys purchases (land + fleet) and hands over to the next seat', () => {
    el('endPhaseBtn').click();
    expect(banner()).toContain('phase: mobilize');

    clickTerr('japan');
    setNum('mob-submarine', 1);
    setNum('mob-destroyer', 1);
    clickButtonContaining('Sea Zone 62', el('selinfo'));
    setNum('mob-infantry', 4);
    setNum('mob-artillery', 1);
    clickButton('Stage deployment', el('selinfo'));
    clickButton('Deploy', el('phasepanel'));
    expect(el('error').textContent).toBe('');
    const japanTitle = document.querySelector('#map g.tgroup[data-terr="japan"] title')!.textContent ?? '';
    expect(japanTitle).toContain('8inf');
    const sz62Title = document.querySelector('#map g.tgroup[data-terr="sz62"] title')!.textContent ?? '';
    expect(sz62Title).toContain('1sub');
    expect(sz62Title).toContain('1dd');

    el('endPhaseBtn').click();
    expect(banner()).toContain('Player 2');
    expect(banner()).toContain('phase: purchase');
    expect(banner()).toContain('bank 24 IPCs');
    expect(el('log').textContent).toContain('Player 3 collects 31 IPCs');
  });
});
