// =============================================================================
// transitlife.ts — the transport layer EMBODIED, straight from the snapshot's
// TransportView. Four sights, all mounted only when hot/near and disposed when
// cold (the BankCrowd spawn/dispose discipline, 4 Hz sweeps):
//
//   BUSES  — kit-style low-poly bodies gliding each transit route on pure
//            schedule-time (the fleet's own ping-pong math replicated from the
//            route polyline, so positions are continuous in the clock: a
//            cold→hot flip mounts a bus exactly where the schedule says it is —
//            no teleport pops, no per-frame integration while cold).
//   TRIPS  — taxi/car bodies for in-flight journeys. View positions refresh on
//            the econ tick, so bodies CHASE their targets smoothly between
//            ticks; the protagonist's own ride tracks her body every frame.
//   QUEUES — waiting riders at served stops, one Humanoid per waiting unit
//            (capped), lined up at a stop-sign prop off the stop node.
//   CROSSERS — walkers at HOT signalised crossings who obey the SAME
//            SignalPlan the sim's pedestrians do (pure clock function):
//            they hold the kerb on red and cross on green.
//
// Everything is cosmetic — this layer owns its bodies, reads the snapshot,
// and never touches the sim. Bodies are pooled and reused; per-frame work is
// O(live entities) with ~zero allocation (scratch vectors reused). Vehicle
// groups are repositioned every frame — nothing here relies on a cached
// localToWorld (the static-matrix rule is for buildings, not vehicles).
// Deterministic idiom: no Math.random — placement jitter comes from hash01.
// =============================================================================
import * as THREE from 'three';
import { MODE_PARAMS } from '../transport/index';
import type { ModeId, TransportView, XZ } from '../transport/index';
import { Humanoid } from './humanoid';
import { hash01, lerpAngle } from './palette';
import { parkedCar, type CityMats } from './worldgeo';
import type { StreetNet } from './streetnet';

const V = THREE.Vector3;

// --- tuning (metres / seconds) ----------------------------------------------
const SWEEP_PERIOD = 0.25;  // seconds between near-set sweeps (~4 Hz)
const VEH_NEAR = 90;        // camera radius inside which a vehicle body mounts
const STOP_NEAR = 65;       // camera radius for stop queues / crossers
const HYST = 12;            // extra slack before culling (no edge flicker)
const MAX_QUEUE = 5;        // bodies per stop queue, ceiling
const MAX_CROSSINGS = 4;    // hot crossings dressed with walkers at once
const DT_MIN = 0.006, DT_MAX = 0.05; // bounded ambient step (bankcrowd's telescoping)
const WALK_MS = 1.35;       // crosser amble, real m/s (ambient layers run real-time)
const KERB_T = 2.6;         // crossing kerb line along the walk axis
const CROSS_L = 7.5;        // walk-axis half-extent of a crosser's shuttle
/** mirror of transitplan.ts DWELL_H — the schedule-time replica needs it to
 *  derive cycleH from the view's polyline (RouteView carries no cycle). */
const DWELL_H = 0.011;

const mod1 = (x: number): number => x - Math.floor(x);
const distXZ = (p: THREE.Vector3, x: number, z: number): number => Math.hypot(p.x - x, p.z - z);

/** primary mode of an in-flight trip by traveler id (null when not riding). */
export function rideModeOf(view: TransportView | undefined, travelerId: string): ModeId | null {
  if (!view) return null;
  for (const t of view.trips) if (t.travelerId === travelerId) return t.mode;
  return null;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------
interface BusRec { g: THREE.Group; live: boolean; yaw: number }
interface RouteRec {
  sig: string;
  poly: XZ[]; cum: number[]; lengthM: number; cycleH: number;
  buses: BusRec[];
}
interface TripRec {
  mode: 'car' | 'taxi';
  body: THREE.Group | null;
  cur: THREE.Vector3; tx: number; tz: number;
  yaw: number; follow: boolean; seen: boolean;
}
interface StopRec {
  x: number; z: number;
  ux: number; uz: number;          // queue direction (along the first street)
  sign: THREE.Group | null;
  figs: Humanoid[]; live: number;
}
interface Crosser { h: Humanoid; t: number; sgn: 1 | -1; off: number; hold: number }
interface CrossRec { ci: number; figs: Crosser[] }

export class TransitLife {
  /** dev/capture: mount every body regardless of camera distance. */
  forceHot = false;

  private readonly routes = new Map<string, RouteRec>();
  private readonly trips = new Map<string, TripRec>();
  private readonly stops = new Map<string, StopRec>();
  private readonly crossers = new Map<number, CrossRec>();
  private readonly poolCar: THREE.Group[] = [];
  private readonly poolTaxi: THREE.Group[] = [];
  private readonly poolBus: THREE.Group[] = [];
  private cooldown = 0;
  private readonly _p = new V();   // scratch (never retained)

  constructor(private scene: THREE.Scene, private mats: CityMats, private net: StreetNet) {}

  /** Per frame. `clock` is absolute sim-hours (drives schedule-time), `dtReal`
   *  real seconds (drives ambient bodies). `protagonist` is the followed
   *  traveler's live body position — her ride tracks it fresh each frame
   *  instead of the tick-stale trip coordinate. Never throws. */
  update(view: TransportView | undefined, clock: number, camPos: THREE.Vector3,
         dtReal: number, protagonist: { id: string; x: number; z: number } | null): void {
    const dt = dtReal > 0 ? Math.min(Math.max(dtReal, DT_MIN), DT_MAX) : 0;
    try {
      this.cooldown -= dtReal;
      if (view && this.cooldown <= 0) {
        this.cooldown = SWEEP_PERIOD;
        this.sweepRoutes(view, clock, camPos);
        this.sweepTrips(view, camPos, protagonist);
        this.sweepStops(view, camPos);
        this.sweepCrossings(view, camPos);
      }
      this.stepBuses(clock);
      this.stepTrips(dt, protagonist);
      this.stepCrossers(clock, dt);
      for (const s of this.stops.values()) for (let i = 0; i < s.live; i++) s.figs[i].tick(dt);
    } catch { /* cosmetic layer: never break the render loop */ }
  }

  dispose(): void {
    for (const r of this.routes.values()) for (const b of r.buses) if (b.live) this.scene.remove(b.g);
    for (const t of this.trips.values()) if (t.body) this.scene.remove(t.body);
    for (const s of this.stops.values()) {
      if (s.sign) this.scene.remove(s.sign);
      for (const f of s.figs) { this.scene.remove(f.object); f.dispose(); }
    }
    for (const c of this.crossers.values()) for (const f of c.figs) { this.scene.remove(f.h.object); f.h.dispose(); }
    this.routes.clear(); this.trips.clear(); this.stops.clear(); this.crossers.clear();
  }

  // ---------------------------------------------------------------------------
  // BUSES — schedule-time replicas of the fleet's ping-pong (pure in the clock)
  // ---------------------------------------------------------------------------
  private sweepRoutes(view: TransportView, clock: number, camPos: THREE.Vector3): void {
    const seen = new Set<string>();
    for (const r of view.routes) {
      seen.add(r.id);
      const sig = `${r.poly.length}:${r.vehicles.length}:${r.stops.join('|')}`;
      let rec = this.routes.get(r.id);
      if (!rec || rec.sig !== sig) {
        if (rec) this.releaseRoute(rec);
        const cum: number[] = [0];
        for (let i = 1; i < r.poly.length; i++) {
          cum.push(cum[i - 1] + Math.hypot(r.poly[i].x - r.poly[i - 1].x, r.poly[i].z - r.poly[i - 1].z));
        }
        const lengthM = cum[cum.length - 1] ?? 0;
        const rideH = lengthM / MODE_PARAMS.bus.speed;
        const cycleH = Math.max(2 * (rideH + Math.max(0, r.stops.length - 2) * DWELL_H) + 2 * DWELL_H, 0.02);
        rec = { sig, poly: r.poly, cum, lengthM, cycleH, buses: [] };
        for (let v = 0; v < r.vehicles.length; v++) rec.buses.push({ g: this.takeBus(), live: false, yaw: 0 });
        this.routes.set(r.id, rec);
      }
      // near-set: mount buses the camera could see, park the rest.
      for (let v = 0; v < rec.buses.length; v++) {
        const b = rec.buses[v];
        this.busPos(rec, v, rec.buses.length, clock, this._p);
        const near = this.forceHot || distXZ(camPos, this._p.x, this._p.z) < VEH_NEAR + (b.live ? HYST : 0);
        if (near && !b.live) {
          b.g.position.copy(this._p);            // mounts exactly on schedule — no pop
          b.yaw = this.busYaw(rec, v, rec.buses.length, clock);
          b.g.rotation.y = b.yaw;
          this.scene.add(b.g); b.live = true;
        } else if (!near && b.live) {
          this.scene.remove(b.g); b.live = false;
        }
      }
    }
    for (const [id, rec] of this.routes) {
      if (!seen.has(id)) { this.releaseRoute(rec); this.routes.delete(id); }
    }
  }

  private releaseRoute(rec: RouteRec): void {
    for (const b of rec.buses) { if (b.live) this.scene.remove(b.g); this.poolBus.push(b.g); }
    rec.buses.length = 0;
  }

  private stepBuses(clock: number): void {
    for (const rec of this.routes.values()) {
      const n = rec.buses.length;
      for (let v = 0; v < n; v++) {
        const b = rec.buses[v];
        if (!b.live) continue;                   // cold buses cost nothing
        this.busPos(rec, v, n, clock, b.g.position);
        b.yaw = lerpAngle(b.yaw, this.busYaw(rec, v, n, clock), 0.35);
        b.g.rotation.y = b.yaw;
      }
    }
  }

  /** fleet.vehiclePos replicated: phase-staggered ping-pong along the line. */
  private busPos(rec: RouteRec, v: number, n: number, clock: number, out: THREE.Vector3): void {
    const s = mod1(clock / rec.cycleH + (n > 0 ? v / n : 0));
    const u = s < 0.5 ? s * 2 : 2 - s * 2;
    polyPoint(rec.poly, rec.cum, u * rec.lengthM, out);
  }

  private busYaw(rec: RouteRec, v: number, n: number, clock: number): number {
    const s = mod1(clock / rec.cycleH + (n > 0 ? v / n : 0));
    const u = s < 0.5 ? s * 2 : 2 - s * 2;
    const fwd = s < 0.5 ? 1 : -1;
    return polyHeading(rec.poly, rec.cum, u * rec.lengthM, fwd);
  }

  // ---------------------------------------------------------------------------
  // TRIPS — taxi/car bodies chasing per-tick view positions
  // ---------------------------------------------------------------------------
  private sweepTrips(view: TransportView, camPos: THREE.Vector3,
                     protagonist: { id: string; x: number; z: number } | null): void {
    for (const t of this.trips.values()) t.seen = false;
    for (const t of view.trips) {
      if (t.mode !== 'car' && t.mode !== 'taxi') continue;  // riders ride buses; walkers walk
      let rec = this.trips.get(t.id);
      if (!rec) {
        rec = {
          mode: t.mode, body: null, cur: new V(t.x, 0, t.z), tx: t.x, tz: t.z,
          yaw: 0, follow: false, seen: true,
        };
        this.trips.set(t.id, rec);
      }
      rec.seen = true;
      rec.follow = protagonist !== null && t.travelerId === protagonist.id;
      rec.tx = t.x; rec.tz = t.z;
      const near = this.forceHot || distXZ(camPos, rec.cur.x, rec.cur.z) < VEH_NEAR + (rec.body ? HYST : 0);
      if (near && !rec.body) {
        rec.body = rec.mode === 'taxi' ? this.takeTaxi() : this.takeCar();
        rec.body.position.copy(rec.cur);
        rec.body.rotation.y = rec.yaw;
        this.scene.add(rec.body);
      } else if (!near && rec.body) {
        this.releaseTripBody(rec);
      }
    }
    for (const [id, rec] of this.trips) {
      if (!rec.seen) { this.releaseTripBody(rec); this.trips.delete(id); }
    }
  }

  private releaseTripBody(rec: TripRec): void {
    if (!rec.body) return;
    this.scene.remove(rec.body);
    (rec.mode === 'taxi' ? this.poolTaxi : this.poolCar).push(rec.body);
    rec.body = null;
  }

  private stepTrips(dt: number, protagonist: { id: string; x: number; z: number } | null): void {
    const k = 1 - Math.exp(-6 * dt);
    for (const rec of this.trips.values()) {
      // her own ride glides with her body (fresh every frame); others chase
      // the tick-stale view coordinate.
      const tx = rec.follow && protagonist ? protagonist.x : rec.tx;
      const tz = rec.follow && protagonist ? protagonist.z : rec.tz;
      const dx = tx - rec.cur.x, dz = tz - rec.cur.z;
      const d = Math.hypot(dx, dz);
      if (d > 45) { rec.cur.set(tx, 0, tz); }        // way stale — resync off-screen
      else if (d > 1e-3) {
        rec.cur.x += dx * k; rec.cur.z += dz * k;
        rec.yaw = lerpAngle(rec.yaw, Math.atan2(dx, dz), k);
      }
      if (rec.body) {
        rec.body.position.copy(rec.cur);
        rec.body.rotation.y = rec.yaw;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // STOP QUEUES — waiting riders at stops the current network actually serves
  // ---------------------------------------------------------------------------
  private sweepStops(view: TransportView, camPos: THREE.Vector3): void {
    const served = new Set<string>();
    for (const r of view.routes) for (const s of r.stops) served.add(s);
    const seen = new Set<string>();
    for (const sv of view.stops) {
      if (!served.has(sv.venueId)) continue;
      seen.add(sv.venueId);
      let rec = this.stops.get(sv.venueId);
      if (!rec) {
        const rc = this.stopFrame(sv.venueId);
        if (!rc) continue;
        rec = { ...rc, sign: null, figs: [], live: 0 };
        this.stops.set(sv.venueId, rec);
      }
      const near = this.forceHot
        || distXZ(camPos, rec.x, rec.z) < STOP_NEAR + (rec.live > 0 || rec.sign ? HYST : 0);
      // the sign stands whenever the stop is served + near (queue or not).
      if (near && !rec.sign) {
        rec.sign = stopSign(this.mats);
        rec.sign.position.set(rec.x + rec.ux * 3.2 - rec.uz * 2.0, 0, rec.z + rec.uz * 3.2 + rec.ux * 2.0);
        this.scene.add(rec.sign);
      } else if (!near && rec.sign) {
        this.scene.remove(rec.sign);
        rec.sign = null;                              // geometry is tiny; keep it simple
      }
      const want = near ? Math.min(MAX_QUEUE, Math.round(sv.waiting)) : 0;
      this.setQueue(rec, sv.venueId, want);
    }
    for (const [id, rec] of this.stops) {
      if (!seen.has(id)) {
        if (rec.sign) this.scene.remove(rec.sign);
        this.setQueue(rec, id, 0);
        this.stops.delete(id);
      }
    }
  }

  /** stop node position + a queue direction along its first street. */
  private stopFrame(id: string): { x: number; z: number; ux: number; uz: number } | null {
    const g = this.net.graph;
    const ni = g.idx(id);
    if (ni < 0) return null;
    const n = g.nodes[ni];
    const inc = g.edgesAt(ni);
    if (inc.length === 0) return null;
    const e = g.edges[inc[0]];
    const o = g.nodes[g.otherEnd(e, ni)];
    const dx = o.x - n.x, dz = o.z - n.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: n.x, z: n.z, ux: dx / len, uz: dz / len };
  }

  /** grow/shrink one stop's pooled queue to `n` (the buildsite setCrowd shape). */
  private setQueue(rec: StopRec, id: string, n: number): void {
    if (n === rec.live) return;
    while (rec.figs.length < n) {
      const i = rec.figs.length;
      const h = new Humanoid('npc');
      const s = hash01(id) * 7.3 + i;
      h.setPose(i % 3 === 0 ? 'impatient' : 'neutral', 1 - (s - Math.floor(s)) * 0.4);
      rec.figs.push(h);
    }
    for (let i = rec.live; i < n; i++) {              // spawn up, down the line
      const h = rec.figs[i];
      const s = hash01(id + ':' + i);
      const px = rec.x + rec.ux * (3.2 + i * 0.9) - rec.uz * (1.1 + (s - 0.5) * 0.5);
      const pz = rec.z + rec.uz * (3.2 + i * 0.9) + rec.ux * (1.1 + (s - 0.5) * 0.5);
      h.place(this._p.set(px, 0, pz), Math.atan2(-rec.ux, -rec.uz) + (s - 0.5) * 0.8);
      h.snapScale(1);
      h.setActivity('stand');
      h.target.copy(this._p);
      this.scene.add(h.object);
    }
    for (let i = n; i < rec.live; i++) this.scene.remove(rec.figs[i].object);
    rec.live = n;
  }

  // ---------------------------------------------------------------------------
  // CROSSERS — walkers shuttling across HOT signalised crossings, kerb-obedient
  // ---------------------------------------------------------------------------
  private sweepCrossings(view: TransportView, camPos: THREE.Vector3): void {
    const hot = new Set(view.hot);
    const want = new Set<number>();
    for (const ci of this.net.crossings) {
      if (want.size >= MAX_CROSSINGS) break;
      const c = this.net.signals.controllers[ci];
      const near = this.forceHot || distXZ(camPos, c.x, c.z) < STOP_NEAR;
      if (near && (this.forceHot || hot.has(c.id))) want.add(ci);
    }
    for (const ci of want) {
      if (this.crossers.has(ci)) continue;
      const figs: Crosser[] = [];
      for (let i = 0; i < 2; i++) {
        const h = new Humanoid('npc');
        const s = hash01(`x:${ci}:${i}`);
        const f: Crosser = {
          h, t: (i === 0 ? -1 : 1) * CROSS_L, sgn: i === 0 ? 1 : -1,
          off: (i === 0 ? 1 : -1) * (0.7 + s * 0.5), hold: s * 1.5,
        };
        const c = this.net.signals.controllers[ci];
        const ca = Math.cos(c.bearingA), sa = Math.sin(c.bearingA);
        h.place(this._p.set(c.x + ca * f.t - sa * f.off, 0, c.z + sa * f.t + ca * f.off), 0);
        h.snapScale(1);
        this.scene.add(h.object);
        figs.push(f);
      }
      this.crossers.set(ci, { ci, figs });
    }
    for (const [ci, rec] of this.crossers) {
      if (!want.has(ci)) {
        for (const f of rec.figs) { this.scene.remove(f.h.object); f.h.dispose(); }
        this.crossers.delete(ci);
      }
    }
  }

  private stepCrossers(clock: number, dt: number): void {
    for (const rec of this.crossers.values()) {
      const c = this.net.signals.controllers[rec.ci];
      const ca = Math.cos(c.bearingA), sa = Math.sin(c.bearingA);
      for (const f of rec.figs) {
        let moving = false;
        if (f.hold > 0) { f.hold -= dt; }
        else {
          const inRoad = Math.abs(f.t) < KERB_T;
          const kerb = -f.sgn * KERB_T;              // the kerb this walker enters at
          const next = f.t + f.sgn * WALK_MS * dt;
          const entering = !inRoad && (next - kerb) * f.sgn >= 0 && (f.t - kerb) * f.sgn < 0;
          if (entering && !this.net.signals.pedGreenAlong(rec.ci, c.bearingA, clock)) {
            f.t = kerb;                              // hold the kerb on red
          } else {
            f.t = next; moving = true;
            if (f.sgn > 0 ? f.t >= CROSS_L : f.t <= -CROSS_L) {
              f.t = f.sgn * CROSS_L;
              f.sgn = f.sgn > 0 ? -1 : 1;            // shuttle back
              f.hold = 1 + hash01(`h:${rec.ci}:${clock.toFixed(1)}`) * 2.5;
            }
          }
        }
        f.h.target.set(c.x + ca * f.t - sa * f.off, 0, c.z + sa * f.t + ca * f.off);
        f.h.setActivity(moving ? 'walk' : 'stand');
        f.h.tick(dt);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // bodies — pooled kit-style vehicles (the parkedCar vocabulary, extended)
  // ---------------------------------------------------------------------------
  private takeCar(): THREE.Group { return this.poolCar.pop() ?? parkedCar(this.mats); }

  private takeTaxi(): THREE.Group {
    const g = this.poolTaxi.pop();
    if (g) return g;
    const t = parkedCar(this.mats);
    const sign = new THREE.BoxGeometry(0.62, 0.2, 0.26);
    sign.translate(0, 1.42, 0.2);
    t.add(new THREE.Mesh(sign, this.mats.fill));
    t.add(new THREE.LineSegments(new THREE.EdgesGeometry(sign, 1), this.mats.ink));
    return t;
  }

  private takeBus(): THREE.Group {
    const g = this.poolBus.pop();
    if (g) return g;
    // a MINIBUS: a true 12 m coach would dwarf the compressed 66 m town core
    // (buildings here are 5-12 m wide), so the transit body is sized to the
    // town's own vocabulary — bigger than a parkedCar, window-banded, wheeled.
    const bus = new THREE.Group();
    const body = new THREE.BoxGeometry(1.9, 1.6, 4.8);
    body.translate(0, 0.35 + 0.8, 0);
    bus.add(new THREE.Mesh(body, this.mats.fill));
    bus.add(new THREE.LineSegments(new THREE.EdgesGeometry(body, 1), this.mats.ink));
    for (const [x, z] of [[-0.85, 1.6], [0.85, 1.6], [-0.85, -1.6], [0.85, -1.6]] as const) {
      const wheel = new THREE.BoxGeometry(0.2, 0.5, 0.55);
      wheel.translate(x, 0.25, z);
      bus.add(new THREE.Mesh(wheel, this.mats.fill));
      bus.add(new THREE.LineSegments(new THREE.EdgesGeometry(wheel, 1), this.mats.soft));
    }
    // window band + door split + windshields — the transit tell. Drawn with
    // the SOFT weight: the faint weight vanishes at street distance and the
    // body reads as a blank slab.
    const win: number[] = [];
    for (const side of [0.96, -0.96]) {              // flanks are ±x; length runs on z
      win.push(side, 1.25, -2.1, side, 1.25, 2.1, side, 1.8, -2.1, side, 1.8, 2.1);
      for (const wz of [-1.4, -0.7, 0, 0.7, 1.4]) win.push(side, 1.25, wz, side, 1.8, wz);
    }
    for (const zf of [2.41, -2.41]) {                // windshield / rear glass
      win.push(-0.7, 1.2, zf, 0.7, 1.2, zf, -0.7, 1.8, zf, 0.7, 1.8, zf,
               -0.7, 1.2, zf, -0.7, 1.8, zf, 0.7, 1.2, zf, 0.7, 1.8, zf);
    }
    win.push(0.4, 0.4, 2.41, 0.4, 1.1, 2.41,         // door split on the nose
             0.96, 0.4, 1.2, 0.96, 1.8, 1.2);        // side door edge
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(win, 3));
    bus.add(new THREE.LineSegments(wg, this.mats.soft));
    return bus;
  }
}

// ---------------------------------------------------------------------------
// polyline helpers — allocation-free versions of fleet.pointOnPoly
// ---------------------------------------------------------------------------
function polyPoint(poly: readonly XZ[], cum: readonly number[], d: number, out: THREE.Vector3): void {
  const n = poly.length;
  if (n === 0) { out.set(0, 0, 0); return; }
  if (d <= 0 || n === 1) { out.set(poly[0].x, 0, poly[0].z); return; }
  const L = cum[n - 1];
  if (d >= L) { out.set(poly[n - 1].x, 0, poly[n - 1].z); return; }
  let i = 1;
  while (cum[i] < d) i++;
  const t = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-9);
  out.set(
    poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t, 0,
    poly[i - 1].z + (poly[i].z - poly[i - 1].z) * t,
  );
}

/** heading (render yaw) of the segment containing distance `d`, signed by
 *  travel direction (the ping-pong's return leg runs the polyline backward). */
function polyHeading(poly: readonly XZ[], cum: readonly number[], d: number, fwd: number): number {
  const n = poly.length;
  if (n < 2) return 0;
  let i = 1;
  const L = cum[n - 1];
  const dd = Math.max(0, Math.min(d, L - 1e-6));
  while (cum[i] < dd) i++;
  const dx = (poly[i].x - poly[i - 1].x) * fwd;
  const dz = (poly[i].z - poly[i - 1].z) * fwd;
  return Math.atan2(dx, dz);
}

/** a bus-stop sign: a slim post with a small flag board. */
function stopSign(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.BoxGeometry(0.08, 2.6, 0.08);
  post.translate(0, 1.3, 0);
  g.add(new THREE.Mesh(post, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(post, 1), mats.ink));
  const flag = new THREE.BoxGeometry(0.52, 0.36, 0.06);
  flag.translate(0.3, 2.35, 0);
  g.add(new THREE.Mesh(flag, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(flag, 1), mats.ink));
  return g;
}
