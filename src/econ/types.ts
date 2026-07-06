// =============================================================================
// ExposomeSim — ECONOMY shared contract.
// -----------------------------------------------------------------------------
// The single source of truth for the economy subsystem. Every module under
// src/econ/ imports ONLY from here (plus core/util). This mirrors the project's
// level-of-detail philosophy (see types.ts §11):
//
//   Tier A — the 10 full-resolution agents: each owns a `Wallet`. Their income
//            and spending are DERIVED from what they actually do (working their
//            venue earns wages; being hungry/thirsty spends on food/water; rent
//            ticks on a clock). No scripting — behaviour already emerges from the
//            soma; the economy just prices it.
//   Tier B — a handful of `Business` firms that SELL a product, earn revenue from
//            price-elastic demand, pay payroll + commercial rent, and hire/fire.
//   Tier C — a probabilistic `ShadowPop` of many cheap households (a few floats
//            each, stepped O(N) on the ECON clock, never per-frame, no soma/LLM).
//            They supply labour (the unemployment pool) and demand goods (the bulk
//            of aggregate consumption) so macro effects — inflation, unemployment,
//            recessions — EMERGE and feed back onto the Tier-A agents' prices and
//            job odds.
//
// Nothing in econ/ touches THREE, the DOM, or the harness Character. Per-agent
// state is keyed by `profile.id` in a side-table, so the economy never edits
// character.ts (which the memory track owns). Keep this file dependency-free.
// =============================================================================

import type { RNG } from '../core/util/num';

// ---------------------------------------------------------------------------
// 0. primitives
// ---------------------------------------------------------------------------
/** Money in abstract dollars. Can go negative (debt). */
export type Money = number;

/** An agent id (Tier A = Character profile.id; Tier C = synthetic 'sh#'). */
export type AgentId = string;
export type BusinessId = string;

/** The goods/services sectors that clear on the goods market. Housing is priced
 *  by its own market; labour by the labour market. */
export type Sector = 'food' | 'groceries' | 'software' | 'utilities' | 'retail';

/** every sector a business can operate in maps to exactly one product good. */
export const SECTORS: Sector[] = ['food', 'groceries', 'software', 'utilities', 'retail'];

// ---------------------------------------------------------------------------
// 1. WALLET — Tier-A per-agent economic state (side-table, keyed by AgentId).
// ---------------------------------------------------------------------------
export type EmploymentStatus = 'employed' | 'unemployed' | 'training' | 'homeless_unemployed';

export interface Wallet {
  id: AgentId;
  money: Money;               // liquid cash (may be negative = debt)
  income: Money;              // cumulative wages earned (for the dashboard)
  spent: Money;               // cumulative spending (for the dashboard)
  // employment
  employer: BusinessId | null;
  status: EmploymentStatus;
  wage: Money;                // current hourly wage (0 if not employed)
  hoursWorked: number;        // cumulative hours worked
  tenure: number;             // sim-hours in the current job (0 when hired)
  skill: number;              // 0..1 human capital: raises wage + hire odds; grows via training/work
  performance: number;        // 0..1 recent on-the-job performance (drives fire order)
  // housing / survival
  rent: Money;                // periodic rent owed
  rentDueAt: number;          // absolute sim-hours of next rent charge
  missedRent: number;         // consecutive missed rent periods → eviction → homeless
  homeless: boolean;
  // subsistence stocks (mirror the somatic needs the town reads)
  foodStock: number;          // cookable meals on hand
  waterStock: number;         // drink units on hand
  // bookkeeping
  bankruptAt?: number;        // when debt first crossed the ruin line (for the panel)
}

// ---------------------------------------------------------------------------
// 2. BUSINESS — a Tier-B firm.
// ---------------------------------------------------------------------------
export interface BusinessConfig {
  id: BusinessId;
  name: string;
  sector: Sector;
  seedCash: Money;
  basePrice: Money;           // starting unit price of the product
  unitCost: Money;            // marginal cost to produce one unit (COGS)
  capacityPerWorker: number;  // units/ sim-hour one worker can produce/serve
  baseWage: Money;            // starting hourly wage offered
  commercialRent: Money;      // rent charged per RENT_PERIOD
  founderIds: AgentId[];      // Tier-A ids that anchor this firm (e.g. Mara's counter)
  maxHeadcount: number;       // ceiling on workforce
  /** anchor firms are load-bearing town infrastructure (Mara's counter, the
   *  office, water & power): they can go bankrupt but are never REMOVED. */
  anchor?: boolean;
  /** the shadow household that founded this firm (entrants only) — receives
   *  dividends when the firm is flush, so capital income is a real flow. */
  ownerId?: AgentId;
  /** demand-expectation learning rate per sim-hour (heterogeneous across firms). */
  adaptRate?: number;
}

export interface BusinessState {
  id: BusinessId;
  name: string;
  sector: Sector;
  cash: Money;
  price: Money;               // current unit price (set by the goods market feedback)
  wage: Money;                // current offered hourly wage (set by labour market)
  workers: AgentId[];         // current workforce (Tier A + Tier C ids)
  desiredHeadcount: number;   // target derived from profitability/demand
  // flow accounting over the last econ tick
  unitsSold: number;
  revenue: Money;
  payroll: Money;
  profit: Money;              // revenue - payroll - COGS - rent, last tick
  // slow state
  health: number;             // 0..1 solvency/vitality; 0 → bankrupt
  bankrupt: boolean;
  foundedAt: number;
  // cumulative for the dashboard
  cumRevenue: Money;
  cumProfit: Money;
}

/** compact per-firm readout for the HUD dashboards. */
export interface BusinessView {
  id: BusinessId;
  name: string;
  sector: Sector;
  cash: Money;
  price: Money;
  wage: Money;
  headcount: number;
  desiredHeadcount: number;
  unitsSold: number;          // last tick
  revenue: Money;             // last tick
  profit: Money;              // last tick
  health: number;
  bankrupt: boolean;
  hiring: boolean;            // desiredHeadcount > headcount and solvent
  // phase 4 — expectations + inventories (Metzler) and demography
  inventory: number;          // finished goods on hand (storable sectors)
  expDemand: number;          // adaptive demand expectation (units/sim-hour)
  produced: number;           // units produced last tick (COGS paid on these)
  ownerId?: AgentId;          // entrant firms: the founding shadow household
  foundedAt: number;
}

// ---------------------------------------------------------------------------
// 3. GOODS MARKET — price discovery by excess demand (tâtonnement).
// ---------------------------------------------------------------------------
export interface GoodMarket {
  sector: Sector;
  price: Money;               // current clearing-ish price
  demand: number;             // units demanded last tick (Tier A + Tier C, price-elastic)
  supply: number;             // units offered last tick (sum of firm capacity)
  sold: number;               // units actually transacted (min-ish of the two)
  shortage: number;           // 0..1 unmet demand fraction (drives felt scarcity)
  priceIndexBase: Money;      // t0 price, for the CPI ratio
}

export interface MarketView {
  sector: Sector;
  price: Money;
  demand: number;
  supply: number;
  shortage: number;
  inflation: number;          // price / priceIndexBase - 1
}

// ---------------------------------------------------------------------------
// 4. HOUSING MARKET — rent responds to occupancy/vacancy.
// ---------------------------------------------------------------------------
export interface HousingMarket {
  rent: Money;                // current market rent per period
  units: number;              // total dwellings
  occupied: number;           // dwellings occupied (Tier A housed + Tier C housed)
  vacancyRate: number;        // 0..1
  baseRent: Money;            // t0 rent, for the index
}

// ---------------------------------------------------------------------------
// 5. LABOUR MARKET — vacancies, matching, recruit/hire/fire.
// ---------------------------------------------------------------------------
export interface Vacancy {
  businessId: BusinessId;
  sector: Sector;
  wage: Money;                // offered wage (rises if unfilled)
  openedAt: number;
  minSkill: number;           // 0..1 hire bar
}

/** the outcome of a labour-market tick — surfaced as events for the HUD ticker. */
export interface LaborEvent {
  t: number;
  kind: 'hire' | 'fire' | 'quit' | 'layoff' | 'evict' | 'bankrupt' | 'found' | 'promote';
  agentId?: AgentId;
  agentName?: string;
  businessId?: BusinessId;
  businessName?: string;
  detail?: string;
}

export interface LaborMarketView {
  vacancies: number;
  unemployment: number;       // 0..1 rate over the whole labour force (A + C)
  laborForce: number;
  employed: number;
  meanWage: Money;
  recentEvents: LaborEvent[]; // bounded, most-recent-first
}

/** per-sector scalar maps used across market / shadowpop / econsim. */
export type SectorMap = Record<Sector, number>;

/** a job-seeker (Tier A seeking, or a Tier-C household) offered to the market. */
export interface LaborCandidate {
  id: AgentId;
  name?: string;
  skill: number;             // 0..1
  tierA: boolean;            // full-res Character (vs shadow household)
  employer: BusinessId | null;
  seeking: boolean;          // actively looking (unemployed, or underpaid+restless)
  wage?: Money;              // current wage (poaching compares offers against it)
  homeless?: boolean;        // job-finding penalty (hysteresis / the poverty trap)
}

/** a firm's hiring posture handed to the labour market each tick. */
export interface FirmDemand {
  id: BusinessId;
  name: string;
  sector: Sector;
  wage: Money;
  headcount: number;
  desired: number;           // desiredHeadcount
  solvent: boolean;          // may hire only if solvent
  minSkill: number;          // hire bar
  workers: AgentId[];
  skillOf: (id: AgentId) => number; // to pick the lowest performer to fire
}

/** the labour market's decision, applied by the EconomySim (money-mover). */
export interface LaborPlan {
  /** prevEmployer set = a poach: the worker QUITS prevEmployer for businessId. */
  hires: { agentId: AgentId; businessId: BusinessId; wage: Money; prevEmployer?: BusinessId }[];
  fires: { agentId: AgentId; businessId: BusinessId }[];
  events: LaborEvent[];
}

// ---------------------------------------------------------------------------
// 6. SHADOW POPULATION — Tier-C cheap probabilistic households.
//   A few floats each; stepped O(N) on the econ clock. NO soma, NO FSM per frame.
// ---------------------------------------------------------------------------
export interface ShadowHousehold {
  id: AgentId;                // 'sh0'..'shN'
  money: Money;
  employer: BusinessId | null;
  wage: Money;
  skill: number;              // 0..1
  employed: boolean;
  homeless: boolean;
  consumeFood: number;        // baseline food demand per period (price-elastic at use)
  consumeGroceries: number;
  propensityToConsume: number;// 0..1 fraction of income spent vs saved
  missedRent: number;
  // phase 4 — the household balance sheet (Minsky channel)
  loan?: Money;               // consumer-credit balance at the household's bank
  lockUntil?: number;         // credit lockout after a default (abs sim-hours)
}

/** the consumer-credit primitives the shadow sweep uses (bound to the
 *  MonetarySystem by the orchestrator so money stays causal + conserved). */
export interface ConsumerCredit {
  borrow(id: AgentId, amt: Money): Money;   // returns amount actually lent (rationed)
  repay(id: AgentId, amt: Money): Money;    // returns amount actually repaid
  writeOff(id: AgentId): Money;             // default: bank eats the balance
}

export interface ShadowPopView {
  n: number;
  employed: number;
  unemployed: number;
  homeless: number;
  meanMoney: Money;
  medianMoney: Money;
  gini: number;               // 0..1 wealth inequality (emergent)
  aggregateDemand: number;    // total consumption units this tick
  consumerDebt: Money;        // Σ household loan balances
  defaults: number;           // cumulative consumer-credit defaults
}

// ---------------------------------------------------------------------------
// 7. MACRO AGGREGATES — the emergent top line.
// ---------------------------------------------------------------------------
export interface MacroAggregates {
  clock: number;
  cpi: number;                // consumer price index (1.0 = t0 basket)
  inflation: number;          // period-over-period CPI change
  unemployment: number;       // 0..1 over A + C labour force
  gdp: number;                // total value produced last tick (proxy)
  meanWage: Money;
  homelessCount: number;      // A + C
  bankruptcies: number;       // cumulative
  gini: number;               // wealth inequality across A + C
  boom: number;               // -1..1 business-cycle indicator (smoothed output gap)
  // phase 4 — firm demography (Schumpeter)
  firmsAlive: number;
  firmBirths: number;         // cumulative entries
  firmDeaths: number;         // cumulative true exits (removed, loans written off)
}

// ---------------------------------------------------------------------------
// 8. PER-AGENT ECON READOUT — projected onto AgentPublic for badges/inspector.
// ---------------------------------------------------------------------------
export interface AgentEconView {
  id: AgentId;
  money: Money;
  wage: Money;
  status: EmploymentStatus;
  employerName?: string;
  homeless: boolean;
  foodStock: number;
  waterStock: number;
  rentDueIn: number;          // sim-hours until next rent (negative = overdue)
  skill: number;
}

// ---------------------------------------------------------------------------
// 8b. BANKING — firms (esp. construction) raise capital as loans, repaid with
//   interest. A minimal credit layer so building can be DEBT-financed.
// ---------------------------------------------------------------------------
export interface Loan {
  id: string;
  borrowerId: BusinessId;
  principal: Money;
  balance: Money;            // remaining owed
  ratePerPeriod: number;     // interest accrued per econ tick (small)
  issuedAt: number;
}
export interface BankView {
  capital: Money;            // lendable capital remaining
  loansOutstanding: number;  // count of open loans
  balanceOutstanding: Money; // total principal still owed
  totalLent: Money;          // cumulative disbursed
  interestIncome: Money;     // cumulative interest earned
}

// ---------------------------------------------------------------------------
// 8c. CONSTRUCTION — a firm that borrows, runs build PROJECTS (progress advances
//   with its workforce), and completes low-poly BUILDINGS that enter the economy:
//   housing adds dwellings (→ rent falls), commercial adds sector capacity. The
//   render reads `buildings` to place/grow meshes; economics read the rest.
// ---------------------------------------------------------------------------
export type BuildKind = 'housing' | 'commercial';

/** an authored empty plot the construction firm can build on (world coords). */
export interface BuildLot {
  id: string;
  x: number; z: number;      // world-unit centre
  w: number; d: number;      // footprint (world units)
}

export interface Building {
  id: string;
  kind: BuildKind;
  lotId: string;
  x: number; z: number; w: number; d: number;
  floors: number;            // low-poly storey count (drives render height)
  progress: number;          // 0..1 while under construction
  complete: boolean;
  cost: Money;               // build cost (loan-financed)
  dwellings: number;         // housing: units of supply added on completion
  sector?: Sector;           // commercial: which sector it serves
  capacity: number;          // commercial: units/hr of supply once open
  cumIncome: Money;          // rent/lease income to date
  startedAt: number;
}

export interface ConstructionView {
  name: string;
  cash: Money;
  workers: number;
  loanBalance: Money;
  activeProjects: number;
  completedBuildings: number;
  lotsFree: number;
  buildings: Building[];     // all buildings (active + complete) — for the render
}

// ---------------------------------------------------------------------------
// 8d. SUPERMARKET — a larger grocery business with per-CATEGORY inventory that
//   depletes as agents buy (from their physiological needs) and restocks over
//   time. Its health is read straight off what the town actually consumes.
// ---------------------------------------------------------------------------
export interface FoodCategory {
  key: string;               // 'produce' | 'dairy' | 'bakery' | 'meat' | 'grains' | 'drinks'
  label: string;
  stock: number;             // units currently on the shelf
  capacity: number;          // max shelf stock
  unitsSold: number;         // cumulative
}
export interface SupermarketView {
  name: string;
  categories: FoodCategory[];
  totalStock: number;
  totalSold: number;         // cumulative units
  trips: number;             // shopping trips served (purchase events)
  revenue: Money;            // last-tick revenue
  fillLevel: number;         // 0..1 mean shelf fill (1 = fully stocked)
}

// ---------------------------------------------------------------------------
// 8e. THE MONETARY SYSTEM — a causal, stock-flow-consistent banking sector.
//   Base money (M0 = reserves + currency) is created ONLY by the Fed; broad money
//   (deposits) is created ONLY when a bank makes a loan and destroyed on repayment.
//   Everything else is a conserved transfer. See MONETARY_DESIGN.md.
// ---------------------------------------------------------------------------
export interface FedView {
  policyRate: number;        // federal-funds target (annual fraction, e.g. 0.045)
  iorb: number;              // interest on reserve balances (annual)
  discountRate: number;      // discount-window rate (annual)
  targetInflation: number;   // dual-mandate inflation target (0.02)
  baseMoney: Money;          // M0 = total reserves + currency in circulation
  reserves: Money;           // bank reserves held at the Fed (a Fed liability)
  securities: Money;         // Fed assets from OMO/QE (Treasuries/MBS)
  discountLoans: Money;      // reserves lent to banks at the window (Fed asset)
  lastOMO: Money;            // net open-market operation last tick (+ = injecting reserves)
}

export interface CommercialBankView {
  id: string; name: string;
  reserves: Money;           // asset — reserves at the Fed
  loans: Money;              // asset — loans outstanding to firms/households
  securities: Money;         // asset — securities held
  deposits: Money;           // liability — customer deposits
  capital: Money;            // equity = assets − deposits
  capitalRatio: number;      // capital / risk assets (Basel-style constraint on lending)
  reserveRatio: number;      // reserves / deposits
  lendingRate: number;       // annual rate charged on new loans (policy + spread)
  depositRate: number;       // annual rate paid on deposits
  solvent: boolean;          // capital > 0
  loanCount: number;         // open loans on the book
}

export interface MonetaryView {
  fed: FedView;
  banks: CommercialBankView[];
  baseMoney: Money;          // M0
  broadMoney: Money;         // M2-ish = Σ deposits (+ currency)
  moneyGrowth: number;       // period-over-period broad-money growth rate
  velocity: number;          // nominal GDP / broad money
  avgLendingRate: number;
  creditCreated: Money;      // new loans this tick (money created)
  creditRepaid: Money;       // repayments this tick (money destroyed)
  conservationError: Money;  // Σ assets − Σ liabilities across all sheets; ~0 if sound
  // phase 4 — credit risk + the deposit channel
  writeOffs: Money;          // cumulative loan balances written off against bank capital
  writeOffsTick: Money;      // written off last tick
  depositInterest: Money;    // deposit interest paid to households last tick (creates deposits)
}

// ---------------------------------------------------------------------------
// 8f. HISTORY — the whole run, t0 → now, one sample per econ tick, decimated.
//   The Economy Observatory reads this. `data` rows parallel `fields`; the
//   arrays are LIVE references (never mutate); redraw when `version` changes.
// ---------------------------------------------------------------------------
export type EconEventKind =
  | 'found' | 'bankrupt' | 'default' | 'policy' | 'evict' | 'boom' | 'bust';

export interface EconEvent {
  t: number;                  // abs sim-hours
  kind: EconEventKind;
  label: string;              // short human line for the event lane
  mag?: number;               // optional magnitude (e.g. Δrate, $ written off)
}

export interface EconHistoryView {
  version: number;            // bump = new sample or decimation; gate redraws on it
  n: number;                  // samples currently held
  stride: number;             // sim-hours per sample AFTER decimation (grows 1→2→4…)
  fields: readonly string[];  // row names, index-aligned with `data`
  data: readonly number[][];  // data[fieldIdx][sampleIdx]; live reference, read-only
  events: readonly EconEvent[]; // notable events, oldest-first, bounded
}

// ---------------------------------------------------------------------------
// 9. THE SNAPSHOT the HUD + TownSnapshot read each frame (pure data).
// ---------------------------------------------------------------------------
export interface EconSnapshot {
  macro: MacroAggregates;
  businesses: BusinessView[];
  markets: MarketView[];
  housing: HousingMarket;
  labor: LaborMarketView;
  shadow: ShadowPopView;
  agents: AgentEconView[];    // Tier-A only, keyed order matches society roster
  bank?: BankView;
  construction?: ConstructionView;
  supermarket?: SupermarketView;
  monetary?: MonetaryView;
  history?: EconHistoryView;  // the full-run time series for the Observatory
}

// ---------------------------------------------------------------------------
// 10. INPUT the town/society hands the EconomySim each econ tick.
//   The town reports WHERE each Tier-A agent is and WHAT it needs; the econ
//   module owns all money math. This keeps the ledger centralized + testable.
// ---------------------------------------------------------------------------
export interface AgentEconInput {
  id: AgentId;
  name: string;
  atWork: boolean;            // physically at their workplace this window
  workHours: number;         // sim-hours actually worked since last econ tick
  hunger: number;            // 0..1 need deficit (drives food spend)
  thirst: number;            // 0..1 need deficit (drives water spend)
  seekingWork: boolean;      // unemployed/underpaid and looking (emergent nudge)
  conscientious: number;     // Big-Five C in [-1,1] → performance/skill growth
}

export interface EconStepCtx {
  clock: number;             // absolute sim-hours
  dtHours: number;           // elapsed sim-hours since last call
  weekday: boolean;
  rng: RNG;
  agents: AgentEconInput[];  // Tier-A inputs (index-aligned with the roster)
}

// ---------------------------------------------------------------------------
// 11. MODULE EXPORT CONTRACTS (what each econ/ file must provide).
//   Implementers: match these signatures exactly so econsim.ts can wire you.
//
//   wallet.ts       createWallet(id, clock, cfg?) : Wallet
//                   walletTick(...) pure helpers for pay/spend/rent/eviction
//   business.ts     class Business { step(...): void; view(): BusinessView; ... }
//   market.ts       class GoodsMarket { clear(demand, supply): void; view() }
//                   class Housing     { step(occupied, units): void; view() }
//   labor.ts        class LaborMarket { match(...): LaborEvent[]; view() }
//   shadowpop.ts    class ShadowPop { step(ctx, macro): void; view(); labour(); demand() }
//   config.ts       BUSINESSES: BusinessConfig[]; constants (RENT_PERIOD, ruin line…)
//   econsim.ts      class EconomySim { step(ctx): void; snapshot(): EconSnapshot;
//                                      walletOf(id); toJSON()/loadJSON() }
// ---------------------------------------------------------------------------
