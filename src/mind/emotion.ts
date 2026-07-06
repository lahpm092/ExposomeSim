// =============================================================================
// emotion.ts — construct a discrete emotion from core affect (Barrett), and
// accumulate the exposome metrics: time-integrals of affective states.
// The readout is PHYSIOLOGICALLY grounded (from the soma), independent of what
// the LLM narrates — so the metrics measure the substrate, not the prose.
// =============================================================================
import type { SomaState, EmotionReadout, EmotionIntegrals } from '../core/types';
import { clamp } from '../core/util/num';

export function readEmotion(soma: SomaState): EmotionReadout {
  const v = soma.valence, a = soma.arousal, d = soma.dominance;
  let label: string;

  if (a > 0.6 && v < -0.15) {
    if (d < 0.0) label = soma.FEAR > 0.3 ? 'afraid' : 'anxious';
    else label = soma.RAGE > 0.3 ? 'angry' : 'frustrated';
  } else if (a < 0.42 && v < -0.2) {
    if (soma.da_meso < 0.85 && soma.PANIC_GRIEF > 0.25) label = 'despondent';
    else label = v < -0.45 ? 'sad' : 'low';
  } else if (v > 0.25 && a > 0.55) {
    label = soma.PLAY > 0.3 ? 'delighted' : 'excited';
  } else if (v > 0.2) {
    label = 'content';
  } else if (v > 0.05) {
    label = 'at ease';
  } else if (a > 0.6) {
    label = 'keyed up';
  } else {
    label = 'neutral';
  }

  const intensity = clamp(
    0.5 * Math.abs(v) + 0.6 * Math.abs(a - 0.45) + 0.3 * Math.abs(d) + 0.3 * soma.amygdala,
    0, 1,
  );
  return { label, valence: v, arousal: a, dominance: d, intensity };
}

export function emptyIntegrals(): EmotionIntegrals {
  return {
    minutesAnxious: 0, minutesDepressed: 0, minutesContent: 0, minutesAngry: 0, minutesJoyful: 0,
    cumulativeStress: 0, cumulativeReward: 0, allostaticLoad: 0,
  };
}

/** ∫ over affective-state membership. dtHours is the elapsed sim time this tick. */
export function updateIntegrals(m: EmotionIntegrals, soma: SomaState, dtHours: number): void {
  const min = dtHours * 60;
  const v = soma.valence, a = soma.arousal, d = soma.dominance;

  if (a > 0.55 && v < -0.12 && d < 0.1) m.minutesAnxious += min;
  if (a < 0.45 && v < -0.18 && soma.da_meso < 0.9) m.minutesDepressed += min;
  if (v > 0.15 && a < 0.6) m.minutesContent += min;
  if (v < -0.05 && a > 0.5 && (soma.RAGE > 0.25 || d > 0.25)) m.minutesAngry += min;
  if (v > 0.3 && a > 0.5) m.minutesJoyful += min;

  m.cumulativeStress += Math.max(0, soma.cortisol - 1) * min;
  m.cumulativeReward += Math.max(0, soma.da_meso - 1) * min;
  m.allostaticLoad = soma.allostaticLoad;
}
