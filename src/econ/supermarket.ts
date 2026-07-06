// =============================================================================
// supermarket.ts — the town's grocery hub with per-CATEGORY inventory. Stock
// depletes as agents shop (driven by their physiological hunger, see physio.ts)
// and restocks over time; how well it does is read straight off what the town
// actually buys (units sold, trips, revenue). It supplies the `groceries` goods
// market alongside the smaller Corner Market. See ECONOMY_DESIGN.md.
// =============================================================================

import type { FoodCategory, Money, SupermarketView } from './types';

interface Cat extends FoodCategory { restock: number; share: number }

const CATS: { key: string; label: string; capacity: number; restock: number; share: number }[] = [
  { key: 'produce', label: 'Produce', capacity: 420, restock: 26, share: 0.24 },
  { key: 'dairy', label: 'Dairy', capacity: 300, restock: 18, share: 0.16 },
  { key: 'bakery', label: 'Bakery', capacity: 240, restock: 16, share: 0.13 },
  { key: 'meat', label: 'Meat & Fish', capacity: 260, restock: 15, share: 0.15 },
  { key: 'grains', label: 'Grains & Dry', capacity: 460, restock: 22, share: 0.20 },
  { key: 'drinks', label: 'Drinks', capacity: 320, restock: 20, share: 0.12 },
];

export class Supermarket {
  readonly name = 'Meridian Fresh Market';
  private cats: Cat[];
  private soldThisTick = 0;
  private revThisTick = 0;
  private tripsTotal = 0;
  private soldTotal = 0;

  constructor() {
    this.cats = CATS.map((c) => ({ key: c.key, label: c.label, capacity: c.capacity, stock: c.capacity * 0.8, unitsSold: 0, restock: c.restock, share: c.share }));
  }

  /** replenish shelves toward capacity (per sim-hour). */
  restockTick(dt: number): void {
    for (const c of this.cats) c.stock = Math.min(c.capacity, c.stock + c.restock * dt);
    this.soldThisTick = 0; this.revThisTick = 0;   // reset per-tick flow (before selling)
  }

  /** total units currently available across all shelves (caps what can be sold). */
  available(): number { let s = 0; for (const c of this.cats) s += c.stock; return s; }

  /** sell up to `units` at `price`, depleting shelves by category share (bounded by
   *  stock → a run on the shelves shows as a stockout). Returns units actually sold. */
  sell(units: number, price: Money): number {
    if (units <= 0) return 0;
    let sold = 0;
    for (const c of this.cats) {
      const want = units * c.share;
      const take = Math.min(want, c.stock);
      c.stock -= take; c.unitsSold += take; sold += take;
    }
    this.soldThisTick += sold; this.soldTotal += sold;
    this.revThisTick += sold * price;
    return sold;
  }

  recordTrips(n: number): void { this.tripsTotal += n; }

  view(): SupermarketView {
    let stock = 0, cap = 0;
    for (const c of this.cats) { stock += c.stock; cap += c.capacity; }
    return {
      name: this.name,
      categories: this.cats.map((c) => ({ key: c.key, label: c.label, stock: c.stock, capacity: c.capacity, unitsSold: c.unitsSold })),
      totalStock: stock,
      totalSold: this.soldTotal,
      trips: this.tripsTotal,
      revenue: this.revThisTick,
      fillLevel: cap > 0 ? stock / cap : 0,
    };
  }

  toJSON(): unknown {
    return { cats: this.cats, tripsTotal: this.tripsTotal, soldTotal: this.soldTotal };
  }
  loadJSON(j: unknown): void {
    const o = j as { cats?: Cat[]; tripsTotal?: number; soldTotal?: number } | null;
    if (!o) return;
    if (Array.isArray(o.cats) && o.cats.length === this.cats.length) {
      for (let i = 0; i < this.cats.length; i++) { this.cats[i].stock = o.cats[i].stock ?? this.cats[i].stock; this.cats[i].unitsSold = o.cats[i].unitsSold ?? 0; }
    }
    this.tripsTotal = o.tripsTotal ?? 0;
    this.soldTotal = o.soldTotal ?? 0;
  }
}
