# Memory & Social Cognition in ExposomeSim
## Research Report and Proposed Redesign

*Report date: 2026-07-03. Companion implementation spec: [`MEMORY_V2_DESIGN.md`](MEMORY_V2_DESIGN.md).*

---

## Executive summary

ExposomeSim runs tens of autonomous characters on a tiny language model (qwen ~0.6B, no chain-of-thought, one in-flight LLM call at a time — and today only *Mara* uses it at all). The question this report answers: **how should the agents' memory system be built so that it produces interesting, complex, realistic social dynamics — rivalries, alliances, gossip, reputations, misunderstandings, grudges, factions — without relying on the intelligence of the LLM?**

A multi-agent research pipeline surveyed the relevant science and engineering, and three independent design teams proposed and critiqued complete systems. **The convergent conclusion, from both the neuroscience and 20+ years of game AI, is that almost none of the "intelligence" of realistic memory lives in language or reasoning — it lives in cheap numeric bookkeeping.** A weighted retrieval score over a few hundred scalars per agent is what actually decides what an agent remembers, whom it likes, which social move it makes, and how its beliefs drift. The 0.6B model's only necessary job is **surface realization**: turning a pre-selected `(action, target, topic, memory-gist)` tuple into a line of dialogue. **Substrate decides; model narrates.**

The recommended design — **"The Reputation Engram"** — adds exactly one missing primitive: a **bias-encoded, transmissible evaluative *claim* about a third party**, stored as a facet on the existing memory-graph entity node. Claims spread between agents as an information epidemic, aggregate into reputation, are injected into the body as self-fulfilling priors, and harden into trust-scaled grudges — with rivalries, factions and scapegoats emerging as *derived reads*, never stored state. Critically, the adversarial review found the sim's real contact graph cannot support a naïve gossip epidemic, so the design **fixes the substrate first** (a net performance win) before adding social features. Full implementation spec and a six-phase rollout are in `MEMORY_V2_DESIGN.md`.

---

## Part I — Methodology

This report was produced by a deterministic multi-agent orchestration, not a single pass:

**Research phase (12 agents, ~428k tokens).** Six research agents each independently surveyed one facet of memory science, instructed to extract *cheap, non-LLM computational mechanisms* suitable for tens of agents. Each finding was then handed to a **skeptic verifier** that spot-checked citations, flagged overclaims, and distilled the most implementable ideas. Citations came back unusually clean; the skeptics caught several genuine errors (documented in §II.7).

**Design phase (7 agents, ~822k tokens).** Three design agents independently proposed complete memory systems from deliberately different lenses — (a) inter-agent gossip/reputation, (b) within-agent reconstruction/identity, (c) memory as a behavior controller. Each proposal was **adversarially stress-tested** by a reviewer simulating 30 agents over many days to find where it breaks. A synthesis-judge then scored all three and merged their non-overlapping strengths into a single blueprint.

The entire pipeline was grounded in a prior implementation-level map of the current codebase, so every proposal targets real files and real integration seams.

---

## Part II — The research

### II.1 The dominant finding

Across all six facets the same conclusion recurred: **the retrieval score is the steering wheel, not the LLM.** A Generative-Agents-style weighted sum — `score = wR·recency + wI·importance + wV·relevance + wMood·moodFit + wSpread·spread` — is a handful of multiplies per memory, and it alone decides which ~3–5 memories a tiny model ever sees. Emotion wires in *here* (importance ← arousal at encoding; moodFit ← current mood; retrieval-noise temperature ← stress), making the retrieval score the entire interface between the sim's neurotransmitter/hormone substrate and cognition.

### II.2 Facet 1 — Neurosymbolic & computational memory models

Three lineages, each handing over a cheap mechanism:

- **Symbolic cognitive architectures (ACT-R, SOAR).** Declarative memory is "chunks," each with a scalar *base-level activation* that rises with rehearsal and decays as a **power law** of time, boosted by spreading activation, tolerant of approximate cues (partial matching), and corrupted by logistic retrieval noise. One float + a sparse association graph per memory. *SOAR chunking* caches `(situation → action)` so deliberation becomes a reflex — a way to make the LLM a fallback, not a per-tick cost. *(Anderson & Schooler 1991; Anderson et al. 2004; Laird 2012; Petrov 2006 O(1) approximation.)*
- **Connectionist/vector models.** Hopfield & modern Hopfield networks give content-addressable *pattern completion* (a partial cue relaxes to the nearest memory) as one softmax·matmul — and at low temperature return a *blend* of similar memories (gist/stereotype). Vector-Symbolic Architectures / Holographic Reduced Representations bind role–filler structure ("agent=Bob, action=insult, target=me") into one fixed-width vector, degrading gracefully as more is bundled (built-in forgetting). Complementary Learning Systems mandates **two stores** — a fast episodic buffer and a slow semantic store updated by interleaved replay. *(Hopfield 1982; Ramsauer et al. 2020; Plate 1995; Kanerva 2009; McClelland, McNaughton & O'Reilly 1995; Kumaran, Hassabis & McClelland 2016.)*
- **LLM-agent memory.** Stanford's Generative Agents score memories by recency + importance + relevance and periodically "reflect" into higher-level beliefs; MemGPT pages memory in and out of a small context like virtual RAM. *(Park et al. 2023; Packer et al. 2023.)*

### II.3 Facet 2 — Formation & consolidation

Memory is built by successive **filters**, each a cheap gate:
- **Encoding is gated by novelty / prediction error × arousal**, not mere exposure — the hippocampal–VTA loop lets surprise "pay for" its own storage. *(Lisman & Grace 2005; Schultz, Dayan & Montague 1997.)*
- **Synaptic tagging & capture / behavioral tagging** — a strong event rescues nearby weak memories (why incidental details around a dramatic moment survive). *(Frey & Morris 1997; Moncada & Viola 2007.)*
- **Systems consolidation (CLS)** — fast hippocampus, slow neocortex, gist extracted over replay. *(McClelland et al. 1995; Squire & Alvarez 1995.)*
- **Engram co-allocation** — memories formed close in time share an ensemble and cue each other (the basis of associative reminiscence / gossip chains). *(Cai et al. 2016; Josselyn & Frankland 2018.)*
- **Sleep replay is prioritized** (emotional/rewarded/surprising) and paired with global synaptic down-scaling — the survive/fade decision is made largely offline. *(Wilson & McNaughton 1994; Diekelmann & Born 2010; Tononi & Cirelli 2014.)*
- **Schema-dependent fast-track** — information congruent with an existing schema consolidates almost immediately; this is the root of stereotype-consistent memory bias. *(Tse et al. 2007, 2011.)*

Computational upshot: `encode_strength = clamp(novelty · (0.3 + arousal) · (0.5 + |RPE|))`; a two-tier episodic/semantic store; one **nightly replay pass** (prioritized experience replay + down-scaling) that decides survival, manufactures reputations, and bounds memory — reusing the sim's existing sleep subsystem.

### II.4 Facet 3 — Retrieval, reconsolidation & drift

The best-replicated finding in a century of work: **memory is reconstructive, not a recording.** Retrieval rebuilds an episode from a sparse trace plus the agent's current schemas, mood and social input — and **writes the reconstruction back** (reconsolidation). Iterated, memories relax toward the agent's schema and social consensus. *(Bartlett 1932; Nader, Schafe & LeDoux 2000.)* Drift mechanisms: schema gap-filling and DRM-style false memories *(Roediger & McDermott 1995; fuzzy-trace theory, Reyna & Brainerd)*; source-monitoring errors turning hearsay into "firsthand" *(Johnson)*; misinformation implanted by leading questions *(Loftus & Palmer 1974; Loftus, Miller & Burns 1978)*; retrieval-induced forgetting of competitors.

**Critical correction (see §II.7):** reconsolidation is **not** an every-recall overwrite — it is *gated* by prediction-error/mismatch and braked by memory age/strength. Confirmatory recalls *strengthen* (the testing effect); only surprising ones rewrite.

### II.5 Facet 4 — Emotion–cognition

Arousal modulates memory at three separable stages. The amygdala acts as a **post-encoding gain knob** *(McGaugh 2004; Cahill et al. 1994)*; the dose–response is an **inverted-U** (moderate enhances, extreme fragments — central emotional gist kept, peripheral detail lost, i.e. weapon-focus) *(Easterbrook 1959; Loftus, Loftus & Messo 1987)*. Practical hooks: an **appraisal lookup table** mapping physiology → a *directed* emotion with a target (other+harm→anger@X, other+help→gratitude@X, other-succeeds→envy) — the body→society bridge; a **somatic-marker EMA** per entity with negativity-biased learning that can pre-empt the LLM; **peak-end** episode compression *(Fredrickson & Kahneman 1993)*; **fading-affect bias** so negatives fade faster than positives (reversed for high-neuroticism agents → forgiveness vs. rumination) *(Walker & Skowronski)*; and a **Zeigarnik open-loop flag** so unresolved slights stay intrusive until closed (a cheap revenge/reconciliation engine).

### II.6 Facet 5 & 6 — Social/collective memory and game-AI systems

**The differences between what agents remember are the raw material of social structure.** Transactive memory (who-knows-what) creates specialization and status *(Wegner)*; collaborative recall converges group memories *(Basden et al. 1997)*; **audience tuning** rewrites the teller's own memory toward what they said — but *only* to a trusted in-group *(Echterhoff, Higgins & Groll 2005)*, a free source of in-group homogenization + out-group divergence. Twenty years of game AI show how to do all this cheaply and *without reasoning*: additive decaying typed "thoughts" (RimWorld/The Sims), influence-rule volition tables (Prom Week / Comme il Faut / Ensemble), and **rumor tokens that copy-and-mutate on contact** (Dwarf Fortress, Talk of the Town). Two population models matter: **bounded-confidence opinion updating** (Deffuant–Weisbuch: converge only if the gap is small, else do nothing) spontaneously fragments a town into stable **factions/cliques** — unlike DeGroot averaging, which collapses to boring global consensus; and **negativity-biased reputation EMAs** make bad reputations sticky and trust slow to build *(Baumeister 2001; Nowak & Sigmund 1998)*.

### II.7 Scientific corrections from the skeptic pass

The verification agents materially improved rigor. The load-bearing corrections, all folded into the design:

1. **Power-law, not exponential forgetting** (Petrov O(1) approximation; the codebase is already close).
2. **Reconsolidation is prediction-error-gated with an age/strength brake** — not a universal overwrite, and not deletion. *The current codebase drifts on every recall — an over-drift bug.*
3. **Flashbulb memories are high-confidence, not high-accuracy** → store *confidence* and *fidelity* as separate floats.
4. **Mood-congruent retrieval needs a mood-repair term** or every agent spirals into depression.
5. **Bounded-confidence has no repulsion term** — factions emerge from *fragmentation*, not active pushing-apart.
6. **Keep reputation private + public**, loosely coupled — a single global scalar erases the divergence the whole system creates.
7. Weapon-focus is driven by *unusualness* + arousal, not threat alone; audience tuning is gated on in-group trust.

---

## Part III — The current system and its gaps

The sim already has a sophisticated ACT-R + Generative-Agents memory graph (`memgraph.ts`, one per character: episodic/semantic/entity/schema nodes, emotion-gated salience, recency+salience+relevance retrieval, reconsolidation, consolidation→gist, reflection→schema) and a two-sided relationship ledger (`relationship.ts`: familiarity/affection/trust/attraction/tension with reversible stages). The gaps that block emergent social complexity:

1. **No inter-agent information flow whatsoever** — no gossip, reputation, or shared/divergent belief. *(The single biggest lever.)*
2. **No confidence/fidelity split** — can't model confidently-held false memories.
3. **Reconsolidation fires on every recall** → over-drift.
4. **Two disjoint social stores** (ledger scalars vs. graph entity nodes) with no consistency link.
5. **`now()` returns `max(lastRecalledAt)`, not the sim clock** → recency scoring is subtly broken; and it's an O(n) scan.
6. **`decayBonds` runs on Mara's ledger only** → the 17 roster ledgers never decay, so grudges can only harden.
7. **The LLM only ever reaches Mara's memory** — the other agents are template-driven, which is exactly why a substrate-first design is the right call.

---

## Part IV — Three independent proposals and the judge's verdict

| # | Proposal | Core idea | Judge (eff / social / no-LLM / impl / science) |
|---|----------|-----------|---|
| 🥇 | **The Grapevine** | the transmissible **claim** as an entity-node facet; reputation & factions as *derived reads*; agreement-bonding folded into the existing bond path | 8 / 8 / 10 / 6 / 7 |
| 🥈 | **Reconstructive Memory** | per-agent **CognitiveBias** lens + reconstruction-on-recall so identical events individuate into different remembered pasts | 9 / 6 / 10 / 6 / 8 |
| 🥉 | **Memory-as-Controller** | entity nodes as **predictive controllers**: soma prior-injection + RPE learning + trust-scaled grudges | 8 / 5 / 10 / 5 / 7 |

All three were rated **"promising-with-fixes."** Crucially, **all three adversarial reviews independently discovered the same structural fact**: the sim's contact graph cannot fuel a naïve gossip epidemic. Face-to-face conversation is floor-siloed into three disjoint pools (and the foodcourt trio never converse), so **the feed is the only cross-venue channel**; conversation warmth is positive-biased, so the natural attractor is a mostly-warm blob rather than factions; and `decayBonds` runs on Mara alone, so roster grudges can only harden into universal wariness. This grounding is what turns the design from a whiteboard fantasy into something implementable.

---

## Part V — Proposed solution: "The Reputation Engram"

**Thesis.** Add one primitive — a bias-encoded, transmissible evaluative **claim** about a third party (`{subjectId, topic, polarity, confidence, originId, sourceId, hops, firsthand}`), stored as a facet on the existing entity node so it inherits retrieval, decay and persistence for free. Each agent encodes and mutates claims through a cheap per-agent **CognitiveBias** lens; claims aggregate into entity-node **reputation** that is **injected into the soma as a self-fulfilling prior before every encounter**; reward-prediction-error folds surprising betrayals into slow, **trust-scaled grudges**. Rivalries, alliances, scapegoats and in-groups are **union-find derived reads over agreement** — never stored state — exactly as the company goal is already a projection of the boss's memory and Maslow needs are read off the soma.

**Because the contact graph can't support a naïve epidemic, the design fixes the substrate first:**
- **Perf (Phase 0, byte-identical):** a `TokenIndex` inverted index + **lazy read-time decay** replace the per-tick `decayAll` sweep, and a stored clock replaces the O(n) `now()` — a *net speedup* that pays for all the new social machinery.
- **Reach:** give gossip a real referent on the channel that has events — optional `aboutId` on feed posts (subtweet/callout) as the primary cross-venue path, plus shared-post **overhear = divergent bystander encoding** so many readers each mint a blame-by-prior claim.
- **Decay:** wire `decayBonds` for all 17 roster ledgers so grudges can soften and reconciliation is reachable.
- **Determinism:** all claim mutation lives in a new `gossip.ts` behind the threaded PRNG; `memgraph` stays RNG-free; `kind==='claim'` is filtered out of ordinary recall so claims never leak into utterances.

**Mechanisms (all O(1) per event, all LLM-free):** bias-gated salience + flashbulb anchoring; reconstruction-on-recall (gated); self-serving self-schema; **soma prior-injection** (`expectationPrime`); **RPE-gated encoding** with a Pearce-Hall adaptive learning rate; **trust-scaled grudges** gated on smoothed RPE; claim genesis, gossip copy-with-mutation (softmax targeting), agreement-bonding into `updateBond`, reputation→first-meeting prior; and faction/scapegoat/grudge **derived reads** via union-find over agreement.

**Six-phase rollout** (each shippable and independently tunable): Phase 0 substrate → 1 individuation + priors → 2 dyadic claims + agreement-bonding → 3 cross-venue reputation + faction reads → 4 org coupling + Mara bridge → 5 sleeper effect. Full data structures, formulas, and verification checks are in [`MEMORY_V2_DESIGN.md`](MEMORY_V2_DESIGN.md).

**Predicted emergent behaviors, all with the LLM off:** town scapegoats that form without authorship; cross-cutting factions around contested events; grudges that outlive their cause; illusory-truth rumors "everyone knows"; feed opinion-leaders; alliances of convenience (enemy-of-my-enemy); self-fulfilling first impressions; betrayal grudges; pleasant-surprise repair arcs; and reconciliation when a direct warm encounter overturns hearsay.

---

## Part VI — Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Contact starvation (R0 < 1)** — reputations fizzle | instrument corroborated-vs-decayed claims/day; tune decay to the *measured* contact rate; scope claims office-local until confirmed; the `aboutId` feed channel is the primary lift |
| **Runaway negativity / one-scapegoat monoculture** | reversion-to-mean; softmax targeting + per-dyad cooldown; orthogonal issue axes; weak positive-gossip channel; wired ledger decay; grudge gated on smoothed RPE |
| **Save/branch divergence** | all draws through the threaded mulberry32; `memgraph` RNG-free; new fields round-trip `toJSON/loadJSON`; serialize-mid-gossip smoke test |
| **Mara disjointness** (dual ledgers + ephemeral MindLite) | the one genuine refactor, deferred to Phase 4; documented exception until bridged |
| **Tuning fragility (~25 constants)** | one global *distortion/temperature* knob + one *transmission* knob; hard clamps; staged rollout tuned against a fixed seed |

---

## Appendix — Key references

*Computational:* Anderson & Schooler (1991); Anderson et al. (2004); Petrov (2006); Laird (2012); McClelland, McNaughton & O'Reilly (1995); Kumaran, Hassabis & McClelland (2016); Hopfield (1982); Ramsauer et al. (2020); Plate (1995); Kanerva (2009); Graves et al. (2014, 2016); Park et al. (2023); Packer et al. (2023).
*Consolidation:* Lisman & Grace (2005); Schultz, Dayan & Montague (1997); Frey & Morris (1997); Moncada & Viola (2007); Squire & Alvarez (1995); Nadel & Moscovitch (1997); Cai et al. (2016); Wilson & McNaughton (1994); Diekelmann & Born (2010); Tononi & Cirelli (2014); Tse et al. (2007, 2011).
*Reconsolidation & drift:* Bartlett (1932); Nader, Schafe & LeDoux (2000); Sevenster/Beckers/Kindt; Loftus & Palmer (1974); Loftus, Miller & Burns (1978); Roediger & McDermott (1995); Reyna & Brainerd (fuzzy-trace); Wang, de Oliveira Alvares & Nader (2009).
*Emotion:* McGaugh (2004); Cahill et al. (1994); Easterbrook (1959); Loftus, Loftus & Messo (1987); Roozendaal, McEwen & Chattarji (2009); Fredrickson & Kahneman (1993); Walker & Skowronski; Fawcett et al. (2013); Bechara et al. (1997); Maia & McClelland (2004).
*Social/collective:* Wegner (transactive memory); Basden et al. (1997); Cuc et al. (2007); Echterhoff, Higgins & Groll (2005); Halbwachs; Assmann; Coman (2016); Momennejad et al. (2019); Nowak & Sigmund (1998); Hirst et al. (2015); Baumeister et al. (2001).
*Systems/models:* Dwarf Fortress; The Sims; RimWorld; Prom Week / Comme il Faut / Ensemble; Versu; Talk of the Town; Daley–Kendall rumor model; Deffuant–Weisbuch; Hegselmann–Krause; DeGroot; Axelrod.

*Full research digests, the three raw proposals, and the adversarial critiques are archived in the session scratchpad (`research-synthesis.md`, `design-proposals.md`, `hybrid-blueprint.md`).*
