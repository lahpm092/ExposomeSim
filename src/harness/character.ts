// =============================================================================
// character.ts — the neurosymbolic character: a persistent soma + memory that an
// LLM drives. This is the unit the simulation steps and the dashboard inspects.
//
// Lifecycle per event:
//   perceive(ev)            → fast low-road kick
//   [driver builds prompt from snapshot, LLM returns LLMResponse]
//   applyDriverResponse()   → high-road appraisal + regulation + memory encode
//   step(dt) every tick     → integrate substrate, accrue fatigue & metrics
// =============================================================================
import type {
  Profile, SomaState, SomaParams, WorldEvent, LLMResponse,
  EmotionReadout, EmotionIntegrals, MemoryItem, CashierPublic,
} from '../types';
import { deriveParams } from './params';
import { createSoma, integrate, computeCoreAffect } from './soma';
import { fastAppraise, applyAppraisal, applyRegulation } from './appraisal';
import { readEmotion, emptyIntegrals, updateIntegrals } from './emotion';
import { MemoryStream } from './memory';
import { clamp, mulberry32, type RNG } from '../util/num';

export interface CharacterOpts { seed?: number; startHour?: number; }

export class Character {
  readonly profile: Profile;
  readonly params: SomaParams;
  readonly soma: SomaState;
  readonly memory = new MemoryStream();
  integrals: EmotionIntegrals = emptyIntegrals();
  lastResponse?: LLMResponse;
  private rng: RNG;

  constructor(profile: Profile, opts: CharacterOpts = {}) {
    this.profile = profile;
    this.params = deriveParams(profile);
    this.rng = mulberry32(opts.seed ?? 0xC0FFEE ^ hash(profile.id));
    this.soma = createSoma(this.params, opts.startHour ?? 8);
    this.memory.seed(profile.experiosome.formativeMemories, opts.startHour ?? 8);
  }

  /** fast pre-cognitive reaction to an incoming event */
  perceive(ev: WorldEvent): void {
    fastAppraise(this.soma, this.params, ev);
    computeCoreAffect(this.soma, this.params);
  }

  /** apply the LLM driver's structured appraisal + chosen regulation, then encode memory */
  applyDriverResponse(ev: WorldEvent, resp: LLMResponse): void {
    applyAppraisal(this.soma, this.params, resp.appraisal);
    applyRegulation(this.soma, this.params, resp.regulation);
    computeCoreAffect(this.soma, this.params);
    this.lastResponse = resp;
    this.memory.add(
      this.soma.t,
      `${ev.description} — I felt ${resp.emotion}; I said: "${resp.speech}"`,
      this.soma,
    );
  }

  /** advance the substrate one tick of simulated time */
  step(dtHours: number): void {
    integrate(this.soma, this.params, dtHours, this.rng);
    // fatigue accrues with sustained arousal over the shift (mean-reverts slowly in integrate)
    this.soma.fatigue = clamp(this.soma.fatigue + dtHours * 0.04 * (0.4 + this.soma.arousal), 0, 1);
    updateIntegrals(this.integrals, this.soma, dtHours);
    this.memory.decayAll(dtHours);
  }

  readout(): EmotionReadout { return readEmotion(this.soma); }
  recall(query: string, k = 4): MemoryItem[] { return this.memory.retrieve(query, k); }

  snapshot(): CashierPublic {
    return {
      profile: this.profile,
      soma: this.soma,
      readout: this.readout(),
      integrals: this.integrals,
      lastResponse: this.lastResponse,
      recentMemories: this.memory.recent(5),
    };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
