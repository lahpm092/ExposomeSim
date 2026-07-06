// =============================================================================
// physiology.ts — a low-abstraction homeostatic reservoir layer: the causal
// SOURCE of felt hunger, thirst and elimination urgency. Where the soma is the
// neural/affective substrate, this is the plumbing beneath it — gut energy, body
// water, bladder/bowel filling, hygiene — each a reservoir that depletes or fills
// by a real-ish flux and then DRIVES the soma's interoceptive signals (ghrelin,
// leptin, the thirst osmostat, insular urgency). Behaviour is never scripted:
// the arbiter simply scores the needs these reservoirs produce, so "drink when
// parched, even mid-shift" or "find a toilet, now" EMERGE from the flux balance.
//
// This is the first seam toward the larger program: a coarse digital-twin of
// bodily homeostasis that a finer organ/tissue model can later be slotted under
// (the reservoirs become the shared hormone/metabolite interface).
// =============================================================================
import type { Physiology, SomaState } from '../core/types';
import { clamp } from '../core/util/num';

/** fresh body at the start of a run — mildly fed, hydrated, empty-ish, clean. */
export function createPhysiology(): Physiology {
  return { satiety: 0.7, hydration: 0.7, bladder: 0.25, bowel: 0.2, hygiene: 0.55 };
}

// ---- ingestion / relief (called by the town when she acts) -----------------

/** eat a meal of `mass` (∈~[0.3,0.7]): gut energy up; a little goes to bowel load. */
export function ingestFood(p: Physiology, mass: number): void {
  p.satiety = clamp(p.satiety + mass, 0, 1.1);
  p.bowel = clamp(p.bowel + mass * 0.28, 0, 1);   // food mass enters the gut transit
}

/** drink `amount` (∈~[0.3,0.45]) of water: hydration up; fluid load reaches the bladder. */
export function ingestWater(p: Physiology, amount: number): void {
  p.hydration = clamp(p.hydration + amount, 0, 1.1);
  p.bladder = clamp(p.bladder + amount * 0.55, 0, 1);
}

export function voidBladder(p: Physiology): void { p.bladder = 0.02; }
export function voidBowel(p: Physiology): void { p.bowel = 0.05; }
export function bathe(p: Physiology): void { p.hygiene = 1; }

// ---- the steep urgency curve for elimination (bladder OR bowel) ------------
// Fine until roughly half-full, then rises sharply — so a toilet trip only wins
// the arbiter's competition when it is genuinely pressing (and then it dominates).
export function eliminationUrgency(p: Physiology): number {
  const m = Math.max(p.bladder, p.bowel);
  const x = clamp((m - 0.5) / 0.45, 0, 1);
  return x * x;
}

// ---- passive dynamics + coupling into the soma (every tick) ----------------
/**
 * Advance the reservoirs by `dt` hours and write their consequences into the
 * soma's interoceptive channels. `activity` ∈ [0,1] scales metabolic/sweat loss
 * (arousal ≈ exertion). Pure mechanism — no decisions here.
 */
export function stepPhysiology(p: Physiology, soma: SomaState, dtHours: number): void {
  const dt = dtHours;
  const activity = clamp(soma.arousal, 0, 1);

  // basal + activity metabolism burns the gut-energy reserve (empties in ~7–10h).
  p.satiety = clamp(p.satiety - dt * (0.085 + 0.05 * activity), 0, 1.1);
  // insensible loss + sweat drains body water (empties in ~6–9h).
  p.hydration = clamp(p.hydration - dt * (0.07 + 0.06 * activity), 0, 1.1);
  // kidneys keep making urine — faster when well hydrated (a real diuresis-ish term).
  p.bladder = clamp(p.bladder + dt * (0.05 + 0.14 * Math.max(0, p.hydration - 0.45)), 0, 1);
  // slow colonic filling from resident food mass.
  p.bowel = clamp(p.bowel + dt * 0.018, 0, 1);
  // hygiene degrades over a day (sweat, grime) — ~a day from clean to grimy.
  p.hygiene = clamp(p.hygiene - dt * 0.032, 0, 1);

  // --- couple UP into the soma (the felt body) -----------------------------
  // thirst osmostat reads dehydration directly (the soma's felt dryness).
  soma.thirst = clamp(1 - p.hydration, 0, 1);
  // orexigenic ghrelin rises as the gut empties; leptin (satiety signal) tracks fullness.
  const ghrelinTarget = 0.55 + 1.5 * (1 - clamp(p.satiety, 0, 1));
  soma.ghrelin += (ghrelinTarget - soma.ghrelin) * clamp(dt * 2.5, 0, 1);
  const leptinTarget = 0.5 + 1.2 * clamp(p.satiety, 0, 1);
  soma.leptin += (leptinTarget - soma.leptin) * clamp(dt * 2.5, 0, 1);
  // a full bladder/bowel speaks through the insula (interoceptive urgency).
  const u = eliminationUrgency(p);
  if (u > 0.3) soma.insula = clamp(soma.insula + u * 0.4 * dt, 0, 1);
}
