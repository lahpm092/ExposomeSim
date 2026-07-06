// =============================================================================
// workpsych.ts — WORK-PSYCHOLOGY as a DERIVED READOUT of the soma (a mirror of
// computeNeeds / computeCoreAffect), plus the gentle DOWN-coupling that lets the
// felt state of a job push back on the body. Nothing here is scripted: boredom,
// stimulation and work-anxiety are read off the substrate + a thin role context
// (WorkCtx) and integrated in place; the cleaner's standing-fatigue is a genuine
// differential equation. The caller turns the resulting PROPENSITIES into moment-
// to-moment behaviour (work vs. talk vs. rest) by comparing them against its own
// noise/thresholds — no decision is taken in this module.
//
// Channel conventions (see types.ts): WorkPsych.{boredom,stimulation,workAnxiety,
// cleanerFatigue} ∈ [0,1]; standingHours is continuous hours on-feet. Soma
// neuromodulators/hormones carry a normalized tone with baseline ~1 over [0,4];
// activations/drives (arousal, SEEKING, FEAR, amygdala, fatigue) live in [0,1].
//
// PURE module: no DOM/THREE/RNG/I-O. Deterministic. Every touched channel is
// re-clamped to its declared range; every nudge is scaled by ctx.dtHours and kept
// SMALL so the soma SDE (stable to k≈8/h) is never fought.
// =============================================================================
import type { SomaState, WorkPsych } from '../core/types';
import { clamp, lerp } from '../core/util/num';

// ---------------------------------------------------------------------------
// Rate constants (all per sim-hour unless noted).
// ---------------------------------------------------------------------------
const K_BORED_UP = 0.5;    // monotony accrues slowly on task
const K_BORED_DOWN = 2.5;  // conversation / novelty dissolves it fast (5×)
const K_SMOOTH = 3;        // 1st-order smoothing rate for stimulation & anxiety
const K_FAT_UP = 0.32;     // standing-fatigue build rate (an evening shift saturates it)
const K_FAT_DOWN = 0.5;    // sitting recovers faster than standing builds
const K_FAT_IDLE = 0.05;   // mild off-shift decay
const K_STAND_RELAX = 2;   // how fast standingHours unwinds while resting

// Soma-feedback gains (small; each impulse is a fractional pull toward a target).
const G_DA = 0.15;         // boredom drains mesolimbic reward toward DA_LO
const G_SEEK = 0.15;       // boredom recruits stimulus-seeking
const G_AMY = 0.12;        // anxiety lifts amygdala toward AMY_HI
const G_CORT = 0.12;       // anxiety lifts cortisol toward CORT_HI
const G_FAT = 0.20;        // standing-fatigue bleeds into somatic fatigue (up only)

// Feedback targets (channel-space).
const DA_LO = 0.7;         // reward tone a bored mind sags toward (baseline is 1)
const AMY_HI = 0.85;       // threat activation felt job-pressure pulls toward
const CORT_HI = 1.6;       // stress-hormone tone felt job-pressure pulls toward

/** Fractional approach of `cur` toward `target` by rate `t`, `t` clamped to [0,1]. */
const approach = (cur: number, target: number, t: number): number =>
  lerp(cur, target, clamp(t, 0, 1));

/** Zeroed start: no standing history, a mild baseline of engagement. */
export function createWorkPsych(): WorkPsych {
  return { boredom: 0, stimulation: 0.2, workAnxiety: 0, standingHours: 0, cleanerFatigue: 0 };
}

/**
 * Integrate the work-psych state one step and close the loop with a gentle soma
 * feedback. Mutates `wp` (and, softly, `soma`) in place.
 */
export function stepWorkPsych(wp: WorkPsych, soma: SomaState, ctx: WorkCtx): void {
  const dt = ctx.dtHours;

  // --- boredom: monotony integrator ----------------------------------------
  // Climbs only while on a repetitive task and NOT talking, and only when the
  // world is quiet (low novelty, low demand) and the body is not already aroused
  // (arousal above ~0.4 suppresses it). Any conversation or environmental novelty
  // drains it fast — this is what makes an understimulated worker seek talk.
  const arousalOver = Math.max(0, soma.arousal - 0.4);
  const boredUp =
    K_BORED_UP * (ctx.onTask && !ctx.socializing ? 1 : 0) *
    (1 - ctx.novelty) * (1 - ctx.demand) * (1 - arousalOver);
  const boredDown = K_BORED_DOWN * ((ctx.socializing ? 1 : 0) + ctx.novelty);
  wp.boredom = clamp(wp.boredom + (boredUp - boredDown) * dt, 0, 1);

  // --- stimulation: lightly-smoothed engagement readout --------------------
  const stimTarget = clamp(
    0.4 * soma.arousal +
    0.3 * clamp(soma.SEEKING, 0, 1) +
    0.3 * Math.max(0, soma.da_meso - 1) +
    0.4 * (ctx.socializing ? 1 : 0) +
    0.3 * ctx.novelty,
    0, 1,
  );
  wp.stimulation = clamp(approach(wp.stimulation, stimTarget, dt * K_SMOOTH), 0, 1);

  // --- workAnxiety: lightly-smoothed felt job-pressure ---------------------
  const anxTarget = clamp(
    0.4 * clamp(soma.cortisol - 1, 0, 1) +
    0.3 * clamp(soma.amygdala, 0, 1) +
    0.3 * clamp(soma.FEAR, 0, 1) +
    0.4 * ctx.demand,
    0, 1,
  );
  wp.workAnxiety = clamp(approach(wp.workAnxiety, anxTarget, dt * K_SMOOTH), 0, 1);

  // --- cleaner standing-fatigue ODE ----------------------------------------
  // On-feet & working: accrue hours and build fatigue (demand steepens it a
  // little). Sitting to recover: hours unwind toward 0 and fatigue drains faster
  // than it built. Off-shift (home/commuting): both relax mildly.
  if (ctx.standing && ctx.onTask) {
    wp.standingHours += dt;
    wp.cleanerFatigue = clamp(wp.cleanerFatigue + K_FAT_UP * (1 + 0.5 * ctx.demand) * dt, 0, 1);
  } else if (ctx.resting) {
    wp.standingHours = Math.max(0, approach(wp.standingHours, 0, dt * K_STAND_RELAX));
    wp.cleanerFatigue = clamp(wp.cleanerFatigue - K_FAT_DOWN * dt, 0, 1);
  } else {
    wp.standingHours = Math.max(0, approach(wp.standingHours, 0, dt * K_FAT_IDLE));
    wp.cleanerFatigue = clamp(wp.cleanerFatigue - K_FAT_IDLE * dt, 0, 1);
  }

  // --- GENTLE soma feedback (close the loop; keep every pull small & dt-scaled) -
  // sustained boredom drains reward and recruits stimulus-seeking...
  soma.da_meso = clamp(approach(soma.da_meso, DA_LO, G_DA * dt * wp.boredom), 0, 4);
  soma.SEEKING = clamp(approach(soma.SEEKING, 1, G_SEEK * dt * wp.boredom), 0, 1);
  // ...work-anxiety lifts threat activation and the stress hormone a touch...
  soma.amygdala = clamp(approach(soma.amygdala, AMY_HI, G_AMY * dt * wp.workAnxiety), 0, 1);
  soma.cortisol = clamp(approach(soma.cortisol, CORT_HI, G_CORT * dt * wp.workAnxiety), 0, 4);
  // ...and standing-fatigue bleeds (upward only) into felt somatic fatigue.
  soma.fatigue = clamp(soma.fatigue + Math.max(0, wp.cleanerFatigue - soma.fatigue) * G_FAT * dt, 0, 1);
}

// ---------------------------------------------------------------------------
// DECISION PROPENSITIES ∈ [0,1] — pure reads, no state mutation. The caller
// compares these against its own noise/thresholds to actually act.
// ---------------------------------------------------------------------------

/** High when bored + understimulated + socially warm, GATED DOWN by work-anxiety. */
export function talkPropensity(wp: WorkPsych, soma: SomaState): number {
  return clamp(
    0.15 +
    0.7 * wp.boredom +
    0.3 * (1 - wp.stimulation) -
    0.8 * wp.workAnxiety +
    0.2 * Math.max(0, soma.oxytocin - 1),
    0, 1,
  );
}

/** Cleaner: a steep smoothstep of standing-fatigue — ~0 below 0.5, →1 by ~0.85. */
export function restUrgency(wp: WorkPsych): number {
  const t = clamp((wp.cleanerFatigue - 0.5) / (0.85 - 0.5), 0, 1);
  return t * t * (3 - 2 * t); // smoothstep: steepest through ~0.7
}

/**
 * Pull to STAY on task, high under felt pressure. `demand` is not passed here on
 * purpose — it has already been integrated into workAnxiety; a persistent
 * cortisol elevation carries the residual somatic pressure signal.
 */
export function workPull(wp: WorkPsych, soma: SomaState): number {
  return clamp(0.6 * wp.workAnxiety + 0.4 * clamp(soma.cortisol - 1, 0, 1), 0, 1);
}

/** Thin role context sampled by the caller each beat (no state of its own). */
export interface WorkCtx {
  onTask: boolean;      // doing monotonous work right now (register / desk typing / mopping)
  socializing: boolean; // in a conversation right now
  standing: boolean;    // on their feet working (the cleaner while cleaning)
  resting: boolean;     // sitting down to recover
  novelty: number;      // 0..1 environmental novelty (usually low at a repetitive job)
  demand: number;       // 0..1 external task pressure (queue length / deadline / boss nearby)
  dtHours: number;      // sim-hours elapsed this step
}
