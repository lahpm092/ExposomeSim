// =============================================================================
// cityview.ts — the zoomed-OUT town: a 2D top-down map on aged sepia, black
//   wireframe line-work. What you see here is exactly the Tier-3 statistics being
//   simulated: a breathing population-density field (no agents, just occupancy),
//   the place nodes, and Mara's marker tracing her needs-driven path between them.
//   Near the café, the people she has actually met condense into a relationship
//   constellation — warm bonds in green, strained ones in oxblood.
//
//   Self-mounts a full-bleed canvas over the stage + a CITY toggle in the titlebar
//   (mirrors BrainPanel). 2D canvas, not WebGL — the locale stage stays the 3D view.
// =============================================================================
import type { TownSnapshot, PlaceId, Relationship } from '../core/types';
import { PLACES, PLACE_LIST } from '../world/places';

const C = {
  paper: '#e9dec4', paperDeep: '#ded2b4', ink: '#20180f',
  inkSoft: '#5b4d38', inkFaint: '#9b8a68', accent: '#7a1f12', good: '#355e3b',
};
const STREETS: [PlaceId, PlaceId][] = [
  ['home', 'work'], ['home', 'market'], ['work', 'market'],
  ['market', 'thirdplace'], ['work', 'thirdplace'], ['home', 'park'], ['market', 'park'],
];
const GLYPH: Record<PlaceId, string> = {
  home: 'HOME', work: 'WORK', market: 'MARKET', thirdplace: 'CAFÉ', park: 'PARK',
};

const fmtClock = (t: number) => {
  const h = Math.floor(((t % 24) + 24) % 24), m = Math.floor((t - Math.floor(t)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hash01 = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

export class CityView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = true;
  private trail: { x: number; y: number }[] = [];
  private clock = 0;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cityview';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle';
    this.btn.textContent = 'CITY';
    this.btn.title = 'Zoom out to the town';
    this.btn.onclick = () => this.toggle();
    titlebarEl.insertBefore(this.btn, titlebarEl.querySelector('.clock'));
    this.resize();
  }

  toggle(): void {
    this.hidden = !this.hidden;
    this.canvas.style.display = this.hidden ? 'none' : 'block';
    this.btn.classList.toggle('off', this.hidden);
    if (!this.hidden) this.resize();
  }
  get isOpen(): boolean { return !this.hidden; }

  resize(): void {
    if (this.hidden) return;
    const p = this.canvas.parentElement;
    const w = Math.max(1, p?.clientWidth ?? 1), h = Math.max(1, p?.clientHeight ?? 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(snap: TownSnapshot, dtReal: number): void {
    if (this.hidden) return;
    this.clock += Number.isFinite(dtReal) ? dtReal : 0;
    const ctx = this.ctx;
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    // map the [0,1] town box into a centred square with margin
    const pad = 54, side = Math.min(W, H) - pad * 2;
    const ox = (W - side) / 2, oy = (H - side) / 2;
    const PX = (x: number) => ox + x * side;
    const PY = (y: number) => oy + y * side;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);

    // --- density field: alpha stipple (count varies, positions are stable) ---
    try {
      const d = snap.density;
      if (d?.cell) {
        ctx.fillStyle = C.ink;
        const cw = side / d.cols, ch = side / d.rows;
        for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
          const occ = d.cell[r * d.cols + c] ?? 0;
          if (occ < 0.06) continue;
          const dots = Math.round(occ * 5);
          for (let i = 0; i < dots; i++) {
            const hx = hash01(r * 131 + c * 17 + i * 3.1);
            const hy = hash01(r * 57 + c * 91 + i * 7.7);
            ctx.globalAlpha = 0.10 + occ * 0.30;
            ctx.fillRect(PX((c + hx) / d.cols), PY((r + hy) / d.rows), 1.4, 1.4);
          }
        }
        ctx.globalAlpha = 1;
      }
    } catch { /* never break the loop */ }

    // --- streets ---
    ctx.strokeStyle = C.inkFaint; ctx.lineWidth = 1;
    for (const [a, b] of STREETS) {
      const pa = PLACES[a].pos2D, pb = PLACES[b].pos2D;
      ctx.beginPath(); ctx.moveTo(PX(pa.x), PY(pa.y)); ctx.lineTo(PX(pb.x), PY(pb.y)); ctx.stroke();
    }

    // --- places ---
    ctx.font = '10px "SFMono-Regular", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    for (const place of PLACE_LIST) {
      const x = PX(place.pos2D.x), y = PY(place.pos2D.y);
      const here = snap.place === place.id && !snap.travelling;
      ctx.strokeStyle = C.ink; ctx.lineWidth = here ? 2 : 1.2;
      ctx.strokeRect(x - 9, y - 9, 18, 18);
      if (here) { ctx.strokeStyle = C.accent; ctx.strokeRect(x - 13, y - 13, 26, 26); }
      ctx.fillStyle = C.inkSoft;
      ctx.fillText(GLYPH[place.id], x, y - 16);
    }

    // --- relationship constellation around the café ---
    this.drawRelationships(ctx, snap.relationships, PX(PLACES.thirdplace.pos2D.x), PY(PLACES.thirdplace.pos2D.y));

    // --- Mara's trail + marker ---
    const mx = PX(snap.macroPos.x), my = PY(snap.macroPos.y);
    this.trail.push({ x: mx, y: my });
    if (this.trail.length > 90) this.trail.shift();
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1;
    ctx.beginPath();
    this.trail.forEach((p, i) => {
      ctx.globalAlpha = (i / this.trail.length) * 0.5;
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke(); ctx.globalAlpha = 1;

    const arousal = snap.cashier?.soma?.arousal ?? 0.5;
    const pulse = 6 + Math.sin(this.clock * 3) * (1 + arousal * 3);
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.ink; ctx.font = 'italic 12px "Hoefler Text", Palatino, serif';
    ctx.fillText('Mara', mx, my + 22);

    // --- HUD ---
    this.drawHud(ctx, snap, W, H);
  }

  private drawRelationships(ctx: CanvasRenderingContext2D, rels: Relationship[], cx: number, cy: number): void {
    if (!rels?.length) return;
    const shown = rels.filter((r) => r.encounters > 0).slice(0, 6);
    shown.forEach((r, i) => {
      const a = (i / Math.max(1, shown.length)) * Math.PI * 2 + 0.6;
      const rad = 30 + (1 - r.familiarity) * 16;
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      const warm = r.affection > 0.2, cold = r.affection < -0.2;
      ctx.strokeStyle = warm ? C.good : cold ? C.accent : C.inkFaint;
      ctx.globalAlpha = 0.5; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = warm ? C.good : cold ? C.accent : C.inkSoft;
      ctx.beginPath(); ctx.arc(x, y, 2 + r.familiarity * 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = '9px "SFMono-Regular", ui-monospace, Menlo, monospace';
      ctx.fillText(`${r.name}${r.stage === 'friend' || r.stage === 'close' || r.stage === 'romantic' ? '·' + r.stage : ''}`, x, y - 6);
    });
  }

  private drawHud(ctx: CanvasRenderingContext2D, snap: TownSnapshot, W: number, _H: number): void {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = '11px "SFMono-Regular", ui-monospace, Menlo, monospace';
    const dow = DOW[snap.day % 7] ?? '';
    ctx.fillText(`${dow} · day ${snap.day} · ${fmtClock(snap.time)}${snap.weekend ? ' · weekend' : ''}`, 16, 22);
    ctx.fillStyle = C.ink;
    ctx.font = 'italic 14px "Hoefler Text", Palatino, serif';
    const r = snap.intention?.reason ?? '';
    ctx.fillText(snap.travelling ? `walking — ${r}` : r, 16, 42);
    // resources
    ctx.textAlign = 'right';
    ctx.fillStyle = C.inkSoft;
    ctx.font = '11px "SFMono-Regular", ui-monospace, Menlo, monospace';
    const res = snap.resources;
    ctx.fillText(`$${res.money.toFixed(0)}   food ${res.foodStock.toFixed(0)}   saved $${res.wageEarned.toFixed(0)}`, W - 16, 22);
    const n = snap.needs;
    if (n) ctx.fillText(`hunger ${(n.hunger * 100) | 0}%  energy ${((1 - n.energy) * 100) | 0}%  belonging ${((1 - n.belonging) * 100) | 0}%`, W - 16, 40);
  }

  dispose(): void { this.canvas.remove(); this.btn.remove(); }
}
