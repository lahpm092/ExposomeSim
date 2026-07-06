// =============================================================================
// construction.ts — firms that BUILD. Phase 5: TWO construction firms coexist
// ('Ironline Construction' + 'Keystone & Sons'), sharing one LOT POOL (claimed
// atomically), each with its own crew, cash, credit line (via the Financier)
// and groundbreaking cooldown. Demand signals:
//   • housing vacancy low  → a housing block (dwellings → rent falls), as before;
//   • the premises pipeline → a 'shopfront' (2 commercial units) or a 'workshop'
//     (1 unit, cheaper) when entrants queue for premises or commercial vacancy
//     runs dry — the kind picked by what the queue wants.
// Shopfront/workshop buildings are KEPT by the builder: its income is the real
// lease rent tenants transfer each RENT_PERIOD (credited by the orchestrator via
// receiveLease). Housing keeps the phase-4 handover + rent-proxy income. The old
// 'commercial' capacity-pad kind is gone (legacy records tolerated on load).
// Hurdle rates still gate groundbreaking — dear money stalls the skyline.
// =============================================================================

import type {
  AgentId, BusinessId, Money, BuildKind, BuildLot, Building, ConstructionView,
  MacroAggregates,
} from './types';
import { HURDLE_HOUSING, HURDLE_COMMERCIAL, HURDLE_PRELET, SHOPFRONT_COST, WORKSHOP_COST, COMMERCIAL_VACANT_MIN } from './config';
import { clamp, type RNG } from '../core/util/num';

/** the credit interface a firm uses to finance projects — satisfied by the causal
 *  MonetarySystem (a bank loan creates a deposit; repayment destroys it). */
export interface Financier {
  borrow(id: AgentId, amount: Money): Money;   // amount actually lent (capital-gated)
  repay(id: AgentId, amount: Money): Money;     // amount actually repaid
  loanBalance(id: AgentId): Money;
  loanRate(id: AgentId): number;
}

let _bSeq = 0;

/** the shared buildable-land ledger: BOTH construction firms draw from it, and a
 *  lot is claimed ATOMICALLY the instant a project starts (or a seed building is
 *  placed) — two firms can never break ground on the same plot. */
export class LotPool {
  private claimed = new Set<string>();
  constructor(readonly lots: BuildLot[]) {}
  claim(): BuildLot | undefined {
    const lot = this.lots.find((l) => !this.claimed.has(l.id));
    if (lot) this.claimed.add(lot.id);
    return lot;
  }
  mark(lotId: string): void { this.claimed.add(lotId); }
  reset(): void { this.claimed.clear(); }
  freeCount(): number { return this.lots.length - this.claimed.size; }
  byId(lotId: string): BuildLot | undefined { return this.lots.find((l) => l.id === lotId); }
}

export interface ConstructionCtx {
  clock: number;
  dt: number;
  rng: RNG;
  macro: MacroAggregates;
  housingVacancy: number;              // 0..1 — low ⇒ build housing
  /** the premises pipeline: entrants queueing + the commercial vacancy picture. */
  commercial: {
    pending: number;                   // firms waiting for premises
    vacantUnits: number;               // unleased commercial units town-wide
    underwayUnits: number;             // units in shopfronts/workshops being built (both firms)
    wantKind: 'shopfront' | 'workshop'; // what the queue's head wants
  };
}

// ---- tunables --------------------------------------------------------------
const BUILD_COST_HOUSING = 7000;
const WORKER_RATE = 0.003;             // build progress / sim-hour per worker (~days/building)
const HOUSING_DWELLINGS = 26;          // dwellings a finished housing block adds
const MAX_ACTIVE = 1;                  // one project at a time per firm
const START_COOLDOWN = 96;             // min sim-hours between one firm's groundbreakings
const HOUSING_VACANCY_TRIGGER = 0.22;  // build housing below this vacancy
const HOUSING_INCOME = 1.7;            // rent per dwelling per sim-hour
const LEGACY_COMMERCIAL_INCOME = 2.2;  // old 'commercial' pads from phase-4 saves

/** units a finished commercial building contributes to the premises registry. */
export function unitsFor(kind: BuildKind): number {
  return kind === 'shopfront' ? 2 : kind === 'workshop' ? 1 : 0;
}

export class Construction {
  readonly id: BusinessId;
  readonly name: string;
  private cash: Money;
  private wageRate: Money;
  private workers: AgentId[] = [];
  private readonly pool: LotPool;
  private readonly builds: Building[] = [];
  private readonly bank: Financier;
  private lastStartAt = -1e9;   // clock of the last groundbreaking (build cooldown)

  constructor(id: BusinessId, name: string, pool: LotPool, bank: Financier, opts: { seedCash?: Money; wage?: Money } = {}) {
    this.id = id;
    this.name = name;
    this.pool = pool;
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

  /** a tenant's lease rent lands here (a REAL transfer, moved by the orchestrator). */
  receiveLease(buildingId: string, amt: Money): void {
    if (amt <= 0) return;
    this.cash += amt;
    const b = this.builds.find((x) => x.id === buildingId);
    if (b) b.cumIncome += amt;
  }

  /** place a pre-existing (t0) building: claims its lot, no cost, complete. */
  seedBuilding(b: Building): void {
    this.pool.mark(b.lotId);
    this.builds.push(b);
  }

  buildingById(id: string): Building | undefined { return this.builds.find((b) => b.id === id); }

  private activeCount(): number { let c = 0; for (const b of this.builds) if (!b.complete) c++; return c; }

  /** commercial units this firm currently has under construction (for the
   *  town-wide underway count that stops both firms overbuilding one signal). */
  underwayUnits(): number {
    let u = 0;
    for (const b of this.builds) if (!b.complete) u += unitsFor(b.kind);
    return u;
  }

  // ---- decide + finance + place a new project -----------------------------
  private maybeStart(ctx: ConstructionCtx): void {
    if (this.activeCount() >= MAX_ACTIVE || this.headcount() === 0) return;
    if (ctx.clock - this.lastStartAt < START_COOLDOWN) return;   // pace groundbreakings

    // THE HURDLE RATE: a project is debt-financed, so when the bank's lending
    // rate is above the hurdle the expected yield can't cover the interest and
    // the firm sits on its hands — monetary tightening stalls real investment.
    const rate = this.bank.loanRate(this.id);

    // pick the project: tight housing first (the incumbent signal), else the
    // premises pipeline — entrants queueing beyond what's already underway, or
    // speculative when commercial vacancy runs dry. A PRE-LET project (tenants
    // already queueing) is de-risked, so it clears a higher hurdle than a
    // speculative shell.
    const c = ctx.commercial;
    const wantHousing = ctx.housingVacancy < HOUSING_VACANCY_TRIGGER;
    const preLet = c.pending > c.underwayUnits;
    const wantCommercial = preLet || (c.vacantUnits + c.underwayUnits < COMMERCIAL_VACANT_MIN);
    let kind: BuildKind;
    if (wantHousing && rate <= HURDLE_HOUSING) kind = 'housing';
    else if (wantCommercial && rate <= (preLet ? HURDLE_PRELET : HURDLE_COMMERCIAL)) kind = c.wantKind;
    else return;

    const lot = this.pool.claim();
    if (!lot) return;

    const cost = kind === 'housing' ? BUILD_COST_HOUSING : kind === 'shopfront' ? SHOPFRONT_COST : WORKSHOP_COST;
    // finance the shortfall with a bank loan (creates a deposit = broad money);
    // if the bank's capital can't support it, unwind and abort.
    if (this.cash < cost) {
      const need = cost - this.cash;
      const lent = this.bank.borrow(this.id, need);
      this.cash += lent;
      if (this.cash < cost) { this.cash -= this.bank.repay(this.id, lent); return; }
    }
    this.cash -= cost;

    const floors = kind === 'housing' ? 4 + Math.floor(ctx.rng() * 5) : kind === 'shopfront' ? 1 + Math.floor(ctx.rng() * 2) : 1;
    this.builds.push({
      id: 'bld' + (_bSeq++).toString(36), kind, lotId: lot.id,
      x: lot.x, z: lot.z, w: lot.w, d: lot.d, floors,
      progress: 0, complete: false, cost,
      dwellings: kind === 'housing' ? HOUSING_DWELLINGS : 0,
      capacity: 0,
      cumIncome: 0, startedAt: ctx.clock,
    });
    this.lastStartAt = ctx.clock;
  }

  // ---- advance: progress, completion, income, payroll, debt service -------
  /** returns the economic deltas the EconomySim applies: new housing supply plus
   *  the freshly-completed buildings (shopfront/workshop completions mint
   *  commercial units in the premises registry — the orchestrator's job). */
  step(ctx: ConstructionCtx): { dwellingsAdded: number; completed: Building[] } {
    this.maybeStart(ctx);

    const rate = WORKER_RATE * this.headcount() * ctx.dt;
    let dwellingsAdded = 0;
    const completed: Building[] = [];

    for (const b of this.builds) {
      if (!b.complete) {
        b.progress = clamp(b.progress + rate, 0, 1);
        if (b.progress >= 1) {
          b.complete = true;
          completed.push(b);
          if (b.kind === 'housing') {
            dwellingsAdded += b.dwellings;
            // handover: the housing block is sold to its owner for cost + a
            // developer margin — the firm's main revenue (covers the loan).
            this.cash += b.cost * 1.6;
            b.cumIncome += b.cost * 1.6;
          }
          // shopfront/workshop: the builder KEEPS the building — its income is
          // the tenants' lease rent, credited later via receiveLease().
        }
      } else if (b.kind === 'housing') {
        // a finished housing block earns rent → cash → services the debt.
        const income = b.dwellings * HOUSING_INCOME * ctx.dt;
        b.cumIncome += income;
        this.cash += income;
      } else if (b.kind === 'commercial') {
        // legacy phase-4 pads (old saves only): keep their lease-proxy income.
        const income = b.capacity * LEGACY_COMMERCIAL_INCOME * ctx.dt;
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

    return { dwellingsAdded, completed };
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
      lotsFree: this.pool.freeCount(),
      buildings: this.builds.map((b) => ({ ...b })),
    };
  }

  toJSON(): unknown {
    return { cash: this.cash, wage: this.wageRate, workers: this.workers, builds: this.builds, seq: _bSeq, lastStartAt: this.lastStartAt };
  }
  loadJSON(j: unknown): void {
    const o = j as { cash?: number; wage?: number; workers?: AgentId[]; builds?: Building[]; seq?: number; lastStartAt?: number } | null;
    if (!o) return;
    if (typeof o.cash === 'number') this.cash = o.cash;
    if (typeof o.wage === 'number') this.wageRate = o.wage;
    this.workers = Array.isArray(o.workers) ? o.workers : [];
    if (Array.isArray(o.builds)) {
      this.builds.length = 0;
      this.builds.push(...o.builds);
      for (const b of this.builds) this.pool.mark(b.lotId);   // re-claim our lots
    }
    if (typeof o.seq === 'number') _bSeq = Math.max(_bSeq, o.seq);
    if (typeof o.lastStartAt === 'number') this.lastStartAt = o.lastStartAt;
  }
}
