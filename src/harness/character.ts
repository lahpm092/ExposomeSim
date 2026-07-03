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
  Profile, SomaState, SomaParams, WorldEvent, LLMResponse, LLMClient,
  EmotionReadout, EmotionIntegrals, MemoryItem, CashierPublic, Physiology,
} from '../types';
import { deriveParams } from './params';
import { createSoma, integrate, computeCoreAffect } from './soma';
import { fastAppraise, applyAppraisal, applyRegulation } from './appraisal';
import { readEmotion, emptyIntegrals, updateIntegrals } from './emotion';
import { MemoryGraph, type MemGraphJSON } from './memgraph';
import { createPhysiology, stepPhysiology, ingestFood, ingestWater, voidBladder, voidBowel, bathe } from './physiology';
import { clamp, mulberry32, type RNG } from '../util/num';

/** the serialized dynamical state of a Character (identity/params are rebuilt). */
export interface CharacterJSON {
  soma: SomaState;
  phys: Physiology;
  integrals: EmotionIntegrals;
  lastResponse?: LLMResponse;
  rng: number;
  consolidateCooldown: number;
  memory: MemGraphJSON;
}

export interface CharacterOpts { seed?: number; startHour?: number; }

export class Character {
  readonly profile: Profile;
  readonly params: SomaParams;
  readonly soma: SomaState;
  readonly phys: Physiology = createPhysiology();
  readonly memory = new MemoryGraph();
  integrals: EmotionIntegrals = emptyIntegrals();
  lastResponse?: LLMResponse;
  private rng: RNG;
  private consolidateCooldown = 0;

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
    // the homeostatic reservoirs drain/fill and drive the felt body (thirst osmostat,
    // ghrelin/leptin, insular urgency) — the causal source of hunger/thirst/elimination.
    stepPhysiology(this.phys, this.soma, dtHours);
    // physiological floors: even a wrecked nervous system does not zero out its
    // monoamines — keep a small tonic reserve so a hard shift depresses without
    // pinning her permanently anhedonic (recovery stays possible).
    this.soma.serotonin = Math.max(this.soma.serotonin, 0.32);
    this.soma.da_meso = Math.max(this.soma.da_meso, 0.3);
    updateIntegrals(this.integrals, this.soma, dtHours);
    this.memory.decayAll(dtHours);
  }

  // ---- consummatory acts that reset the reservoirs (the town calls these) ----
  eat(mass = 0.55): void { ingestFood(this.phys, mass); }
  drink(amount = 0.4): void { ingestWater(this.phys, amount); }
  relieve(): void { voidBladder(this.phys); voidBowel(this.phys); }
  takeBath(): void { bathe(this.phys); }

  readout(): EmotionReadout { return readEmotion(this.soma); }
  recall(query: string, k = 4): MemoryItem[] { return this.memory.retrieve(query, k, this.soma.valence); }

  /**
   * Offline consolidation + reflection ("replay"), fired during rest. Async and
   * fire-and-forget so the LLM never touches the hot path; rate-limited so it runs
   * at most every ~4 simulated hours of rest.
   */
  rest(dtHours: number, llm?: LLMClient | null): void {
    this.consolidateCooldown -= dtHours;
    if (this.consolidateCooldown > 0) return;
    this.consolidateCooldown = 4;
    void this.memory.consolidate(this.soma.t, llm);
    void this.memory.reflect(this.soma.t, llm);
  }

  snapshot(): CashierPublic {
    return {
      profile: this.profile,
      soma: this.soma,
      readout: this.readout(),
      integrals: this.integrals,
      lastResponse: this.lastResponse,
      recentMemories: this.memory.recent(5),
      memoryGraph: this.memory.view(),
      physiology: { ...this.phys },
    };
  }

  // ---- persistence: capture / overwrite the dynamical state in place ---------
  toJSON(): CharacterJSON {
    return {
      soma: { ...this.soma },
      phys: { ...this.phys },
      integrals: { ...this.integrals },
      lastResponse: this.lastResponse,
      rng: this.rng.save ? this.rng.save() : 0,
      consolidateCooldown: this.consolidateCooldown,
      memory: this.memory.toJSON(),
    };
  }

  loadJSON(j: CharacterJSON): void {
    Object.assign(this.soma, j.soma);
    Object.assign(this.phys, j.phys);
    this.integrals = { ...j.integrals };
    this.lastResponse = j.lastResponse;
    if (this.rng.load) this.rng.load(j.rng);
    this.consolidateCooldown = j.consolidateCooldown;
    this.memory.loadJSON(j.memory);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
