// =============================================================================
// ExposomeSim — ECONOMY configuration & seed data.
// -----------------------------------------------------------------------------
// The authored content of the economy: the firms that exist at t0, the macro
// constants, and the price/wage anchors. Everything else (prices, wages,
// headcount, unemployment, homelessness) EMERGES from the dynamics. Anchors are
// chosen to be consistent with the pre-existing single-wallet economy
// (WAGE_PER_HOUR≈12, RENT≈120, GROCERY≈22 in sim/economy.ts).
// =============================================================================

import type { BusinessConfig, BuildLot, Sector } from './types';

// ---- cadence ---------------------------------------------------------------
/** The economy advances on its own coarse clock: one econ tick per this many
 *  sim-hours of accumulated dt. Keeps the O(N) shadow sweep off the render frame.*/
export const ECON_TICK_HOURS = 1.0;

// ---- housing / survival ----------------------------------------------------
export const RENT_PERIOD = 24 * 7;      // weekly rent (matches economy.ts)
export const BASE_RENT = 120;           // t0 market rent (matches economy.ts RENT)
export const EVICT_MISSED_PERIODS = 3;  // consecutive missed rents → eviction → homeless
export const RUIN_MONEY = -500;         // debt floor: below this you cannot pay rent/food
export const DWELLINGS = 320;           // total housing units (Tier A housed + Tier C pool)

// ---- subsistence (per sim-day baseline draw when hungry/thirsty) -----------
// These double as the demand-curve reference prices (shadowpop REF); keeping them
// aligned with each firm's basePrice makes the market clear NEAR base, so the CPI
// index hovers around 1 instead of settling far from its t0 sticker.
export const FOOD_UNIT_PRICE = 3.8;     // one prepared/home meal
export const WATER_UNIT_PRICE = 1.2;    // one drink unit
export const GROCERY_UNIT_PRICE = 2.2;  // one grocery meal-equivalent (bulk, cheaper)
export const MEALS_PER_DAY = 3;
export const WATER_PER_DAY = 6;

// ---- labour ----------------------------------------------------------------
export const BASE_WAGE = 12;            // matches economy.ts WAGE_PER_HOUR
export const MIN_WAGE = 8;
export const WAGE_ADJ = 0.06;           // how fast a firm moves wages toward clearing
export const SKILL_GROWTH = 0.02;       // per sim-day of work (× conscientiousness)
export const TRAIN_SKILL_GROWTH = 0.06; // faster while "training" (unemployed upskilling)
export const HIRE_SKILL_FLOOR = 0.0;    // firms may raise their own bar above this

// ---- goods market (tâtonnement) --------------------------------------------
export const PRICE_ADJ = 0.05;          // price elasticity of the excess-demand law
export const DEMAND_ELASTICITY = 0.8;   // how sharply demand falls as price rises

// ---- shadow population (Tier C) --------------------------------------------
export const SHADOW_N = 240;            // cheap probabilistic households
export const SHADOW_SEED_MONEY = 200;   // mean starting cash (lognormal-ish spread)

// ---- the firms present at t0 -----------------------------------------------
// founderIds are the Tier-A ids that ANCHOR the firm (they start employed there).
// Ids follow roster.ts: `cashier-mara`, `agent-<name>`. Office founders = the 15
// office roster ids; the counter = Mara + Gus + Rosa. Grocery / utilities / café
// start shadow-staffed (no Tier-A founders) so they employ the unemployment pool.
export const OFFICE_FOUNDERS = [
  'agent-danaokafor', 'agent-ivopetrov', 'agent-lenasato', 'agent-marcoricci',
  'agent-priyanair', 'agent-kenadeyemi', 'agent-bealindqvist', 'agent-theomarsh',
  'agent-wrenoduya', 'agent-solrivera', 'agent-nikasorensen', 'agent-kaifischer',
  'agent-mirakovac', 'agent-dexnakamura', 'agent-luxabara',
];
export const COUNTER_FOUNDERS = ['cashier-mara', 'agent-gushale', 'agent-rosavidal'];

// Capacities are sized so supply ≈ town demand at a few workers (prices clear near
// base), and unitCost sits safely below basePrice so no firm is structurally
// loss-making (bankruptcy should be an EMERGENT bad-luck outcome, not built in).
export const BUSINESSES: BusinessConfig[] = [
  {
    id: 'biz-counter', name: 'The Counter', sector: 'food',
    seedCash: 4200, basePrice: 3.8, unitCost: 2.0, capacityPerWorker: 10,
    baseWage: 12, commercialRent: 240, founderIds: COUNTER_FOUNDERS, maxHeadcount: 4,
  },
  {
    id: 'biz-office', name: 'Meridian Software', sector: 'software',
    seedCash: 42000, basePrice: 230, unitCost: 40, capacityPerWorker: 0.32,
    baseWage: 34, commercialRent: 5200, founderIds: OFFICE_FOUNDERS, maxHeadcount: 20,
  },
  // (groceries are supplied by the Supermarket — see sim/econ/supermarket.ts —
  //  which is the town's grocery hub; no separate corner-store firm.)
  {
    id: 'biz-utilities', name: 'Civic Water & Power', sector: 'utilities',
    seedCash: 22000, basePrice: 1.2, unitCost: 0.5, capacityPerWorker: 27,
    baseWage: 20, commercialRent: 1100, founderIds: [], maxHeadcount: 6,
  },
  {
    id: 'biz-cafe', name: 'Riverside Café', sector: 'retail',
    seedCash: 4400, basePrice: 3.6, unitCost: 1.8, capacityPerWorker: 10,
    baseWage: 11, commercialRent: 320, founderIds: [], maxHeadcount: 3,
  },
];

/** which sector supplies each subsistence need the town reports. */
export const NEED_SECTOR: { food: Sector; water: Sector; groceries: Sector } = {
  food: 'food', water: 'utilities', groceries: 'groceries',
};

// ---- banking + construction ------------------------------------------------
export const BANK_CAPITAL = 150000;        // lendable reserves
export const CONSTRUCTION_SEED_CASH = 5000;
export const CONSTRUCTION_WAGE = 17;
/** the 5 Tier-A construction workers (ids follow roster.ts). */
export const CONSTRUCTION_FOUNDERS = [
  'agent-tomek', 'agent-bianca', 'agent-hassan', 'agent-yuki', 'agent-omar',
];

/** empty buildable LOTS (world metres) on the expanded city plane, kept clear of
 *  the central locales. The construction firm claims a free lot per project; the
 *  render places the building at (x,z) with footprint w×d. */
function makeLots(): BuildLot[] {
  const lots: BuildLot[] = [];
  const xs = [-108, -72, -40, 40, 72, 108];
  const zs = [-96, -54, 54, 96];
  let i = 0;
  for (const x of xs) for (const z of zs) lots.push({ id: 'lot' + i++, x, z, w: 24, d: 18 });
  return lots;
}
export const BUILD_LOTS: BuildLot[] = makeLots();

// ---- supermarket: groceries basket driven by physiological shopping trips ----
export const GROCERY_BASKET = 3.2;         // grocery units per shopping trip (× appetite)
