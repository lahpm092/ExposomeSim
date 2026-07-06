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
  AgentId, BusinessId, Sector, Wallet, EconSnapshot, EconStepCtx,
  MacroAggregates, SectorMap, LaborCandidate, FirmDemand, AgentEconView, LaborEvent,
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
import {
  BUSINESSES, ECON_TICK_HOURS, BASE_RENT, DWELLINGS, SHADOW_N, SHADOW_SEED_MONEY,
  MEALS_PER_DAY, WATER_PER_DAY, CONSTRUCTION_SEED_CASH,
  CONSTRUCTION_WAGE, CONSTRUCTION_FOUNDERS, BUILD_LOTS, GROCERY_BASKET,
} from './config';
import { clamp, mulberry32, type RNG } from '../../util/num';

const CONSUMER_SECTORS: Sector[] = ['food', 'groceries', 'utilities', 'retail'];
const SOFTWARE_BASE = 6.2;   // exogenous B2B client demand for software (cycle-driven)

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
  private bankruptcies = 0;
  // cached readout scalars for the snapshot (recomputed each econ tick)
  private laborForce = 0; private employed = 0; private meanWageV = 0;
  private skillCache = new Map<AgentId, number>();

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

    // --- Tier-C shadow population: earn/consume/rent as one O(N) sweep. Groceries
    // are handled separately (physiological shopping trips → the supermarket), so
    // fold in every sector EXCEPT groceries here.
    this.shadow.step({ dtHours: dt, clock, rng: this.rng }, this.macro, prices, this.housing.rent);
    const sd = this.shadow.demand();
    for (const s of SECTORS) { if (s !== 'groceries') demand[s] += sd[s] ?? 0; }
    // exogenous B2B software demand, driven by the business cycle
    demand.software += SOFTWARE_BASE * (1 + 0.5 * this.macro.boom) * dt;

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

    // --- goods markets clear; revenue booked to firms pro-rata by capacity.
    // Everything is in UNITS-THIS-TICK: consumption demand is already dt-scaled, so
    // firm capacity (a per-hour rate) must be multiplied by dt too — otherwise prices
    // would depend on the frame's dt instead of the real supply/demand balance.
    let gdp = 0;
    this.supermarket.restockTick(dt);   // shelves replenish before the day's shopping
    for (const s of SECTORS) {
      const mkt = this.goods.get(s)!;
      const firms = this.bySector.get(s) ?? [];
      const capHour = firms.reduce((sum, b) => sum + b.capacity(), 0);
      // capacity this tick = firm rate + completed-building capacity; groceries also
      // draws on the supermarket's physical shelf stock (so a run can empty shelves).
      let supply = (capHour + this.extraCap[s]) * dt;
      // groceries are supplied by the supermarket straight off the shelves: supply
      // meets demand (stable price) UNLESS the shelves run low (a stockout lifts the
      // price), which is the realistic scarcity signal.
      if (s === 'groceries') supply = Math.min(demand[s], this.supermarket.available());
      const { price, sold } = mkt.clear(demand[s], supply);
      gdp += sold * price;
      const totalCap = capHour || 1;
      for (const b of firms) { b.setPrice(price); b.bookSales(sold * (b.capacity() / totalCap), price); }
      if (s === 'groceries') { this.supermarket.sell(sold, price); this.supermarket.recordTrips(trips); }
    }

    // --- firms: full payroll + rent, then decide headcount/wage, then settle
    for (const b of this.businesses) {
      b.bookPayroll(b.headcount() * b.wage * dt);
      b.chargeRent(clock);
      b.decide(this.macro);
      const was = b.bankrupt;
      b.settle(dt);
      if (b.bankrupt && !was) { this.bankruptcies++; this.pushEvent(clock, 'bankrupt', undefined, b.id, `${b.name} went bankrupt`); }
    }

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
  }

  private stepMonetary(dt: number, clock: number, gdpRate: number): void {
    // 1) working-capital credit lines: every firm draws when cash is low (a bank
    //    loan CREATES a deposit = broad money) and repays when flush (destroys it).
    for (const b of this.businesses) {
      const floor = 0.2 * b.seedCash, target = 0.45 * b.seedCash, cushion = 0.6 * b.seedCash;
      if (b.cash < floor) { b.addCash(this.monetary.borrow(b.id, target - b.cash)); }
      else if (b.cash > cushion) {
        const owed = this.monetary.loanBalance(b.id);
        if (owed > 0) b.addCash(-this.monetary.repay(b.id, Math.min((b.cash - cushion) * 0.5, owed)));
      }
    }
    // 2) loan interest owed this tick → debit the borrower's real cash (a transfer
    //    into bank equity), routed to the lending bank.
    const perBank = new Map<string, number>();
    for (const { id, amt } of this.monetary.interestDue(dt)) {
      let paid = 0;
      if (id === this.construction.id) paid = this.construction.debit(amt);
      else { const b = this.bizById.get(id); if (b) { const d = Math.min(amt, Math.max(0, b.cash)); b.addCash(-d); paid = d; } }
      if (paid > 0) { const bk = this.monetary.bankIdFor(id); perBank.set(bk, (perBank.get(bk) ?? 0) + paid); }
    }
    // 3) broad money = the money the public actually holds → run the banking tick.
    let priv = 0;
    for (const w of this.wallets.values()) priv += w.money;
    for (const b of this.businesses) priv += b.cash;
    priv += this.construction.cashOnHand;
    const sv = this.shadow.view();
    priv += sv.meanMoney * sv.n;
    this.monetary.step({ dtHours: dt, clock, outputGap: this.macro.boom, unemployment: this.macro.unemployment, privateMoney: priv, gdp: gdpRate, realGrowth: 0.02 }, perBank);
    // 4) the monetary price level lifts reported CPI (money growth → inflation).
    this.macro.cpi *= this.monetary.priceLevelFactor;
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
      out.push({ id: w.id, name: inp.name, skill: w.skill, tierA: true, employer: w.employer, seeking: !w.employer });
    }
    for (const c of this.shadow.candidates()) out.push(c);
    return out;
  }

  private applyPlan(plan: { hires: { agentId: AgentId; businessId: BusinessId; wage: number }[]; fires: { agentId: AgentId; businessId: BusinessId }[] }): void {
    for (const f of plan.fires) {
      if (f.agentId === this.maraId) continue;   // the protagonist is never laid off
      if (f.businessId === this.construction.id) this.construction.removeWorker(f.agentId);
      else this.bizById.get(f.businessId)?.removeWorker(f.agentId);
      const w = this.wallets.get(f.agentId);
      if (w) { fire(w); setTraining(w, true); } else this.shadow.applyFire(f.agentId);
    }
    for (const h of plan.hires) {
      if (h.businessId === this.construction.id) this.construction.addWorker(h.agentId);
      else { const b = this.bizById.get(h.businessId); if (!b) continue; b.addWorker(h.agentId); }
      const w = this.wallets.get(h.agentId);
      if (w) hire(w, h.businessId, h.wage); else this.shadow.applyHire(h.agentId, h.businessId, h.wage);
    }
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

    this.gdpEMA = this.gdpEMA <= 0 ? gdp : this.gdpEMA + 0.05 * (gdp - this.gdpEMA);
    const boom = clamp((gdp - this.gdpEMA) / (this.gdpEMA + 1) * 3, -1, 1);

    return {
      clock, cpi, inflation, unemployment, gdp,
      meanWage: this.meanWageV, homelessCount: homeless,
      bankruptcies: this.bankruptcies, gini: this.shadow.view().gini, boom,
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
    return { clock, cpi: 1, inflation: 0, unemployment: 0, gdp: 0, meanWage: 0, homelessCount: 0, bankruptcies: 0, gini: 0, boom: 0 };
  }
  private pushEvent(t: number, kind: LaborEvent['kind'], agentId: AgentId | undefined, businessId: BusinessId | undefined, detail: string): void {
    // route through the labour market's ring buffer so the HUD ticker shows it too.
    this.labor.record({ t, kind, agentId, agentName: agentId ? this.names.get(agentId) : undefined,
      businessId, businessName: businessId ? this.bizById.get(businessId)?.name : undefined, detail });
  }

  // ===================== persistence =======================================
  toJSON(): EconJSON {
    return {
      wallets: [...this.wallets.entries()],
      businesses: this.businesses.map((b) => ({ id: b.id, j: b.toJSON() })),
      goods: SECTORS.map((s) => ({ s, j: this.goods.get(s)!.toJSON() })),
      housing: this.housing.toJSON(),
      labor: this.labor.toJSON(),
      shadow: this.shadow.toJSON(),
      monetary: this.monetary.toJSON(), construction: this.construction.toJSON(),
      supermarket: this.supermarket.toJSON(), physio: this.physio.toJSON(), extraCap: { ...this.extraCap },
      macro: this.macro, acc: this.acc, cpiPrev: this.cpiPrev, gdpEMA: this.gdpEMA,
      bankruptcies: this.bankruptcies, lastClock: this.lastClock, rng: this.rng.save ? this.rng.save() : 0,
    };
  }
  loadJSON(j: EconJSON): void {
    if (!j) return;
    for (const [id, w] of j.wallets) { const cur = this.wallets.get(id); if (cur) Object.assign(cur, w); else this.wallets.set(id, w); }
    for (const { id, j: bj } of j.businesses) this.bizById.get(id)?.loadJSON(bj);
    for (const { s, j: gj } of j.goods) this.goods.get(s)?.loadJSON(gj);
    this.housing.loadJSON(j.housing);
    this.labor.loadJSON(j.labor);
    this.shadow.loadJSON(j.shadow);
    if (j.monetary) this.monetary.loadJSON(j.monetary);
    if (j.construction) this.construction.loadJSON(j.construction);
    if (j.supermarket) this.supermarket.loadJSON(j.supermarket);
    if (j.physio) this.physio.loadJSON(j.physio);
    if (j.extraCap) for (const s of SECTORS) this.extraCap[s] = j.extraCap[s] ?? 0;
    this.macro = j.macro; this.acc = j.acc; this.cpiPrev = j.cpiPrev; this.gdpEMA = j.gdpEMA;
    this.bankruptcies = j.bankruptcies; this.lastClock = j.lastClock;
    if (this.rng.load) this.rng.load(j.rng);
  }
}

export interface EconJSON {
  wallets: [AgentId, Wallet][];
  businesses: { id: BusinessId; j: unknown }[];
  goods: { s: Sector; j: unknown }[];
  housing: unknown; labor: unknown; shadow: unknown;
  monetary?: unknown; construction?: unknown; supermarket?: unknown; physio?: unknown; extraCap?: SectorMap;
  macro: MacroAggregates; acc: number; cpiPrev: number; gdpEMA: number;
  bankruptcies: number; lastClock: number; rng: number;
}
