// =============================================================================
// skyclock.ts — a circular sun/moon time-of-day dial, drawn in ink on aged
// paper in the house instrument style. A 24-hour ring with a horizon diameter:
// noon at the top, midnight at the bottom, sunrise to the left, sunset to the
// right. The sun rides the rim through the day; the moon sits at the opposite
// extreme. Whichever body is ABOVE the horizon is drawn solid; the other faint.
//
// This is ONLY a 2D diagram. It never touches the three.js scene, lighting,
// materials or exposure — no illumination anywhere. A titlebar toggle shows/
// hides it; it self-mounts into a stage corner with pointer-events:none so it
// can never steal the camera drag. Mirrors PsychePanel/MemoryPanel exactly.
// =============================================================================
import type { TownSnapshot } from '../core/types';

// ---------------------------------------------------------------------------
// palette — resolved from style.css custom properties (the same --paper/--ink/
// --accent/--good the dashboard reads), with the canonical hex fallbacks baked
// in so the dial renders even before the stylesheet applies. Resolved once.
// ---------------------------------------------------------------------------
interface Palette {
  paper: string; ink: string; inkSoft: string; inkFaint: string;
  line: string; lineFaint: string; accent: string; good: string;
}

function readPalette(root: HTMLElement): Palette {
  let cs: CSSStyleDeclaration | null = null;
  try { cs = getComputedStyle(root); } catch { cs = null; }
  const v = (name: string, fallback: string): string => {
    if (!cs) return fallback;
    const raw = cs.getPropertyValue(name);
    const t = raw ? raw.trim() : '';
    return t || fallback;
  };
  return {
    paper: v('--paper', '#e9dec4'),
    ink: v('--ink', '#20180f'),
    inkSoft: v('--ink-soft', '#5b4d38'),
    inkFaint: v('--ink-faint', '#9b8a68'),
    line: v('--line', 'rgba(32, 24, 15, 0.78)'),
    lineFaint: v('--line-faint', 'rgba(32, 24, 15, 0.16)'),
    accent: v('--accent', '#7a1f12'),
    good: v('--good', '#355e3b'),
  };
}

/** coerce anything to a finite number, else the fallback. never throws. */
function num(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

/** parse #rrggbb or rgb()/rgba() to a fresh rgba string at alpha `a`. */
function withAlpha(color: string, a: number): string {
  const c = color.trim();
  if (c[0] === '#') {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((h) => h + h).join('');
    const n = parseInt(hex, 16);
    if (!Number.isFinite(n)) return `rgba(32,24,15,${a})`;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${p[0] || 0},${p[1] || 0},${p[2] || 0},${a})`;
  }
  return `rgba(32,24,15,${a})`;
}

const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;

// dial geometry (css px). Kept fixed & compact (~150px) like the psyche glyph.
const W = 150;
const H = 166;
const CX = W / 2;
const CY = 80;
const R = 50;

const MONO = '"SFMono-Regular", ui-monospace, Menlo, monospace';

// one-shot stylesheet injection — a corner placement + pointer-events:none so
// the overlay never intercepts the camera drag. Guarded by id so N instances
// (or a dispose/reconstruct) never duplicate the rule.
//
// Anchored TOP-RIGHT: the bottom-left corner is owned by #caption (the narration/
// dialogue) and the tall top-left .cam-panel (agent roster) grows downward on a
// short stage — parking the dial here keeps every overlay in its own corner
// (roster TL · clock TR · caption BL · psyche BR) with no overlap.
const STYLE_ID = 'skyclock-style';
function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent =
    '.skyclock{position:absolute;right:16px;top:16px;z-index:7;display:block;pointer-events:none;}';
  document.head.appendChild(s);
}

export class SkyClock {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private readonly pal: Palette;
  private hidden = false;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    ensureStyle();
    this.pal = readPalette(stageEl);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'skyclock';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle';
    this.btn.textContent = 'SKY';
    this.btn.title = 'Toggle the sun/moon time-of-day dial';
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

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(snap: TownSnapshot): void {
    if (this.hidden) return;
    try {
      const ctx = this.ctx;
      const pal = this.pal;

      // t ∈ [0,24) continuous sim hours; day is the integer day number.
      const t = (((num((snap as { time?: number })?.time) % 24) + 24) % 24);
      const day = Math.max(0, Math.floor(num((snap as { day?: number })?.day)));

      // α(t): noon (t=12) → top, midnight → bottom, sunrise (t=6) → left,
      // sunset (t=18) → right. Body at (CX + R·sinα, CY − R·cosα).
      const a = (2 * Math.PI * (t - 12)) / 24;
      const alt = Math.cos(a);              // sun altitude proxy; >0 ⇒ daytime (t∈(6,18))
      const day_ = alt > 0;
      const px = (ang: number, r: number) => CX + Math.sin(ang) * r;
      const py = (ang: number, r: number) => CY - Math.cos(ang) * r;

      ctx.clearRect(0, 0, W, H);

      // ---- title ----
      ctx.fillStyle = pal.inkSoft;
      ctx.font = `9px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('SKY CLOCK', 10, 13);

      // ---- faint day-sky (above horizon) & ground (below) fills ----
      ctx.beginPath();
      ctx.arc(CX, CY, R, Math.PI, Math.PI * 2, false); // left → top → right
      ctx.closePath();
      ctx.fillStyle = withAlpha(pal.accent, 0.06);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI, false);           // right → bottom → left
      ctx.closePath();
      ctx.fillStyle = withAlpha(pal.ink, 0.07);
      ctx.fill();

      // ---- 24h ring ----
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(CX, CY, R, 0, Math.PI * 2);
      ctx.stroke();

      // ---- hourly ticks (minor every hour, major at the four cardinals) ----
      for (let h = 0; h < 24; h++) {
        const ah = (2 * Math.PI * (h - 12)) / 24;
        const major = h % 6 === 0;
        const inner = R - (major ? 7 : 3.5);
        ctx.strokeStyle = major ? pal.line : withAlpha(pal.ink, 0.22);
        ctx.lineWidth = major ? 1 : 0.75;
        ctx.beginPath();
        ctx.moveTo(px(ah, R), py(ah, R));
        ctx.lineTo(px(ah, inner), py(ah, inner));
        ctx.stroke();
      }

      // ---- horizon diameter ----
      ctx.strokeStyle = withAlpha(pal.ink, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(CX - R, CY);
      ctx.lineTo(CX + R, CY);
      ctx.stroke();

      // ---- cardinal labels (outside the rim) ----
      ctx.fillStyle = pal.inkSoft;
      ctx.font = `8px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText('12', CX, CY - R - 8);
      ctx.fillText('00', CX, CY + R + 9);
      ctx.textAlign = 'right';
      ctx.fillText('06', CX - R - 6, CY);
      ctx.textAlign = 'left';
      ctx.fillText('18', CX + R + 6, CY);

      // ---- the two bodies: sun on the rim, moon at the opposite extreme ----
      const sx = px(a, R), sy = py(a, R);
      const mx = px(a + Math.PI, R), my = py(a + Math.PI, R);
      // faint (below-horizon) body first, emphasized one on top
      if (day_) {
        this.drawMoon(mx, my, false);
        this.drawSun(sx, sy, true);
      } else {
        this.drawSun(sx, sy, false);
        this.drawMoon(mx, my, true);
      }

      // ---- day · clock caption ----
      const hh = Math.floor(t) % 24;
      const mm = Math.floor((t - Math.floor(t)) * 60);
      ctx.fillStyle = pal.ink;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`day ${day} · ${pad2(hh)}:${pad2(mm)}`, CX, H - 8);
      ctx.textAlign = 'left';
    } catch {
      // The dial must never throw into the render loop.
    }
  }

  // ----- sun: a disc with short rays; emphasized (solid oxblood) above horizon
  private drawSun(x: number, y: number, emph: boolean): void {
    const ctx = this.ctx, pal = this.pal;
    const rs = 5.5;
    // rays
    ctx.strokeStyle = emph ? pal.accent : withAlpha(pal.inkSoft, 0.32);
    ctx.lineWidth = emph ? 1.2 : 0.75;
    const rays = 12;
    const rout = rs + (emph ? 5 : 3);
    for (let i = 0; i < rays; i++) {
      const ra = (i / rays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ra) * (rs + 1.5), y + Math.sin(ra) * (rs + 1.5));
      ctx.lineTo(x + Math.cos(ra) * rout, y + Math.sin(ra) * rout);
      ctx.stroke();
    }
    // disc
    ctx.beginPath();
    ctx.arc(x, y, rs, 0, Math.PI * 2);
    ctx.fillStyle = emph ? pal.accent : withAlpha(pal.inkSoft, 0.1);
    ctx.fill();
    ctx.strokeStyle = emph ? withAlpha(pal.accent, 0.9) : withAlpha(pal.inkSoft, 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ----- moon: a crescent (steel/ink); emphasized (solid) above horizon
  private drawMoon(x: number, y: number, emph: boolean): void {
    const ctx = this.ctx, pal = this.pal;
    const r = 5.5;
    const d = -r * 0.35; // terminator bulge (left) → a thin lit crescent
    // lit outer limb (left semicircle) + terminator (an ellipse arc) → a lune
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI / 2, Math.PI * 1.5, false);            // bottom → left → top
    ctx.ellipse(x, y, Math.abs(d), r, 0, Math.PI * 1.5, Math.PI / 2, d < 0);
    ctx.closePath();
    ctx.fillStyle = emph ? pal.inkSoft : withAlpha(pal.inkSoft, 0.12);
    ctx.fill();
    ctx.strokeStyle = emph ? pal.ink : withAlpha(pal.inkSoft, 0.4);
    ctx.lineWidth = emph ? 1 : 0.75;
    ctx.stroke();
  }

  dispose(): void {
    this.canvas.remove();
    this.btn.remove();
  }
}
