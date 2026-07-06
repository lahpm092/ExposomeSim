// =============================================================================
// mindlite.ts — an ABSTRACTED psyche for interlocutors: the person the
// protagonist is talking to, simulated at LOWER causal resolution than her full
// ~33-channel soma. Where the protagonist integrates coupled SDEs, a MindLite
// carries seven coarse scalars with simple mood-inertia dynamics — enough to make
// an exchange two-sided (it pushes back, warms or sours) without paying for a
// second full nervous system. It is instantiated when an interaction begins and
// DISCARDED when it ends; only a one-line ledger gist survives.
//
// The coarse axes are collapsed from the full model's dimensions:
//   valence · arousal · dominance  ← core affect
//   warmth  (oxytocin·CARE)         ← the affiliative axis
//   threat  (amygdala·FEAR·cortisol)← the defensive axis
//   energy  · openness              ← disposition
// It exposes a soma-shaped VIEW so the shared relationship math reads it uniformly.
// =============================================================================
import type { Profile, SomaState, PartnerView } from '../core/types';
import { clamp } from '../core/util/num';

export interface MindLiteJSON {
  valence: number; arousal: number; dominance: number;
  warmth: number; threat: number; energy: number; openness: number;
}

export class MindLite {
  readonly name: string;
  // coarse state
  valence = 0; arousal = 0.4; dominance = 0;
  warmth = 0.5; threat = 0.15; energy = 0.6; openness = 0.5;
  // temperament set-points (mood reverts toward these)
  private readonly baseValence: number;
  private readonly baseThreat: number;
  private readonly warmthTendency: number;

  constructor(profile: Profile, opts: { carryValence?: number; carryWarmth?: number } = {}) {
    this.name = profile.name;
    const b = profile.bigFive;
    const att = profile.experiosome.attachment;
    const attThreat = att === 'anxious' ? 0.2 : att === 'disorganized' ? 0.3 : att === 'avoidant' ? 0.12 : 0.05;
    const attWarm = att === 'secure' ? 0.2 : att === 'avoidant' ? -0.2 : 0;

    this.baseValence = clamp(0.15 * b.E - 0.12 * b.N, -0.5, 0.5);
    this.baseThreat = clamp(0.12 + 0.14 * b.N + attThreat - 0.05 * b.E, 0, 0.8);
    this.warmthTendency = clamp(0.5 + 0.16 * b.A + attWarm, 0.1, 0.95);
    this.openness = clamp(0.5 + 0.15 * b.O, 0, 1);

    this.valence = clamp(this.baseValence + (opts.carryValence ?? 0) * 0.5, -1, 1);
    this.warmth = clamp(this.warmthTendency * 0.7 + (opts.carryWarmth ?? 0) * 0.4, 0, 1);
    this.threat = this.baseThreat;
  }

  /** fold one interaction beat: `warm ∈ [-1,1]` is how the exchange felt. */
  perceiveBeat(warm: number): void {
    const k = 0.5;
    this.valence = clamp(this.valence + k * (warm - this.valence), -1, 1);
    if (warm >= 0) {
      this.warmth = clamp(this.warmth + k * (warm * this.warmthTendency - (this.warmth - this.warmthTendency)), 0, 1);
      this.threat = clamp(this.threat * (1 - 0.35 * warm), 0, 1);
    } else {
      this.threat = clamp(this.threat + k * (-warm) * (0.4 + this.baseThreat), 0, 1);
      this.warmth = clamp(this.warmth * (1 + 0.2 * warm), 0, 1);
    }
    this.arousal = clamp(0.35 + 0.5 * Math.abs(warm) + 0.4 * this.threat, 0, 1);
    this.dominance = clamp(0.4 * this.valence - 0.6 * this.threat, -1, 1);
  }

  /** mood inertia: coarse mean-reversion toward temperament between beats. */
  step(dtHours: number): void {
    const k = clamp(dtHours * 1.5, 0, 0.5);
    this.valence += k * (this.baseValence - this.valence);
    this.threat += k * (this.baseThreat - this.threat);
    this.warmth += k * (this.warmthTendency * 0.6 - this.warmth);
    this.arousal += k * (0.4 - this.arousal);
  }

  /** a soma-shaped projection so the relationship math reads it like a full soma. */
  somaView(): Partial<SomaState> {
    return {
      valence: this.valence, arousal: this.arousal, dominance: this.dominance,
      oxytocin: 1 + this.warmth * 0.9,
      CARE: clamp(this.warmth, 0, 1),
      FEAR: clamp(this.threat, 0, 1),
      RAGE: clamp(Math.max(0, -this.valence) * this.threat, 0, 1),
      da_meso: 1 + Math.max(0, this.valence) * 0.4,
      LUST: 0,
      SEEKING: this.openness * 0.3,
      cortisol: 1 + this.threat * 0.9,
    };
  }

  // ---- persistence: the 7 coarse scalars (set-points recompute from the profile) --
  toJSON(): MindLiteJSON {
    return { valence: this.valence, arousal: this.arousal, dominance: this.dominance,
      warmth: this.warmth, threat: this.threat, energy: this.energy, openness: this.openness };
  }
  static fromJSON(profile: Profile, j: MindLiteJSON): MindLite {
    const m = new MindLite(profile);
    m.valence = j.valence; m.arousal = j.arousal; m.dominance = j.dominance;
    m.warmth = j.warmth; m.threat = j.threat; m.energy = j.energy; m.openness = j.openness;
    return m;
  }

  /** a coarse read for the renderer + dashboard. */
  view(): PartnerView {
    const v = this.valence, a = this.arousal;
    const label = this.threat > 0.5 ? 'wary'
      : v > 0.3 ? 'warm' : v < -0.25 ? 'cool'
      : a > 0.6 ? 'keyed up' : 'neutral';
    return { name: this.name, label, valence: v, arousal: a, dominance: this.dominance, warmth: this.warmth, threat: this.threat };
  }
}
