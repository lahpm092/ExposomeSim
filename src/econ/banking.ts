// =============================================================================
// banking.ts — commercial banks: the layer that creates BROAD money. A bank makes
// a loan by writing a loan asset AND a matching deposit liability at the same time
// (BoE 2014 "loans create deposits") — no pre-existing deposit is "lent out", and
// reserves do NOT gate this (US reserve requirement = 0 since 2020). What gates it
// is CAPITAL (Basel-style CET1). Repayment destroys the deposit. Interest is a
// TRANSFER from the borrower's deposit into the bank's equity, never creation.
// See MONETARY_DESIGN.md.
// =============================================================================

import type { AgentId, CommercialBankView, Money } from './types';
import { clamp } from '../core/util/num';

const CET1_MIN = 0.07;       // 4.5% minimum + 2.5% conservation buffer
const CET1_TARGET = 0.12;    // banks lend freely down to here, then ration toward the floor
// Residual charge-off noise only: REAL credit losses now arrive as writeOff()
// calls when a borrower actually defaults (the financial accelerator), so the
// blanket rate no longer double-counts them.
const LOSS_RATE_ANNUAL = 0.002;
const RISK_SPREAD_MAX = 0.06; // extra loan spread a capital-thin bank charges

export interface LoanRec { balance: Money; rate: number }

export class CommercialBank {
  readonly id: string;
  readonly name: string;
  // balance sheet
  reserves: Money;    // asset — at the Fed
  securities: Money;  // asset
  loans: Money;       // asset — Σ loan book
  deposits: Money;    // liability — customer deposits (broad money this bank issues)
  capital: Money;     // equity = assets − deposits
  private book = new Map<AgentId, LoanRec>();
  private lendingRate = 0.075;
  private depositRate = 0.02;
  // flow accounting (per tick, for the P&L + HUD)
  private niiThisTick = 0;

  constructor(id: string, name: string, seed: { deposits: Money; capital: Money; reserves: Money; securities?: Money }) {
    this.id = id; this.name = name;
    this.deposits = seed.deposits;
    this.capital = seed.capital;
    this.reserves = seed.reserves;
    // assets must equal liabilities+equity at t0: reserves + securities + loans = deposits + capital
    this.securities = seed.securities ?? Math.max(0, this.deposits + this.capital - this.reserves);
    this.loans = 0;
  }

  // ---- capital-gated lending capacity (the real modern constraint) ---------
  /** how much NEW lending keeps CET1 above the rationing band (capital, not reserves). */
  lendingCapacity(): number {
    // loans allowed at the target ratio, minus what's already on the book.
    return Math.max(0, this.capital / CET1_TARGET - this.loans);
  }
  capitalRatio(): number { return this.loans > 1 ? this.capital / this.loans : 1; }
  get solvent(): boolean { return this.capital > 0; }

  // ---- money creation: a loan writes a loan asset + a deposit liability -----
  /** lend up to `amt` to `borrowerId` (capital-gated). Creates deposits = broad
   *  money. Returns the amount actually lent (0 if fully rationed). */
  lend(borrowerId: AgentId, amt: Money, rate: number): Money {
    if (amt <= 0) return 0;
    const room = this.lendingCapacity();
    const lent = Math.min(amt, room);
    if (lent <= 0.01) return 0;
    this.loans += lent;
    this.deposits += lent;                          // <-- broad money created here
    const rec = this.book.get(borrowerId);
    if (rec) { rec.balance += lent; rec.rate = rate; } else this.book.set(borrowerId, { balance: lent, rate });
    return lent;
  }

  /** repay principal: destroys the deposit against the loan (broad money falls). */
  repay(borrowerId: AgentId, amt: Money): Money {
    const rec = this.book.get(borrowerId);
    if (!rec || amt <= 0) return 0;
    const paid = Math.min(amt, rec.balance);
    rec.balance -= paid;
    this.loans = Math.max(0, this.loans - paid);
    this.deposits = Math.max(0, this.deposits - paid);   // <-- broad money destroyed
    if (rec.balance <= 0.01) this.book.delete(borrowerId);
    return paid;
  }

  loanBalance(borrowerId: AgentId): number { return this.book.get(borrowerId)?.balance ?? 0; }
  get openLoans(): number { return this.book.size; }
  loanRateFor(borrowerId: AgentId): number { return this.book.get(borrowerId)?.rate ?? this.lendingRate; }

  /** borrower default: the loan asset dies against bank EQUITY; the deposits it
   *  once created stay in circulation (money is not destroyed by a default).
   *  Lower capital ⇒ smaller lendingCapacity ⇒ credit rationing — the
   *  financial accelerator. Returns the balance written off. */
  writeOff(borrowerId: AgentId): Money {
    const rec = this.book.get(borrowerId);
    if (!rec || rec.balance <= 0) return 0;
    const loss = rec.balance;
    this.book.delete(borrowerId);
    this.loans = Math.max(0, this.loans - loss);
    this.capital -= loss;
    return loss;
  }

  // ---- pricing -------------------------------------------------------------
  /** set the loan/deposit rates off the Fed's prime + IORB (deposit beta < 1).
   *  A capital-thin bank charges a RISK SPREAD: as CET1 slides from target to
   *  the floor, new credit gets dearer — stress prices itself. */
  setRates(prime: number, iorb: number): void {
    const ratio = this.capitalRatio();
    const thin = clamp((CET1_TARGET - ratio) / (CET1_TARGET - CET1_MIN), 0, 1);
    this.lendingRate = prime + 0.01 + RISK_SPREAD_MAX * thin;
    this.depositRate = Math.max(0, iorb * 0.45);    // pass-through beta ~0.45
  }
  get offeredLoanRate(): number { return this.lendingRate; }
  get offeredDepositRate(): number { return this.depositRate; }

  // ---- per-tick accounting (dt in sim-hours; rates annual) -----------------
  /** loan interest each borrower owes this tick (a TRANSFER borrower→bank equity).
   *  Returned so the orchestrator can debit the borrowers' actual balances. */
  interestDue(dtHours: number): { id: AgentId; amt: Money }[] {
    const yr = dtHours / (24 * 365);
    const out: { id: AgentId; amt: Money }[] = [];
    for (const [id, rec] of this.book) out.push({ id, amt: rec.balance * rec.rate * yr });
    return out;
  }

  /** close the tick's P&L into equity: + loan interest + IORB on reserves
   *  − deposit interest (paid EXPLICITLY to households via the monetary layer,
   *  passed in here so the P&L stays honest) − operating cost − residual losses.
   *  Real credit losses land separately through writeOff(). */
  settle(dtHours: number, loanInterest: Money, iorb: number, depositInterestPaid: Money = 0): void {
    const yr = dtHours / (24 * 365);
    const iorbIncome = this.reserves * iorb * yr;
    const losses = this.loans * LOSS_RATE_ANNUAL * yr;
    const opex = this.deposits * 0.005 * yr;        // stylized operating cost
    this.niiThisTick = loanInterest + iorbIncome - depositInterestPaid - losses - opex;
    this.capital += this.niiThisTick;
    // charge-offs also shrink the loan book (the losses are real asset write-downs).
    this.loans = Math.max(0, this.loans - losses);
  }
  get lastNII(): number { return this.niiThisTick; }

  view(): CommercialBankView {
    return {
      id: this.id, name: this.name, reserves: this.reserves, loans: this.loans,
      securities: this.securities, deposits: this.deposits, capital: this.capital,
      capitalRatio: this.capitalRatio(), reserveRatio: this.deposits > 1 ? this.reserves / this.deposits : 0,
      lendingRate: this.lendingRate, depositRate: this.depositRate, solvent: this.solvent, loanCount: this.openLoans,
    };
  }

  toJSON(): unknown {
    return { id: this.id, reserves: this.reserves, securities: this.securities, loans: this.loans, deposits: this.deposits, capital: this.capital, lend: this.lendingRate, dep: this.depositRate, book: [...this.book.entries()] };
  }
  loadJSON(j: unknown): void {
    const o = j as { reserves?: number; securities?: number; loans?: number; deposits?: number; capital?: number; lend?: number; dep?: number; book?: [AgentId, LoanRec][] } | null;
    if (!o) return;
    this.reserves = o.reserves ?? this.reserves;
    this.securities = o.securities ?? this.securities;
    this.loans = o.loans ?? this.loans;
    this.deposits = o.deposits ?? this.deposits;
    this.capital = o.capital ?? this.capital;
    if (typeof o.lend === 'number') this.lendingRate = o.lend;
    if (typeof o.dep === 'number') this.depositRate = o.dep;
    this.book = new Map(Array.isArray(o.book) ? o.book : []);
  }
}
