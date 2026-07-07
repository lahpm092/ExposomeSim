// =============================================================================
// ExposomeSim — FLEET: the vehicles that carry other people's plans.
// -----------------------------------------------------------------------------
// TAXIS are a utilization queue, not entities: dispatched ride-hours pile into
// a dt-invariant utilization EMA, and the cold waiting time is a pure function
// of that utilization (an M/M/c-flavoured blow-up as the fleet saturates) —
// one busy afternoon really does make the next cab slower to come.
//
// TRANSIT vehicles advance by SCHEDULE-TIME: vehiclePos() is a pure function
// of the clock (ping-pong along the line's polyline, staggered per vehicle),
// so a cold bus network costs nothing per frame and a cold→hot flip finds the
// bus exactly where the timetable says — no teleporting spawns. Boarding is
// mesoscopic: per tick, per stop, capacity = visit rate × free seats; boarded
// riders enter an in-transit FIFO with a scheduled alight time, which is what
// makes passenger conservation EXACT across hot/cold flips:
//     Σ boarded == Σ alighted + aboard_now            (to 1e-6, always)
// A replan retires lines gracefully: riders aboard complete at their booked
// destination (schedule-time semantics), never vanish.
//
// Deterministic, no RNG. Fares are RETURNED, never applied — econ moves money.
// =============================================================================

import type { ODField } from './odfield';
import { buildRoute, routeServes, type TransitRoute } from './transitplan';
import type { StreetGraph } from './netgraph';
import type { Router } from './routing';
import { MODE_PARAMS } from './routing';
import type { XZ } from './types';

/** taxi utilization EMA half-life, sim-hours. */
const UTIL_HALF_LIFE_H = 6;
/** cold taxi dispatch floor (finding + kerb time). */
const TAXI_WAIT_BASE_H = 0.03;
export const DEFAULT_BUS_CAPACITY = 22;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface AboardEntry { alightH: number; amount: number; dest: string; route: string }

export class Fleet {
  // ---- taxi -------------------------------------------------------------------
  private taxis = 0;
  private utilEma = 0;
  private busyPendingH = 0;      // ride-hours dispatched since the last tick

  // ---- transit ----------------------------------------------------------------
  private routes: TransitRoute[] = [];
  private fifo: AboardEntry[] = [];
  private aboardSum = 0;
  boardedTotal = 0;
  alightedTotal = 0;

  // ---------------------------------------------------------------------------
  // taxi — dispatch queue as statistics
  // ---------------------------------------------------------------------------
  setTaxis(n: number): void { this.taxis = Math.max(0, Math.floor(n)); }
  taxiCount(): number { return this.taxis; }
  taxiUtil(): number { return this.utilEma; }

  /** a ride was dispatched — credit its hours to this tick's utilization. */
  noteRide(durH: number): void { if (durH > 0) this.busyPendingH += durH; }

  /** expected wait for the next cab. Rises steeply as the fleet saturates;
   *  Infinity with no fleet (the mode simply is not on offer). */
  taxiWaitH(): number {
    if (this.taxis <= 0) return Infinity;
    const u = Math.min(this.utilEma, 0.999);
    return TAXI_WAIT_BASE_H + 0.3 * (u * u * u) / (1.05 - u);
  }

  tickTaxi(dtH: number): void {
    if (!(dtH > 0)) return;
    const inst = this.taxis > 0 ? Math.min(this.busyPendingH / (this.taxis * dtH), 2) : 0;
    const lam = 1 - Math.pow(0.5, dtH / UTIL_HALF_LIFE_H);
    this.utilEma += lam * (inst - this.utilEma);
    this.busyPendingH = 0;
  }

  // ---------------------------------------------------------------------------
  // transit — schedule-time vehicles + mesoscopic boarding
  // ---------------------------------------------------------------------------
  routeList(): readonly TransitRoute[] { return this.routes; }
  aboard(): number { return this.aboardSum; }

  /** install a new plan. In-flight riders complete at their booked destination
   *  immediately (schedule-time resolution) so conservation never breaks. */
  setRoutes(routes: TransitRoute[]): void {
    for (const e of this.fifo) { this.alightedTotal += e.amount; }
    this.fifo.length = 0;
    this.aboardSum = 0;
    this.routes = routes;
  }

  /** pure schedule-time position of vehicle `v` on route `r` at `clock` —
   *  ping-pong along the polyline, phase-staggered per vehicle. NO integration. */
  vehiclePos(r: TransitRoute, v: number, clock: number): XZ {
    if (r.poly.length === 0) return { x: 0, z: 0 };
    const phase = r.vehicles > 0 ? v / r.vehicles : 0;
    const s = mod1(clock / r.cycleH + phase);
    const u = s < 0.5 ? s * 2 : 2 - s * 2;             // out-and-back
    return pointOnPoly(r.poly, r.cum, u * r.lengthM);
  }

  /** scheduled ride duration between two stops of a route (nearest direction). */
  rideDurH(r: TransitRoute, o: string, d: string): number {
    let ao = -1, ad = -1, between = 0;
    for (const s of r.stops) {
      if (s.nodeId === o) ao = s.at;
      if (s.nodeId === d) ad = s.at;
    }
    if (ao < 0 || ad < 0) return 0;
    for (const s of r.stops) if (s.at > Math.min(ao, ad) && s.at < Math.max(ao, ad)) between++;
    return Math.abs(ad - ao) / MODE_PARAMS.bus.speed + between * 0.011;
  }

  /** one econ-cadence transit step: alight due riders, then board from the
   *  queues at every served stop. Returns the tick's flows + fare base. */
  transitTick(od: ODField, dtH: number, clock: number): { boarded: number; alighted: number } {
    // ---- alight: pop every entry whose scheduled arrival has passed ----------
    let alighted = 0;
    if (this.fifo.length > 0) {
      let w = 0;
      for (const e of this.fifo) {
        if (e.alightH <= clock + 1e-9) {
          alighted += e.amount;
          this.alightedTotal += e.amount;
          this.aboardSum -= e.amount;
        } else {
          this.fifo[w++] = e;
        }
      }
      this.fifo.length = w;
    }

    // ---- board: per route, per stop, visit-rate × free seats -----------------
    let boarded = 0;
    for (const r of this.routes) {
      if (r.vehicles <= 0 || r.stops.length < 2) continue;
      const visitsPerH = 1 / r.headwayH;
      const perVehicle = this.aboardOn(r.id) / r.vehicles;
      const freeSeats = Math.max(0, r.capacity - perVehicle);
      for (const s of r.stops) {
        const cap = visitsPerH * dtH * freeSeats;
        if (cap <= 1e-12) continue;
        const dests: string[] = [];
        for (const t of r.stops) if (t.nodeId !== s.nodeId) dests.push(t.nodeId);
        const rows = od.board(s.nodeId, dests, cap);
        for (const row of rows) {
          const wait = r.headwayH / 2;                  // mean schedule offset
          this.fifo.push({
            alightH: clock + wait + this.rideDurH(r, s.nodeId, row.d),
            amount: row.n,
            dest: row.d,
            route: r.id,
          });
          this.aboardSum += row.n;
          this.boardedTotal += row.n;
          boarded += row.n;
        }
      }
    }
    return { boarded, alighted };
  }

  /** every o>d pair some route serves — the give-up filter's whitelist. */
  servedPairs(): Set<string> {
    const out = new Set<string>();
    for (const r of this.routes) {
      for (const a of r.stops) for (const b of r.stops) {
        if (a.nodeId !== b.nodeId) out.add(`${a.nodeId}>${b.nodeId}`);
      }
    }
    return out;
  }

  /** best route serving o→d, if any (planTrip's service lookup). */
  serving(o: string, d: string): TransitRoute | null {
    let best: TransitRoute | null = null;
    for (const r of this.routes) {
      if (!routeServes(r, o, d)) continue;
      if (!best || r.headwayH < best.headwayH) best = r;
    }
    return best;
  }

  private aboardOn(routeId: string): number {
    let s = 0;
    for (const e of this.fifo) if (e.route === routeId) s += e.amount;
    return s;
  }

  // ---------------------------------------------------------------------------
  // persistence — routes rebuild geometry from the graph; FIFO + EMAs travel.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      taxis: this.taxis,
      util: r6(this.utilEma),
      busy: r6(this.busyPendingH),
      routes: this.routes.map((r) => ({ id: r.id, path: r.nodePath, veh: r.vehicles, cap: r.capacity })),
      fifo: this.fifo.map((e) => [r6(e.alightH), r6(e.amount), e.dest, e.route]),
      totals: [r6(this.boardedTotal), r6(this.alightedTotal)],
    };
  }

  loadJSON(j: unknown, graph: StreetGraph, router: Router): void {
    const o = j as {
      taxis?: number; util?: number; busy?: number;
      routes?: { id?: string; path?: number[]; veh?: number; cap?: number }[];
      fifo?: unknown[]; totals?: unknown[];
    } | null;
    if (!o) return;
    this.taxis = typeof o.taxis === 'number' ? o.taxis : 0;
    this.utilEma = typeof o.util === 'number' ? o.util : 0;
    this.busyPendingH = typeof o.busy === 'number' ? o.busy : 0;
    this.routes = [];
    if (Array.isArray(o.routes)) for (const r of o.routes) {
      if (!r || !Array.isArray(r.path)) continue;
      this.routes.push(buildRoute(graph, router, r.path, r.id ?? `r${this.routes.length}`,
                                  r.veh ?? 0, r.cap ?? DEFAULT_BUS_CAPACITY));
    }
    this.fifo = [];
    this.aboardSum = 0;
    if (Array.isArray(o.fifo)) for (const row of o.fifo) {
      if (!Array.isArray(row) || typeof row[0] !== 'number' || typeof row[1] !== 'number') continue;
      const e: AboardEntry = { alightH: row[0], amount: row[1], dest: String(row[2] ?? ''), route: String(row[3] ?? '') };
      this.fifo.push(e);
      this.aboardSum += e.amount;
    }
    if (Array.isArray(o.totals)) {
      this.boardedTotal = typeof o.totals[0] === 'number' ? o.totals[0] : 0;
      this.alightedTotal = typeof o.totals[1] === 'number' ? o.totals[1] : 0;
    }
  }
}

// ---- polyline math ----------------------------------------------------------

/** point at arc-length `distM` along a polyline with cumulative lengths. */
export function pointOnPoly(poly: readonly XZ[], cum: readonly number[], distM: number): XZ {
  if (poly.length === 1 || distM <= 0) return { x: poly[0].x, z: poly[0].z };
  const total = cum[cum.length - 1];
  if (distM >= total) { const p = poly[poly.length - 1]; return { x: p.x, z: p.z }; }
  let i = 1;
  while (cum[i] < distM) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 1e-9 ? (distM - cum[i - 1]) / seg : 0;
  return {
    x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t,
    z: poly[i - 1].z + (poly[i].z - poly[i - 1].z) * t,
  };
}

function mod1(x: number): number { return x - Math.floor(x); }
