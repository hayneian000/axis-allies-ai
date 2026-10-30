// @vitest-environment jsdom
// The in-game help panel: both entry points (setup "How to play" and
// the game topbar Help button) open the shared modal overlay with the
// generated content; closing works via the close button, the backdrop,
// and Escape; and opening/closing help mid-turn is a pure UI act - the
// game banner and the autosave record are byte-identical afterwards.
import { beforeAll, describe, expect, it } from 'vitest';
import indexHtml from '../ui/index.html?raw';
import { ensureMapLoaded } from '../data/data';

const body = indexHtml.replace(/<script[\s\S]*?<\/script>/g, '');

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
}

function clickButton(label: string): void {
  const norm = (t: string | null) => (t ?? '').replace(/\s+/g, '');
  const matches = [...document.querySelectorAll('button')].filter(
    (b) => norm(b.textContent) === norm(label),
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "${label}" button, found ${matches.length}`);
  }
  (matches[0] as HTMLButtonElement).click();
}

const modalBodyText = () => el('modal-body').textContent ?? '';

beforeAll(async () => {
  document.body.innerHTML = body.match(/<body>([\s\S]*)<\/body>/)![1];
  (window as unknown as { __SKIP_INTRO__: boolean }).__SKIP_INTRO__ = true;
  await import('../ui/main');
});

describe('help panel', () => {
  it('setup screen: How to play opens the overlay and every close path works', () => {
    expect(el('game').hidden).toBe(true);
    expect(el('helpBtn')).toBeTruthy();

    el('setupHelpBtn').click();
    expect(el('modal').hidden).toBe(false);
    expect(el('modal-title').textContent).toBe('How to play');
    expect(modalBodyText()).toContain('Objective');
    expect(modalBodyText()).toContain('Your turn');
    expect(modalBodyText()).toContain('Key rules');
    expect(modalBodyText()).toContain('Units');
    // Setup defaults: America selected at 4 players, 1942 data not yet
    // loaded, so the secondary block degrades without invented numbers.
    expect(modalBodyText()).toContain('Hold 3 of the 4 capitals');
    expect(modalBodyText()).toContain('On the other map');
    expect(modalBodyText()).not.toContain('Germany 6');

    // Close button.
    el('modal-close').click();
    expect(el('modal').hidden).toBe(true);

    // Backdrop click.
    el('setupHelpBtn').click();
    expect(el('modal').hidden).toBe(false);
    el('modal').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(el('modal').hidden).toBe(true);

    // Escape.
    el('setupHelpBtn').click();
    expect(el('modal').hidden).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el('modal').hidden).toBe(true);
  });

  it('hot-seat game: help opens from the topbar and leaves the game untouched', () => {
    document
      .querySelector<HTMLElement>('.dogtag[data-players="2"]')!
      .click();
    (el('seed') as HTMLInputElement).value = '7';
    clickButton('Commence Wargame');
    expect(el('game').hidden).toBe(false);

    const bannerBefore = el('banner').textContent;
    const autosaveBefore = localStorage.getItem('aaa.autosave');
    expect(autosaveBefore).toBeTruthy();

    el('helpBtn').click();
    expect(el('modal').hidden).toBe(false);
    expect(modalBodyText()).toContain('Objective');
    expect(modalBodyText()).toContain('Hold 2 of the 2 capitals');
    expect(modalBodyText()).toContain('Infantry');

    el('modal-close').click();
    expect(el('modal').hidden).toBe(true);
    expect(el('banner').textContent).toBe(bannerBefore);
    expect(localStorage.getItem('aaa.autosave')).toBe(autosaveBefore);
  });

  it('1942 game: help shows the victory cities objective from game state', async () => {
    clickButton('New game');
    expect(el('setup').hidden).toBe(false);
    document
      .querySelector<HTMLElement>('.map-folio[data-map="world1942"]')!
      .click();
    await ensureMapLoaded('world1942');
    clickButton('Commence Wargame');
    expect(el('game').hidden).toBe(false);
    expect(el('banner').textContent).toContain('Germany');

    el('helpBtn').click();
    expect(el('modal').hidden).toBe(false);
    expect(modalBodyText()).toContain('Hold 3 of the 5 capitals');
    expect(modalBodyText()).toContain('Germany 6');
    expect(modalBodyText()).toContain('USSR 5');
    expect(modalBodyText()).toContain('Japan 6');
    expect(modalBodyText()).toContain('UK + US 8');
    expect(modalBodyText()).toContain('end of a complete round');

    el('modal-close').click();
    expect(el('modal').hidden).toBe(true);
  });
});
