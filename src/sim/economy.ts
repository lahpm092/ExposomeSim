// =============================================================================
// ExposomeSim — the resource economy.
// -----------------------------------------------------------------------------
// Pure number transactions on `Resources`: the binding material constraints
// (money / food / shelter / energy) that close the Maslow loop. There is NO
// soma mutation in here — the Town reads these results and applies the somatic
// consequences (a missed meal raises ghrelin; rent-debt strain spikes cortisol;
// a paycheck nudges da_meso). Keeping the ledger pure means it's deterministic,
// trivially testable, and reproducible from a seed.
// =============================================================================

import type { Resources, SomaState } from '../types';
import { clamp } from '../util/num';

// ---- tunable constants (a compressed modern-western cost structure) ---------

/** Hourly wage at the cashier job. */
export const WAGE_PER_HOUR = 12;

/** Cost of one grocery run at the market. */
export const GROCERY_COST = 22;

/** Meals obtained per grocery run (a trip stocks the larder for a while). */
export const GROCERY_UNITS = 6;

/** How much hunger one home meal relieves (a hint for the Town's soma layer). */
export const MEAL_VALUE = 0.55;

/** Periodic rent charge. */
export const RENT = 120;

/** Sim-hours between rent charges (weekly). */
export const RENT_PERIOD = 24 * 7;

// ---- construction -----------------------------------------------------------

/**
 * Fresh ledger at the start of a run. Mara begins thinly capitalized: a little
 * cash, a couple of meals on hand, mild sleep debt, and rent already on the
 * clock one period out.
 */
export function createResources(clock: number): Resources {
  return {
    money: 60,
    foodStock: 2,
    sleepDebt: 2,
    rentDue: RENT,
    rentDueAt: clock + RENT_PERIOD,
    wageEarned: 0,
  };
}

// ---- income -----------------------------------------------------------------

/**
 * Earn wages for `dtHours` worked. Mutates `r` (money + cumulative wageEarned)
 * and returns the amount earned this tick. Negative/zero durations earn nothing.
 */
export function tickWork(r: Resources, dtHours: number): number {
  const earned = WAGE_PER_HOUR * Math.max(0, dtHours);
  r.money += earned;
  r.wageEarned += earned;
  return earned;
}

// ---- groceries --------------------------------------------------------------

/** Can Mara afford a grocery run right now? */
export function canBuyGroceries(r: Resources): boolean {
  return r.money >= GROCERY_COST;
}

/**
 * Buy groceries: spend GROCERY_COST, add GROCERY_UNITS to the larder, return
 * the cost. If she can't afford it, no-op and return 0.
 */
export function buyGroceries(r: Resources): number {
  if (!canBuyGroceries(r)) return 0;
  r.money -= GROCERY_COST;
  r.foodStock += GROCERY_UNITS;
  return GROCERY_COST;
}

// ---- eating -----------------------------------------------------------------

/** Is there food at home to eat? */
export function canEat(r: Resources): boolean {
  return r.foodStock > 0;
}

/**
 * Consume one home meal. Returns true if a meal was available (and decremented),
 * false if the larder was empty.
 */
export function consumeMeal(r: Resources): boolean {
  if (r.foodStock <= 0) return false;
  r.foodStock -= 1;
  return true;
}

// ---- rent (shelter / safety constraint) -------------------------------------

/** Is rent due as of `clock`? */
export function dueRent(r: Resources, clock: number): boolean {
  return clock >= r.rentDueAt;
}

/**
 * Pay rent if it's due: debit `rentDue` and roll the schedule forward one
 * period. Money may go negative — that is intentional (debt / shelter strain
 * the Town can translate into chronic cortisol). Returns the amount charged
 * (0 if rent wasn't due).
 */
export function payRent(r: Resources, clock: number): number {
  if (!dueRent(r, clock)) return 0;
  const paid = r.rentDue;
  r.money -= paid;
  r.rentDueAt += RENT_PERIOD;
  return paid;
}

// ---- energy readout ---------------------------------------------------------

/** Available energy as the complement of somatic fatigue, clamped to [0,1]. */
export function energyOf(soma: SomaState): number {
  return clamp(1 - soma.fatigue, 0, 1);
}
