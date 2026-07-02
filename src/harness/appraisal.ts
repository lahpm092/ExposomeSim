// =============================================================================
// appraisal.ts — the symbolic bridge between meaning and physiology.
//   fastAppraise:   LeDoux "low road" — instant salience kick before cognition.
//   applyAppraisal: OCC/Scherer "high road" — the LLM's structured appraisal
//                   deterministically injects impulses into limbic/neuromod state.
//   applyRegulation: Gross's strategies modulate the soma after appraisal.
// All effects are impulses (added once when the event is processed).
// =============================================================================
import type { SomaState, SomaParams, SomaChannel, Appraisal, RegulationStrategy, WorldEvent } from '../types';
import { clamp } from '../util/num';
import { isModulator } from './params';

function clampVal(ch: SomaChannel, v: number): number {
  if (ch === 'allostaticLoad') return clamp(v, 0, 50);
  if (isModulator(ch)) return clamp(v, 0, 4);
  return clamp(v, 0, 1);
}
const add = (s: SomaState, ch: SomaChannel, d: number) => { (s[ch] as number) = clampVal(ch, (s[ch] as number) + d); };
const mul = (s: SomaState, ch: SomaChannel, f: number) => { (s[ch] as number) = clampVal(ch, (s[ch] as number) * f); };

/** Low road: a fast, pre-cognitive kick from the event's crude salience/valence tags. */
export function fastAppraise(soma: SomaState, params: SomaParams, ev: WorldEvent): void {
  const sal = clamp(ev.salienceHint ?? 0, 0, 1);
  const val = clamp(ev.valenceHint ?? 0, -1, 1);
  if (sal > 0) {
    add(soma, 'norepinephrine', sal * 0.26);
    add(soma, 'epinephrine', sal * 0.34);
    add(soma, 'insula', sal * 0.28);
    if (val < 0) add(soma, 'amygdala', sal * 0.36 * params.amygdalaGain * (-val));
  }
  if (val > 0) add(soma, 'nacc', val * 0.30 * params.rewardSensitivity);
}

/** High road: structured appraisal → physiological impulses. */
export function applyAppraisal(soma: SomaState, params: SomaParams, a: Appraisal): void {
  const rel = clamp(a.goalRelevance, 0, 1);

  // threat: relevant + goal-incongruent + uncoped
  const threat = rel * Math.max(0, -a.goalCongruence) * (1 - clamp(a.copingPotential, 0, 1));
  if (threat > 0) {
    add(soma, 'amygdala', threat * 0.7 * params.amygdalaGain);
    add(soma, 'FEAR', threat * 0.6 * params.amygdalaGain);
    add(soma, 'norepinephrine', threat * 0.3);
    add(soma, 'cortisol', threat * 0.3);
  }

  // reward: relevant + congruent + pleasant
  const reward = rel * Math.max(0, a.goalCongruence) * Math.max(0, a.pleasantness);
  if (reward > 0) {
    add(soma, 'nacc', reward * 0.6 * params.rewardSensitivity);
    add(soma, 'da_meso', reward * 0.4 * params.rewardSensitivity);
    add(soma, 'SEEKING', reward * 0.4);
    if (a.novelty > 0.5) add(soma, 'PLAY', reward * 0.3);
  }

  // anger: another agent is to blame for a goal-incongruent event
  if (a.agency === 'other' && a.blameworthiness < 0 && a.goalCongruence < 0) {
    const anger = Math.max(0, -a.blameworthiness) * Math.max(0, -a.goalCongruence);
    add(soma, 'RAGE', anger * 0.6);
    add(soma, 'norepinephrine', anger * 0.3);
  }

  // warmth / affiliation: prosocial, norm-upholding, pleasant
  if (a.agency === 'other' && a.normCompatibility > 0 && a.pleasantness > 0) {
    const warm = a.normCompatibility * a.pleasantness;
    add(soma, 'oxytocin', warm * 0.5 * params.oxytocinGain);
    add(soma, 'CARE', warm * 0.4);
    add(soma, 'opioid', warm * 0.2);
  }

  // grief / helplessness: uncontrollable loss with low coping
  if (a.agency === 'circumstance' && a.goalCongruence < 0 && a.copingPotential < 0.4) {
    const loss = Math.max(0, -a.goalCongruence) * (1 - a.copingPotential);
    add(soma, 'PANIC_GRIEF', loss * 0.4);
    add(soma, 'serotonin', -loss * 0.12);
    add(soma, 'da_meso', -loss * 0.12);
  }

  // novelty / orienting + control engagement
  add(soma, 'norepinephrine', clamp(a.novelty, 0, 1) * 0.15);
  add(soma, 'SEEKING', clamp(a.novelty, 0, 1) * 0.2);
  add(soma, 'dlPFC', clamp(a.copingPotential, 0, 1) * 0.2 * params.controlGain);

  // interoceptive intensity tracks total appraised significance
  add(soma, 'insula', clamp(threat + reward + 0.3 * Math.abs(a.pleasantness), 0, 1) * 0.4);
}

/** Emotion regulation modulates the soma after appraisal (Gross's process model). */
export function applyRegulation(soma: SomaState, params: SomaParams, strat: RegulationStrategy): void {
  const cg = params.controlGain;
  switch (strat) {
    case 'reappraisal': // vmPFC dampens the limbic response
      add(soma, 'vmPFC', 0.4 * cg);
      mul(soma, 'amygdala', 1 - 0.35 * clamp(cg, 0.4, 1.8) / 1.8);
      mul(soma, 'FEAR', 0.7); mul(soma, 'RAGE', 0.7);
      add(soma, 'cortisol', -0.1);
      add(soma, 'fatigue', 0.02);
      break;
    case 'suppression': // hide the expression; the body still pays
      add(soma, 'norepinephrine', 0.1); add(soma, 'cortisol', 0.05);
      add(soma, 'fatigue', 0.05); // effortful, depleting
      break;
    case 'rumination': // re-entry sustains and re-encodes the threat
      add(soma, 'amygdala', 0.1); add(soma, 'PANIC_GRIEF', 0.1);
      add(soma, 'cortisol', 0.1); add(soma, 'hippocampus', 0.1);
      break;
    case 'distraction':
      mul(soma, 'amygdala', 0.8); add(soma, 'dlPFC', 0.1);
      break;
    case 'acceptance':
      add(soma, 'vmPFC', 0.2); add(soma, 'gaba', 0.1); mul(soma, 'amygdala', 0.9);
      break;
    case 'situation-selection':
      mul(soma, 'amygdala', 0.85); add(soma, 'fatigue', 0.02);
      break;
    case 'none':
    default:
      break;
  }
}
