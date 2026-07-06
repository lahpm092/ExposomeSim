// =============================================================================
// ExposomeSim — CAUSAL GATE: which venues are inside the radius of attention.
// -----------------------------------------------------------------------------
// A venue is HOT while it sits within radius R of ANY causal center (a Tier-A
// agent or the camera). Hot venues earn discrete, watched events; cold venues
// drift statistically (see flow.ts). Two design rules:
//
//   • HYSTERESIS — enter at R, exit only past EXIT_FACTOR×R. A center loitering
//     on the boundary would otherwise flip the venue hot/cold every update,
//     thrashing whatever the renderer / flow layer mounts on the transition.
//     Same Schmitt-trigger idea as physio.ts's purchase latches.
//   • CHEAPNESS — plain squared-distance checks (no sqrt, no spatial index:
//     centers×venues is tens×tens), run only when the CALLER decides — the
//     intended cadence is ~once per 0.25 sim-h, not per frame. Between calls
//     isHot()/hotList() answer from the cached state.
//
// Deterministic (no RNG, no clocks of its own) and allocation-light: the heat
// map and the hot list are allocated once and mutated in place.
// =============================================================================

import type { CausalCenter, VenueHeat, VenuePoint } from './types';

/** default attention radius, metres (world units are real metres). */
const DEFAULT_RADIUS = 55;
/** exit at 1.25×R — the hysteresis band that stops boundary flicker. */
const EXIT_FACTOR = 1.25;

export class CausalGate {
  private readonly r2Enter: number;
  private readonly r2Exit: number;
  readonly radius: number;

  /** per-venue heat records, mutated in place (never re-allocated per update). */
  private heat = new Map<string, VenueHeat>();
  /** cached hot ids, rebuilt in place only when a transition happened. */
  private hot: string[] = [];
  /** cumulative hot↔cold transitions — a cheap flicker diagnostic. */
  private flips = 0;

  constructor(radius: number = DEFAULT_RADIUS, exitFactor: number = EXIT_FACTOR) {
    this.radius = radius;
    this.r2Enter = radius * radius;
    const rExit = radius * Math.max(1, exitFactor);
    this.r2Exit = rExit * rExit;
  }

  // ---------------------------------------------------------------------------
  // update — recompute the hot set from current positions. O(centers×venues).
  // ---------------------------------------------------------------------------
  update(centers: readonly CausalCenter[], venues: readonly VenuePoint[], clock: number): void {
    let dirty = false;
    for (const v of venues) {
      let h = this.heat.get(v.id);
      if (!h) { h = { id: v.id, hot: false, sinceH: clock }; this.heat.set(v.id, h); }

      // nearest center, squared metres (enough for threshold tests — no sqrt).
      let d2 = Infinity;
      for (const c of centers) {
        const dx = c.x - v.x, dz = c.z - v.z;
        const q = dx * dx + dz * dz;
        if (q < d2) d2 = q;
      }

      // Schmitt trigger: latch hot at the inner ring, release past the outer.
      if (!h.hot) {
        if (d2 <= this.r2Enter) { h.hot = true; h.sinceH = clock; this.flips++; dirty = true; }
      } else if (d2 > this.r2Exit) {
        h.hot = false; h.sinceH = clock; this.flips++; dirty = true;
      }
    }
    if (dirty) {
      this.hot.length = 0;                       // rebuild in place — no new array
      for (const h of this.heat.values()) if (h.hot) this.hot.push(h.id);
    }
  }

  /** is this venue currently inside the causal radius? (unknown ⇒ cold) */
  isHot(venueId: string): boolean {
    const h = this.heat.get(venueId);
    return h ? h.hot : false;
  }

  /** live list of hot venue ids — do not mutate; copy if you keep it. */
  hotList(): readonly string[] { return this.hot; }

  /** the full heat record (hot flag + transition hour), if the venue is known. */
  heatOf(venueId: string): VenueHeat | undefined { return this.heat.get(venueId); }

  /** cumulative transitions since construction — smoke tests bound this. */
  flipCount(): number { return this.flips; }

  // ---------------------------------------------------------------------------
  // persistence — heat is technically derivable from positions, but hysteresis
  // makes it path-dependent (a venue inside the band is hot or cold depending
  // on HOW it got there), so it must be saved for byte-identical resume.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    const heat: [string, number, number][] = [];
    for (const h of this.heat.values()) heat.push([h.id, h.hot ? 1 : 0, Math.round(h.sinceH * 1e3) / 1e3]);
    return { v: 1, flips: this.flips, heat };
  }

  loadJSON(j: unknown): void {
    const o = j as { flips?: number; heat?: unknown } | null;
    if (!o) return;
    if (typeof o.flips === 'number') this.flips = o.flips | 0;
    if (Array.isArray(o.heat)) {
      this.heat.clear();
      this.hot.length = 0;
      for (const row of o.heat) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const rec: VenueHeat = { id: row[0], hot: row[1] === 1, sinceH: typeof row[2] === 'number' ? row[2] : 0 };
        this.heat.set(rec.id, rec);
        if (rec.hot) this.hot.push(rec.id);
      }
    }
  }
}
