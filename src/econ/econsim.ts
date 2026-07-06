// =============================================================================
// econsim.ts — the EconomySim orchestrator (the money-mover + tick sequencer).
// -----------------------------------------------------------------------------
// Ties the Tier-A wallets, the Tier-B firms, the goods/housing/labour markets and
// the Tier-C shadow population into one economy that the Town steps once per frame
// (it self-throttles onto a coarse ~1h econ clock). This module owns ALL money
// flows so conservation + bookkeeping live in one testable place; the sub-modules
// only make decisions and hold state. See ECONOMY_DESIGN.md.
//
// Mara (the protagonist) keeps her pre-existing single-wallet ledger (sim/economy.ts)
// untouched — the EconomySim MIRRORS it into her wallet for display + counts her as
// a worker of the counter, but never double-charges her. The other 17 full-res
// agents (+ the shadow population) are driven fully here.
// =============================================================================

import type {
  AgentId, BusinessId, Sector, Wallet, EconSnapshot, EconStepCtx, BusinessConfig,
  MacroAggregates, SectorMap, LaborCandidate, FirmDemand, AgentEconView, LaborEvent,
  ConsumerCredit,
} from './types';
import { SECTORS } from './types';
import { createWallet, payWage, buy, chargeRent, evict, rehouse, growSkill, hire, fire, setTraining } from './wallet';
import { Business } from './business';
import { GoodsMarket, Housing } from './market';
import { LaborMarket } from './labor';
import { ShadowPop } from './shadowpop';
import { MonetarySystem } from './monetary';
import { Construction, type ConstructionCtx } from './construction';
import { Supermarket } from './supermarket';
import { PhysioField } from './physio';
import { EconHistory, type HistField } from './history';
import {
  BUSINESSES, ECON_TICK_HOURS, BASE_RENT, DWELLINGS, SHADOW_N, SHADOW_SEED_MONEY,
  MEALS_PER_DAY, WATER_PER_DAY, CONSTRUCTION_SEED_CASH,
  CONSTRUCTION_WAGE, CONSTRUCTION_FOUNDERS, BUILD_LOTS, GROCERY_BASKET,
  ENTRY_SHORT_EMA, ENTRY_MIN_MARGIN, ENTRY_FAT_MARGIN, ENTRY_HAZARD, ENTRY_COOLDOWN_H, ENTRY_WARMUP_H,
  ENTRY_MIN_WEALTH, ENTRY_EQUITY_FRAC, ENTRY_EQUITY_CAP, ENTRY_MIN_EQUITY,
  DIV_K, SECTOR_FIRM_CAP, SECTOR_TEMPLATES, FIRM_NAMES,
  SOFT_PER_FIRM, SOFT_EXTERNAL,
} from './config';
import { clamp, mulberry32, type RNG } from '../core/util/num';

const CONSUMER_SECTORS: Sector[] = ['food', 'groceries', 'utilities', 'retail'];

export interface EconAgentSpec { id: AgentId; name: string; isMara?: boolean }

export class EconomySim {
  private readonly rng: RNG;
  private readonly wallets = new Map<AgentId, Wallet>();
  private readonly order: AgentId[] = [];              // roster order for the snapshot
  private readonly names = new Map<AgentId, string>();
  private maraId: AgentId | null = null;

  private readonly businesses: Business[] = [];
  private readonly bizById = new Map<BusinessId, Business>();
  private readonly bySector = new Map<Sector, Business[]>();
  private readonly goods = new Map<Sector, GoodsMarket>();
  private readonly housing: Housing;
  private readonly labor = new LaborMarket();
  private readonly shadow: ShadowPop;
  private readonly monetary: MonetarySystem;
  private readonly construction: Construction;
  private readonly supermarket = new Supermarket();
  private readonly physio: PhysioField;
  // extra goods-sector capacity delivered by completed commercial buildings.
  private readonly extraCap: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0 };

  private macro: MacroAggregates;
  private acc = 0;                 // econ-tick accumulator (sim-hours)
  private lastClock = 0;
  private cpiPrev = 1;
  private gdpEMA = 0;
  private gdpFast = 0;             // fast GDP EMA — the boom numerator (the raw
                                   // tick series now carries Metzler production
                                   // oscillation; unsmoothed it aliases into the
                                   // weekly Phillips sample and ratchets rates)
  private bankruptcies = 0;
  // cached readout scalars for the snapshot (recomputed each econ tick)
  private laborForce = 0; private employed = 0; private meanWageV = 0;
  private skillCache = new Map<AgentId, number>();
  // ---- phase 4 state --------------------------------------------------------
  private readonly history = new EconHistory();
  private readonly credit: ConsumerCredit;       // shadow households' bank hookup
  private readonly entrantCfg = new Map<BusinessId, BusinessConfig>(); // for persistence
  private readonly owners = new Set<AgentId>();  // households that own a firm
  private readonly shortEMA: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0 };
  private firmBirths = 0;
  private firmDeaths = 0;
  private lastEntryAt = -1e9;
  private entrantSeq = 0;
  private prevPolicyAtEvent = -1;                // last policy rate an event was logged at
  private boomRegime = 0;                        // -1 bust / 0 normal / +1 boom (event edges)
  private wealthScratch: number[] = [];          // reused for gini/percentiles
  private wealthPct = { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };

  constructor(agents: EconAgentSpec[], opts: { seed?: number; clock?: number } = {}) {
    const clock = opts.clock ?? 0;
    const seed = (opts.seed ?? 7) >>> 0;
    this.rng = mulberry32((seed ^ 0x5eed5eed) >>> 0);
    this.lastClock = clock;

    for (const a of agents) {
      this.order.push(a.id);
      this.names.set(a.id, a.name);
      if (a.isMara) this.maraId = a.id;
      this.wallets.set(a.id, createWallet(a.id, clock, { rent: BASE_RENT }));
    }

    for (const cfg of BUSINESSES) {
      const b = new Business(cfg, clock);
      this.businesses.push(b);
      this.bizById.set(b.id, b);
      const arr = this.bySector.get(b.sector);
      if (arr) arr.push(b); else this.bySector.set(b.sector, [b]);
      for (const fid of cfg.founderIds) {
        const w = this.wallets.get(fid);
        if (w) { hire(w, b.id, cfg.baseWage); b.addWorker(fid); }
      }
    }
    for (const s of SECTORS) this.goods.set(s, new GoodsMarket(s, this.basePriceFor(s)));
    this.housing = new Housing(DWELLINGS, BASE_RENT);
    this.shadow = new ShadowPop(SHADOW_N, (seed ^ 0x5ad0) >>> 0, clock);
    // banking + the construction firm (its 5 Tier-A founders start on the crew).
    // the causal monetary system (a Fed + two commercial banks). Seed its broad
    // money to the economy's starting cash so the bank balance sheets are sized right.
    let money0 = CONSTRUCTION_SEED_CASH + SHADOW_N * SHADOW_SEED_MONEY;
    for (const w of this.wallets.values()) money0 += w.money;
    for (const cfg of BUSINESSES) money0 += cfg.seedCash;
    this.monetary = new MonetarySystem({ seed, privateMoney: money0 });
    // construction finances its projects through the banking system (Financier).
    this.construction = new Construction(BUILD_LOTS, this.monetary, { seedCash: CONSTRUCTION_SEED_CASH, wage: CONSTRUCTION_WAGE });
    for (const fid of CONSTRUCTION_FOUNDERS) {
      const w = this.wallets.get(fid);
      if (w) { hire(w, this.construction.id, CONSTRUCTION_WAGE); this.construction.addWorker(fid); }
    }
    // probabilistic physiological drives for the shadow population (shopping cadence).
    this.physio = new PhysioField(SHADOW_N, (seed ^ 0x9110) >>> 0);
    this.macro = this.freshMacro(clock);
    // households' consumer-credit hookup: every draw/repay/default goes through
    // the causal monetary system so money stays conserved.
    this.credit = {
      borrow: (id, amt) => this.monetary.borrow(id, amt),
      repay: (id, amt) => this.monetary.repay(id, amt),
      writeOff: (id) => this.monetary.writeOff(id),
    };
    this.prevPolicyAtEvent = this.monetary.policyRate;
  }

  // ===================== public API ========================================
  walletOf(id: AgentId): Wallet | undefined { return this.wallets.get(id); }
  get macroState(): MacroAggregates { return this.macro; }

  /** mirror Mara's legacy ledger into her wallet (money/food) so she reads uniformly
   *  and counts in the economy without being double-charged. Cheap; call each frame. */
  mirrorMara(money: number, foodStock: number): void {
    if (!this.maraId) return;
    const w = this.wallets.get(this.maraId);
    if (!w) return;
    w.money = money; w.foodStock = foodStock; // income/rent stay in her legacy ledger
  }

  /** advance the economy. Accumulates dt and fires a discrete econ tick each
   *  ECON_TICK_HOURS — keeping the O(N) shadow sweep off the render frame. */
  step(ctx: EconStepCtx): void {
    this.acc += ctx.dtHours;
    if (this.acc < ECON_TICK_HOURS) return;
    const dt = this.acc; this.acc = 0;
    this.econTick(dt, ctx);
  }

  // ===================== the econ tick =====================================
  private econTick(dt: number, ctx: EconStepCtx): void {
    const clock = ctx.clock;
    this.lastClock = clock;
    const prices = this.sectorPrices();
    const demand: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0 };

    // --- Tier-A (the 17 non-Mara full-res agents): wages, cost-of-living, rent, skill
    for (const inp of ctx.agents) {
      const w = this.wallets.get(inp.id);
      if (!w || inp.id === this.maraId) continue;   // Mara handled by her legacy ledger

      // income: employed AND at work. Construction crew work off-site (no rendered
      // venue) so they earn full-time whenever employed by the construction firm.
      const constr = w.employer === this.construction.id;
      if (w.employer && w.status === 'employed' && (inp.atWork || constr)) {
        payWage(w, (constr ? 1 : (inp.workHours || 0)) * dt);   // personal income ledger
      } else if (!w.employer) {
        setTraining(w, true);                        // unemployed → upskill while searching
      }

      // cost of living at CURRENT market prices (this is "spend money on food/water")
      const foodUnits = inp.hunger * MEALS_PER_DAY * (dt / 24) + 0.03 * dt;
      demand.food += buy(w, foodUnits, prices.food);
      const waterUnits = inp.thirst * WATER_PER_DAY * (dt / 24) + 0.06 * dt;
      demand.utilities += buy(w, waterUnits, prices.utilities);
      if (w.status === 'employed') demand.retail += buy(w, 0.04 * dt, prices.retail); // small discretionary

      // rent → possible eviction → homelessness; recovery re-houses
      chargeRent(w, clock);
      if (evict(w)) this.pushEvent(clock, 'evict', inp.id, w.employer ?? undefined, `${inp.name} evicted — now homeless`);
      else if (w.homeless && w.money > w.rent * 2) rehouse(w, clock, this.housing.rent);

      growSkill(w, dt, inp.conscientious, w.status === 'training');
    }

    // --- Tier-C shadow population: earn/consume/rent as one O(N) sweep, now with
    // a live consumer-credit line into the banking system. Groceries are handled
    // separately (physiological shopping trips → the supermarket), so fold in
    // every sector EXCEPT groceries here.
    this.shadow.step({ dtHours: dt, clock, rng: this.rng }, this.macro, prices, this.housing.rent, this.credit);
    if (this.shadow.defaultsThisTick > 0) {
      this.history.event(clock, 'default',
        `${this.shadow.defaultsThisTick} household default${this.shadow.defaultsThisTick > 1 ? 's' : ''}`,
        this.shadow.defaultsThisTick);
    }
    const sd = this.shadow.demand();
    for (const s of SECTORS) { if (s !== 'groceries') demand[s] += sd[s] ?? 0; }
    // B2B software demand is ENDOGENOUS: every firm alive needs tooling, plus an
    // out-of-town client base; the whole thing rides the cycle AND is price-
    // elastic (dear software gets dropped) — without the elasticity a supply
    // shortfall rides the price to its clamp and never comes back.
    const firmsAlive = this.businesses.length + 2;   // + construction + the supermarket
    const softElast = clamp(Math.pow(SECTOR_TEMPLATES.software.basePrice / Math.max(prices.software, 1e-6), 0.8), 0.2, 2.5);
    demand.software += (SOFT_PER_FIRM * firmsAlive + SOFT_EXTERNAL) * (1 + 0.3 * this.macro.boom) * softElast * dt;

    // --- physiological SHOPPING: hunger drives DISCRETE grocery trips (physio.ts).
    // Each trip is an appetite-scaled basket that depletes the supermarket's shelves,
    // so grocery demand + purchase FREQUENCY emerge from the ODE, not a flat rate.
    this.physio.step(dt, this.rng);
    let trips = 0, basket = 0;
    const shN = this.shadow.count();
    for (let i = 0; i < shN; i++) {
      if (this.physio.wantsFood(i)) { trips++; basket += GROCERY_BASKET * this.physio.appetite(i); this.physio.eat(i); }
    }
    // full-res agents shop for groceries too when hungry (planning + physiology)
    for (const inp of ctx.agents) { if (inp.hunger > 0.6) { trips++; basket += GROCERY_BASKET * 0.6; } }
    demand.groceries += basket;

    // --- goods markets clear. Firms now PLAN production (adaptive expectation +
    // inventory-gap correction, COGS paid on what they make, unsold storables
    // shelved) instead of dumping full capacity — the Metzler accelerator.
    // Everything is in UNITS-THIS-TICK: consumption demand is already dt-scaled, so
    // per-hour rates are multiplied by dt too — otherwise prices would depend on the
    // frame's dt instead of the real supply/demand balance.
    let gdp = 0;
    this.supermarket.restockTick(dt);   // shelves replenish before the day's shopping
    for (const s of SECTORS) {
      const mkt = this.goods.get(s)!;
      const firms = this.bySector.get(s) ?? [];
      let offer = this.extraCap[s] * dt;             // completed-building capacity pad
      let capHour = 0;
      for (const b of firms) { offer += b.produce(dt); capHour += b.capacity(); }
      // groceries are supplied by the supermarket straight off the shelves: supply
      // meets demand (stable price) UNLESS the shelves run low (a stockout lifts the
      // price), which is the realistic scarcity signal.
      const supply = s === 'groceries' ? Math.min(demand[s], this.supermarket.available()) : offer;
      const { price, sold } = mkt.clear(demand[s], supply);
      gdp += sold * price;
      // sales split pro-rata by what each firm OFFERED; the demand each firm gets
      // to SEE (for its expectation) splits by capacity, so under-producers still
      // learn the demand really out there.
      for (const b of firms) {
        const offShare = offer > 1e-9 ? b.lastOffer / offer : 1 / firms.length;
        const capShare = capHour > 1e-9 ? b.capacity() / capHour : 1 / firms.length;
        b.sellAllocated(sold * offShare, price, demand[s] * capShare, dt);
      }
      if (s === 'groceries') { this.supermarket.sell(sold, price); this.supermarket.recordTrips(trips); }
    }

    // --- firms: full payroll + rent, then decide headcount/wage (the lending
    // rate is now a real headwind — dear money raises the hiring bar), then settle.
    for (const b of this.businesses) {
      b.bookPayroll(b.headcount() * b.wage * dt);
      b.chargeRent(clock);
      b.decide(this.macro, this.monetary.loanRate(b.id));
      const was = b.bankrupt;
      b.settle(dt);
      if (b.bankrupt && !was) {
        this.bankruptcies++;
        this.pushEvent(clock, 'bankrupt', undefined, b.id, `${b.name} went bankrupt`);
        this.history.event(clock, 'bankrupt', `${b.name} bankrupt`, this.monetary.loanBalance(b.id));
      }
      // owner-run firms pay DIVIDENDS when flush: capital income flows back to a
      // household — the channel through which wealth concentrates (or doesn't).
      if (b.ownerId && !b.bankrupt && b.cash > 1.2 * b.seedCash) {
        const div = (b.cash - 1.2 * b.seedCash) * Math.min(1, DIV_K * dt);
        if (div > 0.01) { b.addCash(-div); this.shadow.addMoney(b.ownerId, div); }
      }
    }

    // --- true EXIT: a bankrupt non-anchor firm dissolves — workers on the street,
    // its loans written off against its bank's capital (the financial accelerator).
    // Anchor firms (the counter, the office, water & power) are town infrastructure:
    // they RESTRUCTURE instead — debt written off (the bank still eats it), a lean
    // outside equity injection, and a demand relearn from scratch.
    for (let i = this.businesses.length - 1; i >= 0; i--) {
      const b = this.businesses[i];
      if (!b.bankrupt) continue;
      if (!b.anchor) { this.exitFirm(b, clock); continue; }
      const owed = this.monetary.loanBalance(b.id);
      if (b.restructure(clock)) {
        if (owed > 0) this.monetary.writeOff(b.id);
        this.pushEvent(clock, 'found', undefined, b.id, `${b.name} restructured — debt written off`);
        this.history.event(clock, 'bankrupt', `${b.name} restructured`, owed);
      }
    }

    // --- ENTRY: a persistent shortage (or fat markup) plus a wealthy household
    // plus available bank credit = a new firm. Schumpeter's revolving door.
    this.maybeFoundFirm(clock, dt);

    // --- construction: watch demand, finance a project, advance it; completed
    // buildings feed the economy (housing → dwellings; commercial → sector capacity).
    const cctx: ConstructionCtx = {
      clock, dt, rng: this.rng, macro: this.macro,
      housingVacancy: this.housing.view().vacancyRate,
      sectorShortage: (s) => this.goods.get(s)!.view().shortage,
    };
    const built = this.construction.step(cctx);
    if (built.dwellingsAdded > 0) this.housing.addUnits(built.dwellingsAdded);
    for (const s of SECTORS) this.extraCap[s] += built.capacityAdded[s];
    for (const b of built.completed) {
      this.pushEvent(clock, 'found', undefined, this.construction.id,
        `Ironline finished a ${b.kind === 'housing' ? `${b.dwellings}-home block` : `${b.sector} unit`}`);
    }

    // --- labour market: match vacancies ↔ the unemployed pool; apply hires/fires
    this.rebuildSkillCache(ctx);
    const plan = this.labor.plan(this.firmDemands(), this.candidates(ctx), clock, this.rng);
    this.applyPlan(plan);

    // --- housing occupancy → rent adjustment
    const housedShadow = this.shadow.count() - this.shadow.homelessCount();
    let housedA = 0; for (const w of this.wallets.values()) if (!w.homeless) housedA++;
    this.housing.step(housedA + housedShadow);

    // --- recompute the macro aggregates (emergent top line). GDP is normalized to
    // a per-hour RATE (gdp/dt) so the readout + business-cycle signal don't jump
    // around with the frame's dt.
    this.macro = this.computeMacro(clock, dt > 1e-6 ? gdp / dt : gdp);

    // --- the causal MONETARY layer: firm credit lines, loan interest, the Fed +
    // commercial-bank tick, and the price-level overlay that makes money growth show
    // up as inflation (which the Fed then reacts to via the Taylor rule).
    this.stepMonetary(dt, clock, dt > 1e-6 ? gdp / dt : gdp);

    // --- the Observatory's memory: one sample per econ tick, t0 → now.
    this.recordHistory(clock);
  }

  private stepMonetary(dt: number, clock: number, gdpRate: number): void {
    const goodsCpi = this.macro.cpi;   // tâtonnement-only CPI (pre price-level overlay)
    // 1) working-capital credit lines: every firm draws when cash is low (a bank
    //    loan CREATES a deposit = broad money) and repays when flush (destroys it).
    //    The line is CAPPED at 1.2× the firm's equity base — a firm financing
    //    structural losses exhausts it, bleeds to ruin, and actually dies,
    //    instead of zombie-pumping new money forever.
    for (const b of this.businesses) {
      const floor = 0.2 * b.seedCash, target = 0.45 * b.seedCash, cushion = 0.6 * b.seedCash;
      if (b.cash < floor) {
        const room = 1.2 * b.seedCash - this.monetary.loanBalance(b.id);
        if (room > 1) b.addCash(this.monetary.borrow(b.id, Math.min(target - b.cash, room)));
      } else if (b.cash > cushion) {
        const owed = this.monetary.loanBalance(b.id);
        if (owed > 0) b.addCash(-this.monetary.repay(b.id, Math.min((b.cash - cushion) * 0.5, owed)));
      }
    }
    // 2) loan interest owed this tick → debit the borrower's real cash (a transfer
    //    into bank equity), routed to the lending bank. Consumer loans included.
    const perBank = new Map<string, number>();
    for (const { id, amt } of this.monetary.interestDue(dt)) {
      let paid = 0;
      if (id === this.construction.id) paid = this.construction.debit(amt);
      else {
        const b = this.bizById.get(id);
        if (b) { const d = Math.min(amt, Math.max(0, b.cash)); b.addCash(-d); paid = d; }
        else paid = this.shadow.debitCash(id, amt);          // household borrowers
      }
      if (paid > 0) { const bk = this.monetary.bankIdFor(id); perBank.set(bk, (perBank.get(bk) ?? 0) + paid); }
    }
    // 3) DEPOSIT INTEREST: banks pay interest on their actual deposit books
    //    (equity → deposits: creates money, tracked in the broad identity) and
    //    the total is distributed to savers pro-rata by positive balances —
    //    savings now yield, so the rate cycle reaches households on both sides.
    const depInt = this.monetary.payDepositInterest(dt);
    if (depInt > 0) {
      let saverBase = this.shadow.positiveMoneySum();
      for (const [id, w] of this.wallets) { if (id !== this.maraId && w.money > 0) saverBase += w.money; }
      if (saverBase > 1) {
        const factor = depInt / saverBase;
        this.shadow.scaleSavings(factor);
        for (const [id, w] of this.wallets) { if (id !== this.maraId && w.money > 0) w.money += w.money * factor; }
      }
    }
    // 4) broad money = the money the public actually holds → run the banking tick.
    let priv = 0;
    for (const w of this.wallets.values()) priv += w.money;
    for (const b of this.businesses) priv += b.cash;
    priv += this.construction.cashOnHand;
    const sv = this.shadow.view();
    priv += sv.meanMoney * sv.n;
    this.monetary.step({
      dtHours: dt, clock, outputGap: this.macro.boom, unemployment: this.macro.unemployment,
      privateMoney: priv, gdp: gdpRate,
      realGrowth: clamp(0.01 + 0.04 * this.macro.boom, -0.06, 0.08),   // cycle-derived, not a constant
      goodsCpi,
    }, perBank);
    // 5) the monetary price level lifts reported CPI (money growth → inflation).
    this.macro.cpi *= this.monetary.priceLevelFactor;
    // 6) notable-event edges: policy moves ≥ 25bp and boom/bust regime flips.
    const pol = this.monetary.policyRate;
    if (Math.abs(pol - this.prevPolicyAtEvent) >= 0.0025) {
      const dir = pol > this.prevPolicyAtEvent ? 'hike' : 'cut';
      this.history.event(clock, 'policy', `Fed ${dir}s to ${(pol * 100).toFixed(1)}%`, pol - this.prevPolicyAtEvent);
      this.prevPolicyAtEvent = pol;
    }
    const regime = this.macro.boom > 0.35 ? 1 : this.macro.boom < -0.35 ? -1 : 0;
    if (regime !== this.boomRegime && regime !== 0) {
      this.history.event(clock, regime > 0 ? 'boom' : 'bust', regime > 0 ? 'expansion runs hot' : 'recession bites', this.macro.boom);
    }
    this.boomRegime = regime;
  }

  // ===================== history ============================================
  /** one Observatory sample per econ tick — everything the strips chart. */
  private recordHistory(clock: number): void {
    const m = this.macro;
    const mv = this.monetary.view();
    const hv = this.housing.view();
    const sv = this.shadow.view();
    let bankCap = 0, capRatioMin = 10;
    for (const b of mv.banks) { bankCap += b.capital; capRatioMin = Math.min(capRatioMin, b.capitalRatio); }
    let invTotal = 0;
    for (const b of this.businesses) invTotal += b.view().inventory;
    const s: Partial<Record<HistField, number>> = {
      t: clock,
      cpi: m.cpi, goodsCpi: m.cpi / Math.max(this.monetary.priceLevelFactor, 1e-9),
      piAnnual: this.monetary.inflationAnnual,
      unemployment: m.unemployment, gdp: m.gdp, boom: m.boom,
      meanWage: m.meanWage, homeless: m.homelessCount, gini: m.gini,
      policyRate: mv.fed.policyRate, lendRate: mv.avgLendingRate,
      baseMoney: mv.baseMoney, broadMoney: mv.broadMoney,
      creditCreated: mv.creditCreated, creditRepaid: mv.creditRepaid,
      writeOffs: mv.writeOffsTick, depositInterest: mv.depositInterest,
      bankCapital: bankCap, bankCapRatio: capRatioMin > 9 ? 1 : capRatioMin,
      consumerDebt: sv.consumerDebt, defaults: sv.defaults,
      firmsAlive: m.firmsAlive, firmBirths: m.firmBirths, firmDeaths: m.firmDeaths,
      vacancies: this.labor.vacancies, employed: this.employed, laborForce: this.laborForce,
      rent: hv.rent, housingVacancy: hv.vacancyRate, dwellings: hv.units,
      inventory: invTotal, smFill: this.supermarket.view().fillLevel,
      wealthP10: this.wealthPct.p10, wealthP25: this.wealthPct.p25,
      wealthP50: this.wealthPct.p50, wealthP75: this.wealthPct.p75, wealthP90: this.wealthPct.p90,
    };
    for (const mk of this.goods.values()) {
      const v = mk.view();
      const key = mk.sector.charAt(0).toUpperCase() + mk.sector.slice(1);
      (s as Record<string, number>)['price' + key] = v.price;
      (s as Record<string, number>)['short' + key] = v.shortage;
    }
    this.history.record(s);
  }

  // ===================== labour helpers ====================================
  private rebuildSkillCache(ctx: EconStepCtx): void {
    this.skillCache.clear();
    for (const [id, w] of this.wallets) this.skillCache.set(id, w.skill);
    for (const c of this.shadow.candidates()) this.skillCache.set(c.id, c.skill);
    void ctx;
  }
  private skillOf(id: AgentId): number { return this.skillCache.get(id) ?? 0.5; }

  private firmDemands(): FirmDemand[] {
    const list: FirmDemand[] = this.businesses.map((b) => ({
      id: b.id, name: b.name, sector: b.sector, wage: b.wage,
      headcount: b.headcount(), desired: b.desiredHeadcount,
      solvent: !b.bankrupt && b.health > 0.05,
      minSkill: b.minSkillBar(), workers: [...b.workers()],
      skillOf: (id: AgentId) => this.skillOf(id),
    }));
    // the construction firm is always hiring toward a bigger crew (faster builds).
    const c = this.construction;
    list.push({
      id: c.id, name: c.name, sector: 'food' /* not a goods firm; unused in matching */,
      wage: c.wage, headcount: c.headcount(), desired: 6,   // a steady crew of ~6 (hires 1 past the 5 founders)
      solvent: c.cashOnHand > -3000, minSkill: 0.05, workers: [...c.workerIds()],
      skillOf: (id: AgentId) => this.skillOf(id),
    });
    return list;
  }

  private candidates(ctx: EconStepCtx): LaborCandidate[] {
    const out: LaborCandidate[] = [];
    for (const inp of ctx.agents) {
      const w = this.wallets.get(inp.id);
      if (!w || inp.id === this.maraId) continue;
      // Tier-A agents only enter the pool when unemployed: their workplace is a
      // social identity the town renders, so they are never silently poached.
      out.push({ id: w.id, name: inp.name, skill: w.skill, tierA: true, employer: w.employer, seeking: !w.employer, wage: w.wage, homeless: w.homeless });
    }
    for (const c of this.shadow.candidates()) out.push(c);
    return out;
  }

  private applyPlan(plan: { hires: { agentId: AgentId; businessId: BusinessId; wage: number; prevEmployer?: BusinessId }[]; fires: { agentId: AgentId; businessId: BusinessId }[] }): void {
    for (const f of plan.fires) {
      if (f.agentId === this.maraId) continue;   // the protagonist is never laid off
      if (f.businessId === this.construction.id) this.construction.removeWorker(f.agentId);
      else this.bizById.get(f.businessId)?.removeWorker(f.agentId);
      const w = this.wallets.get(f.agentId);
      if (w) { fire(w); setTraining(w, true); } else this.shadow.applyFire(f.agentId);
    }
    for (const h of plan.hires) {
      // a poach: the worker quits their old firm first (vacancy chains follow —
      // the old firm now sits below its desired headcount and posts a vacancy).
      if (h.prevEmployer) {
        if (h.prevEmployer === this.construction.id) this.construction.removeWorker(h.agentId);
        else this.bizById.get(h.prevEmployer)?.removeWorker(h.agentId);
      }
      if (h.businessId === this.construction.id) this.construction.addWorker(h.agentId);
      else { const b = this.bizById.get(h.businessId); if (!b) continue; b.addWorker(h.agentId); }
      const w = this.wallets.get(h.agentId);
      if (w) hire(w, h.businessId, h.wage); else this.shadow.applyHire(h.agentId, h.businessId, h.wage);
    }
  }

  // ===================== firm demography (entry/exit) ======================
  /** dissolve a bankrupt firm: everyone laid off, loans written off against the
   *  bank's capital, residual cash liquidated to the owner. */
  private exitFirm(b: Business, clock: number): void {
    for (const id of [...b.workers()]) {
      b.removeWorker(id);
      const w = this.wallets.get(id);
      if (w) { fire(w); setTraining(w, true); } else this.shadow.applyFire(id);
    }
    const loss = this.monetary.writeOff(b.id);
    if (b.ownerId) {
      if (b.cash > 0) this.shadow.addMoney(b.ownerId, b.cash);
      this.owners.delete(b.ownerId);
    }
    const i = this.businesses.indexOf(b);
    if (i >= 0) this.businesses.splice(i, 1);
    this.bizById.delete(b.id);
    const arr = this.bySector.get(b.sector);
    if (arr) { const k = arr.indexOf(b); if (k >= 0) arr.splice(k, 1); }
    this.entrantCfg.delete(b.id);
    this.firmDeaths++;
    this.pushEvent(clock, 'bankrupt', undefined, undefined, `${b.name} dissolved — ${loss > 0 ? `$${loss.toFixed(0)} written off` : 'doors closed'}`);
  }

  /** a persistent sector shortage/markup + a rich household + willing bank ⇒ entry. */
  private maybeFoundFirm(clock: number, dt: number): void {
    // slow shortage EMAs are the entry signal (spikes shouldn't spawn firms).
    const lam = 1 - Math.pow(0.97, dt);
    for (const s of SECTORS) {
      const v = this.goods.get(s)!.view();
      this.shortEMA[s] += lam * (v.shortage - this.shortEMA[s]);
    }
    if (clock < ENTRY_WARMUP_H) return;               // ignore the t0 transient
    if (clock - this.lastEntryAt < ENTRY_COOLDOWN_H) return;
    if (this.rng() >= ENTRY_HAZARD * dt) return;

    // pick the most tempting sector with room under its cap. Two signals, both
    // margin-aware (nobody founds a firm to sell below cost into a glut):
    //  • a persistent SHORTAGE while the price clears a modest markup, or
    //  • a FAT MARGIN on its own — an incumbent milking price ≫ cost at full
    //    capacity is the textbook invitation to compete.
    let sector: Sector | null = null;
    let bestSignal = 0;
    for (const s of SECTORS) {
      const cap = SECTOR_FIRM_CAP[s];
      if ((this.bySector.get(s)?.length ?? 0) >= cap || cap <= 0) continue;
      const v = this.goods.get(s)!.view();
      const margin = v.price / Math.max(SECTOR_TEMPLATES[s].unitCost, 1e-6);
      const shortSignal = margin >= ENTRY_MIN_MARGIN ? this.shortEMA[s] / ENTRY_SHORT_EMA : 0;
      const signal = Math.max(shortSignal, margin / ENTRY_FAT_MARGIN);
      if (signal >= 1 && signal > bestSignal) { bestSignal = signal; sector = s; }
    }
    if (!sector) return;

    const founder = this.shadow.richest(ENTRY_MIN_WEALTH, this.owners);
    if (!founder) return;
    const equity = Math.min(founder.money * ENTRY_EQUITY_FRAC, ENTRY_EQUITY_CAP);
    if (equity < ENTRY_MIN_EQUITY) return;

    const id: BusinessId = 'biz-n' + (this.entrantSeq++).toString(36);
    // a bank loan tops up the equity — in a credit crunch (thin bank capital)
    // this is rationed to zero and the venture launches lean or not at all.
    const lent = this.monetary.borrow(id, equity * 1.2);
    const seed = equity + lent;
    this.shadow.debitCash(founder.id, equity);

    const t = SECTOR_TEMPLATES[sector];
    const names = FIRM_NAMES[sector];
    const nameIdx = this.firmBirths % names.length;
    const gen = Math.floor(this.firmBirths / names.length);
    const cfg: BusinessConfig = {
      id,
      name: names[nameIdx] + (gen > 0 ? ' ' + 'II III IV V VI'.split(' ')[Math.min(gen - 1, 4)] : ''),
      sector,
      seedCash: seed,
      basePrice: t.basePrice,
      unitCost: t.unitCost * (0.85 + 0.3 * this.rng()),          // heterogeneous costs…
      capacityPerWorker: t.capacityPerWorker * (0.75 + 0.5 * this.rng()), // …and productivity
      baseWage: t.baseWage * (0.9 + 0.2 * this.rng()),
      commercialRent: t.commercialRent,
      founderIds: [],
      maxHeadcount: 2 + Math.floor(this.rng() * 3),
      ownerId: founder.id,
      adaptRate: 0.1 + 0.4 * this.rng(),
    };
    const b = new Business(cfg, clock);
    this.registerBusiness(b, cfg);
    this.owners.add(founder.id);
    this.shadow.applyHire(founder.id, id, cfg.baseWage);
    b.addWorker(founder.id);
    this.firmBirths++;
    this.lastEntryAt = clock;
    this.pushEvent(clock, 'found', founder.id, id, `${cfg.name} opens (${sector})`);
    this.history.event(clock, 'found', `${cfg.name} opens`, seed);
  }

  private registerBusiness(b: Business, cfg: BusinessConfig): void {
    this.businesses.push(b);
    this.bizById.set(b.id, b);
    const arr = this.bySector.get(b.sector);
    if (arr) arr.push(b); else this.bySector.set(b.sector, [b]);
    this.entrantCfg.set(b.id, cfg);
  }

  // ===================== macro ==============================================
  private computeMacro(clock: number, gdp: number): MacroAggregates {
    let cpi = 0;
    for (const s of CONSUMER_SECTORS) cpi += 1 + this.goods.get(s)!.view().inflation;
    cpi /= CONSUMER_SECTORS.length;
    const inflation = cpi - this.cpiPrev; this.cpiPrev = cpi;

    // labour force + employment across Tier-A (non-Mara) + shadow
    let aForce = 0, aEmp = 0, wageSum = 0, wageN = 0, homeless = 0;
    for (const [id, w] of this.wallets) {
      if (id === this.maraId) continue;
      aForce++;
      if (w.employer) { aEmp++; wageSum += w.wage; wageN++; }
      if (w.homeless) homeless++;
    }
    this.laborForce = aForce + this.shadow.laborForce();
    this.employed = aEmp + this.shadow.employedCount();
    homeless += this.shadow.homelessCount();
    this.meanWageV = wageN ? wageSum / wageN : 0;
    const unemployment = this.laborForce > 0 ? clamp(1 - this.employed / this.laborForce, 0, 1) : 0;

    // boom = "activity this ~day vs the ~week baseline". The band matters: the
    // fast EMA (~24h) averages out the 1–2-day Metzler inventory chop, the slow
    // one (~7d) holds the trend, so what registers is the genuine multi-day
    // cycle — not hourly noise aliasing into the Fed's weekly Phillips sample.
    this.gdpFast = this.gdpFast <= 0 ? gdp : this.gdpFast + 0.04 * (gdp - this.gdpFast);
    this.gdpEMA = this.gdpEMA <= 0 ? gdp : this.gdpEMA + 0.006 * (gdp - this.gdpEMA);
    const boom = clamp((this.gdpFast - this.gdpEMA) / (this.gdpEMA + 1) * 2.5, -1, 1);

    // wealth distribution over the WHOLE population (Tier-A + shadow): the gini
    // and percentiles the HUD/history report now see capital income, consumer
    // debt and firm dividends — inequality is a full-economy readout.
    const wealth = this.wealthScratch;
    wealth.length = 0;
    this.shadow.wealthInto(wealth);
    for (const [id, w] of this.wallets) { if (id !== this.maraId) wealth.push(w.money); }
    wealth.sort((a, b) => a - b);
    this.wealthPct = {
      p10: pct(wealth, 0.10), p25: pct(wealth, 0.25), p50: pct(wealth, 0.50),
      p75: pct(wealth, 0.75), p90: pct(wealth, 0.90),
    };

    return {
      clock, cpi, inflation, unemployment, gdp,
      meanWage: this.meanWageV, homelessCount: homeless,
      bankruptcies: this.bankruptcies, gini: giniSorted(wealth), boom,
      firmsAlive: this.businesses.length, firmBirths: this.firmBirths, firmDeaths: this.firmDeaths,
    };
  }

  // ===================== snapshot ===========================================
  snapshot(): EconSnapshot {
    const agents: AgentEconView[] = this.order.map((id) => {
      const w = this.wallets.get(id)!;
      return {
        id, money: w.money, wage: w.wage, status: w.status,
        employerName: w.employer ? this.names.get(w.employer) : undefined,
        homeless: w.homeless, foodStock: w.foodStock, waterStock: w.waterStock,
        rentDueIn: w.rentDueAt - this.lastClock, skill: w.skill,
      };
    });
    const mv = this.monetary.view();
    // legacy summary bank view (for the existing City·Construction·Bank panel line).
    let cap = 0, loans = 0, lc = 0; for (const b of mv.banks) { cap += b.capital; loans += b.loans; lc += b.loanCount; }
    return {
      macro: this.macro,
      businesses: this.businesses.map((b) => b.view()),
      markets: SECTORS.map((s) => this.goods.get(s)!.view()),
      housing: this.housing.view(),
      labor: this.labor.view(this.laborForce, this.employed, this.meanWageV),
      shadow: this.shadow.view(),
      agents,
      bank: { capital: cap, loansOutstanding: lc, balanceOutstanding: loans, totalLent: mv.creditCreated, interestIncome: 0 },
      construction: this.construction.view(),
      supermarket: this.supermarket.view(),
      monetary: mv,
      history: this.history.view(),
    };
  }

  // ===================== internals =========================================
  private sectorPrices(): SectorMap {
    const p: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0 };
    for (const s of SECTORS) p[s] = this.goods.get(s)!.price;
    return p;
  }
  private basePriceFor(s: Sector): number {
    const b = BUSINESSES.find((c) => c.sector === s);
    if (b) return b.basePrice;
    const def: SectorMap = { food: 3.8, groceries: 2.2, software: 230, utilities: 1.2, retail: 3.6 };
    return def[s];   // groceries has no firm — it's supplied by the supermarket
  }
  private freshMacro(clock: number): MacroAggregates {
    return { clock, cpi: 1, inflation: 0, unemployment: 0, gdp: 0, meanWage: 0, homelessCount: 0, bankruptcies: 0, gini: 0, boom: 0,
      firmsAlive: this.businesses.length, firmBirths: 0, firmDeaths: 0 };
  }
  private pushEvent(t: number, kind: LaborEvent['kind'], agentId: AgentId | undefined, businessId: BusinessId | undefined, detail: string): void {
    // route through the labour market's ring buffer so the HUD ticker shows it too.
    this.labor.record({ t, kind, agentId, agentName: agentId ? this.names.get(agentId) : undefined,
      businessId, businessName: businessId ? this.bizById.get(businessId)?.name : undefined, detail });
    // evictions also land in the Observatory's event lane (low priority).
    if (kind === 'evict') this.history.event(t, 'evict', detail);
  }

  // ===================== persistence =======================================
  toJSON(): EconJSON {
    return {
      wallets: [...this.wallets.entries()],
      businesses: this.businesses.map((b) => ({ id: b.id, cfg: this.entrantCfg.get(b.id), j: b.toJSON() })),
      goods: SECTORS.map((s) => ({ s, j: this.goods.get(s)!.toJSON() })),
      housing: this.housing.toJSON(),
      labor: this.labor.toJSON(),
      shadow: this.shadow.toJSON(),
      monetary: this.monetary.toJSON(), construction: this.construction.toJSON(),
      supermarket: this.supermarket.toJSON(), physio: this.physio.toJSON(), extraCap: { ...this.extraCap },
      macro: this.macro, acc: this.acc, cpiPrev: this.cpiPrev, gdpEMA: this.gdpEMA, gdpFast: this.gdpFast,
      bankruptcies: this.bankruptcies, lastClock: this.lastClock, rng: this.rng.save ? this.rng.save() : 0,
      history: this.history.toJSON(),
      demography: {
        births: this.firmBirths, deaths: this.firmDeaths, lastEntryAt: this.lastEntryAt,
        entrantSeq: this.entrantSeq, owners: [...this.owners], shortEMA: { ...this.shortEMA },
      },
    };
  }
  loadJSON(j: EconJSON): void {
    if (!j) return;
    for (const [id, w] of j.wallets) { const cur = this.wallets.get(id); if (cur) Object.assign(cur, w); else this.wallets.set(id, w); }
    // firm demography round-trip: drop firms the save doesn't have (they exited
    // before it was taken), rebuild entrants from their stored configs.
    const savedIds = new Set(j.businesses.map((e) => e.id));
    for (let i = this.businesses.length - 1; i >= 0; i--) {
      const b = this.businesses[i];
      if (savedIds.has(b.id)) continue;
      this.businesses.splice(i, 1);
      this.bizById.delete(b.id);
      const arr = this.bySector.get(b.sector);
      if (arr) { const k = arr.indexOf(b); if (k >= 0) arr.splice(k, 1); }
    }
    for (const { id, cfg, j: bj } of j.businesses) {
      let b = this.bizById.get(id);
      if (!b && cfg) { b = new Business(cfg, this.lastClock); this.registerBusiness(b, cfg); }
      b?.loadJSON(bj);
    }
    for (const { s, j: gj } of j.goods) this.goods.get(s)?.loadJSON(gj);
    this.housing.loadJSON(j.housing);
    this.labor.loadJSON(j.labor);
    this.shadow.loadJSON(j.shadow);
    if (j.monetary) this.monetary.loadJSON(j.monetary);
    if (j.construction) this.construction.loadJSON(j.construction);
    if (j.supermarket) this.supermarket.loadJSON(j.supermarket);
    if (j.physio) this.physio.loadJSON(j.physio);
    if (j.extraCap) for (const s of SECTORS) this.extraCap[s] = j.extraCap[s] ?? 0;
    this.macro = { ...this.freshMacro(j.macro?.clock ?? 0), ...j.macro };
    this.acc = j.acc; this.cpiPrev = j.cpiPrev; this.gdpEMA = j.gdpEMA;
    this.gdpFast = j.gdpFast ?? j.gdpEMA;
    this.bankruptcies = j.bankruptcies; this.lastClock = j.lastClock;
    if (j.history) this.history.loadJSON(j.history);
    if (j.demography) {
      this.firmBirths = j.demography.births; this.firmDeaths = j.demography.deaths;
      this.lastEntryAt = j.demography.lastEntryAt; this.entrantSeq = j.demography.entrantSeq;
      this.owners.clear(); for (const o of j.demography.owners) this.owners.add(o);
      if (j.demography.shortEMA) for (const s of SECTORS) this.shortEMA[s] = j.demography.shortEMA[s] ?? 0;
    }
    this.prevPolicyAtEvent = this.monetary.policyRate;
    if (this.rng.load) this.rng.load(j.rng);
  }
}

export interface EconJSON {
  wallets: [AgentId, Wallet][];
  /** cfg present ⇒ a runtime entrant (rebuilt from cfg on load); absent ⇒ static. */
  businesses: { id: BusinessId; cfg?: BusinessConfig; j: unknown }[];
  goods: { s: Sector; j: unknown }[];
  housing: unknown; labor: unknown; shadow: unknown;
  monetary?: unknown; construction?: unknown; supermarket?: unknown; physio?: unknown; extraCap?: SectorMap;
  macro: MacroAggregates; acc: number; cpiPrev: number; gdpEMA: number; gdpFast?: number;
  bankruptcies: number; lastClock: number; rng: number;
  history?: unknown;
  demography?: { births: number; deaths: number; lastEntryAt: number; entrantSeq: number; owners: AgentId[]; shortEMA: SectorMap };
}

/** percentile from a pre-sorted ascending array (linear interpolation). */
function pct(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const x = p * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[n - 1];
}

/** standard Gini on a pre-sorted ascending array, shifted non-negative. */
function giniSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n < 2) return 0;
  const shift = sorted[0] < 0 ? -sorted[0] : 0;
  let total = 0, idxSum = 0;
  for (let i = 0; i < n; i++) {
    const x = sorted[i] + shift;
    total += x;
    idxSum += (i + 1) * x;
  }
  if (total <= 0) return 0;
  return clamp((2 * idxSum) / (n * total) - (n + 1) / n, 0, 1);
}
