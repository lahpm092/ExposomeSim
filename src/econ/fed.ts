// =============================================================================
// fed.ts — the central bank (a stylized Federal Reserve). It issues BASE MONEY
// (reserves + currency), sets the policy rate by a smoothed TAYLOR RULE against
// the sim's inflation + output gap, pays interest on reserves (IORB), and injects
// reserves via open-market operations. It does NOT create broad money — that is
// the commercial banks' job (loans create deposits, see banking.ts). Modelled on
// the modern US "ample-reserves floor" system. See MONETARY_DESIGN.md and the
// research report folded into it (BoE 2014; Taylor 1993; Basel III).
// =============================================================================

import type { FedView, Money } from './types';
import { clamp } from '../core/util/num';

// ---- policy constants (annual rates; the sim converts to per-tick where needed)
const TARGET_INFLATION = 0.02;   // π*  — the 2% dual-mandate goal
const R_STAR = 0.01;             // r*  — neutral real rate (modern estimate ~0.5–1%)
const TAYLOR_PI = 1.5;           // inflation coefficient (>1 = the Taylor principle → stability)
const TAYLOR_Y = 0.5;            // output-gap coefficient
const SMOOTH = 0.85;             // interest-rate smoothing ρ (avoids oscillation)
const IORB_SPREAD = 0.001;       // IORB set ~10bp below the funds-rate top
const DISCOUNT_SPREAD = 0.005;   // discount/SRF ceiling ~50bp above the target
const PRIME_SPREAD = 0.03;       // prime = policy rate + 300bp (the loan base rate)

export class Fed {
  private policy: number;        // federal-funds target (annual)
  private prevPolicy: number;
  private securities: Money;     // Fed assets from OMO/QE (Treasuries/MBS)
  private reserves: Money;       // bank reserves held at the Fed (a Fed liability)
  private currency: Money;       // currency in circulation (a Fed liability)
  private discountLoans: Money;  // reserves lent to banks at the window (Fed asset)
  private lastOMO = 0;

  constructor(opts: { startRate?: number; baseMoney?: Money } = {}) {
    this.policy = opts.startRate ?? 0.045;   // start near a ~4.5% funds rate
    this.prevPolicy = this.policy;
    const base = opts.baseMoney ?? 0;
    this.reserves = base * 0.8;
    this.currency = base * 0.2;
    this.securities = base;      // Fed assets = its money liabilities at t0 (E_fed≈0)
    this.discountLoans = 0;
  }

  // ---- rates ---------------------------------------------------------------
  get policyRate(): number { return this.policy; }
  /** interest on reserve balances — the floor of the corridor; pays banks. */
  get iorb(): number { return Math.max(0, this.policy - IORB_SPREAD); }
  get discountRate(): number { return this.policy + DISCOUNT_SPREAD; }
  /** the prime lending base rate banks price loans off (policy + 300bp). */
  get primeRate(): number { return this.policy + PRIME_SPREAD; }
  get baseMoney(): Money { return this.reserves + this.currency; }
  get reserveBalances(): Money { return this.reserves; }

  /**
   * Set the policy rate from the dual mandate via a smoothed Taylor rule:
   *   i* = r* + π + φ_π(π − π*) + φ_y·gap ;  i = ρ·i_prev + (1−ρ)·i*  ;  clamp ≥ 0.
   * inflation + outputGap are annualized fractions (gap in [-1,1], + = hot economy).
   */
  step(inflation: number, outputGap: number): void {
    const target = R_STAR + inflation + TAYLOR_PI * (inflation - TARGET_INFLATION) + TAYLOR_Y * outputGap;
    this.prevPolicy = this.policy;
    this.policy = clamp(SMOOTH * this.policy + (1 - SMOOTH) * target, 0, 0.25);
  }

  // ---- base-money operations (the only source of M0) -----------------------
  /** open-market operation: buy `amt` of securities from the banking system,
   *  paying with newly-created reserves (base money ↑). Negative = QT (drain). */
  openMarketOp(amt: Money): void {
    this.securities += amt;
    this.reserves = Math.max(0, this.reserves + amt);
    this.lastOMO = amt;
  }
  /** a bank draws reserves at the discount window (base money ↑, repaid later). */
  lendReserves(amt: Money): Money { if (amt <= 0) return 0; this.discountLoans += amt; this.reserves += amt; return amt; }
  repayReserves(amt: Money): void { const p = Math.min(amt, this.discountLoans); this.discountLoans -= p; this.reserves = Math.max(0, this.reserves - p); }
  /** cash withdrawal shifts base-money composition reserves→currency (M2 unchanged). */
  shiftToCurrency(amt: Money): void { const m = clamp(amt, 0, this.reserves); this.reserves -= m; this.currency += m; }
  /** track the reserve level the banking system reports it holds (settlement). */
  setReserves(total: Money): void { this.reserves = Math.max(0, total); }

  view(): FedView {
    return {
      policyRate: this.policy, iorb: this.iorb, discountRate: this.discountRate,
      targetInflation: TARGET_INFLATION, baseMoney: this.baseMoney, reserves: this.reserves,
      securities: this.securities, discountLoans: this.discountLoans, lastOMO: this.lastOMO,
    };
  }
  toJSON(): unknown {
    return { policy: this.policy, prev: this.prevPolicy, securities: this.securities, reserves: this.reserves, currency: this.currency, dw: this.discountLoans, omo: this.lastOMO };
  }
  loadJSON(j: unknown): void {
    const o = j as { policy?: number; prev?: number; securities?: number; reserves?: number; currency?: number; dw?: number; omo?: number } | null;
    if (!o) return;
    if (typeof o.policy === 'number') this.policy = o.policy;
    if (typeof o.prev === 'number') this.prevPolicy = o.prev;
    if (typeof o.securities === 'number') this.securities = o.securities;
    if (typeof o.reserves === 'number') this.reserves = o.reserves;
    if (typeof o.currency === 'number') this.currency = o.currency;
    if (typeof o.dw === 'number') this.discountLoans = o.dw;
    if (typeof o.omo === 'number') this.lastOMO = o.omo;
  }
}
