// =============================================================================
// goodsassets.ts — SHARED low-poly goods + small helpers for the business
// archetype kits. Everything is built through the house kit (paper fill that
// occludes + crisp ink edges) at REAL metres, and each asset keeps to ~40 tris
// (a kit box is 12) so archetypes can clone them freely for window displays and
// interiors. Colour discipline mirrors supermarket.ts: fills stay paper; accent
// hexes below enter ONLY as edge line-work, deliberately desaturated to sit on
// the sepia stage.
//
// Also here: the lazy shared CityMats/Kit the archetype modules draw from, a
// deterministic seed hash (no Math.random anywhere in the kits), an extruded
// `prism` for bespoke rooflines (gambrel / sawtooth), and a stroke-font
// `inscribe` (grown from civicbank.ts's) for fascia signage.
// =============================================================================
import * as THREE from 'three';
import { makeKit, type Kit, type Tone } from '../kit';
import { makeCityMats, type CityMats } from '../worldgeo';

// ---------------------------------------------------------------------------
// shared materials + kit (one set for every archetype — state stays cheap).
// ---------------------------------------------------------------------------
let MATS: CityMats | null = null;
export function archMats(): CityMats {
  if (!MATS) MATS = makeCityMats();
  return MATS;
}
let KIT: Kit | null = null;
export function archKit(): Kit {
  if (!KIT) KIT = makeKit(archMats());
  return KIT;
}

/** deterministic [0,1) hash off (seed, k) — the ONLY variation source allowed. */
export function h01(seed: number, k: number): number {
  const x = Math.sin(seed * 127.1 + k * 311.7 + 74.7) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// muted accent tones (edge line-work only; fills stay paper).
// ---------------------------------------------------------------------------
export const TONE = {
  bread:   0xa9762f, // warm sand/amber — bakery crust
  oxblood: 0x7f3325, // butcher stripes / hanging cuts
  leaf:    0x4f6a34, // greengrocer greens
  tomato:  0x8f3a2c, // red produce
  amber:   0x9c7b3a, // amber produce / grain / hazard
  cream:   0xb0a170, // dairy pale cream
  timber:  0x8a6b42, // sawdust-warm wood
  indigo:  0x3a4664, // tailor deep indigo
  teal:    0x3f6b76, // rival-market cool accent
  steel:   0x6e6f72, // light-industrial grey
} as const;

const tintCache = new Map<number, THREE.LineBasicMaterial>();
/** cached LineBasicMaterial for an accent hex (edges only, never fills). */
export function tint(hex: number): THREE.LineBasicMaterial {
  let m = tintCache.get(hex);
  if (!m) { m = new THREE.LineBasicMaterial({ color: hex }); tintCache.set(hex, m); }
  return m;
}

/** paper-filled box whose EDGES carry an accent hex (supermarket.ts's trick).
 *  Base sits on y; centred in x/z. Pass fill:false for edge-only ghosts. */
export function tintBox(
  w: number, h: number, d: number, x: number, y: number, z: number,
  hex: number, fill = true,
): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, h / 2, 0);
  if (fill) g.add(new THREE.Mesh(geo, archMats().fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), tint(hex)));
  g.position.set(x, y, z);
  return g;
}

/** disjoint accent-tinted line segments from flat [x,y,z, …] pairs. */
export function tintLine(pts: number[], hex: number): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, tint(hex));
}

/** paper-filled extruded polygon (cross-section in x–y, closed, extruded along
 *  z by `depth`, recentred so z spans ±depth/2). For gambrel barns, sawtooth
 *  roofs, canted bays — the bespoke silhouettes kit.wedge can't reach. */
export function prism(
  pts: Array<[number, number]>, depth: number,
  o?: { edge?: Tone; hex?: number; fill?: boolean },
): THREE.Group {
  const mats = archMats();
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, -depth / 2);
  const g = new THREE.Group();
  if (o?.fill !== false) g.add(new THREE.Mesh(geo, mats.fill));
  const edge = o?.hex !== undefined ? tint(o.hex) : archKit().mat(o?.edge ?? 'ink');
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge));
  return g;
}

/** the four edges of an axis-aligned rectangle in the XY plane at depth z. */
export function rectXY(x0: number, x1: number, y0: number, y1: number, z: number): number[] {
  return [
    x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z,
    x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z,
  ];
}

/** an arc of chords in the XY plane at depth z, centred (cx,cy), a0→a1. */
export function arcXY(
  cx: number, cy: number, r: number, a0: number, a1: number, seg: number, z: number,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const t0 = a0 + (a1 - a0) * (i / seg), t1 = a0 + (a1 - a0) * ((i + 1) / seg);
    pts.push(cx + Math.cos(t0) * r, cy + Math.sin(t0) * r, z,
      cx + Math.cos(t1) * r, cy + Math.sin(t1) * r, z);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// stroke font + inscribe — grown from civicbank.ts's frieze lettering so every
// shop fascia shares one voice. Unit cell x,y ∈ [0,1]; 4 numbers per segment.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  ' ': [],
  '-': [0.2, 0.5, 0.8, 0.5],
  A: [0, 0, 0.5, 1, 0.5, 1, 1, 0, 0.2, 0.42, 0.8, 0.42],
  B: [0, 0, 0, 1, 0, 1, 0.72, 1, 0, 0.55, 0.72, 0.55, 0, 0, 0.72, 0,
    0.72, 1, 0.96, 0.8, 0.96, 0.8, 0.72, 0.55, 0.72, 0.55, 0.96, 0.3, 0.96, 0.3, 0.72, 0],
  C: [1, 1, 0.2, 1, 0.2, 1, 0, 0.8, 0, 0.8, 0, 0.2, 0, 0.2, 0.2, 0, 0.2, 0, 1, 0],
  D: [0, 0, 0, 1, 0, 1, 0.6, 1, 0, 0, 0.6, 0, 0.6, 1, 1, 0.72, 1, 0.72, 1, 0.28, 1, 0.28, 0.6, 0],
  E: [0, 0, 0, 1, 0, 1, 1, 1, 0, 0.55, 0.72, 0.55, 0, 0, 1, 0],
  F: [0, 0, 0, 1, 0, 1, 1, 1, 0, 0.55, 0.72, 0.55],
  G: [1, 1, 0.2, 1, 0.2, 1, 0, 0.8, 0, 0.8, 0, 0.2, 0, 0.2, 0.2, 0, 0.2, 0, 1, 0,
    1, 0, 1, 0.45, 1, 0.45, 0.55, 0.45],
  H: [0, 0, 0, 1, 1, 0, 1, 1, 0, 0.5, 1, 0.5],
  I: [0.5, 0, 0.5, 1, 0.3, 1, 0.7, 1, 0.3, 0, 0.7, 0],
  K: [0, 0, 0, 1, 0, 0.5, 1, 1, 0, 0.5, 1, 0],
  L: [0, 0, 0, 1, 0, 0, 1, 0],
  M: [0, 0, 0, 1, 0, 1, 0.5, 0.4, 0.5, 0.4, 1, 1, 1, 1, 1, 0],
  N: [0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1],
  O: [0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0],
  P: [0, 0, 0, 1, 0, 1, 0.9, 1, 0.9, 1, 0.9, 0.5, 0.9, 0.5, 0, 0.5],
  R: [0, 0, 0, 1, 0, 1, 0.7, 1, 0.7, 1, 1, 0.75, 1, 0.75, 0.72, 0.55,
    0, 0.55, 0.72, 0.55, 0.4, 0.55, 1, 0],
  S: [1, 1, 0, 1, 0, 1, 0, 0.55, 0, 0.55, 1, 0.55, 1, 0.55, 1, 0, 1, 0, 0, 0],
  T: [0, 1, 1, 1, 0.5, 1, 0.5, 0],
  U: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1],
  V: [0, 1, 0.5, 0, 0.5, 0, 1, 1],
  W: [0, 1, 0.25, 0, 0.25, 0, 0.5, 0.55, 0.5, 0.55, 0.75, 0, 0.75, 0, 1, 1],
  Y: [0, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0],
};

/** signage lettering centred on cx, sitting on the plane z, letters cw×ch.
 *  Pass hex for accent-tinted strokes; else a Tone. Faces +z (rotate a parent
 *  group for other faces). */
export function inscribe(
  text: string, cx: number, y: number, z: number,
  cw: number, ch: number, gap: number, o?: { tone?: Tone; hex?: number },
): THREE.LineSegments {
  const pitch = cw + gap;
  const total = text.length * pitch - gap;
  let sx = cx - total / 2;
  const pts: number[] = [];
  for (const c of text) {
    const strokes = FONT[c] ?? [];
    for (let i = 0; i < strokes.length; i += 4) {
      pts.push(sx + strokes[i] * cw, y + strokes[i + 1] * ch, z,
        sx + strokes[i + 2] * cw, y + strokes[i + 3] * ch, z);
    }
    sx += pitch;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = o?.hex !== undefined ? tint(o.hex) : archKit().mat(o?.tone ?? 'faint');
  return new THREE.LineSegments(geo, mat);
}

// =============================================================================
//  GOODS — each a group, base on y=0, centred in x/z, ≤ ~40 tris. Cloneable.
// =============================================================================

/** a bread display: tray + two crusty loaves + a leaning pair of baguettes. */
export function breadLoaves(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  g.add(kit.boxAt(0.9, 0.06, 0.5, 0, 0, 0, { edge: 'soft' }));                 // tray
  g.add(tintBox(0.30, 0.16, 0.20, -0.22, 0.06, -0.08, TONE.bread));            // loaf
  g.add(tintBox(0.26, 0.14, 0.18, 0.14, 0.06, 0.10, TONE.bread));              // loaf
  g.add(tintBox(0.22, 0.12, 0.16, 0.26, 0.06, -0.12, TONE.bread, false));      // ghost loaf
  for (const [bx, rz] of [[0.05, 0.28], [0.16, 0.18]] as const) {              // baguettes, leaning
    const b = tintBox(0.07, 0.62, 0.07, 0, 0, 0, TONE.bread, false);
    b.position.set(bx - 0.35, 0.05, rz - 0.1); b.rotation.z = 0.35; b.rotation.y = 0.3;
    g.add(b);
  }
  // score lines across the loaf tops
  g.add(kit.line([-0.30, 0.23, -0.08, -0.14, 0.23, -0.08, 0.08, 0.21, 0.10, 0.20, 0.21, 0.10], 'soft'));
  return g;
}

/** a produce crate: timber box + a heaped fill of the given accent tone. */
export function produceCrate(tone: number): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  g.add(tintBox(0.52, 0.30, 0.42, 0, 0, 0, TONE.timber));                      // crate
  g.add(kit.line([-0.26, 0.10, 0.212, 0.26, 0.10, 0.212, -0.26, 0.20, 0.212, 0.26, 0.20, 0.212], 'faint')); // slats
  g.add(tintBox(0.44, 0.14, 0.34, 0, 0.28, 0, tone));                          // heap
  for (const [px, pz] of [[-0.12, 0.05], [0.10, -0.06], [0.02, 0.10]] as const) {
    const geo = new THREE.IcosahedronGeometry(0.055, 0); geo.translate(px, 0.46, pz);
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), tint(tone))); // bumps (edge-only)
  }
  return g;
}

/** a shelf of cloth bolts — stacked rolls in tailor tones, slightly skewed. */
export function clothBolts(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  g.add(kit.boxAt(1.05, 0.08, 0.4, 0, 0, 0, { edge: 'soft' }));                // shelf board
  const tones = [TONE.indigo, TONE.oxblood, TONE.leaf, TONE.indigo];
  for (let i = 0; i < 4; i++) {
    const b = tintBox(0.92, 0.10, 0.14, 0, 0, 0, tones[i], i < 2);             // top two ghosted? no: bottom two filled
    b.position.set((i % 2) * 0.06 - 0.03, 0.08 + i * 0.10, (i % 2) * 0.16 - 0.08);
    b.rotation.y = (i - 1.5) * 0.06;
    g.add(b);
  }
  return g;
}

/** a huddle of milk cans (two solid, one ghost) with necks + lids. */
export function milkCans(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  for (const [cx, cz, solid] of [[-0.2, 0.05, 1], [0.16, -0.08, 1], [0.05, 0.24, 0]] as const) {
    const geo = new THREE.CylinderGeometry(0.16, 0.16, 0.5, 5); geo.translate(cx, 0.25, cz);
    const c = new THREE.Group();
    if (solid) c.add(new THREE.Mesh(geo, archMats().fill));
    c.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), tint(TONE.cream)));
    g.add(c);
    g.add(kit.cylAt(0.08, 0.12, 5, cx, 0.5, cz, { edge: 'soft', fill: false })); // neck
    g.add(kit.knob(0.09, cx, 0.66, cz, { edge: 'soft', fill: false }));          // lid
  }
  return g;
}

/** a stack of dressed planks, two crossed courses + a banding strap. */
export function plankStack(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  g.add(tintBox(1.3, 0.14, 0.6, 0, 0, 0, TONE.timber));
  const top = tintBox(1.2, 0.13, 0.5, 0, 0, 0, TONE.timber);
  top.position.y = 0.14; top.rotation.y = 0.09; g.add(top);
  const pts: number[] = [];
  for (const px of [-0.45, -0.15, 0.15, 0.45]) pts.push(px, 0.278, -0.24, px, 0.278, 0.24); // plank gaps
  pts.push(-0.3, 0, 0.31, -0.3, 0.28, 0.31, 0.3, 0, 0.31, 0.3, 0.28, 0.31);                 // strap
  g.add(kit.line(pts, 'faint'));
  return g;
}

/** one finished chair — the furniture-maker's window piece. */
export function chairPiece(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  g.add(tintBox(0.46, 0.06, 0.44, 0, 0.42, 0, TONE.timber));                   // seat
  const back = tintBox(0.44, 0.52, 0.05, 0, 0.48, -0.2, TONE.timber);
  back.rotation.x = 0.08; g.add(back);
  const legs: number[] = [];
  for (const [lx, lz] of [[-0.19, -0.18], [0.19, -0.18], [-0.19, 0.18], [0.19, 0.18]] as const)
    legs.push(lx, 0, lz, lx, 0.42, lz);
  legs.push(-0.19, 0.2, -0.18, -0.19, 0.2, 0.18, 0.19, 0.2, -0.18, 0.19, 0.2, 0.18); // stretchers
  g.add(kit.line(legs, 'ink'));
  return g;
}

/** a butcher's rail of hanging cuts: bar + hooks + three sides of meat. */
export function hangingCuts(): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  const RY = 2.05;                                                             // rail height
  g.add(kit.line([-0.75, RY, 0, 0.75, RY, 0], 'ink'));                          // rail
  const cuts = [[-0.5, 0.34, 0.16, 1], [0.0, 0.44, 0.18, 1], [0.5, 0.30, 0.15, 0]] as const;
  for (const [cx, ch, cw, solid] of cuts) {
    const top = RY - 0.16;
    g.add(kit.line([cx, RY, 0, cx, top, 0], 'soft'));                           // hook drop
    g.add(tintBox(cw, ch, cw * 0.7, cx, top - ch, 0, TONE.oxblood, solid === 1));
  }
  return g;
}

/** a freestanding retail shelf module (market2's own — NOT the supermarket
 *  gondola): open steel frame, three shelves, goods cubes in one accent tone. */
export function shelfModule(goodsTone: number): THREE.Group {
  const kit = archKit();
  const g = kit.group();
  const W = 1.8, D = 0.5, H = 1.7;
  g.add(kit.boxAt(W, 0.1, D, 0, 0, 0, { edge: 'soft' }));                       // kick base
  for (const sx of [-W / 2 + 0.03, W / 2 - 0.03])                               // uprights (edge-only)
    g.add(kit.boxAt(0.06, H, D, sx, 0.1, 0, { edge: 'ink', fill: false }));
  for (const sy of [0.55, 1.1, H]) g.add(kit.slab(W, D, 0, sy, 0, { edge: 'soft' })); // shelves
  const pool: [number, number, number][] = [[0.26, 0.3, 0.2], [0.34, 0.22, 0.24], [0.2, 0.36, 0.18], [0.3, 0.26, 0.22]];
  let k = 0;
  for (const sy of [0.12, 0.58, 1.13]) for (const gx of [-0.55, 0.05, 0.6]) {
    const [w, h, d] = pool[k++ % pool.length];
    g.add(tintBox(w, h, d, gx, sy, 0, goodsTone, k % 3 !== 0));                 // every 3rd is a ghost
  }
  return g;
}
