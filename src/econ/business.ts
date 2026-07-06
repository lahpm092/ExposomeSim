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
  AgentId, BusinessConfig, BusinessId, BusinessKind, BusinessState, BusinessView,
  GoodId, MacroAggregates, Money, Sector,
} from './types';
import {
  RENT_PERIOD, MIN_WAGE, WAGE_ADJ,
  EXP_ADAPT, INV_BUFFER, INV_CORRECT, INV_CORRECT_CAP, INV_TARGET_H, INV_KEEP_H,
  RATE_SENS, RATE_NEUTRAL,
  RETAIL_SHELF, SHELF_TARGET_H, PENDING_CAPACITY, MAKER_INV_TARGET_H, MAKER_KEEP_H,
  MAKER_FLOOR_MARKUP,
} from './config';
import { clamp } from '../core/util/num';

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
  homegoods: 0.05, apparel: 0.05,
};

/** a retail shelf slot: one good's stock, demand share, cap and the blended
 *  wholesale unit cost last paid (feeds the marginal-cost supply floor). */
export interface ShelfSlot {
  good: GoodId;
  share: number;
  cap: number;
  stock: number;
  sold: number;        // cumulative units sold off this slot
  lastCost: number;    // blended wholesale $/unit last restock
}

export class Business {
  readonly id: BusinessId;
  readonly name: string;
  readonly sector: Sector;
  readonly anchor: boolean;            // never removed (town infrastructure)
  readonly ownerId?: AgentId;          // entrant firms: founding household (dividends)
  // ---- phase 5: supply-chain role ----------------------------------------------
  readonly kind: BusinessKind;         // 'service' (default) | 'maker' | 'retail'
  readonly good?: GoodId;              // makers: the good produced
  readonly archetype?: string;         // render-side building archetype (data only)

  // ---- immutable config (identity + economics; rebuilt by the ctor) ----------
  private readonly _seedCash: Money;
  private readonly _basePrice: Money;
  private readonly _unitCost: Money;
  private readonly _capacityPerWorker: number;
  private readonly _baseWage: Money;
  private _commercialRent: Money;      // mutable: a lease replaces the generic rent
  private readonly _maxHeadcount: number;
  private readonly _adapt: number;     // demand-expectation learning rate /h
  private readonly _invTargetH: number;  // maker: keyed by GOOD; else by sector
  private readonly _invKeep: number;

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
  private _restructuredAt = -1e9;      // anchor-firm bailout cooldown
  // phase 4 — expectations + inventory (Metzler). expRate < 0 = "no data yet":
  // produce at capacity until the first sale teaches the firm its demand.
  private _expRate = -1;                  // adaptive expected demand, units/sim-hour
  private _inventory = 0;                 // finished storable goods on the shelf
  private _lastOffer = 0;                 // units offered to the market this tick
  // phase 5 — retail shelf + premises
  private _shelf: ShelfSlot[] = [];       // retail only: per-good shelf stock
  private _pendingPremises = false;       // entrant waiting for a commercial unit
  private _premisesUnitId?: string;
  private _tripsCum = 0;                  // grocery retail: shopping trips served

  // ---- per-tick accumulators (zeroed by settle) ------------------------------
  private _revenueAcc = 0;
  private _cogsAcc = 0;
  private _payrollAcc = 0;
  private _rentAcc = 0;
  private _unitsSoldAcc = 0;
  private _producedAcc = 0;

  // ---- last-tick readouts (what view()/state() report) -----------------------
  private _lastRevenue = 0;
  private _lastCogs = 0;
  private _lastPayroll = 0;
  private _lastRent = 0;
  private _lastUnitsSold = 0;
  private _lastProfit = 0;
  private _lastProduced = 0;

  // ---- cumulative dashboard totals -------------------------------------------
  private _cumRevenue = 0;
  private _cumProfit = 0;

  constructor(cfg: BusinessConfig, clock: number) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.sector = cfg.sector;
    this.anchor = cfg.anchor ?? false;
    this.ownerId = cfg.ownerId;
    this.kind = cfg.kind ?? 'service';
    this.good = cfg.good;
    this.archetype = cfg.archetype;
    this._seedCash = cfg.seedCash;
    this._basePrice = cfg.basePrice;
    this._unitCost = cfg.unitCost;
    this._capacityPerWorker = cfg.capacityPerWorker;
    this._baseWage = cfg.baseWage;
    // "from home" pays no commercial rent; the lease sets the real one later.
    this._commercialRent = cfg.pendingPremises ? 0 : cfg.commercialRent;
    this._maxHeadcount = cfg.maxHeadcount;
    this._adapt = cfg.adaptRate ?? EXP_ADAPT;
    // makers warehouse their own GOOD (a bakery's bread ≠ the groceries sector's
    // zero-shelf); services keep the sector tables (exactly phase-4 behaviour).
    this._invTargetH = this.kind === 'maker' && this.good ? MAKER_INV_TARGET_H[this.good] : INV_TARGET_H[this.sector];
    this._invKeep = this.kind === 'maker' && this.good ? MAKER_KEEP_H[this.good] : INV_KEEP_H[this.sector];
    // retail: build the shelf from the config plan (or the sector template),
    // stocked to 80% at t0 (an opening endowment, like the old supermarket's).
    if (this.kind === 'retail') {
      const plan = cfg.shelf ?? RETAIL_SHELF[this.sector] ?? [];
      this._shelf = plan.map((p) => ({
        good: p.good, share: p.share, cap: p.cap,
        stock: cfg.pendingPremises ? 0 : p.cap * 0.8, sold: 0, lastCost: 0,
      }));
    }
    this._pendingPremises = cfg.pendingPremises ?? false;

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
  /** units this firm can produce/serve per sim-hour at the current workforce.
   *  An entrant still waiting for premises works "from home" at reduced capacity. */
  capacity(): number {
    return this._workers.length * this._capacityPerWorker * (this._pendingPremises ? PENDING_CAPACITY : 1);
  }

  // ---- premises -----------------------------------------------------------------
  get pendingPremises(): boolean { return this._pendingPremises; }
  get premisesUnitId(): string | undefined { return this._premisesUnitId; }
  /** sign the lease: full capacity + the unit's rent replaces the generic rent. */
  leasePremises(unitId: string, rent: Money): void {
    this._pendingPremises = false;
    this._premisesUnitId = unitId;
    this._commercialRent = rent;
  }
  get commercialRent(): Money { return this._commercialRent; }

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
  /**
   * PRODUCE for this tick (Metzler): plan output from the adaptive demand
   * expectation plus an inventory-gap correction, capped by capacity. COGS is
   * paid on PRODUCTION, not sales — overproducing hurts, so expectation errors
   * have teeth and the inventory cycle can emerge. Returns the units OFFERED
   * to the market (fresh production + shelf stock).
   */
  produce(dt: number): number {
    const capT = this.capacity() * dt;
    const rate = this._expRate;
    let planned: number;
    if (rate < 0) {
      planned = capT;                    // no data yet → the old always-full behaviour
    } else {
      const targetInv = this._invTargetH * rate;
      const corr = clamp((targetInv - this._inventory) * INV_CORRECT,
        -INV_CORRECT_CAP * rate * dt, INV_CORRECT_CAP * rate * dt);
      planned = rate * dt * (1 + INV_BUFFER) + corr;
    }
    // PROFITABILITY GATE: no firm keeps producing flat-out at a price below its
    // MARGINAL COST — materials plus the labour a unit takes — it withholds
    // supply instead, which starves the market until tâtonnement lifts the
    // price back over cost. This is the supply-side price floor that (a) keeps
    // a startup glut from freezing into permanent sell-below-cost deflation and
    // (b) anchors each sector's price near real cost + a thin margin.
    // MAKERS carry a fatter floor markup: wholesale demand (retailer restock
    // orders) is price-INELASTIC and import-ceilinged, so the tâtonnement
    // equilibrium lands wherever this throttle says "enough" — 1.05× would pin
    // every maker just below average cost forever (a bleed-out, not a market).
    const marginalCost = this._unitCost + (this._capacityPerWorker > 0 ? this._wage / this._capacityPerWorker : 0);
    const floorPrice = marginalCost * (this.kind === 'maker' ? MAKER_FLOOR_MARKUP : 1.05);
    if (this._price < floorPrice && this._price > 0) {
      planned *= clamp(Math.pow(this._price / floorPrice, 2), 0.15, 1);
    }
    const production = clamp(planned, 0, capT);
    const cogs = production * this._unitCost;
    this._cogsAcc += cogs;
    this._cash -= cogs;
    this._producedAcc += production;
    this._lastOffer = production + this._inventory;
    return this._lastOffer;
  }

  /** the units this firm put on the market this tick (its slice of sector supply). */
  get lastOffer(): number { return this._lastOffer; }

  /**
   * Settle this tick's SALES: bank the gross revenue (buyers already paid the
   * orchestrator), roll unsold output into inventory (perishables decay), and
   * update the adaptive demand expectation from the demand this firm actually
   * saw. dt-invariant: λ_eff = 1 − (1−λ)^dt.
   */
  sellAllocated(units: number, price: Money, demandSeen: number, dt: number): void {
    if (units > 0) {
      this._revenueAcc += units * price;
      this._cash += units * price;
      this._unitsSoldAcc += units;
    }
    this._price = price > 0 ? price : 0;
    const leftover = Math.max(0, this._lastOffer - Math.max(0, units));
    this._inventory = leftover * Math.pow(this._invKeep, Math.max(dt, 0));
    if (dt > 1e-9) {
      const seen = Math.max(0, demandSeen) / dt;
      const lam = 1 - Math.pow(1 - clamp(this._adapt, 0.02, 0.9), dt);
      this._expRate = this._expRate < 0 ? seen : this._expRate + lam * (seen - this._expRate);
    }
  }

  // =============================================================================
  // RETAIL (phase 5): the shelf. A retail firm buys goods at wholesale onto
  // per-good shelf stock and sells at the sector's retail price. Stockouts are
  // lost sales (the sector market reads them as shortage).
  // =============================================================================
  shelfSlots(): readonly ShelfSlot[] { return this._shelf; }
  shelfTotal(): number { let s = 0; for (const sl of this._shelf) s += sl.stock; return s; }
  shelfCapTotal(): number { let s = 0; for (const sl of this._shelf) s += sl.cap; return s; }

  /** units this retailer can put in front of customers this tick: bounded by the
   *  shelf AND by staff throughput (a from-home entrant serves at 0.4 capacity). */
  retailOffer(dt: number): number {
    return Math.min(this.shelfTotal(), this.capacity() * dt);
  }

  /**
   * Plan this tick's RESTOCK toward target shelf depth (SHELF_TARGET_H hours of
   * expected sales), with the same bounded inventory-gap correction the makers
   * use — a bare shelf cannot demand 3× throughput. Orders throttle (a) below
   * the marginal-cost supply floor (retail price under wholesale + labour ⇒
   * withhold — the retail analogue of the maker's profitability gate) and
   * (b) against the cash on hand (keep a day of payroll in reserve).
   * `priceOf` is the current wholesale price estimate per good.
   */
  planRestock(dt: number, priceOf: (g: GoodId) => Money): { good: GoodId; units: number }[] {
    if (this.kind !== 'retail' || this._shelf.length === 0 || this._bankrupt) return [];
    const targetH = SHELF_TARGET_H[this.sector] ?? 24;
    const rate = this._expRate;
    // marginal-cost floor: blended wholesale cost + the labour a unit takes.
    let blend = 0;
    for (const sl of this._shelf) blend += sl.share * (sl.lastCost > 0 ? sl.lastCost : priceOf(sl.good));
    const marginalCost = blend + (this._capacityPerWorker > 0 ? this._wage / this._capacityPerWorker : 0);
    const floorPrice = marginalCost * 1.05;
    const floorScale = this._price < floorPrice && this._price > 0
      ? clamp(Math.pow(this._price / floorPrice, 2), 0.15, 1) : 1;

    const orders: { good: GoodId; units: number }[] = [];
    let estCost = 0;
    for (const sl of this._shelf) {
      let units: number;
      if (rate < 0) {
        // no sales data yet (a fresh entrant): stock the shelf in bounded steps —
        // scaled down while operating from home (don't glut wholesale from a
        // spare room, and don't torch the seed cash before the lease).
        units = 0.03 * sl.cap * dt * (this._pendingPremises ? PENDING_CAPACITY : 1);
      } else {
        const exp = Math.max(0, rate) * sl.share;                 // expected sales/h
        const target = Math.min(exp * targetH, 0.9 * sl.cap);
        const corr = clamp((target - sl.stock) * INV_CORRECT,
          -INV_CORRECT_CAP * exp * dt, INV_CORRECT_CAP * exp * dt);
        units = exp * dt + corr;
      }
      units = clamp(units * floorScale, 0, Math.max(0, sl.cap - sl.stock));
      if (units > 1e-9) { orders.push({ good: sl.good, units }); estCost += units * priceOf(sl.good); }
    }
    // cash gate: never restock past what cash allows (a day of payroll reserved).
    const budget = Math.max(0, this._cash - this.headcount() * this._wage * 24);
    if (estCost > budget && estCost > 1e-9) {
      const k = budget / estCost;
      for (const o of orders) o.units *= k;
    }
    return orders;
  }

  /** goods arrive: stock the shelf, pay the wholesale bill (booked as COGS). */
  receiveStock(good: GoodId, units: number, cost: Money): void {
    if (units <= 0) return;
    const sl = this._shelf.find((s) => s.good === good);
    if (!sl) return;
    sl.stock = Math.min(sl.cap, sl.stock + units);
    sl.lastCost = cost > 0 ? cost / units : sl.lastCost;
    this._cash -= cost;
    this._cogsAcc += cost;
  }

  /**
   * Sell `units` off the shelf at `price`, depleting per-good stock by demand
   * share (bounded by stock — a dry category sells less). Books revenue and
   * updates the adaptive demand expectation like sellAllocated. Returns the
   * units actually moved.
   */
  sellFromShelf(units: number, price: Money, demandSeen: number, dt: number): number {
    let sold = 0;
    if (units > 0) {
      for (const sl of this._shelf) {
        const take = Math.min(units * sl.share, sl.stock);
        sl.stock -= take;
        sl.sold += take;
        sold += take;
      }
      if (sold > 0) {
        this._revenueAcc += sold * price;
        this._cash += sold * price;
        this._unitsSoldAcc += sold;
      }
    }
    this._price = price > 0 ? price : 0;
    if (dt > 1e-9) {
      const seen = Math.max(0, demandSeen) / dt;
      const lam = 1 - Math.pow(1 - clamp(this._adapt, 0.02, 0.9), dt);
      this._expRate = this._expRate < 0 ? seen : this._expRate + lam * (seen - this._expRate);
    }
    return sold;
  }

  /** grocery retail: count the shopping trips served (SupermarketView.trips). */
  recordTrips(n: number): void { this._tripsCum += n; }
  get trips(): number { return this._tripsCum; }

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
  // lowers the utilisation bar that justifies a hire; a bust raises it. DEAR
  // MONEY is a headwind: when the lending rate sits above neutral, expanding
  // payroll on a working-capital line costs real interest, so the bar rises —
  // this is where the Fed's rate reaches the real economy.
  decide(macro: MacroAggregates, lendingRate = RATE_NEUTRAL): void {
    const hc = this.headcount();
    const cap = this.capacity();
    const util = cap > 0 ? clamp(this._lastUnitsSold / cap, 0, 1) : 0;
    const boom = clamp(macro.boom, -1, 1);
    const rateDrag = RATE_SENS * Math.max(0, lendingRate - RATE_NEUTRAL);
    const growBar = clamp(GROW_UTIL - BOOM_TAILWIND * boom + rateDrag, 0.5, 0.98);

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
    this._lastProduced = this._producedAcc;

    this._cumRevenue += this._revenueAcc;
    this._cumProfit += profit;

    // Health: scale-invariant solvency (cash mapped from the ruin line up to the
    // seed) nudged by the sign of this tick's profit. Robust across the 1.8k↔42k
    // seedCash span because everything is a ratio of seedCash.
    const ruin = -RUIN_FRAC * this._seedCash;
    const solvency = clamp((this._cash - ruin) / (this._seedCash - ruin), 0, 1);
    this._health = clamp(solvency + (profit >= 0 ? IDLE_HEALTH : -LOSS_HEALTH), 0, 1);

    // Insolvency latch: once ruined, stay ruined. (Non-anchor firms are then
    // dissolved by the orchestrator; anchor firms get restructured instead.)
    if (this._cash < ruin || this._health <= 0) this._bankrupt = true;

    this._revenueAcc = 0; this._cogsAcc = 0; this._payrollAcc = 0;
    this._rentAcc = 0; this._unitsSoldAcc = 0; this._producedAcc = 0;
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
      inventory: this._inventory,
      expDemand: Math.max(0, this._expRate),
      produced: this._lastProduced,
      ownerId: this.ownerId,
      foundedAt: this._foundedAt,
      cumRevenue: this._cumRevenue,
      kind: this.kind,
      good: this.good,
      archetype: this.archetype,
      pendingPremises: this._pendingPremises || undefined,
      shelfStock: this.kind === 'retail' ? this.shelfTotal() : undefined,
      shelfCap: this.kind === 'retail' ? this.shelfCapTotal() : undefined,
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

  /** RESTRUCTURE a bankrupt ANCHOR firm (town infrastructure can't dissolve):
   *  an outside equity injection resets a lean, chastened balance sheet. The
   *  orchestrator writes off its bank debt first (that loss is real). Returns
   *  false while the post-restructure cooldown holds (then it just sits idle). */
  restructure(clock: number): boolean {
    if (clock - this._restructuredAt < 24 * 14) return false;
    this._restructuredAt = clock;
    this._bankrupt = false;
    this._health = 0.3;
    this._cash = Math.max(this._cash, 0.25 * this._seedCash);
    this._desiredHeadcount = 1;
    this._wage = Math.max(MIN_WAGE, this._baseWage * 0.9);
    this._expRate = -1;                 // relearn demand from scratch
    this._inventory = 0;
    return true;
  }

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
      expRate: this._expRate, inventory: this._inventory,
      restructuredAt: this._restructuredAt,
      shelf: this.kind === 'retail'
        ? this._shelf.map((s) => [s.good, s.stock, s.sold, s.lastCost] as [GoodId, number, number, number])
        : undefined,
      pendingPremises: this._pendingPremises || undefined,
      premisesUnitId: this._premisesUnitId,
      commercialRent: this._commercialRent,
      trips: this._tripsCum || undefined,
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
    this._expRate = typeof s.expRate === 'number' ? s.expRate : -1;
    this._inventory = typeof s.inventory === 'number' ? s.inventory : 0;
    this._restructuredAt = typeof s.restructuredAt === 'number' ? s.restructuredAt : -1e9;
    // ---- phase 5 (all optional: pre-phase-5 saves default cleanly) ------------
    if (Array.isArray(s.shelf)) {
      for (const [good, stock, sold, lastCost] of s.shelf) {
        const sl = this._shelf.find((x) => x.good === good);
        if (sl) { sl.stock = stock ?? sl.stock; sl.sold = sold ?? 0; sl.lastCost = lastCost ?? 0; }
      }
    }
    this._pendingPremises = s.pendingPremises ?? false;
    this._premisesUnitId = s.premisesUnitId;
    if (typeof s.commercialRent === 'number') this._commercialRent = s.commercialRent;
    this._tripsCum = s.trips ?? 0;
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
  expRate?: number; inventory?: number; restructuredAt?: number;
  // phase 5 (optional — old saves default)
  shelf?: [GoodId, number, number, number][];   // good, stock, sold, lastCost
  pendingPremises?: boolean;
  premisesUnitId?: string;
  commercialRent?: number;
  trips?: number;
}
