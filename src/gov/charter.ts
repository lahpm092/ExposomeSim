// =============================================================================
// ExposomeSim — CHARTER & BALLOTS: motions, conserved votes, legitimacy, recall.
// -----------------------------------------------------------------------------
// A charter is derived, never authored: the top grievance categories at the
// assembly become budget lines (the Company rederiveGoal bounded-reallocation
// rule is the aggregation template — shares drift toward what conditions
// justify, at most STEP per re-derivation, then renormalize). One small levy
// motion funds them; taxes exist only if voted.
//
// Ballots are the one machinery for everything — ratification, election,
// recall. Votes are CONSERVED INTEGER counts: Tier-A voters are discrete
// stance-gated draws, the shadow electorate is a Beta-binomial-style pair of
// rounded-normal draws (turnout ≤ N exactly, yes + no === cast exactly).
// A rival wing (bimodal stance distribution) mobilizes the NO side of any
// ballot — contested government, not scripted opposition.
//
// Legitimacy is an EMA pulled by delivered support and pushed by unmet
// grievance and insolvency. A low-legitimacy institution faces a recall
// HAZARD — rate-driven, so an unpopular steward may limp on for weeks or
// fall in days.
// =============================================================================

import { clamp, mulberry32, randn, type RNG } from '../core/util/num';
import type { BallotKind, BallotView, CivicCategory, SpendKind } from './types';
import { CIVIC_CATEGORIES } from './types';

const WINDOW_H = 48;         // ballot voting window
const HL_LEGIT = 48;         // legitimacy EMA half-life
const HL_RIVAL = 36;         // rival-wing mass EMA half-life
const RECALL_T = 0.35;       // recall hazard begins below this legitimacy
const RECALL_HAZ_PER_H = 0.03;
const BIMODAL_WING = 0.18;   // both wings above this share ⇒ bimodal
const STEP = 0.1;            // bounded reallocation step per re-derivation
const LEVY_PAYROLL = 0.03;   // the levy motion's rate (small; politics does the rest)
const MIN_LINE = 0.08;       // category score below this doesn't earn a budget line

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number) => clamp(x, 0, 1);

/** which budget line answers which grievance. */
const LINE_OF: Record<CivicCategory, SpendKind> = {
  jobs: 'civic-build', rent: 'relief', prices: 'relief', wages: 'relief',
  transit: 'transit-subsidy',
};

export interface Charter {
  levyPayroll: number;
  lines: { kind: SpendKind; share: number }[];
  ratifiedAtH: number;
}

interface Ballot {
  kind: BallotKind;
  topic: string;
  opensH: number;
  closesH: number;
  candidateId: string | null;
  eligible: number;
  resolved: boolean;
  passed: boolean;
  tierACast: number;
  shadowCast: number;
  yes: number;
  no: number;
}

export interface Electorate {
  tier: readonly { id: string; salience: number; support: number }[];
  shadowN: number;
  shadowSupportMean: number;
}

export class CharterProcess {
  private rng: RNG;
  private charter: Charter | null = null;
  private ballot: Ballot | null = null;
  private legit = 0;
  private rivalActive = false;
  private rivalMass = 0;

  constructor(seed: number) {
    this.rng = mulberry32(seed >>> 0);
  }

  // ---------------------------------------------------------------------------
  // motions — the assembly's stance vector becomes a draft charter.
  // ---------------------------------------------------------------------------
  draft(scores: Record<CivicCategory, number>, clock: number): Charter {
    const byLine = new Map<SpendKind, number>();
    for (const c of CIVIC_CATEGORIES) {
      if (scores[c] < MIN_LINE) continue;
      const k = LINE_OF[c];
      byLine.set(k, (byLine.get(k) ?? 0) + scores[c]);
    }
    if (!byLine.size) byLine.set('relief', 1);   // an assembly with no burning issue still relieves
    let total = 0;
    for (const v of byLine.values()) total += v;
    const lines = [...byLine.entries()].map(([kind, v]) => ({ kind, share: v / total }));
    this.charter = { levyPayroll: LEVY_PAYROLL, lines, ratifiedAtH: clock };
    return this.charter;
  }

  /** bounded reallocation toward current conditions (rederiveGoal template):
   *  each share moves at most STEP, new lines enter at the floor, renormalize. */
  rederive(scores: Record<CivicCategory, number>): void {
    const ch = this.charter;
    if (!ch) return;
    const byLine = new Map<SpendKind, number>();
    for (const c of CIVIC_CATEGORIES) {
      if (scores[c] < MIN_LINE) continue;
      const k = LINE_OF[c];
      byLine.set(k, (byLine.get(k) ?? 0) + scores[c]);
    }
    let total = 0;
    for (const v of byLine.values()) total += v;
    if (total <= 1e-9) return;                   // nothing justified — keep the standing shares
    for (const line of ch.lines) {
      const target = (byLine.get(line.kind) ?? 0) / total;
      line.share += clamp(target - line.share, -STEP, STEP);
      byLine.delete(line.kind);
    }
    for (const [kind, v] of byLine) ch.lines.push({ kind, share: Math.min(STEP, v / total) });
    let s = 0;
    for (const line of ch.lines) { line.share = Math.max(0, line.share); s += line.share; }
    if (s > 1e-9) for (const line of ch.lines) line.share /= s;
  }

  // ---------------------------------------------------------------------------
  // ballots — one machinery for ratify / elect / recall.
  // ---------------------------------------------------------------------------
  openBallot(kind: BallotKind, topic: string, clock: number, eligible: number, candidateId: string | null = null): void {
    this.ballot = {
      kind, topic, opensH: clock, closesH: clock + WINDOW_H, candidateId, eligible,
      resolved: false, passed: false, tierACast: 0, shadowCast: 0, yes: 0, no: 0,
    };
  }

  /** tally when the window closes. Conserved: yes+no === cast === tierACast +
   *  shadowCast ≤ eligible, all exact integers. Returns null until due. */
  tallyIfDue(clock: number, e: Electorate): Ballot | null {
    const b = this.ballot;
    if (!b || b.resolved || clock < b.closesH) return null;
    // a recall's YES is the anti-movement vote — supporters defend the steward.
    const sign = b.kind === 'recall' ? -1 : 1;

    // Tier-A: discrete, stance-gated draws (turnout rises with salience —
    // the disengaged skip civic life; the world's prepotency gate adds to this).
    for (const row of e.tier) {
      if (this.rng() >= clamp01(0.15 + 0.7 * row.salience)) continue;
      b.tierACast++;
      const pYes = clamp01(0.5 + 0.45 * sign * row.support);
      if (this.rng() < pYes) b.yes++; else b.no++;
    }

    // shadow: Beta-binomial via rounded-normal draws, exactly conserved.
    const m = e.shadowSupportMean;
    const tRate = clamp01(0.1 + 0.5 * Math.abs(m) + 0.3 * this.rivalMass);
    const cast = intBinomial(this.rng, e.shadowN, tRate);
    // rival mobilization tilts the NO side of pro-movement ballots (and the
    // YES side of a recall — same wing, same machinery).
    const pYes = clamp01(0.5 + 0.45 * sign * m - 0.25 * sign * this.rivalMass);
    const yes = intBinomial(this.rng, cast, pYes);
    b.shadowCast = cast;
    b.yes += yes;
    b.no += cast - yes;

    b.resolved = true;
    b.passed = b.yes > b.no && b.yes + b.no > 0;
    return b;
  }

  clearBallot(): void { this.ballot = null; }
  activeBallot(): BallotView | null { return this.ballot ? { ...this.ballot } : null; }
  hasCharter(): boolean { return this.charter !== null; }
  charterRec(): Charter | null { return this.charter; }
  dropCharter(): void { this.charter = null; }

  // ---------------------------------------------------------------------------
  // legitimacy + recall hazard + rival wing
  // ---------------------------------------------------------------------------
  setLegitimacy(x: number): void { this.legit = clamp01(x); }
  legitimacy(): number { return this.legit; }

  /** one EMA step toward what conditions justify. */
  stepLegitimacy(supportMean: number, grievance: number, insolvent: boolean, dtH: number): void {
    const drive = clamp01(0.55 + 0.5 * supportMean - 0.6 * Math.max(0, grievance - 0.25) - (insolvent ? 0.3 : 0));
    const lam = 1 - Math.pow(0.5, dtH / HL_LEGIT);
    this.legit += lam * (drive - this.legit);
  }

  /** rate-driven recall trigger — only meaningful while elected & no ballot runs. */
  recallHazard(dtH: number): boolean {
    if (this.legit >= RECALL_T) return false;
    const p = 1 - Math.exp(-RECALL_HAZ_PER_H * ((RECALL_T - this.legit) / RECALL_T) * dtH);
    return this.rng() < p;
  }

  /** bimodal stance distribution feeds a rival wing; unimodal opposition just
   *  drains legitimacy. Returns true on the tick the rival AWAKENS. */
  stepRival(wings: { pos: number; neg: number }, dtH: number): boolean {
    const bimodal = wings.pos >= BIMODAL_WING && wings.neg >= BIMODAL_WING;
    const target = bimodal ? wings.neg : 0;
    const lam = 1 - Math.pow(0.5, dtH / HL_RIVAL);
    this.rivalMass += lam * (target - this.rivalMass);
    const was = this.rivalActive;
    if (!this.rivalActive && bimodal && this.rivalMass > 0.1) this.rivalActive = true;
    else if (this.rivalActive && this.rivalMass < 0.04) this.rivalActive = false;
    return this.rivalActive && !was;
  }

  rival(): { active: boolean; mass: number } { return { active: this.rivalActive, mass: this.rivalMass }; }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      rng: this.rng.save ? this.rng.save() : 0,
      legit: r6(this.legit),
      rivalActive: this.rivalActive ? 1 : 0,
      rivalMass: r6(this.rivalMass),
      charter: this.charter
        ? { levyPayroll: this.charter.levyPayroll,
            lines: this.charter.lines.map((l) => ({ kind: l.kind, share: r6(l.share) })),
            ratifiedAtH: r6(this.charter.ratifiedAtH) }
        : null,
      ballot: this.ballot ? { ...this.ballot } : null,
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { rng?: number; legit?: number; rivalActive?: number; rivalMass?: number; charter?: Charter | null; ballot?: Ballot | null } | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    this.legit = typeof o.legit === 'number' ? o.legit : 0;
    this.rivalActive = o.rivalActive === 1;
    this.rivalMass = typeof o.rivalMass === 'number' ? o.rivalMass : 0;
    this.charter = o.charter && Array.isArray(o.charter.lines)
      ? { levyPayroll: o.charter.levyPayroll, ratifiedAtH: o.charter.ratifiedAtH,
          lines: o.charter.lines.map((l) => ({ kind: l.kind, share: l.share })) }
      : null;
    this.ballot = o.ballot && typeof o.ballot.kind === 'string' ? { ...o.ballot } : null;
  }
}

/** integer Binomial(n, p) via a rounded-normal draw — exact conservation is
 *  what matters here (0 ≤ k ≤ n), not distributional finesse at tiny n. */
function intBinomial(rng: RNG, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const mu = n * p;
  const k = Math.round(mu + Math.sqrt(mu * (1 - p)) * randn(rng));
  return k < 0 ? 0 : k > n ? n : k;
}
