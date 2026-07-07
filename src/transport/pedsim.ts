// =============================================================================
// ExposomeSim — PEDSIM: social-force pedestrians, hot-only.
// -----------------------------------------------------------------------------
// Tier-2 micro dynamics for street figures near an observer. Each figure feels
// four forces: goal attraction (relax toward desired velocity), inter-agent
// repulsion (exponential personal space, resolved on a spatial hash grid),
// kerb/wall repulsion (pushed back toward the nearest street's corridor), and
// SIGNAL COMPLIANCE — the trait readout: at a red crossing a figure decides
// once (latched) whether to wait or jaywalk, with p(jaywalk) rising in
// impulsivity and falling in conscientiousness (the deriveNeuro projection).
// Behavior↔phenotype coupling you can measure in the exposome.
//
// Stepped ONLY via TransportField.hotStep — a cold town runs zero substeps
// (stepCount is smoke-asserted 0). Internally the integrator substeps at
// ≤ 0.12 real-equivalent seconds for stability, plus a positional hard-core
// projection so bodies can never interpenetrate regardless of dt.
//
// Determinism: the only randomness is the one latched jaywalk draw, taken
// from an owned mulberry32 stream serialized in toJSON.
// =============================================================================

import { mulberry32, type RNG } from '../core/util/num';
import type { StreetGraph } from './netgraph';
import type { SignalPlan } from './signals';
import type { PedFigure, PedTraits } from './types';

// forces work in metres/seconds (the micro layer's native units); dt arrives
// in sim-hours and is converted at the door.
const V_DES = 1.34;            // desired speed, m/s
const V_MAX = 2.2;
const TAU_S = 0.6;             // relaxation time toward desired velocity
const REP_A = 2.8;             // repulsion strength, m/s²
const REP_B = 0.35;            // repulsion range, m
const REP_R = 0.55;            // preferred body separation, m
const HARD_R = 0.5;            // hard-core: positional projection below this
const WALL_HALF_W = 3.5;       // street corridor half-width, m
const WALL_K = 2.0;            // kerb push, m/s² per metre of overshoot
const SUBSTEP_S = 0.12;
const MAX_SUBSTEPS = 600;
const GOAL_R = 0.6;
const SIG_APPROACH_M = 7;      // a signal within this range demands a decision
const SIG_HOLD_M = 3.2;        // compliant figures hold this far from the node
const CELL_M = 1.5;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** p(jaywalk on red) from traits — conscientiousness complies, impulsivity
 *  crosses. Clamped so nobody is a robot in either direction. */
export function jaywalkP(t: PedTraits): number {
  const p = 0.05 + 0.75 * t.impulsivity - 0.55 * t.conscientiousness;
  return p < 0.02 ? 0.02 : p > 0.95 ? 0.95 : p;
}

export class PedSim {
  private figs: PedFigure[] = [];
  private rng: RNG;
  private readonly seed: number;
  /** micro substeps executed — the cold-cost witness (must stay 0 unobserved). */
  stepCount = 0;

  // spatial hash scratch, reused across substeps.
  private grid = new Map<number, number[]>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
  }

  spawn(f: { id: string; x: number; z: number; gx: number; gz: number; traits: PedTraits }): void {
    this.figs.push({
      id: f.id, x: f.x, z: f.z, vx: 0, vz: 0, gx: f.gx, gz: f.gz,
      traits: { conscientiousness: f.traits.conscientiousness, impulsivity: f.traits.impulsivity },
      state: 'go', sig: -1, sigChoice: 0,
    });
  }

  remove(id: string): void {
    const i = this.figs.findIndex((f) => f.id === id);
    if (i >= 0) this.figs.splice(i, 1);
  }

  clear(): void { this.figs.length = 0; }
  count(): number { return this.figs.length; }
  figures(): readonly PedFigure[] { return this.figs; }

  /** smallest pairwise separation right now — the interpenetration audit. */
  minSeparation(): number {
    let m = Infinity;
    for (let i = 0; i < this.figs.length; i++) {
      for (let j = i + 1; j < this.figs.length; j++) {
        const dx = this.figs[i].x - this.figs[j].x, dz = this.figs[i].z - this.figs[j].z;
        const d = Math.hypot(dx, dz);
        if (d < m) m = d;
      }
    }
    return m;
  }

  // ---------------------------------------------------------------------------
  // step — social-force integration. Called ONLY from hotStep.
  // ---------------------------------------------------------------------------
  step(dtH: number, clock: number, signals: SignalPlan | null, graph: StreetGraph | null): void {
    if (!(dtH > 0) || this.figs.length === 0) return;
    const dtS = dtH * 3600;
    const n = Math.min(Math.max(1, Math.ceil(dtS / SUBSTEP_S)), MAX_SUBSTEPS);
    const h = dtS / n;
    const clockPerSub = dtH / n;
    for (let k = 0; k < n; k++) {
      this.substep(h, clock + k * clockPerSub, signals, graph);
      this.stepCount++;
    }
  }

  private substep(hS: number, clock: number, signals: SignalPlan | null, graph: StreetGraph | null): void {
    this.rebuildGrid();

    for (let i = 0; i < this.figs.length; i++) {
      const f = this.figs[i];
      if (f.state === 'done') continue;

      // goal direction (or hold point while waiting at a red).
      let gx = f.gx, gz = f.gz;
      if (signals) this.applySignals(f, signals, clock);
      if (f.state === 'wait' && f.sig >= 0 && signals) {
        const c = signals.controllers[f.sig];
        const dx = f.x - c.x, dz = f.z - c.z;
        const d = Math.hypot(dx, dz) || 1;
        gx = c.x + (dx / d) * SIG_HOLD_M;               // hold the stop line
        gz = c.z + (dz / d) * SIG_HOLD_M;
      }
      let dx = gx - f.x, dz = gz - f.z;
      const dg = Math.hypot(dx, dz);
      if (f.state === 'go' && dg < GOAL_R) { f.state = 'done'; f.vx = 0; f.vz = 0; continue; }
      const want = f.state === 'wait' ? Math.min(V_DES, dg) : V_DES;
      const ux = dg > 1e-9 ? dx / dg : 0, uz = dg > 1e-9 ? dz / dg : 0;

      // goal force: relax velocity toward the desired one.
      let ax = (ux * want - f.vx) / TAU_S;
      let az = (uz * want - f.vz) / TAU_S;

      // agent repulsion from hash neighbors (3×3 cells).
      const cx = Math.floor(f.x / CELL_M), cz = Math.floor(f.z / CELL_M);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const cell = this.grid.get(key(cx + ox, cz + oz));
        if (!cell) continue;
        for (const j of cell) {
          if (j === i) continue;
          const o = this.figs[j];
          const sx = f.x - o.x, sz = f.z - o.z;
          const d = Math.hypot(sx, sz);
          if (d > 1.4 || d < 1e-9) continue;
          const mag = REP_A * Math.exp((REP_R - d) / REP_B);
          ax += (sx / d) * mag;
          az += (sz / d) * mag;
        }
      }

      // kerb: past the corridor half-width of the nearest street, push back.
      if (graph) {
        const w = nearestEdgeOffset(graph, f.x, f.z);
        if (w && w.lat > WALL_HALF_W) {
          const push = WALL_K * (w.lat - WALL_HALF_W);
          ax -= w.nx * push;
          az -= w.nz * push;
        }
      }

      f.vx += ax * hS;
      f.vz += az * hS;
      const sp = Math.hypot(f.vx, f.vz);
      if (sp > V_MAX) { f.vx *= V_MAX / sp; f.vz *= V_MAX / sp; }
      f.x += f.vx * hS;
      f.z += f.vz * hS;
    }

    // hard-core projection: no two bodies closer than HARD_R, ever.
    this.rebuildGrid();
    for (let i = 0; i < this.figs.length; i++) {
      const f = this.figs[i];
      const cx = Math.floor(f.x / CELL_M), cz = Math.floor(f.z / CELL_M);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const cell = this.grid.get(key(cx + ox, cz + oz));
        if (!cell) continue;
        for (const j of cell) {
          if (j <= i) continue;
          const o = this.figs[j];
          let sx = f.x - o.x, sz = f.z - o.z;
          let d = Math.hypot(sx, sz);
          if (d >= HARD_R) continue;
          if (d < 1e-9) { sx = 1; sz = 0; d = 1e-9; }   // exactly stacked: split on x
          const push = 0.5 * (HARD_R - d);
          f.x += (sx / d) * push; f.z += (sz / d) * push;
          o.x -= (sx / d) * push; o.z -= (sz / d) * push;
        }
      }
    }
  }

  /** latched red-light decision: comply (wait) or jaywalk (proceed). */
  private applySignals(f: PedFigure, signals: SignalPlan, clock: number): void {
    // find the controller ahead of this figure.
    let near = -1, nd = Infinity;
    for (let i = 0; i < signals.controllers.length; i++) {
      const c = signals.controllers[i];
      const dx = c.x - f.x, dz = c.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d < nd) { nd = d; near = i; }
    }
    if (near < 0 || nd > SIG_APPROACH_M) {
      if (f.state === 'wait') f.state = 'go';
      f.sig = -1; f.sigChoice = 0;
      return;
    }
    const c = signals.controllers[near];
    const toward = (c.x - f.x) * (f.gx - f.x) + (c.z - f.z) * (f.gz - f.z);
    if (toward <= 0) {                                  // already past it
      if (f.state === 'wait') f.state = 'go';
      f.sig = -1; f.sigChoice = 0;
      return;
    }
    const theta = Math.atan2(f.gz - f.z, f.gx - f.x);
    const green = signals.pedGreenAlong(near, theta, clock);
    if (green) {
      if (f.state === 'wait') f.state = 'go';
      f.sig = -1; f.sigChoice = 0;
      return;
    }
    // red: decide exactly once per approach — the trait readout.
    if (f.sig !== near || f.sigChoice === 0) {
      f.sig = near;
      f.sigChoice = this.rng() < jaywalkP(f.traits) ? 2 : 1;
    }
    if (f.sigChoice === 1) f.state = 'wait';
  }

  private rebuildGrid(): void {
    this.grid.clear();
    for (let i = 0; i < this.figs.length; i++) {
      const k = key(Math.floor(this.figs[i].x / CELL_M), Math.floor(this.figs[i].z / CELL_M));
      const cell = this.grid.get(k);
      if (cell) cell.push(i); else this.grid.set(k, [i]);
    }
  }

  // ---------------------------------------------------------------------------
  // persistence — figures + the rng cursor ARE the state.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      seed: this.seed,
      rng: this.rng.save ? this.rng.save() : 0,
      steps: this.stepCount,
      figs: this.figs.map((f) => [
        f.id, r4(f.x), r4(f.z), r4(f.vx), r4(f.vz), r4(f.gx), r4(f.gz),
        r4(f.traits.conscientiousness), r4(f.traits.impulsivity),
        f.state, f.sig, f.sigChoice,
      ]),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { rng?: number; steps?: number; figs?: unknown[] } | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    if (typeof o.steps === 'number') this.stepCount = o.steps;
    this.figs = [];
    if (Array.isArray(o.figs)) for (const row of o.figs) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      this.figs.push({
        id: row[0], x: num(row[1]), z: num(row[2]), vx: num(row[3]), vz: num(row[4]),
        gx: num(row[5]), gz: num(row[6]),
        traits: { conscientiousness: num(row[7]), impulsivity: num(row[8]) },
        state: row[9] === 'wait' ? 'wait' : row[9] === 'done' ? 'done' : 'go',
        sig: typeof row[10] === 'number' ? row[10] : -1,
        sigChoice: row[11] === 1 ? 1 : row[11] === 2 ? 2 : 0,
      });
    }
  }
}

const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);

/** lateral offset of (x,z) from the nearest edge's centreline, plus the unit
 *  normal pointing AWAY from it — the kerb geometry query. */
function nearestEdgeOffset(graph: StreetGraph, x: number, z: number):
    { lat: number; nx: number; nz: number } | null {
  let bd = Infinity, bx = 0, bz = 0;
  for (const e of graph.edges) {
    const a = graph.nodes[e.ai], b = graph.nodes[e.bi];
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 1e-9 ? ((x - a.x) * abx + (z - a.z) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + abx * t, pz = a.z + abz * t;
    const dx = x - px, dz = z - pz;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bx = dx; bz = dz; }
  }
  if (bd === Infinity) return null;
  const d = Math.sqrt(bd);
  if (d < 1e-9) return { lat: 0, nx: 0, nz: 0 };
  return { lat: d, nx: bx / d, nz: bz / d };
}
