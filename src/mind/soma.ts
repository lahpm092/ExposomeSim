// =============================================================================
// soma.ts — the dynamical substrate.
// Coupled mean-reverting SDEs (Ornstein–Uhlenbeck form) with circadian forcing
// and a cross-channel coupling graph, integrated by Euler–Maruyama. Core affect
// (valence/arousal/dominance) is a *derived* readout — the constructed-emotion seam.
// =============================================================================
import type { SomaState, SomaParams, SomaChannel, CouplingEdge } from '../core/types';
import {
  INTEGRATED_CHANNELS, isModulator, defaultBaseline,
} from './params';
import { clamp, sigmoid, squash, randn, type RNG } from '../core/util/num';

const TWO_PI = Math.PI * 2;
const MAX_SUBSTEP = 0.02; // hours (~1.2 sim-min) — keeps Euler stable for k up to ~8/h

/** circadian-modulated baseline a channel reverts toward at clock time t */
function baselineAt(ch: SomaChannel, t: number, p: SomaParams): number {
  const c = p.circadian[ch];
  if (c) return c.mean + c.amplitude * Math.cos((TWO_PI * (t - c.phaseHours)) / 24);
  return defaultBaseline(ch);
}

/** clamp a channel to its physical range */
function clampCh(ch: SomaChannel, v: number): number {
  if (ch === 'allostaticLoad') return clamp(v, 0, 50);
  if (isModulator(ch)) return clamp(v, 0, 4);
  return clamp(v, 0, 1); // activations, drives, fatigue
}

/** source signal for couplings: modulators contribute their deviation from baseline 1 */
const signalOf = (soma: SomaState, ch: SomaChannel): number =>
  isModulator(ch) ? (soma[ch] as number) - 1 : (soma[ch] as number);

export function createSoma(params: SomaParams, startHour = 8): SomaState {
  const s: Partial<SomaState> = { t: startHour };
  for (const ch of INTEGRATED_CHANNELS) {
    (s as any)[ch] = baselineAt(ch, startHour, params);
  }
  // experiential / dispositional initial conditions
  s.fatigue = 0.2;
  s.thirst = 0.15;           // hypothalamic osmostat starts mildly dry
  s.da_meso = 0.85 + 0.15 * params.d2Density; // muted tonic reward if low D2
  s.allostaticLoad = clamp(params.amygdalaGain - 1, 0, 3) * 0.6; // chronic-load head start
  s.valence = 0; s.arousal = 0.45; s.dominance = 0;
  const soma = s as SomaState;
  computeCoreAffect(soma, params);
  return soma;
}

/** advance the substrate by dtHours (sub-stepped internally), then refresh affect */
export function integrate(soma: SomaState, params: SomaParams, dtHours: number, rng: RNG): void {
  // adjacency: target ← incoming edges
  const incoming = new Map<SomaChannel, CouplingEdge[]>();
  for (const e of params.couplings) {
    const arr = incoming.get(e.to); if (arr) arr.push(e); else incoming.set(e.to, [e]);
  }

  let remaining = dtHours;
  while (remaining > 1e-9) {
    const h = Math.min(MAX_SUBSTEP, remaining);
    const sqrtH = Math.sqrt(h);
    const next: Partial<Record<SomaChannel, number>> = {};

    for (const ch of INTEGRATED_CHANNELS) {
      const x = soma[ch] as number;
      const k = params.decay[ch] ?? 3;
      const base = baselineAt(ch, soma.t, params);
      let dx = k * (base - x) * h;

      const edges = incoming.get(ch);
      if (edges) for (const e of edges) dx += e.weight * signalOf(soma, e.from) * h;

      const sigma = params.noise[ch] ?? 0;
      if (sigma) dx += sigma * sqrtH * randn(rng);

      next[ch] = clampCh(ch, x + dx);
    }

    for (const ch of INTEGRATED_CHANNELS) (soma[ch] as number) = next[ch]!;
    soma.t += h;
    remaining -= h;
  }

  // allostatic load is the exposome's memory: it slowly accrues from sustained
  // amygdala+cortisol load (this dominates its tiny decay).
  const loadDrive = Math.max(0, soma.amygdala - 0.3) * Math.max(0, soma.cortisol - 1);
  soma.allostaticLoad = clampCh('allostaticLoad', soma.allostaticLoad + loadDrive * dtHours * 0.25);

  computeCoreAffect(soma, params);
}

/** derive valence/arousal/dominance from the substrate — the readout the LLM reads */
export function computeCoreAffect(soma: SomaState, params: SomaParams): void {
  const md = (ch: SomaChannel) => (soma[ch] as number) - 1;

  soma.valence = squash(
    0.8 * md('da_meso') + 0.5 * md('serotonin') + 0.4 * md('oxytocin') + 0.35 * md('opioid') +
    0.4 * soma.nacc + 0.3 * soma.PLAY + 0.2 * soma.CARE -
    0.7 * soma.amygdala - 0.5 * md('cortisol') - 0.45 * soma.FEAR - 0.4 * soma.RAGE -
    0.6 * soma.PANIC_GRIEF - 0.3 * soma.fatigue,
  );

  const arousalRaw =
    0.9 * md('norepinephrine') + 0.8 * md('cortisol') + 1.4 * soma.amygdala +
    0.9 * md('epinephrine') + 0.7 * soma.FEAR + 0.7 * soma.RAGE + 0.5 * soma.SEEKING -
    0.6 * md('melatonin') - 0.4 * md('gaba') - 0.2 * soma.fatigue;
  soma.arousal = clamp(sigmoid(1.2 * arousalRaw), 0, 1);

  soma.dominance = squash(
    0.6 * md('da_meso') + 0.5 * params.controlGain * soma.dlPFC + 0.4 * soma.RAGE -
    0.6 * soma.FEAR - 0.5 * soma.PANIC_GRIEF - 0.4 * md('cortisol') - 0.3 * soma.amygdala,
  );
}
