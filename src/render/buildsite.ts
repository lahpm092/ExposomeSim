// =============================================================================
// buildsite.ts — the CITY GROWS. The economy's construction firm runs build
// projects; this module turns each `Building` record into a low-poly massing
// that RISES from a poured slab as `progress` climbs, then caps out into a
// finished block when it completes. Same ink-on-sepia discipline as the rest of
// the town: paper fill that occludes cleanly + crisp ink line-work on top, built
// from the shared `fillerBlock` primitive so a new tower costs a few boxes, not
// a new material.
//
// Coordinates are real world metres (1 unit = 1 m), matching worldgeo's unified
// scale: storey pitch = 3 m, so a `floors`-storey block is `floors * 3` m tall.
// Each building is centred at (b.x, 0, b.z) with everything parented under one
// returned group, so the reconciler can add/scale/remove it as a single unit.
//
// Growth is CHEAP: the shell is one child group whose `scale.y` we drive from
// `progress` each frame (a rising shell). We only rebuild geometry when a
// building crosses the complete boundary (shell → capped block, scaffold gone).
// Materials are SHARED (owned by CityMats) and reused across every building, so
// we NEVER dispose them — only per-building geometry.
// =============================================================================
import * as THREE from 'three';
import { makeCityMats, fillerBlock } from './worldgeo';
import type { Building } from '../econ/types';

/** Shared material set (paper fill + three ink line weights + green). */
type Mats = ReturnType<typeof makeCityMats>;

const FLOOR_H = 3; // real-metre storey pitch (matches the city + interiors)

// ---------------------------------------------------------------------------
// local low-poly primitives — mirror worldgeo's PRIVATE box()/seg() (they are
// not exported). Both lean on the shared mats, so they allocate only geometry.
// ---------------------------------------------------------------------------
/** solid box: paper fill (occludes) + ink edges, base sitting on y=0. */
function solidBox(w: number, h: number, d: number, mats: Mats, edge = mats.ink): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, 0); // base on the ground
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge));
  return g;
}
/** disjoint line segments from flat [x,y,z, …] vertex pairs. */
function seg(pts: number[], mat: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}

// small guards so a malformed building record degrades to sane defaults rather
// than emitting NaN geometry (coords may be negative; dims must be positive).
const fin = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const dim = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fb);

// ---------------------------------------------------------------------------
// roof caps — the "finished" look, differentiated by kind so a housing block
// and a commercial block read apart at a glance (subtle roof/frontage change,
// not a colour change: the fill material is shared town-wide).
// ---------------------------------------------------------------------------
function addRoof(massing: THREE.Group, w: number, h: number, d: number, housing: boolean, mats: Mats): void {
  if (housing) {
    // HOUSING → a low attic cap + a chimney + a ridge line (a domestic hat).
    const cap = solidBox(w * 0.86, 0.5, d * 0.86, mats); cap.position.y = h; massing.add(cap);
    const chim = solidBox(0.5, 0.9, 0.5, mats); chim.position.set(w * 0.26, h + 0.5, -d * 0.26); massing.add(chim);
    massing.add(seg([-(w * 0.86) / 2, h + 0.52, 0, (w * 0.86) / 2, h + 0.52, 0], mats.ink)); // ridge
  } else {
    // COMMERCIAL → a flat roof with a raised parapet rim + a rooftop plant box,
    // plus a ground-floor shopfront glazing band on the front (+z) face.
    const hw = w / 2, hd = d / 2, py = h + 0.35;
    massing.add(seg([
      -hw, py, -hd, hw, py, -hd, hw, py, -hd, hw, py, hd,
      hw, py, hd, -hw, py, hd, -hw, py, hd, -hw, py, -hd,
    ], mats.soft)); // parapet rim
    const hvac = solidBox(1.4, 0.7, 1.0, mats); hvac.position.set(w * 0.18, h, -d * 0.18); massing.add(hvac);
    const z = hd + 0.02, x0 = -hw + 0.4, x1 = hw - 0.4;
    const store: number[] = [x0, 0.4, z, x1, 0.4, z, x0, 2.6, z, x1, 2.6, z]; // sill + transom
    for (const t of [0.25, 0.5, 0.75]) { const mx = x0 + (x1 - x0) * t; store.push(mx, 0.4, z, mx, 2.6, z); } // mullions
    massing.add(seg(store, mats.soft));
  }
}

/** a poured foundation slab, a touch wider than the footprint (a construction cue). */
function foundationSlab(w: number, d: number, mats: Mats): THREE.Group {
  return solidBox(w + 0.6, 0.2, d + 0.6, mats, mats.soft);
}

/** a thin scaffold frame around the plot — corner posts + ledger rings + braces,
 *  erected to the planned height. One geometry, one soft line weight = a hint. */
function scaffold(w: number, h: number, d: number, mats: Mats): THREE.LineSegments {
  const H = h + 0.5; // scaffolding overshoots the structure slightly
  const cx = w / 2 + 0.25, cz = d / 2 + 0.25;
  const corners: [number, number][] = [[cx, cz], [cx, -cz], [-cx, -cz], [-cx, cz]];
  const pts: number[] = [];
  for (const [x, z] of corners) pts.push(x, 0, z, x, H, z);            // vertical posts
  for (const y of [H * 0.5, H]) {                                     // ledger rings
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      pts.push(a[0], y, a[1], b[0], y, b[1]);
    }
  }
  // a couple of diagonal braces across the front (+z) face
  pts.push(cx, 0, cz, -cx, H * 0.5, cz, -cx, 0, cz, cx, H * 0.5, cz);
  return seg(pts, mats.soft);
}

// ---------------------------------------------------------------------------
// PUBLIC — build one building's mesh (finished OR mid-construction).
// ---------------------------------------------------------------------------
export function buildConstructedMesh(b: Building, mats: ReturnType<typeof makeCityMats>): THREE.Group {
  const group = new THREE.Group();
  const w = dim(b?.w, 4), d = dim(b?.d, 4);
  const floors = Math.max(1, Math.round(dim(b?.floors, 3)));
  const h = floors * FLOOR_H;
  const housing = b?.kind !== 'commercial'; // anything not explicitly commercial reads as housing
  const complete = !!b?.complete || fin(b?.progress, 0) >= 1;

  group.position.set(fin(b?.x, 0), 0, fin(b?.z, 0));

  // the massing shell — the child we grow. Windows on for both kinds.
  const massing = new THREE.Group();
  massing.add(fillerBlock(mats, w, h, d, true));

  if (complete) {
    addRoof(massing, w, h, d, housing, mats); // finished cap; scale.y stays 1
  } else {
    // under construction: a rising shell over a poured slab, wrapped in scaffold.
    massing.scale.y = Math.max(0.02, Math.min(1, fin(b?.progress, 0)));
    group.add(foundationSlab(w, d, mats));
    group.add(scaffold(w, h, d, mats));
  }

  group.add(massing);
  // stash cheap-update handles for the reconciler (avoid re-searching children).
  group.userData.massing = massing;
  group.userData.complete = complete;
  return group;
}

// ---------------------------------------------------------------------------
// PUBLIC — the per-frame reconciler. Mirrors citystage.ts `syncFigures`:
// a Map keyed by id, add the new, drop the gone, cheaply update the rest.
// ---------------------------------------------------------------------------
export interface ConstructionRegistry {
  groups: Map<string, THREE.Group>;
}

/** geometry-only teardown — the materials are SHARED (owned by CityMats and used
 *  by the whole city), so we must dispose buffers but NEVER touch the materials. */
function disposeGeometry(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const geo = (o as unknown as { geometry?: { dispose?: () => void } }).geometry;
    geo?.dispose?.();
  });
}

export function syncConstruction(
  scene: THREE.Scene,
  buildings: Building[],
  reg: ConstructionRegistry,
  mats: ReturnType<typeof makeCityMats>,
): void {
  const seen = new Set<string>();
  const list = Array.isArray(buildings) ? buildings : [];

  for (const b of list) {
    try {
      if (!b || typeof b.id !== 'string') continue; // skip a bad entry, don't crash the frame
      seen.add(b.id);
      const complete = !!b.complete || fin(b.progress, 0) >= 1;
      let g = reg.groups.get(b.id);

      if (!g) {
        // new building → build + park it.
        g = buildConstructedMesh(b, mats);
        scene.add(g);
        reg.groups.set(b.id, g);
      } else if (g.userData.complete !== complete) {
        // crossed the complete boundary → rebuild with the new look (rare event).
        scene.remove(g);
        disposeGeometry(g);
        g = buildConstructedMesh(b, mats);
        scene.add(g);
        reg.groups.set(b.id, g);
      }

      // cheap per-frame growth: just drive the shell's vertical scale.
      if (!complete) {
        const m = g.userData.massing as THREE.Group | undefined;
        if (m) m.scale.y = Math.max(0.02, Math.min(1, fin(b.progress, 0)));
      }
      // lots are static, but re-syncing position is O(1) and keeps us honest.
      g.position.set(fin(b.x, 0), 0, fin(b.z, 0));
    } catch {
      // a single malformed building must never take down the render loop.
    }
  }

  // remove groups whose building has vanished from the economy.
  for (const [id, g] of reg.groups) {
    if (!seen.has(id)) {
      scene.remove(g);
      disposeGeometry(g);
      reg.groups.delete(id);
    }
  }
}
