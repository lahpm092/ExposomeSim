// =============================================================================
// ExposomeSim — TRANSITPLAN: routes synthesized from the demand field.
// -----------------------------------------------------------------------------
// No route table is authored anywhere. On a slow cadence the planner reads the
// OD field's top flows and lays bus lines over them: the heaviest unserved
// pair gets a line along its shortest walk-graph path; further pairs are
// absorbed if the line already serves them, extended from a terminal when the
// extension is cheap, or granted a new line while the fleet lasts. Vehicles
// are then split across lines in proportion to the demand each one carries —
// network design emerges from demand, and re-emerges when demand moves.
//
// Pure and deterministic: same graph + same flows + same fleet ⇒ same plan
// (ties broken by key order). No RNG, no internal state — the facade owns the
// replan cadence and the resulting routes' lifecycle.
// =============================================================================

import type { StreetGraph } from './netgraph';
import { MODE_PARAMS, type Router } from './routing';
import type { ODFlow } from './odfield';
import type { XZ } from './types';

export const MAX_ROUTES = 3;
/** dwell per intermediate stop, sim-hours (~40 s). */
const DWELL_H = 0.011;
/** an extension may cost at most this multiple of the direct path. */
const EXTEND_FACTOR = 1.8;

export interface TransitRoute {
  id: string;
  nodePath: number[];            // node indices along the line
  poly: XZ[];
  cum: number[];                 // cumulative metres at each poly vertex
  lengthM: number;
  stops: { nodeId: string; nodeIdx: number; at: number }[]; // anchor nodes on the line
  cycleH: number;                // full out-and-back period incl. dwells
  vehicles: number;
  headwayH: number;
  capacity: number;              // riders per vehicle
}

/** derive the full route record from a node path — also the loadJSON rebuilder. */
export function buildRoute(graph: StreetGraph, router: Router, nodePath: number[],
                           id: string, vehicles: number, capacity: number): TransitRoute {
  const poly = router.polyOf(nodePath);
  const cum: number[] = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z));
  }
  const lengthM = cum[cum.length - 1];
  const stops: TransitRoute['stops'] = [];
  for (let i = 0; i < nodePath.length; i++) {
    const n = graph.nodes[nodePath[i]];
    if (n.kind === 'anchor') stops.push({ nodeId: n.id, nodeIdx: nodePath[i], at: cum[i] });
  }
  const rideH = lengthM / MODE_PARAMS.bus.speed;
  const cycleH = 2 * (rideH + Math.max(0, stops.length - 2) * DWELL_H) + 2 * DWELL_H;
  const v = Math.max(0, Math.floor(vehicles));
  return {
    id, nodePath, poly, cum, lengthM, stops,
    cycleH: Math.max(cycleH, 0.02),
    vehicles: v,
    headwayH: v > 0 ? Math.max(cycleH, 0.02) / v : Infinity,
    capacity,
  };
}

/** does route `r` serve o→d? (ping-pong lines serve every stop pair on them) */
export function routeServes(r: TransitRoute, o: string, d: string): boolean {
  let ho = false, hd = false;
  for (const s of r.stops) { if (s.nodeId === o) ho = true; if (s.nodeId === d) hd = true; }
  return ho && hd && o !== d;
}

export function planRoutes(graph: StreetGraph, router: Router, flows: readonly ODFlow[],
                           vehiclesTotal: number, capacity: number): TransitRoute[] {
  if (vehiclesTotal <= 0 || flows.length === 0) return [];
  const lines: { path: number[]; demand: number }[] = [];

  for (const f of flows) {
    const a = graph.idx(f.o), b = graph.idx(f.d);
    if (a < 0 || b < 0 || a === b) continue;
    // absorbed? a line already carrying both stops just banks the demand.
    const holder = lines.find((l) => l.path.includes(a) && l.path.includes(b));
    if (holder) { holder.demand += f.flow; continue; }
    // extend a line whose terminal is one endpoint, when the detour is cheap.
    let extended = false;
    for (const l of lines) {
      const t0 = l.path[0], t1 = l.path[l.path.length - 1];
      const onA = l.path.includes(a), onB = l.path.includes(b);
      const need = onA ? b : onB ? a : -1;
      if (need < 0) continue;
      const from = need === b ? (onA ? nearTerm(l.path, a, t0, t1) : t1) : nearTerm(l.path, b, t0, t1);
      const ext = router.route(from, need, 'bus');
      const direct = router.route(need === b ? a : b, need, 'bus');
      if (!ext || !direct || ext.distM > direct.distM * EXTEND_FACTOR) continue;
      l.path = from === l.path[0] ? [...ext.path.slice(1).reverse(), ...l.path] : [...l.path, ...ext.path.slice(1)];
      l.demand += f.flow;
      extended = true;
      break;
    }
    if (extended) continue;
    if (lines.length >= MAX_ROUTES) continue;
    const r = router.route(a, b, 'bus');
    if (r && r.path.length >= 2) lines.push({ path: r.path, demand: f.flow });
  }
  if (lines.length === 0) return [];

  // fleet split ∝ demand, every live line keeps at least one vehicle.
  const total = lines.reduce((s, l) => s + l.demand, 0);
  const alloc = lines.map((l) => Math.max(1, Math.round((vehiclesTotal * l.demand) / Math.max(total, 1e-9))));
  let over = alloc.reduce((s, v) => s + v, 0) - vehiclesTotal;
  for (let i = alloc.length - 1; i >= 0 && over > 0; i--) {
    const take = Math.min(over, alloc[i] - 1);
    alloc[i] -= take; over -= take;
  }
  return lines
    .map((l, i) => buildRoute(graph, router, l.path, `r${i}`, alloc[i], capacity))
    .filter((r) => r.vehicles > 0 && r.stops.length >= 2);
}

/** the terminal of `path` nearest (along the array) to member node `m`. */
function nearTerm(path: number[], m: number, t0: number, t1: number): number {
  const i = path.indexOf(m);
  return i < path.length / 2 ? t0 : t1;
}
