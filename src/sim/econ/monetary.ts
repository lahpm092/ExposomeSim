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
  /** the MEASURED goods-market CPI (tâtonnement, pre price-level overlay) — the
   *  Fed now reacts to actual prices, not only the Phillips construct. */
  goodsCpi?: number;
}

/** weight of measured goods inflation in the Fed's reaction + the price level.
 *  The raw weekly reading annualizes ×52, so it is EMA-smoothed and clamped
 *  tight — otherwise one noisy week ratchets expectations for months. */
const GOODS_W = 0.15;
const GOODS_SMOOTH = 0.35;      // EMA weight on the newest annualized reading

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
  private goodsCpiAtPolicy = 1;   // measured goods CPI at the last policy tick
  private goodsInflEMA = 0;       // smoothed annualized goods inflation
  private creditSincePolicy = 0;  // net credit created since the last policy tick (QTM input)
  // phase 4 — credit risk + the deposit channel
  private writeOffsCum = 0;
  private writeOffsTick = 0;
  private depIntPending = new Map<string, Money>(); // per-bank, to route into settle
  private depIntTick = 0;         // deposit interest paid last tick (creates deposits)
  // latched last-tick flows (the accumulators reset inside step(), but view() is
  // read BETWEEN ticks — without the latch every per-tick flow would report 0).
  private lastCreated = 0;
  private lastRepaid = 0;
  private lastDepInt = 0;
  private lastWriteOffs = 0;

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

  /** default: the borrower's balance is written off against its bank's CAPITAL.
   *  Deposits (money) are untouched — the loan asset dies, the money it created
   *  lives on. Thin capital then rations + re-prices credit system-wide. */
  writeOff(id: AgentId): Money {
    const loss = this.bankFor(id).writeOff(id);
    this.writeOffsCum += loss;
    this.writeOffsTick += loss;
    return loss;
  }

  /** pay deposit interest on each bank's ACTUAL deposit liabilities: bank
   *  equity → deposits (this CREATES deposits, so it enters the broad-money
   *  identity — but NOT the QTM impulse, which tracks net credit only, or
   *  rate hikes would print money that reads as inflation that forces rate
   *  hikes). Returns the total for the caller to distribute to savers. */
  payDepositInterest(dtHours: number): Money {
    const yr = dtHours / YEAR;
    let total = 0;
    for (const b of this.banks) {
      const amt = Math.max(0, b.deposits) * b.offeredDepositRate * yr;
      if (amt <= 0) continue;
      this.depIntPending.set(b.id, (this.depIntPending.get(b.id) ?? 0) + amt);
      total += amt;
    }
    this.depIntTick += total;
    return total;
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
    //    destroys them) — plus deposit interest, which is an equity→deposit transfer
    //    that also creates deposits. Defaults do NOT destroy money (they hit capital).
    this.broad = Math.max(1, this.broad + this.creditCreated - this.creditRepaid + this.depIntTick);
    this.creditSincePolicy += this.creditCreated - this.creditRepaid;
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

    // 3) close each bank's P&L each tick (net interest income → equity → gate);
    //    the deposit interest it owes households is routed through here.
    for (const b of this.banks) {
      b.settle(dtHours, loanInterestByBank?.get(b.id) ?? 0, this.fed.iorb, this.depIntPending.get(b.id) ?? 0);
    }
    this.depIntPending.clear();

    // 4) WEEKLY policy decision: measured goods inflation blends with the Phillips
    //    path → the price level P → the Taylor rate. The Fed now SEES real prices.
    this.policyAcc += dtHours;
    if (this.policyAcc >= POLICY_WINDOW) {
      const window = this.policyAcc; this.policyAcc = 0;
      // money growth for the QTM impulse: NET CREDIT only (deposit interest is
      // interest-on-money, not new lending — counting it would make rate hikes
      // read as money-printing and close a doom loop back into more hikes).
      const mg = this.broadAtPolicy > 1 ? (this.creditSincePolicy / this.broadAtPolicy) * (YEAR / window) : 0;
      this.creditSincePolicy = 0;
      this.broadAtPolicy = broad;
      // annualized measured goods inflation since the last policy meeting,
      // EMA-smoothed so one noisy week can't ratchet the expectations loop.
      const gCpi = ctx.goodsCpi ?? this.goodsCpiAtPolicy;
      const gRaw = this.goodsCpiAtPolicy > 0.05
        ? clamp((gCpi / this.goodsCpiAtPolicy - 1) * (YEAR / window), -0.5, 0.5) : 0;
      this.goodsCpiAtPolicy = gCpi;
      this.goodsInflEMA += GOODS_SMOOTH * (gRaw - this.goodsInflEMA);
      const gInfl = clamp(this.goodsInflEMA, -0.08, 0.12);
      // expectations-augmented Phillips curve + a small quantity-theory nudge. gap
      // blends the business-cycle output gap with the Okun unemployment gap.
      const gap = clamp(outputGap - 2 * (unemployment - 0.07), -1, 1);
      const piE = EXPECT_L * this.piAnnual + (1 - EXPECT_L) * TARGET_PI;
      this.piAnnual = clamp(
        piE + PHILLIPS_K * gap + QTM_MU * clamp(mg - realGrowth, -0.25, 0.25) + GOODS_W * gInfl,
        -0.08, 0.25);
      this.priceLevel *= (1 + this.piAnnual * window / YEAR);
      this.fed.step(0.75 * this.piAnnual + 0.25 * gInfl, gap);  // the Fed reacts to a measured blend
      for (const b of this.banks) b.setRates(this.fed.primeRate, this.fed.iorb);
    }

    // 5) money growth (per-tick readout) + velocity + conservation. The identity now
    //    includes the deposit-interest channel: ΔM ≡ created − repaid + depositInterest.
    this.moneyGrowth = this.prevBroad > 1 ? (broad - this.prevBroad) / this.prevBroad : 0;
    this.conservationError = (broad - this.prevBroad) - (this.creditCreated - this.creditRepaid + this.depIntTick);
    this.velocity = broad > 1 ? gdp / broad : 0;
    this.prevBroad = broad;
    this.lastCreated = this.creditCreated; this.lastRepaid = this.creditRepaid;
    this.lastDepInt = this.depIntTick; this.lastWriteOffs = this.writeOffsTick;
    this.creditCreated = 0; this.creditRepaid = 0; this.depIntTick = 0; this.writeOffsTick = 0;
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
      creditCreated: this.lastCreated, creditRepaid: this.lastRepaid,
      conservationError: this.conservationError,
      writeOffs: this.writeOffsCum, writeOffsTick: this.lastWriteOffs,
      depositInterest: this.lastDepInt,
    };
  }

  toJSON(): unknown {
    return { fed: this.fed.toJSON(), banks: this.banks.map((b) => b.toJSON()), bankOf: [...this.bankOf.entries()],
      prevBroad: this.prevBroad, priceLevel: this.priceLevel, piAnnual: this.piAnnual, broadAtPolicy: this.broadAtPolicy, policyAcc: this.policyAcc,
      broad: this.broad, goodsCpiAtPolicy: this.goodsCpiAtPolicy, writeOffsCum: this.writeOffsCum, goodsInflEMA: this.goodsInflEMA, creditSincePolicy: this.creditSincePolicy };
  }
  loadJSON(j: unknown): void {
    const o = j as { fed?: unknown; banks?: unknown[]; bankOf?: [AgentId, number][]; prevBroad?: number; priceLevel?: number; piAnnual?: number; broadAtPolicy?: number; policyAcc?: number; broad?: number; goodsCpiAtPolicy?: number; writeOffsCum?: number; goodsInflEMA?: number; creditSincePolicy?: number } | null;
    if (!o) return;
    this.fed.loadJSON(o.fed);
    if (Array.isArray(o.banks)) o.banks.forEach((bj, i) => this.banks[i]?.loadJSON(bj));
    if (Array.isArray(o.bankOf)) { this.bankOf.clear(); for (const [k, v] of o.bankOf) this.bankOf.set(k, v); }
    if (typeof o.prevBroad === 'number') this.prevBroad = o.prevBroad;
    if (typeof o.priceLevel === 'number') this.priceLevel = o.priceLevel;
    if (typeof o.piAnnual === 'number') this.piAnnual = o.piAnnual;
    if (typeof o.broadAtPolicy === 'number') this.broadAtPolicy = o.broadAtPolicy;
    if (typeof o.policyAcc === 'number') this.policyAcc = o.policyAcc;
    if (typeof o.broad === 'number') this.broad = o.broad;
    if (typeof o.goodsCpiAtPolicy === 'number') this.goodsCpiAtPolicy = o.goodsCpiAtPolicy;
    if (typeof o.writeOffsCum === 'number') this.writeOffsCum = o.writeOffsCum;
    if (typeof o.goodsInflEMA === 'number') this.goodsInflEMA = o.goodsInflEMA;
    if (typeof o.creditSincePolicy === 'number') this.creditSincePolicy = o.creditSincePolicy;
  }
}

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
