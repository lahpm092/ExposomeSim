// =============================================================================
// ExposomeSim — ECONOMY / Tier-C shadow population.
// -----------------------------------------------------------------------------
// The macro substrate: many CHEAP probabilistic households (a few floats each)
// that supply the labour pool and demand the bulk of aggregate consumption, so
// that micro shocks (one firm's layoffs) ripple into macro effects (a higher
// unemployment rate, a dip in aggregate demand, wider inequality, homelessness)
// WITHOUT spending soma/LLM cycles.
//
// Cost discipline (mirrors ECONOMY_DESIGN.md Tier C):
//   • stepped on the COARSE econ clock, never the render frame,
//   • one O(N) sweep of plain floats — no nested loops over households,
//   • allocation-light step(): the demand accumulator and per-household structs
//     are reused in place; the only heavier work (a sort for median/gini) lives
//     in view(), which the HUD calls at most once per econ tick.
//
// Determinism: every stochastic choice draws from an INTERNAL mulberry32 stream
// seeded in the constructor and serialized in toJSON — never Math.random, and
// (deliberately) never ctx.rng, so the shadow substrate is byte-identical after
// a save/load independently of the orchestrator's shared stream.
// =============================================================================

import type {
  AgentId, BusinessId, ConsumerCredit, LaborCandidate, MacroAggregates,
  Money, SectorMap, ShadowHousehold, ShadowPopView,
} from './types';
import {
  BASE_WAGE, DEMAND_ELASTICITY, EVICT_MISSED_PERIODS, FOOD_UNIT_PRICE,
  GROCERY_UNIT_PRICE, MEALS_PER_DAY, MIN_WAGE, RENT_PERIOD, RUIN_MONEY,
  SKILL_GROWTH, SHADOW_SEED_MONEY, TRAIN_SKILL_GROWTH, WATER_UNIT_PRICE,
  CC_TRIGGER, CC_CHUNK, CC_COMFORT, CC_REPAY_K, CC_LIMIT_WEEKS,
  CC_DEFAULT_MONEY, CC_LOCK_HOURS, FEAR_U0, FEAR_K, FEAR_CUT,
  FURN_PERIOD_H, APPAREL_PERIOD_H, DURABLE_COMFORT,
} from './config';
import { clamp, mulberry32, type RNG } from '../core/util/num';

// ---- tuning (local; the authored anchors live in config.ts) -----------------

/** lognormal spread of starting cash (σ of the underlying gaussian). */
const SIGMA_MONEY = 0.7;
/** lognormal-ish skill: right-skewed around a modest median human-capital. */
const SKILL_MEAN = 0.35;
const SIGMA_SKILL = 0.55;

/** utilities demand tracks household size — proxied off the food baseline. */
const UTIL_RATIO = 0.9;
/** retail (discretionary) units/day for a household spending its whole propensity. */
const RETAIL_SCALE = 2.0;
/** reference price for the retail basket (café-ish); food/groceries/utilities use
 *  their subsistence unit prices from config as the elasticity anchor. Aligned with
 *  the café's basePrice so the retail market clears near base. */
const RETAIL_REF = 3.6;

/** per-sector reference prices for the constant-elasticity demand curve. Software
 *  is B2B — households never buy it, so its ref is inert. Homegoods/apparel are
 *  DURABLES: demand comes off the wear accumulators (discrete purchases, budget-
 *  gated), so their refs are inert too — kept for map totality. */
const REF: SectorMap = {
  food: FOOD_UNIT_PRICE,
  groceries: GROCERY_UNIT_PRICE,
  software: 240,
  utilities: WATER_UNIT_PRICE,
  retail: RETAIL_REF,
  homegoods: 6.0,
  apparel: 7.0,
};

/** clamp the elastic multiplier so a near-zero price can't blow demand up nor a
 *  spike zero it out entirely. */
const ELAST_MIN = 0.2;
const ELAST_MAX = 2.5;

/** business-cycle → consumer-confidence gain on discretionary (retail) spend. */
const CONFIDENCE_K = 0.25;

// ---- the "wider economy" (jobs outside our 5 modelled firms) -----------------
// Without this, the only employers are the handful of firms we simulate (~50 slots
// for 240 households) → structural mass unemployment. Real towns have countless
// small employers we don't model; households churn in/out of that wider labour
// market at baseline hazards, pinning the unemployment rate near a natural level
// (steady-state u = SEP/(SEP+HIRE) ≈ 7%) and making it PROCYCLICAL (hire faster in
// a boom). Firm-employed households (employer set) are exempt — the orchestrator's
// labour market manages them.
const HIRE_HAZARD = 0.020;   // per sim-hour re-employment hazard into the wider economy
const SEP_HAZARD = 0.0016;   // per sim-hour separation from wider-economy work
const START_EMPLOYED = 0.90; // fraction employed at t0

/** deep-debt line past which a household cuts to subsistence only. */
const BROKE_LINE = RUIN_MONEY;
/** hard debt floor: money is never allowed below this. */
const MONEY_FLOOR = RUIN_MONEY * 2;
/** discretionary throttle when broke (buys a fraction of the retail basket). */
const BROKE_BUDGET = 0.35;

/** a homeless household must have recovered this many rents in cash before it
 *  even rolls the dice on re-housing… */
const REHOUSE_BUFFER = 2;
/** …and then re-houses with this per-tick probability. */
const REHOUSE_CHANCE = 0.04;

// ---- small local numerics (only clamp/mulberry32/RNG may be imported) --------

/** standard-normal via Box–Muller off the internal stream (randn isn't importable). */
function gauss(rng: RNG): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** constant-elasticity demand multiplier: q ∝ (ref/price)^ε, clamped. */
function elast(price: number, ref: number): number {
  const p = price > 1e-6 ? price : 1e-6;
  return clamp(Math.pow(ref / p, DEMAND_ELASTICITY), ELAST_MIN, ELAST_MAX);
}

// =============================================================================
// ShadowPop
// =============================================================================
export class ShadowPop {
  private hh: ShadowHousehold[] = [];
  /** absolute sim-hours of each household's next rent charge (staggered). Kept as
   *  a parallel array so ShadowHousehold stays the minimal on-type struct. */
  private rentDueAt: number[] = [];
  /** households locked out of the wider labour market (can only be hired by our
   *  modelled firms, which rarely take the least-skilled) → the source of chronic
   *  long-term unemployment and, in turn, emergent homeless spells. */
  private chronic: boolean[] = [];
  private rng: RNG;
  private seed: number;
  /** consumer-credit defaults — cumulative and last-tick (for events/history). */
  private defaultsCum = 0;
  private lastDefaults = 0;

  /** demand accumulator, reused across steps (zeroed in place — no allocation). */
  private _demand: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0, homegoods: 0, apparel: 0 };
  private _aggDemand = 0;

  /**
   * Seed `n` households with a lognormal-ish spread of cash and skill. ~50% start
   * employed but attached to NOTHING yet (employer === null) — they draw a wage
   * so the initial economy isn't all-broke, and the orchestrator's labour market
   * assigns real employers (and fires) over time.
   */
  constructor(n: number, seed: number, clock: number) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    const r = this.rng;
    const count = Math.max(0, n | 0);
    this.hh = new Array(count);
    this.rentDueAt = new Array(count);
    this.chronic = new Array(count);

    for (let i = 0; i < count; i++) {
      // lognormal cash: exp(σg − σ²/2) has unit mean, so cash ≈ SHADOW_SEED_MONEY.
      const moneyBase = SHADOW_SEED_MONEY *
        Math.exp(SIGMA_MONEY * gauss(r) - 0.5 * SIGMA_MONEY * SIGMA_MONEY);
      const skill = clamp(
        SKILL_MEAN * Math.exp(SIGMA_SKILL * gauss(r) - 0.5 * SIGMA_SKILL * SIGMA_SKILL),
        0, 1,
      );
      // a precarious tail (~16%): little savings and out of work — with skill-gated
      // re-employment (below), the least-skilled of these can slide into a homeless
      // spell, so homelessness EMERGES for the vulnerable rather than never/always.
      const precarious = r() < 0.16;
      const money = precarious ? SHADOW_SEED_MONEY * (0.04 + 0.12 * r()) : moneyBase;
      const employed = precarious ? false : r() < START_EMPLOYED;
      // a third of the precarious tail (~5% of all) are chronically locked out.
      this.chronic[i] = precarious && r() < 0.34;
      // skilled workers command more; nobody is offered below the floor.
      const wage = employed ? Math.max(MIN_WAGE, BASE_WAGE * (0.6 + skill * 0.8)) : 0;
      const propensityToConsume = clamp(0.55 + 0.18 * gauss(r), 0.2, 0.98);
      const consumeFood = clamp(MEALS_PER_DAY * (0.7 + 0.6 * r()), 1, 6);      // meals/day
      const consumeGroceries = clamp(2 * (0.6 + 0.8 * r()), 0.5, 4);          // grocery-equiv/day

      this.hh[i] = {
        id: 'sh' + i,
        money,
        employer: null,
        wage,
        skill,
        employed,
        homeless: false,
        consumeFood,
        consumeGroceries,
        propensityToConsume,
        missedRent: 0,
        loan: 0,
        lockUntil: 0,
        // durables: wear starts uniformly spread (purchases stagger from t0);
        // per-household wear RATES are jittered lognormal-ish around the mean.
        furnWear: r(),
        apparelWear: r(),
        furnRate: (1 / FURN_PERIOD_H) * (0.6 + 0.8 * r()),
        apparelRate: (1 / APPAREL_PERIOD_H) * (0.6 + 0.8 * r()),
      };

      // stagger the weekly rent charge across the period via a cheap id hash so
      // charges don't clump on one tick (deterministic, no RNG spend).
      const phase = ((Math.imul(i + 1, 2654435761) >>> 0) % RENT_PERIOD);
      this.rentDueAt[i] = clock + phase + 1;
    }
  }

  // ---------------------------------------------------------------------------
  // step — one econ tick over the whole population. Strictly O(N), alloc-free.
  // ---------------------------------------------------------------------------
  step(
    ctx: { dtHours: number; clock: number; rng: RNG },
    macro: MacroAggregates,
    prices: SectorMap,
    rent: Money,
    credit: ConsumerCredit | null = null,
  ): void {
    const dt = ctx.dtHours;
    const dtDay = dt / 24;                 // per-day baselines → this tick
    const clock = ctx.clock;
    const rng = this.rng;                  // internal, serialized stream (see header)
    this.lastDefaults = 0;

    // Booms loosen wallets, busts tighten them — confidence rides the cycle and
    // only touches discretionary (retail) spend.
    const confidence = clamp(1 + CONFIDENCE_K * macro.boom, 0.6, 1.4);

    // PRECAUTIONARY SAVING: as unemployment climbs past its natural rate, every
    // household trims discretionary spend — the jobless hardest. This is the
    // classic demand amplifier (fear of the slump deepens the slump).
    const fear = clamp(FEAR_K * (macro.unemployment - FEAR_U0), 0, 1);
    const precautionEmp = 1 - FEAR_CUT * fear * 0.6;
    const precautionJobless = 1 - FEAR_CUT * fear;

    // Re-employment wages INDEX partially to the price level, so inflation can
    // pass through into nominal wages (the wage-price spiral becomes possible —
    // the half-weight pivot + tight clamp keep it a spiral, not a rocket).
    const wageIndex = clamp(0.5 + 0.5 * macro.cpi, 0.85, 1.5);

    // Price elasticity is identical for every household, so resolve the per-sector
    // demand multipliers ONCE; the per-household sweep is then pure multiply-add.
    const foodMult = elast(prices.food, REF.food) * dtDay;
    const groMult = elast(prices.groceries, REF.groceries) * dtDay;
    const utilMult = elast(prices.utilities, REF.utilities) * dtDay;
    const retMult = elast(prices.retail, REF.retail) * dtDay * confidence;

    // zero the demand accumulator in place (households never buy software).
    const D = this._demand;
    D.food = 0; D.groceries = 0; D.software = 0; D.utilities = 0; D.retail = 0;
    D.homegoods = 0; D.apparel = 0;
    const pFurn = prices.homegoods;
    const pApp = prices.apparel;

    const hh = this.hh;
    const dueAt = this.rentDueAt;
    const n = hh.length;

    for (let i = 0; i < n; i++) {
      const h = hh[i];

      // ---- income / human capital -----------------------------------------
      if (h.employed) {
        h.money += h.wage * dt;                                  // wages accrue on the clock
        h.skill = clamp(h.skill + SKILL_GROWTH * dtDay * 0.5, 0, 1); // learn-by-doing (slow)
      } else {
        // no income (savings erode through consumption below); reskill a touch
        // faster than on-the-job, per config's TRAIN_SKILL_GROWTH.
        h.skill = clamp(h.skill + TRAIN_SKILL_GROWTH * dtDay * 0.5, 0, 1);
      }

      // ---- wider-economy labour churn (jobs outside our 5 firms) -----------
      // Only households NOT holding one of our modelled firm jobs (employer===null)
      // churn here; a procyclical hire hazard keeps unemployment near its natural
      // rate instead of collapsing onto the few slots we simulate. Homelessness
      // halves the hire hazard — the poverty trap is real (hysteresis).
      if (h.employer === null) {
        if (h.employed) {
          if (rng() < SEP_HAZARD * dt) { h.employed = false; h.wage = 0; }
        } else if (!this.chronic[i]
          && rng() < HIRE_HAZARD * (0.35 + h.skill) * (1 + 0.6 * macro.boom) * (h.homeless ? 0.45 : 1) * dt) {
          // re-employment is skill-gated: the least-skilled wait longest for work.
          h.employed = true;
          h.wage = Math.max(MIN_WAGE, BASE_WAGE * (0.6 + h.skill * 0.8) * wageIndex);
        }
      }

      // ---- consumption (price-elastic, budget-gated) ----------------------
      // Deep in debt ⇒ subsistence only: discretionary throttles hard so debt
      // can't run away and the poor visibly cut back (demand sags in a slump).
      const budget = h.money <= BROKE_LINE ? BROKE_BUDGET : 1;
      const utilBase = h.consumeFood * UTIL_RATIO;              // size proxy
      const retBase = h.propensityToConsume * RETAIL_SCALE * budget
        * (h.employed ? precautionEmp : precautionJobless);

      const qFood = h.consumeFood * foodMult;
      const qGro = h.consumeGroceries * groMult;
      const qUtil = utilBase * utilMult;
      const qRet = retBase * retMult;

      D.food += qFood; D.groceries += qGro; D.utilities += qUtil; D.retail += qRet;

      // debit the basket at current market prices.
      h.money -= qFood * prices.food + qGro * prices.groceries
        + qUtil * prices.utilities + qRet * prices.retail;

      // ---- durables wear (phase 5): wear grows with time; crossing 1 with
      // money above a comfort floor ⇒ ONE discrete purchase (a demand unit) at
      // the retail price, then a jittered reset. Broke households defer at the
      // saturated wear level and buy the moment they can — emergent elasticity.
      // the comfort floor scales 2× with the price: dear durables get deferred
      // by the less-comfortable — the demand elasticity that stops a stockout
      // blip from ratcheting the retail price without limit.
      const fw = (h.furnWear ?? 0) + (h.furnRate ?? 1 / FURN_PERIOD_H) * dt;
      if (fw >= 1) {
        if (h.money > DURABLE_COMFORT + 2 * pFurn) {
          D.homegoods += 1;
          h.money -= pFurn;
          h.furnWear = 0.1 * rng();
        } else h.furnWear = 1;
      } else h.furnWear = fw;
      const aw = (h.apparelWear ?? 0) + (h.apparelRate ?? 1 / APPAREL_PERIOD_H) * dt;
      if (aw >= 1) {
        if (h.money > DURABLE_COMFORT + 2 * pApp) {
          D.apparel += 1;
          h.money -= pApp;
          h.apparelWear = 0.1 * rng();
        } else h.apparelWear = 1;
      } else h.apparelWear = aw;

      // ---- rent / eviction -------------------------------------------------
      if (!h.homeless) {
        if (clock >= dueAt[i]) {
          if (h.money >= rent) {
            h.money -= rent;
            h.missedRent = 0;
          } else {
            h.missedRent++;
            if (h.missedRent >= EVICT_MISSED_PERIODS) h.homeless = true; // evicted
          }
          dueAt[i] += RENT_PERIOD;                              // schedule rolls on regardless
        }
      } else if (h.money > rent * REHOUSE_BUFFER && rng() < REHOUSE_CHANCE) {
        // homeless pay no rent; a small chance to re-house once savings recover.
        h.homeless = false;
        h.missedRent = 0;
        dueAt[i] = clock + RENT_PERIOD;
      }

      // ---- the household balance sheet (consumer credit / Minsky) ----------
      // Banks lend to the EMPLOYED short on cash (each draw creates deposits),
      // up to a debt-service cap tied to wage income. Comfortable households
      // deleverage (destroying money). The broke-and-jobless DEFAULT: the bank
      // eats the balance (capital ↓ → system-wide credit rations) and the
      // household is locked out of credit for a spell.
      if (credit) {
        const loan = h.loan ?? 0;
        const lockUntil = h.lockUntil ?? 0;
        if (h.employed && h.money < CC_TRIGGER && clock >= lockUntil) {
          const cap = h.wage * 168 * CC_LIMIT_WEEKS;
          if (loan < cap) {
            const lent = credit.borrow(h.id, Math.min(CC_CHUNK, cap - loan));
            h.money += lent;
            h.loan = loan + lent;
          }
        } else if (loan > 0 && h.money > CC_COMFORT) {
          const want = Math.min(loan, (h.money - CC_COMFORT) * Math.min(1, CC_REPAY_K * dt));
          const paid = credit.repay(h.id, want);
          h.money -= paid;
          h.loan = loan - paid;
        } else if (loan > 40 && !h.employed && h.money < CC_DEFAULT_MONEY) {
          credit.writeOff(h.id);
          h.loan = 0;
          h.lockUntil = clock + CC_LOCK_HOURS;
          this.defaultsCum++;
          this.lastDefaults++;
        }
      }

      // keep money within sane bounds (debt bottoms out at the hard floor).
      if (h.money < MONEY_FLOOR) h.money = MONEY_FLOOR;
    }

    this._aggDemand = D.food + D.groceries + D.utilities + D.retail + D.homegoods + D.apparel;
  }

  // ---------------------------------------------------------------------------
  // readouts
  // ---------------------------------------------------------------------------

  /** aggregate consumption UNITS per sector from the last step() (fresh copy). */
  demand(): SectorMap {
    const d = this._demand;
    return {
      food: d.food, groceries: d.groceries, software: d.software,
      utilities: d.utilities, retail: d.retail,
      homegoods: d.homegoods, apparel: d.apparel,
    };
  }

  /** every household as a job-seeker; the orchestrator filters the unemployed. */
  candidates(): LaborCandidate[] {
    const out: LaborCandidate[] = new Array(this.hh.length);
    for (let i = 0; i < this.hh.length; i++) {
      const h = this.hh[i];
      out[i] = {
        id: h.id,
        skill: h.skill,
        tierA: false,
        employer: h.employer,
        seeking: !h.employed,          // unemployed households are looking
        wage: h.wage,
        homeless: h.homeless,
      };
    }
    return out;
  }

  /** debit `amt` from a household (loan interest); pays down to the hard floor.
   *  Returns what was actually collected. */
  debitCash(id: AgentId, amt: Money): Money {
    const h = this.byId(id);
    if (!h || amt <= 0) return 0;
    const paid = Math.min(amt, Math.max(0, h.money - MONEY_FLOOR));
    h.money -= paid;
    return paid;
  }

  /** credit `amt` to a household (dividends, deposit interest). */
  addMoney(id: AgentId, amt: Money): void {
    const h = this.byId(id);
    if (h && amt > 0) h.money += amt;
  }

  /** Σ positive balances (the deposit base banks pay interest on). */
  positiveMoneySum(): Money {
    let s = 0;
    for (let i = 0; i < this.hh.length; i++) { const m = this.hh[i].money; if (m > 0) s += m; }
    return s;
  }

  /** distribute deposit interest pro-rata over positive balances: every saver's
   *  money grows by `factor` (= totalInterest / depositBase). */
  scaleSavings(factor: number): void {
    if (factor <= 0) return;
    for (let i = 0; i < this.hh.length; i++) { const h = this.hh[i]; if (h.money > 0) h.money += h.money * factor; }
  }

  /** the richest credit-worthy household (an entrepreneur candidate) — or null. */
  richest(minWealth: Money, exclude: ReadonlySet<AgentId>): ShadowHousehold | null {
    let best: ShadowHousehold | null = null;
    for (let i = 0; i < this.hh.length; i++) {
      const h = this.hh[i];
      if (h.money < minWealth || exclude.has(h.id) || h.homeless) continue;
      if (!best || h.money > best.money) best = h;
    }
    return best;
  }

  /** append every household's wealth into `out` (for the combined A+C gini). */
  wealthInto(out: number[]): void {
    for (let i = 0; i < this.hh.length; i++) out.push(this.hh[i].money);
  }

  get defaults(): number { return this.defaultsCum; }
  get defaultsThisTick(): number { return this.lastDefaults; }

  /** the labour market hired this household — attach the employer + wage. */
  applyHire(id: AgentId, businessId: BusinessId, wage: Money): void {
    const h = this.byId(id);
    if (!h) return;
    h.employer = businessId;
    h.wage = wage;
    h.employed = true;
  }

  /** the labour market let this household go — back into the pool. */
  applyFire(id: AgentId): void {
    const h = this.byId(id);
    if (!h) return;
    h.employer = null;
    h.wage = 0;
    h.employed = false;
  }

  count(): number { return this.hh.length; }

  /** the whole population is employable (no one is modelled out-of-market). */
  laborForce(): number { return this.hh.length; }

  employedCount(): number {
    let c = 0;
    for (let i = 0; i < this.hh.length; i++) if (this.hh[i].employed) c++;
    return c;
  }

  homelessCount(): number {
    let c = 0;
    for (let i = 0; i < this.hh.length; i++) if (this.hh[i].homeless) c++;
    return c;
  }

  /** compact readout with emergent inequality (gini) + aggregate demand. */
  view(): ShadowPopView {
    const n = this.hh.length;
    let employed = 0, homeless = 0, sum = 0, debt = 0;
    const monies = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const h = this.hh[i];
      if (h.employed) employed++;
      if (h.homeless) homeless++;
      sum += h.money;
      debt += h.loan ?? 0;
      monies[i] = h.money;
    }
    monies.sort((a, b) => a - b);

    const meanMoney = n > 0 ? sum / n : 0;
    let medianMoney = 0;
    if (n > 0) {
      const mid = n >> 1;
      medianMoney = (n & 1) ? monies[mid] : (monies[mid - 1] + monies[mid]) / 2;
    }

    return {
      n,
      employed,
      unemployed: n - employed,
      homeless,
      meanMoney,
      medianMoney,
      gini: this.giniOf(monies),
      aggregateDemand: this._aggDemand,
      consumerDebt: debt,
      defaults: this.defaultsCum,
    };
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 2,
      seed: this.seed,
      rng: this.rng.save ? this.rng.save() : this.seed,
      hh: this.hh,
      rentDueAt: this.rentDueAt,
      chronic: this.chronic,
      demand: this._demand,
      agg: this._aggDemand,
      defaults: this.defaultsCum,
    };
  }

  loadJSON(j: unknown): void {
    const o = j as {
      seed?: number; rng?: number; hh?: ShadowHousehold[]; rentDueAt?: number[];
      chronic?: boolean[]; demand?: SectorMap; agg?: number; defaults?: number;
    } | null;
    if (!o) return;
    if (typeof o.seed === 'number') this.seed = o.seed >>> 0;
    if (Array.isArray(o.hh)) {
      this.hh = o.hh;
      // v1 saves predate the balance-sheet fields — normalize them in. Pre-
      // phase-5 saves lack the durable-wear fields: derive them DETERMINISTICALLY
      // from the household index (a cheap hash, no rng spend) so an old save
      // stays byte-stable and durables demand simply fades in.
      for (let i = 0; i < this.hh.length; i++) {
        const h = this.hh[i];
        h.loan = h.loan ?? 0; h.lockUntil = h.lockUntil ?? 0;
        if (typeof h.furnWear !== 'number') {
          const f1 = ((Math.imul(i + 1, 2654435761) >>> 0) % 1000) / 1000;
          const f2 = ((Math.imul(i + 7, 40503) >>> 0) % 1000) / 1000;
          h.furnWear = f1;
          h.apparelWear = f2;
          h.furnRate = (1 / FURN_PERIOD_H) * (0.6 + 0.8 * f2);
          h.apparelRate = (1 / APPAREL_PERIOD_H) * (0.6 + 0.8 * f1);
        }
      }
    }
    if (typeof o.defaults === 'number') this.defaultsCum = o.defaults;
    if (Array.isArray(o.rentDueAt)) this.rentDueAt = o.rentDueAt;
    if (Array.isArray(o.chronic)) this.chronic = o.chronic;
    else if (Array.isArray(o.hh)) this.chronic = new Array(o.hh.length).fill(false);
    if (o.demand) {
      const d = o.demand;
      this._demand = {
        food: d.food ?? 0, groceries: d.groceries ?? 0, software: d.software ?? 0,
        utilities: d.utilities ?? 0, retail: d.retail ?? 0,
        homegoods: d.homegoods ?? 0, apparel: d.apparel ?? 0,
      };
    }
    if (typeof o.agg === 'number') this._aggDemand = o.agg;
    if (this.rng.load && typeof o.rng === 'number') this.rng.load(o.rng);
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** O(1) lookup off the 'sh<i>' id convention, validated against the slot. */
  private byId(id: AgentId): ShadowHousehold | undefined {
    if (id.length < 3 || id[0] !== 's' || id[1] !== 'h') return undefined;
    const idx = +id.slice(2);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.hh.length) return undefined;
    const h = this.hh[idx];
    return h && h.id === id ? h : undefined;
  }

  /** standard Gini on a pre-sorted array, shifted non-negative; guards n<2. */
  private giniOf(sorted: number[]): number {
    const n = sorted.length;
    if (n < 2) return 0;
    const shift = sorted[0] < 0 ? -sorted[0] : 0;   // wealth can be debt-negative
    let total = 0, idxSum = 0;
    for (let i = 0; i < n; i++) {
      const x = sorted[i] + shift;
      total += x;
      idxSum += (i + 1) * x;
    }
    if (total <= 0) return 0;
    // G = (2·Σ i·x_i)/(n·Σ x_i) − (n+1)/n   for x sorted ascending.
    return clamp((2 * idxSum) / (n * total) - (n + 1) / n, 0, 1);
  }
}
