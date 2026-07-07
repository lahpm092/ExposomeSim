// =============================================================================
// ExposomeSim — CIVIC OPINION: the two-tier stance field.
// -----------------------------------------------------------------------------
// Tier-A (roster characters): a side table keyed by profile.id (the types.ts:22
// invariant — never touch character.ts). Three floats per character:
//
//   grievance — relaxes toward what their MATERIAL conditions justify (own
//               wage/home/money row blended with the macro slice). No synthetic
//               complaints: no hardship, no grievance.
//   salience  — how present civic life is in their mind. It DECAYS (96h
//               half-life) and is only ever raised by real events: seeded
//               memories, civic conversations, feed engagement — plus an
//               AMPLIFICATION term (grievance × salience) that lets hardship
//               sustain an existing spark but never strike one. That asymmetry
//               is the whole thesis: without the seed, a 30-day recession
//               produces grievance and zero politics.
//   support   — stance toward collective action, [-1,1]. Pulled by grievance,
//               pushed back by taxes once levies bite (the comfortable-and-
//               taxed drift negative — recall pressure and rivals emerge from
//               this, not from a script).
//
// Shadow (households): two Float32Arrays (grievance, support) updated in one
// O(N) sweep per tick — relaxation toward the macro target, pairwise contagion
// mixing (dt-invariant event count with a carry), an agitation broadcast term
// (Tier-A civic activity radiates outward), decay mirroring decayBonds
// half-lives, and the tax drag. All draws from an owned, serialized mulberry32.
// =============================================================================

import { clamp, mulberry32, type RNG } from '../core/util/num';
import type { CivicCategory, GovMacroSlice, GovTickInput, TierAMaterialRow } from './types';
import { CIVIC_CATEGORIES } from './types';

// ---- rates (all per-sim-hour; EMAs via λ_eff = 1−0.5^(dt/halfLife)) ----------
const HL_GRIEV_A = 24;       // Tier-A grievance relaxation half-life
const HL_GRIEV_S = 24;       // shadow grievance relaxation half-life
const HL_SALIENCE = 96;      // salience decay half-life
const HL_SUPPORT_A = 48;     // Tier-A support relaxation half-life
const HL_SUPPORT_S = 168;    // shadow support decay half-life (~a week, decayBonds-like)
const AMP_PER_H = 0.024;     // grievance×salience amplification (break-even at g≈0.3)
const MIX_PER_H = 0.35;      // expected contagion encounters per household per hour
const PERSUADE_MIX = 0.22;   // per-encounter stance pull
const BCAST_PER_H = 0.05;    // agitation broadcast gain
const TAX_DRAG_PER_H = 0.045;// resentment per unit payroll rate on the un-aggrieved
const SEED_SALIENCE = 0.42;  // what a seeded civic memory set is worth at t0
const SEED_SUPPORT = 0.35;

const SALIENT_T = 0.2;       // who counts as "salient" for mass/percolation

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number) => clamp(x, 0, 1);

/** stateless per-index draw — resize-stable heterogeneity that never consumes
 *  the serialized stream. */
function hash01(seed: number, i: number): number {
  return mulberry32((seed ^ (i * 0x9e3779b9)) >>> 0)();
}

// ---- grievance categories from material conditions ----------------------------

/** per-category grievance scores, 0..1 — pure projection of the macro slice.
 *  These are what motions, hot topics and the shadow target all derive from. */
export function categoryScores(macro: GovMacroSlice, commuteCostIndex: number): Record<CivicCategory, number> {
  return {
    jobs: clamp01((macro.unemployment - 0.05) * 3.2),
    rent: clamp01((macro.rentBurden - 0.32) * 2.4 + macro.homeless * 4),
    prices: clamp01((macro.cpi - 1.03) * 3.5),
    wages: clamp01((macro.gini - 0.34) * 2.8),
    transit: clamp01(commuteCostIndex),
  };
}

/** the scalar grievance target the field relaxes toward — a soft-OR so one
 *  screaming category is enough, several mild ones compound. */
export function grievanceTarget(scores: Record<CivicCategory, number>): number {
  let miss = 1;
  for (const c of CIVIC_CATEGORIES) miss *= 1 - 0.75 * scores[c];
  return clamp01(1 - miss);
}

// ---- the field -----------------------------------------------------------------

interface TierARow {
  salience: number;
  grievance: number;
  support: number;
}

export class OpinionField {
  private rng: RNG;
  private readonly seed: number;

  private tier = new Map<string, TierARow>();
  private seededIds: string[] = [];

  private n = 0;                       // shadow household count (grows, never shrinks)
  private g = new Float32Array(0);     // shadow grievance
  private s = new Float32Array(0);     // shadow support
  private mixCarry = 0;                // fractional contagion events carried across ticks

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
  }

  // ---------------------------------------------------------------------------
  // seeding — called when (and only when) the world actually consumes the seed
  // plan. No call ⇒ no spark ⇒ the freedom check's dead field.
  // ---------------------------------------------------------------------------
  markSeeded(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.seededIds.includes(id)) continue;
      this.seededIds.push(id);
      const row = this.ensure(id);
      row.salience = Math.max(row.salience, SEED_SALIENCE);
      row.support = Math.max(row.support, SEED_SUPPORT);
    }
  }

  private ensure(id: string): TierARow {
    let row = this.tier.get(id);
    if (!row) { row = { salience: 0, grievance: 0, support: 0 }; this.tier.set(id, row); }
    return row;
  }

  // ---------------------------------------------------------------------------
  // discrete stance events (real, watched — they arrive from world channels).
  // ---------------------------------------------------------------------------

  /** civic conversation: warmth×trust persuasion + salience for both parties.
   *  Returns the applied deltas (the exchange record the world gets back). */
  applyConversation(aId: string, bId: string, warmth: number, trustAB: number, trustBA: number):
      { dA: number; dB: number; sA: number; sB: number } {
    const a = this.ensure(aId), b = this.ensure(bId);
    const w = clamp01(warmth);
    const dA = 0.35 * w * clamp01(trustAB) * (b.support - a.support);
    const dB = 0.35 * w * clamp01(trustBA) * (a.support - b.support);
    a.support = clamp(a.support + dA, -1, 1);
    b.support = clamp(b.support + dB, -1, 1);
    const bump = 0.05 * (0.5 + 0.5 * w);
    a.salience = clamp01(a.salience + bump);
    b.salience = clamp01(b.salience + bump);
    return { dA, dB, sA: a.support, sB: b.support };
  }

  /** feed engagement: reading/signing raises salience and pulls the reader a
   *  step toward the author's stance (broadcast persuasion, weaker than talk). */
  applyFeedEngagement(readerId: string, authorId: string, strong: boolean): void {
    const r = this.ensure(readerId);
    const author = this.tier.get(authorId);
    r.salience = clamp01(r.salience + (strong ? 0.05 : 0.025));
    if (author) r.support = clamp(r.support + 0.08 * (author.support - r.support), -1, 1);
  }

  // ---------------------------------------------------------------------------
  // tick — one O(tierA + shadowN) sweep. dt-invariant throughout.
  // ---------------------------------------------------------------------------
  tick(input: GovTickInput, gStar: number, agitation: number, payrollRate: number, dtH: number): void {
    if (!(dtH > 0)) return;
    this.ensureShadow(input.shadowHouseholds);
    const lamGA = 1 - Math.pow(0.5, dtH / HL_GRIEV_A);
    const lamGS = 1 - Math.pow(0.5, dtH / HL_GRIEV_S);
    const lamSup = 1 - Math.pow(0.5, dtH / HL_SUPPORT_A);
    const decSal = Math.pow(0.5, dtH / HL_SALIENCE);
    const decSupS = Math.pow(0.5, dtH / HL_SUPPORT_S);
    const meanWage = Math.max(input.macro.meanWage, 1e-6);

    // ---- Tier-A ---------------------------------------------------------------
    for (const row of input.tierA) {
      const r = this.ensure(row.id);
      const own = clamp01(
        (row.employed ? 0 : 0.5) + (row.homeless ? 0.5 : 0) +
        0.3 * clamp01(1 - row.money / (40 * meanWage)));
      const gTarget = clamp01(0.55 * own + 0.7 * gStar);
      r.grievance += lamGA * (gTarget - r.grievance);
      // salience: decay + amplification (sustains a spark, never strikes one)
      r.salience = clamp01(r.salience * decSal + AMP_PER_H * r.grievance * r.salience * dtH);
      // support: pulled by grievance, pushed back by taxes on the employed
      const sTarget = clamp(1.4 * r.grievance - 0.12 - (row.employed ? 6 * payrollRate : 0), -1, 1);
      r.support += lamSup * (sTarget - r.support);
    }

    // ---- shadow: relaxation + broadcast + tax drag (one pass) -----------------
    const bcast = BCAST_PER_H * agitation * dtH;
    const drag = TAX_DRAG_PER_H * payrollRate * dtH;
    for (let i = 0; i < this.n; i++) {
      const sens = 0.6 + 0.8 * hash01(this.seed, i);
      this.g[i] += lamGS * (clamp01(sens * gStar) - this.g[i]);
      const rec = 0.25 + 0.75 * this.g[i];
      let si = this.s[i] * decSupS;
      si += bcast * rec * (1 - si);
      si += drag * (1 - this.g[i]) * (-1 - si);   // taxes pull the comfortable toward opposition
      this.s[i] = clamp(si, -1, 1);
    }

    // ---- contagion mixing: dt-invariant event count with a carry --------------
    const want = this.n * MIX_PER_H * dtH + this.mixCarry;
    let events = Math.floor(want);
    this.mixCarry = want - events;
    if (this.n >= 2) {
      while (events-- > 0) {
        const i = (this.rng() * this.n) | 0;
        const j = (this.rng() * this.n) | 0;
        if (i === j) continue;
        const rec = 0.25 + 0.75 * this.g[i];
        this.s[i] = clamp(this.s[i] + PERSUADE_MIX * rec * (this.s[j] - this.s[i]), -1, 1);
      }
    } else {
      events = 0;
    }
  }

  private ensureShadow(n: number): void {
    if (n <= this.n) return;
    const g = new Float32Array(n), s = new Float32Array(n);
    g.set(this.g); s.set(this.s);
    this.g = g; this.s = s; this.n = n;
  }

  // ---------------------------------------------------------------------------
  // readouts
  // ---------------------------------------------------------------------------

  /** Σ salience × max(0, support) over the SALIENT Tier-A — the raw cluster
   *  mass the percolation factor weights (movement.ts). */
  tierMass(): number {
    let m = 0;
    for (const r of this.tier.values()) if (r.salience > SALIENT_T) m += r.salience * Math.max(0, r.support);
    return m;
  }

  salientIds(): string[] {
    const out: string[] = [];
    for (const [id, r] of this.tier) if (r.salience > SALIENT_T) out.push(id);
    return out;
  }

  maxSalience(): number {
    let m = 0;
    for (const r of this.tier.values()) if (r.salience > m) m = r.salience;
    return m;
  }

  salienceOf(id: string): number { return this.tier.get(id)?.salience ?? 0; }
  supportOf(id: string): number { return this.tier.get(id)?.support ?? 0; }
  grievanceOf(id: string): number { return this.tier.get(id)?.grievance ?? 0; }

  meanShadowSupport(): number {
    if (!this.n) return 0;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.s[i];
    return s / this.n;
  }

  meanShadowGrievance(): number {
    if (!this.n) return 0;
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.g[i];
    return s / this.n;
  }

  /** stance distribution wings over Tier-A ∪ shadow — the rival detector reads
   *  this: a movement with a real opposition wing is bimodal, not unpopular. */
  wingShares(): { pos: number; neg: number } {
    let pos = 0, neg = 0, total = 0;
    for (const r of this.tier.values()) {
      if (r.salience <= SALIENT_T * 0.5) continue;
      total++;
      if (r.support > 0.35) pos++;
      else if (r.support < -0.2) neg++;
    }
    for (let i = 0; i < this.n; i++) {
      total++;
      if (this.s[i] > 0.35) pos++;
      else if (this.s[i] < -0.2) neg++;
    }
    return total ? { pos: pos / total, neg: neg / total } : { pos: 0, neg: 0 };
  }

  /** support mean across both tiers (legitimacy's drive term). */
  meanSupportAll(): number {
    let s = 0, k = 0;
    for (const r of this.tier.values()) { s += r.support; k++; }
    for (let i = 0; i < this.n; i++) { s += this.s[i]; k++; }
    return k ? s / k : 0;
  }

  shadowN(): number { return this.n; }
  seeded(): readonly string[] { return this.seededIds; }

  rows(): { id: string; salience: number; grievance: number; support: number }[] {
    const out: { id: string; salience: number; grievance: number; support: number }[] = [];
    for (const [id, r] of this.tier) out.push({ id, salience: r6(r.salience), grievance: r6(r.grievance), support: r6(r.support) });
    return out;
  }

  // ---------------------------------------------------------------------------
  // persistence — the rng cursor, the carry and both tiers ARE the state.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      rng: this.rng.save ? this.rng.save() : 0,
      mixCarry: r6(this.mixCarry),
      seeded: this.seededIds.slice(),
      tier: [...this.tier.entries()].map(([id, r]) => [id, r6(r.salience), r6(r.grievance), r6(r.support)]),
      n: this.n,
      g: Array.from(this.g, r6),
      s: Array.from(this.s, r6),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { rng?: number; mixCarry?: number; seeded?: unknown; tier?: unknown; n?: number; g?: unknown; s?: unknown } | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    this.mixCarry = typeof o.mixCarry === 'number' ? o.mixCarry : 0;
    this.seededIds = Array.isArray(o.seeded) ? o.seeded.filter((x): x is string => typeof x === 'string') : [];
    this.tier.clear();
    if (Array.isArray(o.tier)) {
      for (const row of o.tier) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        this.tier.set(row[0], {
          salience: typeof row[1] === 'number' ? row[1] : 0,
          grievance: typeof row[2] === 'number' ? row[2] : 0,
          support: typeof row[3] === 'number' ? row[3] : 0,
        });
      }
    }
    this.n = typeof o.n === 'number' ? o.n | 0 : 0;
    this.g = new Float32Array(this.n);
    this.s = new Float32Array(this.n);
    if (Array.isArray(o.g)) for (let i = 0; i < Math.min(this.n, o.g.length); i++) { const x = o.g[i]; if (typeof x === 'number') this.g[i] = x; }
    if (Array.isArray(o.s)) for (let i = 0; i < Math.min(this.n, o.s.length); i++) { const x = o.s[i]; if (typeof x === 'number') this.s[i] = x; }
  }
}
