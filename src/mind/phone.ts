// =============================================================================
// phone.ts — the phone / social-media engagement loop as a per-agent runtime,
// integrated exactly like workpsych.ts (a thin ctx sampled by the caller, a small
// dt-scaled soma feedback, every channel re-clamped). NOTHING here is scheduled:
// whether the phone comes out is a per-tick HAZARD read off the substrate.
//
// The pull to check is a competition:
//   appetite  = dopaminergicGain · (understimulation + habit + craving + connect)
//   brake     = current engagement (a good real conversation) + flow + felt watching
// where dopaminergicGain (the ADHD axis, params.neuro) makes an under-rewarded mind
// reach harder for the immediate hit, and a slow HABIT reservoir grows with that
// gain × past reward — so compulsive checking is an emergent addiction, not a flag.
//
// While on the phone the app delivers a VARIABLE-RATIO dopamine trickle (the pull
// of the slot-machine feed) and, at night, suppresses melatonin (blue light) so
// "one more scroll" pushes sleep later. The SOCIAL reward of actually being liked/
// replied-to is delivered by sim/feed.ts (it writes ps.lastEngagement back here),
// so a hollow scroll and a warm reply are cleanly different: the lonely doom-
// scroller builds habit without connection; the listened-to feel purpose.
//
// PURE except for the threaded rng: deterministic, no DOM/THREE, no Math.random.
// =============================================================================
import type { SomaState, SomaParams, PhoneState, WorkPsych } from '../core/types';
import { clamp, sigmoid, type RNG } from '../core/util/num';

/** Thin per-tick context the caller samples (mirrors WorkCtx). */
export interface PhoneCtx {
  engaged: number;      // 0..1 how engaging the current REAL situation is (in a live convo → 1)
  watched: number;      // 0..1 social cost of being seen checking (boss on the floor → high)
  demand: number;       // 0..1 external task pressure pulling attention back
  needPull: number;     // 0..1 a pressing bodily need (full bladder / hunger) that ends a session
  night: boolean;       // a sleep-hour → blue-light melatonin suppression applies
  extraversion: number; // 0..1 normalized E (raises the odds a session is socially engaging)
  dtHours: number;
}

const PHONE_BEAT = 0; // (no throttle here; the caller steps it every society tick)

export function createPhoneState(): PhoneState {
  return { onPhone: false, sessionT: 0, feed: 0, habit: 0, craving: 0, sinceLast: 6, lastEngagement: 0, sessionsToday: 0 };
}

/**
 * Integrate the phone loop one step. Mutates `ps`, and (softly, dt-scaled) `soma`
 * and `wp`. `rng` is the caller's seeded RNG — every stochastic draw goes through it.
 */
export function stepPhone(ps: PhoneState, wp: Pick<WorkPsych, 'boredom' | 'stimulation' | 'workAnxiety'>,
  soma: SomaState, params: SomaParams, ctx: PhoneCtx, rng: RNG): void {
  const dt = ctx.dtHours;
  if (dt <= 0) return;
  void PHONE_BEAT;
  const gain = params.neuro.dopaminergicGain;

  // --- off-phone integrators: craving builds, habit extinguishes very slowly ---
  const understim = clamp(
    1.0 * wp.boredom + 0.5 * (1 - wp.stimulation) +
    0.6 * clamp(1 - soma.da_meso, 0, 1) + 1.0 * clamp(0.45 - soma.arousal, 0, 0.45),
    0, 2,
  );
  if (!ps.onPhone) {
    ps.craving = clamp(ps.craving + dt * (0.6 * ps.habit + 0.4 * Math.min(1, understim)) - 1.5 * dt * ctx.engaged, 0, 1);
    ps.habit = clamp(ps.habit - 0.010 * dt, 0, 1);   // ~days to extinguish an unfed habit
    ps.sinceLast += dt;
    // craving leaks restlessness into the body (stimulus-seeking; a little withdrawal edge)
    soma.SEEKING = clamp(soma.SEEKING + 0.04 * dt * ps.craving, 0, 1);
    if (ctx.watched > 0.4) soma.RAGE = clamp(soma.RAGE + 0.02 * dt * Math.max(0, ps.craving - 0.6) * ctx.watched, 0, 1);
  }

  if (!ps.onPhone) {
    // --- PICKUP HAZARD ---------------------------------------------------------
    const lonely = clamp(0.5 * soma.PANIC_GRIEF + 0.4 * clamp(1 - soma.oxytocin, 0, 1) + 0.3 * clamp(1 - soma.opioid, 0, 1), 0, 1);
    const expectPos = clamp(0.5 + 0.5 * ps.lastEngagement, 0, 1);
    // the reach-for-connection pull is GATED by theory-of-mind: someone who converts
    // social contact into felt warmth reaches for it; a low-ToM mind gets little
    // connective reward and is driven instead by the dopamine/habit channel below.
    const connect = 0.9 * lonely * params.neuro.theoryOfMind * expectPos;
    const flow = clamp(wp.stimulation - wp.boredom, 0, 1);
    const appetite = gain * (understim + 1.1 * ps.habit + 1.3 * ps.craving + connect);
    const brake = 3.0 * ctx.engaged + 1.2 * flow + 1.0 * wp.workAnxiety * ctx.watched
      + 0.6 * params.controlGain * (1 - ps.habit) + 0.8 * Math.max(0, -ps.lastEngagement);
    const P = -2.2 + appetite - brake;
    const lambda = 6.0 * sigmoid(1.4 * P);
    const pPick = 1 - Math.exp(-lambda * dt);
    if (rng() < pPick) {
      ps.onPhone = true; ps.sessionT = 0; ps.feed = 0.7; ps.sinceLast = 0; ps.sessionsToday += 1;
    }
    return;
  }

  // --- ON-PHONE: variable-ratio dopamine + blue-light + putaway ---------------
  ps.sessionT += dt;
  // intermittent dopamine hit (Poisson per tick so it is dt-invariant)
  const pHit = 1 - Math.exp(-30 * (0.4 + 0.6 * ps.feed) * dt);
  let reward = 0;
  if (rng() < pHit) {
    const burst = 0.12 * params.rewardSensitivity * gain;
    soma.da_meso = clamp(soma.da_meso + burst, 0, 4);
    soma.SEEKING = clamp(soma.SEEKING + 0.05, 0, 1);
    ps.feed = clamp(ps.feed + 0.12, 0, 1);
    reward += burst;
  } else {
    ps.feed = clamp(ps.feed - 1.6 * dt, 0, 1);   // scrolling dulls novelty
  }
  // a fresh feed relieves boredom; a stale one stops relieving → boredom rebounds → the loop
  wp.boredom = clamp(wp.boredom - 2.0 * ps.feed * dt, 0, 1);

  // addiction consolidation: the reservoir grows with gain × received reward
  ps.habit = clamp(ps.habit + 0.20 * gain * reward, 0, 1);
  ps.craving = clamp(ps.craving - 1.5 * dt, 0, 1);

  // blue-light: at a sleep-hour the phone suppresses melatonin and lifts NE, so the
  // sleep gate (harness/sleep.ts) is pushed later WITHOUT any scripted bedtime rule.
  if (ctx.night) {
    soma.melatonin = clamp(soma.melatonin * (1 - 0.5 * dt), 0, 4);
    soma.norepinephrine = clamp(soma.norepinephrine + 0.10 * dt, 0, 4);
  }

  // --- PUTAWAY HAZARD ---------------------------------------------------------
  const externalPull = clamp(ctx.demand + ctx.needPull, 0, 1);
  const stopDrive =
    1.4 * (1 - ps.feed) + 1.0 * clamp(ps.sessionT / 0.6, 0, 1) + 1.5 * externalPull
    - 1.2 * ps.habit - 0.8 * gain * ps.feed;
  const mu = 5.0 * sigmoid(1.4 * stopDrive);
  const pStop = 1 - Math.exp(-mu * dt);
  if (rng() < pStop) { ps.onPhone = false; ps.sessionT = 0; ps.sinceLast = 0; }
}

/** Reset the daily session counter (call at the ~04:00 rollover). */
export function rolloverPhone(ps: PhoneState): void { ps.sessionsToday = 0; }
