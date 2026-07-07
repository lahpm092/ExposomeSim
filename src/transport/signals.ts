// =============================================================================
// ExposomeSim — SIGNALS: fixed-cycle intersection controllers as pure data.
// -----------------------------------------------------------------------------
// One controller per intersection (generated crossings + any degree-≥3 node).
// Incident edges are split into two AXES by bearing (mod π); the cycle
// alternates green between them. The phase is a PURE FUNCTION of the clock —
// no tick, no state, no serialization — so a cold controller costs literally
// nothing and a hot one is just an arithmetic read. Offsets stagger by node
// index so the whole town never blinks in unison.
//
// Pedestrian semantics: a walker travelling ALONG axis A crosses roadway B,
// and may legally cross while A has the green (parallel traffic flows, cross
// traffic is stopped) — pedGreenAlong() encodes exactly that.
// =============================================================================

import type { StreetGraph } from './netgraph';

/** cycle length: 90 real-ish seconds of sim time. */
const CYCLE_H = 0.025;
/** per-controller phase stagger, sim-hours per controller index. */
const OFFSET_STEP_H = 0.007;

export interface SignalController {
  nodeIdx: number;
  id: string;                 // node id
  x: number; z: number;
  cycleH: number;
  offsetH: number;
  axisA: number[];            // incident edge indices, bearing-clustered
  axisB: number[];
  bearingA: number;           // representative bearing of axis A, [0, π)
}

export class SignalPlan {
  readonly controllers: SignalController[] = [];

  constructor(graph: StreetGraph) {
    const nodes = graph.intersections();
    for (let k = 0; k < nodes.length; k++) {
      const ni = nodes[k];
      const n = graph.nodes[ni];
      const inc = graph.edgesAt(ni);
      if (inc.length < 3) continue;                    // a bend needs no light
      // cluster incident edges into two axes by undirected bearing.
      const bearings = inc.map((e) => {
        const edge = graph.edges[e];
        const o = graph.otherEnd(edge, ni);
        const b = Math.atan2(graph.nodes[o].z - n.z, graph.nodes[o].x - n.x);
        return ((b % Math.PI) + Math.PI) % Math.PI;
      });
      const ref = bearings[0];
      const axisA: number[] = [], axisB: number[] = [];
      for (let i = 0; i < inc.length; i++) {
        // strict < so a 45° oblique becomes cross traffic, not a parallel.
        (axisDist(bearings[i], ref) < Math.PI / 4 ? axisA : axisB).push(inc[i]);
      }
      this.controllers.push({
        nodeIdx: ni, id: n.id, x: n.x, z: n.z,
        cycleH: CYCLE_H,
        offsetH: k * OFFSET_STEP_H,
        axisA, axisB, bearingA: ref,
      });
    }
  }

  /** current phase of controller `i`: 0 = axis A green, 1 = axis B green. */
  phaseAt(i: number, clock: number): 0 | 1 {
    const c = this.controllers[i];
    const frac = mod1((clock - c.offsetH) / c.cycleH);
    return frac < 0.5 ? 0 : 1;
  }

  /** may vehicles on edge `edgeIdx` proceed through controller `i` now? */
  carGreen(i: number, edgeIdx: number, clock: number): boolean {
    const c = this.controllers[i];
    const phase = this.phaseAt(i, clock);
    const onA = c.axisA.indexOf(edgeIdx) >= 0;
    return phase === 0 ? onA : !onA;
  }

  /** may a pedestrian WALKING along bearing θ cross legally now? Legal while
   *  the parallel axis has the green (the crossed roadway is stopped). */
  pedGreenAlong(i: number, theta: number, clock: number): boolean {
    const c = this.controllers[i];
    const t = ((theta % Math.PI) + Math.PI) % Math.PI;
    const alongA = axisDist(t, c.bearingA) < Math.PI / 4;
    const phase = this.phaseAt(i, clock);
    return phase === 0 ? alongA : !alongA;
  }
}

/** circular distance between two undirected bearings in [0, π). */
function axisDist(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, Math.PI - d);
}

function mod1(x: number): number { return x - Math.floor(x); }
