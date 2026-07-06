// =============================================================================
// premises.ts — the CommercialRegistry: commercial real estate as REAL units.
// Construction completions mint CommercialUnits (shopfront = 2, workshop = 1);
// entrant firms that need premises queue as PENDING (operating "from home" at
// reduced capacity) until they lease the cheapest vacant unit; the lease is a
// real transfer each RENT_PERIOD (tenant cash → owner construction firm cash),
// replacing the tenant's generic commercialRent leak. This registry only keeps
// the BOOKS (units, tenancy, the pending queue) — the orchestrator moves every
// dollar and mutates the firms/buildings, so conservation stays in one place.
//
// PURE + deterministic; everything round-trips toJSON/loadJSON.
// =============================================================================

import type { BusinessId, CommercialUnit, PremisesView } from './types';

export class CommercialRegistry {
  private units: CommercialUnit[] = [];
  /** founding-order queue of firms waiting for premises. */
  private pending: BusinessId[] = [];
  private leasesCum = 0;
  private unitSeq = 0;

  // ---- units ----------------------------------------------------------------
  /** mint one unit (a construction completion, or a seeded t0 building). */
  addUnit(u: Omit<CommercialUnit, 'id'> & { id?: string }): CommercialUnit {
    const unit: CommercialUnit = { id: u.id ?? 'cu' + (this.unitSeq++).toString(36), ...u };
    this.units.push(unit);
    return unit;
  }

  unitById(id: string): CommercialUnit | undefined { return this.units.find((u) => u.id === id); }
  allUnits(): readonly CommercialUnit[] { return this.units; }

  vacantCount(): number {
    let n = 0;
    for (const u of this.units) if (!u.tenantId) n++;
    return n;
  }

  /** the cheapest vacant unit (the one a queueing entrant leases first). */
  cheapestVacant(): CommercialUnit | undefined {
    let best: CommercialUnit | undefined;
    for (const u of this.units) {
      if (u.tenantId) continue;
      if (!best || u.rent < best.rent) best = u;
    }
    return best;
  }

  // ---- the pending queue ------------------------------------------------------
  enqueue(id: BusinessId): void { if (!this.pending.includes(id)) this.pending.push(id); }
  dequeue(id: BusinessId): void {
    const i = this.pending.indexOf(id);
    if (i >= 0) this.pending.splice(i, 1);
  }
  get pendingIds(): readonly BusinessId[] { return this.pending; }
  pendingCount(): number { return this.pending.length; }

  /** sign the lease: bind tenant ↔ unit and stamp the tenant's archetype on the
   *  unit (the orchestrator mirrors it onto the Building + firm). */
  lease(unit: CommercialUnit, tenantId: BusinessId, archetype?: string): void {
    unit.tenantId = tenantId;
    if (archetype) unit.archetype = archetype;
    this.dequeue(tenantId);
    this.leasesCum++;
  }

  /** tenant exit/bankruptcy: the unit reverts to vacant (the shop shell keeps
   *  its archetype — the next tenant inherits the fit-out). */
  release(tenantId: BusinessId): void {
    for (const u of this.units) if (u.tenantId === tenantId) u.tenantId = undefined;
    this.dequeue(tenantId);
  }

  unitOfTenant(tenantId: BusinessId): CommercialUnit | undefined {
    return this.units.find((u) => u.tenantId === tenantId);
  }

  // ---- readout ------------------------------------------------------------------
  view(): PremisesView {
    return {
      units: this.units.length,
      vacant: this.vacantCount(),
      pending: this.pending.length,
      leases: this.leasesCum,
    };
  }

  // ---- persistence ----------------------------------------------------------------
  toJSON(): unknown {
    return { units: this.units, pending: this.pending, leases: this.leasesCum, seq: this.unitSeq };
  }
  loadJSON(j: unknown): void {
    const o = j as { units?: CommercialUnit[]; pending?: BusinessId[]; leases?: number; seq?: number } | null;
    if (!o) return;
    if (Array.isArray(o.units)) this.units = o.units;
    this.pending = Array.isArray(o.pending) ? o.pending : [];
    this.leasesCum = typeof o.leases === 'number' ? o.leases : 0;
    this.unitSeq = typeof o.seq === 'number' ? o.seq : this.units.length;
  }
}
