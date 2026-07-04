# Memory v2 — "The Reputation Engram"
### A memory system engineered to produce emergent social complexity on a 0.6B model

*Produced by a research → synthesis → design pipeline: 6 parallel research agents (each cross-checked by a skeptic) surveyed computational/neurosymbolic memory models, consolidation, reconsolidation/drift, emotion–cognition, social/collective memory, and 20+ years of game-AI social sims; three independent design agents then proposed complete systems from different lenses; each was adversarially critiqued and a synthesis-judge merged them. This document is the recommended design. It is an **evolution of the existing `MemoryGraph` (`memgraph.ts`) + `Relationship` ledger (`relationship.ts`)**, not a rewrite.*

---

## 0. The thesis

> **The one missing primitive is a bias-encoded, transmissible evaluative *claim* about a third party.** Store it as a facet on the existing entity node so it inherits retrieval/decay/persistence for free. Each agent encodes and mutates claims through a cheap per-agent *bias lens*; claims aggregate into entity-node *reputation* that is **injected into the soma as a self-fulfilling prior before every encounter** and folded by **reward-prediction-error** into slow, trust-scaled **grudges**. Rivalries, alliances, scapegoats and in-groups are **derived reads over agreement** (union-find), never stored state — exactly as the company goal is already a projection of the boss's memory and Maslow needs are read off the soma.

The load-bearing architectural rule (all three designers and all three critics agreed):

> **The numeric/symbolic substrate decides WHAT to remember, WHOM to like, WHICH social move to make, and HOW beliefs drift. The 0.6B LLM only paints prose over a social structure that is already fully computed.** Everything runs byte-identically with Ollama off.

## 1. Why the naïve version fails here (the critics' convergent finding)

Three independent adversarial reviews all discovered the same thing: **a gossip epidemic assumes a contact rate this sim does not deliver.** Any design must fix the substrate *first* or the dynamics fizzle:

- **Face-to-face is floor-siloed.** `matchmakeOffice` pairs only same-floor "wandering" office agents, one dyad per tick behind a 0.4 h cooldown, in private. Floors partition the roster into 3 disjoint pools of 4–7; the 3 foodcourt agents (Mara/Gus/Rosa) never converse at all. **The feed is the only cross-venue channel.**
- **`decayBonds` runs on Mara's ledger only** (`town.ts:186`), never the 17 roster ledgers → roster grudges can *only harden* into universal wariness. The whole reconciliation/estrangement half is dead-on-arrival without fixing this.
- **Conversation warmth is positive-biased** → the natural attractor is a mostly-warm blob, not factions, unless negativity is routed through specific channels (the feed + the office coordination system).
- **No third-party referent** exists on conversations or the feed (they carry an *interest topic*, never "about Priya") → gossip needs a new referent.
- **Determinism constraints:** `memgraph` is RNG-free (for save/branch replay); `now()` is an O(n) scan; there's a stray `Math.random` smell in `reconsolidate`. All claim mutation must live outside `memgraph`, behind the threaded PRNG.

## 2. The three proposals it was synthesized from

| # | Proposal | Lead idea | Judge scores (eff / social / no-LLM / impl / science) | What it contributed |
|---|----------|-----------|---|---|
| 🥇 | **The Grapevine** | the transmissible **claim** as an entity-node facet; reputation & factions as *derived reads*; agreement-bonding | 8 / 8 / 10 / 6 / 7 | the social-complexity ceiling + the idiomatic "derived read" pattern |
| 🥈 | **Reconstructive Memory** | per-agent **CognitiveBias** lens + reconstruction-on-recall so identical events individuate | 9 / 6 / 10 / 6 / 8 | the only **perf win** (TokenIndex + lazy decay) + individuation + best science |
| 🥉 | **Memory-as-Controller** | entity nodes as **predictive controllers**: soma prior-injection + RPE learning | 8 / 5 / 10 / 5 / 7 | soma prior-injection, RPE-gated salience, Pearce-Hall gain, trust-scaled grudge |

Each was rated **"promising-with-fixes"** — none survived contact with the real contact graph alone, which is exactly why the hybrid fixes the substrate first and combines their non-overlapping strengths.

---

## 3. New data structures

### 3.1 `Claim` — the only thing that copies between agents
A facet stored **on the existing entity node** (`kind:'claim'`), resolved to the canonical `entityByName` id so gossip and firsthand memory converge on one node. It rides `retrievability` / ACT-R base-level / `toJSON` for free.

```ts
interface Claim {
  subjectId: string;     // canonical entity id the claim is ABOUT (NOT the holder)
  topic: 'warmth' | 'competence' | 'reliability' | 'status' | 'romance' | 'deviance';
  polarity: number;      // [-1,1]  the evaluative content
  confidence: number;    // [0,1]   CERTAINTY — decoupled from retrievability (see §6)
  originId: string;      // root witness (for credibility / sleeper effect)
  sourceId: string;      // last teller ('self' if firsthand)
  firsthand: boolean;
  hops: number;          // telephone distance from the event
  corroborations: number;
}
```

### 3.2 `CognitiveBias` — per-agent individuation lens
Derived once from the profile (Big-Five z-scores, `aceScore`, attachment, `NeuroTraits`) and **rebuilt on load like `SomaParams` — nothing extra to persist.**

```ts
interface CognitiveBias {
  negBias: number;        // negativity weighting of salience (reads allostaticLoad live)
  posBias: number;
  selfServing: number;    // attribution flip for the self-schema
  schemaPull: number;     // reconstruction drift rate toward schema/mood
  suggestibility: number; // how much heard claims move belief
  confabRate: number;     // schema-consistent intrusion probability
  vividnessThreshold: number; // flashbulb anchor cutoff
}
```

### 3.3 Entity-node reputation + predictive prior (fields on the entity node)
```ts
// reputation = confidence-weighted running mean of claims about this subject
rep: { warmth, competence, reliability, status: number; count: number; notoriety: number }
// predictive controller
exp: { expValence, expWarmth, expThreat, expConf, assoc /*Pearce-Hall*/, predErrEWMA, lastEncounter }
```

### 3.4 `Relationship` additions
```ts
grudge: number;      // [0,1] trust-scaled betrayal residue; decays ~5-10x slower than tension,
                     // re-seeded on each recall of the backing negative claim
gratitude: number;   // [0,1] faster timescale than grudge
repSeeded: boolean;  // this bond was prejudged from reputation (UI badge)
```

Reputation stays **private per agent** (drives drama, can be wrong) with an **optional public tier** for legible ostracism — loosely coupled, never collapsed to one scalar.

---

## 4. Mechanisms (all O(1) per event, all LLM-free)

### A. Individuation (why 18 agents diverge from shared events)
- **Bias-gated salience + flashbulb anchoring.** `sal = clamp(sal0 · (valence<0 ? negBias : posBias))` where `sal0` is the existing McGaugh gate; `sal > vividnessThreshold` ⇒ near-permanent anchor (`decay≈0`, high `encodingStrength`). A high-neuroticism mind burns in a grudge where a low-N mind barely notices.
- **Reconstruction-on-recall.** On each retrieved winner, drift `valence` toward `0.6·schema.valence + 0.4·mood` at rate `schemaPull`; with prob `confabRate` add one schema-consistent token. **Gated** (see §6) so identity memories don't relax to noise.
- **Self-schema + self-serving attribution.** `selfServing × negBias` grows a confident-vs-depressive `self.valence` from identical life histories, which feeds `feed.expressiveUrge` and `fallbackResponse` tone.

### B. Prediction & priors (the self-fulfilling loop)
- **Soma prior-injection (`expectationPrime`).** A new primitive in `socialaffect.ts` (mirroring `socialReward`): before a beat, pre-load `amygdala/nacc/oxytocin/cortisol` from the partner's reputation × confidence × `K_PRIOR(0.25)`. You approach someone you expect to be hostile with the amygdala already primed → you read their neutral act as a slight → they sour → the prior confirms itself. **Memory biases the body before cognition.**
- **RPE-gated encoding + adaptive gain.** `pe = actualValence − expValence`; `lr = clamp(0.15 + 0.6·assoc, 0.05, 0.9)` (Pearce-Hall: volatile bonds learn fast, stable ones go sticky); `expValence += lr·pe`; `assoc = lerp(assoc, |pe|, 0.4)`; **`salience *= 1 + 0.8·|pe|·expConf`** so a *surprising betrayal by a trusted friend* is the single most memorable event in the system.
- **Trust-scaled asymmetric grudge**, gated on the **smoothed** `predErrEWMA` (not single-beat ±0.1 noise): `grudge += (−pe − θ)·(0.5 + 0.5·trust)·0.6`. Betrayal by a trusted friend hurts most; positive pe bleeds grudge (forgiveness); `recomputeStage` demotes when `grudge > affection`.

### C. Transmission & structure (where social complexity is generated)
- **Claim genesis** — every salient beat that already writes a memory also mints a firsthand claim about the partner (`polarity = tanh(2.5·dV)`), seeding reputation from lived experience.
- **Gossip (copy-with-mutation)** in a new **`gossip.ts` (threaded RNG)**: teller shares argmax-juiciest claim (`|pol|·salience·freshness·juiciness(topic)·notRecentlyTold`, **softmax/ε** not hard argmax to avoid one-scapegoat monoculture); listener adopts with `conf' = conf·srcTrust·0.7`, `pol' = lerp(pol, priorWarmth, 0.25)`, `hops+1`. Corroboration pumps confidence (illusory truth); conflict pulls toward the teller or, if firsthand, raises tension.
- **Agreement-bonding / disagreement-tension** folded into the **existing** `socialReward + updateBond` two-sided path: shared dislike bonds (enemy-of-my-enemy gets a *larger* bonus, per Heider); disagreeing about a friend stings. **The cheapest faction generator that works on a sparse contact graph.**
- **Reputation → first-meeting prior** — a fresh bond's affection/trust/tension seeded from what each agent has already heard (a bad name precedes you), closing the loop gossip→reputation→interaction→new-claim.
- **Faction / scapegoat / grudge = derived reads.** Every ~2 sim-hours, union-find over agreement (`align(A,B) = cosine(repVec_A, repVec_B)·(1 + 0.5·sign(affection))`) on the top-~8 notable subjects. `O(A²·|N|) ≈ 7k ops` a few times/day — off the hot path, never stored.

### D. Substrate fixes (the "fix first" prerequisites — from the critiques)
1. **Wire decay for all 17 roster ledgers** (throttled amortized sweep or lazy read-time from `lastSeen`), grudge slow/exempt — so untended friction softens but anchored grudges persist.
2. **Give gossip a real referent on the channels that have events:** optional `aboutId` on feed posts (subtweet/callout) as the **primary cross-venue channel**; shared-post **overhear = divergent bystander encoding** (many agents reading one post each mint a blame-by-prior claim); foodcourt agents get a feed-only reputation path.
3. **Route all claim mutation through `gossip.ts` with the threaded RNG**; `memgraph` stores claims but never mutates polarity; `kind==='claim'` is filtered out of ordinary recall/composition so claims never leak into utterances/reflection; clean the `reconsolidate` `Math.random` smell; add 2–3 orthogonal issue-topic axes to guarantee cross-cutting cleavages.

### E. Performance (what pays for it)
- **TokenIndex** (inverted `token → nodeId`) replaces the per-event whole-graph pattern-separation scan and the retrieval seed scan.
- **Lazy read-time power-law decay** replaces the per-tick `decayAll` sweep → removes today's `O(agents × nodes)` per-tick cost.
- **Stored clock** replaces the `O(n)` `now()` scan.

Net: this is a **performance win** that *pays for* the new social machinery, which is what makes 30+ agents genuinely cheap. New per-tick cost is ≈ zero (all social work is event-driven inside already-throttled beats).

---

## 5. Phased rollout (each phase shippable & independently tunable)

- **Phase 0 — Substrate (perf-only, byte-identical).** TokenIndex + lazy decay + stored clock; clean the `Math.random` smell; bump `SNAPSHOT_VERSION` with a v1→v2 defaulting loader. Pure performance win, no behavior change — buys headroom for 30+ agents.
- **Phase 1 — Individuation + predictive priors (no transmission yet).** `CognitiveBias` lens; RPE fold + Pearce-Hall gain + RPE-gated salience; `expectationPrime`; entity-node reputation with **confidence decoupled from retrievability**; reputation→first-meeting prior; **decay wired for all 17 ledgers.** *Verify:* identical events individuate; a planted reputation biases a first meeting; grudges form on surprising betrayals then soften.
- **Phase 2 — Dyadic claims + agreement-bonding.** Claim primitive + `gossip.ts`; gossip beat inside `conversation.step`; agreement-bonding into `updateBond`; trust-scaled grudge with re-seed-on-recall. *Verify:* a claim copies A→B with a confidence discount; two agents who share a dislike gain affection while dissenters gain tension (factions of two).
- **Phase 3 — Cross-venue reputation + structure.** Feed subtweets (`aboutId`) + shared-post overhear divergent encoding; softmax/ε targeting; 2–3 orthogonal issue axes; union-find faction/scapegoat derived-read on the standup throttle + a grapevine UI panel. *Verify:* one staged feed blowup mints opposite claims in observers and a visible 2-faction split; foodcourt agents acquire reputations via the feed alone.
- **Phase 4 — Organizational coupling + Mara bridge.** Reputation/grudge into `company.ts` `coordFor`/`arbitrateKind` (work factions); bridge Mara onto the shared entity-node reputation substrate. *Verify:* a rumor measurably shifts who leads / what the boss prioritizes; Mara pre-judges a named agent she's only heard about.
- **Phase 5 — Sleeper effect + consolidation flavor.** Source-amnesia decay (source fades faster than content — now possible because confidence ≠ retrievability); reputation-schema consolidation during rest (reuse `consolidate()`/`reflect()`, optional LLM prose). *Verify:* a low-credibility feed rumor gains believability over sim-days and is later recalled as firsthand.

---

## 6. Scientific caveats honored (skeptics' corrections)

- **Reconsolidation is GATED, not universal.** Drift only on prediction-error/mismatch at recall, with a **strength/age brake** `malleability ∝ 1/(1 + k·gist_strength·log(1+recallCount))`. Confirmatory recalls *strengthen* (testing effect), not rewrite. (The current codebase drifts on *every* recall — an over-drift bug this fixes.)
- **Confidence ≠ fidelity.** Flashbulb memories are vivid/confident, **not accurate.** A heavily-reconsolidated (inaccurate) grievance can carry high confidence — "I *know* you said that" — which is what fuels stubborn feuds. This decoupling is also what lets illusory-truth and the sleeper effect actually manifest.
- **Power-law, not exponential forgetting** (ACT-R/Petrov O(1) — codebase already close).
- **Mood-congruent retrieval needs a mood-repair term** + fading-affect-bias, or every agent spirals into depression.
- **Bounded-confidence has no repulsion term** — factions come from *fragmentation* (sub-populations that never converge), not active pushing-apart.
- **Reputation stays private + public**, loosely coupled — a single global scalar would erase the divergence the whole system creates.
- **Negativity bias** (`bad > good`) is the right default for the *update* rule, softened by fading-affect-bias on *decay*.

## 7. Biggest risks & mitigations

| Risk | Mitigation |
|---|---|
| **Contact starvation (R0<1)** — reputations fizzle | instrument `claims-corroborated` vs `claims-decayed`/day; tune decay to the *measured* contact rate; scope claims office-local until confirmed; the `aboutId` feed channel is the primary lift |
| **Runaway negativity / one-scapegoat monoculture** | reversion-to-mean in reputation; softmax targeting + per-dyad gossip cooldown; orthogonal issue axes; weak positive-gossip channel; wired ledger decay; grudge gated on smoothed RPE |
| **Save/branch divergence** | all stochastic draws through the threaded mulberry32; `memgraph` stays RNG-free; new fields round-trip `toJSON/loadJSON`; smoke-test serialize-mid-gossip → byte-identical |
| **Mara disjointness** (dual ledgers + ephemeral MindLite) | the one genuine refactor, deferred to Phase 4; documented exception until bridged |
| **Tuning fragility (~25 constants)** | one global *distortion/temperature* knob + one *transmission* knob; hard clamps everywhere; staged rollout tunes each layer against a fixed seed |
| **Claim/entity-node pollution** | `addClaim` resolves `subjectId` to canonical `entityByName` id; `kind==='claim'` excluded from every recall site used for speech/consolidation |

---

*Predicted emergent behaviors (all LLM-free): town scapegoats that form without authorship, cross-cutting factions around contested events, grudges that outlive their cause, illusory-truth rumors "everyone knows," opinion leaders on the feed, alliances of convenience (enemy-of-my-enemy), self-fulfilling first impressions, betrayal grudges, pleasant-surprise repair arcs, and reconciliation when a direct warm encounter overturns hearsay.*
