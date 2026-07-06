// =============================================================================
// townpanel.ts — a compact dashboard panel making the EMERGENT life legible:
//   where Mara is, what she's doing and WHY (the arbiter's reason), her Maslow
//   need deficits, the resource economy (money / food / savings), and the
//   relationship ledger as it forms. Self-mounts into the dashboard aside.
// =============================================================================
import type { TownSnapshot, NeedsReadout } from '../core/types';

const PLACE_LABEL: Record<string, string> = {
  home: 'Apartment', work: 'The Counter', market: 'Market', thirdplace: 'Café', park: 'Park',
};
const NEED_ROWS: { key: keyof NeedsReadout; label: string }[] = [
  { key: 'hunger', label: 'hunger' }, { key: 'thirst', label: 'thirst' },
  { key: 'elimination', label: 'bladder' }, { key: 'cleanliness', label: 'grime' },
  { key: 'energy', label: 'depletion' },
  { key: 'safety', label: 'unsafety' }, { key: 'belonging', label: 'loneliness' },
  { key: 'esteem', label: 'esteem-gap' }, { key: 'novelty', label: 'novelty-gap' },
];

export class TownPanel {
  private readonly where: HTMLElement;
  private readonly doing: HTMLElement;
  private readonly res: HTMLElement;
  private readonly bars = new Map<string, HTMLElement>();
  private readonly rels: HTMLElement;
  private cache = '';

  constructor(dashEl: HTMLElement) {
    const panel = document.createElement('div');
    panel.className = 'panel town-panel';
    panel.innerHTML = '<h2>The day · a life by need</h2>';

    this.where = el('div', 'town-where'); panel.appendChild(this.where);
    this.doing = el('div', 'town-doing'); panel.appendChild(this.doing);

    const needs = el('div', 'town-needs'); panel.appendChild(needs);
    for (const r of NEED_ROWS) {
      const row = el('div', 'town-need');
      const lab = el('span', 'town-need-l'); lab.textContent = r.label;
      const track = el('div', 'town-bar');
      const fill = el('div', 'town-bar-f');
      track.appendChild(fill);
      row.append(lab, track);
      needs.appendChild(row);
      this.bars.set(r.key as string, fill);
    }

    this.res = el('div', 'town-res'); panel.appendChild(this.res);

    const h3 = el('div', 'town-sub'); h3.textContent = 'Relationships'; panel.appendChild(h3);
    this.rels = el('div', 'town-rels'); panel.appendChild(this.rels);

    // sits just under the brain panel (which inserts itself at the very top)
    dashEl.insertBefore(panel, dashEl.children[1] ?? null);
  }

  update(snap: TownSnapshot): void {
    if (!snap) return;
    const placeName = PLACE_LABEL[snap.place] ?? snap.place;
    this.where.textContent = snap.travelling
      ? `walking · day ${snap.day}${snap.weekend ? ' (weekend)' : ''}`
      : `${placeName} · day ${snap.day}${snap.weekend ? ' (weekend)' : ''}`;
    this.doing.textContent = snap.intention?.reason ?? '';

    const n = snap.needs;
    if (n) for (const r of NEED_ROWS) {
      const v = Math.max(0, Math.min(1, n[r.key] as number));
      const fill = this.bars.get(r.key as string)!;
      fill.style.width = `${Math.round(v * 100)}%`;
      fill.classList.toggle('hot', v > 0.6);
    }
    const res = snap.resources;
    this.res.textContent = `$${res.money.toFixed(0)} · food ${res.foodStock.toFixed(0)} · saved $${res.wageEarned.toFixed(0)}`;

    // relationships (only redraw on change)
    const key = snap.relationships.map((r) => `${r.name}${r.stage}${r.affection.toFixed(1)}`).join('|');
    if (key !== this.cache) {
      this.cache = key;
      this.rels.innerHTML = '';
      if (!snap.relationships.length) {
        const e = el('div', 'town-rel-empty'); e.textContent = '— no one yet —'; this.rels.appendChild(e);
      }
      for (const r of snap.relationships.slice(0, 6)) {
        const row = el('div', 'town-rel');
        const tone = r.affection > 0.2 ? 'warm' : r.affection < -0.2 ? 'cold' : 'neutral';
        row.classList.add(tone);
        row.innerHTML =
          `<span class="town-rel-n">${r.name}</span>` +
          `<span class="town-rel-s">${r.stage}</span>` +
          `<span class="town-rel-e">${r.encounters}×</span>`;
        this.rels.appendChild(row);
      }
    }
  }
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}
