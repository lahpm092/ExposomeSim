// =============================================================================
// polisviz.ts — the POLIS OBSERVATORY: a full-bleed stage overlay for the
// emergent government AND the streets that feed its politics. Same instrument
// family as the Economy Observatory (econviz.ts): everything at once, t0 → now.
//
//   • STRIPS (left) — the civic time series on one shared axis: movement mass
//     vs the rival, salience & agitation, the opinion field (support/grievance),
//     legitimacy with ballot yes-shares, the treasury with spend ticks, turnout.
//     Below them a TRANSIT lane — ridership, commute cost/congestion, and the
//     modal-split river — because commute pain IS a civic input. Then an EVENT
//     LANE dropping glyphs for the discrete drama (assemblies, charters,
//     elections, recalls, insolvency; jams and service changes underneath).
//   • NOW RAIL (right) — the institution's state ladder, legitimacy + treasury
//     dials, the open ballot with live tallies (or the last result), the office
//     roster and policy lines, Tier-A stances, transit KPIs, recent events.
//
// Data comes from snapshot.gov.history (GovHistory) + snapshot.transport.history
// — redraws are gated on their version counters, so the canvas repaints ~once
// per econ tick. Both layers degrade gracefully: an old save without a gov or
// transport slot just shows what it has (or a quiet 'the polity sleeps').
// Toggled by the titlebar POLIS button or the `g` key (wired in main.ts).
// =============================================================================
import type { TownSnapshot } from '../core/types';
import type {
  GovView, GovHistoryView, GovEvent, InstitutionState, OfficeHolder,
} from '../gov/types';
import type { TransportView, TransportHistoryView, TransportEvent, ModeId } from '../transport/types';

const C = {
  paper: '#e9dec4', ink: '#20180f', inkSoft: '#5b4d38', inkFaint: '#9b8a68',
  accent: '#7a1f12', good: '#355e3b',
  bandGov: 'rgba(53,94,59,0.07)',      // an institution exists
  bandFail: 'rgba(122,31,18,0.08)',    // insolvent / recalled / dissolved
};
const MONO = '"SFMono-Regular", ui-monospace, Menlo, monospace';

/** the constitutional mainline; failure states hang off it. */
const STATE_LINE: InstitutionState[] = ['dormant', 'stirring', 'assembly-called', 'chartered', 'elected'];
const STATE_FAIL: InstitutionState[] = ['insolvent', 'recalled', 'dissolved'];

interface SeriesSpec {
  vals: readonly number[];
  color: string;
  width?: number;
  alpha?: number;
  fillTo?: number;
  dash?: number[];
}

interface StripSpec {
  title: string;
  t: readonly number[];       // each strip carries its own clock (gov vs transit)
  series: SeriesSpec[];
  ref?: number;
  fmt: (v: number) => string;
  min?: number;
  max?: number;
}

export class PolisViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = true;
  private lastVersion = -1;
  private needsDraw = true;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'polisviz';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle off';
    this.btn.textContent = 'POLIS';
    this.btn.title = 'Toggle the Polis Observatory (g)';
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
    const g = snap.gov, t = snap.transport;
    const ver = (g?.history?.version ?? -1) * 100003 + (t?.history?.version ?? -1);
    if (ver === this.lastVersion && !this.needsDraw) return;
    this.lastVersion = ver;
    this.needsDraw = false;
    try { this.draw(snap, g, t); } catch { /* never throw into the render loop */ }
  }

  // ===========================================================================
  // drawing
  // ===========================================================================
  private F(h: { fields: readonly string[]; data: number[][] } | undefined, name: string): readonly number[] {
    if (!h) return [];
    const i = h.fields.indexOf(name);
    return i >= 0 ? h.data[i] : [];
  }

  private nameOf(snap: TownSnapshot, id: string | null | undefined): string {
    if (!id) return '—';
    for (const a of snap.agents ?? []) {
      if (a.id === id || a.profile?.id === id) return a.profile?.name ?? id;
    }
    return id.replace(/^agent-/, '');
  }

  private draw(snap: TownSnapshot, g: GovView | undefined, t: TransportView | undefined): void {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
    const clockH = snap.day * 24 + snap.time;

    // ---- header ---------------------------------------------------------------
    ctx.textAlign = 'left'; ctx.fillStyle = C.ink;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('POLIS OBSERVATORY', 14, 20);
    ctx.fillStyle = C.inkSoft;
    if (g) {
      const lead = g.officials.some((o) => o.office === 'steward') ? 'steward' : 'leader';
      ctx.fillText(
        `state ${g.state} · mass ${g.mass.toFixed(2)} · legitimacy ${g.legitimacy.toFixed(2)}` +
        ` · treasury $${g.treasury.balance.toFixed(0)}${g.treasury.insolvent ? ' INSOLVENT' : ''}` +
        ` · ${lead} ${this.nameOf(snap, g.leaderId)}`, 170, 20);
    } else {
      ctx.fillText('no civic field in this save', 170, 20);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = C.inkFaint;
    const gh = g?.history, th = t?.history;
    ctx.fillText(`t0 → now · ${gh?.n ?? 0}+${th?.n ?? 0} samples`, W - 14, 20);
    ctx.textAlign = 'left';

    if (!g && !t) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = `italic 14px "Hoefler Text", Palatino, serif`;
      ctx.fillText('The polity sleeps — nothing to observe yet.', 14, 48);
      return;
    }

    // ---- geometry ---------------------------------------------------------------
    const left0 = 14, left1 = Math.floor(W * 0.60);
    const railX = left1 + 22, rail1 = W - 14;
    const stripsTop = 34, axisY = H - 22, laneY = axisY - 30;
    const gt = this.F(gh, 't'), tt = this.F(th, 't');
    const t0 = Math.min(gt[0] ?? clockH, tt[0] ?? clockH);
    const t1 = Math.max(gt[gt.length - 1] ?? clockH, tt[tt.length - 1] ?? clockH, t0 + 1);
    const X = (h: number) => left0 + 44 + ((h - t0) / (t1 - t0)) * (left1 - left0 - 44);

    // institutional-era shading spans the whole strip column
    this.stateBands(ctx, this.F(gh, 'state'), gt, X, stripsTop, laneY - 6);

    // ---- the strips ---------------------------------------------------------------
    const pct = (v: number) => (v * 100).toFixed(0) + '%';
    const strips: StripSpec[] = [
      {
        title: 'MOVEMENT · mass (ink) · rival (oxblood)', t: gt, fmt: (v) => v.toFixed(2), min: 0,
        series: [
          { vals: this.F(gh, 'rivalMass'), color: C.accent, width: 1 },
          { vals: this.F(gh, 'mass'), color: C.ink, width: 1.4, fillTo: 0 },
        ],
      },
      {
        title: 'SALIENCE · max Tier-A (ink) · agitation (oxblood)', t: gt, fmt: (v) => v.toFixed(2), min: 0, max: 1,
        series: [
          { vals: this.F(gh, 'agitation'), color: C.accent, width: 1, alpha: 0.8 },
          { vals: this.F(gh, 'salience'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'OPINION · shadow support (ink) · Tier-A (faint) · grievance (oxblood)', t: gt, ref: 0, fmt: (v) => v.toFixed(2),
        series: [
          { vals: this.F(gh, 'shadowGrievance'), color: C.accent, width: 1 },
          { vals: this.F(gh, 'tierSupport'), color: C.inkFaint, width: 1 },
          { vals: this.F(gh, 'shadowSupport'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'LEGITIMACY · (ink) · ballot yes-share (green dash)', t: gt, ref: 0.5, fmt: pct, min: 0, max: 1,
        series: [
          { vals: this.F(gh, 'yesShare'), color: C.good, width: 1, dash: [2, 3] },
          { vals: this.F(gh, 'legitimacy'), color: C.ink, width: 1.4 },
        ],
      },
      {
        title: 'TREASURY · balance (green) · ▼ spend ordered', t: gt, ref: 0, fmt: (v) => '$' + v.toFixed(0),
        series: [{ vals: this.F(gh, 'treasury'), color: C.good, width: 1.2, fillTo: 0 }],
      },
      {
        title: 'TURNOUT · votes cast at the last ballot', t: gt, fmt: (v) => v.toFixed(0), min: 0,
        series: [{ vals: this.F(gh, 'turnout'), color: C.ink, width: 1.2, fillTo: 0 }],
      },
      {
        title: 'TRANSIT · boarded/tick (ink) · aboard (green) · waiting (oxblood)', t: tt, fmt: (v) => v.toFixed(0), min: 0,
        series: [
          { vals: this.F(th, 'waiting'), color: C.accent, width: 1, alpha: 0.8 },
          { vals: this.F(th, 'aboard'), color: C.good, width: 1, fillTo: 0 },
          { vals: this.F(th, 'boarded'), color: C.ink, width: 1.2 },
        ],
      },
      {
        title: 'COMMUTE · cost index (ink) · congestion (oxblood)', t: tt, ref: 1, fmt: (v) => v.toFixed(2), min: 0,
        series: [
          { vals: this.F(th, 'congestion'), color: C.accent, width: 1, alpha: 0.8 },
          { vals: this.F(th, 'commuteCost'), color: C.ink, width: 1.4 },
        ],
      },
    ];

    const gap = 7;
    const nStrips = strips.length + 1;                 // +1 for the modal river
    const stripH = (laneY - 6 - stripsTop - gap * (nStrips - 1)) / nStrips;
    strips.forEach((s, i) => {
      const y0 = stripsTop + i * (stripH + gap);
      this.strip(ctx, s, X, left0, y0, left1, y0 + stripH);
    });
    // spend ticks under the TREASURY strip
    const ty = stripsTop + 4 * (stripH + gap);
    this.spendTicks(ctx, gh, gt, X, ty + stripH);
    // the modal-split river fills the last slot
    const my = stripsTop + strips.length * (stripH + gap);
    this.modeRiver(ctx, th, tt, X, left0, my, left1, my + stripH);

    // ---- event lane + time axis ---------------------------------------------------
    this.eventLane(ctx, gh?.events ?? [], th?.events ?? [], X, laneY, t0, t1);
    this.timeAxis(ctx, X, left0 + 44, left1, axisY, t0, t1);

    // ---- right rail -----------------------------------------------------------------
    let y = 34;
    if (g) {
      y = this.stateLadder(ctx, g, snap, railX, y, rail1);
      y = this.dials(ctx, g, railX, y + 12, rail1);
      y = this.ballotBox(ctx, g, clockH, railX, y + 12, rail1);
      y = this.offices(ctx, g, snap, railX, y + 12, rail1);
      y = this.stances(ctx, g, snap, railX, y + 12, rail1);
    }
    if (t) y = this.transitNow(ctx, t, railX, y + 12, rail1);
    this.recentEvents(ctx, gh?.events ?? [], th?.events ?? [], clockH, railX, y + 16, rail1, H - 16);
  }

  // ---- one strip (own time base) --------------------------------------------------
  private strip(ctx: CanvasRenderingContext2D, s: StripSpec,
    X: (h: number) => number, labelX: number, y0: number, x1: number, y1: number): void {
    const t = s.t;
    // title always (so an empty save still names its instruments)
    ctx.fillStyle = C.inkSoft;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText(s.title, labelX + 44, y0 + 8);
    ctx.strokeStyle = 'rgba(32,24,15,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(labelX + 44, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
    if (t.length < 2) return;

    let lo = Infinity, hi = -Infinity;
    for (const sp of s.series) {
      for (let i = 0; i < sp.vals.length; i++) {
        const v = sp.vals[i];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    if (s.ref !== undefined) { lo = Math.min(lo, s.ref); hi = Math.max(hi, s.ref); }
    if (s.min !== undefined) lo = Math.min(s.min, lo);
    if (s.max !== undefined) hi = Math.max(s.max, hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    const pad = (hi - lo) * 0.1 + 1e-9;
    lo -= pad * 0.4; hi += pad;
    const Y = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0 - 10) - 2;

    if (s.ref !== undefined) {
      ctx.strokeStyle = 'rgba(32,24,15,0.18)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(t[0]), Y(s.ref)); ctx.lineTo(x1, Y(s.ref)); ctx.stroke();
      ctx.setLineDash([]);
    }

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

    const main = s.series[s.series.length - 1];
    const last = main.vals[main.vals.length - 1];
    if (Number.isFinite(last)) {
      ctx.fillStyle = main.color;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'right';
      ctx.fillText(s.fmt(last), labelX + 40, Y(last) + 3);
      ctx.beginPath(); ctx.arc(X(t[t.length - 1]), Y(last), 2, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'left';
    }
  }

  /** era shading from the state ordinal: green while an institution stands
   *  (chartered/elected), oxblood through insolvency/recall/dissolution. */
  private stateBands(ctx: CanvasRenderingContext2D, state: readonly number[], t: readonly number[],
    X: (h: number) => number, y0: number, y1: number): void {
    if (state.length < 2) return;
    const spans: [number, string][] = [];
    void spans;
    let start = -1, kind = '';
    const classify = (v: number) => v >= 5 ? 'fail' : v >= 3 ? 'gov' : '';
    for (let i = 0; i <= state.length; i++) {
      const k = i < state.length ? classify(state[i]) : '';
      if (k !== kind) {
        if (kind && start >= 0) {
          ctx.fillStyle = kind === 'fail' ? C.bandFail : C.bandGov;
          ctx.fillRect(X(t[start]), y0, Math.max(1, X(t[Math.min(i, t.length - 1)]) - X(t[start])), y1 - y0);
        }
        start = i; kind = k;
      }
    }
  }

  private spendTicks(ctx: CanvasRenderingContext2D, gh: GovHistoryView | undefined,
    t: readonly number[], X: (h: number) => number, yBase: number): void {
    const sp = this.F(gh, 'spendOrdered');
    ctx.fillStyle = C.accent;
    for (let i = 0; i < sp.length; i++) {
      if ((sp[i] ?? 0) > 0.5) {
        const x = X(t[i]);
        ctx.beginPath(); ctx.moveTo(x, yBase - 7); ctx.lineTo(x - 2.5, yBase - 1); ctx.lineTo(x + 2.5, yBase - 1); ctx.closePath(); ctx.fill();
      }
    }
  }

  // ---- the modal-split river: stacked shares, walk at the bed, bus on top ---------
  private modeRiver(ctx: CanvasRenderingContext2D, th: TransportHistoryView | undefined,
    t: readonly number[], X: (h: number) => number, labelX: number, y0: number, x1: number, y1: number): void {
    ctx.fillStyle = C.inkSoft;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText('MODE SPLIT · walk · bike · car · taxi · bus (stacked)', labelX + 44, y0 + 8);
    ctx.strokeStyle = 'rgba(32,24,15,0.14)';
    ctx.beginPath(); ctx.moveTo(labelX + 44, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
    if (!th || t.length < 2) return;
    const layers: { f: string; fill: string; label: string }[] = [
      { f: 'shareWalk', fill: 'rgba(32,24,15,0.12)', label: 'walk' },
      { f: 'shareBike', fill: 'rgba(53,94,59,0.22)', label: 'bike' },
      { f: 'shareCar', fill: 'rgba(32,24,15,0.28)', label: 'car' },
      { f: 'shareTaxi', fill: 'rgba(122,31,18,0.30)', label: 'taxi' },
      { f: 'shareBus', fill: 'rgba(53,94,59,0.42)', label: 'bus' },
    ];
    const n = t.length;
    const Y = (v: number) => y1 - Math.max(0, Math.min(1, v)) * (y1 - y0 - 10) - 1;
    const base = new Float64Array(n);
    const top = new Float64Array(n);
    let lastLabelY = Infinity;   // labels stack upward — keep them from colliding
    for (const L of layers) {
      const vals = this.F(th, L.f);
      for (let i = 0; i < n; i++) top[i] = base[i] + (vals[i] ?? 0);
      ctx.fillStyle = L.fill;
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = X(t[i]), y = Y(top[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(t[i]), Y(base[i]));
      ctx.closePath(); ctx.fill();
      // label the band at its final midpoint when it's wide enough to read
      const band = top[n - 1] - base[n - 1];
      const ly = Y((top[n - 1] + base[n - 1]) / 2) + 3;
      if (band > 0.08 && lastLabelY - ly > 9) {
        ctx.fillStyle = C.inkSoft;
        ctx.font = `8px ${MONO}`;
        ctx.textAlign = 'right';
        ctx.fillText(`${L.label} ${(band * 100).toFixed(0)}%`, labelX + 40, ly);
        ctx.textAlign = 'left';
        lastLabelY = ly;
      }
      base.set(top);
    }
  }

  // ---- the event lane: civic glyphs on top, street events beneath ------------------
  private eventLane(ctx: CanvasRenderingContext2D, gov: readonly GovEvent[],
    transit: readonly TransportEvent[], X: (h: number) => number, y: number, t0: number, t1: number): void {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.textAlign = 'left';
    ctx.fillText('events', 14, y + 10);
    for (const ev of gov) {
      if (ev.t < t0 || ev.t > t1) continue;
      this.govGlyph(ctx, ev, X(ev.t), y + 7);
    }
    for (const ev of transit) {
      if (ev.t < t0 || ev.t > t1) continue;
      const x = X(ev.t), cy = y + 19;
      switch (ev.kind) {
        case 'jam':
          ctx.fillStyle = C.accent; ctx.font = `9px ${MONO}`; ctx.textAlign = 'center';
          ctx.fillText('~', x, cy + 3); ctx.textAlign = 'left';
          break;
        case 'strand':
          ctx.strokeStyle = C.accent; ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.moveTo(x - 2.5, cy - 2.5); ctx.lineTo(x + 2.5, cy + 2.5);
          ctx.moveTo(x + 2.5, cy - 2.5); ctx.lineTo(x - 2.5, cy + 2.5);
          ctx.stroke();
          break;
        case 'service':
          ctx.fillStyle = C.good;
          ctx.beginPath(); ctx.arc(x, cy, 2, 0, Math.PI * 2); ctx.fill();
          break;
        default: // replan
          ctx.fillStyle = C.inkFaint;
          ctx.beginPath(); ctx.arc(x, cy, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  private govGlyph(ctx: CanvasRenderingContext2D, ev: GovEvent, x: number, cy: number): void {
    switch (ev.kind) {
      case 'assembly':
        ctx.fillStyle = C.ink;
        ctx.beginPath(); ctx.moveTo(x, cy - 4); ctx.lineTo(x - 3.5, cy + 3); ctx.lineTo(x + 3.5, cy + 3); ctx.closePath(); ctx.fill();
        break;
      case 'charter':
        ctx.fillStyle = C.good;
        ctx.beginPath(); ctx.moveTo(x, cy - 4); ctx.lineTo(x + 3.5, cy); ctx.lineTo(x, cy + 4); ctx.lineTo(x - 3.5, cy); ctx.closePath(); ctx.fill();
        break;
      case 'election':
        ctx.strokeStyle = C.good; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x, cy, 3.2, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = C.good;
        ctx.beginPath(); ctx.arc(x, cy, 1.2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'recall': case 'dissolve':
        ctx.strokeStyle = C.accent; ctx.lineWidth = ev.kind === 'dissolve' ? 1.8 : 1.3;
        ctx.beginPath();
        ctx.moveTo(x - 3, cy - 3); ctx.lineTo(x + 3, cy + 3);
        ctx.moveTo(x + 3, cy - 3); ctx.lineTo(x - 3, cy + 3);
        ctx.stroke();
        break;
      case 'insolvent':
        ctx.fillStyle = C.accent; ctx.font = `bold 10px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText('!', x, cy + 3); ctx.textAlign = 'left';
        break;
      case 'recover':
        ctx.fillStyle = C.good; ctx.font = `10px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText('+', x, cy + 3); ctx.textAlign = 'left';
        break;
      case 'levy':
        ctx.fillStyle = C.inkSoft; ctx.font = `9px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText('$', x, cy + 3); ctx.textAlign = 'left';
        break;
      case 'spend':
        ctx.fillStyle = C.inkSoft;
        ctx.beginPath(); ctx.moveTo(x, cy + 3); ctx.lineTo(x - 2.5, cy - 2.5); ctx.lineTo(x + 2.5, cy - 2.5); ctx.closePath(); ctx.fill();
        break;
      case 'rival':
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, cy - 3.5); ctx.lineTo(x + 3, cy); ctx.lineTo(x, cy + 3.5); ctx.lineTo(x - 3, cy); ctx.closePath(); ctx.stroke();
        break;
      case 'quorum-fail': case 'charter-fail': case 'election-fail': case 'recall-fail':
        ctx.strokeStyle = C.inkFaint; ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(x - 2.5, cy - 2.5); ctx.lineTo(x + 2.5, cy + 2.5);
        ctx.moveTo(x + 2.5, cy - 2.5); ctx.lineTo(x - 2.5, cy + 2.5);
        ctx.stroke();
        break;
      default: // stir · wane · petition · hire
        ctx.fillStyle = C.inkFaint;
        ctx.beginPath(); ctx.arc(x, cy, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  private timeAxis(ctx: CanvasRenderingContext2D, X: (h: number) => number,
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

  // ===========================================================================
  // the right rail — NOW
  // ===========================================================================
  private stateLadder(ctx: CanvasRenderingContext2D, g: GovView, snap: TownSnapshot,
    x0: number, y0: number, x1: number): number {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('INSTITUTION', x0, y0 + 8);
    const y = y0 + 28;
    const w = (x1 - x0 - 20) / STATE_LINE.length;
    const onFail = STATE_FAIL.includes(g.state);
    // the mainline, connected
    ctx.strokeStyle = 'rgba(32,24,15,0.25)';
    ctx.beginPath(); ctx.moveTo(x0 + w / 2, y); ctx.lineTo(x0 + w / 2 + w * (STATE_LINE.length - 1), y); ctx.stroke();
    ctx.textAlign = 'center';
    STATE_LINE.forEach((s, i) => {
      const cx = x0 + w / 2 + i * w;
      const here = g.state === s;
      ctx.fillStyle = here ? C.ink : C.paper;
      ctx.strokeStyle = C.ink; ctx.lineWidth = here ? 1.6 : 1;
      ctx.beginPath(); ctx.arc(cx, y, here ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = here ? C.ink : C.inkSoft;
      ctx.font = here ? `bold 8px ${MONO}` : `8px ${MONO}`;
      ctx.fillText(s.replace('assembly-called', 'assembly'), cx, y + 15);
    });
    // failure siding, only lit when we're on it
    if (onFail) {
      ctx.fillStyle = C.accent;
      ctx.font = `bold 9px ${MONO}`;
      ctx.fillText(`— ${g.state.toUpperCase()} —`, (x0 + x1) / 2, y + 30);
    }
    ctx.textAlign = 'left';
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkSoft;
    // topics = what people can argue about; hotCivic = venues under live watch
    const hot = g.topics.map((s) => s.replace('civic:', '')).join(' · ');
    const watched = g.hotCivic.join(' · ');
    ctx.fillText(`hot topics: ${hot || 'none'}${watched ? ` · watching ${watched}` : ''}`, x0, y + (onFail ? 44 : 30));
    return y + (onFail ? 50 : 36);
  }

  private dials(ctx: CanvasRenderingContext2D, g: GovView, x0: number, y0: number, x1: number): number {
    const r = 24, cy = y0 + r + 12;
    const cx1 = x0 + (x1 - x0) * 0.22, cx2 = x0 + (x1 - x0) * 0.62;
    this.dial(ctx, cx1, cy, r, Math.max(0, Math.min(1, g.legitimacy)),
      (g.legitimacy * 100).toFixed(0) + '%', 'LEGITIMACY',
      g.legitimacy < 0.3 ? C.accent : g.legitimacy > 0.6 ? C.good : C.ink);
    // treasury dial: share of everything ever credited still held — a runway
    // gauge, not a balance chart (the strip already shows the level).
    const kept = g.treasury.credited > 1 ? g.treasury.balance / g.treasury.credited : 0;
    this.dial(ctx, cx2, cy, r, Math.max(0, Math.min(1, kept)),
      '$' + g.treasury.balance.toFixed(0), 'TREASURY',
      g.treasury.insolvent ? C.accent : C.ink);
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = g.treasury.insolvent ? C.accent : C.inkSoft;
    ctx.fillText(
      (g.treasury.insolvent ? 'INSOLVENT · ' : '') +
      `in $${g.treasury.credited.toFixed(0)} · out $${g.treasury.debited.toFixed(0)}` +
      ` · levy ${(g.levies.payroll * 100).toFixed(1)}%pay ${(g.levies.sales * 100).toFixed(1)}%sales`,
      x0, cy + r + 24);
    return cy + r + 28;
  }

  private dial(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
    frac: number, value: string, label: string, color: string): void {
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.strokeStyle = 'rgba(32,24,15,0.16)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = C.ink;
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(value, cx, cy + 3);
    ctx.fillStyle = C.inkFaint;
    ctx.font = `8px ${MONO}`;
    ctx.fillText(label, cx, cy + r + 10);
    ctx.textAlign = 'left';
  }

  private ballotBox(ctx: CanvasRenderingContext2D, g: GovView, clockH: number,
    x0: number, y0: number, x1: number): number {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('BALLOT', x0, y0 + 8);
    let y = y0 + 22;
    const b = g.ballot ?? g.lastBallot;
    if (!b) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = `italic 11px "Hoefler Text", Palatino, serif`;
      ctx.fillText('no ballot has ever opened', x0, y);
      return y + 6;
    }
    const open = g.ballot !== null;
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = C.ink;
    const head = open
      ? `${b.kind.toUpperCase()} · ${b.topic.replace('civic:', '')} · closes in ${Math.max(0, b.closesH - clockH).toFixed(0)}h`
      : `${b.kind.toUpperCase()} · ${b.topic.replace('civic:', '')} — ${b.passed ? 'PASSED' : 'FAILED'}`;
    ctx.fillText(head, x0, y);
    y += 14;
    // yes/no bar over the eligible base
    const bw = x1 - x0 - 60, cast = b.yes + b.no;
    const denom = Math.max(1, b.eligible);
    ctx.strokeStyle = 'rgba(32,24,15,0.25)';
    ctx.strokeRect(x0, y - 8, bw, 8);
    ctx.fillStyle = C.good;
    ctx.fillRect(x0, y - 8, bw * (b.yes / denom), 8);
    ctx.fillStyle = C.accent;
    ctx.fillRect(x0 + bw * (b.yes / denom), y - 8, bw * (b.no / denom), 8);
    ctx.fillStyle = C.inkSoft;
    ctx.font = `9px ${MONO}`;
    ctx.fillText(`${cast}/${b.eligible}`, x0 + bw + 6, y - 1);
    y += 12;
    ctx.fillText(
      `yes ${b.yes} · no ${b.no} · turnout ${(100 * cast / denom).toFixed(0)}%` +
      ` (tier-A ${b.tierACast} · shadow ${b.shadowCast})`, x0, y);
    return y + 4;
  }

  private holderName(snap: TownSnapshot, h: OfficeHolder): string {
    return h.kind === 'roster' ? this.nameOf(snap, h.id) : `citizen s${h.profileSeed % 997}`;
  }

  private offices(ctx: CanvasRenderingContext2D, g: GovView, snap: TownSnapshot,
    x0: number, y0: number, x1: number): number {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('OFFICES & POLICY', x0, y0 + 8);
    let y = y0 + 22;
    ctx.font = `10px ${MONO}`;
    if (!g.officials.length) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = `italic 11px "Hoefler Text", Palatino, serif`;
      ctx.fillText('no offices are seated', x0, y);
      y += 14;
    }
    for (const o of g.officials) {
      ctx.fillStyle = C.ink;
      ctx.font = `10px ${MONO}`;
      ctx.fillText(`${o.office.padEnd(8)} ${this.holderName(snap, o.holder)}`, x0, y);
      ctx.fillStyle = C.inkFaint;
      ctx.textAlign = 'right';
      ctx.fillText(`seated d${Math.floor(o.seatedAtH / 24)}`, x1, y);
      ctx.textAlign = 'left';
      y += 13;
    }
    // policy budget lines
    for (const p of g.policy) {
      const bw = Math.min(90, x1 - x0 - 150);
      ctx.fillStyle = C.inkSoft;
      ctx.fillText(p.kind.padEnd(16), x0, y);
      ctx.strokeStyle = 'rgba(32,24,15,0.2)';
      ctx.strokeRect(x0 + 120, y - 7, bw, 6);
      ctx.fillStyle = C.good;
      ctx.fillRect(x0 + 120, y - 7, bw * Math.max(0, Math.min(1, p.share)), 6);
      ctx.fillStyle = C.inkFaint;
      ctx.fillText((p.share * 100).toFixed(0) + '%', x0 + 126 + bw, y);
      y += 13;
    }
    return y - 4;
  }

  private stances(ctx: CanvasRenderingContext2D, g: GovView, snap: TownSnapshot,
    x0: number, y0: number, x1: number): number {
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('TIER-A STANCES · salience bar · support ◆', x0, y0 + 8);
    let y = y0 + 21;
    // salient first; everyone with any engagement shows
    const rows = g.tierA.filter((r) => r.salience > 0.02).sort((a, b) => b.salience - a.salience).slice(0, 7);
    if (!rows.length) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = `italic 11px "Hoefler Text", Palatino, serif`;
      ctx.fillText('nobody carries the civic spark yet', x0, y);
      return y + 6;
    }
    const bw = Math.min(80, x1 - x0 - 190);
    const mid = x0 + 118 + bw + 34;
    for (const r of rows) {
      ctx.fillStyle = C.ink;
      ctx.font = `10px ${MONO}`;
      ctx.fillText(this.nameOf(snap, r.id).slice(0, 14), x0, y);
      ctx.strokeStyle = 'rgba(32,24,15,0.2)';
      ctx.strokeRect(x0 + 118, y - 7, bw, 6);
      ctx.fillStyle = C.inkSoft;
      ctx.fillRect(x0 + 118, y - 7, bw * Math.max(0, Math.min(1, r.salience)), 6);
      // support diamond on a −1..+1 axis
      ctx.strokeStyle = 'rgba(32,24,15,0.2)';
      ctx.beginPath(); ctx.moveTo(mid - 26, y - 4); ctx.lineTo(mid + 26, y - 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(mid, y - 8); ctx.lineTo(mid, y); ctx.stroke();
      const sx = mid + 26 * Math.max(-1, Math.min(1, r.support));
      ctx.fillStyle = r.support >= 0 ? C.good : C.accent;
      ctx.beginPath();
      ctx.moveTo(sx, y - 8); ctx.lineTo(sx + 3, y - 4); ctx.lineTo(sx, y); ctx.lineTo(sx - 3, y - 4);
      ctx.closePath(); ctx.fill();
      y += 13;
    }
    return y - 4;
  }

  private transitNow(ctx: CanvasRenderingContext2D, t: TransportView,
    x0: number, y0: number, x1: number): number {
    void x1;
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('TRANSIT NOW', x0, y0 + 8);
    let y = y0 + 22;
    const k = t.kpis;
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = C.inkSoft;
    ctx.fillText(
      `${t.routes.length} routes · aboard ${k.aboard.toFixed(0)} · waiting ${k.waiting.toFixed(0)}` +
      ` · trips ${k.tripsArrived.toFixed(0)}/${k.tripsStarted.toFixed(0)}`, x0, y);
    y += 13;
    const ms = k.modeShare;
    const share = (id: ModeId) => `${id} ${(100 * (ms[id] ?? 0)).toFixed(0)}%`;
    ctx.fillText(
      `${share('walk')} · ${share('bus')} · ${share('taxi')} · ${share('car')} · ${share('bike')}`, x0, y);
    y += 13;
    ctx.fillStyle = k.congestion > 1.3 ? C.accent : C.inkSoft;
    ctx.fillText(
      `congestion ×${k.congestion.toFixed(2)} · commute idx ${k.commuteCostIndex.toFixed(2)}` +
      ` · taxi util ${(k.taxiUtil * 100).toFixed(0)}% wait ${(k.taxiWaitH * 60).toFixed(0)}m`, x0, y);
    return y + 2;
  }

  private recentEvents(ctx: CanvasRenderingContext2D, gov: readonly GovEvent[],
    transit: readonly TransportEvent[], clock: number, x0: number, y0: number, x1: number, y1: number): void {
    void x1;
    if (y0 > y1 - 20) return;
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = C.inkFaint;
    ctx.fillText('RECENT', x0, y0);
    ctx.font = `10px ${MONO}`;
    const lines = Math.max(1, Math.floor((y1 - y0 - 8) / 13));
    // merge the two streams, newest first — civic drama and street drama interleave
    const merged: { t: number; kind: string; label: string; civic: boolean }[] = [];
    for (const e of gov) merged.push({ t: e.t, kind: e.kind, label: e.label, civic: true });
    for (const e of transit) merged.push({ t: e.t, kind: e.kind, label: e.label, civic: false });
    merged.sort((a, b) => b.t - a.t);
    let y = y0 + 14;
    if (!merged.length) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = `italic 11px "Hoefler Text", Palatino, serif`;
      ctx.fillText('nothing notable has happened yet', x0, y);
      return;
    }
    for (const ev of merged.slice(0, lines)) {
      const age = Math.max(0, clock - ev.t);
      const when = age < 24 ? `${age.toFixed(0)}h ago` : `d${Math.floor(ev.t / 24)}`;
      ctx.fillStyle =
        ev.kind === 'charter' || ev.kind === 'election' || ev.kind === 'recover' || ev.kind === 'service' ? C.good :
        ev.kind === 'recall' || ev.kind === 'dissolve' || ev.kind === 'insolvent' || ev.kind === 'jam' || ev.kind === 'strand' ? C.accent :
        ev.civic ? C.inkSoft : C.inkFaint;
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
