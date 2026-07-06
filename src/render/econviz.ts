// =============================================================================
// econviz.ts — the ECONOMY OBSERVATORY: a full-bleed stage overlay that shows
// the whole economy at once — its CURRENT state and its ENTIRE HISTORY from t0
// to now. Three complementary readings of "how has the economy evolved":
//
//   • STRIPS (left) — synchronized macro time series on one shared time axis,
//     FRED-style: output (with recession shading), prices, rates, money &
//     credit, labour, firm demography, the WEALTH FAN (p10–p90 of the whole
//     population — inequality as a widening/narrowing river), housing. Below
//     them an EVENT LANE drops glyphs for the discrete drama (foundings,
//     bankruptcies, defaults, rate moves, evictions) on the same axis.
//   • PHASE PORTRAIT (right-middle) — the Phillips trail (unemployment ×
//     inflation), ink fading with age: loops and spirals reveal the dynamics,
//     not just the levels.
//   • NOW BOARD (right-top) — sector prices vs base with shortage + inventory,
//     bank capital ratios against the Basel band, the Fed's stance, town
//     pulse; and the most recent notable events as text.
//
// Data comes from snapshot.economy.history (EconHistory: one sample per econ
// tick, pair-merge decimated so the series always spans t0→now) — redraws are
// gated on its version counter, so the canvas repaints ~once per econ tick.
// Same family as memoryviz/psycheviz: 2D canvas, ink on aged paper, titlebar
// toggle (plus the `e` key wired in main.ts).
// =============================================================================
import type { TownSnapshot } from '../core/types';
import type { EconSnapshot, EconHistoryView, EconEvent } from '../econ/types';

const C = {
  paper: '#e9dec4', ink: '#20180f', inkSoft: '#5b4d38', inkFaint: '#9b8a68',
  accent: '#7a1f12', good: '#355e3b', band: 'rgba(32,24,15,0.055)',
};
const MONO = '"SFMono-Regular", ui-monospace, Menlo, monospace';

interface SeriesSpec {
  vals: readonly number[];
  color: string;
  width?: number;
  alpha?: number;
  fillTo?: number;      // fill down to this VALUE (area chart) at low alpha
  dash?: number[];
}

interface StripSpec {
  title: string;
  series: SeriesSpec[];
  ref?: number;               // horizontal reference line (e.g. CPI = 1)
  fmt: (v: number) => string; // last-value label
  min?: number;               // force domain floor (e.g. 0)
  band?: [readonly number[], readonly number[], string][]; // fan fills [lo, hi, color]
}

export class EconViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = true;
  private lastVersion = -1;
  private needsDraw = true;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'econviz';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle off';
    this.btn.textContent = 'ECON';
    this.btn.title = 'Toggle the Economy Observatory (e)';
    this.btn.onclick = () => this.toggle();
    titlebarEl.insertBefore(this.btn, titlebarEl.querySelector('.clock'));
    this.resize();
  }

  toggle(): void {
    this.hidden = !this.hidden;
    this.canvas.style.display = this.hidden ? 'none' : 'block';
    this.btn.classList.toggle('off', this.hidden);
    if (!this.hidden) { this.resize(); this.needsDraw = true; }
  }

  resize(): void {
    if (this.hidden) return;
    const p = this.canvas.parentElement;
    const w = Math.max(1, p?.clientWidth ?? 1), h = Math.max(1, p?.clientHeight ?? 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.needsDraw = true;
  }

  update(snap: TownSnapshot, _dtReal: number): void {
    if (this.hidden) return;
    const e = snap.economy as EconSnapshot | undefined;
    const h = e?.history;
    if (!e || !h || h.n < 2) return;
    if (h.version === this.lastVersion && !this.needsDraw) return;
    this.lastVersion = h.version;
    this.needsDraw = false;
    try { this.draw(e, h); } catch { /* never throw into the render loop */ }
  }

  // ===========================================================================
  // drawing
  // ===========================================================================
  private F(h: EconHistoryView, name: string): readonly number[] {
    const i = h.fields.indexOf(name);
    return i >= 0 ? h.data[i] : [];
  }

  private draw(e: EconSnapshot, h: EconHistoryView): void {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);

    const t = this.F(h, 't');
    const n = h.n;
    const t0 = t[0], t1 = Math.max(t[n - 1], t0 + 1);
    const tx = (x0: number, x1: number) => (tt: number) => x0 + ((tt - t0) / (t1 - t0)) * (x1 - x0);

    // ---- header --------------------------------------------------------------
    const m = e.macro;
    ctx.textAlign = 'left'; ctx.fillStyle = C.ink;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('ECONOMY OBSERVATORY', 14, 20);
    ctx.fillStyle = C.inkSoft;
    const day = Math.floor(m.clock / 24);
    ctx.fillText(
      `day ${day} · CPI ${m.cpi.toFixed(2)} · u ${(m.unemployment * 100).toFixed(1)}%` +
      ` · policy ${(((e.monetary?.fed.policyRate) ?? 0) * 100).toFixed(2)}%` +
      ` · GDP ${m.gdp.toFixed(0)}/h · ${m.firmsAlive} firms · gini ${m.gini.toFixed(2)}`,
      190, 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.inkFaint;
    ctx.fillText(`t0 → now · ${n} samples @ ${h.stride}h`, W - 14, 20);
    ctx.textAlign = 'left';

    // ---- geometry --------------------------------------------------------------
    const left0 = 14, left1 = Math.floor(W * 0.60);
    const railX = left1 + 22, rail1 = W - 14;
    const stripsTop = 34, axisY = H - 22, laneY = axisY - 20;
    const X = tx(left0 + 44, left1);        // 44px gutter for strip value labels

    // recession shading spans the whole strip column (boom < -0.35)
    this.recessionBands(ctx, this.F(h, 'boom'), t, X, stripsTop, laneY - 6);

    // ---- the strips ------------------------------------------------------------
    const pct = (v: number) => (v * 100).toFixed(1) + '%';
    const money = (v: number) => v >= 10000 ? '$' + (v / 1000).toFixed(0) + 'k' : '$' + v.toFixed(0);
    const strips: StripSpec[] = [
      {
        title: 'OUTPUT · gdp/h (shaded = recession)', fmt: (v) => v.toFixed(0), min: 0,
        series: [{ vals: this.F(h, 'gdp'), color: C.ink, fillTo: 0 }],
      },
      {
        title: 'PRICES · cpi (ink) · goods-only (faint)', ref: 1, fmt: (v) => v.toFixed(2),
        series: [
          { vals: this.F(h, 'goodsCpi'), color: C.inkFaint, width: 1 },
          { vals: this.F(h, 'cpi'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'RATES · policy (ink) · bank lending (oxblood)', ref: 0, fmt: pct, min: 0,
        series: [
          { vals: this.F(h, 'lendRate'), color: C.accent, width: 1 },
          { vals: this.F(h, 'policyRate'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'MONEY · broad (area) · base (line) · write-offs ▼', fmt: money, min: 0,
        series: [
          { vals: this.F(h, 'baseMoney'), color: C.inkSoft, width: 1 },
          { vals: this.F(h, 'broadMoney'), color: C.good, width: 1.2, fillTo: 0 },
        ],
      },
      {
        title: 'LABOUR · unemployment (ink) · vacancies (faint)', ref: 0.07, fmt: pct, min: 0,
        series: [
          { vals: this.F(h, 'vacancies'), color: C.inkFaint, width: 1, alpha: 0.7 },
          { vals: this.F(h, 'unemployment'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'FIRMS · alive · ▲ born ✕ died', fmt: (v) => v.toFixed(0), min: 0,
        series: [{ vals: this.F(h, 'firmsAlive'), color: C.ink, width: 1.4 }],
      },
      {
        title: 'WEALTH · p10–p90 river · median (ink) · debt (oxblood)', fmt: money,
        band: [
          [this.F(h, 'wealthP10'), this.F(h, 'wealthP90'), 'rgba(53,94,59,0.14)'],
          [this.F(h, 'wealthP25'), this.F(h, 'wealthP75'), 'rgba(53,94,59,0.18)'],
        ],
        series: [
          { vals: this.F(h, 'consumerDebt'), color: C.accent, width: 1 },
          { vals: this.F(h, 'wealthP50'), color: C.ink, width: 1.2 },
        ],
      },
      {
        title: 'HOUSING · rent (ink) · dwellings (faint)', fmt: (v) => '$' + v.toFixed(0),
        series: [
          { vals: this.F(h, 'dwellings'), color: C.inkFaint, width: 1 },
          { vals: this.F(h, 'rent'), color: C.ink, width: 1.4 },
        ],
      },
    ];

    const gap = 7;
    const stripH = (laneY - 6 - stripsTop - gap * (strips.length - 1)) / strips.length;
    strips.forEach((s, i) => {
      const y0 = stripsTop + i * (stripH + gap);
      this.strip(ctx, s, t, X, left0, y0, left1, y0 + stripH);
    });

    // firm birth/death ticks on the FIRMS strip
    const firmsIdx = 5;
    const fy = stripsTop + firmsIdx * (stripH + gap);
    this.demographyTicks(ctx, h, X, fy, fy + stripH);
    // write-off ticks on the MONEY strip
    const my = stripsTop + 3 * (stripH + gap);
    this.writeOffTicks(ctx, h, t, X, my + stripH);

    // ---- event lane + time axis -----------------------------------------------
    this.eventLane(ctx, h.events, X, laneY, t0, t1);
    this.timeAxis(ctx, X, left0 + 44, left1, axisY, t0, t1);

    // ---- right rail -------------------------------------------------------------
    const railTop = 34;
    const nowH = Math.floor((H - railTop - 30) * 0.42);
    const phH = Math.floor((H - railTop - 30) * 0.34);
    this.nowBoard(ctx, e, railX, railTop, rail1, railTop + nowH);
    this.phillips(ctx, h, railX, railTop + nowH + 14, rail1, railTop + nowH + phH);
    this.recentEvents(ctx, h.events, m.clock, railX, railTop + nowH + phH + 26, rail1, H - 16);
  }

  // ---- one synced strip -------------------------------------------------------
  private strip(ctx: CanvasRenderingContext2D, s: StripSpec, t: readonly number[],
    X: (tt: number) => number, labelX: number, y0: number, x1: number, y1: number): void {
    // domain
    let lo = Infinity, hi = -Infinity;
    const scan = (vals: readonly number[]) => {
      for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    };
    for (const sp of s.series) scan(sp.vals);
    if (s.band) for (const [a, b] of s.band) { scan(a); scan(b); }
    if (s.ref !== undefined) { lo = Math.min(lo, s.ref); hi = Math.max(hi, s.ref); }
    if (s.min !== undefined) lo = Math.min(s.min, lo);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const pad = (hi - lo) * 0.1 + 1e-9;
    lo -= pad * 0.4; hi += pad;
    const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0 - 10) - 2;

    // frame + reference line
    ctx.strokeStyle = 'rgba(32,24,15,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(t[0]), y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
    if (s.ref !== undefined) {
      ctx.strokeStyle = 'rgba(32,24,15,0.18)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(t[0]), Y(s.ref)); ctx.lineTo(x1, Y(s.ref)); ctx.stroke();
      ctx.setLineDash([]);
    }

    // fan bands (wealth river)
    if (s.band) {
      for (const [loV, hiV, color] of s.band) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < t.length; i++) { const x = X(t[i]), y = Y(hiV[i] ?? 0); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
        for (let i = t.length - 1; i >= 0; i--) ctx.lineTo(X(t[i]), Y(loV[i] ?? 0));
        ctx.closePath(); ctx.fill();
      }
    }

    // series
    for (const sp of s.series) {
      const vals = sp.vals;
      if (!vals.length) continue;
      if (sp.fillTo !== undefined) {
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = sp.color;
        ctx.beginPath();
        ctx.moveTo(X(t[0]), Y(Math.max(sp.fillTo, lo)));
        for (let i = 0; i < t.length; i++) ctx.lineTo(X(t[i]), Y(vals[i] ?? 0));
        ctx.lineTo(X(t[t.length - 1]), Y(Math.max(sp.fillTo, lo)));
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = sp.alpha ?? 1;
      ctx.strokeStyle = sp.color;
      ctx.lineWidth = sp.width ?? 1;
      if (sp.dash) ctx.setLineDash(sp.dash);
      ctx.beginPath();
      for (let i = 0; i < t.length; i++) { const x = X(t[i]), y = Y(vals[i] ?? 0); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // title + latest value
    ctx.fillStyle = C.inkSoft;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText(s.title, labelX + 44, y0 + 8);
    const main = s.series[s.series.length - 1];
    const last = main.vals[main.vals.length - 1];
    if (Number.isFinite(last)) {
      ctx.fillStyle = main.color;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(s.fmt(last), labelX + 40, Y(last) + 3);
      ctx.beginPath(); ctx.arc(X(t[t.length - 1]), Y(last), 2, 0, Math.PI * 2);
      ctx.fillStyle = main.color; ctx.fill();
      ctx.textAlign = 'left';
    }
  }

  private recessionBands(ctx: CanvasRenderingContext2D, boom: readonly number[], t: readonly number[],
    X: (tt: number) => number, y0: number, y1: number): void {
    ctx.fillStyle = C.band;
    let start = -1;
    for (let i = 0; i <= boom.length; i++) {
      const inRec = i < boom.length && boom[i] < -0.35;
      if (inRec && start < 0) start = i;
      else if (!inRec && start >= 0) {
        ctx.fillRect(X(t[start]), y0, Math.max(1, X(t[Math.min(i, t.length - 1)]) - X(t[start])), y1 - y0);
        start = -1;
      }
    }
  }

  private demographyTicks(ctx: CanvasRenderingContext2D, h: EconHistoryView,
    X: (tt: number) => number, y0: number, y1: number): void {
    for (const ev of h.events) {
      const x = X(ev.t);
      if (ev.kind === 'found') {
        ctx.fillStyle = C.good;
        ctx.beginPath(); ctx.moveTo(x, y1 - 8); ctx.lineTo(x - 3, y1 - 2); ctx.lineTo(x + 3, y1 - 2); ctx.closePath(); ctx.fill();
      } else if (ev.kind === 'bankrupt') {
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 3, y0 + 4); ctx.lineTo(x + 3, y0 + 10);
        ctx.moveTo(x + 3, y0 + 4); ctx.lineTo(x - 3, y0 + 10);
        ctx.stroke();
      }
    }
  }

  private writeOffTicks(ctx: CanvasRenderingContext2D, h: EconHistoryView, t: readonly number[],
    X: (tt: number) => number, yBase: number): void {
    const wo = this.F(h, 'writeOffs');
    ctx.fillStyle = C.accent;
    for (let i = 0; i < wo.length; i++) {
      if ((wo[i] ?? 0) > 0.5) {
        const x = X(t[i]);
        ctx.beginPath(); ctx.moveTo(x, yBase - 7); ctx.lineTo(x - 2.5, yBase - 1); ctx.lineTo(x + 2.5, yBase - 1); ctx.closePath(); ctx.fill();
      }
    }
  }

  private eventLane(ctx: CanvasRenderingContext2D, events: readonly EconEvent[],
    X: (tt: number) => number, y: number, t0: number, t1: number): void {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.textAlign = 'left';
    ctx.fillText('events', 14, y + 10);
    for (const ev of events) {
      if (ev.t < t0 || ev.t > t1) continue;
      const x = X(ev.t), cy = y + 7;
      switch (ev.kind) {
        case 'found':
          ctx.fillStyle = C.good;
          ctx.beginPath(); ctx.moveTo(x, cy - 4); ctx.lineTo(x - 3.5, cy + 3); ctx.lineTo(x + 3.5, cy + 3); ctx.closePath(); ctx.fill();
          break;
        case 'bankrupt':
          ctx.strokeStyle = C.accent; ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(x - 3, cy - 3); ctx.lineTo(x + 3, cy + 3);
          ctx.moveTo(x + 3, cy - 3); ctx.lineTo(x - 3, cy + 3);
          ctx.stroke();
          break;
        case 'default':
          ctx.fillStyle = C.accent;
          ctx.beginPath(); ctx.moveTo(x, cy + 4); ctx.lineTo(x - 3, cy - 3); ctx.lineTo(x + 3, cy - 3); ctx.closePath(); ctx.fill();
          break;
        case 'policy': {
          const up = (ev.mag ?? 0) >= 0;
          ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, cy + 4); ctx.lineTo(x, cy - 4);
          ctx.moveTo(x - 2.5, up ? cy - 1 : cy + 1); ctx.lineTo(x, up ? cy - 4 : cy + 4); ctx.lineTo(x + 2.5, up ? cy - 1 : cy + 1);
          ctx.stroke();
          break;
        }
        case 'boom': case 'bust':
          ctx.fillStyle = ev.kind === 'boom' ? C.good : C.accent;
          ctx.beginPath();
          ctx.moveTo(x, cy - 4); ctx.lineTo(x + 3.5, cy); ctx.lineTo(x, cy + 4); ctx.lineTo(x - 3.5, cy); ctx.closePath();
          ctx.globalAlpha = 0.7; ctx.fill(); ctx.globalAlpha = 1;
          break;
        default: // evict
          ctx.fillStyle = C.inkFaint;
          ctx.beginPath(); ctx.arc(x, cy, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  private timeAxis(ctx: CanvasRenderingContext2D, X: (tt: number) => number,
    x0: number, x1: number, y: number, t0: number, t1: number): void {
    ctx.strokeStyle = 'rgba(32,24,15,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.stroke();
    const spanDays = (t1 - t0) / 24;
    const step = Math.max(1, Math.ceil(spanDays / 10));
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkSoft;
    ctx.textAlign = 'center';
    for (let d = Math.ceil(t0 / 24 / step) * step; d * 24 <= t1; d += step) {
      const x = X(d * 24);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 4); ctx.stroke();
      ctx.fillText('d' + d, x, y + 13);
    }
    ctx.textAlign = 'left';
  }

  // ---- right rail: the NOW board ----------------------------------------------
  private nowBoard(ctx: CanvasRenderingContext2D, e: EconSnapshot,
    x0: number, y0: number, x1: number, y1: number): void {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('NOW', x0, y0 + 8);
    let y = y0 + 22;
    const lh = Math.min(15, (y1 - y0 - 30) / (e.markets.length + (e.monetary?.banks.length ?? 0) + 4));

    // sector rows: price bar vs base (log scale −1..+1 ≈ ×0.37..×2.7)
    ctx.font = `10px ${MONO}`;
    const barX = x0 + 130, barW = Math.min(110, x1 - barX - 90);
    for (const mk of e.markets) {
      const base = mk.price / (1 + mk.inflation || 1e-9);
      const ratio = base > 0 ? mk.price / base : 1;
      const pos = Math.max(-1, Math.min(1, Math.log(Math.max(ratio, 1e-3))));
      ctx.fillStyle = C.ink;
      ctx.fillText(mk.sector.padEnd(10), x0, y);
      ctx.fillStyle = C.inkSoft;
      ctx.fillText(('$' + (mk.price >= 100 ? mk.price.toFixed(0) : mk.price.toFixed(2))).padStart(7), x0 + 66, y);
      // bar: centre = t0 base price
      ctx.strokeStyle = 'rgba(32,24,15,0.2)';
      ctx.beginPath(); ctx.moveTo(barX, y - 3.5); ctx.lineTo(barX + barW, y - 3.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(barX + barW / 2, y - 7); ctx.lineTo(barX + barW / 2, y); ctx.stroke();
      ctx.fillStyle = pos >= 0 ? C.accent : C.good;
      const bw = (barW / 2) * Math.abs(pos);
      ctx.fillRect(pos >= 0 ? barX + barW / 2 : barX + barW / 2 - bw, y - 6, Math.max(1, bw), 5);
      // shortage dot + inventory
      if (mk.shortage > 0.02) {
        ctx.fillStyle = mk.shortage > 0.3 ? C.accent : C.inkSoft;
        ctx.beginPath(); ctx.arc(barX + barW + 12, y - 3.5, 2 + mk.shortage * 3, 0, Math.PI * 2); ctx.fill();
      }
      const inv = e.businesses.filter((b) => b.sector === mk.sector).reduce((s, b) => s + b.inventory, 0);
      if (inv > 0.5) {
        ctx.fillStyle = C.inkFaint;
        ctx.fillText('inv ' + inv.toFixed(0), barX + barW + 22, y);
      }
      y += lh;
    }
    y += 4;

    // banks: capital ratio vs the Basel band (7% floor · 12% target)
    for (const b of e.monetary?.banks ?? []) {
      ctx.fillStyle = C.ink;
      ctx.fillText(b.name.padEnd(16), x0, y);
      const bx = x0 + 130, bw2 = Math.min(110, x1 - bx - 90);
      const frac = Math.max(0, Math.min(1, b.capitalRatio / 0.24));
      ctx.strokeStyle = 'rgba(32,24,15,0.2)';
      ctx.strokeRect(bx, y - 7, bw2, 6);
      ctx.fillStyle = b.capitalRatio < 0.08 ? C.accent : b.capitalRatio < 0.11 ? C.inkSoft : C.good;
      ctx.fillRect(bx, y - 7, bw2 * frac, 6);
      for (const mark of [0.07, 0.12]) {
        const mxx = bx + bw2 * (mark / 0.24);
        ctx.strokeStyle = C.ink;
        ctx.beginPath(); ctx.moveTo(mxx, y - 9); ctx.lineTo(mxx, y + 1); ctx.stroke();
      }
      ctx.fillStyle = C.inkSoft;
      const ratioLabel = b.capitalRatio > 0.24 ? '24%+' : (b.capitalRatio * 100).toFixed(0) + '%';
      ctx.fillText(`${ratioLabel} · $${(b.capital / 1000).toFixed(1)}k`, bx + bw2 + 10, y);
      y += lh;
    }
    y += 4;

    // fed + money + town pulse
    const mon = e.monetary;
    ctx.fillStyle = C.inkSoft;
    if (mon) {
      ctx.fillText(`fed  ${(mon.fed.policyRate * 100).toFixed(2)}% → lend ${(mon.avgLendingRate * 100).toFixed(2)}%` +
        ` · M2 $${(mon.broadMoney / 1000).toFixed(0)}k · vel ${mon.velocity.toFixed(3)}`, x0, y); y += lh;
      ctx.fillText(`credit +$${mon.creditCreated.toFixed(0)} −$${mon.creditRepaid.toFixed(0)}` +
        ` · write-offs $${mon.writeOffs.toFixed(0)} · hh debt $${e.shadow.consumerDebt.toFixed(0)}`, x0, y); y += lh;
    }
    ctx.fillText(`town  ${e.construction?.activeProjects ?? 0} building · ${e.construction?.completedBuildings ?? 0} built` +
      ` · market ${(100 * (e.supermarket?.fillLevel ?? 0)).toFixed(0)}% stocked` +
      ` · ${e.macro.homelessCount} homeless`, x0, y);
  }

  // ---- right rail: the Phillips phase portrait ----------------------------------
  private phillips(ctx: CanvasRenderingContext2D, h: EconHistoryView,
    x0: number, y0: number, x1: number, y1: number): void {
    const u = this.F(h, 'unemployment'), pi = this.F(h, 'piAnnual');
    if (!u.length) return;
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('PHILLIPS TRAIL · unemployment → inflation · ink fades with age', x0, y0 + 8);
    const px0 = x0 + 30, px1 = x1 - 8, py0 = y0 + 18, py1 = y1 - 16;
    let uMax = 0.14, piLo = -0.05, piHi = 0.08;
    for (let i = 0; i < u.length; i++) { uMax = Math.max(uMax, u[i]); piLo = Math.min(piLo, pi[i]); piHi = Math.max(piHi, pi[i]); }
    const PX = (v: number) => px0 + (v / (uMax * 1.1)) * (px1 - px0);
    const PY = (v: number) => py1 - ((v - piLo) / (piHi - piLo + 1e-9)) * (py1 - py0);

    // frame + the dual-mandate cross (u* = 7%, π* = 2%)
    ctx.strokeStyle = 'rgba(32,24,15,0.2)';
    ctx.strokeRect(px0, py0, px1 - px0, py1 - py0);
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(PX(0.07), py0); ctx.lineTo(PX(0.07), py1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px0, PY(0.02)); ctx.lineTo(px1, PY(0.02)); ctx.stroke();
    ctx.setLineDash([]);

    // the trail — age-faded ink
    const N = u.length;
    for (let i = 1; i < N; i++) {
      const a = 0.06 + 0.74 * (i / N);
      ctx.strokeStyle = `rgba(32,24,15,${a.toFixed(3)})`;
      ctx.lineWidth = 0.8 + 0.8 * (i / N);
      ctx.beginPath();
      ctx.moveTo(PX(u[i - 1]), PY(pi[i - 1]));
      ctx.lineTo(PX(u[i]), PY(pi[i]));
      ctx.stroke();
    }
    // start ○ and now ●
    ctx.strokeStyle = C.inkSoft;
    ctx.beginPath(); ctx.arc(PX(u[0]), PY(pi[0]), 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.accent;
    ctx.beginPath(); ctx.arc(PX(u[N - 1]), PY(pi[N - 1]), 3.5, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = C.inkSoft;
    ctx.textAlign = 'center';
    ctx.fillText('u →', (px0 + px1) / 2, py1 + 11);
    ctx.textAlign = 'left';
    ctx.save();
    ctx.translate(x0 + 8, (py0 + py1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('π →', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
  }

  // ---- right rail: recent notable events as text -------------------------------
  private recentEvents(ctx: CanvasRenderingContext2D, events: readonly EconEvent[],
    clock: number, x0: number, y0: number, x1: number, y1: number): void {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('RECENT', x0, y0);
    ctx.font = `10px ${MONO}`;
    const lines = Math.max(1, Math.floor((y1 - y0 - 8) / 13));
    const recent = events.slice(-lines).reverse();
    let y = y0 + 14;
    for (const ev of recent) {
      const age = Math.max(0, clock - ev.t);
      const when = age < 24 ? `${age.toFixed(0)}h ago` : `d${Math.floor(ev.t / 24)}`;
      ctx.fillStyle = ev.kind === 'found' ? C.good : ev.kind === 'evict' ? C.inkFaint : ev.kind === 'policy' ? C.inkSoft : C.accent;
      ctx.fillText('·', x0, y);
      ctx.fillStyle = C.inkSoft;
      ctx.fillText(`${when.padEnd(8)} ${this.clip(ev.label, 46)}`, x0 + 8, y);
      y += 13;
      if (y > y1) break;
    }
  }

  private clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  dispose(): void { this.canvas.remove(); this.btn.remove(); }
}
