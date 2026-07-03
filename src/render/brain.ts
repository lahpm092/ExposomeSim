// =============================================================================
// brain.ts — BrainPanel: an anatomical 3D brain instrument.
//   Renders a REAL MRI-derived brain (Brainder "Brain for Blender", FreeSurfer
//   surfaces, CC-BY-SA 3.0; preprocessed → /public/brain-mesh.json): the pial
//   cortex with true gyri/sulci, Desikan-Killiany cortical regions, segmented
//   subcortical nuclei (amygdala, hippocampus, accumbens, ventral diencephalon),
//   and a brainstem · cerebellum · basal-ganglia · corpus-callosum context.
//   The tiny brainstem nuclei MRI can't segment (VTA, raphe, locus coeruleus,
//   PAG, pituitary, pineal) are shown as small markers placed in the real frame.
//
//   ↑/↓ arrow keys move a cursor through the 33-channel soma vector; the brain
//   region(s) responsible for the selected channel turn opaque ink, and labeled
//   leader-arrows point to each. Drag to rotate, wheel to zoom. Line-work only —
//   no lights / fills / shadows, in the house ink-on-sepia discipline.
//
//   Attribution (CC-BY-SA 3.0): brain surfaces from Brainder "Brain for Blender"
//   by Anderson M. Winkler — https://brainder.org/research/brain-for-blender/
// =============================================================================
import * as THREE from 'three';
import type { WorldSnapshot, SomaChannel, SomaState } from '../types';
import { PALETTE, C, lineMaterial, disposeObject, clampNum } from './palette';
import { isModulator } from '../harness/params';

// ---- channel → responsible structure id(s) ---------------------------------
const CH2REG: Record<SomaChannel, string[]> = {
  da_meso:        ['vta', 'nacc'],
  da_cort:        ['vta', 'dlPFC'],
  serotonin:      ['raphe'],
  norepinephrine: ['lc'],
  gaba:           ['cortex', 'amygdala'],
  glutamate:      ['cortex'],
  oxytocin:       ['hypothalamus'],
  opioid:         ['pag', 'nacc'],
  endocannabinoid:['amygdala', 'cortex'],
  cortisol:       ['hypothalamus', 'pituitary'],
  melatonin:      ['pineal'],
  epinephrine:    ['lc'],
  ghrelin:        ['hypothalamus'],
  leptin:         ['hypothalamus'],
  amygdala:       ['amygdala'],
  hippocampus:    ['hippocampus'],
  nacc:           ['nacc'],
  insula:         ['insula'],
  hypothalamus:   ['hypothalamus'],
  vmPFC:          ['vmPFC'],
  dlPFC:          ['dlPFC'],
  SEEKING:        ['vta', 'nacc'],
  FEAR:           ['amygdala', 'pag'],
  RAGE:           ['amygdala', 'hypothalamus', 'pag'],
  CARE:           ['hypothalamus', 'vta', 'nacc'],
  PANIC_GRIEF:    ['pag', 'dACC'],
  PLAY:           ['pag', 'nacc'],
  LUST:           ['hypothalamus', 'vta'],
  thirst:         ['hypothalamus', 'insula'],
  allostaticLoad: ['amygdala', 'hippocampus', 'hypothalamus', 'pituitary', 'vmPFC'],
  fatigue:        ['dlPFC', 'hypothalamus', 'insula'],
  valence:        ['vmPFC', 'nacc', 'amygdala', 'insula'],
  arousal:        ['lc', 'amygdala', 'hypothalamus', 'dACC'],
  dominance:      ['dlPFC', 'vmPFC', 'nacc', 'amygdala'],
};

// reverse map: which soma channels drive each anatomical region (from CH2REG),
// so the region can glow with the LIVE sum of those channels' activation.
const REGION_CHANNELS: Record<string, SomaChannel[]> = (() => {
  const m: Record<string, SomaChannel[]> = {};
  for (const ch of Object.keys(CH2REG) as SomaChannel[]) {
    for (const reg of CH2REG[ch]) (m[reg] ??= []).push(ch);
  }
  return m;
})();
const THREAT_REGIONS = new Set(['amygdala', 'pag', 'lc', 'dACC', 'pituitary']);
const REWARD_REGIONS = new Set(['nacc', 'vta']);

/** a channel's live activation in [0,1] (modulators read deviation from baseline 1). */
function channelIntensity(soma: SomaState, ch: SomaChannel): number {
  const v = soma[ch] as number;
  if (!Number.isFinite(v)) return 0;
  if (ch === 'allostaticLoad') return clampNum(v / 12, 0, 1);
  if (ch === 'valence' || ch === 'dominance') return clampNum(Math.abs(v), 0, 1);
  if (ch === 'arousal') return clampNum(v, 0, 1);
  if (isModulator(ch)) return clampNum(Math.abs(v - 1) / 1.3, 0, 1);
  return clampNum(v, 0, 1); // activations, drives, fatigue, thirst
}

const REGION_NAME: Record<string, string> = {
  cortex: 'Neocortex', insula: 'Insula', vmPFC: 'vmPFC / OFC', dlPFC: 'dlPFC', dACC: 'Dorsal ACC',
  amygdala: 'Amygdala', hippocampus: 'Hippocampus', nacc: 'Nucleus accumbens', hypothalamus: 'Hypothalamus',
  vta: 'Ventral tegmental area', raphe: 'Raphe nuclei', lc: 'Locus coeruleus', pag: 'Periaqueductal gray',
  pituitary: 'Pituitary', pineal: 'Pineal',
};

// synthetic markers for nuclei MRI can't segment: id → {ref centroid, offset, radii, bilateral}
const MARKERS: { id: string; ref: string; off: [number, number, number]; r: [number, number, number]; bilateral: boolean }[] = [
  { id: 'pag',       ref: 'brainstem',    off: [0,    0.17, -0.02], r: [0.04, 0.05, 0.05], bilateral: false },
  { id: 'vta',       ref: 'brainstem',    off: [0.03, 0.14,  0.05], r: [0.04, 0.04, 0.04], bilateral: true  },
  { id: 'lc',        ref: 'brainstem',    off: [0.04, 0.06, -0.05], r: [0.03, 0.04, 0.04], bilateral: true  },
  { id: 'raphe',     ref: 'brainstem',    off: [0,    0.0,   0.0 ], r: [0.025, 0.13, 0.04], bilateral: false },
  { id: 'pituitary', ref: 'hypothalamus', off: [0,   -0.11,  0.05], r: [0.045, 0.045, 0.045], bilateral: false },
  { id: 'pineal',    ref: 'thalamus',     off: [0,    0.01, -0.14], r: [0.04, 0.045, 0.045], bilateral: false },
];

// ---- the arrow-traversal order, grouped by functional system -----------------
const CHANNEL_ORDER: SomaChannel[] = [
  'da_meso', 'da_cort', 'serotonin', 'norepinephrine', 'gaba', 'glutamate', 'oxytocin', 'opioid', 'endocannabinoid',
  'cortisol', 'melatonin', 'epinephrine', 'ghrelin', 'leptin',
  'amygdala', 'hippocampus', 'nacc', 'insula', 'hypothalamus',
  'vmPFC', 'dlPFC',
  'SEEKING', 'FEAR', 'RAGE', 'CARE', 'PANIC_GRIEF', 'PLAY', 'LUST',
  'thirst', 'allostaticLoad', 'fatigue',
  'valence', 'arousal', 'dominance',
];
const GROUPS: { title: string; start: number }[] = [
  { title: 'Neuromodulators', start: 0 }, { title: 'Hormones', start: 9 },
  { title: 'Limbic nodes', start: 14 }, { title: 'Cortical', start: 19 },
  { title: 'Panksepp drives', start: 21 }, { title: 'Homeostatic · slow', start: 28 },
  { title: 'Core affect', start: 31 },
];
const LABELS: Record<SomaChannel, string> = {
  da_meso: 'Mesolimbic dopamine', da_cort: 'Mesocortical dopamine', serotonin: 'Serotonin',
  norepinephrine: 'Norepinephrine', gaba: 'GABA', glutamate: 'Glutamate', oxytocin: 'Oxytocin',
  opioid: 'Endogenous opioid', endocannabinoid: 'Endocannabinoid',
  cortisol: 'Cortisol', melatonin: 'Melatonin', epinephrine: 'Epinephrine', ghrelin: 'Ghrelin', leptin: 'Leptin',
  amygdala: 'Amygdala', hippocampus: 'Hippocampus', nacc: 'Nucleus accumbens', insula: 'Insula', hypothalamus: 'Hypothalamus',
  vmPFC: 'vmPFC (reappraisal)', dlPFC: 'dlPFC (control)',
  SEEKING: 'SEEKING', FEAR: 'FEAR', RAGE: 'RAGE', CARE: 'CARE', PANIC_GRIEF: 'PANIC / GRIEF', PLAY: 'PLAY', LUST: 'LUST',
  thirst: 'Thirst (osmostat)', allostaticLoad: 'Allostatic load', fatigue: 'Fatigue',
  valence: 'Valence', arousal: 'Arousal', dominance: 'Dominance',
};

const SVGNS = 'http://www.w3.org/2000/svg';
const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—');

interface MeshData { p: number[]; i: number[]; }
interface Bundle { structures: Record<string, MeshData>; centroids: Record<string, [number, number, number]>; roles: Record<string, string>; }

interface RegionView {
  meshes: THREE.LineSegments[];
  mat: THREE.LineBasicMaterial;
  base: number;
  tOpacity: number;
}
interface Row { key: SomaChannel; row: HTMLElement; b: HTMLElement; cache: string; }
interface Label { chip: HTMLDivElement; line: SVGLineElement; dot: SVGCircleElement; }

const BASE: Record<string, number> = { cortex: 0.14, cortexRegion: 0.0, nucleus: 0.14, marker: 0.15, context: 0.04 };
const CORTEX_HILITE = 0.5; // the whole cortex lit reads at half — not a black blob

export class BrainPanel {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly panel: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly btn: HTMLButtonElement;
  private readonly litEl: HTMLDivElement;
  private readonly regions = new Map<string, RegionView>();
  private readonly anchors = new Map<string, THREE.Vector3>();
  private readonly labels = new Map<string, Label>();
  private readonly rows: Row[] = [];
  private contextMat!: THREE.LineBasicMaterial;
  private markerGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1, 2));
  private cursor = 0;
  private clock = 0;
  private hidden = false;
  private ready = false;
  private live = true;         // regions glow with live soma activation
  private liveBtn!: HTMLButtonElement;

  // orbit state
  private readonly tgt = new THREE.Vector3(0, 0.0, 0);
  private theta = 1.02;
  private phi = 1.4;
  private radius = 3.5;
  private dragging = false;
  private autoRot = true;
  private lastX = 0;
  private lastY = 0;

  constructor(dashEl: HTMLElement, titlebarEl: HTMLElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'panel brain-panel';
    const h2 = document.createElement('h2');
    h2.textContent = 'Neuroanatomy · soma vector';
    this.panel.appendChild(h2);

    const stage = document.createElement('div');
    stage.className = 'brain-stage';
    this.canvas = document.createElement('canvas');
    stage.appendChild(this.canvas);
    this.overlay = document.createElement('div');
    this.overlay.className = 'brain-overlay';
    this.svg = document.createElementNS(SVGNS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('class', 'brain-leaders');
    this.overlay.appendChild(this.svg);
    stage.appendChild(this.overlay);
    this.panel.appendChild(stage);

    this.litEl = document.createElement('div');
    this.litEl.className = 'brain-lit';
    this.litEl.textContent = 'loading MRI surfaces…';
    this.panel.appendChild(this.litEl);

    // a small LIVE toggle: real-time activation glow vs. static inspect
    this.liveBtn = document.createElement('button');
    this.liveBtn.className = 'toggle brain-live-btn';
    this.liveBtn.textContent = 'LIVE';
    this.liveBtn.title = 'Glow regions by live soma activation';
    this.liveBtn.onclick = () => {
      this.live = !this.live;
      this.liveBtn.classList.toggle('off', !this.live);
    };
    h2.appendChild(this.liveBtn);

    const list = document.createElement('ul');
    list.className = 'soma-list';
    this.panel.appendChild(list);
    dashEl.insertBefore(this.panel, dashEl.firstChild);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(PALETTE.paper, 1);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.contextMat = lineMaterial(PALETTE.ink, BASE.context);

    this.buildList(list);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    this.btn = document.createElement('button');
    this.btn.className = 'toggle';
    this.btn.textContent = 'BRAIN';
    this.btn.title = 'Toggle the neuroanatomy panel';
    this.btn.onclick = () => this.toggle();
    titlebarEl.insertBefore(this.btn, titlebarEl.querySelector('.clock'));

    this.resize();
    void this.load();
  }

  // =================== load + build real meshes ===========================

  private async load(): Promise<void> {
    let bundle: Bundle;
    try {
      const res = await fetch('brain-mesh.json');
      bundle = await res.json() as Bundle;
    } catch {
      this.litEl.textContent = 'could not load brain-mesh.json';
      return;
    }
    for (const [id, data] of Object.entries(bundle.structures)) {
      this.buildStructure(id, data, bundle.roles[id] ?? 'context');
    }
    this.buildMarkers(bundle.centroids);
    this.anchors.set('cortex', new THREE.Vector3(0.72, 0.34, 0.12));
    this.buildLabels();
    this.ready = true;
    this.litEl.textContent = '';
    this.select(CHANNEL_ORDER.indexOf('amygdala'));
    this.resize();
  }

  private buildStructure(id: string, data: MeshData, role: string): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(data.p, 3));
    geo.setIndex(data.i);
    // The cortex gets an opaque paper fill that writes depth, so only the NEAR
    // surface's gyri draw (the far wall is occluded) — a clean line-drawing
    // instead of see-through wire-wool. Deep nuclei x-ray through (depthTest off).
    if (role === 'cortex') {
      const fill = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({
        color: PALETTE.paper, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      fill.renderOrder = -1;
      this.scene.add(fill);
    }
    // cortex/context read best as fold-line edges; small parts as full wireframe
    const wire = role === 'cortex' ? new THREE.EdgesGeometry(geo, 34)
      : role === 'context' ? new THREE.EdgesGeometry(geo, 34)
      : new THREE.WireframeGeometry(geo);
    geo.dispose();

    if (role === 'context') {
      const m = new THREE.LineSegments(wire, this.contextMat);
      m.renderOrder = 0;
      this.scene.add(m);
      return;
    }
    const baseKey = role === 'cortexRegion' ? 'cortexRegion' : role === 'nucleus' ? 'nucleus' : 'cortex';
    const base = BASE[baseKey]!;
    const mat = lineMaterial(PALETTE.ink, Math.max(base, 0.02));
    mat.opacity = base;
    if (role === 'nucleus') mat.depthTest = false; // deep nuclei x-ray through the cortex fill
    const m = new THREE.LineSegments(wire, mat);
    if (role === 'cortexRegion') m.scale.setScalar(1.012); // lift patches just off the pial surface
    m.renderOrder = role === 'cortex' ? 0 : role === 'nucleus' ? 5 : 1;
    this.scene.add(m);
    this.regions.set(id, { meshes: [m], mat, base, tOpacity: base });
    if (id !== 'cortex') this.anchors.set(id, new THREE.Vector3(...(this.regionCentroidFromData(data))));
  }

  private regionCentroidFromData(d: MeshData): [number, number, number] {
    let x = 0, y = 0, z = 0; const n = d.p.length / 3 || 1;
    for (let i = 0; i < d.p.length; i += 3) { x += d.p[i]!; y += d.p[i + 1]!; z += d.p[i + 2]!; }
    return [x / n, y / n, z / n];
  }

  private buildMarkers(centroids: Record<string, [number, number, number]>): void {
    for (const mk of MARKERS) {
      const c = centroids[mk.ref] ?? [0, 0, 0];
      const mat = lineMaterial(PALETTE.ink, BASE.marker);
      mat.opacity = BASE.marker;
      mat.depthTest = false; // deep brainstem nuclei x-ray through the cortex fill
      const group = new THREE.Group();
      group.renderOrder = 5;
      const meshes: THREE.LineSegments[] = [];
      const add = (sx: number) => {
        const m = new THREE.LineSegments(this.markerGeo, mat);
        m.position.set(c[0] + mk.off[0] * sx, c[1] + mk.off[1], c[2] + mk.off[2]);
        m.scale.set(mk.r[0], mk.r[1], mk.r[2]);
        m.renderOrder = 2;
        group.add(m);
        meshes.push(m);
      };
      add(1);
      if (mk.bilateral && Math.abs(mk.off[0]) > 1e-3) add(-1);
      this.scene.add(group);
      this.regions.set(mk.id, { meshes, mat, base: BASE.marker, tOpacity: BASE.marker });
      const a = meshes[0]!.position;
      this.anchors.set(mk.id, new THREE.Vector3(a.x, a.y, a.z));
    }
  }

  private buildLabels(): void {
    for (const id of this.anchors.keys()) {
      const chip = document.createElement('div');
      chip.className = 'brain-label';
      chip.textContent = REGION_NAME[id] ?? id;
      this.overlay.appendChild(chip);
      const line = document.createElementNS(SVGNS, 'line') as SVGLineElement;
      const dot = document.createElementNS(SVGNS, 'circle') as SVGCircleElement;
      dot.setAttribute('r', '2');
      this.svg.append(line, dot);
      this.labels.set(id, { chip, line, dot });
    }
  }

  private buildList(list: HTMLElement): void {
    const headerAt = new Map(GROUPS.map((g) => [g.start, g.title]));
    CHANNEL_ORDER.forEach((key, i) => {
      const ht = headerAt.get(i);
      if (ht) { const h = document.createElement('li'); h.className = 'soma-group'; h.textContent = ht; list.appendChild(h); }
      const row = document.createElement('li');
      row.className = 'soma-row';
      const label = document.createElement('span');
      label.textContent = LABELS[key];
      const b = document.createElement('b');
      b.textContent = '—';
      row.append(label, b);
      row.onclick = () => this.select(i);
      list.appendChild(row);
      this.rows.push({ key, row, b, cache: '' });
    });
  }

  // =================== selection / highlight ==============================

  selectPrev(): void { this.select(this.cursor - 1); }
  selectNext(): void { this.select(this.cursor + 1); }

  private select(i: number): void {
    this.cursor = clampNum(i, 0, CHANNEL_ORDER.length - 1) | 0;
    this.rows.forEach((r, j) => r.row.classList.toggle('sel', j === this.cursor));
    this.rows[this.cursor]?.row.scrollIntoView({ block: 'nearest' });
    this.applySelection();
  }

  private applySelection(): void {
    const ch = CHANNEL_ORDER[this.cursor]!;
    const hot = new Set(CH2REG[ch] ?? []);
    for (const [id, rv] of this.regions) {
      rv.tOpacity = hot.has(id) ? (id === 'cortex' ? CORTEX_HILITE : 1) : rv.base;
    }
    const names = [...hot].filter((id) => this.regions.has(id) || id === 'cortex').map((id) => REGION_NAME[id] ?? id);
    this.litEl.textContent = names.length ? `lit · ${names.join(' · ')}` : '';
  }

  /** live activation of an anatomical region = max over the channels that drive it. */
  private regionActivation(id: string, soma: SomaState): number {
    const chans = REGION_CHANNELS[id];
    if (!chans) return 0;
    let a = 0;
    for (const ch of chans) { const i = channelIntensity(soma, ch); if (i > a) a = i; }
    return a;
  }

  private hotColor(ch: SomaChannel, s: SomaState | undefined): THREE.Color {
    if (!s) return C.ink;
    if (ch === 'amygdala' && s.amygdala > 0.6) return C.accent;
    if (ch === 'cortisol' && s.cortisol > 1.25) return C.accent;
    if (ch === 'da_meso' && s.da_meso > 1.05) return C.good;
    if (ch === 'nacc' && s.nacc > 0.55) return C.good;
    return C.ink;
  }

  // =================== per-frame ==========================================

  update(snap: WorldSnapshot, dtReal: number): void {
    if (this.hidden) return;
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;
    if (this.ready) {
      try {
        const anyS = snap as unknown as { agents?: { soma?: SomaState }[]; focus?: number };
        const focusAgent = anyS.agents?.[anyS.focus ?? 0];
        const soma = (focusAgent?.soma ?? snap?.cashier?.soma) as SomaState | undefined;
        const ch = CHANNEL_ORDER[this.cursor]!;
        const hot = CH2REG[ch] ?? [];
        const k = 1 - Math.exp(-9 * dt);
        const ck = 1 - Math.exp(-3 * dt);
        const tint = this.hotColor(ch, soma);
        for (const [id, rv] of this.regions) {
          const cursorOn = hot.includes(id);
          // base target: the cursor-selected region(s) go opaque; others rest faint
          let target = cursorOn ? (id === 'cortex' ? CORTEX_HILITE : 1) : rv.base;
          let col = C.ink;
          // LIVE glow: every region brightens with the current activation of the
          // soma channels that drive it — the brain lights up as the psyche runs.
          if (this.live && soma) {
            const act = this.regionActivation(id, soma);
            const liveOp = rv.base + act * (id === 'cortex' ? 0.4 : 0.9);
            if (liveOp > target) target = liveOp;
            if (act > 0.28) col = THREAT_REGIONS.has(id) ? C.accent : REWARD_REGIONS.has(id) ? C.good : C.ink;
          }
          if (cursorOn) col = tint;                 // the inspected channel wins the tint
          rv.mat.opacity += (Math.min(1, target) - rv.mat.opacity) * k;
          rv.mat.depthWrite = rv.mat.opacity >= 0.55;
          rv.mat.color.lerp(col, ck);
        }
        if (soma) for (const r of this.rows) { const t = fmt(soma[r.key]); if (t !== r.cache) { r.cache = t; r.b.textContent = t; } }
      } catch { /* never break the host loop */ }
    }
    if (this.autoRot && !this.dragging) this.theta += dt * 0.16;
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    if (this.ready) this.updateLabels();
  }

  private applyCamera(): void {
    const sp = this.phi, st = this.theta, r = this.radius;
    this.camera.position.set(
      this.tgt.x + r * Math.sin(sp) * Math.cos(st),
      this.tgt.y + r * Math.cos(sp),
      this.tgt.z + r * Math.sin(sp) * Math.sin(st),
    );
    this.camera.lookAt(this.tgt);
  }

  private updateLabels(): void {
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ch = CHANNEL_ORDER[this.cursor]!;
    const lit = new Set(CH2REG[ch] ?? []);
    const v = new THREE.Vector3();
    interface Item { id: string; sx: number; sy: number; side: 'L' | 'R'; cy: number; }
    const items: Item[] = [];
    for (const id of lit) {
      const a = this.anchors.get(id);
      if (!a) continue;
      v.copy(a).project(this.camera);
      if (v.z > 1 || v.z < -1) { this.hide(id); continue; }
      const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
      items.push({ id, sx, sy, side: sx < W * 0.5 ? 'L' : 'R', cy: sy });
    }
    for (const side of ['L', 'R'] as const) {
      const col = items.filter((it) => it.side === side).sort((a, b) => a.sy - b.sy);
      let prev = -1e9;
      for (const it of col) { it.cy = Math.max(Math.min(it.sy, H - 10), prev + 16); prev = it.cy; }
    }
    const shown = new Set<string>();
    for (const it of items) {
      shown.add(it.id);
      const lab = this.labels.get(it.id);
      if (!lab) continue;
      const edgeX = it.side === 'L' ? 6 : W - 6;
      lab.chip.style.display = '';
      lab.chip.style.top = `${it.cy}px`;
      if (it.side === 'L') { lab.chip.style.left = '6px'; lab.chip.style.right = ''; lab.chip.style.textAlign = 'left'; }
      else { lab.chip.style.right = '6px'; lab.chip.style.left = ''; lab.chip.style.textAlign = 'right'; }
      lab.line.setAttribute('x1', `${it.sx}`); lab.line.setAttribute('y1', `${it.sy}`);
      lab.line.setAttribute('x2', `${edgeX}`); lab.line.setAttribute('y2', `${it.cy}`);
      lab.line.style.display = '';
      lab.dot.setAttribute('cx', `${it.sx}`); lab.dot.setAttribute('cy', `${it.sy}`);
      lab.dot.style.display = '';
    }
    for (const [id] of this.labels) if (!shown.has(id)) this.hide(id);
  }

  private hide(id: string): void {
    const lab = this.labels.get(id);
    if (!lab) return;
    lab.chip.style.display = 'none';
    lab.line.style.display = 'none';
    lab.dot.style.display = 'none';
  }

  // =================== orbit handlers =====================================

  private onPointerDown = (e: PointerEvent) => {
    this.dragging = true; this.autoRot = false;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.theta -= (e.clientX - this.lastX) * 0.008;
    this.phi = clampNum(this.phi - (e.clientY - this.lastY) * 0.008, 0.3, Math.PI - 0.3);
    this.lastX = e.clientX; this.lastY = e.clientY;
  };
  private onPointerUp = () => { this.dragging = false; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius = clampNum(this.radius * (1 + Math.sign(e.deltaY) * 0.08), 2.4, 6.5);
  };

  // =================== lifecycle ==========================================

  toggle(): void {
    this.hidden = !this.hidden;
    this.panel.style.display = this.hidden ? 'none' : '';
    this.btn.classList.toggle('off', this.hidden);
    if (!this.hidden) this.resize();
  }

  resize(): void {
    if (this.hidden) return;
    const w = Math.max(1, this.canvas.clientWidth || this.panel.clientWidth || 1);
    const h = Math.max(1, this.canvas.clientHeight || 300);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    disposeObject(this.scene);
    this.markerGeo.dispose();
    this.contextMat.dispose();
    for (const rv of this.regions.values()) rv.mat.dispose();
    this.renderer.dispose();
    this.panel.remove();
    this.btn.remove();
  }
}
