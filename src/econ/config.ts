// =============================================================================
// ExposomeSim — ECONOMY configuration & seed data.
// -----------------------------------------------------------------------------
// The authored content of the economy: the firms that exist at t0, the macro
// constants, and the price/wage anchors. Everything else (prices, wages,
// headcount, unemployment, homelessness) EMERGES from the dynamics. Anchors are
// chosen to be consistent with the pre-existing single-wallet economy
// (WAGE_PER_HOUR≈12, RENT≈120, GROCERY≈22 in sim/economy.ts).
// =============================================================================

import type { BusinessConfig, BuildLot, GoodId, Sector } from './types';

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
  // ---- phase 5: the supply chain ------------------------------------------
  // The town's grocery hub, refactored from the old Supermarket singleton into a
  // real RETAIL firm: it buys goods at wholesale onto category shelves and sells
  // at the groceries sector price. Its bespoke building already exists (no
  // archetype, no premises). unitCost ≈ the blended wholesale anchor (used for
  // entry-margin math and the marginal-cost supply floor, not per-unit COGS —
  // real COGS is what it actually pays at wholesale).
  {
    id: 'biz-market', name: 'Meridian Fresh Market', sector: 'groceries',
    seedCash: 12000, basePrice: 2.2, unitCost: 1.21, capacityPerWorker: 60,
    baseWage: 11, commercialRent: 420, founderIds: [], maxHeadcount: 4,
    anchor: true,   // the town cannot lose its only food shop
    kind: 'retail',
    shelf: [
      { good: 'produce', share: 0.22, cap: 420 },
      { good: 'dairy', share: 0.15, cap: 300 },
      { good: 'bakery', share: 0.20, cap: 260 },
      { good: 'meat', share: 0.14, cap: 260 },
      { good: 'grains', share: 0.17, cap: 460 },
      { good: 'drinks', share: 0.12, cap: 320 },
    ],
  },
  // Two seeded MAKERS so the wholesale markets are alive at t0 (everything else
  // emerges). Shadow-staffed like the café; premises pre-assigned on two
  // BUILD_LOTS as pre-existing buildings (see SEED_PREMISES).
  {
    id: 'biz-bakehouse', name: 'Hearth & Rye Bakehouse', sector: 'groceries',
    seedCash: 6500, basePrice: 1.32, unitCost: 0.4, capacityPerWorker: 18,
    baseWage: 10, commercialRent: 130, founderIds: [], maxHeadcount: 3,
    kind: 'maker', good: 'bakery', archetype: 'bakery',
  },
  {
    id: 'biz-alderplane', name: 'Alder & Plane Furniture', sector: 'homegoods',
    seedCash: 7000, basePrice: 3.3, unitCost: 1.15, capacityPerWorker: 10,
    baseWage: 11, commercialRent: 130, founderIds: [], maxHeadcount: 3,
    kind: 'maker', good: 'furniture', archetype: 'furniture',
  },
  // ---- phase 6: mobility (TRANSPORT_DESIGN.md 'fleet + operators') ----------
  // The dealership is a plain RETAIL firm: car + bike shelves restocked from
  // wholesale markets whose import channel IS the out-of-town manufacture
  // (GOOD_MAKER_CAP 0 — nobody builds cars here). basePrice = the share-blended
  // vehicle sticker (see VEHICLE_BASE); buyers pay the per-kind anchor ratio.
  // capacityPerWorker sits WELL above the integer purchase lumps (~0.3/h mean,
  // spikes of 2-3): a dealer whose staff throughput reads a two-buyer hour as
  // a shortage ratchets the sticker to the tâtonnement ceiling and never back.
  {
    id: 'biz-dealership', name: 'Axle & Rim Motors', sector: 'vehicles',
    seedCash: 9000, basePrice: 157.5, unitCost: 87, capacityPerWorker: 4,
    baseWage: 12, commercialRent: 240, founderIds: [], maxHeadcount: 2,
    kind: 'retail', archetype: 'dealership',
    shelf: [
      { good: 'car', share: 0.3, cap: 10 },
      { good: 'bike', share: 0.7, cap: 22 },
    ],
  },
  // The taxi firm: a service Business selling rides into the transit sector.
  // capacityPerWorker sized so ONE driver serves the town's t0 fare demand
  // (~7 rides/h) at ~70% utilisation — under the hiring bar, so it doesn't
  // hire-fire oscillate (the phase-4 balance lesson).
  {
    id: 'biz-taxi', name: 'Crossline Cabs', sector: 'transit',
    seedCash: 3800, basePrice: 3.2, unitCost: 0.9, capacityPerWorker: 10,
    baseWage: 13, commercialRent: 220, founderIds: [], maxHeadcount: 3,
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
/** a PRE-LET commercial project (entrants already queueing for the units) is
 *  de-risked — it pencils out at a dearer financing rate than a spec shell. */
export const HURDLE_PRELET = 0.16;

// ---- E5: expectations + inventories (Metzler) --------------------------------
export const EXP_ADAPT = 0.25;        // default demand-expectation learning rate /h
export const INV_BUFFER = 0.08;       // production margin above expected demand
export const INV_CORRECT = 0.35;      // per-tick correction toward target inventory
/** target inventory in HOURS of expected demand (0 = non-storable sector). */
export const INV_TARGET_H: Record<Sector, number> = {
  food: 1.5, groceries: 0, software: 0, utilities: 0, retail: 3,
  homegoods: 4, apparel: 4, transit: 0, vehicles: 4,
};
/** the inventory-gap correction is bounded to ±this × expected demand per tick,
 *  so a bare shelf can't demand 3× capacity (which would nullify every other
 *  production signal, incl. the profitability gate). */
export const INV_CORRECT_CAP = 0.6;
/** fraction of unsold stock that survives one sim-hour (0 = perishes instantly). */
export const INV_KEEP_H: Record<Sector, number> = {
  food: 0.75, groceries: 0, software: 0, utilities: 0, retail: 0.995,
  homegoods: 0.998, apparel: 0.998, transit: 0, vehicles: 0.999,
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
/** max firms per sector (0 = no entry). Groceries/homegoods/apparel entry
 *  founds RETAIL firms (see KIND_FOR_SECTOR) — a second supermarket can EMERGE. */
export const SECTOR_FIRM_CAP: Record<Sector, number> = {
  food: 3, groceries: 2, software: 2, utilities: 2, retail: 3,
  homegoods: 2, apparel: 2,
  // transit cap 2 = the seeded taxi + ONE more operator: a rich household on a
  // persistent transit shortage, or the publicly-chartered authority —
  // whichever the race produces first (TRANSPORT_DESIGN.md). One dealership.
  transit: 2, vehicles: 1,
};
/** entrant templates (draws jitter productivity/cost around these). For the
 *  RETAIL sectors, unitCost ≈ the (blended) wholesale anchor — the margin math
 *  and the marginal-cost supply floor read it; real COGS is paid at wholesale. */
export const SECTOR_TEMPLATES: Record<Sector, {
  basePrice: number; unitCost: number; capacityPerWorker: number;
  baseWage: number; commercialRent: number;
}> = {
  food: { basePrice: 3.8, unitCost: 2.0, capacityPerWorker: 10, baseWage: 12, commercialRent: 200 },
  groceries: { basePrice: 2.2, unitCost: 1.22, capacityPerWorker: 18, baseWage: 11, commercialRent: 260 },
  software: { basePrice: 230, unitCost: 40, capacityPerWorker: 0.30, baseWage: 30, commercialRent: 900 },
  utilities: { basePrice: 1.2, unitCost: 0.5, capacityPerWorker: 24, baseWage: 19, commercialRent: 420 },
  retail: { basePrice: 3.6, unitCost: 1.8, capacityPerWorker: 10, baseWage: 11, commercialRent: 220 },
  homegoods: { basePrice: 6.0, unitCost: 3.3, capacityPerWorker: 6, baseWage: 10, commercialRent: 170 },
  apparel: { basePrice: 7.0, unitCost: 3.85, capacityPerWorker: 6, baseWage: 10, commercialRent: 170 },
  // transit unitCost ≈ vehicle wear + fuel per ride: margin at base fare is
  // 2.13× — over the 1.5× shortage-entry floor, under the 2.5× fat-margin bar,
  // so a private operator enters ONLY on a persistent unserved-ride shortage.
  transit: { basePrice: 3.2, unitCost: 1.5, capacityPerWorker: 9, baseWage: 13, commercialRent: 200 },
  vehicles: { basePrice: 157.5, unitCost: 87, capacityPerWorker: 4, baseWage: 12, commercialRent: 240 },
};
export const FIRM_NAMES: Record<Sector, string[]> = {
  food: ['Ash & Ember Diner', 'Marrow Kitchen', 'The Tin Spoon', 'Solstice Grill'],
  groceries: ['Larder & Co', 'Northside Pantry'],
  software: ['Kestrel Systems', 'Bluewire Labs', 'Fathom Analytics'],
  utilities: ['Eastbank Utilities', 'Granite Power Co-op'],
  retail: ['Foxglove Goods', 'Paper Lantern', 'Harbor Sundries', 'Wren & Co'],
  homegoods: ['Gable & Grain Home', 'The Copper Kettle', 'Hearthside Goods'],
  apparel: ['Juniper Thread', 'Second Bloom Clothiers', 'Warp & Weft'],
  transit: ['Beacon Rides', 'Northgate Coaches'],
  vehicles: ['Harborview Motors'],
};

// ---- E4/E6: job ladder + labour frictions -------------------------------------
export const POACH_MARGIN = 1.15;     // a raise ≥15% tempts an employed worker
export const OTJ_SEARCH_P = 0.35;     // chance an underpaid worker looks this tick
export const HOMELESS_PENALTY = 0.15; // match-score penalty while homeless

// ---- endogenized software demand (B2B ∝ firms alive) --------------------------
export const SOFT_PER_FIRM = 0.7;     // units/h of software demand per firm alive
export const SOFT_EXTERNAL = 2.0;     // out-of-town client baseline (units/h)

// =============================================================================
// PHASE 5 — goods supply chains, premises, dual construction
// (see WORLD_EXPANSION.md §1-2)
// =============================================================================

// ---- CPI basket (weighted; the durables join at small weights) ---------------
export const CPI_WEIGHTS: Partial<Record<Sector, number>> = {
  food: 0.30, groceries: 0.27, utilities: 0.20, retail: 0.13,
  homegoods: 0.05, apparel: 0.05, transit: 0.04, vehicles: 0.02,
};

// ---- goods price anchors ------------------------------------------------------
/** per-good RETAIL anchor (what a unit stickers at in its sector). */
export const GOOD_RETAIL_ANCHOR: Record<GoodId, number> = {
  produce: 2.0, dairy: 2.4, bakery: 2.4, meat: 3.2, grains: 1.6, drinks: 1.8,
  furniture: 6.0, apparel: 7.0, car: 420, bike: 45,
};
/** wholesale base ≈ 55% of the retail anchor (the maker's side of the margin). */
export const WHOLESALE_FRAC = 0.55;
export const GOOD_WHOLESALE_BASE: Record<GoodId, number> = Object.fromEntries(
  (Object.keys(GOOD_RETAIL_ANCHOR) as GoodId[]).map((g) => [g, GOOD_RETAIL_ANCHOR[g] * WHOLESALE_FRAC]),
) as Record<GoodId, number>;
/** the external IMPORTER sells any residual demand at ~1.1 × base wholesale — a
 *  perfectly elastic world-price anchor. Money paid for imports LEAKS to
 *  External exactly like raw-material COGS (no domestic recipient). Grains +
 *  drinks have no seeded maker, so they are import-supplied until one enters;
 *  every other good imports only the gap its local makers leave. */
export const IMPORT_MARKUP = 1.1;

// ---- the retail shelf ----------------------------------------------------------
/** which goods stock each RETAIL sector's shelf, at what demand share + shelf cap.
 *  Groceries shares mirror the old supermarket's category mix. */
export const RETAIL_SHELF: Partial<Record<Sector, { good: GoodId; share: number; cap: number }[]>> = {
  groceries: [
    { good: 'produce', share: 0.22, cap: 220 },
    { good: 'dairy', share: 0.15, cap: 160 },
    { good: 'bakery', share: 0.20, cap: 160 },
    { good: 'meat', share: 0.14, cap: 140 },
    { good: 'grains', share: 0.17, cap: 240 },
    { good: 'drinks', share: 0.12, cap: 170 },
  ],
  homegoods: [{ good: 'furniture', share: 1, cap: 260 }],
  apparel: [{ good: 'apparel', share: 1, cap: 240 }],
  vehicles: [
    { good: 'car', share: 0.3, cap: 10 },
    { good: 'bike', share: 0.7, cap: 22 },
  ],
};
/** HUD labels for the grocery categories (SupermarketView). */
export const GOOD_LABELS: Record<GoodId, string> = {
  produce: 'Produce', dairy: 'Dairy', bakery: 'Bakery', meat: 'Meat & Fish',
  grains: 'Grains & Dry', drinks: 'Drinks', furniture: 'Furniture', apparel: 'Apparel',
  car: 'Cars', bike: 'Bicycles',
};
/** target shelf depth in HOURS of expected sales (the bounded-correction target). */
export const SHELF_TARGET_H: Partial<Record<Sector, number>> = {
  groceries: 24, homegoods: 36, apparel: 36, vehicles: 48,
};

// ---- maker templates (entrants; the two seeded makers live in BUSINESSES) -----
/** unitCost here is the RAW-MATERIAL slice only (~35% of the wholesale anchor);
 *  the rest of a maker's cost is labour — so maker profit = wholesale revenue −
 *  raw COGS − payroll − rent. Raw COGS still leaks to External. */
export const MAKER_TEMPLATES: Record<GoodId, {
  rawCost: number; capacityPerWorker: number; baseWage: number;
  maxHeadcount: number; archetype: string;
}> = {
  // capacities sized so ONE worker serves the good's typical volume at ~70%
  // utilisation — under the hiring bar, so makers don't hire-fire oscillate
  // (each cycle ratchets the wage and bleeds the margin away).
  produce: { rawCost: 0.39, capacityPerWorker: 20, baseWage: 10, maxHeadcount: 3, archetype: 'greengrocer' },
  dairy: { rawCost: 0.46, capacityPerWorker: 16, baseWage: 10, maxHeadcount: 3, archetype: 'dairy' },
  bakery: { rawCost: 0.40, capacityPerWorker: 18, baseWage: 10, maxHeadcount: 3, archetype: 'bakery' },
  meat: { rawCost: 0.62, capacityPerWorker: 14, baseWage: 10, maxHeadcount: 3, archetype: 'butcher' },
  grains: { rawCost: 0.31, capacityPerWorker: 24, baseWage: 10, maxHeadcount: 3, archetype: 'workshop' },
  drinks: { rawCost: 0.35, capacityPerWorker: 22, baseWage: 10, maxHeadcount: 3, archetype: 'workshop' },
  furniture: { rawCost: 1.15, capacityPerWorker: 10, baseWage: 11, maxHeadcount: 3, archetype: 'furniture' },
  apparel: { rawCost: 1.35, capacityPerWorker: 8, baseWage: 11, maxHeadcount: 3, archetype: 'tailor' },
  // vehicles are made OUT OF TOWN (GOOD_MAKER_CAP 0 — the import channel is
  // the factory); rows exist for map totality only.
  car: { rawCost: 150, capacityPerWorker: 0.06, baseWage: 16, maxHeadcount: 4, archetype: 'workshop' },
  bike: { rawCost: 16, capacityPerWorker: 0.5, baseWage: 12, maxHeadcount: 3, archetype: 'workshop' },
};
export const MAKER_NAMES: Record<GoodId, string[]> = {
  produce: ['Rowan Row Produce', 'Green Furrow Farmshop'],
  dairy: ['Clover Hollow Dairy', 'Bellwether Creamery'],
  bakery: ['Stone Oven Bakery', 'Millwright Breads'],
  meat: ['Harlan & Sons Butchery', 'Riverbend Smokehouse'],
  grains: ['Granary Row Milling'],
  drinks: ['Coldspring Bottling'],
  furniture: ['Oxbow Joinery', 'Tenon & True'],
  apparel: ['Nightingale Tailoring', 'Selvedge House'],
  car: ['Meridian Motorworks'],
  bike: ['Spoke & Sprocket Works'],
};
/** maker finished-goods inventory: target hours of expected demand + hourly
 *  survival (perishables spoil; durables keep) — keyed by GOOD, since a maker's
 *  SECTOR tables describe its retail downstream, not its own warehouse. */
export const MAKER_INV_TARGET_H: Record<GoodId, number> = {
  produce: 1, dairy: 1, bakery: 0.5, meat: 1, grains: 6, drinks: 6,
  furniture: 6, apparel: 6, car: 12, bike: 12,
};
export const MAKER_KEEP_H: Record<GoodId, number> = {
  produce: 0.9, dairy: 0.92, bakery: 0.9, meat: 0.9, grains: 0.999, drinks: 0.999,
  furniture: 0.998, apparel: 0.998, car: 0.999, bike: 0.999,
};
/** the maker supply floor sits at this × marginal cost (service firms use
 *  1.05×): wholesale orders are price-inelastic and import-ceilinged, so the
 *  throttle equilibrium IS the price — a fixed-cost-recovery markup keeps the
 *  seeded makers on the right side of average cost. */
export const MAKER_FLOOR_MARKUP = 1.5;
/** max makers per good (selection recycles the doomed; staples stay imported). */
export const GOOD_MAKER_CAP: Record<GoodId, number> = {
  produce: 1, dairy: 1, bakery: 2, meat: 1, grains: 1, drinks: 1,
  furniture: 2, apparel: 2,
  car: 0, bike: 0,   // no local manufacture — vehicles stay import-supplied
};
/** maker entry thresholds (margins over raw + labour marginal cost — thinner
 *  than retail's, wholesale trade runs tight; the import ceiling caps them). */
export const WS_ENTRY_MIN_MARGIN = 1.12;
export const WS_ENTRY_FAT_MARGIN = 1.35;
/** persistent LOCAL wholesale shortage that invites maker entry (import
 *  substitution): the shortage EMA divided by this is the signal strength. */
export const WS_ENTRY_SHORT_EMA = 0.25;

/** which retail SECTOR consumes each good (a maker's downstream market). */
export const GOOD_SECTOR: Record<GoodId, Sector> = {
  produce: 'groceries', dairy: 'groceries', bakery: 'groceries',
  meat: 'groceries', grains: 'groceries', drinks: 'groceries',
  furniture: 'homegoods', apparel: 'apparel',
  car: 'vehicles', bike: 'vehicles',
};

/** supply-chain entrants (makers + retailers) capitalize heavier than service
 *  startups: stock/premises take runway, so equity caps higher and the bank
 *  matches a larger multiple. */
export const ENTRY_EQUITY_CAP_CHAIN = 900;
export const ENTRY_LOAN_MULT_CHAIN = 2.0;

/** what KIND of firm sector entry founds (retail sectors get shelf retailers). */
export const KIND_FOR_SECTOR: Record<Sector, 'service' | 'retail'> = {
  food: 'service', software: 'service', utilities: 'service', retail: 'service',
  groceries: 'retail', homegoods: 'retail', apparel: 'retail',
  transit: 'service', vehicles: 'retail',
};
/** render archetype an entrant RETAILER carries (groceries → a rival market). */
export const RETAIL_ARCHETYPE: Partial<Record<Sector, string>> = {
  groceries: 'market2', homegoods: 'workshop', apparel: 'workshop',
  vehicles: 'dealership',
};

// ---- durables demand (shadow wear-and-tear accumulators) -----------------------
/** mean sim-hours between one household's homegoods / apparel purchases. */
export const FURN_PERIOD_H = 36;
export const APPAREL_PERIOD_H = 40;
/** comfort floor: a household only replaces a worn durable when its cash clears
 *  the price plus this buffer (broke households defer — emergent elasticity). */
export const DURABLE_COMFORT = 40;
/** Tier-A agents contribute a simple slow trickle (units/h each). */
export const TIERA_DURABLE_TRICKLE = 0.008;

// ---- premises (commercial real estate) -----------------------------------------
export const SHOPFRONT_COST = 6200;
export const WORKSHOP_COST = 3600;
export const SHOPFRONT_UNITS = 2;      // units a finished shopfront adds
export const WORKSHOP_UNITS = 1;
export const SHOPFRONT_RENT = 170;     // per RENT_PERIOD, per unit
export const WORKSHOP_RENT = 130;
/** entrants without premises operate "from home" at this capacity fraction. */
export const PENDING_CAPACITY = 0.4;
/** no NEW premises-needing entrant while this many already queue (a town with
 *  no shopfronts to let doesn't attract more shopkeepers — and a zombie queue
 *  of from-home firms drawing credit reads as money growth to the Fed). */
export const PENDING_ENTRY_CAP = 3;
/** the business-cycle indicator warms up: the t0 staffing ramp (GDP 0 → full)
 *  is not a boom, and one Fed meeting that reads it as one pins the Phillips
 *  expectations high enough to block construction for the whole run. During
 *  warmup the slow EMA TRACKS the fast one, so the spread starts honest. */
export const BOOM_WARMUP_H = 240;
/** builders break ground speculatively when vacant+underway units fall below this. */
export const COMMERCIAL_VACANT_MIN = 1;

/** the two seeded maker premises: pre-existing workshop buildings on BUILD_LOTS
 *  (owners split between the construction firms so both earn lease income). */
export const SEED_PREMISES: {
  lotId: string; buildingId: string; unitId: string; archetype: string;
  tenantId: string; ownerIdx: 0 | 1; rent: number; floors: number;
}[] = [
  { lotId: 'lot9', buildingId: 'bld-seed0', unitId: 'cu-seed0', archetype: 'bakery', tenantId: 'biz-bakehouse', ownerIdx: 0, rent: 130, floors: 1 },
  { lotId: 'lot13', buildingId: 'bld-seed1', unitId: 'cu-seed1', archetype: 'furniture', tenantId: 'biz-alderplane', ownerIdx: 1, rent: 130, floors: 1 },
];

// ---- two construction firms ------------------------------------------------------
export const CONSTRUCTION_FIRMS: { id: string; name: string }[] = [
  { id: 'biz-construction', name: 'Ironline Construction' },   // keeps the legacy id (old saves' loans)
  { id: 'biz-keystone', name: 'Keystone & Sons' },
];
/** the 5 Tier-A construction founders split 3/2 across the two firms. */
export const CONSTRUCTION_CREW_SPLIT = 3;

// =============================================================================
// PHASE 6 — mobility + civic execution
// (see TRANSPORT_DESIGN.md 'fleet + operators' and POLIS_DESIGN.md wiring)
// =============================================================================

// ---- vehicles: the car/bike durables ------------------------------------------
/** the dealership's share-blended vehicle sticker (0.3·car + 0.7·bike anchors) —
 *  the vehicles sector's t0 price; a buyer pays the per-kind anchor RATIO of
 *  the live sector price, so tâtonnement moves both stickers together. */
export const VEHICLE_BASE = 0.3 * GOOD_RETAIL_ANCHOR.car + 0.7 * GOOD_RETAIL_ANCHOR.bike;   // 157.5
export const CAR_PRICE_MULT = GOOD_RETAIL_ANCHOR.car / VEHICLE_BASE;
export const BIKE_PRICE_MULT = GOOD_RETAIL_ANCHOR.bike / VEHICLE_BASE;
/** mean sim-hours between one household's vehicle-need events (wear crossing 1). */
export const VEH_PERIOD_H = 700;
/** comfort floor: replace/buy only when cash clears price×2 plus this buffer —
 *  the wealth gate that makes the modal split EMERGE (few afford the car bar). */
export const VEH_COMFORT = 60;

// ---- commuting: fare demand for the transit sector ------------------------------
/** fare-demand units/day an EMPLOYED household generates (jittered per household;
 *  keys off h.employed — most shadow jobs are in the wider economy). */
export const COMMUTE_RIDES_DAY = 0.8;
/** ride-demand multipliers once a household owns a vehicle (mode substitution). */
export const OWN_CAR_RIDE_MULT = 0.15;
export const OWN_BIKE_RIDE_MULT = 0.4;
/** Tier-A: employed agents ride a small fare trickle (units/h). */
export const TIERA_FARE_TRICKLE = 0.03;

// ---- civic execution (the econ side of POLIS_DESIGN's GovTickResult) ------------
/** the treasury's account id at the banks (Financier: deficit = money creation)
 *  and the public-employer id that joins firmDemands()/applyPlan dispatch. */
export const GOV_TREASURY_ID = 'gov-treasury';
export const GOV_EMPLOYER_ID = 'gov';
/** levy rates are clamped here — no confiscatory decrees. */
export const LEVY_MAX = 0.35;
/** treasury cash above this repays bank debt; below zero it borrows. */
export const GOV_CUSHION = 1500;
/** insolvency line: below this (banks rationing) public hiring freezes and
 *  rosters shed through the labour market — unpaid clerks quit. */
export const GOV_INSOLVENT_FLOOR = -2500;
/** the publicly-chartered transit authority (founded at RUNTIME by a
 *  'transit-subsidy' spend order — never seeded; the private race is real). */
export const AUTHORITY_ID = 'biz-transit-auth';
export const AUTHORITY_NAME = 'Meridian Transit Authority';
/** a chartering spend order below this can't capitalize an authority. */
export const AUTHORITY_MIN_SEED = 1200;
/** the ADMINISTERED public fare: set by charter, bypassing tâtonnement (the
 *  setPrice gotcha) — below private marginal cost, so taxis are crowded out
 *  unless they out-serve it; authority losses are covered by subsidy. */
export const PUBLIC_FARE = 2.4;
/** a commissioned civic building's construction cost (the contract budget
 *  above it is the builder's margin). */
export const CIVIC_COST = 4800;
/** relief goes to households below this cash line (evenly; all if none). */
export const RELIEF_LINE = 60;
