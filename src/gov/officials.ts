// =============================================================================
// ExposomeSim — OFFICIALS: the office roster + the MindLite-on-demand plan.
// -----------------------------------------------------------------------------
// Offices are data, not minds. A roster winner is already fully simulated
// (Tier F — zero marginal cost); a shadow winner is a deterministic
// sampleProfile(profileSeed) the WORLD promotes to MindLite + a standalone
// MemoryGraph only while observed (the town.ts:587 on-demand pattern).
// This module only says WHO holds WHAT since WHEN, and what wage the clerks
// draw — recruitment itself goes through the labor market via the
// FirmDemandRow gov emits each tick.
// =============================================================================

import type { FirmDemandRow, OfficeHolder, OfficeKind, OfficialView } from './types';

/** the civic org id econ folds into firmDemands() (sector unused — the
 *  Construction precedent). */
export const GOV_FIRM_ID = 'gov:office';
export const GOV_FIRM_NAME = 'Civic Office';
const CLERK_HEADCOUNT = 2;
const CLERK_MIN_SKILL = 0.2;
const CLERK_WAGE_MULT = 0.95;   // clerks earn just under the mean wage

interface OfficeRec {
  office: OfficeKind;
  holder: OfficeHolder;
  seatedAtH: number;
}

export class Officials {
  private seats: OfficeRec[] = [];

  seat(office: OfficeKind, holder: OfficeHolder, clock: number): void {
    this.seats.push({ office, holder, seatedAtH: clock });
  }

  unseat(office: OfficeKind): void {
    this.seats = this.seats.filter((s) => s.office !== office);
  }

  unseatAll(): void { this.seats = []; }

  steward(): OfficeRec | null {
    return this.seats.find((s) => s.office === 'steward') ?? null;
  }

  hasSteward(): boolean { return this.steward() !== null; }

  /** the labor demand the institution runs on. desired = 0 ⇒ the clerks quit
   *  (insolvency) — econ's fire path handles the rest. */
  clerkDemand(meanWage: number, desired: number): FirmDemandRow {
    return {
      id: GOV_FIRM_ID,
      name: GOV_FIRM_NAME,
      wage: Math.max(1, meanWage * CLERK_WAGE_MULT),
      desired,
      minSkill: CLERK_MIN_SKILL,
    };
  }

  clerkTarget(): number { return CLERK_HEADCOUNT; }

  view(): OfficialView[] {
    return this.seats.map((s) => ({ office: s.office, holder: { ...s.holder }, seatedAtH: s.seatedAtH }));
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return { v: 1, seats: this.seats.map((s) => ({ office: s.office, holder: s.holder, seatedAtH: Math.round(s.seatedAtH * 1e3) / 1e3 })) };
  }

  loadJSON(j: unknown): void {
    const o = j as { seats?: unknown } | null;
    if (!o || !Array.isArray(o.seats)) return;
    this.seats = [];
    for (const row of o.seats) {
      const s = row as OfficeRec | null;
      if (!s || (s.office !== 'steward' && s.office !== 'clerk') || !s.holder) continue;
      this.seats.push({ office: s.office, holder: s.holder, seatedAtH: typeof s.seatedAtH === 'number' ? s.seatedAtH : 0 });
    }
  }
}
