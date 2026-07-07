// =============================================================================
// streetnet.ts — the street network drawn from the ONE graph. The old
// hardcoded STREETS literal is dead: geometry here is generated from the same
// `StreetGraph` the transport sim routes over (imported read-only — pure data
// + math, the same legality as render importing econ types), built from a
// 1:1 mirror of the anchor list town.ts feeds `TransportField`. Because the
// graph is a deterministic pure function of its anchors, the drawn kerbs,
// crossings and signal masts land EXACTLY where the sim's congestion, transit
// stops and pedestrian signals live.
//
// Street furniture keeps the classic look: twin kerb lines ±1.6 m on the
// walkable core (sidewalk edges), wider ±2.0 m arterials with a dashed centre
// line out to the POIs and lots, lamps every ~9 m along the core. New:
// crosswalk bands + a signal mast with two lit phase-disc heads at every
// drawable controller — the disc state is driven per-frame from the shared
// `SignalPlan`, whose phase is a PURE function of the clock (an arithmetic
// read, no per-frame allocation; materials swap only on a phase flip).
// Controllers standing at locale centres ('place' anchors) get no mast —
// the pole would stand inside the building.
// =============================================================================
import * as THREE from 'three';
import { StreetGraph, SignalPlan } from '../transport/index';
import type { NetAnchor } from '../transport/index';
import { PLACE_LIST } from '../world/places';
import { BUILD_LOTS } from '../econ/config';
import { CITY, lamp, type CityMats } from './worldgeo';
import { PALETTE } from './palette';

const KERB_HALF = 1.6;      // sidewalk street half-width (the classic look)
const ARTERIAL_HALF = 2.0;  // the wider out-of-core roads
const LAMP_SPACING = 9;     // metres between lamps on sidewalk edges
const DASH = 2.2, GAP = 3.0; // arterial centre-line dashes
const POLE_OFF = 3.4;       // signal mast offset from the crossing centre
const HEAD_Y = 3.1;         // signal head height on the mast
const XWALK_BARS = 4;       // zebra bars per approach

/** mirror of town.ts `netAnchors()` — the five PLACES + the off-core POIs +
 *  the build lots, in the SAME order, so the graph (a pure function of the
 *  anchors) is identical to the one the sim routes over. The capture scripts
 *  assert the drawn signals coincide with `snapshot.transport.signals`. */
export function renderNetAnchors(): NetAnchor[] {
  const out: NetAnchor[] = PLACE_LIST.map((p) => ({
    id: p.id, x: (p.pos2D.x - 0.5) * CITY, z: (p.pos2D.y - 0.5) * CITY, kind: 'place',
  }));
  out.push(
    { id: 'supermarket', x: 0, z: -78, kind: 'poi' },
    { id: 'fed', x: 0, z: 112, kind: 'poi' },
    { id: 'bank', x: -50, z: 110, kind: 'poi' },
    { id: 'office', x: 26, z: 4, kind: 'poi' },
  );
  for (const l of BUILD_LOTS) out.push({ id: l.id, x: l.x, z: l.z, kind: 'lot' });
  return out;
}

/** one signal head: an ink-edged housing with a stop disc over a go disc.
 *  Disc materials are swapped by `updatePhases` (shared: lit-red / lit-green
 *  / dim), so a phase flip costs two pointer writes per head. */
interface SigHead { stop: THREE.Mesh; go: THREE.Mesh }

export interface StreetNet {
  group: THREE.Group;
  graph: StreetGraph;
  signals: SignalPlan;
  /** controller indices that got a drawn mast (open-ground crossings). */
  crossings: number[];
  /** drive the phase discs from the sim clock — pure, cheap, per-frame. */
  updatePhases(clock: number): void;
  /** min XZ distance from a point to any street centreline (filler carving). */
  distToStreet(x: number, z: number): number;
}

export function buildStreetNet(mats: CityMats): StreetNet {
  const graph = new StreetGraph(renderNetAnchors());
  const signals = new SignalPlan(graph);
  const group = new THREE.Group();

  // ---- merged line-work: one LineSegments per weight for the whole network --
  const soft: number[] = [];   // kerb/roadside lines
  const faint: number[] = [];  // dashes + crosswalk bands
  const segsFlat: { ax: number; az: number; bx: number; bz: number }[] = [];

  for (const e of graph.edges) {
    const a = graph.nodes[e.ai], b = graph.nodes[e.bi];
    segsFlat.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len, uz = dz / len;
    const half = e.sidewalk ? KERB_HALF : ARTERIAL_HALF;
    const nx = -uz * half, nz = ux * half;
    soft.push(
      a.x + nx, 0.01, a.z + nz, b.x + nx, 0.01, b.z + nz,
      a.x - nx, 0.01, a.z - nz, b.x - nx, 0.01, b.z - nz,
    );
    if (e.sidewalk) {
      // lamps down one kerb, as the old buildStreets did.
      const lampN = Math.max(1, Math.floor(len / LAMP_SPACING));
      for (let i = 1; i <= lampN; i++) {
        const t = (i / (lampN + 1)) * len;
        const L = lamp(mats);
        L.position.set(a.x + ux * t + nx, 0, a.z + uz * t + nz);
        group.add(L);
      }
    } else {
      // dashed centre line — the arterial tell.
      for (let d = GAP; d + DASH < len - GAP; d += DASH + GAP) {
        faint.push(a.x + ux * d, 0.01, a.z + uz * d, a.x + ux * (d + DASH), 0.01, a.z + uz * (d + DASH));
      }
    }
  }

  // ---- signal masts + crosswalks at open-ground controllers ----------------
  // Disc materials are SHARED across every head (three for the whole town).
  const litGo = discMat(PALETTE.good);
  const litStop = discMat(PALETTE.accent);
  const dim = discMat(PALETTE.paperDeep);

  const crossings: number[] = [];
  const heads: ({ a: SigHead; b: SigHead } | null)[] = [];
  const lastPhase: number[] = [];

  for (let i = 0; i < signals.controllers.length; i++) {
    const c = signals.controllers[i];
    const node = graph.nodes[c.nodeIdx];
    const drawable = node.kind === 'intersection' || node.anchorKind !== 'place';
    if (!drawable) { heads.push(null); lastPhase.push(-1); continue; }
    crossings.push(i);

    // zebra bands across each approach, just outside the junction box.
    for (const ei of graph.edgesAt(c.nodeIdx)) {
      const e = graph.edges[ei];
      const o = graph.nodes[graph.otherEnd(e, c.nodeIdx)];
      const dx = o.x - node.x, dz = o.z - node.z;
      const len = Math.hypot(dx, dz);
      if (len < 8) continue;                       // no band on a stub approach
      const ux = dx / len, uz = dz / len;
      const half = e.sidewalk ? KERB_HALF : ARTERIAL_HALF;
      const px = -uz * (half - 0.15), pz = ux * (half - 0.15);
      for (let k = 0; k < XWALK_BARS; k++) {
        const d = 2.6 + k * 0.6;
        faint.push(node.x + ux * d - px, 0.012, node.z + uz * d - pz,
                   node.x + ux * d + px, 0.012, node.z + uz * d + pz);
      }
    }

    // the mast on a corner: offset along the A-axis bisector so it stands
    // clear of both roadways.
    const ca = Math.cos(c.bearingA), sa = Math.sin(c.bearingA);
    const px = node.x + (ca - sa) * POLE_OFF * 0.7071;
    const pz = node.z + (sa + ca) * POLE_OFF * 0.7071;
    const mast = solidBox(0.12, HEAD_Y + 0.7, 0.12, mats);
    mast.position.set(px, 0, pz);
    group.add(mast);
    // each head hangs proud of the mast along its own facing so the two
    // housings never interpenetrate (they'd bisect each other's discs).
    const a = signalHead(mats, litStop, dim);
    a.g.position.set(px + ca * 0.24, HEAD_Y, pz + sa * 0.24);
    a.g.rotation.y = Math.atan2(ca, sa);           // face along axis A
    group.add(a.g);
    const b = signalHead(mats, dim, litGo);
    b.g.position.set(px - sa * 0.24, HEAD_Y, pz + ca * 0.24);
    b.g.rotation.y = Math.atan2(ca, sa) + Math.PI / 2;
    group.add(b.g);
    heads.push({ a: { stop: a.stop, go: a.go }, b: { stop: b.stop, go: b.go } });
    lastPhase.push(-1);
  }

  group.add(lines(soft, mats.soft));
  group.add(lines(faint, mats.faint));

  return {
    group, graph, signals, crossings,
    updatePhases(clock: number): void {
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (!h) continue;
        const ph = signals.phaseAt(i, clock);
        if (ph === lastPhase[i]) continue;         // materials swap only on a flip
        lastPhase[i] = ph;
        // phase 0 = axis A green: A shows go, B shows stop.
        h.a.go.material = ph === 0 ? litGo : dim;
        h.a.stop.material = ph === 0 ? dim : litStop;
        h.b.go.material = ph === 0 ? dim : litGo;
        h.b.stop.material = ph === 0 ? litStop : dim;
      }
    },
    distToStreet(x: number, z: number): number {
      let best = Infinity;
      for (const s of segsFlat) {
        const dx = s.bx - s.ax, dz = s.bz - s.az;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2)) : 0;
        const ex = s.ax + dx * t - x, ez = s.az + dz * t - z;
        const d = ex * ex + ez * ez;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    },
  };
}

// ---------------------------------------------------------------------------
// local primitives — mirror worldgeo's private box()/seg() (not exported).
// ---------------------------------------------------------------------------
function solidBox(w: number, h: number, d: number, mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, 0);
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), mats.ink));
  return g;
}

function lines(pts: number[], mat: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}

function discMat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}

/** an ink-edged housing with a stop disc stacked over a go disc; the caller
 *  keeps the disc handles and swaps their (shared) materials on phase flips. */
function signalHead(mats: CityMats, stopMat: THREE.Material, goMat: THREE.Material):
    { g: THREE.Group; stop: THREE.Mesh; go: THREE.Mesh } {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.36, 0.92, 0.22);
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), mats.ink));
  const disc = new THREE.CircleGeometry(0.125, 10);
  const stop = new THREE.Mesh(disc, stopMat);
  stop.position.set(0, 0.21, 0.115);
  const go = new THREE.Mesh(disc, goMat);
  go.position.set(0, -0.21, 0.115);
  g.add(stop, go);
  return { g, stop, go };
}
