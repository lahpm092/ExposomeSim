// =============================================================================
// buildsite.ts — the CITY GROWS. The economy's construction firms run build
// projects; this module turns each `Building` record into a low-poly massing
// that RISES from a poured slab as `progress` climbs, then caps out into a
// finished block when it completes. Same ink-on-sepia discipline as the rest of
// the town: paper fill that occludes cleanly + crisp ink line-work on top, built
// from the shared `fillerBlock` primitive so a new tower costs a few boxes, not
// a new material.
//
// Phase 5 — the BUSINESS WORLD (WORLD_EXPANSION.md §4, render-what's-needed):
//   • a completed building whose lease stamped an `archetype` mounts that
//     archetype kit's bespoke EXTERIOR instead of the generic block (and swaps
//     live when the lease lands after completion);
//   • an archetype's interior goods/fittings are mounted ONLY while the camera
//     is near (~70 m) AND the venue is HOT in the causal gate, and disposed the
//     moment either lapses — the cold world never pays for shelves nobody sees;
//   • venues that are COLD but in view (~120 m) breathe through the LEARNED
//     surrogate: 0-3 standing figures at the shopfront, scaled by the venue's
//     current-hour arrival shape (snapshot.causal.stats) — the town's average
//     causality, rendered;
//   • while a building is under construction a small `conyard` presence (crane,
//     fence, piles) stands at the lot edge — one per active project, sided by
//     which of the two construction firms owns it.
//
// Coordinates are real world metres (1 unit = 1 m), matching worldgeo's unified
// scale: storey pitch = 3 m, so a `floors`-storey block is `floors * 3` m tall.
// Each building is centred at (b.x, 0, b.z) with everything parented under one
// returned group, so the reconciler can add/scale/remove it as a single unit.
//
// Growth is CHEAP: the shell is one child group whose `scale.y` we drive from
// `progress` each frame (a rising shell). We only rebuild geometry when a
// building's LOOK changes (crossing complete, or an archetype appearing on
// lease). Materials are SHARED (owned by CityMats / the archetype kits' own
// singletons), so we NEVER dispose them — only per-building geometry. The
// near-set sweep (interiors + ambience) is throttled to ~4 Hz, not per-frame.
// =============================================================================
import * as THREE from 'three';
import { makeCityMats, fillerBlock } from './worldgeo';
import { getArchetype } from './archetypes/index';   // side-effect: registers all kits
import { Humanoid } from './humanoid';
import type { Building, BusinessView, ConstructionView } from '../econ/types';
import type { CausalView, VenueStatsView } from '../causal/types';

/** Shared material set (paper fill + three ink line weights + green). */
type Mats = ReturnType<typeof makeCityMats>;

const FLOOR_H = 3; // real-metre storey pitch (matches the city + interiors)

// --- render-what's-needed tuning (metres / seconds) --------------------------
const INTERIOR_NEAR = 70;   // camera distance inside which a HOT venue mounts its interior
const AMBIENCE_NEAR = 120;  // camera distance inside which a COLD venue shows surrogate figures
const SWEEP_PERIOD = 0.25;  // seconds between near-set recomputes (~4 Hz, never per-frame)
const MAX_FIGS = 3;         // ambience bodies per venue, ceiling
// bounded animation step for ambience bodies (mirrors bankcrowd's telescoping).
const DT_MIN = 0.006, DT_MAX = 0.05;

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

/** deterministic [0,1) hash of a building id (feeds ArchetypeCtx.seed + fig spots). */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 100003) / 100003;
}
/** deterministic [0,1) hash off (seed, k) — same recipe as the archetype kits. */
function h01(seed: number, k: number): number {
  const x = Math.sin(seed * 127.1 + k * 311.7 + 74.7) * 43758.5453;
  return x - Math.floor(x);
}

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
// the LOOK of a building — the key the reconciler rebuilds on:
//   'u'          under construction (rising shell + scaffold)
//   'a:<kind>'   complete + leased → the tenant archetype's bespoke exterior
//   'c'          complete, unleased shell → the generic capped block
// ---------------------------------------------------------------------------
function lookOf(b: Building): string {
  const complete = !!b?.complete || fin(b?.progress, 0) >= 1;
  if (!complete) return 'u';
  return b?.archetype && getArchetype(b.archetype) ? 'a:' + b.archetype : 'c';
}

// ---------------------------------------------------------------------------
// PUBLIC — build one building's mesh (finished, archetype-fitted, OR mid-build).
// ---------------------------------------------------------------------------
export function buildConstructedMesh(b: Building, mats: ReturnType<typeof makeCityMats>): THREE.Group {
  const group = new THREE.Group();
  const w = dim(b?.w, 4), d = dim(b?.d, 4);
  const floors = Math.max(1, Math.round(dim(b?.floors, 3)));
  const h = floors * FLOOR_H;
  const housing = b?.kind !== 'commercial' && b?.kind !== 'shopfront' && b?.kind !== 'workshop';
  const look = lookOf(b);

  group.position.set(fin(b?.x, 0), 0, fin(b?.z, 0));
  group.userData.look = look;
  group.userData.dims = { w, d };

  // complete + leased → the tenant archetype's bespoke exterior replaces the
  // generic massing wholesale. The kit's optional interior builder is stashed
  // for the near-set sweep (mounted/disposed there — render what's needed).
  if (look.startsWith('a:')) {
    try {
      const built = getArchetype(b.archetype)!({ w, d, floors, seed: hashId(b.id) });
      group.add(built.group);
      group.userData.buildInterior = built.buildInterior;
      return group;
    } catch {
      // a kit crash must not hole the city — fall through to the generic block.
      group.userData.look = 'c';
    }
  }

  // the massing shell — the child we grow. Windows on for both kinds.
  const massing = new THREE.Group();
  massing.add(fillerBlock(mats, w, h, d, true));

  if (look === 'u') {
    // under construction: a rising shell over a poured slab, wrapped in scaffold.
    massing.scale.y = Math.max(0.02, Math.min(1, fin(b?.progress, 0)));
    group.add(foundationSlab(w, d, mats));
    group.add(scaffold(w, h, d, mats));
  } else {
    addRoof(massing, w, h, d, housing, mats); // finished cap; scale.y stays 1
  }

  group.add(massing);
  // stash cheap-update handles for the reconciler (avoid re-searching children).
  group.userData.massing = massing;
  return group;
}

// ---------------------------------------------------------------------------
// the conyard presence at an active site — the crane kit parked at the lot
// edge (the building fills the lot, so the yard sits just off it), sided by
// which construction firm runs the project so the two builders read apart.
// ---------------------------------------------------------------------------
const YARD_W = 14, YARD_D = 11;   // the smallest footprint the kit lays out cleanly
function buildCrane(b: Building, ownerIdx: number): THREE.Group | undefined {
  const yard = getArchetype('conyard');
  if (!yard) return undefined;
  try {
    // seed bias: at this compact footprint the kit's crane mast can brush its
    // site-office cabin for seeds that pull the mast far left — walk the seed
    // until the mast lands clear (h01(seed,1) is the kit's mast-x draw).
    let seed = hashId(b.id) + ownerIdx * 0.317;
    for (let k = 0; k < 8 && h01(seed, 1) > 0.3; k++) seed += 0.113;
    const g = yard({ w: YARD_W, d: YARD_D, floors: 1, seed }).group;
    // park the yard beside the lot (the building fills it): builder 0 west,
    // builder 1 east — flipped toward town when the lot hugs the district edge.
    let side = ownerIdx === 1 ? 1 : -1;
    const off = dim(b.w, 24) / 2 + YARD_W / 2 + 1.2;
    if (Math.abs(fin(b.x, 0) + side * off) + YARD_W / 2 > 130) side = -side;
    g.position.set(side * off, 0, 0);
    return g;
  } catch { return undefined; }
}

/** which of the (two) construction firms owns building `id` (0 if unknown). */
function ownerIndexOf(id: string, builders: ConstructionView[] | undefined): number {
  if (!Array.isArray(builders)) return 0;
  for (let i = 0; i < builders.length; i++) {
    const bs = builders[i]?.buildings;
    if (Array.isArray(bs) && bs.some((x) => x?.id === id)) return i;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// PUBLIC — the per-frame reconciler. Mirrors citystage.ts `syncFigures`:
// a Map keyed by id, add the new, drop the gone, cheaply update the rest.
// ---------------------------------------------------------------------------
/** one pooled cold-venue ambience body (created once per building, reused). */
interface AmbFig { h: Humanoid; spot: THREE.Vector3; yaw: number; }
interface AmbCrowd { figs: AmbFig[]; live: number; }

export interface ConstructionRegistry {
  groups: Map<string, THREE.Group>;
  /** mounted near+hot interiors, by building id (children of their group). */
  interiors: Map<string, THREE.Group>;
  /** conyard presences at active sites, by building id (children of their group). */
  cranes: Map<string, THREE.Group>;
  /** pooled cold-venue ambience bodies, by building id (scene-level). */
  crowds: Map<string, AmbCrowd>;
  /** seconds until the next near-set sweep (~4 Hz throttle). */
  cooldown: number;
}

export function makeConstructionRegistry(): ConstructionRegistry {
  return { groups: new Map(), interiors: new Map(), cranes: new Map(), crowds: new Map(), cooldown: 0 };
}

/** what the stage knows that the reconciler needs (one persistent object —
 *  the caller mutates its fields each frame; nothing here is retained). */
export interface WorldRenderCtx {
  camPos: THREE.Vector3;            // camera world position
  hourOfDay: number;                // 0..23 sim hour (indexes the learned hourShape)
  dt: number;                       // real seconds this frame (throttle + body ticks)
  causal?: CausalView;              // hot set + learned surrogate (may be absent)
  businesses?: BusinessView[];      // for the hot-venue join (business → archetype)
  builders?: ConstructionView[];    // both construction firms (crane ownership)
  forceHot?: boolean;               // dev/capture: treat every venue as hot
}

/** geometry-only teardown — the materials are SHARED (owned by CityMats / the
 *  archetype kits' singletons), so we dispose buffers but NEVER the materials. */
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
  world?: WorldRenderCtx,
): void {
  const seen = new Set<string>();
  const list = Array.isArray(buildings) ? buildings : [];
  // the crane joins the scaffold only when BOTH construction firms exist
  // (phase-5 snapshots); legacy single-builder snapshots keep the old look.
  const wantCranes = (world?.builders?.length ?? 0) >= 2;

  for (const b of list) {
    try {
      if (!b || typeof b.id !== 'string') continue; // skip a bad entry, don't crash the frame
      const look = lookOf(b);
      seen.add(b.id);
      let g = reg.groups.get(b.id);

      if (!g) {
        // new building → build + park it.
        g = buildConstructedMesh(b, mats);
        scene.add(g);
        reg.groups.set(b.id, g);
      } else if (g.userData.look !== look) {
        // crossed the complete boundary, or a lease fitted an archetype after
        // completion → swap the mesh (rare event). Anything mounted ON the old
        // group (interior, crane) goes with it; drop their registry handles.
        const it = reg.interiors.get(b.id);
        if (it) { disposeGeometry(it); reg.interiors.delete(b.id); }
        reg.cranes.delete(b.id);
        scene.remove(g);
        disposeGeometry(g);
        g = buildConstructedMesh(b, mats);
        scene.add(g);
        reg.groups.set(b.id, g);
      }

      if (look === 'u') {
        // cheap per-frame growth: just drive the shell's vertical scale.
        const m = g.userData.massing as THREE.Group | undefined;
        if (m) m.scale.y = Math.max(0.02, Math.min(1, fin(b.progress, 0)));
        // an ACTIVE project gets its builder's conyard presence at the lot edge.
        if (wantCranes && !reg.cranes.has(b.id)) {
          const crane = buildCrane(b, ownerIndexOf(b.id, world?.builders));
          if (crane) { g.add(crane); reg.cranes.set(b.id, crane); }
        }
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
      const it = reg.interiors.get(id);
      if (it) { disposeGeometry(it); reg.interiors.delete(id); }
      reg.cranes.delete(id);
      const c = reg.crowds.get(id);
      if (c) {
        for (const f of c.figs) { scene.remove(f.h.object); f.h.dispose(); }
        reg.crowds.delete(id);
      }
    }
  }

  if (world) sweepNearWorld(scene, list, reg, world);
}

// =============================================================================
// the NEAR-WORLD sweep — interiors for hot venues the camera can see, learned
// ambience for the cold ones. Bodies tick every frame (cheap: only live ones);
// the SET recomputes at ~4 Hz.
//
// THE HOT-VENUE JOIN: snapshot.causal.hot carries BUSINESS ids, but the
// snapshot exposes no business→building link (BusinessView has no
// premisesUnitId; PremisesView is counts only). Both sides DO carry the lease's
// `archetype` stamp, so we join through it: a building is treated as hot when
// ANY hot business shares its archetype. Exact for distinct archetypes (the
// common case); when two same-archetype venues coexist this over-approximates,
// and the ≤70 m camera gate keeps the cost bounded anyway. With no causal
// snapshot at all we fall back to camera distance alone.
// =============================================================================
const MOODS = ['polite', 'neutral', 'impatient'] as const;

function sweepNearWorld(
  scene: THREE.Scene,
  list: Building[],
  reg: ConstructionRegistry,
  world: WorldRenderCtx,
): void {
  try {
    // per-frame: integrate the live ambience bodies (bounded step, like bankcrowd).
    const dt = world.dt > 0 ? Math.min(Math.max(world.dt, DT_MIN), DT_MAX) : 0;
    for (const c of reg.crowds.values()) {
      for (let i = 0; i < c.live; i++) c.figs[i].h.tick(dt);
    }

    reg.cooldown -= world.dt;
    if (reg.cooldown > 0) return;
    reg.cooldown = SWEEP_PERIOD;

    // --- the archetype join tables (tiny: a handful of venues) ---------------
    const archOfBiz = new Map<string, string>();
    if (Array.isArray(world.businesses)) {
      for (const bv of world.businesses) if (bv?.archetype) archOfBiz.set(bv.id, bv.archetype);
    }
    const hotArch = new Set<string>();
    if (world.causal && Array.isArray(world.causal.hot)) {
      for (const id of world.causal.hot) {
        const a = archOfBiz.get(id);
        if (a) hotArch.add(a);
      }
    }
    // learned surrogate per archetype: the most-visited venue's stats speak.
    const statsByArch = new Map<string, VenueStatsView>();
    if (world.causal && Array.isArray(world.causal.stats)) {
      for (const sv of world.causal.stats) {
        const a = archOfBiz.get(sv.venueId);
        if (!a) continue;
        const cur = statsByArch.get(a);
        if (!cur || sv.visits > cur.visits) statsByArch.set(a, sv);
      }
    }
    const hour = Math.min(23, Math.max(0, world.hourOfDay | 0));

    for (const b of list) {
      if (!b || typeof b.id !== 'string') continue;
      const g = reg.groups.get(b.id);
      const look = g?.userData.look as string | undefined;
      if (!g || !look || !look.startsWith('a:')) continue;   // only archetype-fitted venues
      const arch = look.slice(2);
      const dx = world.camPos.x - g.position.x, dz = world.camPos.z - g.position.z;
      const dist = Math.hypot(dx, dz);
      // hot: the causal gate's word when we have it, camera proximity otherwise.
      const hot = world.forceHot === true
        || (world.causal ? hotArch.has(arch) : dist <= INTERIOR_NEAR);

      // ---- interior: mounted ONLY near AND hot; disposed the moment not -----
      const wantInterior = dist <= INTERIOR_NEAR && hot;
      const mounted = reg.interiors.get(b.id);
      if (wantInterior && !mounted) {
        const mk = g.userData.buildInterior as (() => THREE.Group) | undefined;
        if (mk) {
          try {
            const it = mk();
            g.add(it);
            reg.interiors.set(b.id, it);
          } catch { /* a kit crash must not hole the frame */ }
        }
      } else if (!wantInterior && mounted) {
        g.remove(mounted);
        disposeGeometry(mounted);
        reg.interiors.delete(b.id);
      }

      // ---- cold-venue ambience: the learned average causality, standing there
      let want = 0;
      if (!hot && dist <= AMBIENCE_NEAR) {
        const sv = statsByArch.get(arch);
        const shape = sv?.hourShape;
        if (shape && shape.length === 24) {
          const rel = shape[hour] * 24;   // 1 = the flat prior's hourly average
          want = rel < 0.45 ? 0 : rel < 1.25 ? 1 : rel < 2.3 ? 2 : MAX_FIGS;
        }
      }
      setCrowd(scene, reg, b, want);
    }
  } catch { /* cosmetic layer: never break the render loop */ }
}

/** grow/shrink one venue's pooled standing figures to `n` (bodies are created
 *  once and re-added; full disposal only happens when the building vanishes). */
function setCrowd(scene: THREE.Scene, reg: ConstructionRegistry, b: Building, n: number): void {
  let c = reg.crowds.get(b.id);
  if (!c) {
    if (n <= 0) return;
    c = { figs: [], live: 0 };
    reg.crowds.set(b.id, c);
  }
  if (n === c.live) return;
  while (c.figs.length < n) c.figs.push(makeAmbFig(b, c.figs.length));
  for (let i = c.live; i < n; i++) {           // spawn up
    const f = c.figs[i];
    f.h.place(f.spot, f.yaw);
    f.h.snapScale(1);
    f.h.setActivity('stand');
    scene.add(f.h.object);
  }
  for (let i = n; i < c.live; i++) scene.remove(c.figs[i].h.object);  // cull down
  c.live = n;
}

/** one standing figure by the shopfront: a deterministic spot on the front
 *  apron (every kit's facade sits at ≈ d/2 − 2.5, so the strip just outside it
 *  stays clear of the walls), mostly facing the shop window. */
function makeAmbFig(b: Building, i: number): AmbFig {
  const s = hashId(b.id) * 91.7 + i * 13.13;
  const w = dim(b.w, 24), d = dim(b.d, 18);
  const spot = new THREE.Vector3(
    fin(b.x, 0) + (h01(s, 1) - 0.5) * w * 0.42,
    0,
    fin(b.z, 0) + d / 2 - 0.6 - h01(s, 2) * 1.6,
  );
  const yaw = Math.PI + (h01(s, 3) - 0.5) * 1.3;   // ± toward the facade (−z)
  const h = new Humanoid('npc');
  h.setPose(MOODS[(h01(s, 4) * MOODS.length) | 0], 1 - h01(s, 5) * 0.4);
  return { h, spot, yaw };
}
