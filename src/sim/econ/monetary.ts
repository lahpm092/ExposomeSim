// =============================================================================
// monetary.ts — the MonetarySystem: the Fed + commercial banks tied into one
// causal, stock-flow-consistent money layer for the sim. It owns the ONLY two
// ways money enters/leaves existence — the Fed's base-money operations and bank
// loan creation/repayment — and prices credit off a Taylor-rule policy rate.
//
// Design (see MONETARY_DESIGN.md): broad money = Σ bank deposits = the money the
// public actually holds (Σ of every wallet/firm/household balance). Loans are
// tracked per borrower and are causal (create deposits, destroy on repay). The
// Fed sets base money + the policy rate; banks earn a net-interest margin that
// drives their equity, which in turn CAPITAL-GATES further lending. A per-tick
// conservation check surfaces any leak (ΔM vs credit created − repaid).
// =============================================================================

import type { AgentId, MonetaryView, Money } from './types';
import { Fed } from './fed';
import { CommercialBank } from './banking';
import { clamp } from '../../util/num';

// ---- seed + policy parameters (scaled to the sim's $100s–1000s money world) --
const RESERVE_TARGET = 0.12;   // Fed keeps reserves ≈ this share of deposits (ample)
const YEAR = 24 * 365;         // sim-hours per year (rates are annual)
const POLICY_WINDOW = 168;     // sim-hours between policy decisions (weekly, matches rent)
const TARGET_PI = 0.02;        // 2% inflation goal
const PHILLIPS_K = 0.16;       // slope: output gap → inflation
const EXPECT_L = 0.7;          // adaptive-expectations weight on last inflation
const QTM_MU = 0.10;           // long-run quantity-theory nudge (excess money → inflation)

export interface MonetaryCtx {
  dtHours: number;
  clock: number;
  outputGap: number;           // -1..1 (+ = hot economy), from the business cycle
  unemployment: number;        // 0..1 (for the Okun/Phillips gap)
  privateMoney: Money;         // Σ of all wallet/firm/household balances = broad money
  gdp: Money;                  // nominal output rate (for velocity)
  realGrowth: number;          // annualized real-output growth (for the QTM term)
}

export class MonetarySystem {
  readonly fed: Fed;
  private readonly banks: CommercialBank[];
  private readonly bankOf = new Map<AgentId, number>();
  private broad = 0;             // broad money (deposits) — changes ONLY via credit
  private prevBroad = 0;
  private moneyGrowth = 0;
  private creditCreated = 0;
  private creditRepaid = 0;
  private conservationError = 0;
  private velocity = 0;
  // the monetary price-LEVEL overlay (Phillips-driven); reported CPI = goods CPI × P
  private priceLevel = 1;
  private piAnnual = TARGET_PI;   // current annualized inflation (the Taylor input)
  private policyAcc = 0;          // sim-hours since the last policy decision
  private broadAtPolicy = 0;      // broad money at the last policy tick (for money growth)

  constructor(opts: { seed?: number; privateMoney?: Money } = {}) {
    const broad0 = opts.privateMoney ?? 60000;   // ≈ starting Σ of all balances
    const base0 = broad0 * RESERVE_TARGET;        // reserves; base money at t0
    this.fed = new Fed({ startRate: 0.045, baseMoney: base0 });
    // two commercial banks split the deposits + reserves; well-capitalized (~12% CET1).
    const mk = (id: string, name: string, share: number) => new CommercialBank(id, name, {
      deposits: broad0 * share, reserves: base0 * share, capital: broad0 * share * 0.12,
    });
    this.banks = [mk('bank-meridian', 'Meridian Trust', 0.6), mk('bank-harbor', 'Harbor Mutual', 0.4)];
    this.broad = broad0;
    this.prevBroad = broad0;
    this.broadAtPolicy = broad0;
  }

  // ---- account assignment (each agent/firm banks at one bank) ---------------
  private bankIndexFor(id: AgentId): number {
    let i = this.bankOf.get(id);
    if (i === undefined) { i = hash(id) % this.banks.length; this.bankOf.set(id, i); }
    return i;
  }
  private bankFor(id: AgentId): CommercialBank { return this.banks[this.bankIndexFor(id)]; }

  // ---- credit primitives (called by the EconomySim) ------------------------
  /** the annual rate `id` would pay on a new loan (bank pricing off the policy rate). */
  loanRate(id: AgentId): number { return this.bankFor(id).offeredLoanRate; }
  /** remaining system-wide lending capacity (capital-gated). */
  creditCapacity(): number { let c = 0; for (const b of this.banks) c += b.lendingCapacity(); return c; }
  loanBalance(id: AgentId): number { return this.bankFor(id).loanBalance(id); }

  /** borrow: the bank creates a deposit (money) → the caller credits the borrower's
   *  cash by the returned amount. Capital-gated, so it may lend less than asked. */
  borrow(id: AgentId, amount: Money): Money {
    const bank = this.bankFor(id);
    const lent = bank.lend(id, amount, bank.offeredLoanRate);
    this.creditCreated += lent;
    return lent;
  }
  /** repay: destroys the deposit (money) → the caller debits the borrower's cash. */
  repay(id: AgentId, amount: Money): Money {
    const paid = this.bankFor(id).repay(id, amount);
    this.creditRepaid += paid;
    return paid;
  }

  /** loan interest owed this tick per borrower (transfer borrower→bank equity). The
   *  caller debits each borrower's actual balance and passes the total back via the
   *  bank settle in step(). Returns [{id, amt}]. */
  interestDue(dtHours: number): { id: AgentId; amt: Money }[] {
    const out: { id: AgentId; amt: Money }[] = [];
    for (const b of this.banks) for (const d of b.interestDue(dtHours)) out.push(d);
    return out;
  }

  // ---- the monetary tick ---------------------------------------------------
  step(ctx: MonetaryCtx, loanInterestByBank?: Map<string, Money>): void {
    const { dtHours, outputGap, unemployment, gdp, realGrowth } = ctx;

    // 1) BROAD MONEY changes ONLY via bank credit (loans create deposits, repayment
    //    destroys them) — the causal, conserved definition. It is NOT the sum of the
    //    goods economy's circulating cash (which drifts via unmodelled external trade).
    this.broad = Math.max(1, this.broad + this.creditCreated - this.creditRepaid);
    const broad = this.broad;
    let depTotal = 0; for (const b of this.banks) depTotal += b.deposits;
    for (const b of this.banks) { const share = depTotal > 1 ? b.deposits / depTotal : 1 / this.banks.length; b.deposits = broad * share; }

    // 2) keep reserves ample (≈ RESERVE_TARGET of deposits) via OMO — the base-money
    //    lever; the securities plug keeps every bank's A = L + E every tick.
    const reserveTarget = broad * RESERVE_TARGET;
    let reserveTotal = 0; for (const b of this.banks) reserveTotal += b.reserves;
    this.fed.openMarketOp(reserveTarget - reserveTotal);
    for (const b of this.banks) { const share = broad > 1 ? b.deposits / broad : 1 / this.banks.length; b.reserves = reserveTarget * share; b.securities = Math.max(0, b.deposits + b.capital - b.reserves - b.loans); }
    this.fed.setReserves(reserveTarget);

    // 3) close each bank's P&L each tick (net interest income → equity → gate).
    for (const b of this.banks) b.settle(dtHours, loanInterestByBank?.get(b.id) ?? 0, this.fed.iorb);

    // 4) WEEKLY policy decision: Phillips inflation → the price level P → Taylor rate.
    this.policyAcc += dtHours;
    if (this.policyAcc >= POLICY_WINDOW) {
      const window = this.policyAcc; this.policyAcc = 0;
      const mg = this.broadAtPolicy > 1 ? (broad - this.broadAtPolicy) / this.broadAtPolicy * (YEAR / window) : 0;
      this.broadAtPolicy = broad;
      // expectations-augmented Phillips curve + a small quantity-theory nudge. gap
      // blends the business-cycle output gap with the Okun unemployment gap.
      const gap = clamp(outputGap - 2 * (unemployment - 0.07), -1, 1);
      const piE = EXPECT_L * this.piAnnual + (1 - EXPECT_L) * TARGET_PI;
      this.piAnnual = clamp(piE + PHILLIPS_K * gap + QTM_MU * clamp(mg - realGrowth, -0.4, 0.4), -0.1, 0.4);
      this.priceLevel *= (1 + this.piAnnual * window / YEAR);
      this.fed.step(this.piAnnual, gap);                 // Taylor rule reacts
      for (const b of this.banks) b.setRates(this.fed.primeRate, this.fed.iorb);
    }

    // 5) money growth (per-tick readout) + velocity + conservation.
    this.moneyGrowth = this.prevBroad > 1 ? (broad - this.prevBroad) / this.prevBroad : 0;
    this.conservationError = (broad - this.prevBroad) - (this.creditCreated - this.creditRepaid);
    this.velocity = broad > 1 ? gdp / broad : 0;
    this.prevBroad = broad;
    this.creditCreated = 0; this.creditRepaid = 0;
  }

  /** the monetary price-level overlay: reported CPI = goods-market CPI × this. */
  get priceLevelFactor(): number { return this.priceLevel; }
  get inflationAnnual(): number { return this.piAnnual; }
  get policyRate(): number { return this.fed.policyRate; }
  get anyInsolvent(): boolean { return this.banks.some((b) => !b.solvent); }
  /** which bank an account settles at (for routing loan-interest income). */
  bankIdFor(id: AgentId): string { return this.banks[this.bankIndexFor(id)].id; }

  // ---- readout -------------------------------------------------------------
  view(): MonetaryView {
    const banks = this.banks.map((b) => b.view());
    let broad = 0, loans = 0; for (const b of this.banks) { broad += b.deposits; loans += b.loans; }
    const avgLend = banks.length ? banks.reduce((s, b) => s + b.lendingRate, 0) / banks.length : 0;
    return {
      fed: this.fed.view(), banks,
      baseMoney: this.fed.baseMoney, broadMoney: broad,
      moneyGrowth: this.moneyGrowth, velocity: this.velocity, avgLendingRate: avgLend,
      creditCreated: this.creditCreated, creditRepaid: this.creditRepaid,
      conservationError: this.conservationError,
    };
  }

  toJSON(): unknown {
    return { fed: this.fed.toJSON(), banks: this.banks.map((b) => b.toJSON()), bankOf: [...this.bankOf.entries()],
      prevBroad: this.prevBroad, priceLevel: this.priceLevel, piAnnual: this.piAnnual, broadAtPolicy: this.broadAtPolicy, policyAcc: this.policyAcc };
  }
  loadJSON(j: unknown): void {
    const o = j as { fed?: unknown; banks?: unknown[]; bankOf?: [AgentId, number][]; prevBroad?: number; priceLevel?: number; piAnnual?: number; broadAtPolicy?: number; policyAcc?: number } | null;
    if (!o) return;
    this.fed.loadJSON(o.fed);
    if (Array.isArray(o.banks)) o.banks.forEach((bj, i) => this.banks[i]?.loadJSON(bj));
    if (Array.isArray(o.bankOf)) { this.bankOf.clear(); for (const [k, v] of o.bankOf) this.bankOf.set(k, v); }
    if (typeof o.prevBroad === 'number') this.prevBroad = o.prevBroad;
    if (typeof o.priceLevel === 'number') this.priceLevel = o.priceLevel;
    if (typeof o.piAnnual === 'number') this.piAnnual = o.piAnnual;
    if (typeof o.broadAtPolicy === 'number') this.broadAtPolicy = o.broadAtPolicy;
    if (typeof o.policyAcc === 'number') this.policyAcc = o.policyAcc;
  }
}

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
