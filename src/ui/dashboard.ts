// =============================================================================
// ExposomeSim — the instrument readout panels.
// -----------------------------------------------------------------------------
// A real-time neuropsychological dashboard rendered with the canvas 2D API in
// the house style: a scientific instrument drawn in ink on aged sepia paper.
// Black meshlike line-work, tabular figures, restraint. No textures, no
// gradients, no shadows. Oxblood only for alarm/peaks; deep green for reward.
//
// Public surface (consumed by the sim loop):
//   const dash = new Dashboard(rootAside);
//   dash.update(snapshot);   // called every animation frame
//
// Reads only from `snap.cashier`. Never throws on missing fields.
// =============================================================================

import type { WorldSnapshot } from '../core/types';

// ---------------------------------------------------------------------------
// palette + fonts — resolved from style.css custom properties, with the
// canonical hex/rgba fallbacks baked in so the panel renders even if the
// stylesheet has not applied yet.
// ---------------------------------------------------------------------------
interface Palette {
  paper: string;
  paperDeep: string;
  ink: string;
  inkSoft: string;
  inkFaint: string;
  line: string;
  lineFaint: string;
  accent: string; // oxblood — alarm / peaks
  good: string;   // deep green — contentment / reward
}

function readPalette(root: HTMLElement): Palette {
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(root);
  } catch {
    cs = null;
  }
  const v = (name: string, fallback: string): string => {
    if (!cs) return fallback;
    const raw = cs.getPropertyValue(name);
    const trimmed = raw ? raw.trim() : '';
    return trimmed || fallback;
  };
  return {
    paper: v('--paper', '#e9dec4'),
    paperDeep: v('--paper-deep', '#ded2b4'),
    ink: v('--ink', '#20180f'),
    inkSoft: v('--ink-soft', '#5b4d38'),
    inkFaint: v('--ink-faint', '#9b8a68'),
    line: v('--line', 'rgba(32, 24, 15, 0.78)'),
    lineFaint: v('--line-faint', 'rgba(32, 24, 15, 0.16)'),
    accent: v('--accent', '#7a1f12'),
    good: v('--good', '#355e3b'),
  };
}

function readFont(root: HTMLElement, name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    return raw || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// small numeric / color helpers (kept local — dashboard.ts is self-contained)
// ---------------------------------------------------------------------------
const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** coerce anything to a finite number, else the fallback. never throws. */
function num(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/** "1.12" / "0.43" — two decimals, for normalized tone & activation. */
function f2(x: number): string {
  return num(x).toFixed(2);
}

/** general scalar — keep a couple sig figs without runaway width. */
function fScalar(x: number): string {
  const a = Math.abs(num(x));
  if (a >= 1000) return num(x).toFixed(0);
  if (a >= 10) return num(x).toFixed(1);
  return num(x).toFixed(2);
}

/** minutes integral — compact. */
function fMin(x: number): string {
  const a = Math.abs(num(x));
  return a >= 10 ? num(x).toFixed(0) : num(x).toFixed(1);
}

/** parse #rrggbb or rgb()/rgba() to a fresh rgba string at alpha `a`. */
function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c[0] === '#') {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((h) => h + h).join('');
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n)) return `rgba(32,24,15,${a})`;
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    const [r, g, b] = parts;
    return `rgba(${r || 0},${g || 0},${b || 0},${a})`;
  }
  return `rgba(32,24,15,${a})`;
}

// ---------------------------------------------------------------------------
// CanvasPanel — a <canvas> with a HiDPI-correct 2D context. The backing store
// is (re)sized to clientWidth × cssHeight × devicePixelRatio only when those
// change; begin() returns a context already transformed into CSS-pixel space
// with the surface cleared. Returns null when the panel has no layout width.
// ---------------------------------------------------------------------------
interface Surface {
  ctx: CanvasRenderingContext2D;
  w: number; // css px
  h: number; // css px
}

class CanvasPanel {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly cssH: number;

  constructor(parent: HTMLElement, cssHeight: number) {
    this.cssH = cssHeight;
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = `${cssHeight}px`;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
  }

  begin(): Surface | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const cssW = this.canvas.clientWidth;
    if (!cssW || cssW <= 0) return null;
    const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    const needW = Math.round(cssW * dpr);
    const needH = Math.round(this.cssH * dpr);
    if (this.canvas.width !== needW || this.canvas.height !== needH) {
      this.canvas.width = needW;
      this.canvas.height = needH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, this.cssH);
    ctx.textBaseline = 'middle';
    return { ctx, w: cssW, h: this.cssH };
  }
}

// crisp 1px rules (snap to half-pixel)
function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const px = Math.round(x) + 0.5;
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
}
function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  const py = Math.round(y) + 0.5;
  ctx.beginPath();
  ctx.moveTo(x0, py);
  ctx.lineTo(x1, py);
  ctx.stroke();
}
function frame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
}

// ---------------------------------------------------------------------------
// canvas heights (css px) — tuned for the ~360px scrolling column
// ---------------------------------------------------------------------------
const H_INTENSITY = 16;
const H_AFFECT = 172;
const H_NEURO = 124;
const H_LIMBIC = 106;
const H_MINUTES = 92;
const H_LOADBAR = 12;
const H_SERIES = 138;

const SAMPLE_MS = 100;   // ring-buffer cadence (wall clock)
const SERIES_CAP = 600;  // ~60 s of history
const TRAIL_LEN = 80;    // recent core-affect points drawn as a fading trail

// neurochemistry channels (normalized tone, baseline 1.0, ~[0,2])
const NEURO_KEYS = [
  ['cortisol', 'cortisol'],
  ['da_meso', 'da_meso'],
  ['serotonin', 'serotonin'],
  ['norepinephrine', 'norepineph'],
  ['gaba', 'gaba'],
  ['oxytocin', 'oxytocin'],
  ['melatonin', 'melatonin'],
] as const;

// limbic / cortical activation nodes (∈ [0,1])
const LIMBIC_KEYS = [
  ['amygdala', 'amygdala'],
  ['vmPFC', 'vmPFC'],
  ['dlPFC', 'dlPFC'],
  ['nacc', 'nacc'],
  ['insula', 'insula'],
  ['hypothalamus', 'hypothal'],
] as const;

// =============================================================================
// Dashboard
// =============================================================================
export class Dashboard {
  private readonly pal: Palette;
  private readonly mono: string;
  private readonly serif: string;

  // DOM text nodes (updated only when their content changes)
  private readonly emotionEl: HTMLDivElement;
  private readonly stressVal: HTMLElement;
  private readonly rewardVal: HTMLElement;
  private readonly loadNum: HTMLDivElement;
  private readonly monologueEl: HTMLDivElement;
  private readonly regulationVal: HTMLElement;

  // canvas panels
  private readonly intensityC: CanvasPanel;
  private readonly affectC: CanvasPanel;
  private readonly neuroC: CanvasPanel;
  private readonly limbicC: CanvasPanel;
  private readonly minutesC: CanvasPanel;
  private readonly loadBarC: CanvasPanel;
  private readonly seriesC: CanvasPanel;

  // internal ring buffers (persist across update() calls)
  private readonly sValence: number[] = [];
  private readonly sArousal: number[] = [];
  private readonly sCortisol: number[] = [];
  private lastSample = 0;

  // cache for guarded DOM writes
  private cLabel = '';
  private cStress = '';
  private cReward = '';
  private cLoad = '';
  private cMono = '';
  private cReg = '';

  constructor(root: HTMLElement) {
    this.pal = readPalette(root);
    this.mono = readFont(
      root,
      '--mono',
      '"SFMono-Regular", ui-monospace, Menlo, monospace',
    );
    this.serif = readFont(
      root,
      '--serif',
      '"Hoefler Text", "Iowan Old Style", Palatino, "Times New Roman", serif',
    );

    // --- 1. CONSTRUCTED EMOTION -------------------------------------------
    const p1 = this.panel(root, 'Constructed Emotion');
    this.emotionEl = document.createElement('div');
    this.emotionEl.className = 'readout-emotion';
    this.emotionEl.textContent = '—';
    p1.appendChild(this.emotionEl);
    this.intensityC = new CanvasPanel(p1, H_INTENSITY);

    // --- 2. CORE AFFECT ----------------------------------------------------
    const p2 = this.panel(root, 'Core Affect');
    this.affectC = new CanvasPanel(p2, H_AFFECT);

    // --- 3. NEUROCHEMISTRY -------------------------------------------------
    const p3 = this.panel(root, 'Neurochemistry');
    this.neuroC = new CanvasPanel(p3, H_NEURO);

    // --- 4. LIMBIC ---------------------------------------------------------
    const p4 = this.panel(root, 'Limbic');
    this.limbicC = new CanvasPanel(p4, H_LIMBIC);

    // --- 5. EXPOSOME INTEGRALS --------------------------------------------
    const p5 = this.panel(root, 'Exposome Integrals');
    this.minutesC = new CanvasPanel(p5, H_MINUTES);
    this.stressVal = this.kv(p5, 'cumulative stress');
    this.rewardVal = this.kv(p5, 'cumulative reward');

    const loadWrap = document.createElement('div');
    loadWrap.style.marginTop = '10px';
    loadWrap.style.borderTop = `1px solid ${this.pal.lineFaint}`;
    loadWrap.style.paddingTop = '8px';
    const loadLabel = document.createElement('div');
    loadLabel.textContent = 'ALLOSTATIC LOAD';
    loadLabel.style.fontSize = '10px';
    loadLabel.style.fontWeight = '600';
    loadLabel.style.letterSpacing = '0.28em';
    loadLabel.style.color = this.pal.inkSoft;
    this.loadNum = document.createElement('div');
    this.loadNum.textContent = '0.00';
    this.loadNum.style.fontFamily = this.mono;
    this.loadNum.style.fontSize = '22px';
    this.loadNum.style.fontWeight = '600';
    this.loadNum.style.lineHeight = '1.15';
    this.loadNum.style.color = this.pal.ink;
    this.loadNum.style.fontVariantNumeric = 'tabular-nums';
    loadWrap.appendChild(loadLabel);
    loadWrap.appendChild(this.loadNum);
    p5.appendChild(loadWrap);
    this.loadBarC = new CanvasPanel(loadWrap, H_LOADBAR);

    // --- 6. TIME SERIES ----------------------------------------------------
    const p6 = this.panel(root, 'Time Series');
    this.seriesC = new CanvasPanel(p6, H_SERIES);

    // --- 7. INNER STATE ----------------------------------------------------
    const p7 = this.panel(root, 'Inner State');
    this.monologueEl = document.createElement('div');
    this.monologueEl.style.fontFamily = this.serif;
    this.monologueEl.style.fontStyle = 'italic';
    this.monologueEl.style.fontSize = '14px';
    this.monologueEl.style.lineHeight = '1.5';
    this.monologueEl.style.color = this.pal.ink;
    this.monologueEl.style.marginBottom = '8px';
    this.monologueEl.textContent = '— no inner speech —';
    p7.appendChild(this.monologueEl);
    this.regulationVal = this.kv(p7, 'regulation');
  }

  // ----- DOM scaffolding helpers ------------------------------------------
  private panel(root: HTMLElement, title: string): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h2 = document.createElement('h2');
    h2.textContent = title;
    panel.appendChild(h2);
    root.appendChild(panel);
    return panel;
  }

  private kv(parent: HTMLElement, label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'kv';
    const k = document.createElement('span');
    k.textContent = label;
    const b = document.createElement('b');
    b.textContent = '—';
    b.style.fontVariantNumeric = 'tabular-nums';
    row.appendChild(k);
    row.appendChild(b);
    parent.appendChild(row);
    return b;
  }

  private setText(el: { textContent: string | null }, next: string, cacheKey: string): void {
    // guarded write: avoid touching the DOM (and clobbering selection) when unchanged
    if ((this as any)[cacheKey] === next) return;
    (this as any)[cacheKey] = next;
    el.textContent = next;
  }

  // =========================================================================
  // update — called every frame
  // =========================================================================
  update(snap: WorldSnapshot): void {
    try {
      // follow the camera's focused agent (falls back to Mara / the cashier).
      const anyS = snap as unknown as { agents?: unknown[]; focus?: number };
      const focusAgent = anyS.agents?.[anyS.focus ?? 0] as WorldSnapshot['cashier'] | undefined;
      const cashier = focusAgent ?? (snap && snap.cashier ? snap.cashier : undefined);
      const soma = cashier ? (cashier.soma as any) : undefined;
      const readout = cashier ? cashier.readout : undefined;
      const integrals = cashier ? cashier.integrals : undefined;
      const last = cashier ? cashier.lastResponse : undefined;

      const valence = clamp(num(soma?.valence, num(readout?.valence)), -1, 1);
      const arousal = clamp(num(soma?.arousal, num(readout?.arousal)), 0, 1);
      const dominance = clamp(num(soma?.dominance, num(readout?.dominance)), -1, 1);
      const cortisol = num(soma?.cortisol, 1);

      // ---- ring-buffer sampling (throttled to wall clock) ----
      const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (t - this.lastSample >= SAMPLE_MS) {
        this.lastSample = t;
        push(this.sValence, valence);
        push(this.sArousal, arousal);
        push(this.sCortisol, cortisol);
      }

      // ---- DOM readouts (guarded) ----
      this.setText(this.emotionEl, readout?.label ? String(readout.label) : '—', 'cLabel');
      this.setText(this.stressVal, fScalar(num(integrals?.cumulativeStress)), 'cStress');
      this.setText(this.rewardVal, fScalar(num(integrals?.cumulativeReward)), 'cReward');

      const load = num(integrals?.allostaticLoad, num(soma?.allostaticLoad));
      this.setText(this.loadNum, fScalar(load), 'cLoad');
      this.loadNum.style.color = load > 4 ? this.pal.accent : this.pal.ink;

      const mono = last?.innerMonologue ? String(last.innerMonologue).trim() : '';
      this.setText(this.monologueEl, mono ? `“${mono}”` : '— no inner speech —', 'cMono');
      this.monologueEl.style.color = mono ? this.pal.ink : this.pal.inkFaint;

      const reg = last?.regulation ? String(last.regulation) : '';
      this.setText(this.regulationVal, reg && reg !== 'none' ? reg : '—', 'cReg');

      // ---- canvas panels ----
      this.drawIntensity(num(readout?.intensity));
      this.drawAffect(valence, arousal, dominance);
      this.drawNeuro(soma);
      this.drawLimbic(soma);
      this.drawMinutes(integrals);
      this.drawLoadBar(load);
      this.drawSeries();
    } catch {
      // The dashboard must never throw into the render loop.
    }
  }

  // ----- 1. intensity bar --------------------------------------------------
  private drawIntensity(intensity: number): void {
    const s = this.intensityC.begin();
    if (!s) return;
    const { ctx, w, h } = s;
    const i = clamp(intensity, 0, 1);
    const valW = 30;
    const trackW = w - valW - 4;
    const y = Math.round(h / 2);
    const barH = 6;

    ctx.strokeStyle = this.pal.lineFaint;
    ctx.lineWidth = 1;
    frame(ctx, 0, y - barH / 2, trackW, barH);

    ctx.fillStyle = this.pal.ink;
    ctx.fillRect(0, y - barH / 2 + 1, Math.max(0, (trackW - 1) * i), barH - 2);

    ctx.fillStyle = this.pal.inkSoft;
    ctx.font = `9px ${this.mono}`;
    ctx.textAlign = 'right';
    ctx.fillText(f2(i), w, y);
    ctx.textAlign = 'left';
  }

  // ----- 2. core affect plane ---------------------------------------------
  private drawAffect(valence: number, arousal: number, dominance: number): void {
    const s = this.affectC.begin();
    if (!s) return;
    const { ctx, w, h } = s;
    const padL = 20;
    const padR = 8;
    const padT = 8;
    const padB = 16;
    const x0 = padL;
    const x1 = w - padR;
    const y0 = padT;
    const y1 = h - padB;
    const pw = x1 - x0;
    const ph = y1 - y0;

    const vx = (v: number) => x0 + ((clamp(v, -1, 1) + 1) / 2) * pw;
    const vy = (a: number) => y1 - clamp(a, 0, 1) * ph;

    // frame + central cross gridlines
    ctx.strokeStyle = this.pal.lineFaint;
    ctx.lineWidth = 1;
    vline(ctx, vx(0), y0, y1);          // valence = 0
    hline(ctx, x0, x1, vy(0.5));        // arousal = 0.5
    ctx.strokeStyle = this.pal.line;
    frame(ctx, x0, y0, pw, ph);

    // axis ticks / labels
    ctx.fillStyle = this.pal.inkFaint;
    ctx.font = `8px ${this.mono}`;
    ctx.textAlign = 'center';
    ctx.fillText('-1', x0, y1 + 8);
    ctx.fillText('0', vx(0), y1 + 8);
    ctx.fillText('+1', x1, y1 + 8);
    ctx.fillText('valence', vx(0), h - 4);
    ctx.textAlign = 'right';
    ctx.fillText('1', x0 - 3, y0 + 4);
    ctx.fillText('0', x0 - 3, y1 - 4);
    ctx.save();
    ctx.translate(7, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('arousal', 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';

    // fading trail (older → fainter), drawn from the sampled ring buffers
    const n = this.sValence.length;
    const start = Math.max(0, n - TRAIL_LEN);
    ctx.lineWidth = 1;
    for (let i = start + 1; i < n; i++) {
      const age = (i - start) / Math.max(1, n - start); // 0..1, newer larger
      ctx.strokeStyle = withAlpha(this.pal.ink, 0.05 + age * 0.4);
      ctx.beginPath();
      ctx.moveTo(vx(this.sValence[i - 1]), vy(this.sArousal[i - 1]));
      ctx.lineTo(vx(this.sValence[i]), vy(this.sArousal[i]));
      ctx.stroke();
    }

    // current point — colored by affective quadrant
    let dotColor = this.pal.ink;
    if (valence < -0.25 && arousal > 0.55) dotColor = this.pal.accent; // distress peak
    else if (valence > 0.35) dotColor = this.pal.good;                 // contentment / reward
    const cx = vx(valence);
    const cy = vy(arousal);

    // dominance needle — a gauge pointer rotating with dominance ([-1,1] → ±60°)
    const ang = -Math.PI / 2 + dominance * (Math.PI / 3);
    const nlen = 9 + Math.abs(dominance) * 14;
    ctx.strokeStyle = dotColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * nlen, cy + Math.sin(ang) * nlen);
    ctx.stroke();

    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ----- shared bar-row renderer ------------------------------------------
  // bipolar: deviations from `baseline` over [min,max] (neurochemistry).
  // unipolar: fill from left over [0,max] (limbic activations).
  private drawBarRows(
    s: Surface,
    rows: { label: string; value: number; color: string; fmt: string }[],
    opts: { bipolar: boolean; min: number; max: number; baseline: number; gutter: number; valW: number },
  ): void {
    const { ctx, w, h } = s;
    const { gutter, valW } = opts;
    const trackX = gutter;
    const trackW = w - gutter - valW;
    if (trackW <= 4) return;
    const rowH = h / rows.length;
    const barH = 5;

    ctx.font = `9px ${this.mono}`;

    if (opts.bipolar) {
      // continuous faint baseline rule down the chart
      ctx.strokeStyle = this.pal.lineFaint;
      ctx.lineWidth = 1;
      const cx = trackX + trackW / 2;
      vline(ctx, cx, 2, h - 2);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const yc = i * rowH + rowH / 2;

      // label
      ctx.fillStyle = this.pal.inkSoft;
      ctx.textAlign = 'right';
      ctx.fillText(row.label, gutter - 6, yc);

      // faint track rule
      ctx.strokeStyle = this.pal.lineFaint;
      ctx.lineWidth = 1;
      hline(ctx, trackX, trackX + trackW, yc);

      if (opts.bipolar) {
        const cx = trackX + trackW / 2;
        const span = (opts.max - opts.baseline) || 1;
        const off = (clamp(row.value, opts.min, opts.max) - opts.baseline) / span; // -1..1
        const px = clamp(off, -1, 1) * (trackW / 2);
        ctx.fillStyle = row.color;
        const bx = Math.min(cx, cx + px);
        ctx.fillRect(bx, yc - barH / 2, Math.abs(px), barH);
        // baseline tick at this row
        ctx.strokeStyle = this.pal.line;
        ctx.lineWidth = 1;
        vline(ctx, cx, yc - barH, yc + barH);
      } else {
        const frac = clamp((row.value - opts.min) / ((opts.max - opts.min) || 1), 0, 1);
        ctx.fillStyle = row.color;
        ctx.fillRect(trackX, yc - barH / 2, trackW * frac, barH);
      }

      // value
      ctx.fillStyle = this.pal.inkSoft;
      ctx.textAlign = 'right';
      ctx.fillText(row.fmt, w, yc);
    }
    ctx.textAlign = 'left';
  }

  // ----- 3. neurochemistry -------------------------------------------------
  private drawNeuro(soma: any): void {
    const s = this.neuroC.begin();
    if (!s) return;
    const rows = NEURO_KEYS.map(([key, label]) => {
      const value = num(soma?.[key], 1);
      let color = this.pal.ink;
      if (key === 'cortisol' && value > 1.25) color = this.pal.accent; // stress alarm
      else if (key === 'da_meso' && value > 1.05) color = this.pal.good; // reward signal
      return { label, value, color, fmt: f2(value) };
    });
    this.drawBarRows(s, rows, {
      bipolar: true,
      min: 0,
      max: 2,
      baseline: 1,
      gutter: 62,
      valW: 28,
    });
  }

  // ----- 4. limbic ---------------------------------------------------------
  private drawLimbic(soma: any): void {
    const s = this.limbicC.begin();
    if (!s) return;
    const rows = LIMBIC_KEYS.map(([key, label]) => {
      const value = clamp(num(soma?.[key]), 0, 1);
      let color = this.pal.ink;
      if (key === 'amygdala' && value > 0.6) color = this.pal.accent; // threat
      else if (key === 'nacc' && value > 0.55) color = this.pal.good; // approach/reward
      return { label, value, color, fmt: f2(value) };
    });
    this.drawBarRows(s, rows, {
      bipolar: false,
      min: 0,
      max: 1,
      baseline: 0,
      gutter: 56,
      valW: 28,
    });
  }

  // ----- 5. exposome integrals — minutes small-multiples -------------------
  private drawMinutes(integrals: any): void {
    const s = this.minutesC.begin();
    if (!s) return;
    const items: { label: string; value: number; color: string }[] = [
      { label: 'anxious', value: num(integrals?.minutesAnxious), color: this.pal.accent },
      { label: 'depressed', value: num(integrals?.minutesDepressed), color: this.pal.inkSoft },
      { label: 'content', value: num(integrals?.minutesContent), color: this.pal.good },
      { label: 'angry', value: num(integrals?.minutesAngry), color: this.pal.accent },
      { label: 'joyful', value: num(integrals?.minutesJoyful), color: this.pal.good },
    ];
    const maxV = Math.max(1e-6, ...items.map((it) => it.value));
    const rows = items.map((it) => ({ ...it, fmt: fMin(it.value) }));
    this.drawBarRows(s, rows, {
      bipolar: false,
      min: 0,
      max: maxV,
      baseline: 0,
      gutter: 62,
      valW: 34,
    });
  }

  // ----- 5b. allostatic load bar (the exposome's memory) -------------------
  private drawLoadBar(load: number): void {
    const s = this.loadBarC.begin();
    if (!s) return;
    const { ctx, w, h } = s;
    const y = Math.round(h / 2);
    const barH = 6;
    // unbounded load → [0,1) via soft saturation
    const frac = 1 - Math.exp(-Math.max(0, load) / 6);
    ctx.strokeStyle = this.pal.lineFaint;
    ctx.lineWidth = 1;
    frame(ctx, 0, y - barH / 2, w - 1, barH);
    ctx.fillStyle = frac > 0.5 ? this.pal.accent : this.pal.inkSoft;
    ctx.fillRect(1, y - barH / 2 + 1, Math.max(0, (w - 2) * frac), barH - 2);
  }

  // ----- 6. time series sparklines ----------------------------------------
  private drawSeries(): void {
    const s = this.seriesC.begin();
    if (!s) return;
    const { ctx, w, h } = s;
    const left = 2;
    const right = w - 2;

    const band = (
      top: number,
      bot: number,
      label: string,
      buf: number[],
      toY: (v: number, t: number, b: number) => number,
      refY: number,
      curColor: string,
      curVal: string,
    ) => {
      const plotTop = top + 13;
      const plotBot = bot - 3;

      // header
      ctx.fillStyle = this.pal.inkSoft;
      ctx.font = `9px ${this.mono}`;
      ctx.textAlign = 'left';
      ctx.fillText(label, left, top + 7);
      ctx.textAlign = 'right';
      ctx.fillStyle = curColor;
      ctx.fillText(curVal, right, top + 7);
      ctx.textAlign = 'left';

      // reference / baseline line
      ctx.strokeStyle = this.pal.lineFaint;
      ctx.lineWidth = 1;
      hline(ctx, left, right, refY);

      // polyline
      const n = buf.length;
      if (n >= 2) {
        ctx.strokeStyle = this.pal.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = left + (i / (n - 1)) * (right - left);
          const yv = toY(buf[i], plotTop, plotBot);
          if (i === 0) ctx.moveTo(x, yv);
          else ctx.lineTo(x, yv);
        }
        ctx.stroke();

        // current sample marker
        const yv = toY(buf[n - 1], plotTop, plotBot);
        ctx.fillStyle = curColor;
        ctx.beginPath();
        ctx.arc(right, yv, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const half = h / 2;

    // valence band: zero line at mid, range [-1,1]
    {
      const plotTop = 0 + 13;
      const plotBot = half - 3;
      const zeroY = (plotTop + plotBot) / 2;
      const cur = this.sValence.length ? this.sValence[this.sValence.length - 1] : 0;
      band(
        0,
        half,
        'valence',
        this.sValence,
        (v, top, bot) => (top + bot) / 2 - clamp(v, -1, 1) * ((bot - top) / 2),
        zeroY,
        cur > 0.35 ? this.pal.good : cur < -0.25 ? this.pal.accent : this.pal.ink,
        cur.toFixed(2),
      );
    }

    // cortisol band: baseline 1.0 line at mid, range [0,2]
    {
      const plotTop = half + 13;
      const plotBot = h - 3;
      const baseY = plotBot - 0.5 * (plotBot - plotTop);
      const cur = this.sCortisol.length ? this.sCortisol[this.sCortisol.length - 1] : 1;
      band(
        half,
        h,
        'cortisol',
        this.sCortisol,
        (v, top, bot) => bot - (clamp(v, 0, 2) / 2) * (bot - top),
        baseY,
        cur > 1.3 ? this.pal.accent : this.pal.ink,
        cur.toFixed(2),
      );
    }

    // divider between bands
    ctx.strokeStyle = this.pal.lineFaint;
    hline(ctx, 0, w, half);
  }
}

/** push with cap — the ring buffers stay at SERIES_CAP samples. */
function push(buf: number[], v: number): void {
  buf.push(v);
  if (buf.length > SERIES_CAP) buf.shift();
}
