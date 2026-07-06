// =============================================================================
// ExposomeSim — ECONOMY, Tier-A wallet (pure money helpers).
// -----------------------------------------------------------------------------
// A `Wallet` is the per-agent economic side-table (keyed by AgentId; the econ
// module never touches character.ts). Every function here is a pure, in-place
// transaction on a `Wallet` struct — NO Math.random, no Date, no I/O — so the
// whole ledger is deterministic and reproducible from a seed. Income and spend
// are DERIVED by the orchestrator from what an agent actually does (working a
// venue calls payWage; being hungry calls buy; the rent clock calls chargeRent);
// nothing here decides behaviour, it only prices it.
//
// The one invariant these helpers protect: consumption may not push cash below
// the RUIN_MONEY debt floor (canAfford / buy / chargeRent all respect it), which
// is what turns sustained hardship into missed rent → eviction → homelessness
// instead of unbounded negative balances.
// =============================================================================

import type { Wallet, Money, AgentId, BusinessId, EmploymentStatus } from './types';
import {
  RENT_PERIOD,
  BASE_RENT,
  EVICT_MISSED_PERIODS,
  RUIN_MONEY,
  SKILL_GROWTH,
  TRAIN_SKILL_GROWTH,
} from './config';
import { clamp } from '../core/util/num';

// ---- construction -----------------------------------------------------------

/**
 * Fresh Tier-A wallet. Defaults describe a thinly-capitalized, unemployed,
 * housed agent with a day or so of subsistence on hand and rent one period out;
 * `opts` overrides any of the seedable fields. When `status` is omitted it is
 * derived from employer/homeless so the enum never contradicts the flags.
 */
export function createWallet(
  id: AgentId,
  clock: number,
  opts: Partial<Pick<Wallet,
    'money' | 'rent' | 'skill' | 'employer' | 'wage' | 'status' | 'homeless' | 'foodStock' | 'waterStock'
  >> = {},
): Wallet {
  const employer = opts.employer ?? null;
  const homeless = opts.homeless ?? false;
  const status: EmploymentStatus =
    opts.status ?? (employer ? 'employed' : homeless ? 'homeless_unemployed' : 'unemployed');
  return {
    id,
    money: opts.money ?? 60,
    income: 0,
    spent: 0,
    // employment
    employer,
    status,
    wage: opts.wage ?? 0,
    hoursWorked: 0,
    tenure: 0,
    skill: clamp(opts.skill ?? 0.5, 0, 1),
    performance: 0.5,
    // housing / survival
    rent: opts.rent ?? BASE_RENT,
    rentDueAt: clock + RENT_PERIOD,
    missedRent: 0,
    homeless,
    // subsistence stocks
    foodStock: opts.foodStock ?? 2,
    waterStock: opts.waterStock ?? 4,
  };
}

// ---- income -----------------------------------------------------------------

/**
 * Credit wages for `hours` worked at the wallet's current wage. Mutates money +
 * cumulative income, and accrues hoursWorked and job tenure. Non-positive
 * durations earn nothing. Returns the amount earned this call.
 */
export function payWage(w: Wallet, hours: number): number {
  const h = Math.max(0, hours);
  const earned = w.wage * h;
  w.money += earned;
  w.income += earned;
  w.hoursWorked += h;
  w.tenure += h;
  return earned;
}

// ---- spending ---------------------------------------------------------------

/** Can this wallet spend `cost` without crossing the RUIN_MONEY debt floor?
 *  (Sitting exactly at the floor is allowed; going below it is not.) */
export function canAfford(w: Wallet, cost: Money): boolean {
  return w.money - cost >= RUIN_MONEY;
}

/**
 * Buy up to `units` at `unitPrice`, taking as many as fit under the RUIN_MONEY
 * floor. Debits money and adds to cumulative spend. Returns the number of units
 * actually bought (fractional is fine — subsistence draws are continuous).
 */
export function buy(w: Wallet, units: number, unitPrice: Money): number {
  if (units <= 0) return 0;
  if (unitPrice <= 0) return units;            // free good: take all, no debit
  const budget = w.money - RUIN_MONEY;         // cash spendable before the floor
  if (budget <= 0) return 0;
  const bought = Math.min(units, budget / unitPrice);
  if (bought <= 0) return 0;
  const cost = bought * unitPrice;
  w.money -= cost;
  w.spent += cost;
  return bought;
}

// ---- rent (shelter constraint) ----------------------------------------------

/**
 * Charge rent if it's due as of `clock`. Pays `w.rent` when affordable (missed
 * counter resets); otherwise the period is missed (missedRent++ → debt pressure
 * toward eviction) and rent stays effectively owed. Either way the schedule
 * rolls forward one period. Returns { paid, missed }: `paid` is the amount
 * actually debited (0 when not due or missed), `missed` is true if a period was
 * missed on this call.
 */
export function chargeRent(w: Wallet, clock: number): { paid: Money; missed: boolean } {
  if (clock < w.rentDueAt) return { paid: 0, missed: false };
  w.rentDueAt += RENT_PERIOD;
  if (canAfford(w, w.rent)) {
    w.money -= w.rent;
    w.spent += w.rent;
    w.missedRent = 0;
    return { paid: w.rent, missed: false };
  }
  w.missedRent += 1;
  return { paid: 0, missed: true };
}

// ---- eviction / housing transitions -----------------------------------------

/** Evict once `missedRent` hits EVICT_MISSED_PERIODS. Sets `homeless` and keeps
 *  the status enum coherent for a jobless agent. Returns true only on the tick
 *  the agent is *newly* evicted (idempotent afterwards). */
export function evict(w: Wallet): boolean {
  if (w.homeless || w.missedRent < EVICT_MISSED_PERIODS) return false;
  w.homeless = true;
  if (w.status === 'unemployed') w.status = 'homeless_unemployed';
  return true;
}

/** Move a housed-again agent back in: clear homelessness + missed rent, adopt
 *  the (new market) rent, and reset the clock one period out. */
export function rehouse(w: Wallet, clock: number, rent: Money): void {
  w.homeless = false;
  w.missedRent = 0;
  w.rent = rent;
  w.rentDueAt = clock + RENT_PERIOD;
  if (w.status === 'homeless_unemployed') w.status = 'unemployed';
}

// ---- human capital ----------------------------------------------------------

/**
 * Grow skill (human capital) over `dtHours`. Training (unemployed upskilling)
 * compounds faster than on-the-job learning; both scale by the elapsed day
 * fraction and by a conscientiousness drive in [0.3, 1.0]. While actually
 * working (training=false) on-the-job `performance` also drifts toward a
 * skill-linked target so more skilled workers tend to perform (and survive
 * layoffs) better. Skill and performance stay clamped to [0,1].
 */
export function growSkill(w: Wallet, dtHours: number, conscientious: number, training: boolean): void {
  if (dtHours <= 0) return;
  const base = training ? TRAIN_SKILL_GROWTH : SKILL_GROWTH;
  const drive = Math.max(0.3, 0.6 + 0.4 * conscientious);   // Big-Five C in [-1,1]
  const day = dtHours / 24;
  w.skill = clamp(w.skill + base * day * drive, 0, 1);
  if (!training) {
    const target = 0.5 + 0.4 * w.skill;                     // ~[0.5, 0.9]
    w.performance = clamp(w.performance + (target - w.performance) * clamp(day, 0, 1), 0, 1);
  }
}

// ---- employment transitions -------------------------------------------------

/** Hired: adopt employer + wage, mark employed, reset tenure. */
export function hire(w: Wallet, businessId: BusinessId, wage: Money): void {
  w.employer = businessId;
  w.wage = wage;
  w.status = 'employed';
  w.tenure = 0;
}

/** Let go: drop employer + wage, fall back to the jobless status that matches
 *  the housing flag, reset tenure. */
export function fire(w: Wallet): void {
  w.employer = null;
  w.wage = 0;
  w.status = w.homeless ? 'homeless_unemployed' : 'unemployed';
  w.tenure = 0;
}

/** Toggle the "training" state. Only a jobless agent can train; turning it off
 *  (or calling it on an employed agent) returns the status to the state its
 *  employment + housing flags imply. */
export function setTraining(w: Wallet, on: boolean): void {
  if (on && w.employer === null) {
    w.status = 'training';
  } else if (w.employer === null) {
    w.status = w.homeless ? 'homeless_unemployed' : 'unemployed';
  } else {
    w.status = 'employed';
  }
}
