// =============================================================================
// ExposomeSim — ROUTING: A* over the street graph + the price of distance.
// -----------------------------------------------------------------------------
// Per-mode shortest paths with congestion-aware edge times, a generalized
// cost g = time·VoT + money + energy·fatigue + comfort + habitBias, and a
// LOGIT mode choice whose temperature comes from trait openness — an open
// traveler explores, a closed one repeats the cheapest habit. Nothing about
// the modal split is imposed: it emerges from prices, speeds, ownership and
// congestion flowing through this one cost.
//
// costEstimate must be O(1) amortized for the arbiter (it replaces the
// telescoped travelTime() in every decision): all-pairs walk/car time
// matrices over the small node set are cached and rebuilt ONLY when the
// congestion regime version moves. `matrixBuilds` is exposed so smoke tests
// can assert the cache actually holds.
//
// Deterministic: the router itself draws no randomness; the logit SAMPLE
// takes the caller's RNG (the facade's serialized mulberry32 stream).
// =============================================================================

import type { RNG } from '../core/util/num';
import type { StreetGraph } from './netgraph';
import type { Congestion } from './congestion';
import type { ModeId, XZ } from './types';

/** per-mode physics + $-equivalents. Speeds in metres/sim-hour. */
export const MODE_PARAMS: Record<ModeId, {
  speed: number;        // m/sim-h
  congestible: boolean; // does the BPR factor slow it?
  energyPerKm: number;  // $-equivalent bodily cost per km (× fatigue)
  comfort: number;      // flat $-equivalent per trip (crowding, weather, hassle)
}> = {
  walk: { speed: 4800,  congestible: false, energyPerKm: 0.9,  comfort: 0 },
  bike: { speed: 14000, congestible: false, energyPerKm: 0.45, comfort: 0.3 },
  car:  { speed: 34000, congestible: true,  energyPerKm: 0.05, comfort: -0.1 },
  taxi: { speed: 34000, congestible: true,  energyPerKm: 0.02, comfort: -0.2 },
  bus:  { speed: 20000, congestible: true,  energyPerKm: 0.08, comfort: 0.8 },
};

/** VoT floor + wage share — time is money, but never free. */
const VOT_FLOOR = 4;
const VOT_WAGE_SHARE = 0.6;
export const DEFAULT_WAGE = 12;
/** logit temperature from openness: T = T0 + T1·openness ($-units). */
const LOGIT_T0 = 0.5;
const LOGIT_T1 = 2.5;

export interface RouteResult { path: number[]; distM: number; durH: number }

export interface ModeOption { mode: ModeId; durH: number; money: number; g: number }

export class Router {
  /** all-pairs matrix rebuild count — the smoke's O(1)-amortized witness. */
  matrixBuilds = 0;

  private n: number;
  private walkM: Float64Array | null = null;   // hours, congestion-free
  private carM: Float64Array | null = null;    // hours, congestion-priced
  private carRegime = -1;

  // scratch for A*/Dijkstra — allocated once for the module's lifetime.
  private dist: Float64Array;
  private time: Float64Array;
  private prev: Int32Array;
  private closed: Uint8Array;

  constructor(private graph: StreetGraph, private congestion: Congestion) {
    this.n = graph.nodes.length;
    this.dist = new Float64Array(this.n);
    this.time = new Float64Array(this.n);
    this.prev = new Int32Array(this.n);
    this.closed = new Uint8Array(this.n);
  }

  // ---------------------------------------------------------------------------
  // route — A* between node indices for one mode. Heuristic: straight-line
  // time at the mode's free speed (admissible: BPR factors are ≥ 1).
  // ---------------------------------------------------------------------------
  route(a: number, b: number, mode: ModeId): RouteResult | null {
    const p = MODE_PARAMS[mode];
    const nodes = this.graph.nodes;
    this.time.fill(Infinity);
    this.dist.fill(Infinity);
    this.prev.fill(-1);
    this.closed.fill(0);
    this.time[a] = 0;
    this.dist[a] = 0;

    for (;;) {
      // linear open-set scan — the node set is tens, a heap would cost more.
      let cur = -1, best = Infinity;
      for (let i = 0; i < this.n; i++) {
        if (this.closed[i] || this.time[i] === Infinity) continue;
        const dx = nodes[i].x - nodes[b].x, dz = nodes[i].z - nodes[b].z;
        const f = this.time[i] + Math.hypot(dx, dz) / p.speed;
        if (f < best) { best = f; cur = i; }
      }
      if (cur < 0) return null;
      if (cur === b) break;
      this.closed[cur] = 1;
      for (const ei of this.graph.edgesAt(cur)) {
        const e = this.graph.edges[ei];
        const o = this.graph.otherEnd(e, cur);
        if (this.closed[o]) continue;
        const f = p.congestible ? this.congestion.factor(ei) : 1;
        const t = this.time[cur] + (e.lengthM / p.speed) * f;
        if (t < this.time[o]) {
          this.time[o] = t;
          this.dist[o] = this.dist[cur] + e.lengthM;
          this.prev[o] = cur;
        }
      }
    }
    const path: number[] = [];
    for (let i = b; i >= 0; i = this.prev[i]) { path.push(i); if (i === a) break; }
    path.reverse();
    if (path[0] !== a) return null;
    return { path, distM: this.dist[b], durH: this.time[b] };
  }

  /** polyline (world metres) for a node-index path. */
  polyOf(path: readonly number[]): XZ[] {
    return path.map((i) => ({ x: this.graph.nodes[i].x, z: this.graph.nodes[i].z }));
  }

  // ---------------------------------------------------------------------------
  // cached all-pairs times — the arbiter's cheap read.
  // ---------------------------------------------------------------------------
  walkH(a: number, b: number): number {
    if (!this.walkM) { this.walkM = this.buildMatrix('walk'); this.matrixBuilds++; }
    return this.walkM[a * this.n + b];
  }

  carH(a: number, b: number): number {
    const ver = this.congestion.regimeVersion();
    if (!this.carM || this.carRegime !== ver) {
      this.carM = this.buildMatrix('car');
      this.carRegime = ver;
      this.matrixBuilds++;
    }
    return this.carM[a * this.n + b];
  }

  /** mean congested car-hours over a set of node pairs (KPI input). */
  meanCarH(pairs: readonly [number, number][]): number {
    if (pairs.length === 0) return 0;
    let s = 0;
    for (const [a, b] of pairs) s += this.carH(a, b);
    return s / pairs.length;
  }

  private buildMatrix(mode: ModeId): Float64Array {
    const p = MODE_PARAMS[mode];
    const m = new Float64Array(this.n * this.n);
    for (let src = 0; src < this.n; src++) {
      // Dijkstra from src — O(N²+E) with N in the tens.
      this.time.fill(Infinity);
      this.closed.fill(0);
      this.time[src] = 0;
      for (;;) {
        let cur = -1, best = Infinity;
        for (let i = 0; i < this.n; i++) {
          if (!this.closed[i] && this.time[i] < best) { best = this.time[i]; cur = i; }
        }
        if (cur < 0) break;
        this.closed[cur] = 1;
        for (const ei of this.graph.edgesAt(cur)) {
          const e = this.graph.edges[ei];
          const o = this.graph.otherEnd(e, cur);
          const f = p.congestible ? this.congestion.factor(ei) : 1;
          const t = this.time[cur] + (e.lengthM / p.speed) * f;
          if (t < this.time[o]) this.time[o] = t;
        }
      }
      for (let i = 0; i < this.n; i++) m[src * this.n + i] = this.time[i];
    }
    return m;
  }
}

// ---------------------------------------------------------------------------
// generalized cost + logit mode choice (pure functions)
// ---------------------------------------------------------------------------

export function valueOfTime(wageRate: number | undefined): number {
  const w = wageRate !== undefined && wageRate > 0 ? wageRate : DEFAULT_WAGE;
  return Math.max(VOT_FLOOR, w * VOT_WAGE_SHARE);
}

/** the one substitution that makes distance real: every mode priced in the
 *  same $-equivalents, so wealth, fatigue, habit and congestion all compete. */
export function generalizedCost(mode: ModeId, durH: number, money: number,
                                distM: number, vot: number, fatigue: number,
                                habitBias: number): number {
  const p = MODE_PARAMS[mode];
  return durH * vot + money + p.energyPerKm * (distM / 1000) * fatigue + p.comfort + habitBias;
}

/** logit sample over mode options; temperature grows with openness. */
export function chooseMode(options: readonly ModeOption[], openness: number | undefined,
                           rng: RNG): ModeOption {
  const T = LOGIT_T0 + LOGIT_T1 * clamp01(openness ?? 0.35);
  let gMin = Infinity;
  for (const o of options) if (o.g < gMin) gMin = o.g;
  let sum = 0;
  const w: number[] = [];
  for (const o of options) { const e = Math.exp(-(o.g - gMin) / T); w.push(e); sum += e; }
  let r = rng() * sum;
  for (let i = 0; i < options.length; i++) { if ((r -= w[i]) <= 0) return options[i]; }
  return options[options.length - 1];
}

/** deterministic aggregate shares (no RNG) — the shadow population's split. */
export function logitShares(options: readonly ModeOption[], T: number): number[] {
  let gMin = Infinity;
  for (const o of options) if (o.g < gMin) gMin = o.g;
  let sum = 0;
  const w: number[] = [];
  for (const o of options) { const e = Math.exp(-(o.g - gMin) / T); w.push(e); sum += e; }
  return w.map((x) => x / sum);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
