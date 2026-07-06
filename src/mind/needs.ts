// =============================================================================
// needs.ts — Maslow needs as a DERIVED READOUT of the soma (a mirror of
// computeCoreAffect / readEmotion), plus the UP-coupling that lets a deficit be
// *felt* in the body. The town's agency emerges from these deficits, but the
// deficits themselves are physiologically grounded — they are read off the
// substrate, never authored. Each need is a DEFICIT in [0,1] (1 = maximally
// unmet), so higher always means "more urgent".
//
// Channel conventions (see types.ts): neuromodulators/hormones carry a
// normalized tone with baseline ~1 over [0,4]; activations/drives live in
// [0,1]; dominance in [-1,1]; allostaticLoad in [0,50].
// =============================================================================
import type { SomaState, Resources, NeedsReadout, NeedsIntegrals, NeedTier, Physiology } from '../core/types';
import { eliminationUrgency } from './physiology';
import { clamp, sigmoid } from '../core/util/num';

// Deficit of a baseline-1 modulator: 0 at/above baseline, →1 as tone collapses.
const belowBaseline = (x: number) => clamp(1 - x, 0, 1);

// Maslow tiers, strictly low→high (prepotency order).
const TIERS: NeedTier[] = ['physiological', 'safety', 'belonging', 'esteem', 'actualization'];

// Intrinsic "loudness" of each tier before prepotency gating. Gently tapered so
// that, all deficits equal, a lower need still wins — but a large higher-tier
// deficit can dominate once the floors below it are reasonably met.
const TIER_BASE: Record<NeedTier, number> = {
  physiological: 1.0, safety: 0.95, belonging: 0.9, esteem: 0.85, actualization: 0.8,
};

export function computeNeeds(soma: SomaState, resources: Resources, phys?: Physiology): NeedsReadout {
  // --- physiological -------------------------------------------------------
  // hunger: the gut-energy reservoir is the CAUSE (satiety low ⇒ hungry). The
  // ghrelin tone it drives is a secondary read; a small anticipatory term reflects
  // an empty larder (nothing to cook), which recruits a grocery run before crisis.
  const bodyHunger = phys ? clamp(1 - phys.satiety, 0, 1) : clamp(0.55 * sigmoid(1.5 * (soma.ghrelin - 1)) + 0.45 * (resources.foodStock <= 0 ? 1 : 0.2), 0, 1);
  const hunger = clamp(bodyHunger * 0.8 + (resources.foodStock <= 0 && bodyHunger > 0.3 ? 0.25 : 0), 0, 1);
  // thirst: the osmostat reads dehydration directly (physiology writes soma.thirst).
  const thirst = clamp(soma.thirst, 0, 1);
  // elimination: a steep urgency near a full bladder/bowel (overrides when pressing).
  const elimination = phys ? eliminationUrgency(phys) : 0;
  // cleanliness: hygiene decays with time; a bath restores it.
  const cleanliness = phys ? clamp(1 - phys.hygiene, 0, 1) : 0;
  // sleep pressure as a slow scalar (debt of ~16h saturates the need).
  const sleepPressure = clamp(resources.sleepDebt / 16, 0, 1);
  // energy deficit: acute depletion (fatigue) lifted by accumulated sleep debt.
  const energy = clamp(soma.fatigue + 0.35 * sleepPressure, 0, 1);

  // --- safety --------------------------------------------------------------
  // somatic threat from the stress axis + fast salience + the chronic scar of
  // allostatic load (the exposome's memory of past unsafety).
  const threat = clamp(
    0.35 * clamp((soma.cortisol - 1) / 2, 0, 1) +
    0.40 * soma.amygdala +
    0.45 * soma.FEAR +
    0.10 * (soma.allostaticLoad / 50), // chronic scar contributes, but must not pin "unsafe"
    0, 1,
  );
  // financial precarity: rent looming with insufficient money to cover it.
  const financialStrain = clamp(
    resources.rentDue > 0 ? 1 - resources.money / (resources.rentDue + 1) : 0,
    0, 1,
  );
  // soft-OR blend: either the body's alarm OR material precarity can carry safety.
  const safety = clamp(threat + financialStrain * (1 - threat), 0, 1);

  // --- belonging -----------------------------------------------------------
  // separation distress (PANIC/GRIEF) plus the absence of the bonding/comfort
  // tone that close contact normally supplies (oxytocin, opioid below baseline).
  const belonging = clamp(
    1.3 * (0.50 * soma.PANIC_GRIEF + 0.30 * belowBaseline(soma.oxytocin) + 0.25 * belowBaseline(soma.opioid)),
    0, 1,
  );

  // --- esteem (INTERPRETIVE mapping) --------------------------------------
  // There is no "esteem hormone". We read esteem as an interpretive composite of
  // agentic standing in the body: low DOMINANCE (felt powerlessness/low status),
  // depleted mesocortical dopamine (da_cort — the competence/efficacy signal of
  // mastery & working-memory engagement), and a quiet PLAY system (no confident,
  // socially-rewarded self-expression). High on any axis = an unmet esteem need.
  const lowDominance = clamp(0.5 * (1 - soma.dominance), 0, 1); // [-1,1]→[1,0]
  const esteem = clamp(
    0.50 * lowDominance + 0.30 * belowBaseline(soma.da_cort) + 0.20 * (1 - clamp(soma.PLAY, 0, 1)),
    0, 1,
  );

  // --- actualization / novelty (INTERPRETIVE mapping) ----------------------
  // Self-actualization is operationalized as unmet exploratory drive: a soma with
  // little active SEEKING/PLAY expression is one whose growth/curiosity appetite
  // is going unfed. Simplest faithful proxy: 1 − how much the appetitive systems
  // are currently switched on.
  const novelty = clamp(1 - clamp(soma.SEEKING + soma.PLAY, 0, 1), 0, 1);

  const deficit: Record<NeedTier, number> = {
    // elimination & thirst can seize the physiological tier outright when urgent;
    // cleanliness is a softer physiological pull (weighted below the survival needs).
    physiological: Math.max(hunger, thirst, elimination, energy * 0.9, sleepPressure, cleanliness * 0.6),
    safety,
    belonging,
    esteem,
    actualization: novelty,
  };

  // --- Maslow prepotency: which tier OWNS the body right now? ---------------
  // w(tier) = base(tier) · ∏_{lower} (1 − 0.9·deficit[lower]); a satisfied lower
  // need opens a "gate" that lets the next tier matter. dominantTier maximizes
  // w(tier)·deficit[tier] — a higher need can only win once its floors are met.
  let gate = 1;
  let dominantTier: NeedTier = 'physiological';
  let bestScore = -1;
  for (const tier of TIERS) {
    const score = TIER_BASE[tier] * gate * deficit[tier];
    if (score > bestScore) { bestScore = score; dominantTier = tier; }
    gate *= clamp(1 - 0.6 * deficit[tier], 0.25, 1); // SOFT gate: Maslow is a tendency, not a lock
  }

  return { hunger, thirst, energy, elimination, cleanliness, safety, belonging, esteem, novelty, deficit, dominantTier };
}

export function emptyNeedIntegrals(): NeedsIntegrals {
  return { minutesHungry: 0, minutesThirsty: 0, minutesLonely: 0, minutesDepleted: 0, minutesUnsafe: 0 };
}

/** ∫ over deficit membership: accrue minutes whenever a need is genuinely unmet (>0.5). */
export function updateNeedIntegrals(m: NeedsIntegrals, n: NeedsReadout, dtHours: number): void {
  const min = dtHours * 60;
  if (n.hunger > 0.5) m.minutesHungry += min;
  if (n.thirst > 0.5) m.minutesThirsty += min;
  if (n.belonging > 0.5) m.minutesLonely += min;
  if (n.energy > 0.5) m.minutesDepleted += min;
  if (n.safety > 0.5) m.minutesUnsafe += min;
}

/**
 * UP coupling: close the needs↔soma loop by letting deficits push back on the
 * body each tick, so an unmet need is *felt* (and thus reshapes future affect &
 * appraisal) rather than being a passive label. Gains are small (~0.3–0.6/h) and
 * SATURATING — each impulse is scaled by the channel's remaining head-room, so it
 * eases off near the ceiling and never fights the channel's own decay too hard.
 * Every touched channel is re-clamped to its declared range.
 */
export function applyNeedFeedback(soma: SomaState, n: NeedsReadout, dtHours: number): void {
  const dt = dtHours;

  // hunger → orexigenic ghrelin (+ a little appetitive SEEKING: foraging wanting).
  const ghrelinHead = (4 - soma.ghrelin) / 4;
  soma.ghrelin = clamp(soma.ghrelin + n.hunger * 0.5 * dt * Math.max(0, ghrelinHead), 0, 4);
  soma.SEEKING = clamp(soma.SEEKING + n.hunger * 0.15 * dt * (1 - soma.SEEKING), 0, 1);

  // thirst + hunger jointly light the HYPOTHALAMUS — the homeostatic detector hub.
  // (ghrelin already drives it via the coupling graph; thirst adds an osmostat term.)
  soma.hypothalamus = clamp(soma.hypothalamus + (0.6 * n.thirst + 0.3 * n.hunger) * dt * (1 - soma.hypothalamus), 0, 1);
  soma.SEEKING = clamp(soma.SEEKING + n.thirst * 0.12 * dt * (1 - soma.SEEKING), 0, 1);

  // belonging → separation distress (PANIC/GRIEF) builds when contact is missing.
  soma.PANIC_GRIEF = clamp(soma.PANIC_GRIEF + n.belonging * 0.45 * dt * (1 - soma.PANIC_GRIEF), 0, 1);

  // novelty → exploratory drive (SEEKING) — an unfed mind reaches for stimulation.
  soma.SEEKING = clamp(soma.SEEKING + n.novelty * 0.5 * dt * (1 - soma.SEEKING), 0, 1);

  // safety → HPA stress hormone, but only once the need is acutely pressing, and
  // with a SMALL gain: a large gain creates a cortisol→threat→safety runaway that
  // pins "unsafe" forever. Kept gentle so the body can also recover.
  if (n.safety > 0.6) {
    const cortHead = (4 - soma.cortisol) / 4;
    soma.cortisol = clamp(soma.cortisol + (n.safety - 0.6) * 0.18 * dt * Math.max(0, cortHead), 0, 4);
  }

  // chronic compound deprivation leaves a slow scar — sustained unmet floors feed
  // the exposome's memory (allostaticLoad). Tiny gain so it only matters over time.
  const chronic = Math.max(0, n.deficit.physiological + n.safety + n.belonging - 1.4);
  soma.allostaticLoad = clamp(soma.allostaticLoad + chronic * 0.03 * dt, 0, 50);
}
