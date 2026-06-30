// =============================================================================
// params.ts — the science mapping.
// Profile (genotype × Big Five/CB5T × experiosome) → SomaParams (the physics).
// Also: population sampling of profiles, and a hand-authored protagonist.
//
// Effect sizes here are deliberately MODEST and interpretable. Candidate-gene
// associations are small and partly non-replicating (esp. 5-HTTLPR×stress);
// we use them as readable knobs, not as determinism. See HARNESS_DESIGN.md.
// =============================================================================
import type {
  Profile, SomaParams, SomaChannel, CircadianTerm, CouplingEdge, Genotype,
  BigFive, Experiosome, Attachment,
} from '../types';
import { clamp, mulberry32, randn, weightedPick, type RNG } from '../util/num';

// --- channel taxonomy (modulators are centered at 1; activations at 0) --------
export const MODULATOR_CHANNELS: SomaChannel[] = [
  'da_meso', 'da_cort', 'serotonin', 'norepinephrine', 'gaba', 'glutamate',
  'oxytocin', 'opioid', 'endocannabinoid', 'cortisol', 'melatonin',
  'epinephrine', 'ghrelin', 'leptin',
];
const MOD_SET = new Set<SomaChannel>(MODULATOR_CHANNELS);
export const isModulator = (ch: SomaChannel) => MOD_SET.has(ch);

// channels that are integrated each tick (everything except clock + derived affect)
export const INTEGRATED_CHANNELS: SomaChannel[] = [
  'amygdala', 'hippocampus', 'vmPFC', 'dlPFC', 'nacc', 'insula', 'hypothalamus',
  ...MODULATOR_CHANNELS,
  'SEEKING', 'FEAR', 'RAGE', 'CARE', 'PANIC_GRIEF', 'PLAY', 'LUST',
  'allostaticLoad', 'fatigue',
];

/** rest baseline a channel reverts toward when no circadian term overrides it */
export function defaultBaseline(ch: SomaChannel): number {
  if (isModulator(ch)) return 1; // normalized tone
  return 0; // activations & drives rest at 0
}

// --- base (population-average) rate constants, per simulated hour --------------
const BASE_DECAY: Partial<Record<SomaChannel, number>> = {
  amygdala: 5, hippocampus: 3, vmPFC: 5, dlPFC: 5, nacc: 4, insula: 5, hypothalamus: 3,
  da_meso: 2.5, da_cort: 2, serotonin: 1.2, norepinephrine: 3.5, gaba: 2, glutamate: 3,
  oxytocin: 3, opioid: 3, endocannabinoid: 2,
  cortisol: 1.5, melatonin: 1.0, epinephrine: 8, ghrelin: 0.8, leptin: 0.8,
  SEEKING: 2, FEAR: 3, RAGE: 3.5, CARE: 2.5, PANIC_GRIEF: 1.5, PLAY: 3, LUST: 2,
  allostaticLoad: 0.0015, fatigue: 0.03,
};

const BASE_NOISE: Partial<Record<SomaChannel, number>> = {
  amygdala: 0.05, nacc: 0.04, insula: 0.04,
  da_meso: 0.06, da_cort: 0.05, serotonin: 0.04, norepinephrine: 0.06, gaba: 0.04,
  oxytocin: 0.04, opioid: 0.03, endocannabinoid: 0.03,
  cortisol: 0.07, melatonin: 0.05, epinephrine: 0.05,
  SEEKING: 0.04, FEAR: 0.04, RAGE: 0.04, CARE: 0.03, PANIC_GRIEF: 0.03, PLAY: 0.04,
};

// circadian forcing: baseline(t) = mean + amplitude·cos(2π (t − phaseHours)/24)
// (single-harmonic cosine — a deliberate approximation; real cortisol is skewed.)
const CIRCADIAN: Partial<Record<SomaChannel, CircadianTerm>> = {
  cortisol:       { mean: 1.00, amplitude: 0.55, phaseHours: 8 },  // peak ~ waking (CAR)
  melatonin:      { mean: 0.80, amplitude: 0.70, phaseHours: 3 },  // peak deep night
  da_meso:        { mean: 1.00, amplitude: 0.12, phaseHours: 14 },
  serotonin:      { mean: 1.00, amplitude: 0.10, phaseHours: 13 }, // higher in daylight
  norepinephrine: { mean: 1.00, amplitude: 0.18, phaseHours: 11 },
};

// universal cross-channel couplings (individualization rides on the gains below
// and on per-channel decay scaling — not on rewiring this graph).
const BASE_COUPLINGS: CouplingEdge[] = [
  { from: 'amygdala', to: 'cortisol', weight: 0.9 },       // HPA drive (CRH→ACTH→cortisol)
  { from: 'amygdala', to: 'norepinephrine', weight: 0.6 },
  { from: 'vmPFC', to: 'amygdala', weight: -0.8 },         // top-down regulation
  { from: 'dlPFC', to: 'amygdala', weight: -0.4 },
  { from: 'serotonin', to: 'amygdala', weight: -0.5 },
  { from: 'gaba', to: 'amygdala', weight: -0.6 },
  { from: 'gaba', to: 'norepinephrine', weight: -0.3 },
  { from: 'cortisol', to: 'amygdala', weight: 0.25 },      // stress sensitization
  { from: 'cortisol', to: 'hippocampus', weight: -0.3 },
  { from: 'oxytocin', to: 'amygdala', weight: -0.4 },      // social buffering
  { from: 'oxytocin', to: 'CARE', weight: 0.5 },
  { from: 'da_meso', to: 'nacc', weight: 0.7 },
  { from: 'da_meso', to: 'SEEKING', weight: 0.5 },
  { from: 'nacc', to: 'SEEKING', weight: 0.3 },
  { from: 'melatonin', to: 'norepinephrine', weight: -0.3 },
  { from: 'melatonin', to: 'da_meso', weight: -0.2 },
  { from: 'fatigue', to: 'dlPFC', weight: -0.5 },
  { from: 'fatigue', to: 'da_meso', weight: -0.2 },
  { from: 'allostaticLoad', to: 'amygdala', weight: 0.15 },
  { from: 'allostaticLoad', to: 'serotonin', weight: -0.15 },
  { from: 'allostaticLoad', to: 'da_meso', weight: -0.12 },
  { from: 'endocannabinoid', to: 'amygdala', weight: -0.3 },
  { from: 'opioid', to: 'PANIC_GRIEF', weight: -0.4 },
  { from: 'FEAR', to: 'amygdala', weight: 0.4 },
  { from: 'RAGE', to: 'norepinephrine', weight: 0.3 },
];

const ATTACH_THREAT: Record<Attachment, number> = { secure: -0.10, avoidant: 0.10, anxious: 0.28, disorganized: 0.42 };
const ATTACH_OXT: Record<Attachment, number> = { secure: 0.20, avoidant: -0.25, anxious: 0.05, disorganized: -0.15 };

/**
 * The core mapping. CB5T (DeYoung) ties Big Five to neuromodulator systems:
 *   N↔threat/serotonin, E↔dopamine/reward, C↔prefrontal control,
 *   A↔oxytocin/empathy, O↔dopaminergic flexibility.
 */
export function deriveParams(profile: Profile): SomaParams {
  const g = profile.genotype;
  const b = profile.bigFive;
  const x = profile.experiosome;

  const d2Density = clamp(1.0 - 0.16 * g.DRD2_Taq1A, 0.5, 1.2);
  const daClearancePFC = clamp(1.0 - 0.12 * g.COMT_Met, 0.7, 1.05);

  const amygdalaGain = clamp(
    1 + 0.30 * b.N + 0.10 * g.HTTLPR_S + 0.05 * x.aceScore + ATTACH_THREAT[x.attachment] - 0.06 * x.ses,
    0.4, 2.6,
  );
  const hpaFeedbackGain = clamp(
    1 - 0.14 * g.FKBP5_risk - 0.04 * x.aceScore - 0.05 * (x.attachment === 'disorganized' ? 1 : 0) + 0.03 * b.C,
    0.35, 1.4,
  );
  const rewardSensitivity = clamp(
    1 + 0.22 * b.E + 0.08 * g.DRD4_7R + 0.5 * (d2Density - 1) - 0.06 * x.aceScore,
    0.4, 2.0,
  );
  const oxytocinGain = clamp(1 + 0.22 * b.A - 0.10 * g.OXTR_A + ATTACH_OXT[x.attachment], 0.4, 1.8);
  const controlGain = clamp(1 + 0.28 * b.C + 0.05 * g.COMT_Met - 0.08 * x.aceScore + 0.05 * x.ses, 0.4, 1.8);
  const recoveryRate = clamp(1 - 0.28 * b.N + 0.10 * b.C, 0.35, 1.6);

  // individualize decay: neuroticism slows affective recovery; FKBP5 weakens HPA feedback
  const decay: Partial<Record<SomaChannel, number>> = { ...BASE_DECAY };
  for (const ch of ['amygdala', 'FEAR', 'RAGE', 'PANIC_GRIEF'] as SomaChannel[]) {
    decay[ch] = (BASE_DECAY[ch] ?? 3) * recoveryRate;
  }
  decay.cortisol = (BASE_DECAY.cortisol ?? 1.5) * hpaFeedbackGain;
  decay.serotonin = (BASE_DECAY.serotonin ?? 1.2) * clamp(1 - 0.1 * b.N, 0.6, 1.2);

  // experiosome shifts a couple of baselines via the circadian "mean" (set-point)
  const circadian: Partial<Record<SomaChannel, CircadianTerm>> = JSON.parse(JSON.stringify(CIRCADIAN));
  if (circadian.cortisol) circadian.cortisol.mean += clamp(0.04 * x.aceScore - 0.03 * x.ses, -0.2, 0.4);
  if (circadian.serotonin) circadian.serotonin.mean -= clamp(0.03 * x.aceScore, 0, 0.2);

  return {
    decay,
    circadian,
    noise: { ...BASE_NOISE },
    couplings: BASE_COUPLINGS,
    amygdalaGain, hpaFeedbackGain, d2Density, daClearancePFC,
    rewardSensitivity, oxytocinGain, controlGain, recoveryRate,
  };
}

// ---------------------------------------------------------------------------
// Population sampling — draw a person from joint distributions.
// ---------------------------------------------------------------------------
const binom2 = (rng: RNG, p: number): 0 | 1 | 2 =>
  ((rng() < p ? 1 : 0) + (rng() < p ? 1 : 0)) as 0 | 1 | 2;

function sampleGenotype(rng: RNG): Genotype {
  return {
    COMT_Met: binom2(rng, 0.5),
    DRD2_Taq1A: binom2(rng, 0.2),
    DRD4_7R: binom2(rng, 0.2),
    DAT1_VNTR: binom2(rng, 0.25),
    HTTLPR_S: binom2(rng, 0.45),
    BDNF_Met: binom2(rng, 0.2),
    FKBP5_risk: binom2(rng, 0.35),
    OXTR_A: binom2(rng, 0.4),
    MAOA_low: binom2(rng, 0.35),
    CYP2D6: weightedPick(rng, [
      ['extensive', 0.70], ['intermediate', 0.15], ['poor', 0.07], ['ultrarapid', 0.08],
    ]),
  };
}

const NAMES = ['Mara', 'Eli', 'Nadia', 'Tomas', 'Priya', 'Jonah', 'Yuki', 'Dario', 'Lena', 'Omar', 'Ines', 'Cole'];
const STRESSORS = ['rent overdue', 'sick parent', 'tuition debt', 'recent breakup', 'immigration paperwork', 'a custody fight'];
const SEED_MEMS = ['was praised by a teacher once', 'got yelled at by a former manager', 'a friend moved away last month', 'aced an exam recently'];

export function sampleProfile(seed: number): Profile {
  const rng = mulberry32(seed);
  const bigFive: BigFive = { O: randn(rng), C: randn(rng), E: randn(rng), A: randn(rng), N: randn(rng) };
  const attachment = weightedPick<Attachment>(rng, [
    ['secure', 0.58], ['avoidant', 0.20], ['anxious', 0.15], ['disorganized', 0.07],
  ]);
  const aceScore = clamp(Math.round(randn(rng) * 1.4 + 0.9), 0, 10);
  const experiosome: Experiosome = {
    attachment, aceScore, ses: randn(rng),
    chronicStressors: aceScore > 1 ? [STRESSORS[Math.floor(rng() * STRESSORS.length)]] : [],
    formativeMemories: [SEED_MEMS[Math.floor(rng() * SEED_MEMS.length)]],
  };
  const name = NAMES[Math.floor(rng() * NAMES.length)];
  return {
    id: `npc-${seed}`,
    name,
    age: 18 + Math.floor(rng() * 42),
    role: 'customer',
    backstory: `${name}, ${attachment}-attached, came in to grab food.`,
    goals: ['get my order right', 'not waste time'],
    genotype: sampleGenotype(rng),
    bigFive, experiosome,
  };
}

// The protagonist of field study I. Hand-authored to be psychologically vivid:
// conscientious & warm but anxious and depleted, with a low-D2 reward system
// (DRD2 A1) and an elevated HPA set-point from childhood adversity.
export const CASHIER_PROFILE: Profile = {
  id: 'cashier-mara',
  name: 'Mara Voss',
  age: 24,
  role: 'cashier',
  backstory:
    'Mara works the register at a burger counter on a double shift, saving for nursing school ' +
    'while caring for her ill mother. She is warm and dutiful but runs close to empty; criticism ' +
    'lands hard and lingers. She wants to be kind, and resents that exhaustion keeps getting in the way.',
  goals: ['get through the shift without a mistake', 'be genuinely kind to people', 'keep the line moving', 'save enough for tuition'],
  genotype: {
    COMT_Met: 2,      // "worrier": high prefrontal DA, sharp but stress-sensitive
    DRD2_Taq1A: 1,    // reduced striatal D2 density → muted reward, prone to anhedonia
    DRD4_7R: 0,
    DAT1_VNTR: 1,
    HTTLPR_S: 2,      // short/short → high amygdala reactivity (contested, used as a knob)
    BDNF_Met: 1,
    FKBP5_risk: 1,    // somewhat blunted HPA negative feedback
    OXTR_A: 0,        // intact social-reward sensitivity
    MAOA_low: 0,
    CYP2D6: 'extensive',
  },
  bigFive: { O: 0.3, C: 1.1, E: -0.2, A: 1.3, N: 1.2 },
  experiosome: {
    attachment: 'anxious',
    aceScore: 3,
    ses: -0.8,
    chronicStressors: ['mother’s illness', 'tuition debt', 'chronic sleep debt'],
    formativeMemories: [
      'A manager once humiliated her in front of customers; she still hears it.',
      'A regular customer learned her name and it made her whole week.',
    ],
  },
};
