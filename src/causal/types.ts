// =============================================================================
// ExposomeSim — CAUSAL RADIUS shared contract.
// -----------------------------------------------------------------------------
// The causal layer gates the RESOLUTION of causality, never conservation
// (WORLD_EXPANSION.md §3). The econ tick keeps computing exact aggregate
// flows; this module decides where those flows become DISCRETE, WATCHED
// events (a customer walks in, a basket is rung up) versus statistical drift
// that only exists as totals. Everything under src/causal/ imports ONLY from
// this file plus core/util — no THREE, no DOM, no econ, no world. Integration
// (town/econ/render wiring) happens elsewhere, against these types.
// =============================================================================

/** A source of causal attention: a Tier-A agent's position, or the camera.
 *  Venues inside a center's radius get fully-simulated (HOT) treatment. */
export interface CausalCenter {
  id: string;
  x: number;
  z: number;
}

/** A venue (business premises) as the gate sees it: a point plus the
 *  archetype it pools statistics under ('bakery', 'grocer', …). */
export interface VenuePoint {
  id: string;
  x: number;
  z: number;
  archetype: string;
}

/** A venue's current heat state. `sinceH` is the sim-hour of the last
 *  transition — how long it has been hot (or cold). */
export interface VenueHeat {
  id: string;
  hot: boolean;
  sinceH: number;
}

/** What the causal layer sends into this tick's flow for ONE venue: the
 *  venue's slice of the sector's aggregate demand, in units and dollars.
 *  These totals are computed by the econ tick and are already exact —
 *  the causal layer only re-expresses them. */
export interface VenueFlowInput {
  venueId: string;
  units: number;
  revenue: number;
}

/** One venue's flow for one tick, after the causal layer decided its
 *  resolution. HOT → `discrete: true`, `arrivals` is an integer count of
 *  customer events with a real `basket` each. COLD → `discrete: false`,
 *  `arrivals` is a fractional expectation. Either way
 *  arrivals × basket == the units actually moved this tick. */
export interface VenueFlowTick {
  venueId: string;
  arrivals: number;
  basket: number;
  revenue: number;
  discrete: boolean;
}

/** Per-venue readout of the evolving surrogate, for HUDs / the observatory.
 *  `hourShape` is a 24-bucket probability distribution (sums to 1) of when
 *  this venue's arrivals happen; `confidence` is how much of that shape is
 *  the venue's own data versus the pooled archetype prior. */
export interface VenueStatsView {
  venueId: string;
  visits: number;
  hourShape: number[];   // 24 entries, sums to 1
  meanBasket: number;
  confidence: number;    // 0..1
}

/** The whole causal layer's compact snapshot. */
export interface CausalView {
  radius: number;
  hot: string[];
  stats: VenueStatsView[];
}
