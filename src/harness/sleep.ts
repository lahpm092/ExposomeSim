// =============================================================================
// sleep.ts — sleep onset as a DERIVED readout of the soma, exactly like the
// cleaner's restUrgency or the office worker's talkPropensity. No hour is
// hardcoded: bedtime is a competition between
//   sleepPressure  = Process-S homeostatic drive (fatigue) + the circadian gate
//                    (melatonin, already forced by params.ts CIRCADIAN)
//   wakePull       = the arousal/stress axis (arousal · NE · cortisol) + phone
//                    engagement + an active conversation + an open work window
// and sleep EMERGES where pressure overtakes pull. An anxious phenotype (high
// cortisol → NE → arousal) therefore has a higher wakePull and a LATER, harder
// onset — "tired but wired" nights fall out of the same params that drive the
// daytime, never a scripted trait. A wrecked body's pull collapses so nobody
// latches awake forever (the insomnia safety valve).
//
// PURE & deterministic: reads soma channels Character.step already integrates;
// no writes, no RNG, no DOM. The caller applies onset/wake hysteresis.
// =============================================================================
import type { SomaState, SleepDrive } from '../types';
import { clamp } from '../util/num';

/** thin context the caller samples each beat. */
export interface SleepCtx {
  phone: number;          // 0..1 phone engagement pulling against sleep (onPhone → 1)
  talking: boolean;       // in a live conversation (won't nod off mid-chat)
  workWindowOpen: boolean;// the soft work window is open (a reason to stay up / get up)
}

/** the circadian sleep gate ∈ [0,1] read off melatonin (mean .80 / amp .70 / phase 3h):
 *  rises through ~0.95→1.40 across 21:00→00:00, falls below 0.95 by ~08:00. */
export function melatoninGate(soma: Pick<SomaState, 'melatonin'>): number {
  return clamp((soma.melatonin - 0.90) / 0.50, 0, 1);
}

/** homeostatic (Process S) + circadian push toward sleep ∈ [0,1]. The extra
 *  over-tiredness term makes an exhausted body dominate — no phenotype stays up forever. */
export function sleepPressure(soma: Pick<SomaState, 'melatonin' | 'fatigue'>): number {
  const melN = melatoninGate(soma);
  return clamp(0.60 * melN + 0.55 * soma.fatigue + 0.40 * Math.max(0, soma.fatigue - 0.85) - 0.10, 0, 1);
}

/** arousal/engagement pull AGAINST sleep ∈ [0,1], collapsed when over-tired. */
export function wakePull(
  soma: Pick<SomaState, 'arousal' | 'norepinephrine' | 'cortisol' | 'fatigue'>,
  ctx: SleepCtx,
): number {
  const aroN = clamp((soma.arousal - 0.35) / 0.45, 0, 1);
  const neOver = clamp(soma.norepinephrine - 1, 0, 1);
  const cortOver = clamp(soma.cortisol - 1, 0, 1);
  let W = clamp(
    0.40 * aroN + 0.30 * neOver + 0.30 * cortOver +
    0.75 * ctx.phone + (ctx.talking ? 1 : 0) + (ctx.workWindowOpen ? 0.5 : 0),
    0, 1,
  );
  // overtired collapse: past fatigue 0.90 the pull is scaled toward 0 (finally sleeps).
  W *= (1 - Math.min(1, Math.max(0, soma.fatigue - 0.90) / 0.10));
  return W;
}

/** the smoothstep decision variable ∈ [0,1] — same shape as restUrgency(). */
export function sleepPropensity(soma: SomaState, ctx: SleepCtx): number {
  const r = clamp(sleepPressure(soma) - wakePull(soma, ctx), 0, 1);
  return r * r * (3 - 2 * r);
}

/** build the readout for projection into AgentPublic. `asleep` is the caller's latch. */
export function sleepDriveOf(soma: SomaState, ctx: SleepCtx, asleep: boolean): SleepDrive {
  const pressure = sleepPressure(soma);
  const pull = wakePull(soma, ctx);
  const r = clamp(pressure - pull, 0, 1);
  return { pressure, wakePull: pull, propensity: r * r * (3 - 2 * r), asleep, melatonin: soma.melatonin };
}
