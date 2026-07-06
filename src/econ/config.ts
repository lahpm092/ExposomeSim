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
    anchor: true,   // Mara's venue — load-bearing for the town sim
  },
  {
    id: 'biz-office', name: 'Meridian Software', sector: 'software',
    seedCash: 42000, basePrice: 230, unitCost: 40, capacityPerWorker: 0.32,
    baseWage: 34, commercialRent: 5200, founderIds: OFFICE_FOUNDERS, maxHeadcount: 20,
    anchor: true,   // the office cast works here
  },
  // (groceries are supplied by the Supermarket — see sim/econ/supermarket.ts —
  //  which is the town's grocery hub; no separate corner-store firm.)
  {
    id: 'biz-utilities', name: 'Civic Water & Power', sector: 'utilities',
    seedCash: 22000, basePrice: 1.2, unitCost: 0.5, capacityPerWorker: 27,
    baseWage: 20, commercialRent: 1100, founderIds: [], maxHeadcount: 6,
    anchor: true,   // infrastructure: the town cannot lose its water supply
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

// =============================================================================
// PHASE 4 — emergence expansions (see ECONOMY_EMERGENCE.md)
// =============================================================================

// ---- E1: money matters (rates → real activity) ------------------------------
export const RATE_SENS = 1.4;         // hiring-bar sensitivity to dear money
export const RATE_NEUTRAL = 0.075;    // lending rate at which financing is "neutral"
export const HURDLE_HOUSING = 0.145;  // construction won't break ground above these
export const HURDLE_COMMERCIAL = 0.125;

// ---- E5: expectations + inventories (Metzler) --------------------------------
export const EXP_ADAPT = 0.25;        // default demand-expectation learning rate /h
export const INV_BUFFER = 0.08;       // production margin above expected demand
export const INV_CORRECT = 0.35;      // per-tick correction toward target inventory
/** target inventory in HOURS of expected demand (0 = non-storable sector). */
export const INV_TARGET_H: Record<Sector, number> = {
  food: 1.5, groceries: 0, software: 0, utilities: 0, retail: 3,
};
/** the inventory-gap correction is bounded to ±this × expected demand per tick,
 *  so a bare shelf can't demand 3× capacity (which would nullify every other
 *  production signal, incl. the profitability gate). */
export const INV_CORRECT_CAP = 0.6;
/** fraction of unsold stock that survives one sim-hour (0 = perishes instantly). */
export const INV_KEEP_H: Record<Sector, number> = {
  food: 0.75, groceries: 0, software: 0, utilities: 0, retail: 0.995,
};

// ---- E3: household balance sheets (consumer credit / Minsky) -----------------
export const CC_TRIGGER = 40;         // draw on the credit line below this cash
export const CC_CHUNK = 150;          // credit-line draw size
export const CC_COMFORT = 420;        // start repaying above this cash
export const CC_REPAY_K = 0.02;       // per-hour repayment rate on the excess
export const CC_LIMIT_WEEKS = 0.5;    // debt cap ≈ this × weekly wage income
export const CC_DEFAULT_MONEY = -260; // broke line: jobless + below this ⇒ default
export const CC_LOCK_HOURS = 24 * 45; // credit lockout after a default
export const FEAR_U0 = 0.075;         // unemployment above this breeds precaution
export const FEAR_K = 6;              // how fast fear saturates
export const FEAR_CUT = 0.45;         // max discretionary cut from precautionary saving

// ---- E4: firm demography (entry/exit) ----------------------------------------
export const ENTRY_SHORT_EMA = 0.08;  // persistent shortage that invites entry…
export const ENTRY_MIN_MARGIN = 1.5;  // …but only at a price ≥ this × template cost
export const ENTRY_FAT_MARGIN = 2.5;  // a price this far above cost invites entry by itself
export const ENTRY_HAZARD = 0.02;     // per-hour founding hazard while signal is on
export const ENTRY_COOLDOWN_H = 96;   // min hours between foundings
export const ENTRY_WARMUP_H = 240;    // no entry while the t0 transient settles
export const ENTRY_MIN_WEALTH = 700;  // a founder household needs at least this
export const ENTRY_EQUITY_FRAC = 0.6; // share of founder wealth put in as equity
export const ENTRY_EQUITY_CAP = 500;
export const ENTRY_MIN_EQUITY = 250;  // below this (credit rationed) the venture aborts
export const DIV_K = 0.05;            // per-hour dividend rate on excess owner-firm cash
/** max firms per sector (0 = no entry; groceries is the supermarket's). */
export const SECTOR_FIRM_CAP: Record<Sector, number> = {
  food: 3, groceries: 0, software: 2, utilities: 2, retail: 3,
};
/** entrant templates (draws jitter productivity/cost around these). */
export const SECTOR_TEMPLATES: Record<Sector, {
  basePrice: number; unitCost: number; capacityPerWorker: number;
  baseWage: number; commercialRent: number;
}> = {
  food: { basePrice: 3.8, unitCost: 2.0, capacityPerWorker: 10, baseWage: 12, commercialRent: 200 },
  groceries: { basePrice: 2.2, unitCost: 1.1, capacityPerWorker: 16, baseWage: 11, commercialRent: 260 },
  software: { basePrice: 230, unitCost: 40, capacityPerWorker: 0.30, baseWage: 30, commercialRent: 900 },
  utilities: { basePrice: 1.2, unitCost: 0.5, capacityPerWorker: 24, baseWage: 19, commercialRent: 420 },
  retail: { basePrice: 3.6, unitCost: 1.8, capacityPerWorker: 10, baseWage: 11, commercialRent: 220 },
};
export const FIRM_NAMES: Record<Sector, string[]> = {
  food: ['Ash & Ember Diner', 'Marrow Kitchen', 'The Tin Spoon', 'Solstice Grill'],
  groceries: ['Larder & Co', 'Northside Pantry'],
  software: ['Kestrel Systems', 'Bluewire Labs', 'Fathom Analytics'],
  utilities: ['Eastbank Utilities', 'Granite Power Co-op'],
  retail: ['Foxglove Goods', 'Paper Lantern', 'Harbor Sundries', 'Wren & Co'],
};

// ---- E4/E6: job ladder + labour frictions -------------------------------------
export const POACH_MARGIN = 1.15;     // a raise ≥15% tempts an employed worker
export const OTJ_SEARCH_P = 0.35;     // chance an underpaid worker looks this tick
export const HOMELESS_PENALTY = 0.15; // match-score penalty while homeless

// ---- endogenized software demand (B2B ∝ firms alive) --------------------------
export const SOFT_PER_FIRM = 0.7;     // units/h of software demand per firm alive
export const SOFT_EXTERNAL = 2.0;     // out-of-town client baseline (units/h)
