// =============================================================================
// socialaffect.ts — the ONE definition of social-reward physics, shared by every
// site where two minds affect each other: face-to-face conversation, the public
// social feed, and the office's internal coordination net. Extracting it here
// means an online "like" and an in-person warm beat move the SAME soma channels
// by the SAME rule — the online contact is just a weaker magnitude of the same
// physiology, never a different mechanism. (Verbatim from the original
// conversation.ts rewardSoma/threatSoma/somaWarmth so behaviour is unchanged.)
//
// Pure & deterministic: no DOM/THREE/RNG. Every touched channel is re-clamped.
// =============================================================================
import type { SomaState, BigFive } from '../types';
import { clamp, sigmoid } from '../util/num';

/** How warm a body currently is, in [-1,1]: high oxytocin/CARE and low amygdala
 *  read positive; a threatened body reads negative. */
export function somaWarmth(s: Pick<SomaState, 'oxytocin' | 'CARE' | 'amygdala'>): number {
  return clamp(0.5 * (s.oxytocin - 1) + 0.5 * s.CARE - 0.5 * s.amygdala, -1, 1);
}

/** The warm-beat reward: da/5HT, oxytocin, opioid and CARE up; amygdala/FEAR/PANIC
 *  down; cortisol eased toward tone. `warm` in (0,1] scales the whole nudge. */
export function socialReward(s: SomaState, warm: number): void {
  s.da_meso = clamp(s.da_meso + warm * 0.1, 0, 4);
  s.serotonin = clamp(s.serotonin + warm * 0.06, 0, 4);
  s.oxytocin = clamp(s.oxytocin + warm * 0.18, 0, 4);
  s.opioid = clamp(s.opioid + warm * 0.12, 0, 4);
  s.CARE = clamp(s.CARE + warm * 0.12, 0, 1);
  s.amygdala = clamp(s.amygdala * (1 - 0.22 * warm), 0, 1);
  s.FEAR = clamp(s.FEAR * (1 - 0.28 * warm), 0, 1);
  s.PANIC_GRIEF = clamp(s.PANIC_GRIEF * (1 - 0.3 * warm), 0, 1);
  s.cortisol = s.cortisol + (1 - s.cortisol) * 0.15 * warm;
}

/** A cold/awkward exchange: a mild threat nudge. `warm` is <= 0; magnitude = -warm. */
export function socialThreat(s: SomaState, warm: number): void {
  const bad = -warm;  // (0,1]
  s.amygdala = clamp(s.amygdala + bad * 0.08, 0, 1);
  s.FEAR = clamp(s.FEAR + bad * 0.05, 0, 1);
  s.cortisol = clamp(s.cortisol + bad * 0.06, 0, 4);
}

/** Big-Five pair compatibility in [0,1]: agreeable + extraverted warm it,
 *  neuroticism cools it. 0.5 at population-average traits. The single metric
 *  behind conversation warmth, feed resonance and net-coordination synergy. */
export function bigFiveCompat(fa: BigFive, fb: BigFive): number {
  const A = 0.5 * (fa.A + fb.A);
  const E = 0.5 * (fa.E + fb.E);
  const N = 0.5 * (fa.N + fb.N);
  return sigmoid(0.7 * A + 0.5 * E - 0.6 * N);
}
