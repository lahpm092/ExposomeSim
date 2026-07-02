// =============================================================================
// ExposomeSim — shared domain contract
// -----------------------------------------------------------------------------
// This is the single source of truth that couples every subsystem:
//   harness (soma + appraisal)  ·  llm (driver)  ·  sim (world/loop)
//   render (three.js)           ·  ui  (dashboard)
// Keep this file dependency-free. Changes here ripple everywhere by design.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. GENETICS  — interpretable, mechanistically-hooked polymorphisms.
//    Additive coding: count of the named (effect/minor) allele, 0|1|2.
//    NOTE: candidate-gene effect sizes are small & partly contested; these are
//    *interpretable parameter priors*, not claims of genomic determinism.
// ---------------------------------------------------------------------------
export type Allele2 = 0 | 1 | 2;

export interface Genotype {
  COMT_Met: Allele2;        // rs4680 Met count: slower prefrontal DA clearance ("worrier")
  DRD2_Taq1A: Allele2;      // rs1800497 A1 count: ↓ striatal D2 receptor density
  DRD4_7R: Allele2;         // 48bp VNTR 7-repeat count: novelty seeking / ↓ reward efficacy
  DAT1_VNTR: Allele2;       // SLC6A3: dopamine transporter density (reuptake)
  HTTLPR_S: Allele2;        // 5-HTTLPR short-allele count: ↑ amygdala reactivity (contested)
  BDNF_Met: Allele2;        // rs6265 Met count: ↓ plasticity / hippocampal stress resilience
  FKBP5_risk: Allele2;      // HPA negative-feedback efficiency (strong GxE w/ early trauma)
  OXTR_A: Allele2;          // rs53576 A count: ↓ social-reward / trust sensitivity
  MAOA_low: Allele2;        // uVNTR low-activity: ↓ monoamine clearance (GxE w/ maltreatment)
  CYP2D6: 'poor' | 'intermediate' | 'extensive' | 'ultrarapid'; // drug-metabolism hook
}

// ---------------------------------------------------------------------------
// 2. PERSONALITY & EXPERIOSOME — the "who" sampled from population distributions.
// ---------------------------------------------------------------------------
/** Big Five as z-scores, ~N(0,1) over the population. */
export interface BigFive { O: number; C: number; E: number; A: number; N: number; }

export type Attachment = 'secure' | 'anxious' | 'avoidant' | 'disorganized';

/** The distribution of lived experience that shapes set-points. */
export interface Experiosome {
  attachment: Attachment;
  aceScore: number;          // 0–10 Adverse Childhood Experiences
  ses: number;               // socioeconomic status z-score (low ⇒ chronic stress load)
  chronicStressors: string[];// narrative ongoing stressors (debt, illness, ...)
  formativeMemories: string[]; // seed episodic memories
}

/** The stable identity of a character. Immutable across a sim run (mostly). */
export interface Profile {
  id: string;
  name: string;
  age: number;
  role: string;              // e.g. "cashier"
  backstory: string;         // narrative handed to the LLM
  goals: string[];           // active goals used in appraisal (goal-congruence)
  genotype: Genotype;
  bigFive: BigFive;
  experiosome: Experiosome;
}

// ---------------------------------------------------------------------------
// 3. THE SOMA — the persistent dynamical state ("the self lives here, not in
//    the LLM context"). Conventions:
//      activations   ∈ [0,1]
//      neuromodulators / hormones: normalized tone, ~[0,2], 1 = personal baseline
//      valence,dominance ∈ [-1,1]   arousal ∈ [0,1]
// ---------------------------------------------------------------------------
export interface SomaState {
  t: number;                 // simulated clock time, hours (continuous; mod 24 for circadian)

  // limbic / cortical activation nodes
  amygdala: number;          // threat / salience
  hippocampus: number;       // memory engagement + HPA negative feedback
  vmPFC: number;             // affective regulation engaged (reappraisal capacity in use)
  dlPFC: number;             // cognitive control
  nacc: number;              // nucleus accumbens — reward / approach
  insula: number;            // interoceptive intensity ("how loudly the body speaks")
  hypothalamus: number;      // homeostatic drive / HPA initiation

  // neuromodulator tone
  da_meso: number;           // mesolimbic dopamine — reward, motivation, wanting
  da_cort: number;           // mesocortical dopamine — control, working memory
  serotonin: number;         // mood, behavioral inhibition, harm avoidance
  norepinephrine: number;    // arousal, vigilance (locus coeruleus)
  gaba: number;              // inhibitory tone (anxiety damping)
  glutamate: number;         // excitatory tone
  oxytocin: number;          // bonding, trust
  opioid: number;            // social comfort, pain relief
  endocannabinoid: number;   // stress buffering

  // hormones (slow, circadian)
  cortisol: number;          // central stress hormone (HPA), strong circadian
  melatonin: number;         // circadian / sleep pressure
  epinephrine: number;       // fast acute fight-flight
  ghrelin: number;           // hunger (metabolic hook to gastric module)
  leptin: number;            // satiety

  // Panksepp primary-process emotional systems ∈ [0,1]
  SEEKING: number; FEAR: number; RAGE: number; CARE: number;
  PANIC_GRIEF: number; PLAY: number; LUST: number;

  // core-affect readout (constructed-emotion substrate)
  valence: number;           // [-1,1]
  arousal: number;           // [0,1]
  dominance: number;         // [-1,1]

  // hypothalamic homeostatic drives ∈ [0,1] (osmostat/glucostat-style detectors,
  // managed outside the OU integrator: they climb with deprivation, reset on relief)
  thirst: number;            // osmotic/volume deficit — rises with time & heat, reset by drinking

  // slow integrators / load
  allostaticLoad: number;    // accumulates with chronic activation; shifts set-points
  fatigue: number;           // [0,1] depletes control capacity
}

/** Names of the continuously-integrated scalar channels (for generic plumbing). */
export type SomaChannel = Exclude<keyof SomaState, 't'>;

// ---------------------------------------------------------------------------
// 4. SOMA PARAMETERS — the individualized physics, derived from Profile.
// ---------------------------------------------------------------------------
/** baseline(t) = mean + amplitude * cos(2π (t - phaseHours) / 24) */
export interface CircadianTerm { mean: number; amplitude: number; phaseHours: number; }

export interface CouplingEdge { from: SomaChannel; to: SomaChannel; weight: number; }

export interface SomaParams {
  decay: Partial<Record<SomaChannel, number>>;            // k_i mean-reversion rate (per hour)
  circadian: Partial<Record<SomaChannel, CircadianTerm>>; // baseline forcing
  noise: Partial<Record<SomaChannel, number>>;            // σ_i Euler–Maruyama noise amplitude
  couplings: CouplingEdge[];                              // cross-channel directed effects

  // headline individualized gains (set by genotype × personality × experiosome)
  amygdalaGain: number;      // threat reactivity (↑ N, HTTLPR_S, ACEs, anxious attachment)
  hpaFeedbackGain: number;   // cortisol negative-feedback efficiency (FKBP5; ↓ w/ ACEs)
  d2Density: number;         // striatal D2 receptor density (DRD2_Taq1A) → reward gain, ~[0.4,1.3]
  daClearancePFC: number;    // prefrontal DA clearance (COMT)
  rewardSensitivity: number; // E × DRD4 × d2Density → NAcc / da_meso response to reward
  oxytocinGain: number;      // A × OXTR × attachment → social-reward response
  controlGain: number;       // C → dlPFC/vmPFC regulation efficacy
  recoveryRate: number;      // affect inertia (↓ N ⇒ faster return to baseline)
}

// ---------------------------------------------------------------------------
// 5. SYMBOLIC APPRAISAL — the contract between events and the soma (OCC + Scherer SECs).
// ---------------------------------------------------------------------------
export type Agency = 'self' | 'other' | 'circumstance';

export interface Appraisal {
  novelty: number;           // 0..1  unexpectedness
  pleasantness: number;      // -1..1 intrinsic valence
  goalRelevance: number;     // 0..1  does it matter to my goals?
  goalCongruence: number;    // -1..1 helps (+) vs harms (-) my goals
  agency: Agency;            // who caused it
  blameworthiness: number;   // -1..1 (praise … blame)
  copingPotential: number;   // 0..1  can I handle this?
  certainty: number;         // 0..1  how sure am I what's happening?
  normCompatibility: number; // -1..1 social-norm violation … upholding
  urgency: number;           // 0..1  time pressure
}

export type RegulationStrategy =
  | 'reappraisal' | 'suppression' | 'situation-selection'
  | 'distraction' | 'rumination' | 'acceptance' | 'none';

// ---------------------------------------------------------------------------
// 6. EVENTS & LLM I/O
// ---------------------------------------------------------------------------
export interface WorldEvent {
  id: string;
  kind: string;              // 'customer_arrive' | 'order' | 'rude' | 'compliment'
                             // | 'complaint' | 'rush' | 'mistake' | 'idle' | 'shift_end' ...
  description: string;       // natural language, handed to the LLM
  source?: string;           // who/what caused it
  salienceHint?: number;     // 0..1 fast low-road salience (pre-LLM kick)
  valenceHint?: number;      // -1..1 fast low-road valence (pre-LLM kick)
}

/** Strict JSON the LLM driver must return. Schema-constrained for tiny models. */
export interface LLMResponse {
  appraisal: Appraisal;
  emotion: string;           // discrete emotion CONSTRUCTED from core affect + context
  regulation: RegulationStrategy;
  speech: string;            // what the character says aloud
  action: string;            // work/physical token: 'take_order'|'serve'|'apologize'|'wait'|'gesture'|...
  innerMonologue?: string;   // optional private thought (for the caption / inspector)
}

// ---------------------------------------------------------------------------
// 7. READOUTS & METRICS — what the dashboard plots.
// ---------------------------------------------------------------------------
export interface EmotionReadout {
  label: string;             // constructed discrete emotion
  valence: number; arousal: number; dominance: number;
  intensity: number;         // 0..1
}

/** Time-integrals of affect — the exposome metrics. Units: simulated minutes / area. */
export interface EmotionIntegrals {
  minutesAnxious: number;
  minutesDepressed: number;
  minutesContent: number;
  minutesAngry: number;
  minutesJoyful: number;
  cumulativeStress: number;  // ∫ max(0, cortisol-baseline) dt
  cumulativeReward: number;  // ∫ max(0, da_meso-baseline) dt
  allostaticLoad: number;    // mirror of soma.allostaticLoad for convenience
}

// ---------------------------------------------------------------------------
// 8. EPISODIC MEMORY (Generative-Agents-style stream, affect-gated encoding).
// ---------------------------------------------------------------------------
export interface MemoryItem {
  id: string;
  t: number;                 // when it happened (sim hours)
  text: string;
  salience: number;          // 0..1 encoding strength (gated by arousal × cortisol/NE)
  valence: number;           // affective tag
  decay: number;             // current retrievability
}

// ---- symbolic memory GRAPH (see src/harness/memgraph.ts, MEMORY_DESIGN.md) ---
export type MemNodeKind = 'episodic' | 'semantic' | 'entity' | 'schema';
export type MemEdgeKind = 'temporal' | 'assoc' | 'about' | 'is_a' | 'causal';
/** A bounded snapshot of a character's memory graph for the live visualization. */
export interface MemGraphView {
  nodes: { id: string; kind: MemNodeKind; text: string; salience: number; valence: number; retr: number; act: number }[];
  edges: { a: string; b: string; kind: MemEdgeKind; w: number }[];
}

// ---------------------------------------------------------------------------
// 9. SIMULATION WORLD
// ---------------------------------------------------------------------------
export interface Vec3 { x: number; y: number; z: number; }

export type Demeanor = 'polite' | 'neutral' | 'impatient' | 'rude' | 'warm';

export interface Customer {
  id: string;
  name: string;
  demeanor: Demeanor;
  patience: number;          // 0..1 drains while waiting
  order: string;             // natural-language order
  pos: Vec3;
  state: 'approaching' | 'ordering' | 'waiting' | 'leaving' | 'gone';
  spawnedAt: number;
  profileSeed?: number;      // when set, this customer can be promoted to a full-sim NPC
}

/** Snapshot the renderer + dashboard read each frame (no logic, pure data). */
export interface CashierPublic {
  profile: Profile;
  soma: SomaState;
  readout: EmotionReadout;
  integrals: EmotionIntegrals;
  lastResponse?: LLMResponse;
  recentMemories: MemoryItem[];
  memoryGraph?: MemGraphView;      // live snapshot of the symbolic memory graph
  needs?: NeedsReadout;            // Maslow deficits read off the soma (town layer)
  needsIntegrals?: NeedsIntegrals;
  physiology?: Physiology;         // homeostatic reservoirs (town layer)
}

export interface WorldSnapshot {
  time: number;              // sim clock hours
  speed: number;             // sim time units per real second
  queue: Customer[];
  servedCount: number;
  cashier: CashierPublic;
  currentEvent?: WorldEvent;
}

// ---------------------------------------------------------------------------
// 10. LLM CLIENT — swappable backend (Ollama now, remote API later).
// ---------------------------------------------------------------------------
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export interface LLMClient {
  readonly name: string;
  /** Returns the raw assistant text. `format:'json'` requests JSON-constrained output. */
  complete(
    messages: ChatMessage[],
    opts?: { format?: 'json'; temperature?: number; signal?: AbortSignal },
  ): Promise<string>;
}

// ===========================================================================
// 11. THE TOWN — level-of-detail scaling to a compressed modern-western life.
//   Full psyche only for the protagonist + whoever she is interacting with;
//   cheap symbolic minds for proximate NPCs; pure statistics for the city.
//   The daily/weekly loop is NOT scripted — it emerges from Maslow needs read
//   off the soma, arbitrated against place affordances + money/food/energy/time.
// ===========================================================================
export interface Vec2 { x: number; y: number; }

// ---- Maslow needs: a derived readout of the soma (like core affect) --------
export type NeedTier = 'physiological' | 'safety' | 'belonging' | 'esteem' | 'actualization';

/** Each field is a DEFICIT in [0,1] — 1 = maximally unmet. */
export interface NeedsReadout {
  hunger: number; thirst: number; energy: number;
  elimination: number;  // urgency to void bladder/bowel (steep near-full)
  cleanliness: number;  // hygiene deficit (rises since last bath)
  safety: number; belonging: number; esteem: number; novelty: number;
  deficit: Record<NeedTier, number>;
  dominantTier: NeedTier;
}
export interface NeedsIntegrals {
  minutesHungry: number; minutesThirsty: number; minutesLonely: number; minutesDepleted: number; minutesUnsafe: number;
}

// ---------------------------------------------------------------------------
// PHYSIOLOGY — a low-abstraction homeostatic reservoir layer that is the causal
// SOURCE of felt hunger/thirst/urgency (it drives soma ghrelin/leptin/thirst).
// Reservoirs deplete/fill by real-ish flux; behaviour emerges when the arbiter
// scores the resulting needs. Nothing here is scripted. See harness/physiology.ts.
// ---------------------------------------------------------------------------
export interface Physiology {
  satiety: number;    // 0..1 gut-energy reserve: +eating, −basal+activity metabolism
  hydration: number;  // 0..1 body water: +drinking, −insensible loss + sweat
  bladder: number;    // 0..1 fullness: fills from fluid throughput, void at a toilet
  bowel: number;      // 0..1 fullness: fills slowly from food mass, void at a toilet
  hygiene: number;    // 0..1 cleanliness: decays with time, restored by bathing
}

// ---- places & affordances (the only authored content) ----------------------
export type PlaceId = 'home' | 'work' | 'market' | 'thirdplace' | 'park';
export type IntentionKind =
  | 'eat' | 'buy_meal' | 'drink' | 'relieve' | 'bathe'
  | 'rest' | 'work' | 'shop' | 'socialize' | 'go_home' | 'linger';

export interface Affordance {
  kind: IntentionKind;
  tier: NeedTier;
  satisfies: number;        // how strongly it relieves its tier, [0,1]
  costMoney: number;
  costEnergy: number;       // fatigue added (or, for rest, negative)
  durHours: number;
  needsFoodStock?: boolean; // eat requires foodStock>0
  social?: boolean;         // a site of NPC interaction
}
export interface Place {
  id: PlaceId;
  name: string;
  pos2D: Vec2;              // town coords in [0,1]
  openHours: [number, number]; // [open, close); wraps if open>close; [0,24]=always
  capacity: number;        // max simultaneous proximate NPCs
  localeKind: string;      // which 3D locale the Stage builds
  affordances: Affordance[];
}

// ---- agency: the emergent goal, not a schedule -----------------------------
export interface Intention {
  kind: IntentionKind;
  place: PlaceId;
  targetNpc?: string;
  utility: number;
  reason: string;          // human-readable "why" for the dashboard
}
export interface CurrentGoal {
  intention: Intention;
  phase: 'travel' | 'execute';
  startedAt: number;
  plannedEnd: number;
}

// ---- the resource economy (binding constraints that close the loop) --------
export interface Resources {
  money: number;
  foodStock: number;       // cookable meals on hand at home
  pantry: string[];        // named groceries in the fridge (abstract inventory)
  sleepDebt: number;       // hours
  rentDue: number;         // amount owed at rentDueAt
  rentDueAt: number;       // clock (absolute sim-hours) when rent is charged
  wageEarned: number;      // cumulative, for the dashboard
}

// ---- Tier-1 proximate NPC: a cheap symbolic mind, NO soma ------------------
export interface NpcLite {
  id: string;
  profileSeed: number;
  name: string;
  pos: Vec3;
  dir: number;
  path: Vec3[];
  goalToken: 'queue' | 'browse' | 'linger' | 'approach_mara' | 'leave';
  hunger: number; energy: number; mood: number; // cheap scalars [0,1]/[-1,1]
  wantsMara: boolean;      // triggers promotion to a full-sim partner
  bonded?: boolean;        // has a ledger relationship with Mara
}

// ---- the emergent relationship ledger --------------------------------------
export type RelStage = 'stranger' | 'acquaintance' | 'friend' | 'close' | 'romantic';
export interface Relationship {
  npcId: string;
  profileSeed: number;
  name: string;
  familiarity: number;     // [0,1]
  affection: number;       // [-1,1]
  trust: number;           // [0,1]
  attraction: number;      // [0,1]
  tension: number;         // [0,1]
  cumValence: number;      // running sum of Mara's interaction valence
  encounters: number;
  lastSeen: number;
  stage: RelStage;
  summary: string;
  somaSnapshot?: Partial<SomaState>;
}
export type Ledger = Map<string, Relationship>;

// ---- Tier-3 city: pure statistics, zero stored agents ----------------------
export interface DensityField {
  cols: number; rows: number;
  cell: Float32Array;      // occupancy per cell, [0,1]
  t: number;               // clock when last relaxed
  placeCell: Partial<Record<PlaceId, number>>; // cell index of each place
}

// ---- the town snapshot the renderers read each frame -----------------------
/** A coarse read of the currently-promoted interlocutor's abstracted psyche
 *  (MindLite runs at lower causal resolution than the protagonist's full soma). */
export interface PartnerView {
  name: string;
  label: string;
  valence: number; arousal: number; dominance: number;
  warmth: number;  threat: number;   // the two coarse limbic axes
}

export interface TownSnapshot extends WorldSnapshot {
  place: PlaceId;
  macroPos: Vec2;          // Mara's town position (interpolated while travelling)
  travelling: boolean;
  needs: NeedsReadout;
  needsIntegrals: NeedsIntegrals;
  resources: Resources;
  intention: Intention;
  day: number;
  weekend: boolean;
  density: DensityField;
  locale: { figures: NpcLite[] };
  relationships: Relationship[];
  partner?: PartnerView;   // the currently-promoted, abstracted interaction partner
  protagonists?: string[]; // names of full-resolution protagonists in the sim
  others?: OtherAgentView[]; // additional full-resolution protagonists, for rendering
}

/** A second full-resolution protagonist, projected for the renderer + dashboard. */
export interface OtherAgentView {
  name: string;
  place: PlaceId;
  macroPos: Vec2;
  travelling: boolean;
  valence: number; arousal: number; dominance: number; amygdala: number; cortisol: number;
  label: string;
  reason: string;
}
