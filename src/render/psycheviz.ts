// =============================================================================
// psycheviz.ts — a compact, live "psyche signature": the protagonist's whole
// affective/motivational state as a single morphing radial glyph, drawn in ink
// on the stage. Twelve axes (core affect + Panksepp drives + key neuromodulators)
// spoke out from a centre; the filled polygon breathes with the soma in real time.
// A toggle in the titlebar shows/hides it. Minimal by design — one glyph, no chrome.
// =============================================================================
import type { TownSnapshot, SomaState } from '../types';

const C = { paper: '#e9dec4', ink: '#20180f', inkSoft: '#5b4d38', faint: 'rgba(32,24,15,0.14)', accent: '#7a1f12', good: '#355e3b' };

interface Axis { key: string; label: string; norm: (s: SomaState) => number; tone?: 'warn' | 'good'; }
// each maps its soma channel to [0,1] (modulators are centred at 1)
const AXES: Axis[] = [
  { key: 'valence', label: 'val', norm: (s) => (s.valence + 1) / 2, good: true } as Axis,
  { key: 'arousal', label: 'aro', norm: (s) => s.arousal },
  { key: 'dominance', label: 'dom', norm: (s) => (s.dominance + 1) / 2 },
  { key: 'SEEKING', label: 'seek', norm: (s) => s.SEEKING },
  { key: 'CARE', label: 'care', norm: (s) => s.CARE, tone: 'good' },
  { key: 'PLAY', label: 'play', norm: (s) => s.PLAY, tone: 'good' },
  { key: 'FEAR', label: 'fear', norm: (s) => s.FEAR, tone: 'warn' },
  { key: 'RAGE', label: 'rage', norm: (s) => s.RAGE, tone: 'warn' },
  { key: 'PANIC_GRIEF', label: 'grief', norm: (s) => s.PANIC_GRIEF, tone: 'warn' },
  { key: 'da_meso', label: 'DA', norm: (s) => clamp01((s.da_meso - 0.5) / 1.5), tone: 'good' },
  { key: 'cortisol', label: 'cort', norm: (s) => clamp01((s.cortisol - 0.5) / 2), tone: 'warn' },
  { key: 'oxytocin', label: 'oxt', norm: (s) => clamp01((s.oxytocin - 0.5) / 1.5), tone: 'good' },
];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class PsychePanel {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = false;
  private smoothed = AXES.map(() => 0.2);
  private clock = 0;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'psycheviz';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle';
    this.btn.textContent = 'PSYCHE';
    this.btn.title = 'Toggle the live psyche-vector signature';
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
    const S = 210;
    this.canvas.width = S * dpr; this.canvas.height = S * dpr;
    this.canvas.style.width = S + 'px'; this.canvas.style.height = S + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(snap: TownSnapshot, dtReal: number): void {
    if (this.hidden) return;
    const focusAgent = snap?.agents?.[snap.focus ?? 0];
    const soma = focusAgent?.soma ?? snap?.cashier?.soma;
    if (!soma) return;
    this.clock += Number.isFinite(dtReal) ? dtReal : 0;
    const k = 1 - Math.exp(-6 * (dtReal || 0.016));

    const ctx = this.ctx;
    const S = 210, cx = S / 2, cy = S / 2 + 4, R = 74;
    ctx.clearRect(0, 0, S, S);

    // title
    ctx.fillStyle = C.inkSoft;
    ctx.font = '9px "SFMono-Regular", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PSYCHE VECTOR', 8, 12);

    // concentric guide rings
    ctx.strokeStyle = C.faint; ctx.lineWidth = 1;
    for (const r of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * r, 0, Math.PI * 2); ctx.stroke(); }

    const n = AXES.length;
    // spokes + labels
    ctx.fillStyle = C.inkSoft;
    ctx.font = '8px "SFMono-Regular", ui-monospace, Menlo, monospace';
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      ctx.strokeStyle = C.faint;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
      const lx = cx + Math.cos(a) * (R + 12), ly = cy + Math.sin(a) * (R + 12);
      ctx.textAlign = Math.abs(Math.cos(a)) < 0.3 ? 'center' : (Math.cos(a) > 0 ? 'left' : 'right');
      ctx.fillText(AXES[i].label, lx, ly);
    }

    // smoothed polygon
    let warn = 0, good = 0;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const target = clamp01(AXES[i].norm(soma));
      this.smoothed[i] += (target - this.smoothed[i]) * k;
      const v = 0.06 + this.smoothed[i] * 0.94;
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      pts.push([cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]);
      if (AXES[i].tone === 'warn') warn += this.smoothed[i];
      if (AXES[i].tone === 'good') good += this.smoothed[i];
    }
    const hot = warn > good;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = hot ? 'rgba(122,31,18,0.16)' : 'rgba(53,94,59,0.15)';
    ctx.fill();
    ctx.strokeStyle = hot ? C.accent : C.good; ctx.lineWidth = 1.4;
    ctx.stroke();
    // vertex dots
    ctx.fillStyle = C.ink;
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  }

  dispose(): void { this.canvas.remove(); this.btn.remove(); }
}
