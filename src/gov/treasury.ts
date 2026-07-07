// =============================================================================
// ExposomeSim — GOV TREASURY: a pure ledger. Execution happens in econ.
// -----------------------------------------------------------------------------
// The treasury is an account id inside MonetarySystem — econ credits the levy
// take into it and debits clerk wages and executed spend orders out of it.
// This class only KEEPS THE BOOKS: balance === Σ credited − Σ debited exactly,
// by construction, forever (the smoke audits it; econ's conservationError
// audits the other side). Gov never creates or destroys a cent.
//
// Budget lines accrue per-hour spending power and emit discrete spend ORDERS
// (requests, not transfers) when the accrual clears a minimum — conservation
// with an explicit per-line carry (flow.ts pattern):
//     Σ accrued === Σ ordered + Σ carry_now      (to 1e-6)
//
// Insolvency is a STATE, not an event: the balance can't cover the payroll
// horizon, a timer accrues; sustained, the institution starves (govsim turns
// that into clerks quitting and, eventually, dissolution).
// =============================================================================

import type { SpendKind } from './types';

const RESERVE_H = 12;        // hours of payroll kept as reserve before spending
const PAY_HORIZON_H = 24;    // insolvency test: can we cover this many hours?
const MIN_ORDER = 5;         // dollars an accrual must reach to emit an order
const SPEND_FRAC = 0.85;     // spend slightly under income — solvency by default
const HL_REV = 24;           // revenue-rate EMA half-life

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export class GovTreasury {
  private bal = 0;
  private cred = 0;
  private deb = 0;
  private revEmaPerH = 0;              // smoothed inflow rate — the budget's ceiling
  private carry = new Map<SpendKind, number>();
  private accruedTotal = 0;
  private orderedTotal = 0;
  private insolventH = 0;              // hours the insolvency condition has held

  // ---------------------------------------------------------------------------
  // reconciliation — the only way money enters or leaves these books.
  // ---------------------------------------------------------------------------
  report(credited: number, debited: number, dtH: number): void {
    this.cred += credited;
    this.deb += debited;
    this.bal += credited - debited;
    if (dtH > 0) {
      const lam = 1 - Math.pow(0.5, dtH / HL_REV);
      this.revEmaPerH += lam * (credited / dtH - this.revEmaPerH);
    }
  }

  // ---------------------------------------------------------------------------
  // budget lines → discrete spend orders, carry-conserved.
  // ---------------------------------------------------------------------------
  accrue(lines: readonly { kind: SpendKind; share: number }[], payrollPerH: number, dtH: number):
      { kind: SpendKind; amount: number }[] {
    const reserve = payrollPerH * RESERVE_H;
    const room = Math.max(0, this.bal - reserve);
    const budgetPerH = Math.min(SPEND_FRAC * Math.max(0, this.revEmaPerH - payrollPerH), room / PAY_HORIZON_H);
    const orders: { kind: SpendKind; amount: number }[] = [];
    if (budgetPerH <= 0) return orders;
    for (const line of lines) {
      const inc = budgetPerH * line.share * dtH;
      this.accruedTotal += inc;
      const acc = (this.carry.get(line.kind) ?? 0) + inc;
      if (acc >= MIN_ORDER) {
        orders.push({ kind: line.kind, amount: acc });
        this.orderedTotal += acc;
        this.carry.set(line.kind, 0);
      } else {
        this.carry.set(line.kind, acc);
      }
    }
    return orders;
  }

  /** step the insolvency timer: condition = obligations exist and the balance
   *  can't cover the horizon. Recovery drains the timer twice as fast. */
  stepInsolvency(payrollPerH: number, dtH: number): void {
    const broke = payrollPerH > 0 && this.bal < payrollPerH * PAY_HORIZON_H;
    this.insolventH = broke ? this.insolventH + dtH : Math.max(0, this.insolventH - 2 * dtH);
  }

  balance(): number { return this.bal; }
  totalCredited(): number { return this.cred; }
  totalDebited(): number { return this.deb; }
  revenuePerH(): number { return this.revEmaPerH; }
  insolvencyHours(): number { return this.insolventH; }
  /** conservation audit surface: Σ accrued − Σ ordered − Σ carry ≈ 0. */
  accrualDrift(): number {
    let c = 0;
    for (const v of this.carry.values()) c += v;
    return this.accruedTotal - this.orderedTotal - c;
  }

  /** dissolution wipes the books' obligations, not the money — whatever
   *  balance remains is econ's to sweep back; the ledger keeps counting. */
  resetInsolvency(): void { this.insolventH = 0; }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      bal: r6(this.bal), cred: r6(this.cred), deb: r6(this.deb),
      rev: r6(this.revEmaPerH), insolventH: r6(this.insolventH),
      accrued: r6(this.accruedTotal), ordered: r6(this.orderedTotal),
      carry: [...this.carry.entries()].map(([k, v]) => [k, r6(v)]),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { bal?: number; cred?: number; deb?: number; rev?: number; insolventH?: number; accrued?: number; ordered?: number; carry?: unknown } | null;
    if (!o) return;
    this.bal = o.bal ?? 0;
    this.cred = o.cred ?? 0;
    this.deb = o.deb ?? 0;
    this.revEmaPerH = o.rev ?? 0;
    this.insolventH = o.insolventH ?? 0;
    this.accruedTotal = o.accrued ?? 0;
    this.orderedTotal = o.ordered ?? 0;
    this.carry.clear();
    if (Array.isArray(o.carry)) {
      for (const row of o.carry) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number') this.carry.set(row[0] as SpendKind, row[1]);
      }
    }
  }
}
