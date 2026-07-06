// =============================================================================
// goods.ts — the WHOLESALE layer: one market per GoodId, upstream of the retail
// shelf. Reuses the GoodsMarket tâtonnement mechanics (excess demand slides the
// price) with two supply-chain twists:
//
//   • an external IMPORTER supplies any residual demand with perfectly elastic
//     supply at IMPORT_MARKUP × the base wholesale price — a world-price anchor.
//     The clearing price is therefore CEILINGED at the import price (no retailer
//     pays a local maker more than the world charges). Money paid for imports
//     LEAKS to External exactly like raw-material COGS: the retailer's cash
//     falls and no domestic account receives it (the broad-money identity in
//     monetary.ts is untouched — it tracks bank credit, not private cash).
//     Grains + drinks have no seeded maker, so they are import-supplied until a
//     maker enters; every other good imports only the gap its makers leave.
//
//   • `shortage` measures the LOCAL supply gap (demand unmet by makers) even
//     when imports keep shelves full — it is the maker-entry signal (import
//     substitution), not a starvation signal.
//
// Like market.ts, this class owns NO money and transacts NOTHING: the
// orchestrator computes retailer orders + maker offers, and applies the cash.
// PURE + deterministic; state round-trips toJSON/loadJSON.
// =============================================================================

import type { GoodId, Money, WholesaleView } from './types';
import { PRICE_ADJ, GOOD_WHOLESALE_BASE, IMPORT_MARKUP } from './config';
import { clamp } from '../core/util/num';

export class WholesaleMarket {
  readonly good: GoodId;
  /** base wholesale price ≈ 55% of the good's retail anchor (see config). */
  readonly base: Money;
  /** the importer's world price — a hard ceiling on the local clearing price. */
  readonly importPrice: Money;
  private _price: Money;
  // last-tick figures, cached for view().
  private _demand = 0;
  private _supply = 0;       // local maker offer
  private _soldLocal = 0;
  private _imports = 0;
  private _shortage = 0;     // unmet-by-LOCAL fraction (the maker-entry signal)

  constructor(good: GoodId) {
    this.good = good;
    this.base = GOOD_WHOLESALE_BASE[good];
    this.importPrice = this.base * IMPORT_MARKUP;
    this._price = this.base;
  }

  get price(): Money { return this._price; }
  get shortage(): number { return this._shortage; }

  /**
   * Clear one tick: retailer orders vs local maker offer. Tâtonnement moves the
   * local price along excess demand, ceilinged at the import price (the world
   * market undercuts any dearer local ask) and floored well under base (the
   * makers' marginal-cost supply floor is what really holds it up). Residual
   * demand is imported at the world price. Returns what the orchestrator needs
   * to move the money: local units sold + at what price, imports + their price.
   */
  clear(demandUnits: number, localOffer: number): {
    price: Money; soldLocal: number; imports: number; importPrice: Money;
  } {
    const d = Math.max(0, demandUnits);
    const s = Math.max(0, localOffer);
    if (d > 1e-9 || s > 1e-9) {
      const excess = (d - s) / (d + s + 1e-6);
      // floor 0.78×base: no maker sells much below its raw + labour cost (the
      // supply throttle holds there anyway); ceiling = the importer's world
      // price. Keeps the retailer-cash ↔ maker-glut spiral from crashing the
      // price into a hole neither side can climb out of.
      this._price = clamp(this._price + PRICE_ADJ * this._price * excess, 0.78 * this.base, this.importPrice);
    }
    this._demand = d;
    this._supply = s;
    this._soldLocal = Math.min(d, s);
    this._imports = Math.max(0, d - s);
    this._shortage = d > 1e-9 ? clamp((d - s) / d, 0, 1) : 0;
    return { price: this._price, soldLocal: this._soldLocal, imports: this._imports, importPrice: this.importPrice };
  }

  view(): WholesaleView {
    return {
      good: this.good, price: this._price,
      demand: this._demand, supply: this._supply,
      shortage: this._shortage, imports: this._imports, importPrice: this.importPrice,
    };
  }

  // ---- persistence (good/base rebuilt by the ctor; state overwritten) --------
  toJSON(): unknown {
    return { price: this._price, demand: this._demand, supply: this._supply, soldLocal: this._soldLocal, imports: this._imports, shortage: this._shortage };
  }
  loadJSON(j: unknown): void {
    const o = j as { price?: number; demand?: number; supply?: number; soldLocal?: number; imports?: number; shortage?: number } | null;
    if (!o) return;
    if (typeof o.price === 'number') this._price = clamp(o.price, 0.78 * this.base, this.importPrice);
    this._demand = o.demand ?? 0;
    this._supply = o.supply ?? 0;
    this._soldLocal = o.soldLocal ?? 0;
    this._imports = o.imports ?? 0;
    this._shortage = o.shortage ?? 0;
  }
}
