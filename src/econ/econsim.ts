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
  ConsumerCredit, GoodId, Building, SupermarketView, ConstructionView,
} from './types';
import { SECTORS, GOODS, zeroSectors } from './types';
import { createWallet, payWage, buy, chargeRent, evict, rehouse, growSkill, hire, fire, setTraining } from './wallet';
import { Business } from './business';
import { GoodsMarket, Housing } from './market';
import { WholesaleMarket } from './goods';
import { CommercialRegistry } from './premises';
import { LaborMarket } from './labor';
import { ShadowPop } from './shadowpop';
import { MonetarySystem } from './monetary';
import { Construction, LotPool, unitsFor, type ConstructionCtx } from './construction';
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
  CPI_WEIGHTS, KIND_FOR_SECTOR, RETAIL_ARCHETYPE, RETAIL_SHELF, GOOD_LABELS,
  MAKER_TEMPLATES, MAKER_NAMES, GOOD_MAKER_CAP, GOOD_SECTOR, GOOD_WHOLESALE_BASE,
  WS_ENTRY_MIN_MARGIN, WS_ENTRY_FAT_MARGIN, WS_ENTRY_SHORT_EMA,
  ENTRY_EQUITY_CAP_CHAIN, ENTRY_LOAN_MULT_CHAIN,
  TIERA_DURABLE_TRICKLE, CONSTRUCTION_FIRMS, CONSTRUCTION_CREW_SPLIT,
  SEED_PREMISES, SHOPFRONT_RENT, WORKSHOP_RENT, PENDING_ENTRY_CAP, BOOM_WARMUP_H,
} from './config';
import { clamp, mulberry32, type RNG } from '../core/util/num';

const CONSUMER_SECTORS: Sector[] = ['food', 'groceries', 'utilities', 'retail', 'homegoods', 'apparel'];

/** save schema version: <5 predates the supply chain (phase-5 seeded firms must
 *  survive loading such a save — they are new, not exited). */
const ECON_SAVE_V = 5;
const PHASE5_SEED_IDS = new Set<BusinessId>(['biz-market', 'biz-bakehouse', 'biz-alderplane']);

/** a fresh all-zero per-good map. */
function zeroGoods(): Record<GoodId, number> {
  const m = {} as Record<GoodId, number>;
  for (const g of GOODS) m[g] = 0;
  return m;
}

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
  private readonly wholesale = new Map<GoodId, WholesaleMarket>();
  private readonly premises = new CommercialRegistry();
  private readonly housing: Housing;
  private readonly labor = new LaborMarket();
  private readonly shadow: ShadowPop;
  private readonly monetary: MonetarySystem;
  private readonly lotPool: LotPool;
  private readonly builders: Construction[];   // the two construction firms
  private readonly physio: PhysioField;

  private macro: MacroAggregates;
  private acc = 0;                 // econ-tick accumulator (sim-hours)
  private lastClock = 0;
  private cpiPrev = 1;
  private gdpEMA = 0;
  private prevGdpEMA = 0;          // last tick's slow EMA (measured real growth)
  private boomTrend = 0;           // ~2-week EMA of the raw boom (detrend stage)
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
  private readonly shortEMA: SectorMap = zeroSectors();
  private readonly wsShortEMA: Record<GoodId, number> = zeroGoods();  // maker-entry signal
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
    for (const g of GOODS) this.wholesale.set(g, new WholesaleMarket(g));
    this.housing = new Housing(DWELLINGS, BASE_RENT);
    this.shadow = new ShadowPop(SHADOW_N, (seed ^ 0x5ad0) >>> 0, clock);
    // banking + the TWO construction firms (5 Tier-A founders split 3/2).
    // the causal monetary system (a Fed + two commercial banks). Seed its broad
    // money to the economy's starting cash so the bank balance sheets are sized right.
    let money0 = CONSTRUCTION_FIRMS.length * CONSTRUCTION_SEED_CASH + SHADOW_N * SHADOW_SEED_MONEY;
    for (const w of this.wallets.values()) money0 += w.money;
    for (const cfg of BUSINESSES) money0 += cfg.seedCash;
    this.monetary = new MonetarySystem({ seed, privateMoney: money0 });
    // both builders share ONE lot pool (claims are atomic) and finance their
    // projects through the banking system (Financier), each on its own account.
    this.lotPool = new LotPool(BUILD_LOTS);
    this.builders = CONSTRUCTION_FIRMS.map((f) =>
      new Construction(f.id, f.name, this.lotPool, this.monetary, { seedCash: CONSTRUCTION_SEED_CASH, wage: CONSTRUCTION_WAGE }));
    CONSTRUCTION_FOUNDERS.forEach((fid, i) => {
      const c = this.builders[i < CONSTRUCTION_CREW_SPLIT ? 0 : 1];
      const w = this.wallets.get(fid);
      if (w) { hire(w, c.id, CONSTRUCTION_WAGE); c.addWorker(fid); }
    });
    // the two seeded maker premises: pre-existing workshop buildings on two
    // BUILD_LOTS (owners split across the builders — both earn lease income),
    // already tenanted so the wholesale markets are alive at t0.
    for (const sp of SEED_PREMISES) {
      const lot = BUILD_LOTS.find((l) => l.id === sp.lotId);
      if (!lot) continue;
      const bld: Building = {
        id: sp.buildingId, kind: 'workshop', lotId: lot.id,
        x: lot.x, z: lot.z, w: lot.w, d: lot.d, floors: sp.floors,
        progress: 1, complete: true, cost: 0, dwellings: 0, capacity: 0,
        cumIncome: 0, startedAt: 0, archetype: sp.archetype,
      };
      this.builders[sp.ownerIdx].seedBuilding(bld);
      this.premises.addUnit({
        id: sp.unitId, buildingId: sp.buildingId, lotId: lot.id,
        archetype: sp.archetype, tenantId: sp.tenantId, rent: sp.rent,
        ownerId: this.builders[sp.ownerIdx].id,
      });
      this.bizById.get(sp.tenantId)?.leasePremises(sp.unitId, sp.rent);
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
    const demand: SectorMap = zeroSectors();

    // --- Tier-A (the 17 non-Mara full-res agents): wages, cost-of-living, rent, skill
    for (const inp of ctx.agents) {
      const w = this.wallets.get(inp.id);
      if (!w || inp.id === this.maraId) continue;   // Mara handled by her legacy ledger

      // income: employed AND at work. Construction crews work off-site (no rendered
      // venue) so they earn full-time whenever employed by either builder.
      const constr = w.employer !== null && this.builderById(w.employer) !== undefined;
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
      // durables: Tier-A agents contribute a simple slow replacement trickle.
      demand.homegoods += buy(w, TIERA_DURABLE_TRICKLE * dt, prices.homegoods);
      demand.apparel += buy(w, TIERA_DURABLE_TRICKLE * dt, prices.apparel);

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
    const firmsAlive = this.businesses.length + 2;   // + the two construction firms
    const softElast = clamp(Math.pow(SECTOR_TEMPLATES.software.basePrice / Math.max(prices.software, 1e-6), 0.8), 0.2, 2.5);
    demand.software += (SOFT_PER_FIRM * firmsAlive + SOFT_EXTERNAL) * (1 + 0.3 * this.macro.boom) * softElast * dt;

    // --- physiological SHOPPING: hunger drives DISCRETE grocery trips (physio.ts).
    // Each trip is an appetite-scaled basket that depletes the grocers' shelves,
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

    // =========================================================================
    // THE WHOLESALE PHASE (phase 5): makers produce into their good's market;
    // retailers place restock orders toward target shelf depth; each good
    // clears by tâtonnement under the importer's world-price ceiling. Retailer
    // cash pays a BLENDED unit cost — the local share lands as maker revenue
    // (pro-rata by offer), the import share LEAKS to External exactly like raw
    // COGS. Every order fills (imports are perfectly elastic), so shelves only
    // run dry when a retailer under-orders or runs out of cash.
    // =========================================================================
    const wsOffer = zeroGoods();
    const wsCapHour = zeroGoods();
    const makersByGood = new Map<GoodId, Business[]>();
    for (const b of this.businesses) {
      if (b.kind !== 'maker' || !b.good) continue;
      wsOffer[b.good] += b.produce(dt);
      wsCapHour[b.good] += b.capacity();
      const arr = makersByGood.get(b.good);
      if (arr) arr.push(b); else makersByGood.set(b.good, [b]);
    }
    const wsOrders = zeroGoods();
    const retailOrders: [Business, { good: GoodId; units: number }[]][] = [];
    for (const b of this.businesses) {
      if (b.kind !== 'retail') continue;
      const orders = b.planRestock(dt, (g) => this.wholesale.get(g)!.price);
      if (orders.length) retailOrders.push([b, orders]);
      for (const o of orders) wsOrders[o.good] += o.units;
    }
    const wsUnitCost = zeroGoods();
    for (const g of GOODS) {
      const mkt = this.wholesale.get(g)!;
      const { price, soldLocal, imports, importPrice } = mkt.clear(wsOrders[g], wsOffer[g]);
      const makers = makersByGood.get(g) ?? [];
      for (const m of makers) {
        const offShare = wsOffer[g] > 1e-9 ? m.lastOffer / wsOffer[g] : 1 / makers.length;
        const capShare = wsCapHour[g] > 1e-9 ? m.capacity() / wsCapHour[g] : 1 / makers.length;
        m.sellAllocated(soldLocal * offShare, price, wsOrders[g] * capShare, dt);
      }
      wsUnitCost[g] = wsOrders[g] > 1e-9 ? (soldLocal * price + imports * importPrice) / wsOrders[g] : price;
    }
    for (const [b, orders] of retailOrders) {
      for (const o of orders) b.receiveStock(o.good, o.units, o.units * wsUnitCost[o.good]);
    }

    // --- goods markets clear. Service firms PLAN production (adaptive
    // expectation + inventory-gap correction, COGS paid on what they make,
    // unsold storables shelved) — the Metzler accelerator; RETAIL sectors sell
    // off the shelf: supply meets demand (stable price, with a hair of slack so
    // a well-stocked town discounts gently) UNLESS the shelves or the staff run
    // short — the stockout is the scarcity signal. Everything is in UNITS-THIS-
    // TICK: consumption demand is already dt-scaled, so per-hour rates are
    // multiplied by dt too — otherwise prices would depend on the frame's dt.
    let gdp = 0;
    for (const s of SECTORS) {
      const mkt = this.goods.get(s)!;
      const firms = this.bySector.get(s) ?? [];
      const services: Business[] = [];
      const retailers: Business[] = [];
      for (const b of firms) {
        if (b.kind === 'retail') retailers.push(b);
        else if (b.kind === 'service') services.push(b);
        // makers sell upstream (wholesale) — never into the retail market.
      }
      let offer = 0, capHour = 0;
      for (const b of services) { offer += b.produce(dt); capHour += b.capacity(); }
      const rOffers: number[] = [];
      let shelfSum = 0, shelfStock = 0;
      for (const r of retailers) {
        const o = r.retailOffer(dt);
        rOffers.push(o); shelfSum += o; shelfStock += r.shelfTotal(); capHour += r.capacity();
      }
      // shelf-cover slack: retailers holding DEEP stock discount to move it —
      // the price gets real downward mobility, so a stockout blip can't ratchet
      // it up forever. Cover ≤ 24h ⇒ a bare 2% slack; ≥ 72h ⇒ up to 12%.
      const coverH = demand[s] > 1e-9 ? shelfStock / (demand[s] / Math.max(dt, 1e-9)) : 48;
      const slack = 1.02 + 0.10 * clamp((coverH - 24) / 48, 0, 1);
      const supply = retailers.length > 0
        ? offer + Math.min(shelfSum, Math.max(0, demand[s] * slack - offer))
        : offer;
      // a market with NO seller has no price discovery: freeze the price (the
      // shortage still records and screams for entry — see market.ts).
      const { price, sold } = mkt.clear(demand[s], supply, services.length + retailers.length > 0);
      gdp += sold * price;
      // sales split pro-rata by what each seller OFFERED; the demand each firm
      // gets to SEE (for its expectation) splits by capacity, so under-producers
      // and under-stockers still learn the demand really out there.
      const totalOffer = offer + shelfSum;
      const n = services.length + retailers.length;
      for (const b of services) {
        const offShare = totalOffer > 1e-9 ? b.lastOffer / totalOffer : 1 / n;
        const capShare = capHour > 1e-9 ? b.capacity() / capHour : 1 / n;
        b.sellAllocated(sold * offShare, price, demand[s] * capShare, dt);
      }
      for (let i = 0; i < retailers.length; i++) {
        const r = retailers[i];
        const offShare = totalOffer > 1e-9 ? rOffers[i] / totalOffer : 1 / n;
        const capShare = capHour > 1e-9 ? r.capacity() / capHour : 1 / n;
        r.sellFromShelf(sold * offShare, price, demand[s] * capShare, dt);
        // grocery trips split across grocers by offer share (a second market EARNS its footfall)
        if (s === 'groceries') r.recordTrips(trips * (totalOffer > 1e-9 ? rOffers[i] / totalOffer : 1 / retailers.length));
      }
    }

    // --- firms: full payroll + rent, then decide headcount/wage (the lending
    // rate is now a real headwind — dear money raises the hiring bar), then settle.
    for (const b of this.businesses) {
      b.bookPayroll(b.headcount() * b.wage * dt);
      const rentPaid = b.chargeRent(clock);
      // a LEASED firm's rent is a REAL transfer: tenant cash → the owning
      // construction firm (replacing the generic commercialRent leak).
      if (rentPaid > 0 && b.premisesUnitId) {
        const unit = this.premises.unitById(b.premisesUnitId);
        if (unit) this.builderById(unit.ownerId)?.receiveLease(unit.buildingId, rentPaid);
      }
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
    // plus available bank credit = a new firm. Schumpeter's revolving door —
    // now founding makers + retailers as well as service firms.
    this.maybeFoundFirm(clock, dt);

    // --- PREMISES: entrants in the pending queue lease the cheapest vacant
    // unit (from-home 0.4 capacity ends; the unit + building take their archetype).
    this.stepPremises(clock);

    // --- construction ×2: both firms watch housing vacancy AND the premises
    // pipeline (pending entrants / commercial vacancy), finance projects and
    // advance them. Completions: housing → dwellings; shopfront/workshop →
    // commercial units minted into the registry (owner keeps the building).
    const pendingHead = this.premises.pendingIds
      .map((id) => this.bizById.get(id)).find((b) => !!b);
    const cctx: ConstructionCtx = {
      clock, dt, rng: this.rng, macro: this.macro,
      housingVacancy: this.housing.view().vacancyRate,
      commercial: {
        pending: this.premises.pendingCount(),
        vacantUnits: this.premises.vacantCount(),
        underwayUnits: 0,
        wantKind: pendingHead?.kind === 'maker' ? 'workshop' : 'shopfront',
      },
    };
    for (const c of this.builders) {
      // refresh the town-wide underway count so firm B sees firm A's fresh start
      cctx.commercial.underwayUnits = this.builders.reduce((u, x) => u + x.underwayUnits(), 0);
      const built = c.step(cctx);
      if (built.dwellingsAdded > 0) this.housing.addUnits(built.dwellingsAdded);
      for (const b of built.completed) {
        const nUnits = unitsFor(b.kind);
        for (let i = 0; i < nUnits; i++) {
          this.premises.addUnit({
            buildingId: b.id, lotId: b.lotId,
            rent: b.kind === 'shopfront' ? SHOPFRONT_RENT : WORKSHOP_RENT,
            ownerId: c.id,
          });
        }
        this.pushEvent(clock, 'found', undefined, c.id,
          `${c.name.split(' ')[0]} finished a ${b.kind === 'housing' ? `${b.dwellings}-home block` : `${b.kind} (${nUnits} unit${nUnits > 1 ? 's' : ''})`}`);
      }
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
    this.macro = this.computeMacro(clock, dt > 1e-6 ? gdp / dt : gdp, dt);

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
      const builder = this.builderById(id);
      if (builder) paid = builder.debit(amt);
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
    for (const c of this.builders) priv += c.cashOnHand;
    const sv = this.shadow.view();
    priv += sv.meanMoney * sv.n;
    // realGrowth for the QTM impulse: the MEASURED trend of the slow GDP EMA.
    // Phase 5 is an economy that genuinely EXPANDS (entrants, new sectors, new
    // buildings) — netting real growth out of money growth stops the quantity
    // theory reading expansion credit as pure inflation (which ratcheted the
    // Taylor rule toward its ceiling and froze construction under the hurdles).
    const rg = this.prevGdpEMA > 1 && dt > 1e-9
      ? clamp(((this.gdpEMA - this.prevGdpEMA) / this.prevGdpEMA) * (8760 / dt), -0.06, 0.1)
      : 0.01;
    this.prevGdpEMA = this.gdpEMA;
    this.monetary.step({
      dtHours: dt, clock, outputGap: this.macro.boom, unemployment: this.macro.unemployment,
      privateMoney: priv, gdp: gdpRate,
      realGrowth: rg,
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
    let invTotal = 0, makerCount = 0, retailCount = 0;
    for (const b of this.businesses) {
      invTotal += b.view().inventory;
      if (b.kind === 'maker') makerCount++;
      else if (b.kind === 'retail') retailCount++;
    }
    const sm = this.supermarketView();
    const pv = this.premises.view();
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
      inventory: invTotal, smFill: sm?.fillLevel ?? 0,
      wealthP10: this.wealthPct.p10, wealthP25: this.wealthPct.p25,
      wealthP50: this.wealthPct.p50, wealthP75: this.wealthPct.p75, wealthP90: this.wealthPct.p90,
      // phase 5 — the supply chain
      wholesaleBakery: this.wholesale.get('bakery')!.price,
      wholesaleFurniture: this.wholesale.get('furniture')!.price,
      pendingPremises: pv.pending,
      commercialUnits: pv.units,
      makerCount, retailCount,
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
    // both construction firms always want a SMALL standing crew (steady builds).
    for (const c of this.builders) {
      list.push({
        id: c.id, name: c.name, sector: 'food' /* not a goods firm; unused in matching */,
        wage: c.wage, headcount: c.headcount(), desired: 3,   // ~3 each ⇒ the old crew of 6 town-wide
        solvent: c.cashOnHand > -3000, minSkill: 0.05, workers: [...c.workerIds()],
        skillOf: (id: AgentId) => this.skillOf(id),
      });
    }
    return list;
  }

  /** which construction firm (if any) an account id belongs to. */
  private builderById(id: BusinessId): Construction | undefined {
    return this.builders.find((c) => c.id === id);
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
      const fc = this.builderById(f.businessId);
      if (fc) fc.removeWorker(f.agentId);
      else this.bizById.get(f.businessId)?.removeWorker(f.agentId);
      const w = this.wallets.get(f.agentId);
      if (w) { fire(w); setTraining(w, true); } else this.shadow.applyFire(f.agentId);
    }
    for (const h of plan.hires) {
      // a poach: the worker quits their old firm first (vacancy chains follow —
      // the old firm now sits below its desired headcount and posts a vacancy).
      if (h.prevEmployer) {
        const pc = this.builderById(h.prevEmployer);
        if (pc) pc.removeWorker(h.agentId);
        else this.bizById.get(h.prevEmployer)?.removeWorker(h.agentId);
      }
      const hc = this.builderById(h.businessId);
      if (hc) hc.addWorker(h.agentId);
      else { const b = this.bizById.get(h.businessId); if (!b) continue; b.addWorker(h.agentId); }
      const w = this.wallets.get(h.agentId);
      if (w) hire(w, h.businessId, h.wage); else this.shadow.applyHire(h.agentId, h.businessId, h.wage);
    }
  }

  // ===================== premises (the leasing sweep) ========================
  /** FIFO over the pending queue: each entrant takes the cheapest vacant unit,
   *  gains full capacity, adopts the unit's rent, and stamps its archetype onto
   *  the unit AND the building record (the render fits the building to it). */
  private stepPremises(clock: number): void {
    while (this.premises.pendingCount() > 0) {
      const unit = this.premises.cheapestVacant();
      if (!unit) break;
      const id = this.premises.pendingIds[0];
      const b = this.bizById.get(id);
      if (!b) { this.premises.dequeue(id); continue; }
      this.premises.lease(unit, b.id, b.archetype);
      b.leasePremises(unit.id, unit.rent);
      const bld = this.builderById(unit.ownerId)?.buildingById(unit.buildingId);
      if (bld) bld.archetype = b.archetype ?? bld.archetype;
      this.pushEvent(clock, 'found', undefined, b.id,
        `${b.name} leases a unit ($${unit.rent.toFixed(0)}/wk) — open for business`);
      this.history.event(clock, 'found', `${b.name} signs a lease`, unit.rent);
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
    // hand back the premises (the unit reverts to vacant; queue slot freed).
    this.premises.release(b.id);
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

  /** a persistent shortage/markup + a rich household + a willing bank ⇒ entry.
   *  Phase 5 extends the same margin-signal machinery to found MAKERS (fat
   *  wholesale margin vs the maker template's marginal cost, or a persistent
   *  LOCAL wholesale shortage — import substitution) and RETAILERS (fat
   *  retail-minus-wholesale margin, or a retail shortage). One founding per
   *  cooldown across all kinds keeps entry paced. */
  private maybeFoundFirm(clock: number, dt: number): void {
    // slow shortage EMAs are the entry signal (spikes shouldn't spawn firms).
    const lam = 1 - Math.pow(0.97, dt);
    for (const s of SECTORS) {
      const v = this.goods.get(s)!.view();
      this.shortEMA[s] += lam * (v.shortage - this.shortEMA[s]);
    }
    for (const g of GOODS) {
      this.wsShortEMA[g] += lam * (this.wholesale.get(g)!.shortage - this.wsShortEMA[g]);
    }
    if (clock < ENTRY_WARMUP_H) return;               // ignore the t0 transient
    if (clock - this.lastEntryAt < ENTRY_COOLDOWN_H) return;
    if (this.rng() >= ENTRY_HAZARD * dt) return;

    // pick the most tempting opportunity with room under its cap. Two signals,
    // both margin-aware (nobody founds a firm to sell below cost into a glut):
    //  • a persistent SHORTAGE while the price clears a modest markup, or
    //  • a FAT MARGIN on its own — an incumbent milking price ≫ cost at full
    //    capacity is the textbook invitation to compete.
    let sector: Sector | null = null;
    let good: GoodId | null = null;
    let bestSignal = 0;
    for (const s of SECTORS) {
      const cap = SECTOR_FIRM_CAP[s];
      const kindHere = KIND_FOR_SECTOR[s];
      const count = (this.bySector.get(s) ?? []).filter((b) => b.kind === kindHere).length;
      if (count >= cap || cap <= 0) continue;
      const v = this.goods.get(s)!.view();
      const margin = v.price / Math.max(SECTOR_TEMPLATES[s].unitCost, 1e-6);
      const shortSignal = margin >= ENTRY_MIN_MARGIN ? this.shortEMA[s] / ENTRY_SHORT_EMA : 0;
      const signal = Math.max(shortSignal, margin / ENTRY_FAT_MARGIN);
      if (signal >= 1 && signal > bestSignal) { bestSignal = signal; sector = s; good = null; }
    }
    // maker entry per GOOD: margin over the template's raw + labour marginal
    // cost at the CURRENT wholesale price (ceilinged by the world price), or a
    // persistent local shortage while the margin at least clears its floor.
    for (const g of GOODS) {
      const capG = GOOD_MAKER_CAP[g];
      let count = 0;
      for (const b of this.businesses) if (b.kind === 'maker' && b.good === g) count++;
      if (count >= capG || capG <= 0) continue;
      const t = MAKER_TEMPLATES[g];
      const mc = t.rawCost + (t.capacityPerWorker > 0 ? t.baseWage / t.capacityPerWorker : 0);
      const margin = this.wholesale.get(g)!.price / Math.max(mc, 1e-6);
      // the shortage signal is MARGIN-WEIGHTED: every import-supplied good runs
      // a permanent local shortage, so the queue would otherwise be won by list
      // order forever — the fattest import-substitution margin goes first.
      const shortSignal = margin >= WS_ENTRY_MIN_MARGIN
        ? (this.wsShortEMA[g] / WS_ENTRY_SHORT_EMA) * (margin / WS_ENTRY_MIN_MARGIN) : 0;
      const signal = Math.max(shortSignal, margin / WS_ENTRY_FAT_MARGIN);
      if (signal >= 1 && signal > bestSignal) { bestSignal = signal; good = g; sector = null; }
    }
    if (!sector && !good) return;

    const founder = this.shadow.richest(ENTRY_MIN_WEALTH, this.owners);
    if (!founder) return;
    const kind = good ? 'maker' : KIND_FOR_SECTOR[sector!];
    // premises gate: a town with nothing to let doesn't attract more shopkeepers.
    const needsPremises = kind === 'maker' || kind === 'retail';
    if (needsPremises && this.premises.pendingCount() >= PENDING_ENTRY_CAP) return;
    // supply-chain ventures capitalize heavier (stock + premises take runway).
    const chain = kind !== 'service';
    const equity = Math.min(founder.money * ENTRY_EQUITY_FRAC, chain ? ENTRY_EQUITY_CAP_CHAIN : ENTRY_EQUITY_CAP);
    if (equity < ENTRY_MIN_EQUITY) return;

    const id: BusinessId = 'biz-n' + (this.entrantSeq++).toString(36);
    // a bank loan tops up the equity — in a credit crunch (thin bank capital)
    // this is rationed to zero and the venture launches lean or not at all.
    const lent = this.monetary.borrow(id, equity * (chain ? ENTRY_LOAN_MULT_CHAIN : 1.2));
    const seed = equity + lent;
    this.shadow.debitCash(founder.id, equity);

    let cfg: BusinessConfig;
    if (good) {
      // a MAKER: produces `good`, sells into its wholesale market.
      const t = MAKER_TEMPLATES[good];
      const names = MAKER_NAMES[good];
      const nameIdx = this.firmBirths % names.length;
      const gen = Math.floor(this.firmBirths / names.length);
      cfg = {
        id,
        name: names[nameIdx] + (gen > 0 ? ' ' + 'II III IV V VI'.split(' ')[Math.min(gen - 1, 4)] : ''),
        sector: GOOD_SECTOR[good],
        seedCash: seed,
        basePrice: GOOD_WHOLESALE_BASE[good],
        unitCost: t.rawCost * (0.85 + 0.3 * this.rng()),           // heterogeneous costs…
        capacityPerWorker: t.capacityPerWorker * (0.75 + 0.5 * this.rng()), // …and productivity
        baseWage: t.baseWage * (0.9 + 0.2 * this.rng()),
        commercialRent: WORKSHOP_RENT,
        founderIds: [],
        maxHeadcount: t.maxHeadcount,
        ownerId: founder.id,
        adaptRate: 0.1 + 0.4 * this.rng(),
        kind: 'maker', good, archetype: t.archetype,
        pendingPremises: true,
      };
    } else {
      const s = sector!;
      const t = SECTOR_TEMPLATES[s];
      const names = FIRM_NAMES[s];
      const nameIdx = this.firmBirths % names.length;
      const gen = Math.floor(this.firmBirths / names.length);
      cfg = {
        id,
        name: names[nameIdx] + (gen > 0 ? ' ' + 'II III IV V VI'.split(' ')[Math.min(gen - 1, 4)] : ''),
        sector: s,
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
        kind,
        archetype: kind === 'retail' ? RETAIL_ARCHETYPE[s] : undefined,
        shelf: kind === 'retail' ? RETAIL_SHELF[s] : undefined,
        pendingPremises: kind === 'retail',   // service entrants never needed premises
      };
    }
    const b = new Business(cfg, clock);
    this.registerBusiness(b, cfg);
    if (b.pendingPremises) this.premises.enqueue(b.id);
    this.owners.add(founder.id);
    this.shadow.applyHire(founder.id, id, cfg.baseWage);
    b.addWorker(founder.id);
    this.firmBirths++;
    this.lastEntryAt = clock;
    const what = good ? `${good} maker` : sector!;
    this.pushEvent(clock, 'found', founder.id, id, `${cfg.name} opens (${what})${b.pendingPremises ? ' — seeking premises' : ''}`);
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
  private computeMacro(clock: number, gdp: number, dt: number): MacroAggregates {
    // weighted CPI basket — the durables join at small weights (see CPI_WEIGHTS).
    let cpi = 0, wsum = 0;
    for (const s of CONSUMER_SECTORS) {
      const w = CPI_WEIGHTS[s] ?? 0;
      cpi += w * (1 + this.goods.get(s)!.view().inflation);
      wsum += w;
    }
    cpi /= Math.max(wsum, 1e-9);
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
    // warmup: the t0 staffing ramp (GDP climbing from zero as firms hire) is
    // not a boom — letting the first Fed meetings read it as one ratchets the
    // Phillips expectations high enough to block investment all run. The slow
    // EMA tracks the fast one through the warmup so the spread starts honest.
    let boom: number;
    if (clock < BOOM_WARMUP_H) { this.gdpEMA = this.gdpFast; boom = 0; this.boomTrend = 0; }
    else {
      const raw = clamp((this.gdpFast - this.gdpEMA) / (this.gdpEMA + 1) * 2.5, -1, 1);
      // DETREND (a second band-pass stage): a phase-5 economy EXPANDS secularly
      // (entrants, new sectors, buildings), which keeps the fast-vs-slow EMA
      // spread permanently positive — the Taylor principle then amplifies that
      // pseudo-gap into a 15-20% policy rate that freezes construction. The
      // cycle is the deviation from the ~2-week average pace, not the pace.
      this.boomTrend += (1 - Math.pow(0.997, dt)) * (raw - this.boomTrend);
      boom = clamp(raw - this.boomTrend, -1, 1);
    }

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
      construction: this.mergedConstruction(),
      supermarket: this.supermarketView(),
      monetary: mv,
      history: this.history.view(),
      wholesale: GOODS.map((g) => this.wholesale.get(g)!.view()),
      premises: this.premises.view(),
      builders: this.builders.map((c) => c.view()),
    };
  }

  /** SupermarketView, derived from the primary grocery RETAILER's shelf (the
   *  old singleton's HUD/render contract, kept alive off the firm). */
  private supermarketView(): SupermarketView | undefined {
    const grocers = (this.bySector.get('groceries') ?? []).filter((b) => b.kind === 'retail');
    const primary = grocers.find((b) => b.id === 'biz-market') ?? grocers[0];
    if (!primary) return undefined;
    let trips = 0;
    for (const g of grocers) trips += g.trips;
    let stock = 0, capSum = 0, sold = 0;
    const categories = primary.shelfSlots().map((sl) => {
      stock += sl.stock; capSum += sl.cap; sold += sl.sold;
      return { key: sl.good, label: GOOD_LABELS[sl.good], stock: sl.stock, capacity: sl.cap, unitsSold: sl.sold };
    });
    const v = primary.view();
    return {
      name: primary.name,
      categories,
      totalStock: stock,
      totalSold: sold,
      trips,
      revenue: v.revenue,
      fillLevel: capSum > 0 ? stock / capSum : 0,
    };
  }

  /** the legacy single-construction view = the SUM/merge of both builders (the
   *  render syncs `buildings` off this; the HUD's City line reads the totals). */
  private mergedConstruction(): ConstructionView {
    const vs = this.builders.map((c) => c.view());
    const merged: ConstructionView = {
      name: vs.map((v) => v.name.split(' ')[0]).join(' + '),
      cash: 0, workers: 0, loanBalance: 0, activeProjects: 0, completedBuildings: 0,
      lotsFree: this.lotPool.freeCount(), buildings: [],
    };
    for (const v of vs) {
      merged.cash += v.cash;
      merged.workers += v.workers;
      merged.loanBalance += v.loanBalance;
      merged.activeProjects += v.activeProjects;
      merged.completedBuildings += v.completedBuildings;
      merged.buildings.push(...v.buildings);
    }
    return merged;
  }

  // ===================== internals =========================================
  private sectorPrices(): SectorMap {
    const p = zeroSectors();
    for (const s of SECTORS) p[s] = this.goods.get(s)!.price;
    return p;
  }
  private basePriceFor(s: Sector): number {
    // a MAKER's basePrice is a WHOLESALE anchor — only sector-facing firms
    // (service/retail) may anchor the retail market's t0 price.
    const b = BUSINESSES.find((c) => c.sector === s && (c.kind ?? 'service') !== 'maker');
    if (b) return b.basePrice;
    return SECTOR_TEMPLATES[s].basePrice;
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
      v: ECON_SAVE_V,
      wallets: [...this.wallets.entries()],
      businesses: this.businesses.map((b) => ({ id: b.id, cfg: this.entrantCfg.get(b.id), j: b.toJSON() })),
      goods: SECTORS.map((s) => ({ s, j: this.goods.get(s)!.toJSON() })),
      wholesale: GOODS.map((g) => ({ g, j: this.wholesale.get(g)!.toJSON() })),
      premises: this.premises.toJSON(),
      housing: this.housing.toJSON(),
      labor: this.labor.toJSON(),
      shadow: this.shadow.toJSON(),
      monetary: this.monetary.toJSON(),
      construction: this.builders[0].toJSON(),
      construction2: this.builders[1]?.toJSON(),
      physio: this.physio.toJSON(),
      macro: this.macro, acc: this.acc, cpiPrev: this.cpiPrev, gdpEMA: this.gdpEMA, gdpFast: this.gdpFast,
      boomTrend: this.boomTrend,
      bankruptcies: this.bankruptcies, lastClock: this.lastClock, rng: this.rng.save ? this.rng.save() : 0,
      history: this.history.toJSON(),
      demography: {
        births: this.firmBirths, deaths: this.firmDeaths, lastEntryAt: this.lastEntryAt,
        entrantSeq: this.entrantSeq, owners: [...this.owners], shortEMA: { ...this.shortEMA },
        wsShortEMA: { ...this.wsShortEMA },
      },
    };
  }
  loadJSON(j: EconJSON): void {
    if (!j) return;
    // pre-phase-5 saves predate the seeded supply-chain firms: their absence
    // from the save means "not born yet", never "exited" — keep them.
    const legacy = (j.v ?? 4) < ECON_SAVE_V;
    for (const [id, w] of j.wallets) { const cur = this.wallets.get(id); if (cur) Object.assign(cur, w); else this.wallets.set(id, w); }
    // firm demography round-trip: drop firms the save doesn't have (they exited
    // before it was taken), rebuild entrants from their stored configs.
    const savedIds = new Set(j.businesses.map((e) => e.id));
    for (let i = this.businesses.length - 1; i >= 0; i--) {
      const b = this.businesses[i];
      if (savedIds.has(b.id)) continue;
      if (legacy && PHASE5_SEED_IDS.has(b.id)) continue;
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
    if (Array.isArray(j.wholesale)) for (const { g, j: wj } of j.wholesale) this.wholesale.get(g)?.loadJSON(wj);
    if (j.premises) this.premises.loadJSON(j.premises);
    this.housing.loadJSON(j.housing);
    this.labor.loadJSON(j.labor);
    this.shadow.loadJSON(j.shadow);
    if (j.monetary) this.monetary.loadJSON(j.monetary);
    // both builders share the lot pool: reset the claims, load each firm (its
    // loader re-marks its lots), then re-mark everything still standing (covers
    // a builder whose save section is missing — e.g. Keystone on an old save).
    this.lotPool.reset();
    if (j.construction) this.builders[0].loadJSON(j.construction);
    if (j.construction2) this.builders[1]?.loadJSON(j.construction2);
    for (const c of this.builders) for (const b of c.buildings()) this.lotPool.mark(b.lotId);
    // legacy saves predate the seeded t0 workshop buildings — restore any the
    // load dropped so the seeded makers keep their premises (and the render its
    // buildings). j.extraCap (the old commercial capacity pad) is deliberately
    // IGNORED: premises replaced it.
    this.restoreSeedBuildings();
    if (legacy && j.supermarket) this.loadLegacySupermarket(j.supermarket);
    if (j.physio) this.physio.loadJSON(j.physio);
    this.macro = { ...this.freshMacro(j.macro?.clock ?? 0), ...j.macro };
    this.acc = j.acc; this.cpiPrev = j.cpiPrev; this.gdpEMA = j.gdpEMA;
    this.gdpFast = j.gdpFast ?? j.gdpEMA;
    this.boomTrend = j.boomTrend ?? 0;
    this.bankruptcies = j.bankruptcies; this.lastClock = j.lastClock;
    if (j.history) this.history.loadJSON(j.history);
    if (j.demography) {
      this.firmBirths = j.demography.births; this.firmDeaths = j.demography.deaths;
      this.lastEntryAt = j.demography.lastEntryAt; this.entrantSeq = j.demography.entrantSeq;
      this.owners.clear(); for (const o of j.demography.owners) this.owners.add(o);
      if (j.demography.shortEMA) for (const s of SECTORS) this.shortEMA[s] = j.demography.shortEMA[s] ?? 0;
      if (j.demography.wsShortEMA) for (const g of GOODS) this.wsShortEMA[g] = j.demography.wsShortEMA[g] ?? 0;
    }
    // rebuild the pending queue for any entrant flagged pending that the
    // registry (older or partial save) doesn't already track.
    for (const b of this.businesses) {
      if (b.pendingPremises && !this.premises.pendingIds.includes(b.id)) this.premises.enqueue(b.id);
    }
    this.prevPolicyAtEvent = this.monetary.policyRate;
    if (this.rng.load) this.rng.load(j.rng);
  }

  /** re-seed the t0 workshop buildings if a (legacy) save dropped them. */
  private restoreSeedBuildings(): void {
    for (const sp of SEED_PREMISES) {
      const owner = this.builders[sp.ownerIdx];
      if (!owner || owner.buildingById(sp.buildingId)) continue;
      const lot = BUILD_LOTS.find((l) => l.id === sp.lotId);
      if (!lot) continue;
      // the lot may have been claimed by a legacy save's building — skip then.
      if (this.builders.some((c) => c.buildings().some((b) => b.lotId === sp.lotId))) continue;
      owner.seedBuilding({
        id: sp.buildingId, kind: 'workshop', lotId: lot.id,
        x: lot.x, z: lot.z, w: lot.w, d: lot.d, floors: sp.floors,
        progress: 1, complete: true, cost: 0, dwellings: 0, capacity: 0,
        cumIncome: 0, startedAt: 0, archetype: sp.archetype,
      });
    }
  }

  /** map a phase-4 Supermarket singleton save onto the Meridian firm's shelf. */
  private loadLegacySupermarket(sj: unknown): void {
    const o = sj as { cats?: { key?: string; stock?: number; unitsSold?: number }[]; tripsTotal?: number } | null;
    const market = this.bizById.get('biz-market');
    if (!o || !market || market.kind !== 'retail') return;
    if (Array.isArray(o.cats)) {
      for (const cat of o.cats) {
        const sl = market.shelfSlots().find((x) => x.good === cat.key);
        if (sl) {
          (sl as { stock: number }).stock = Math.min(sl.cap, cat.stock ?? sl.stock);
          (sl as { sold: number }).sold = cat.unitsSold ?? 0;
        }
      }
    }
    if (typeof o.tripsTotal === 'number') market.recordTrips(o.tripsTotal);
  }
}

export interface EconJSON {
  /** save schema version (absent = phase 4). */
  v?: number;
  wallets: [AgentId, Wallet][];
  /** cfg present ⇒ a runtime entrant (rebuilt from cfg on load); absent ⇒ static. */
  businesses: { id: BusinessId; cfg?: BusinessConfig; j: unknown }[];
  goods: { s: Sector; j: unknown }[];
  wholesale?: { g: GoodId; j: unknown }[];
  premises?: unknown;
  housing: unknown; labor: unknown; shadow: unknown;
  monetary?: unknown; construction?: unknown; construction2?: unknown;
  /** legacy phase-4 singleton (mapped onto the Meridian firm's shelf on load). */
  supermarket?: unknown;
  physio?: unknown;
  /** legacy phase-4 commercial capacity pad — ignored (premises replaced it). */
  extraCap?: SectorMap;
  macro: MacroAggregates; acc: number; cpiPrev: number; gdpEMA: number; gdpFast?: number;
  boomTrend?: number;
  bankruptcies: number; lastClock: number; rng: number;
  history?: unknown;
  demography?: {
    births: number; deaths: number; lastEntryAt: number; entrantSeq: number;
    owners: AgentId[]; shortEMA: SectorMap;
    wsShortEMA?: Record<GoodId, number>;
  };
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
