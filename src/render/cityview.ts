// =============================================================================
// cityview.ts — the zoomed-OUT town: a 2D top-down map on aged sepia, black
//   wireframe line-work. What you see here is exactly the Tier-3 statistics being
//   simulated: a breathing population-density field (no agents, just occupancy),
//   the OPINION field tinting it (civic support in green, grievance in oxblood —
//   the same stipple language as density, because it IS the same kind of field),
//   the one true street graph with its live edge flows (moving ink stipple —
//   traffic you can read at a glance), transit routes with schedule-time buses,
//   signals blinking their phase, and Mara's marker tracing her needs-driven path.
//   Near the café, the people she has actually met condense into a relationship
//   constellation — warm bonds in green, strained ones in oxblood.
//
//   Streets come from snapshot.transport (the shared netgraph view — the old
//   duplicated STREETS literal is dead); when a save predates transport, a
//   fallback graph is derived read-only from the same generator over the five
//   core places, so the map never goes blank.
//
//   Self-mounts a full-bleed canvas over the stage + a CITY toggle in the titlebar
//   (mirrors BrainPanel). 2D canvas, not WebGL — the locale stage stays the 3D view.
// =============================================================================
import type { TownSnapshot, PlaceId, Relationship } from '../core/types';
import type { TransportView, ModeId } from '../transport/types';
import { StreetGraph } from '../transport/netgraph';
import { PLACES, PLACE_LIST } from '../world/places';

const C = {
  paper: '#e9dec4', paperDeep: '#ded2b4', ink: '#20180f',
  inkSoft: '#5b4d38', inkFaint: '#9b8a68', accent: '#7a1f12', good: '#355e3b',
};
const GLYPH: Record<PlaceId, string> = {
  home: 'HOME', work: 'WORK', market: 'MARKET', thirdplace: 'CAFÉ', park: 'PARK',
};
const POI_GLYPH: Record<string, string> = {
  supermarket: 'SUPERMKT', fed: 'FED', bank: 'BANK', office: 'OFFICE',
};
const M = 66; // world-metre core scale — u = m/M + 0.5 recovers town coords

const fmtClock = (t: number) => {
  const h = Math.floor(((t % 24) + 24) % 24), m = Math.floor((t - Math.floor(t)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hash01 = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

/** the slice of the transport view the map draws — the fallback graph mimics it. */
interface NetLike {
  nodes: { id: string; x: number; z: number; kind: string }[];
  edges: { id: string; a: string; b: string; sidewalk: boolean; lengthM: number; load: number; factor: number }[];
}

export class CityView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly btn: HTMLButtonElement;
  private hidden = true;
  private trail: { x: number; y: number }[] = [];
  private clock = 0;
  // cached projection + node lookup — rebuilt only when the topology changes
  private box = { cx: 0.5, cy: 0.5, span: 1.1 };
  private posKey = '';
  private pos = new Map<string, { u: number; v: number }>();
  private fallback: NetLike | null = null;

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

  // ---- the street network: transport view, or a derived fallback -------------
  private netOf(snap: TownSnapshot): NetLike {
    const t = snap.transport;
    if (t?.nodes?.length) return t;
    if (!this.fallback) {
      // old save without a transport slot: derive the same graph (read-only)
      // from the five core places, so streets stay drawn from ONE generator.
      const g = new StreetGraph(PLACE_LIST.map((p) => ({
        id: p.id, x: (p.pos2D.x - 0.5) * M, z: (p.pos2D.y - 0.5) * M, kind: 'place',
      })));
      this.fallback = {
        nodes: g.nodes.map((n) => ({ id: n.id, x: n.x, z: n.z, kind: n.kind })),
        edges: g.edges.map((e) => ({ id: e.id, a: e.a, b: e.b, sidewalk: e.sidewalk, lengthM: e.lengthM, load: 0, factor: 1 })),
      };
    }
    return this.fallback;
  }

  /** projection cache: town-u bounds over all nodes (the POIs push past [0,1]). */
  private syncProjection(net: NetLike): void {
    const key = `${net.nodes.length}:${net.nodes[0]?.id}:${net.nodes[net.nodes.length - 1]?.id}`;
    if (key === this.posKey) return;
    this.posKey = key;
    this.pos.clear();
    let u0 = 0, u1 = 1, v0 = 0, v1 = 1; // always cover the density core box
    for (const n of net.nodes) {
      const u = n.x / M + 0.5, v = n.z / M + 0.5;
      this.pos.set(n.id, { u, v });
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    this.box.cx = (u0 + u1) / 2;
    this.box.cy = (v0 + v1) / 2;
    this.box.span = Math.max(u1 - u0, v1 - v0, 1.02) * 1.12;
  }

  update(snap: TownSnapshot, dtReal: number): void {
    if (this.hidden) return;
    this.clock += Number.isFinite(dtReal) ? dtReal : 0;
    const ctx = this.ctx;
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    const net = this.netOf(snap);
    this.syncProjection(net);
    // map town-u space into a centred square with margin
    const pad = 46, side = Math.min(W, H) - pad * 2;
    const { cx, cy, span } = this.box;
    const PX = (u: number) => (W - side) / 2 + ((u - (cx - span / 2)) / span) * side;
    const PY = (v: number) => (H - side) / 2 + ((v - (cy - span / 2)) / span) * side;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);

    // --- density field: alpha stipple (count varies, positions are stable) ---
    try {
      const d = snap.density;
      if (d?.cell) {
        ctx.fillStyle = C.ink;
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
      // --- opinion field: the same stipple language, tinted — support breathes
      //     green, grievance oxblood. It IS a density (of stances), so it is
      //     rendered exactly like one. Absent gov view ⇒ the layer simply isn't.
      const g = snap.gov;
      if (d?.cell && g && (g.mass > 0.02 || g.shadow.meanGrievance > 0.04)) {
        const gr = Math.min(1, Math.max(0, g.shadow.meanGrievance));
        const su = Math.min(1, Math.max(0, g.shadow.meanSupport));
        for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
          const occ = d.cell[r * d.cols + c] ?? 0;
          if (occ < 0.06) continue;
          const gd = Math.round(occ * 4 * gr), sd = Math.round(occ * 4 * su);
          ctx.fillStyle = C.accent;
          for (let i = 0; i < gd; i++) {
            const hx = hash01(r * 211 + c * 43 + i * 5.3), hy = hash01(r * 97 + c * 151 + i * 9.1);
            ctx.globalAlpha = 0.07 + gr * 0.18;
            ctx.fillRect(PX((c + hx) / d.cols), PY((r + hy) / d.rows), 1.6, 1.6);
          }
          ctx.fillStyle = C.good;
          for (let i = 0; i < sd; i++) {
            const hx = hash01(r * 173 + c * 67 + i * 4.7), hy = hash01(r * 83 + c * 139 + i * 8.3);
            ctx.globalAlpha = 0.06 + su * 0.16;
            ctx.fillRect(PX((c + hx) / d.cols), PY((r + hy) / d.rows), 1.6, 1.6);
          }
        }
        ctx.globalAlpha = 1;
      }
    } catch { /* never break the loop */ }

    // --- streets: the shared netgraph + animated edge flows ---
    this.drawStreets(ctx, net, PX, PY);
    if (snap.transport) this.drawTransit(ctx, snap.transport, PX, PY);

    // --- anchors & labels ---
    ctx.font = '10px "SFMono-Regular", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    for (const n of net.nodes) {
      const p = this.pos.get(n.id)!;
      const x = PX(p.u), y = PY(p.v);
      if (n.kind === 'intersection') {
        ctx.fillStyle = C.inkFaint;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        continue;
      }
      const glyph = GLYPH[n.id as PlaceId];
      if (glyph) {
        const here = snap.place === n.id && !snap.travelling;
        ctx.strokeStyle = C.ink; ctx.lineWidth = here ? 2 : 1.2;
        ctx.strokeRect(x - 9, y - 9, 18, 18);
        if (here) { ctx.strokeStyle = C.accent; ctx.strokeRect(x - 13, y - 13, 26, 26); }
        ctx.fillStyle = C.inkSoft;
        ctx.fillText(glyph, x, y - 16);
      } else if (POI_GLYPH[n.id]) {
        ctx.strokeStyle = C.inkSoft; ctx.lineWidth = 1;
        ctx.strokeRect(x - 5, y - 5, 10, 10);
        ctx.fillStyle = C.inkFaint;
        ctx.fillText(POI_GLYPH[n.id], x, y - 10);
      } else {
        // build lots and other minor anchors: quiet marks, no label
        ctx.strokeStyle = C.inkFaint; ctx.lineWidth = 0.75;
        ctx.strokeRect(x - 2.5, y - 2.5, 5, 5);
      }
    }

    // --- assembly: a called gathering pulses at its borrowed venue ---
    this.drawAssembly(ctx, snap, PX, PY);

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

  // ---- streets + the flow layer: moving stipple, intensity ∝ live load -------
  private drawStreets(ctx: CanvasRenderingContext2D, net: NetLike,
    PX: (u: number) => number, PY: (v: number) => number): void {
    // base line-work first (so flow ink layers over it)
    ctx.lineWidth = 1;
    for (const e of net.edges) {
      const a = this.pos.get(e.a), b = this.pos.get(e.b);
      if (!a || !b) continue;
      ctx.strokeStyle = C.inkFaint;
      ctx.globalAlpha = e.sidewalk ? 0.9 : 0.55;
      ctx.beginPath(); ctx.moveTo(PX(a.u), PY(a.v)); ctx.lineTo(PX(b.u), PY(b.v)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // flow pass: dash-offset animation — the ants march faster where load is
    // heavier, and the ink turns oxblood where congestion bites (factor > ~1.3).
    let maxLoad = 0;
    for (const e of net.edges) if (e.load > maxLoad) maxLoad = e.load;
    if (maxLoad < 1e-3) return;
    for (let i = 0; i < net.edges.length; i++) {
      const e = net.edges[i];
      if (e.load < maxLoad * 0.04) continue;
      const a = this.pos.get(e.a), b = this.pos.get(e.b);
      if (!a || !b) continue;
      const k = e.load / maxLoad;                       // 0..1 relative intensity
      const jam = e.factor > 1.3;
      ctx.strokeStyle = jam ? C.accent : C.ink;
      ctx.lineWidth = 0.9 + k * 1.8;
      ctx.globalAlpha = 0.25 + k * 0.55;
      ctx.setLineDash([2, 5]);
      // jammed edges crawl; free edges stream. Direction alternates by parity
      // (edges are undirected — the shimmer reads as two-way traffic).
      const speed = jam ? 3 : 8 + k * 22;
      ctx.lineDashOffset = ((i & 1) ? 1 : -1) * this.clock * speed;
      ctx.beginPath(); ctx.moveTo(PX(a.u), PY(a.v)); ctx.lineTo(PX(b.u), PY(b.v)); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = 1;
  }

  // ---- transit: routes, schedule-time buses, waiting stops, live trips, signals
  private drawTransit(ctx: CanvasRenderingContext2D, t: TransportView,
    PX: (u: number) => number, PY: (v: number) => number): void {
    const U = (x: number) => PX(x / M + 0.5), V = (z: number) => PY(z / M + 0.5);
    // route polylines: long calm dashes in green — the public network
    for (const r of t.routes) {
      if (r.poly.length < 2) continue;
      ctx.strokeStyle = C.good; ctx.lineWidth = 1.1; ctx.globalAlpha = 0.5;
      ctx.setLineDash([7, 4]);
      ctx.beginPath();
      for (let i = 0; i < r.poly.length; i++) {
        const p = r.poly[i];
        i === 0 ? ctx.moveTo(U(p.x), V(p.z)) : ctx.lineTo(U(p.x), V(p.z));
      }
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      for (const v of r.vehicles) {                     // buses at schedule-time
        ctx.fillStyle = C.good;
        ctx.fillRect(U(v.x) - 2.5, V(v.z) - 2, 5, 4);
        ctx.strokeStyle = C.ink; ctx.lineWidth = 0.6;
        ctx.strokeRect(U(v.x) - 2.5, V(v.z) - 2, 5, 4);
      }
    }
    // stops with a queue: a ring that grows with the wait
    for (const s of t.stops) {
      if (s.waiting < 0.5) continue;
      const p = this.pos.get(s.venueId);
      if (!p) continue;
      ctx.strokeStyle = C.inkSoft; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(PX(p.u), PY(p.v), 3 + Math.min(6, s.waiting * 0.6), 0, Math.PI * 2); ctx.stroke();
      if (s.waiting >= 3) {
        ctx.fillStyle = C.inkSoft; ctx.font = '9px "SFMono-Regular", ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(Math.round(s.waiting)), PX(p.u), PY(p.v) - 8);
      }
    }
    // signal heads: phase 0/1 alternates which axis holds the green
    for (const sg of t.signals) {
      ctx.fillStyle = sg.phase === 0 ? C.good : C.accent;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(U(sg.x), V(sg.z), 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // live Tier-A trips: a dot per traveler, tinted by mode
    const MODE_C: Record<ModeId, string> = { walk: C.inkSoft, bike: C.good, car: C.ink, taxi: C.accent, bus: C.good };
    for (const tr of t.trips) {
      ctx.fillStyle = MODE_C[tr.mode] ?? C.ink;
      ctx.beginPath(); ctx.arc(U(tr.x), V(tr.z), 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = C.paper; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.arc(U(tr.x), V(tr.z), 2.4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  private drawAssembly(ctx: CanvasRenderingContext2D, snap: TownSnapshot,
    PX: (u: number) => number, PY: (v: number) => number): void {
    const asm = snap.gov?.assembly;
    if (!asm) return;
    // assemblies borrow real venues — 'foodcourt' is the work food court
    const at = asm.place === 'park' ? PLACES.park.pos2D : PLACES.work.pos2D;
    const x = PX(at.x), y = PY(at.y);
    const r = 16 + Math.sin(this.clock * 2.2) * 3;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = C.accent;
    ctx.font = '9px "SFMono-Regular", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ASSEMBLY', x, y + r + 14);
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

  private drawHud(ctx: CanvasRenderingContext2D, snap: TownSnapshot, W: number, H: number): void {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = '11px "SFMono-Regular", ui-monospace, Menlo, monospace';
    const dow = DOW[snap.day % 7] ?? '';
    ctx.fillText(`${dow} · day ${snap.day} · ${fmtClock(snap.time)}${snap.weekend ? ' · weekend' : ''}`, 16, 22);
    ctx.fillStyle = C.ink;
    ctx.font = 'italic 14px "Hoefler Text", Palatino, serif';
    const r = snap.intention?.reason ?? '';
    ctx.fillText(snap.travelling ? `walking — ${r}` : r, 16, 42);
    // street + civic pulse lines live bottom-left, clear of the camera roster
    ctx.font = '10px "SFMono-Regular", ui-monospace, Menlo, monospace';
    const k = snap.transport?.kpis;
    if (k) {
      ctx.fillStyle = k.congestion > 1.3 ? C.accent : C.inkSoft;
      const ms = k.modeShare;
      const share = (id: ModeId) => `${id} ${(100 * (ms[id] ?? 0)).toFixed(0)}%`;
      ctx.fillText(
        `streets ×${k.congestion.toFixed(2)} · aboard ${k.aboard.toFixed(0)} · waiting ${k.waiting.toFixed(0)}` +
        ` · ${share('walk')} ${share('bus')} ${share('taxi')}`, 16, H - 30);
    }
    // the civic pulse: only when something is stirring — dormant towns stay quiet
    const g = snap.gov;
    if (g && g.state !== 'dormant') {
      ctx.fillStyle = g.state === 'insolvent' || g.state === 'dissolved' ? C.accent : C.inkSoft;
      ctx.fillText(
        `polis: ${g.state} · mass ${g.mass.toFixed(2)} · grievance ${g.shadow.meanGrievance.toFixed(2)}` +
        ` · support ${g.shadow.meanSupport.toFixed(2)}`, 16, H - 16);
    }
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
