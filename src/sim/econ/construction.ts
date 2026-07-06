// =============================================================================
// construction.ts — a firm that BUILDS. It watches the town's needs (tight
// housing, goods shortages), finances a project with a bank loan, and runs it:
// progress advances with its workforce until a low-poly BUILDING completes and
// enters the economy — housing adds dwellings (rent falls), commercial adds
// capacity to a goods sector. Completed buildings yield income that repays the
// debt. The render reads `buildings()` (world-coord footprints + progress) to
// place and grow the meshes. See ECONOMY_DESIGN.md.
// =============================================================================

import type {
  AgentId, BusinessId, Money, BuildKind, BuildLot, Building, ConstructionView,
  Sector, SectorMap, MacroAggregates,
} from './types';
import { HURDLE_HOUSING, HURDLE_COMMERCIAL } from './config';
import { clamp, type RNG } from '../../util/num';

/** the credit interface a firm uses to finance projects — satisfied by the causal
 *  MonetarySystem (a bank loan creates a deposit; repayment destroys it). */
export interface Financier {
  borrow(id: AgentId, amount: Money): Money;   // amount actually lent (capital-gated)
  repay(id: AgentId, amount: Money): Money;     // amount actually repaid
  loanBalance(id: AgentId): Money;
  loanRate(id: AgentId): number;
}

let _bSeq = 0;

export interface ConstructionCtx {
  clock: number;
  dt: number;
  rng: RNG;
  macro: MacroAggregates;
  housingVacancy: number;              // 0..1 — low ⇒ build housing
  sectorShortage: (s: Sector) => number; // 0..1 — high ⇒ build commercial there
}

// ---- tunables --------------------------------------------------------------
const BUILD_COST_HOUSING = 7000;
const BUILD_COST_COMMERCIAL = 9500;
const WORKER_RATE = 0.003;             // build progress / sim-hour per worker (~days/building)
const HOUSING_DWELLINGS = 26;          // dwellings a finished housing block adds
const COMMERCIAL_CAP = 3;              // units/hr a finished commercial block adds (small — resolves
                                       // a shortage gradually so building self-limits, without a price crash)
const MAX_ACTIVE = 1;                  // one project at a time (paces borrowing + supply)
const MAX_COMMERCIAL = 3;              // lifetime commercial cap (keeps the goods economy stable)
const START_COOLDOWN = 96;             // min sim-hours between breaking ground (paces the skyline)
const HOUSING_VACANCY_TRIGGER = 0.22;  // build housing below this vacancy
const SHORTAGE_TRIGGER = 0.14;         // build commercial above this shortage
const HOUSING_INCOME = 1.7;            // rent per dwelling per sim-hour
const COMMERCIAL_INCOME = 2.2;         // lease per capacity-unit per sim-hour
// commercial blocks serve only the larger-buffered sectors — adding capacity to the
// tiny food/retail firms would tip them into loss.
const COMMERCIAL_SECTORS: Sector[] = ['utilities'];

export class Construction {
  readonly id: BusinessId = 'biz-construction';
  readonly name = 'Ironline Construction';
  private cash: Money;
  private wageRate: Money;
  private workers: AgentId[] = [];
  private readonly lots: BuildLot[];
  private readonly builds: Building[] = [];
  private readonly bank: Financier;
  private lastStartAt = -1e9;   // clock of the last groundbreaking (build cooldown)

  constructor(lots: BuildLot[], bank: Financier, opts: { seedCash?: Money; wage?: Money } = {}) {
    this.lots = lots;
    this.bank = bank;
    this.cash = opts.seedCash ?? 4000;
    this.wageRate = opts.wage ?? 17;
  }

  // ---- workforce ----------------------------------------------------------
  addWorker(id: AgentId): void { if (!this.workers.includes(id)) this.workers.push(id); }
  removeWorker(id: AgentId): boolean { const i = this.workers.indexOf(id); if (i < 0) return false; this.workers.splice(i, 1); return true; }
  hasWorker(id: AgentId): boolean { return this.workers.includes(id); }
  headcount(): number { return this.workers.length; }
  workerIds(): readonly AgentId[] { return this.workers; }
  get wage(): Money { return this.wageRate; }
  get cashOnHand(): Money { return this.cash; }
  /** reduce cash (loan interest paid to the bank); returns the amount taken. */
  debit(amt: Money): number { const d = Math.min(amt, Math.max(0, this.cash)); this.cash -= d; return d; }

  private activeCount(): number { let c = 0; for (const b of this.builds) if (!b.complete) c++; return c; }
  private freeLot(): BuildLot | undefined { return this.lots.find((l) => !this.builds.some((b) => b.lotId === l.id)); }

  // ---- decide + finance + place a new project -----------------------------
  private maybeStart(ctx: ConstructionCtx): void {
    if (this.activeCount() >= MAX_ACTIVE || this.headcount() === 0) return;
    if (ctx.clock - this.lastStartAt < START_COOLDOWN) return;   // pace groundbreakings
    const lot = this.freeLot();
    if (!lot) return;

    // THE HURDLE RATE: a project is debt-financed, so when the bank's lending
    // rate is above the hurdle the expected yield can't cover the interest and
    // the firm sits on its hands — monetary tightening now stalls real
    // investment (and easing revives it). This is the Fed's main lever into
    // the physical town.
    const rate = this.bank.loanRate(this.id);

    const wantHousing = ctx.housingVacancy < HOUSING_VACANCY_TRIGGER;
    let kind: BuildKind = 'housing';
    let sector: Sector | undefined;
    if (wantHousing) {
      if (rate > HURDLE_HOUSING) return;
    } else {
      if (rate > HURDLE_COMMERCIAL) return;
      // only a bounded number of commercial blocks ever (keeps goods supply sane)
      const nComm = this.builds.reduce((n, b) => n + (b.kind === 'commercial' ? 1 : 0), 0);
      if (nComm >= MAX_COMMERCIAL) return;
      let worst = 0;
      for (const s of COMMERCIAL_SECTORS) { const sh = ctx.sectorShortage(s); if (sh > worst) { worst = sh; sector = s; } }
      if (worst < SHORTAGE_TRIGGER || !sector) return;   // nothing worth building
      kind = 'commercial';
    }

    const cost = kind === 'housing' ? BUILD_COST_HOUSING : BUILD_COST_COMMERCIAL;
    // finance the shortfall with a bank loan (creates a deposit = broad money);
    // if the bank's capital can't support it, unwind and abort.
    if (this.cash < cost) {
      const need = cost - this.cash;
      const lent = this.bank.borrow(this.id, need);
      this.cash += lent;
      if (this.cash < cost) { this.cash -= this.bank.repay(this.id, lent); return; }
    }
    this.cash -= cost;

    const floors = kind === 'housing' ? 4 + Math.floor(ctx.rng() * 5) : 2 + Math.floor(ctx.rng() * 2);
    this.builds.push({
      id: 'bld' + (_bSeq++).toString(36), kind, lotId: lot.id,
      x: lot.x, z: lot.z, w: lot.w, d: lot.d, floors,
      progress: 0, complete: false, cost,
      dwellings: kind === 'housing' ? HOUSING_DWELLINGS : 0,
      sector, capacity: kind === 'commercial' ? COMMERCIAL_CAP : 0,
      cumIncome: 0, startedAt: ctx.clock,
    });
    this.lastStartAt = ctx.clock;
  }

  // ---- advance: progress, completion, income, payroll, debt service -------
  /** returns the economic deltas the EconomySim applies (new housing supply +
   *  new commercial capacity per sector), plus a list of freshly-completed ids. */
  step(ctx: ConstructionCtx): { dwellingsAdded: number; capacityAdded: SectorMap; completed: Building[] } {
    this.maybeStart(ctx);

    const rate = WORKER_RATE * this.headcount() * ctx.dt;
    let dwellingsAdded = 0;
    const capacityAdded: SectorMap = { food: 0, groceries: 0, software: 0, utilities: 0, retail: 0 };
    const completed: Building[] = [];

    for (const b of this.builds) {
      if (!b.complete) {
        b.progress = clamp(b.progress + rate, 0, 1);
        if (b.progress >= 1) {
          b.complete = true;
          completed.push(b);
          // Housing eases the housing market; commercial adds a SMALL amount of
          // goods capacity (resolves the shortage that triggered it, so building
          // self-limits) plus its lease income.
          if (b.kind === 'housing') dwellingsAdded += b.dwellings;
          else if (b.sector) capacityAdded[b.sector] += b.capacity;
          // handover: the finished building is sold/leased to its owner for cost +
          // a developer margin — this is the firm's main revenue (covers the loan).
          this.cash += b.cost * 1.6;
          b.cumIncome += b.cost * 1.6;
        }
      } else {
        // a finished building earns rent/lease → cash → services the debt.
        const income = (b.kind === 'housing' ? b.dwellings * HOUSING_INCOME : b.capacity * COMMERCIAL_INCOME) * ctx.dt;
        b.cumIncome += income;
        this.cash += income;
      }
    }

    // payroll — full while a project runs, a reduced retainer while the crew waits
    // for the next contract (so an idle firm isn't bled dry by its standing crew).
    const duty = this.activeCount() > 0 ? 1 : 0.4;
    this.cash -= this.headcount() * this.wageRate * ctx.dt * duty;
    const owed = this.bank.loanBalance(this.id);
    if (owed > 0 && this.cash > 0) {
      const pay = Math.min(this.cash * 0.35, owed * 0.03 + 4);
      this.cash -= this.bank.repay(this.id, pay);  // repay principal (interest is charged centrally)
    }

    return { dwellingsAdded, capacityAdded, completed };
  }

  // ---- readout ------------------------------------------------------------
  buildings(): Building[] { return this.builds; }

  view(): ConstructionView {
    return {
      name: this.name,
      cash: this.cash,
      workers: this.headcount(),
      loanBalance: this.bank.loanBalance(this.id),
      activeProjects: this.activeCount(),
      completedBuildings: this.builds.filter((b) => b.complete).length,
      lotsFree: this.lots.length - this.builds.length,
      buildings: this.builds.map((b) => ({ ...b })),
    };
  }

  toJSON(): unknown {
    return { cash: this.cash, wage: this.wageRate, workers: this.workers, builds: this.builds, seq: _bSeq };
  }
  loadJSON(j: unknown): void {
    const o = j as { cash?: number; wage?: number; workers?: AgentId[]; builds?: Building[]; seq?: number } | null;
    if (!o) return;
    if (typeof o.cash === 'number') this.cash = o.cash;
    if (typeof o.wage === 'number') this.wageRate = o.wage;
    this.workers = Array.isArray(o.workers) ? o.workers : [];
    if (Array.isArray(o.builds)) { this.builds.length = 0; this.builds.push(...o.builds); }
    if (typeof o.seq === 'number') _bSeq = Math.max(_bSeq, o.seq);
  }
}
