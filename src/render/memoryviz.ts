// =============================================================================
// memoryviz.ts — a live view of the symbolic memory GRAPH: nodes (episodic ·
// semantic · entity · schema) laid out by a cheap incremental force sim, edges
// (assoc · about · is_a · temporal) as faint ink, everything drawn on aged paper.
// Node size tracks salience×retrievability; a node currently ACTIVATED by recall
// glows and names itself. A titlebar toggle shows/hides it over the stage.
// =============================================================================
import type { TownSnapshot, MemGraphView, MemNodeKind } from '../types';

const C = {
  paper: '#e9dec4', ink: '#20180f', inkSoft: '#5b4d38', inkFaint: '#9b8a68',
  accent: '#7a1f12', good: '#355e3b',
};
const KIND_COLOR: Record<MemNodeKind, string> = {
  episodic: '#20180f', semantic: '#355e3b', entity: '#7a1f12', schema: '#5b4d38',
};
const KIND_LABEL: Record<MemNodeKind, string> = {
  episodic: 'episodic event', semantic: 'semantic gist', entity: 'person / place', schema: 'schema · insight',
};

interface P { x: number; y: number; vx: number; vy: number; }
const hash01 = (s: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

export class MemoryPanel {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = true;
  private pos = new Map<string, P>();
  private clock = 0;

  constructor(stageEl: HTMLElement, titlebarEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'memoryviz';
    stageEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    this.btn = document.createElement('button');
    this.btn.className = 'toggle';
    this.btn.textContent = 'MEMORY';
    this.btn.title = 'Toggle the symbolic memory graph';
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
    const focusAgent = snap?.agents?.[snap.focus ?? 0];
    const g = focusAgent?.memoryGraph ?? snap?.cashier?.memoryGraph;
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
    if (!g) return;
    this.clock += Number.isFinite(dtReal) ? dtReal : 0;

    this.layout(g, W, H);

    // --- edges ---
    for (const e of g.edges) {
      const a = this.pos.get(e.a), b = this.pos.get(e.b);
      if (!a || !b) continue;
      ctx.strokeStyle = e.kind === 'is_a' ? 'rgba(53,94,59,0.35)'
        : e.kind === 'about' ? 'rgba(122,31,18,0.22)'
        : e.kind === 'temporal' ? 'rgba(32,24,15,0.10)' : 'rgba(32,24,15,0.13)';
      ctx.lineWidth = 0.5 + e.w * 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // --- nodes ---
    let hottest: { text: string; kind: MemNodeKind } | null = null; let hot = 0.05;
    for (const n of g.nodes) {
      const p = this.pos.get(n.id); if (!p) continue;
      const r = 2.5 + n.salience * 3 + (n.kind !== 'episodic' ? 2 : 0) + n.retr * 1.5;
      // activation halo
      if (n.act > 0.05) {
        ctx.fillStyle = 'rgba(122,31,18,' + (0.06 + n.act * 0.2).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 6 + n.act * 8, 0, Math.PI * 2); ctx.fill();
        if (n.act > hot) { hot = n.act; hottest = { text: n.text, kind: n.kind }; }
      }
      ctx.globalAlpha = 0.35 + Math.min(0.65, n.retr);
      ctx.fillStyle = KIND_COLOR[n.kind];
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      // label the big / lit nodes
      if (n.kind === 'entity' || n.kind === 'schema' || n.kind === 'semantic' || n.act > 0.2) {
        ctx.fillStyle = C.inkSoft;
        ctx.font = '9px "SFMono-Regular", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(this.clip(n.kind === 'entity' ? n.text : n.text, n.kind === 'entity' ? 16 : 26), p.x, p.y - r - 4);
      }
    }

    this.drawHud(ctx, g, hottest, W, H);
  }

  private layout(g: MemGraphView, W: number, H: number): void {
    const cx = W / 2, cy = H / 2 + 10;
    const ids = new Set(g.nodes.map((n) => n.id));
    // seed new nodes deterministically near centre
    for (const n of g.nodes) {
      if (!this.pos.has(n.id)) {
        const a = hash01(n.id) * Math.PI * 2, rr = 40 + hash01(n.id + 'r') * 180;
        this.pos.set(n.id, { x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, vx: 0, vy: 0 });
      }
    }
    for (const id of [...this.pos.keys()]) if (!ids.has(id)) this.pos.delete(id);

    const nodes = g.nodes.map((n) => ({ n, p: this.pos.get(n.id)! }));
    // repulsion (O(N^2), N≤60)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].p, b = nodes[j].p;
        let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = (hash01(nodes[i].n.id) - 0.5); dy = (hash01(nodes[j].n.id) - 0.5); }
        const f = 620 / d2;
        const inv = 1 / Math.sqrt(d2);
        a.vx += dx * inv * f; a.vy += dy * inv * f;
        b.vx -= dx * inv * f; b.vy -= dy * inv * f;
      }
    }
    // spring along edges
    for (const e of g.edges) {
      const a = this.pos.get(e.a), b = this.pos.get(e.b); if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
      const rest = e.kind === 'about' ? 42 : e.kind === 'is_a' ? 52 : 66;
      const f = (d - rest) * 0.012 * (0.4 + e.w);
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    // gravity + integrate + damp + bound
    for (const { p } of nodes) {
      p.vx += (cx - p.x) * 0.004; p.vy += (cy - p.y) * 0.004;
      p.vx *= 0.82; p.vy *= 0.82;
      p.x += Math.max(-6, Math.min(6, p.vx)); p.y += Math.max(-6, Math.min(6, p.vy));
      p.x = Math.max(40, Math.min(W - 40, p.x)); p.y = Math.max(60, Math.min(H - 40, p.y));
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D, g: MemGraphView, hot: { text: string; kind: MemNodeKind } | null, W: number, H: number): void {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = '11px "SFMono-Regular", ui-monospace, Menlo, monospace';
    const counts: Record<string, number> = {};
    g.nodes.forEach((n) => (counts[n.kind] = (counts[n.kind] ?? 0) + 1));
    ctx.fillText(`SYMBOLIC MEMORY GRAPH · ${g.nodes.length} nodes · ${g.edges.length} edges`, 16, 22);
    // legend
    let lx = 16;
    for (const k of ['episodic', 'semantic', 'entity', 'schema'] as MemNodeKind[]) {
      ctx.fillStyle = KIND_COLOR[k]; ctx.beginPath(); ctx.arc(lx + 4, 38, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.inkSoft; ctx.font = '10px "SFMono-Regular", ui-monospace, Menlo, monospace';
      ctx.fillText(`${KIND_LABEL[k]} ${counts[k] ?? 0}`, lx + 12, 41);
      lx += ctx.measureText(`${KIND_LABEL[k]} ${counts[k] ?? 0}`).width + 30;
    }
    // recalled-now caption
    if (hot) {
      ctx.fillStyle = C.accent;
      ctx.font = '10px "SFMono-Regular", ui-monospace, Menlo, monospace';
      ctx.fillText('RECALLING NOW', 16, H - 34);
      ctx.fillStyle = C.ink;
      ctx.font = 'italic 14px "Hoefler Text", Palatino, serif';
      ctx.fillText(this.clip(hot.text, 92), 16, H - 16);
    }
  }

  private clip(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  dispose(): void { this.canvas.remove(); this.btn.remove(); }
}
