// =============================================================================
// ExposomeSim — ECONOMY: goods price-discovery + housing markets.
// -----------------------------------------------------------------------------
// Two tiny price-movers, one per market kind. They own NO money and transact
// NOTHING: the orchestrator (econsim.ts) computes aggregate demand/supply and
// applies consumption; these classes only slide a price in response, then cache
// the figures the HUD reads. Keeping them side-effect-free (no soma, no RNG, no
// clocks) makes the whole economy deterministic and byte-identical after a
// save/load — the same discipline as sim/economy.ts's pure ledger.
// =============================================================================

import type { GoodMarket, HousingMarket, MarketView, Money, Sector } from './types';
import { PRICE_ADJ } from './config';
import { clamp } from '../core/util/num';

// ---------------------------------------------------------------------------
// GOODS MARKET — one instance per Sector. Discovers a clearing-ish price by
// tâtonnement: excess demand pushes the price up, a glut pulls it down.
// ---------------------------------------------------------------------------
export class GoodsMarket {
  private readonly _sector: Sector;
  /** t0 price — doubles as the CPI index base and the clamp anchor. */
  private readonly _base: Money;
  private _price: Money;
  // last-tick figures, cached for view() (the market never re-derives them).
  private _demand = 0;
  private _supply = 0;
  private _sold = 0;
  private _shortage = 0;

  constructor(sector: Sector, basePrice: Money) {
    this._sector = sector;
    this._base = basePrice;
    this._price = basePrice;
  }

  get sector(): Sector { return this._sector; }
  get price(): Money { return this._price; }

  /** ADMINISTERED pricing (a publicly-chartered operator): the treasury fixes
   *  the price outside tâtonnement — pair with clear(…, discover=false) so the
   *  quantities still record while price discovery stays off. */
  administer(p: Money): void { if (p > 0) this._price = p; }

  /**
   * Walrasian tâtonnement: nudge the price along the sign of excess demand,
   * scaled by how lopsided the market is. `+1e-6` keeps a dead (0/0) market
   * quiet; the price is clamped to a plausible band so a runaway shortage or
   * glut can't send it to zero or the moon. Caches + returns the cleared trade.
   *
   * `discover = false` marks a DORMANT market (no seller alive in the sector):
   * tâtonnement needs traders on both sides, so the price freezes at its last
   * level while demand + shortage keep recording — the shortage EMA still
   * screams for entry, but a shop-less durables sector can't hyperinflate a
   * price nobody is charging.
   */
  clear(demandUnits: number, supplyUnits: number, discover = true): { price: Money; sold: number; shortage: number } {
    if (discover) {
      const excess = (demandUnits - supplyUnits) / (demandUnits + supplyUnits + 1e-6);
      // ceiling 5× base: with firm exit possible, a briefly supplier-less sector
      // pins at the ceiling until an entrant arrives — 5× reads as a crisis price
      // without torching the CPI series the way 8× did.
      this._price = clamp(this._price + PRICE_ADJ * this._price * excess, 0.2 * this._base, 5 * this._base);
    }
    this._demand = demandUnits;
    this._supply = supplyUnits;
    this._sold = Math.min(demandUnits, supplyUnits);
    this._shortage = demandUnits <= 0 ? 0 : Math.max(0, demandUnits - supplyUnits) / demandUnits;
    return { price: this._price, sold: this._sold, shortage: this._shortage };
  }

  /** compact readout for the HUD; inflation is the price ratio vs t0. */
  view(): MarketView {
    return {
      sector: this._sector,
      price: this._price,
      demand: this._demand,
      supply: this._supply,
      shortage: this._shortage,
      inflation: this._price / this._base - 1,
    };
  }

  // ---- persistence (sector/base rebuilt by the ctor; state overwritten) -----
  toJSON(): unknown {
    const j: GoodMarket = {
      sector: this._sector,
      price: this._price,
      demand: this._demand,
      supply: this._supply,
      sold: this._sold,
      shortage: this._shortage,
      priceIndexBase: this._base,
    };
    return j;
  }
  loadJSON(j: unknown): void {
    const g = j as GoodMarket;
    this._price = g.price;
    this._demand = g.demand;
    this._supply = g.supply;
    this._sold = g.sold;
    this._shortage = g.shortage;
  }
}

// ---------------------------------------------------------------------------
// HOUSING MARKET — a single rental pool. Rent tracks scarcity: as vacancy
// falls the target rent climbs, and the actual rent eases toward it so tenants
// feel a squeeze build rather than a shock.
// ---------------------------------------------------------------------------
export class Housing {
  private _units: number;   // grows when construction completes housing blocks
  /** t0 rent — the index the target rent is expressed as a multiple of. */
  private readonly _baseRent: Money;
  private _rent: Money;
  private _occupied = 0;
  private _vacancyRate = 1; // fully vacant until the first step reports occupancy.

  constructor(units: number, baseRent: Money) {
    this._units = units;
    this._baseRent = baseRent;
    this._rent = baseRent;
  }

  get rent(): Money { return this._rent; }
  get units(): number { return this._units; }

  /** new housing supply (a completed construction block) — eases the market. */
  addUnits(n: number): void { if (n > 0) this._units += n; }

  /**
   * Reprice against reported occupancy. A full town (vacancy→0) targets
   * baseRent·1.6; an empty one (vacancy→1) targets baseRent; the live rent
   * relaxes 10% of the way there each tick (a slow lease-turnover lag).
   */
  step(occupied: number): void {
    this._vacancyRate = this._units > 0 ? clamp((this._units - occupied) / this._units, 0, 1) : 0;
    const target = this._baseRent * (1 + 0.6 * (1 - this._vacancyRate));
    this._rent += 0.1 * (target - this._rent);
    this._occupied = occupied;
  }

  view(): HousingMarket {
    return {
      rent: this._rent,
      units: this._units,
      occupied: this._occupied,
      vacancyRate: this._vacancyRate,
      baseRent: this._baseRent,
    };
  }

  // ---- persistence (units/baseRent rebuilt by the ctor; state overwritten) --
  toJSON(): unknown {
    const j: HousingMarket = {
      rent: this._rent,
      units: this._units,
      occupied: this._occupied,
      vacancyRate: this._vacancyRate,
      baseRent: this._baseRent,
    };
    return j;
  }
  loadJSON(j: unknown): void {
    const h = j as HousingMarket;
    this._rent = h.rent;
    this._occupied = h.occupied;
    this._vacancyRate = h.vacancyRate;
    if (typeof h.units === 'number' && h.units > 0) this._units = h.units; // may have grown via construction
  }
}
