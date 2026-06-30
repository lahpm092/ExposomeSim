// =============================================================================
// palette.ts — house-style colours + tiny line-geometry helpers for the stage.
// Everything on stage is black ink line-work on warm sepia paper. No fills,
// no textures, no shadows. These helpers keep that discipline in one place.
// =============================================================================
import * as THREE from 'three';

/** Raw house-style hexes (mirror of src/ui/style.css :root). */
export const PALETTE = {
  paper: 0xe9dec4, // aged sepia ground (renderer clear colour)
  paperDeep: 0xded2b4, // recessed panels
  ink: 0x20180f, // near-black ink
  inkSoft: 0x5b4d38, // secondary ink
  inkFaint: 0x9b8a68, // gridlines / ticks
  accent: 0x7a1f12, // oxblood — alarm / peaks ONLY
  good: 0x355e3b, // deep green — contentment / reward
} as const;

/** Pre-built THREE.Color instances for lerping/tinting. */
export const C = {
  paper: new THREE.Color(PALETTE.paper),
  ink: new THREE.Color(PALETTE.ink),
  inkSoft: new THREE.Color(PALETTE.inkSoft),
  inkFaint: new THREE.Color(PALETTE.inkFaint),
  accent: new THREE.Color(PALETTE.accent),
  good: new THREE.Color(PALETTE.good),
};

/** A thin unlit line material. Always transparent so opacity can be animated. */
export function lineMaterial(color: number, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: opacity >= 0.999,
  });
}

/** Connected polyline through flat [x,y,z, x,y,z, ...] vertices. */
export function polyline(pts: number[], material: THREE.LineBasicMaterial): THREE.Line {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.Line(g, material);
}

/** Disjoint segments: vertices consumed in pairs (0–1), (2–3), … */
export function segments(pts: number[], material: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, material);
}

/** The 12 visible edges of an axis-aligned box, centred at the origin. */
export function boxEdges(
  w: number,
  h: number,
  d: number,
  material: THREE.LineBasicMaterial,
): THREE.LineSegments {
  const box = new THREE.BoxGeometry(w, h, d);
  const eg = new THREE.EdgesGeometry(box);
  box.dispose();
  return new THREE.LineSegments(eg, material);
}

/** A horizontal circle outline of unit `radius` in the XZ plane (y = 0). */
export function circleXZ(
  radius: number,
  seg: number,
  material: THREE.LineBasicMaterial,
): THREE.LineLoop {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineLoop(g, material);
}

/** Recursively dispose geometries + materials beneath an object. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const any = o as unknown as {
      geometry?: { dispose?: () => void };
      material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
    };
    any.geometry?.dispose?.();
    const m = any.material;
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.());
    else m?.dispose?.();
  });
}

/** Stable [0,1) hash of a string id (FNV-1a) — for deterministic jitter. */
export function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export const clampNum = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/** Shortest-path angular interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
