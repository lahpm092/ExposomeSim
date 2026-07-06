// =============================================================================
// ExposomeSim — ECONOMY / labour market (recruit · hire · fire matching).
// -----------------------------------------------------------------------------
// The matching engine for the Tier-A + Tier-C workforce. It is a PURE DECISION
// engine: given each firm's hiring posture (`FirmDemand`) and the job-seekers on
// offer (`LaborCandidate`), it returns a `LaborPlan` — the hires and fires it
// WANTS — and never touches a wallet, firm, or shadow household. The EconomySim
// orchestrator is the money-mover: it APPLIES the plan (reassigning employers,
// moving wages) and it alone owns the labour-force / unemployment aggregates.
//
// All this module keeps between ticks is a bounded ring buffer of recent events
// (for the HUD ticker) and the count of vacancies it couldn't fill (for the
// view). Keeping it stateless-ish and side-effect-free makes it deterministic
// and reproducible from a seed. Matching leans on skill (highest wins) with a
// pinch of rng churn so the market settles instead of oscillating each tick.
// =============================================================================

import type {
  FirmDemand, LaborCandidate, LaborEvent, LaborMarketView, LaborPlan, Money,
} from './types';
import { POACH_MARGIN, OTJ_SEARCH_P, HOMELESS_PENALTY } from './config';
import { clamp, type RNG } from '../core/util/num';

// ---- tunables --------------------------------------------------------------

/** Ring-buffer depth for the recent-events ticker surfaced to the HUD. */
const MAX_EVENTS = 40;

/** Actively-looking candidates get a small edge over the merely-idle pool. */
const SEEK_BONUS = 0.15;

/** A dash of rng on each candidate's match score: breaks exact ties and keeps
 *  the borderline hire/fire from flip-flopping every tick. Kept well under 1 so
 *  skill still dominates the ordering. */
const CHURN = 0.08;

/** Inertia discount on employed searchers: switching jobs has a cost, so the
 *  employed rank a notch below equally-skilled unemployed seekers. */
const OTJ_INERTIA = 0.1;

// ---- the market ------------------------------------------------------------

export class LaborMarket {
  /** vacancies posted by solvent firms that went unfilled this tick (for view). */
  vacancies = 0;

  /** recent events, most-recent-first, bounded to MAX_EVENTS (for the ticker). */
  private recent: LaborEvent[] = [];

  constructor() {}

  // ---- decision: who gets hired, who gets let go ---------------------------
  /**
   * Decide hires and fires for this tick WITHOUT mutating firms or candidates —
   * the returned plan is data the orchestrator applies.
   *
   *  FIRES  — every firm carrying more staff than it wants sheds the surplus,
   *           strictly the lowest-`skillOf` workers first. Emits 'layoff'.
   *  HIRES  — the unemployed pool (candidates with no employer, active seekers
   *           preferred) is matched into open vacancies at solvent firms whose
   *           bar `minSkill` they clear, highest skill first. A candidate takes
   *           at most one offer per tick. Emits 'hire'.
   *
   * Fires and hires are disjoint by construction (a firm either wants to grow or
   * shrink), and a worker fired here still reads as employed in this tick's
   * `candidates` snapshot, so they cannot be re-hired until the plan is applied.
   */
  plan(firms: FirmDemand[], candidates: LaborCandidate[], clock: number, rng: RNG): LaborPlan {
    const hires: LaborPlan['hires'] = [];
    const fires: LaborPlan['fires'] = [];
    const events: LaborEvent[] = [];

    // ---- FIRES: trim each over-staffed firm down to its desired headcount ---
    for (const f of firms ?? []) {
      if (!f || f.desired >= f.headcount) continue;
      const workers = f.workers ?? [];
      const cut = f.headcount - f.desired;
      // Rank ascending by skill; the least-skilled are let go first. Ties keep
      // their incidental order (a lower one is fine) — no rng, fire order is
      // deterministic on purpose so it reads as "worst performer goes".
      const ranked = workers.slice().sort((a, b) => f.skillOf(a) - f.skillOf(b));
      for (let i = 0; i < cut && i < ranked.length; i++) {
        const id = ranked[i];
        fires.push({ agentId: id, businessId: f.id });
        events.push({ t: clock, kind: 'layoff', agentId: id, businessId: f.id, businessName: f.name, detail: `let go from ${f.name}` });
      }
    }

    // ---- HIRES: match seekers into open vacancies ---------------------------
    // The pool has two kinds of candidate:
    //  • the UNEMPLOYED (employer === null) — score: skill + seek bonus + rng,
    //    minus a penalty while homeless (job-finding hysteresis);
    //  • the EMPLOYED-BUT-UNDERPAID (on-the-job search, the JOB LADDER): with
    //    probability OTJ_SEARCH_P they look this tick, rank below equal-skill
    //    unemployed (inertia), and only accept an offer ≥ POACH_MARGIN × their
    //    current wage — a hire from this group is a QUIT at the old firm, which
    //    creates replacement demand next tick (vacancy chains).
    const pool: { c: LaborCandidate; score: number }[] = [];
    for (const c of candidates ?? []) {
      if (!c) continue;
      if (c.employer === null) {
        const score = c.skill + (c.seeking ? SEEK_BONUS : 0)
          - (c.homeless ? HOMELESS_PENALTY : 0) + rng() * CHURN;
        pool.push({ c, score });
      } else if (rng() < OTJ_SEARCH_P) {
        pool.push({ c, score: c.skill - OTJ_INERTIA + rng() * CHURN });
      }
    }
    pool.sort((a, b) => b.score - a.score);
    const taken = new Set<string>();
    const firedNow = new Set(fires.map((f) => f.agentId));

    let unfilled = 0;
    for (const f of firms ?? []) {
      // Only solvent firms wanting to grow post a real vacancy.
      if (!f || !f.solvent || f.desired <= f.headcount) continue;
      let slots = f.desired - f.headcount;
      for (const p of pool) {
        if (slots <= 0) break;
        const c = p.c;
        if (taken.has(c.id) || c.skill < f.minSkill) continue;
        if (c.employer !== null) {
          // poach conditions: not our own worker, not already being let go, and
          // the offered wage clears the raise bar over their current wage.
          if (c.employer === f.id || firedNow.has(c.id)) continue;
          if (f.wage < (c.wage ?? 0) * POACH_MARGIN) continue;
          taken.add(c.id);
          hires.push({ agentId: c.id, businessId: f.id, wage: f.wage, prevEmployer: c.employer });
          events.push({ t: clock, kind: 'quit', agentId: c.id, agentName: c.name, businessId: f.id, businessName: f.name, detail: `quit for ${f.name} · $${f.wage.toFixed(0)}/h` });
        } else {
          taken.add(c.id);
          hires.push({ agentId: c.id, businessId: f.id, wage: f.wage });
          events.push({ t: clock, kind: 'hire', agentId: c.id, agentName: c.name, businessId: f.id, businessName: f.name, detail: `hired at ${f.name} · $${f.wage.toFixed(0)}/h` });
        }
        slots--;
      }
      if (slots > 0) unfilled += slots; // a vacancy no qualifying seeker could fill
    }
    this.vacancies = unfilled;

    // ---- record into the ring buffer (most-recent-first, bounded) -----------
    for (const e of events) this.recent.unshift(e);
    if (this.recent.length > MAX_EVENTS) this.recent.length = MAX_EVENTS;

    return { hires, fires, events };
  }

  /** inject an externally-decided event (eviction/bankruptcy/founding) into the
   *  ticker so the HUD shows the whole labour-market story in one stream. */
  record(e: LaborEvent): void {
    this.recent.unshift(e);
    if (this.recent.length > MAX_EVENTS) this.recent.length = MAX_EVENTS;
  }

  // ---- readout -------------------------------------------------------------
  /**
   * Build the HUD view. The orchestrator owns the labour-force accounting and
   * hands in the totals (A + C); we derive the unemployment rate from them and
   * surface our own vacancy count + recent-events ticker.
   */
  view(laborForce: number, employed: number, meanWage: Money): LaborMarketView {
    const unemployment = laborForce > 0 ? clamp((laborForce - employed) / laborForce, 0, 1) : 0;
    return {
      vacancies: this.vacancies,
      unemployment,
      laborForce,
      employed,
      meanWage,
      recentEvents: this.recent.slice(), // copy — callers must not mutate our buffer
    };
  }

  // ---- persistence (config-free; just the mutable tick state) --------------
  toJSON(): unknown {
    return { vacancies: this.vacancies, recent: this.recent };
  }

  loadJSON(j: unknown): void {
    const o = (j ?? {}) as { vacancies?: unknown; recent?: unknown };
    this.vacancies = typeof o.vacancies === 'number' ? o.vacancies : 0;
    this.recent = Array.isArray(o.recent) ? (o.recent as LaborEvent[]).slice(0, MAX_EVENTS) : [];
  }
}
