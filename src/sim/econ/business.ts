// =============================================================================
// business.ts — the Tier-B firm engine. One data-driven Business per row in
// config.ts BUSINESSES. It owns firm-level STATE (cash, price, wage, workforce)
// and the hire/fire/wage/headcount DECISIONS, plus the per-tick accounting hooks
// the orchestrator drives. It does NOT move money between wallets and firms (the
// orchestrator owns transfers) and it does NOT set its own sector price — the
// goods market discovers that and pushes it in via setPrice(). Everything macro
// (inflation, unemployment, the business cycle) EMERGES from many firms running
// this same loop against the markets; there is no closed form, so you must step
// the sim (computational irreducibility).
//
// PURE: no DOM/THREE, no Math.random/Date/IO. Deterministic from its inputs.
// =============================================================================
import type {
  AgentId, BusinessConfig, BusinessId, BusinessState, BusinessView,
  MacroAggregates, Money, Sector,
} from './types';
import { RENT_PERIOD, MIN_WAGE, WAGE_ADJ } from './config';
import { clamp } from '../../util/num';

// ---- tuning ----------------------------------------------------------------
const RUIN_FRAC = 0.6;          // debt past −RUIN_FRAC·seedCash ⇒ bankrupt (scale-free)
const GROW_UTIL = 0.82;         // baseline utilisation bar that justifies hiring
const BOOM_TAILWIND = 0.15;     // a boom lowers that bar; a bust raises it
const IDLE_HEALTH = 0.05;       // profit nudge to health when in the black
const LOSS_HEALTH = 0.15;       // profit nudge to health when bleeding
const WAGE_CEIL_MULT = 3;       // wages may drift up to this × the firm's base wage

/** Hire bar per sector: how skilled a candidate a firm insists on. The software
 *  house is selective (its capacityPerWorker is tiny and its wage/output huge, so
 *  a weak hire is expensive); food/retail take anyone off the street. Grocery and
 *  utilities sit in between. Emergent selectivity, not scripted staffing. */
const SKILL_BAR: Record<Sector, number> = {
  food: 0, retail: 0, groceries: 0.05, utilities: 0.18, software: 0.35,
};

export class Business {
  readonly id: BusinessId;
  readonly name: string;
  readonly sector: Sector;

  // ---- immutable config (identity + economics; rebuilt by the ctor) ----------
  private readonly _seedCash: Money;
  private readonly _basePrice: Money;
  private readonly _unitCost: Money;
  private readonly _capacityPerWorker: number;
  private readonly _baseWage: Money;
  private readonly _commercialRent: Money;
  private readonly _maxHeadcount: number;

  // ---- live state ------------------------------------------------------------
  private _cash: Money;
  private _price: Money;                 // owned by the goods market (setPrice)
  private _wage: Money;                   // offered hourly wage
  private _health = 1;                    // 0..1 solvency/vitality
  private _bankrupt = false;
  private _desiredHeadcount: number;
  private _workers: AgentId[] = [];
  private _rentDueAt: number;
  private readonly _foundedAt: number;

  // ---- per-tick accumulators (zeroed by settle) ------------------------------
  private _revenueAcc = 0;
  private _cogsAcc = 0;
  private _payrollAcc = 0;
  private _rentAcc = 0;
  private _unitsSoldAcc = 0;

  // ---- last-tick readouts (what view()/state() report) -----------------------
  private _lastRevenue = 0;
  private _lastCogs = 0;
  private _lastPayroll = 0;
  private _lastRent = 0;
  private _lastUnitsSold = 0;
  private _lastProfit = 0;

  // ---- cumulative dashboard totals -------------------------------------------
  private _cumRevenue = 0;
  private _cumProfit = 0;

  constructor(cfg: BusinessConfig, clock: number) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.sector = cfg.sector;
    this._seedCash = cfg.seedCash;
    this._basePrice = cfg.basePrice;
    this._unitCost = cfg.unitCost;
    this._capacityPerWorker = cfg.capacityPerWorker;
    this._baseWage = cfg.baseWage;
    this._commercialRent = cfg.commercialRent;
    this._maxHeadcount = cfg.maxHeadcount;

    this._cash = cfg.seedCash;
    this._price = cfg.basePrice;
    this._wage = cfg.baseWage;
    // want to staff up to (at least) the founder count; the labour market fills it.
    this._desiredHeadcount = clamp(cfg.founderIds.length || 1, 1, cfg.maxHeadcount);
    this._foundedAt = clock;
    this._rentDueAt = clock + RENT_PERIOD;
  }

  // ---- live getters ----------------------------------------------------------
  get cash(): Money { return this._cash; }
  get seedCash(): Money { return this._seedCash; }
  /** move cash in/out (a bank credit-line draw or repayment / interest paid). */
  addCash(amt: Money): void { this._cash += amt; }
  get price(): Money { return this._price; }
  get wage(): Money { return this._wage; }
  get bankrupt(): boolean { return this._bankrupt; }
  get health(): number { return this._health; }
  get desiredHeadcount(): number { return this._desiredHeadcount; }

  workers(): readonly AgentId[] { return this._workers; }
  headcount(): number { return this._workers.length; }
  /** units this firm can produce/serve per econ tick at the current workforce. */
  capacity(): number { return this._workers.length * this._capacityPerWorker; }

  // ---- workforce roster (membership only; the labour market decides who) ------
  hasWorker(id: AgentId): boolean { return this._workers.includes(id); }
  addWorker(id: AgentId): void { if (!this._workers.includes(id)) this._workers.push(id); }
  removeWorker(id: AgentId): boolean {
    const i = this._workers.indexOf(id);
    if (i < 0) return false;
    this._workers.splice(i, 1);
    return true;
  }

  // ---- accounting hooks (accumulate into the CURRENT tick) -------------------
  /** Sell `units` at the market-transacted `price`. Revenue and COGS accrue for
   *  the tick's profit; cash moves only by the margin (the orchestrator has
   *  already collected the gross from buyers, so we bank net-of-COGS here). */
  bookSales(units: number, price: Money): void {
    if (units <= 0) return;
    const revenue = units * price;
    const cogs = units * this._unitCost;
    this._revenueAcc += revenue;
    this._cogsAcc += cogs;
    this._cash += revenue - cogs;
    this._unitsSoldAcc += units;
  }

  /** Book a payroll disbursement this tick (the orchestrator pays the wallets). */
  bookPayroll(amount: Money): void {
    this._payrollAcc += amount;
    this._cash -= amount;
  }

  /** Charge one period of commercial rent if it has come due; roll the schedule
   *  forward and return the amount charged (0 if not yet due). */
  chargeRent(clock: number): Money {
    if (clock < this._rentDueAt) return 0;
    this._cash -= this._commercialRent;
    this._rentAcc += this._commercialRent;
    this._rentDueAt += RENT_PERIOD;
    return this._commercialRent;
  }

  // ---- external setters ------------------------------------------------------
  /** The goods market pushes the discovered sector price in here (see header). */
  setPrice(p: Money): void { this._price = p > 0 ? p : 0; }
  /** The labour market may post a higher offered wage; keep it in a sane band. */
  setWage(w: Money): void { this._wage = clamp(w, MIN_WAGE, this._baseWage * WAGE_CEIL_MULT); }

  // ---- policy: pick a target headcount + wage from the last tick -------------
  // Grow when we made money AND ran near capacity (demand we could have served);
  // shrink when we bled. Wage bids up when we want more hands than we have, and
  // drifts toward the floor when we are shedding. A boom is a mild tailwind: it
  // lowers the utilisation bar that justifies a hire; a bust raises it.
  decide(macro: MacroAggregates): void {
    const hc = this.headcount();
    const cap = this.capacity();
    const util = cap > 0 ? clamp(this._lastUnitsSold / cap, 0, 1) : 0;
    const boom = clamp(macro.boom, -1, 1);
    const growBar = clamp(GROW_UTIL - BOOM_TAILWIND * boom, 0.5, 0.95);

    let desired = hc;
    if (this._lastProfit > 0 && util >= growBar) {
      desired = hc + 1;                 // profitable AND capacity-constrained → expand
    } else if (this._lastProfit < 0) {
      desired = hc - 1;                 // losing money → shed a worker
    }
    this._desiredHeadcount = clamp(desired, 1, this._maxHeadcount);

    const wageCeil = this._baseWage * WAGE_CEIL_MULT;
    if (this._desiredHeadcount > hc) {
      this._wage = clamp(this._wage * (1 + WAGE_ADJ), MIN_WAGE, wageCeil);  // scarce labour
    } else if (this._desiredHeadcount < hc) {
      this._wage = clamp(this._wage * (1 - WAGE_ADJ), MIN_WAGE, wageCeil);  // shedding
    }
  }

  // ---- close the tick --------------------------------------------------------
  // Realise profit, roll accumulators into the last* readouts, refresh health,
  // latch bankruptcy, then zero the accumulators for the next tick. `dtHours` is
  // the elapsed econ window; the booked flows already cover it, so it is kept for
  // signature/future use (e.g. annualising) rather than rescaling here.
  settle(dtHours: number): void {
    void dtHours;
    const profit = this._revenueAcc - this._payrollAcc - this._cogsAcc - this._rentAcc;

    this._lastRevenue = this._revenueAcc;
    this._lastCogs = this._cogsAcc;
    this._lastPayroll = this._payrollAcc;
    this._lastRent = this._rentAcc;
    this._lastUnitsSold = this._unitsSoldAcc;
    this._lastProfit = profit;

    this._cumRevenue += this._revenueAcc;
    this._cumProfit += profit;

    // Health: scale-invariant solvency (cash mapped from the ruin line up to the
    // seed) nudged by the sign of this tick's profit. Robust across the 1.8k↔42k
    // seedCash span because everything is a ratio of seedCash.
    const ruin = -RUIN_FRAC * this._seedCash;
    const solvency = clamp((this._cash - ruin) / (this._seedCash - ruin), 0, 1);
    this._health = clamp(solvency + (profit >= 0 ? IDLE_HEALTH : -LOSS_HEALTH), 0, 1);

    // Insolvency latch: once ruined, stay ruined.
    if (this._cash < ruin || this._health <= 0) this._bankrupt = true;

    this._revenueAcc = 0; this._cogsAcc = 0; this._payrollAcc = 0;
    this._rentAcc = 0; this._unitsSoldAcc = 0;
  }

  // ---- readouts --------------------------------------------------------------
  view(): BusinessView {
    return {
      id: this.id, name: this.name, sector: this.sector,
      cash: this._cash, price: this._price, wage: this._wage,
      headcount: this._workers.length,
      desiredHeadcount: this._desiredHeadcount,
      unitsSold: this._lastUnitsSold,
      revenue: this._lastRevenue,
      profit: this._lastProfit,
      health: this._health,
      bankrupt: this._bankrupt,
      hiring: this._desiredHeadcount > this._workers.length && !this._bankrupt,
    };
  }

  state(): BusinessState {
    return {
      id: this.id, name: this.name, sector: this.sector,
      cash: this._cash, price: this._price, wage: this._wage,
      workers: this._workers.slice(),
      desiredHeadcount: this._desiredHeadcount,
      unitsSold: this._lastUnitsSold,
      revenue: this._lastRevenue,
      payroll: this._lastPayroll,
      profit: this._lastProfit,
      health: this._health,
      bankrupt: this._bankrupt,
      foundedAt: this._foundedAt,
      cumRevenue: this._cumRevenue,
      cumProfit: this._cumProfit,
    };
  }

  /** the skill floor this firm hires above (0 = anyone; software is selective). */
  minSkillBar(): number { return SKILL_BAR[this.sector]; }

  // ---- persistence (identity/config rebuilt by the ctor; state overwritten) --
  toJSON(): unknown {
    const j: BusinessJSON = {
      cash: this._cash, price: this._price, wage: this._wage,
      health: this._health, bankrupt: this._bankrupt,
      desiredHeadcount: this._desiredHeadcount,
      workers: this._workers.slice(), rentDueAt: this._rentDueAt,
      revenueAcc: this._revenueAcc, cogsAcc: this._cogsAcc,
      payrollAcc: this._payrollAcc, rentAcc: this._rentAcc,
      unitsSoldAcc: this._unitsSoldAcc,
      lastRevenue: this._lastRevenue, lastCogs: this._lastCogs,
      lastPayroll: this._lastPayroll, lastRent: this._lastRent,
      lastUnitsSold: this._lastUnitsSold, lastProfit: this._lastProfit,
      cumRevenue: this._cumRevenue, cumProfit: this._cumProfit,
    };
    return j;
  }

  loadJSON(j: unknown): void {
    const s = j as BusinessJSON;
    this._cash = s.cash; this._price = s.price; this._wage = s.wage;
    this._health = s.health; this._bankrupt = s.bankrupt;
    this._desiredHeadcount = s.desiredHeadcount;
    this._workers = s.workers.slice(); this._rentDueAt = s.rentDueAt;
    this._revenueAcc = s.revenueAcc; this._cogsAcc = s.cogsAcc;
    this._payrollAcc = s.payrollAcc; this._rentAcc = s.rentAcc;
    this._unitsSoldAcc = s.unitsSoldAcc;
    this._lastRevenue = s.lastRevenue; this._lastCogs = s.lastCogs;
    this._lastPayroll = s.lastPayroll; this._lastRent = s.lastRent;
    this._lastUnitsSold = s.lastUnitsSold; this._lastProfit = s.lastProfit;
    this._cumRevenue = s.cumRevenue; this._cumProfit = s.cumProfit;
  }
}

export interface BusinessJSON {
  cash: Money; price: Money; wage: Money;
  health: number; bankrupt: boolean;
  desiredHeadcount: number;
  workers: AgentId[]; rentDueAt: number;
  revenueAcc: number; cogsAcc: number; payrollAcc: number;
  rentAcc: number; unitsSoldAcc: number;
  lastRevenue: number; lastCogs: number; lastPayroll: number;
  lastRent: number; lastUnitsSold: number; lastProfit: number;
  cumRevenue: number; cumProfit: number;
}
