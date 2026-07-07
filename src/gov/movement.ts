// =============================================================================
// ExposomeSim — CIVIC MOVEMENT: percolation, assembly calling, influence.
// -----------------------------------------------------------------------------
// Coordination crosses a threshold, or it doesn't. The movement's effective
// mass is NOT a raw global mean of opinion — it is the Tier-A salience mass
// weighted by the pairwise-link density among the salient (a coarse adjacency
// summary the world computes from relationship ledgers), amplified by the
// shadow field's aligned support. Below the percolation band the same total
// salience is politically inert: aggrieved strangers don't assemble.
//
//   massInst = perc(density) × Σ salience·max(0,support) × (1 + k·shadowLift)
//
// The mass rides a 12h-half-life EMA (no single loud hour calls an assembly).
// STIR/WANE use a Schmitt band (gate.ts discipline); the assembly CALL is a
// HAZARD on the excess mass — rate-driven, so formation timing varies across
// seeds and marginal fields may never call at all. The caller (govsim) owns
// the state machine; this class reports threshold signals.
//
// Influence (who calls the assembly, who stands for election) is adapted from
// Company.recomputeInfluence: an EMA of civic engagement RECEIVED (likes,
// replies, being persuasive in conversation) plus a salience term.
// =============================================================================

import { clamp, mulberry32, type RNG } from '../core/util/num';
import type { CivicPoint } from './types';

const HL_MASS = 12;          // mass EMA half-life
const HL_INFLUENCE = 72;     // engagement-received decay half-life
const STIR_T = 0.35;         // stirring latches above this…
const WANE_T = 0.18;         // …and releases below this (hysteresis band)
const CALL_T = 0.9;          // assembly hazard begins above this mass
const CALL_HAZ_PER_H = 0.05; // hazard per unit excess mass per hour
const PERC_LO = 0.15;        // link density below which no cluster percolates
const PERC_HI = 0.5;         // density at which the cluster is fully connected
const SHADOW_LIFT = 1.5;     // how much aligned shadow support amplifies the cluster
const ASSEMBLY_LEAD_H = 20;  // minimum notice before an assembly can start
const ASSEMBLY_HOUR = 18;    // assemblies convene at the evening hour…
const ASSEMBLY_LEN_H = 3;    // …and run three hours (a rule, not an outcome)
const ATTEND_R2 = 55 * 55;   // a center this close to the venue is an attendee

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface AssemblyRec {
  place: string;
  x: number;
  z: number;
  startH: number;
  endH: number;
  attendees: string[];       // distinct Tier-A center ids seen inside the radius
}

export class Movement {
  private rng: RNG;
  private massEma = 0;
  private stirring = false;
  private assembly: AssemblyRec | null = null;
  /** engagement-received EMA per Tier-A id — the influence ledger. */
  private engRecv = new Map<string, number>();

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
  }

  // ---------------------------------------------------------------------------
  // mass + threshold signals. Returns what crossed THIS tick; govsim applies
  // the state machine.
  // ---------------------------------------------------------------------------
  tick(tierMass: number, density01: number, shadowSupportMean: number, dtH: number):
      { stir: boolean; wane: boolean; callAssembly: boolean } {
    const perc = smoothstep((clamp(density01, 0, 1) - PERC_LO) / (PERC_HI - PERC_LO));
    const lift = 1 + SHADOW_LIFT * Math.max(0, shadowSupportMean);
    const inst = perc * tierMass * lift;
    const lam = 1 - Math.pow(0.5, dtH / HL_MASS);
    this.massEma += lam * (inst - this.massEma);

    // influence decay (one pass; the map stays small — it's Tier-A only)
    const dec = Math.pow(0.5, dtH / HL_INFLUENCE);
    for (const [id, v] of this.engRecv) this.engRecv.set(id, v * dec);

    let stir = false, wane = false, callAssembly = false;
    if (!this.stirring) {
      if (this.massEma > STIR_T) { this.stirring = true; stir = true; }
    } else if (this.massEma < WANE_T) {
      this.stirring = false; wane = true;
    }
    // the call is a hazard on excess mass — crossing CALL_T makes a call
    // POSSIBLE, not scheduled. One draw per tick, dt-scaled.
    if (this.stirring && this.assembly === null && this.massEma > CALL_T) {
      const p = 1 - Math.exp(-CALL_HAZ_PER_H * (this.massEma - CALL_T) * dtH);
      if (this.rng() < p) callAssembly = true;
    }
    return { stir, wane, callAssembly };
  }

  /** schedule the assembly at a borrowed venue: the next evening hour that
   *  gives at least ASSEMBLY_LEAD_H notice (word has to travel). */
  openAssembly(venue: CivicPoint, clock: number): AssemblyRec {
    let start = Math.ceil(clock + ASSEMBLY_LEAD_H);
    while (((start % 24) + 24) % 24 !== ASSEMBLY_HOUR) start++;
    this.assembly = {
      place: venue.id, x: venue.x, z: venue.z,
      startH: start, endH: start + ASSEMBLY_LEN_H, attendees: [],
    };
    return this.assembly;
  }

  /** during the window: any hot center inside the radius is a real attendee —
   *  attendance emerges from the world actually walking people there. */
  noteAttendance(centers: readonly CivicPoint[], clock: number): void {
    const a = this.assembly;
    if (!a || clock < a.startH || clock > a.endH) return;
    for (const c of centers) {
      const dx = c.x - a.x, dz = c.z - a.z;
      if (dx * dx + dz * dz <= ATTEND_R2 && !a.attendees.includes(c.id)) a.attendees.push(c.id);
    }
  }

  /** non-null once the window has closed; caller resolves quorum and clears. */
  dueAssembly(clock: number): AssemblyRec | null {
    return this.assembly && clock >= this.assembly.endH ? this.assembly : null;
  }

  assemblyRec(): AssemblyRec | null { return this.assembly; }
  clearAssembly(): void { this.assembly = null; }

  // ---------------------------------------------------------------------------
  // influence — engagement received + salience (queried at ranking time).
  // ---------------------------------------------------------------------------
  addEngagementReceived(id: string, amt: number): void {
    this.engRecv.set(id, (this.engRecv.get(id) ?? 0) + amt);
  }

  influenceOf(id: string, salience: number): number {
    return (this.engRecv.get(id) ?? 0) + 0.5 * salience;
  }

  /** highest-influence civic agent among the candidates (ties break on id —
   *  deterministic). Null if nobody carries any influence at all. */
  leader(candidates: readonly { id: string; salience: number }[]): string | null {
    let best: string | null = null, bestV = 1e-9;
    for (const c of candidates) {
      const v = this.influenceOf(c.id, c.salience);
      if (v > bestV || (v === bestV && best !== null && c.id < best)) { best = c.id; bestV = v; }
    }
    return best;
  }

  mass(): number { return this.massEma; }
  isStirring(): boolean { return this.stirring; }

  /** collapse after dissolution — the field keeps a memory of failure. */
  damp(factor: number): void { this.massEma *= factor; }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      rng: this.rng.save ? this.rng.save() : 0,
      mass: r6(this.massEma),
      stirring: this.stirring ? 1 : 0,
      assembly: this.assembly
        ? { place: this.assembly.place, x: this.assembly.x, z: this.assembly.z,
            startH: this.assembly.startH, endH: this.assembly.endH,
            attendees: this.assembly.attendees.slice() }
        : null,
      eng: [...this.engRecv.entries()].map(([id, v]) => [id, r6(v)]),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { rng?: number; mass?: number; stirring?: number; assembly?: AssemblyRec | null; eng?: unknown } | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    this.massEma = typeof o.mass === 'number' ? o.mass : 0;
    this.stirring = o.stirring === 1;
    this.assembly = o.assembly && typeof o.assembly.place === 'string'
      ? { place: o.assembly.place, x: o.assembly.x, z: o.assembly.z,
          startH: o.assembly.startH, endH: o.assembly.endH,
          attendees: Array.isArray(o.assembly.attendees) ? o.assembly.attendees.slice() : [] }
      : null;
    this.engRecv.clear();
    if (Array.isArray(o.eng)) {
      for (const row of o.eng) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number') this.engRecv.set(row[0], row[1]);
      }
    }
  }
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
