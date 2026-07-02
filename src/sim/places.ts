// =============================================================================
// ExposomeSim — places.ts
// -----------------------------------------------------------------------------
// The ONLY authored content of the town layer: four (+1 stub) place nodes for a
// compressed modern-western life. Behaviour over these is NOT scripted — the
// Town orchestrator arbitrates these affordances against Maslow deficits read
// off the soma, bound by money / food / energy / time. This file is pure data
// plus two stateless helpers (open-hours test + telescoped travel time).
// =============================================================================

import type { Affordance, Place, PlaceId } from '../types';
import { clamp } from '../util/num';

// ---------------------------------------------------------------------------
// Affordances — what each locale lets you *do*. Costs are in the resource
// economy's own units (money ≈ currency; energy ≈ fatigue delta in [0,1]).
// Convention: costMoney<0 EARNS, costEnergy<0 RESTORES.
// ---------------------------------------------------------------------------

/** Sleep / recover at home — the only thing that pays down fatigue. */
const REST: Affordance = {
  kind: 'rest',
  tier: 'physiological',   // energy is a physiological need
  satisfies: 0.85,
  costMoney: 0,
  // small negative: resting clears fatigue, but its VALUE is the energy-deficit
  // relief in the utility's tier term — a big unconditional bonus here would make
  // her rest even when rested (a homebody attractor).
  costEnergy: -0.1,
  durHours: 7,
};

/** Eat a meal from the home pantry — consumes one unit of foodStock. */
const EAT: Affordance = {
  kind: 'eat',
  tier: 'physiological',
  satisfies: 0.9,
  costMoney: 0,
  costEnergy: 0.02,
  durHours: 0.5,
  needsFoodStock: true,
};

/** Drink water — reset the hypothalamic osmostat. Nearly free, quick, available
 *  wherever there's a tap: home, the market, the café, a park fountain. */
const DRINK: Affordance = {
  kind: 'drink',
  tier: 'physiological',
  satisfies: 0.9,
  costMoney: 0,
  costEnergy: 0.0,
  durHours: 0.15,
};

/** Use a toilet — void bladder/bowel. Trivial cost, but its NEED (elimination)
 *  is steep near-full, so it can override a shift. Wherever there's a restroom. */
const TOILET: Affordance = {
  kind: 'relieve',
  tier: 'physiological',
  satisfies: 0.95,
  costMoney: 0,
  costEnergy: 0.0,
  durHours: 0.08,
};

/** A warm bath at home — restores hygiene; a mild self-care that reads as a
 *  morning ritual (via circadian fit + a habit memory), not a hard schedule. */
const BATHE: Affordance = {
  kind: 'bathe',
  tier: 'physiological',
  satisfies: 0.9,
  costMoney: 0,
  costEnergy: -0.02,       // mildly restorative
  durHours: 0.4,
};

/** A shift behind the counter — the income source; tiring but esteem-bearing. */
const WORK: Affordance = {
  kind: 'work',
  tier: 'esteem',
  satisfies: 0.5,
  costMoney: -90,          // NEGATIVE: a shift EARNS wage
  costEnergy: 0.5,
  durHours: 8,
};

/** Grab a staff burger at work — prepared food for a few dollars; the only food
 *  source besides cooking groceries from home. Sates hunger without the pantry. */
const BUY_MEAL: Affordance = {
  kind: 'buy_meal',
  tier: 'physiological',
  satisfies: 0.62,         // a burger takes the edge off but she still cooks properly later
  costMoney: 5,
  costEnergy: 0.02,
  durHours: 0.4,
};

/** Grocery run — converts money into home foodStock (the orchestrator restocks).
 *  Tagged PHYSIOLOGICAL: shopping is instrumental to eating, so Maslow prepotency
 *  must let high hunger RECRUIT it — not throttle it (the way it throttles esteem). */
const SHOP: Affordance = {
  kind: 'shop',
  tier: 'physiological',
  satisfies: 0.6,
  costMoney: 24,           // ~aligns with economy GROCERY_COST
  costEnergy: 0.15,
  durHours: 0.75,
};

/** Coffee + company at the third place — the belonging / social-interaction site. */
const SOCIALIZE: Affordance = {
  kind: 'socialize',
  tier: 'belonging',
  satisfies: 0.88,
  costMoney: 6,
  costEnergy: 0.05,
  durHours: 1.5,
  social: true,
};

/** Idle in the park — cheap novelty / self-direction (stub locale). */
const LINGER: Affordance = {
  kind: 'linger',
  tier: 'actualization',
  satisfies: 0.4,
  costMoney: 0,
  costEnergy: 0.05,
  durHours: 1,
  social: true,
};

// ---------------------------------------------------------------------------
// The place graph. pos2D ∈ [0,1] town coords; openHours [open, close) wrapping
// if open>close; [0,24] = always open.
// ---------------------------------------------------------------------------
export const PLACES: Record<PlaceId, Place> = {
  home: {
    id: 'home',
    name: 'Apartment',
    pos2D: { x: 0.2, y: 0.7 },
    openHours: [0, 24],
    capacity: 1,
    localeKind: 'apartment',
    affordances: [REST, EAT, DRINK, TOILET, BATHE],
  },
  work: {
    id: 'work',
    name: 'The Counter',
    pos2D: { x: 0.7, y: 0.3 },
    openHours: [8, 22],
    capacity: 8,
    localeKind: 'counter',
    affordances: [WORK, DRINK, TOILET, BUY_MEAL],
  },
  market: {
    id: 'market',
    name: 'Corner Market',
    pos2D: { x: 0.5, y: 0.6 },
    openHours: [8, 21],
    capacity: 12,
    localeKind: 'market',
    affordances: [SHOP, DRINK],
  },
  thirdplace: {
    id: 'thirdplace',
    name: 'Café',
    pos2D: { x: 0.8, y: 0.8 },
    openHours: [15, 24],
    capacity: 6,
    localeKind: 'cafe',
    affordances: [SOCIALIZE, DRINK],
  },
  // stub node — present so PlaceId stays total; cheap optional novelty sink.
  park: {
    id: 'park',
    name: 'Riverside Park',
    pos2D: { x: 0.35, y: 0.35 },
    openHours: [6, 22],
    capacity: 20,
    localeKind: 'park',
    affordances: [LINGER, DRINK],
  },
};

/** Iterable view of the place graph (stable insertion order). */
export const PLACE_LIST: Place[] = Object.values(PLACES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Is `p` open at absolute sim-hour `clock`?
 * openHours is [open, close): a normal interval when open<=close, and a
 * midnight-wrapping interval when open>close. [0,24] is therefore always open.
 */
export function openNow(p: Place, clock: number): boolean {
  const h = ((clock % 24) + 24) % 24; // wrap into [0,24)
  const [o, c] = p.openHours;
  if (o === c) return true;           // degenerate: treat as always open
  if (o <= c) return h >= o && h < c; // normal window (covers [0,24])
  return h >= o || h < c;             // wraps past midnight
}

/**
 * Telescoped travel time in sim-hours between two places, derived from the
 * euclidean distance of their town coordinates and compressed into ~[0.15,0.5]h
 * so a full day's movement stays cheap. Same place ⇒ 0.
 */
export function travelTime(a: PlaceId, b: PlaceId): number {
  if (a === b) return 0;
  const pa = PLACES[a].pos2D;
  const pb = PLACES[b].pos2D;
  const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y); // [0, ~1.41]
  return clamp(0.1 + dist * 0.55, 0.15, 0.5);
}
