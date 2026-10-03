// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import indexHtml from '../ui/index.html?raw';
import { MAP } from '../data/data';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  expect(e, `#${id} exists`).not.toBeNull();
  return e as T;
}

function setNum(id: string, v: number): void {
  el<HTMLInputElement>(id).value = String(v);
}

function clickButton(text: string): void {
  const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent === text);
  expect(btns, `button "${text}"`).toHaveLength(1);
  btns[0].click();
}

function banner(): string {
  return el('banner').textContent ?? '';
}

function rectIndexFor(tid: string): number {
  return MAP.territories.findIndex((t) => t.id === tid);
}

function clickTerr(tid: string): void {
  const rects = document.querySelectorAll('#map .terr');
  const r = rects[rectIndexFor(tid)];
  expect(r, `rect for ${tid}`).toBeDefined();
  (r as SVGPolygonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function ownerOf(tid: string): string | null {
  const rects = document.querySelectorAll('#map .terr');
  const fill = (rects[rectIndexFor(tid)] as SVGRectElement).getAttribute('fill');
  if (fill === '#8a8f98') return null;
  const players = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
  const idx = players.indexOf(fill ?? '');
  return idx >= 0 ? `Player ${idx + 1}` : `unknown:${fill}`;
}

beforeAll(async () => {
  const body = (indexHtml as string).match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/, '');
  document.body.innerHTML = body;
  await import('../ui/main');
});

describe('browser UI playthrough', () => {
  it('starts a game and renders 26 territories', () => {
    (el<HTMLSelectElement>('numPlayers').value = '2');
    (el<HTMLInputElement>('seed').value = '7');
    clickButton('Start game');
    expect(el('game').hidden).toBe(false);
    expect(banner()).toContain('purchase');
    expect(document.querySelectorAll('#map .terr')).toHaveLength(26);
    expect(document.querySelectorAll('#roster .p')).toHaveLength(2);
  });

  it('renders Tier 1 map chrome: groups, badges, icons, zoom controls', () => {
    const groups = document.querySelectorAll('#map g[data-terr]');
    expect(groups).toHaveLength(26);
    for (const g of groups) {
      expect(g.querySelector('title')?.textContent).toMatch(/IPC \d/);
    }
    expect(document.querySelectorAll('#map .ipcbadge')).toHaveLength(26);
    expect(document.querySelectorAll('#map .uicon').length).toBeGreaterThan(0);
    // 2p capitals (california, new_york) start with star badges + factories.
    expect(document.querySelectorAll('#map .capbadge')).toHaveLength(2);
    expect(document.querySelectorAll('#map .facbadge').length).toBeGreaterThanOrEqual(2);
    // Zoom controls rescale the viewport group.
    const vport = (): string =>
      document.getElementById('vport')?.getAttribute('transform') ?? '';
    expect(vport()).toContain('scale(1)');
    el('zin').click();
    expect(vport()).toContain('scale(1.25)');
    el('zreset').click();
    expect(vport()).toContain('scale(1)');
  });

  it('refuses unaffordable carts and shows the remaining balance live', () => {
    const bank = parseInt(banner().match(/bank (\d+) IPCs/)![1], 10);
    clickButton('Buy units…');
    const inp = el<HTMLInputElement>('buy-infantry');
    inp.value = '999';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const n = parseInt(inp.value, 10);
    expect(n * 3).toBeLessThanOrEqual(bank); // pulled back to affordable
    expect(el('buy-remaining').textContent).toBe(
      `Remaining after purchase: ${bank - n * 3} IPCs.`,
    );
    expect(parseInt(inp.max, 10) * 3).toBeLessThanOrEqual(bank); // [+] ceiling tightened
    // Buying the clamped cart succeeds and deducts the bank.
    clickButton('Buy');
    expect(el('error').textContent).toBe('');
    expect(banner()).toContain(`bank ${bank - n * 3} IPCs`);
  });

  it('updates the cart live when stepper [+] is clicked', () => {
    clickButton('New game');
    (el<HTMLSelectElement>('numPlayers').value = '2');
    (el<HTMLInputElement>('seed').value = '7');
    clickButton('Start game');
    const bank = parseInt(banner().match(/bank (\d+) IPCs/)![1], 10);
    clickButton('Buy units…');
    const inp = el<HTMLInputElement>('buy-infantry');
    const plus = inp.nextElementSibling as HTMLButtonElement;
    expect(plus.textContent).toBe('+');
    plus.click(); // no manual event dispatch: the button must notify by itself
    expect(inp.value).toBe('1');
    expect(el('modal-body').textContent).toContain('Cart total: 3 IPCs.');
    expect(el('buy-remaining').textContent).toBe(`Remaining after purchase: ${bank - 3} IPCs.`);
    plus.click();
    plus.click();
    const maxAffordable = Math.floor(bank / 3);
    expect(parseInt(inp.value, 10)).toBe(maxAffordable);
    expect(el('buy-remaining').textContent).toBe(
      `Remaining after purchase: ${bank - maxAffordable * 3} IPCs.`,
    );
  });

  it('advances to combat move and logs events', () => {
    el('endPhaseBtn').click(); // -> combatMove
    expect(banner()).toContain('combatMove');
    expect(el('log').textContent).toContain('Combat-move phase');
  });

  it('declares an attack through the map and fights it in the combat panel', () => {
    const me = banner().match(/(Player \d+)'s turn/)![1];
    // Find an owned territory showing infantry, adjacent to a non-owned one.
    // Forces render as icons; each territory group carries the full unit
    // summary in its <title> (native tooltip + accessible text).
    const unitsShown = (id: string): string => {
      const g = document.querySelector(`#map g[data-terr="${id}"]`);
      return g?.querySelector('title')?.textContent ?? '';
    };
    const owned = MAP.territories.map((t) => t.id).filter((id) => ownerOf(id) === me);
    expect(owned.length).toBeGreaterThan(0);
    let from: string | null = null;
    let to: string | null = null;
    for (const f of owned) {
      if (!/[1-9]\d*inf/.test(unitsShown(f))) continue;
      const enemy = MAP.territories
        .find((t) => t.id === f)!
        .neighbors.find((n) => ownerOf(n) !== me);
      if (enemy) {
        from = f;
        to = enemy;
        break;
      }
    }
    expect(from, 'attack origin').not.toBeNull();
    clickTerr(from!); // opens the move dialog
    expect((el('modal') as HTMLElement).hidden).toBe(false);
    expect(el('modal-title').textContent).toBe('Plan move');
    // Staging with zero troops is refused, not silently queued.
    (document.querySelector(`#modal-body button[data-dest="${to}"]`) as HTMLButtonElement).click();
    expect(el('error').textContent).toContain('at least one unit');
    expect(document.querySelectorAll('#map line')).toHaveLength(0);
    setNum('mv-infantry', 1);
    const destBtn = document.querySelector(
      `#modal-body button[data-dest="${to}"]`,
    ) as HTMLButtonElement;
    expect(destBtn, `destination button for ${to}`).toBeDefined();
    destBtn.click(); // stages the move; arrow appears on the map
    expect(el('phasepanel').textContent).toContain(`${from} → ${to}`);
    expect(document.querySelectorAll('#map line').length).toBeGreaterThan(0);
    clickButton('Launch moves');
    expect(el('error').textContent).toBe('');
    el('endPhaseBtn').click(); // -> combat
    expect(banner()).toContain('combat');
    // Open the battle dialog and fight to completion via Roll + Auto.
    const battlesBtn = [...document.querySelectorAll('#phasepanel button')].find((b) =>
      b.textContent?.startsWith('Battles'),
    ) as HTMLButtonElement;
    expect(battlesBtn, 'Battles button').toBeDefined();
    battlesBtn.click();
    expect(el('modal')).not.toBeNull();
    expect((el('modal') as HTMLElement).hidden).toBe(false);
    // Both forces always visible.
    expect(el('modal-body').textContent).toContain('Attacker');
    expect(el('modal-body').textContent).toContain('Defender');
    clickButton('Roll one round');
    // Dice shown as faces after the roll.
    expect(el('modal-body').textContent).toMatch(/[⚀⚁⚂⚃⚄⚅]/);
    // Casualty Apply stays disabled until the exact required count is dialed.
    const applyBtn = document.getElementById('cas-attacker-apply') as HTMLButtonElement | null;
    const autoBtn = [...document.querySelectorAll('#modal-body button')].find(
      (b) => b.textContent === 'Auto',
    ) as HTMLButtonElement | undefined;
    if (applyBtn && autoBtn) {
      expect(applyBtn.disabled).toBe(true);
      autoBtn.click();
      expect(el('error').textContent).toBe('');
    }
    let guard = 60;
    while (document.querySelector('#modal-body')?.textContent?.includes('Roll one round') && guard-- > 0) {
      const roll = [...document.querySelectorAll('#modal-body button')].find(
        (b) => b.textContent === 'Roll one round',
      ) as HTMLButtonElement | undefined;
      if (!roll || roll.disabled) {
        const autos = [...document.querySelectorAll('#modal-body button')].filter((b) => b.textContent === 'Auto');
        if (autos.length === 0) break;
        (autos[0] as HTMLButtonElement).click();
        continue;
      }
      roll.click();
      for (let i = 0; i < 4; i++) {
        const autos = [...document.querySelectorAll('#modal-body button')].filter((b) => b.textContent === 'Auto');
        if (autos.length === 0) break;
        (autos[0] as HTMLButtonElement).click();
      }
    }
    expect(guard).toBeGreaterThan(0);
    expect(el('log').textContent).toMatch(/holds against the attack|captures/);
  });

  it('finishes the turn: non-combat, mobilize, income, next player', () => {
    el('endPhaseBtn').click(); // -> nonCombat
    expect(banner()).toContain('nonCombat');
    el('endPhaseBtn').click(); // -> mobilize
    expect(banner()).toContain('mobilize');
    el('endPhaseBtn').click(); // -> income + next player
    expect(banner()).toContain('purchase');
    expect(el('log').textContent).toContain('collects');
  });

  it('only offers deployment controls at usable factories', () => {
    clickButton('New game');
    (el<HTMLSelectElement>('numPlayers').value = '2');
    (el<HTMLInputElement>('seed').value = '11');
    clickButton('Start game');
    const me = banner().match(/(Player \d+)'s turn/)![1];
    const myId = parseInt(me.split(' ')[1], 10) - 1;
    const cap = ['california', 'new_york'][myId];
    clickButton('Buy units…');
    el<HTMLInputElement>('buy-infantry').value = '1';
    el<HTMLInputElement>('buy-infantry').dispatchEvent(new Event('input', { bubbles: true }));
    clickButton('Buy');
    el('endPhaseBtn').click(); // -> combatMove
    el('endPhaseBtn').click(); // -> combat
    el('endPhaseBtn').click(); // -> nonCombat
    el('endPhaseBtn').click(); // -> mobilize
    expect(banner()).toContain('mobilize');
    // Capital factory: steppers offered.
    clickTerr(cap);
    expect(document.getElementById('mob-infantry'), 'capital offers mob steppers').not.toBeNull();
    // Owned ground without a factory: info only, no controls, no staging.
    const plain = MAP.territories.map((t) => t.id).find(
      (id) => ownerOf(id) === me && id !== cap,
    )!;
    clickTerr(plain);
    expect(document.getElementById('mob-infantry'), 'plain ground offers no steppers').toBeNull();
    expect(document.getElementById('mob-factory'), 'plain ground offers no factory box').toBeNull();
    expect(el('selinfo').textContent).toContain('No usable factory');
  });

  it('sends a chat message', () => {
    el('tab-chat').click();
    el<HTMLInputElement>('chatText').value = 'good luck';
    el('chatSend').click();
    expect(el('chat').textContent).toContain('good luck');
  });
});
