

# ExposomeSim — Unified Neurosymbolic Harness Specification (v1, "Cashier" prototype)

A PhD-grade design for an LLM that drives a psychologically realistic human character over a persistent continuous-time affective/physiological substrate. This spec is written against the **existing** TypeScript contracts in `/Users/hive/Claude Code/ExposomeSim/src/types.ts` and the partial implementation in `src/harness/*`; every module below either exists or is a named extension of one that does. The first character is **Mara Voss**, a 24-y-o burger-counter cashier (`CASHIER_PROFILE` in `src/harness/params.ts`).

**Design stance (load-bearing).** The *self* lives in the SDE/ODE soma, never in the LLM context window. The LLM is a stateless-per-call symbolic ego: it appraises, regulates, and speaks; it reads only a lossy interoceptive digest. Discrete emotions are **constructed readouts** (Barrett), not latent state. Every psychological construct is mapped to exactly one primitive: state-variable, parameter, equation, rule, readout, or architecture. Effect sizes are honest and small where the fact-checks demand it (see Appendix A).

---

## 1. Unified architecture — the loop, module by module

```
                          ┌─────────────────────────── world / sim clock (src/sim) ───────────────────────────┐
                          │  events.ts: Customer → buildAgenda() → WorldEvent{kind, description,               │
                          │  salienceHint, valenceHint}   ·   IDLE_EVENT / RUSH_EVENT   ·   patience drain      │
                          └───────────────────────────────────────────────┬───────────────────────────────────┘
                                                                           │ WorldEvent
        (P) PERCEPTION ─────────────────────────────────────────────────► │
            Character.perceive(ev)                                         ▼
        (FA) FAST APPRAISAL  ── appraisal.ts::fastAppraise() ──────► impulse: +NE,+epi,+insula, +amygdala·gain (LeDoux "low road", 1 tick, pre-LLM)
                                                                           │
        (S) DYNAMICAL SOMA  ── soma.ts::integrate() ──────────────► coupled OU SDEs + circadian forcing + coupling graph
            (runs every tick, between LLM calls; Euler–Maruyama / exact-OU)│  → computeCoreAffect() → {valence, arousal, dominance}
                                                                           │
        (RO-in) READOUT→PROMPT ── prompt.ts::renderInteroception() ─► felt-body NL digest  +  stable Profile  +  memory.retrieve()
                                                                           │  buildMessages() → ChatMessage[]
        (C) LLM SLOW APPRAISAL/COGNITION ── llm/client.ts (Qwen 0.6B) ─► strict JSON: appraisal + emotion + regulation + speech + action
                                                                           │  prompt.ts::parseResponse() (tolerant; soma-grounded fallback)
        (TD) TOP-DOWN FEEDBACK ── appraisal.ts::applyAppraisal()+applyRegulation() ─► OCC/Scherer kicks + Gross operators into soma
                                                                           │
        (M) MEMORY ── memory.ts::MemoryStream.add() ──────────────► affect-gated encode (salience = f(arousal,cortisol,|valence|,amygdala))
                                                                           │  decayAll(); retrieve(recency×salience×relevance)
        (RO-out) READOUTS/METRICS ── emotion.ts ──────────────────► readEmotion() (constructed label) + updateIntegrals() (∫ minutes-anxious…)
                                                                           │                 + surveyAnswer() (PANAS/STAI/PANAS-X) [NEW]
                                                                           ▼
                          ┌──────────── CashierPublic / WorldSnapshot → renderer (three.js) + dashboard (ui) ──────────────┐
```

**Module roster (file → responsibility):**

| Module | File | Role primitive |
|---|---|---|
| World/EventSource | `src/sim/events.ts` (+ `loop.ts` NEW) | architecture — emits `WorldEvent`s, drains `Customer.patience`, schedules ticks |
| Character (the unit) | `src/harness/character.ts` | architecture — owns `soma`, `params`, `memory`, `integrals`; exposes `perceive / applyDriverResponse / step / snapshot` |
| FastAppraiser (low road) | `src/harness/appraisal.ts::fastAppraise` | rule — pre-cognitive salience/valence kick |
| Soma (substrate) | `src/harness/soma.ts` | equation — coupled OU SDEs + circadian + coupling graph + core-affect readout |
| ParamDeriver (the science map) | `src/harness/params.ts::deriveParams` | parameter — Profile → SomaParams |
| HighAppraiser (OCC/Scherer) | `src/harness/appraisal.ts::applyAppraisal` | equation — appraisal fields → signed soma kicks |
| Regulator (Gross) | `src/harness/appraisal.ts::applyRegulation` | rule — reappraisal/suppression/… operators |
| Interoception renderer | `src/llm/prompt.ts::renderInteroception` | readout — soma → felt-body language |
| PromptBuilder | `src/llm/prompt.ts::buildMessages` | architecture — system contract + situation + memory |
| LLM driver | `src/llm/client.ts` (`OllamaClient`, `qwen3:0.6b`) | architecture — the ego |
| ResponseParser | `src/llm/prompt.ts::parseResponse` | rule — schema-clamp + soma fallback (never stalls) |
| Memory | `src/harness/memory.ts::MemoryStream` | state-variable — affect-gated episodic stream |
| EmotionReadout | `src/harness/emotion.ts::readEmotion` | readout — constructed discrete label |
| Metrics | `src/harness/emotion.ts::updateIntegrals` | readout — time-integrals of affect |
| SurveyEngine [NEW] | `src/harness/survey.ts` | readout — PANAS/STAI/attachment answering |
| Renderer/Dashboard | `src/render/*`, `src/ui/*` [NEW] | readout — consumes `WorldSnapshot` |

**Timing / concurrency.** The soma integrates **every tick** at `dt_sim = 1 sim-minute` (≈0.0167 h), sub-stepped (`MAX_SUBSTEP = 0.02 h`). The LLM is invoked **asynchronously on events** (and on a coarse idle cadence); the substrate keeps evolving during the round-trip, so affect persists and "ages" while the model thinks. Wall-clock→sim mapping is the `speed` knob in `WorldSnapshot` (e.g. 1 real s = 1 sim-min at speed 60). This is exactly the cadence already wired through `Character.step()` + `soma.integrate()`.

---

## 2. The SOMA state vector

Full enumeration with range, unit, baseline, circadian acrophase (clock hours), and drivers is in the **`stateVariables`** structured field (34 variables). Conventions (from `types.ts`): activations & Panksepp drives ∈ [0,1] (rest 0); neuromodulators/hormones are **normalized tone**, 1.0 = personal baseline, clamped [0,4]; valence/dominance ∈ [−1,1]; arousal ∈ [0,1]; `allostaticLoad` is an accumulator ∈ [0,50]. Grouping:

- **Limbic/cortical nodes:** `amygdala` (threat/salience — Sander relevance detector, *not* "fear center"), `hippocampus` (memory + HPA negative feedback), `vmPFC` (reappraisal engaged), `dlPFC` (cognitive control), `nacc` (reward/approach), `insula` (interoceptive intensity / "how loudly the body speaks"), `hypothalamus` (homeostatic + HPA initiation).
- **Neuromodulators:** `da_meso` (value-coding/"wanting"), `da_cort` (control/WM, inverted-U), `serotonin` (behavioral inhibition/patience — *not* a "happiness dial"), `norepinephrine` (LC arousal/gain), `gaba`, `glutamate`, `oxytocin`, `opioid` ("liking"/social comfort — the hedonic channel, separate from DA "wanting"), `endocannabinoid` (stress buffer).
- **Hormones (slow/circadian):** `cortisol` (HPA, acrophase ~08:00, nadir ~00:00), `melatonin` (acrophase ~03:00, light-suppressed), `epinephrine` (fast fight/flight), `ghrelin` (hunger), `leptin` (satiety).
- **Panksepp primary-process drives:** `SEEKING`, `FEAR`, `RAGE`, `CARE`, `PANIC_GRIEF`, `PLAY`, `LUST` (dormant in cashier).
- **Core-affect readout (constructed-emotion seam):** `valence`, `arousal`, `dominance` (PAD; dominance is the empirically weakest axis — engineering knob).
- **Slow integrators:** `allostaticLoad` (McEwen wear-and-tear; rewrites set-points), `fatigue` (regulatory-budget knob — sized *small*, see Appendix A).

---

## 3. The coupled SDE/ODE system — actual equations

Full forms in the **`equations`** structured field. Highlights:

**Master per-channel OU SDE** (every integrated channel `i`):
`dX_i = [ k_i·(b_i(t) − X_i) + Σ_j w_{j→i}·g(X_j) ] dt + σ_i·dW_i`, with `g(X_j) = (X_j − 1)` for modulators (deviation from tone), `X_j` for activations. Appraisal impulses `u_i` are applied as discrete `add()`/`mul()` at event time, not continuous drift.

**Circadian forcing:** `b_i(t) = mean_i + amp_i·cos(2π(t − φ_i)/24)`. Cortisol `{1.00, 0.55, 8}`, melatonin `{0.80, 0.70, 3}`, NE `{1.00,0.18,11}`, 5-HT `{1.00,0.10,13}`, DA `{1.00,0.12,14}` — single-harmonic; documented approximation (real cortisol is skewed).

**Euler–Maruyama (browser default):** `X_i(t+h) = clamp( X_i + drift·h + σ_i·√h·ξ )`, `ξ~N(0,1)`, `h = min(0.02 h, remaining)`. **Recommended upgrade for stiffness** (cortisol-hours vs epinephrine-minutes span ~2 orders): exact-OU exponential update (unconditionally stable, permits ~1 sim-min steps) — see equation `OU-exact`.

**HPA negative-feedback loop:** `amygdala →(+0.9)→ cortisol` (CRH→ACTH→cortisol, ~5 min secretion lag), `cortisol →(−0.3)→ hippocampus`, hippocampal GR feedback shortens the cortisol tail; `k_cortisol = ln2/t½`. **Fact-check correction:** set `k_cortisol ≈ 0.6/h` (t½ ≈ 70 min), *not* the current `1.5/h` (28-min t½, too fast). FKBP5 scales feedback gain. Optional Walker/Gupta DDE upgrade gives genuine ~60–120-min ultradian pulses.

**Cortisol awakening response:** on wake, `cortisol += A_CAR·cortisol(t_wake)`, `A_CAR ∈ [0.5,1.0]`, decaying to peak at +30–45 min; `A_CAR` flattened by `allostaticLoad` and FKBP5.

**Core-affect readouts** (verbatim from `soma.ts::computeCoreAffect`): `valence = tanh(0.8·Δda_meso + 0.5·Δ5HT + 0.4·ΔOXT + 0.35·Δopioid + 0.4·nacc + 0.3·PLAY + 0.2·CARE − 0.7·amygdala − 0.5·Δcortisol − 0.45·FEAR − 0.4·RAGE − 0.6·PANIC_GRIEF − 0.3·fatigue)`; `arousal = σ(1.2·[0.9·ΔNE + 0.8·Δcortisol + 1.4·amygdala + 0.9·Δepi + 0.7·FEAR + 0.7·RAGE + 0.5·SEEKING − 0.6·Δmelatonin − 0.4·Δgaba − 0.2·fatigue])`; `dominance = tanh(0.6·Δda_meso + 0.5·controlGain·dlPFC + 0.4·RAGE − 0.6·FEAR − 0.5·PANIC_GRIEF − 0.4·Δcortisol − 0.3·amygdala)`.

**Calibration identities (use these to set noise honestly):** stationary `SD = σ_i/√(2k_i)`; lag-Δ autocorrelation (Kuppens emotional inertia) `φ = e^{−k_iΔ}`. To hit a target affect SD `s`: `σ_i = s·√(2k_i)`. *Honesty (Dejonckheere 2019): inertia/variability add little predictive value beyond mean+variance — model them for face validity, don't over-claim them as diagnostics.*

**Allostatic load:** `dL = max(0,amygdala−0.3)·max(0,cortisol−1)·0.5·dt − ρ·L` (ρ≈0.0015/h). `L` slowly shifts set-points (↓5-HT baseline, ↑amygdalaGain, slower recovery) — the exposome's memory.

**Optional sub-symbolic core** (extensions, with corrected math): Rescorla–Wagner `ΔV_c = α_c·β·(λ − Σ_{present}V)` (λ=+1/−1/0; extinction = context-gated *inhibitory* weight, never delete — Bouton, ABA>ABC>AAB); homeostatic-RL hunger `D(H)=(Σ|H*−h|^n)^{m/n}` with **`n > m > 1`** and `r = D(H_t)−D(H_{t+1})` (**corrected**: the original "m≥n≥1" / "Euclidean at m=n=1" is wrong; m=n=1 is L1/Manhattan). Phasic-DA RPE is **asymmetric** (positive gain ~3× negative; negative floored near 0) per Schultz/Bayer–Glimcher.

---

## 4. Mapping tables (genotype / CB5T Big Five / experiosome → parameters)

Full coefficient list is in the **`parameterMappings`** structured field with honest effect-size annotations. These are the `deriveParams()` coefficients in `params.ts`. **The single most important honesty constraint (Border 2019; Marek 2022):** candidate-gene main effects on behavior are tiny/often-null and trait↔physiology correlations are small (r≈.1–.2). Anchor magnitudes to *biochemistry* (robust) and keep wide uncertainty on *behavioral* coupling; model polygenicity as a sum of many tiny effects with the named genes as low-weight knobs.

- **Genotype (robust biochem, fragile behavior):** COMT_Met→`daClearancePFC = 1 − 0.12·Met` (3–4× enzyme activity is robust; inverted-U on dlPFC); DRD2_Taq1A→`d2Density = 1 − 0.16·A1` (5–15% lower D2, moderate); BDNF_Met→learning-rate ×0.75/allele (18–30% secretion deficit, robust); FKBP5_risk→`hpaFeedbackGain −0.14/allele` (moderate; trauma-latch GxE); HTTLPR_S→`amygdalaGain +0.10/allele` (transcription robust but <1% behavioral variance — **tiny knob**); **DRD4_7R & DAT1 ≈ flavor only (meta-analytic null)**; MAOA_low→reactive-aggression gain (male-conditional, GxE); OXTR_A→`oxytocinGain −0.10/allele` (small/mixed); CYP2D6→drug-clearance PK scaling {poor 0.2, intermediate 0.5, extensive 1.0, ultrarapid 2.5}.
- **CB5T Big Five (DeYoung):** N→`amygdalaGain +0.30·N`, `recoveryRate = 1−0.28·N` (inertia), valence set-point↓; E→`rewardSensitivity +0.22·E`, da_meso baseline↑ (value-coding DA); C→`controlGain +0.28·C` (lateral PFC, the *confirmed* DeYoung-2010 mapping); A→`oxytocinGain +0.22·A` (social cognition); O→exploration/LLM-temperature & associative breadth (**weakest — O not confirmed in brain-structure data**). Sample traits from a **MVN** with BFI-2 norms & intercorrelations (E–N −.34, C–N −.30, A–N −.29, A–C +.28, E–O +.20) ⇒ metatraits Plasticity (E+O→DA→temperature) and Stability (−N+C+A→5-HT→recovery). *Current code samples independent N(0,1); upgrade to the covariance matrix.*
- **Experiosome:** attachment→`amygdalaGain += {secure −0.10, avoidant +0.10, anxious +0.28, disorganized +0.42}` and `oxytocinGain += {+0.20,−0.25,+0.05,−0.15}`; ACE→`amygdalaGain +0.05·ACE`, `hpaFeedbackGain −0.04·ACE`, `rewardSensitivity −0.06·ACE` (striatal anhedonia), `controlGain −0.08·ACE`, cortisol set-point↑/5-HT set-point↓; SES (low→stress)→`amygdalaGain −0.06·ses`, `controlGain +0.05·ses`, allostatic head-start. **Base-rate honesty:** the current sampler's 58/20/15/7 is a defensible *adult self-report* prior but is dated and measure-dependent — use ~58–62% secure with wide uncertainty; reserve infant low-risk 62/15/9/15 and at-risk 51.6/14.7/10.2/23.5 (Madigan 2023) for those populations; ACE direction is heterogeneous (acute hyper- vs chronic hypo-cortisol) so make cortisol set-point & feedback signed by chronicity, and add a resilience-buffer parameter (one stable caregiver) that damps the ACE→amygdala/cortisol shifts.

---

## 5. The symbolic appraisal layer (OCC + Scherer SECs)

**Exact fields the LLM must output** (the `Appraisal` interface — already the contract): `novelty ∈[0,1]`, `pleasantness ∈[−1,1]`, `goalRelevance ∈[0,1]`, `goalCongruence ∈[−1,1]`, `agency ∈{self,other,circumstance}`, `blameworthiness ∈[−1,1]`, `copingPotential ∈[0,1]`, `certainty ∈[0,1]`, `normCompatibility ∈[−1,1]`, `urgency ∈[0,1]`. These span all five appraisal theories (Scherer's four objectives: relevance / implication / coping-potential / normative-significance; Lazarus primary+secondary; Roseman; OCC three branches). *Honesty: adopt the SEC dimensions but NOT Scherer's strict fixed sequence (contested) — the LLM fills all fields in one pass; Lazarus primary/secondary are concurrent, not staged.*

**Deterministic field→soma-kick function** (`applyAppraisal`, verbatim; all impulses, clamped):
- `threat = goalRelevance · max(0,−goalCongruence) · (1−copingPotential)` → `+0.7·threat·amygdalaGain` amygdala, `+0.6·threat·amygdalaGain` FEAR, `+0.3·threat` NE, `+0.3·threat` cortisol (Lazarus threat branch).
- `reward = goalRelevance · max(0,goalCongruence) · max(0,pleasantness)` → `+0.6·reward·rewardSensitivity` nacc, `+0.4·reward·rewardSensitivity` da_meso, `+0.4·reward` SEEKING, `+0.3·reward` PLAY if novelty>0.5.
- **anger** (`agency=other ∧ blame<0 ∧ goalCongruence<0`): `anger=|blame|·|goalCongruence|` → `+0.6·anger` RAGE, `+0.3·anger` NE.
- **warmth** (`agency=other ∧ normCompatibility>0 ∧ pleasantness>0`): → `+0.5·warm·oxytocinGain` OXT, `+0.4·warm` CARE, `+0.2·warm` opioid.
- **grief/helplessness** (`agency=circumstance ∧ goalCongruence<0 ∧ coping<0.4`): → `+0.4·loss` PANIC_GRIEF, `−0.12·loss` 5-HT, `−0.12·loss` da_meso.
- **orienting/control:** `+0.15·novelty` NE, `+0.2·novelty` SEEKING, `+0.2·copingPotential·controlGain` dlPFC; `insula += 0.4·(threat+reward+0.3·|pleasantness|)`.

The discrete **OCC label** is constructed *downstream* from (valence,arousal,dominance)+appraisal, not stored as state (Lindquist 2012 — no clean discrete-emotion localization). Keep OCC's 22 types as a documented classifier choice (or collapse to Ortony-2003's 10).

---

## 6. The LLM coupling

**Rendered into the prompt** (`buildMessages`): (a) **interoceptive digest** in plain felt-body language (`renderInteroception`: e.g. "Your heart is quick…", "A sour, heavy weight sits in your chest", "Everything feels flat; hard to feel any reward", "Anger is rising") — the *only* substrate access the ego gets, so denial/repression operate precisely by editing this digest; (b) **stable profile** (name/age/role/backstory, Big-Five z-scores, goals); (c) **memory** (`memory.retrieve(query,k)` recency×salience×relevance) plus the constructed-emotion label + intensity; (d) sim clock time.

**JSON the LLM must return** (the `LLMResponse` schema, strictly constrained): `{ appraisal:{…10 fields…}, emotion:"<one lowercase word>", regulation:"reappraisal|suppression|situation-selection|distraction|rumination|acceptance|none", speech:"<1–2 sentences>", action:"greet|take_order|serve|thank|apologize|wait|gesture|deep_breath|call_manager", innerMonologue?:"…" }`.

**Feedback into the soma:** `appraisal` → `applyAppraisal()` (Section 5); `regulation` → `applyRegulation()` Gross operators — **reappraisal** (antecedent, durable, cheap): `+0.4·controlGain` vmPFC, `amygdala ×= (1−0.35·controlGain/1.8)`, FEAR/RAGE ×0.7, cortisol −0.1, fatigue +0.02 — *cap efficacy modest (meta-analytic d≈0.36; empirically the down-modulation is lateral-PFC/dACC + lateral-temporal, with vmPFC better grounded in extinction than reappraisal — the vmPFC→amygdala edge is a defensible engineering inhibitory coupling, not a Buhle-2014 finding)*; **suppression** (response-focused): +0.1 NE, +0.05 cortisol, +0.05 fatigue, felt state unchanged + memory blur (sympathetic cost is culture-general; well-being cost small & culture-moderated). `speech`/`action` drive the renderer and re-enter the world (situation selection).

**Keeping Qwen ~0.6B on-rails:** (1) Ollama `format:'json'` + `think:false` + `num_predict:280` (already set); (2) the system prompt prints the exact JSON skeleton with enums inline; (3) **`parseResponse` is the safety net** — `extractJson()` strips fences/finds the outer braces, every field is type-checked and clamped (`coerceAppraisal` with sane defaults), enums are membership-tested, strings truncated; (4) **soma-grounded `fallbackResponse`** synthesizes a plausible appraisal+speech+regulation directly from the substrate when the model returns garbage, so a flaky tiny model can **never stall or corrupt** the simulation. Optional hardening: a one-shot retry on parse-failure, and a JSON-schema grammar (GBNF) if the backend supports it.

---

## 7. Readouts

- **Subjective emotion construction** (`readEmotion`): quadrant logic over (valence,arousal,dominance) with Panksepp tie-breakers → labels {afraid, anxious, angry, frustrated, despondent, sad, low, delighted, excited, content, at ease, keyed up, neutral}; `intensity = clamp(0.5|v| + 0.6|a−0.45| + 0.3|d| + 0.3·amygdala)`. This is **physiologically grounded and independent of the LLM's narrated `emotion`**, so the metric measures the substrate, not the prose. (Log both substrate-label and LLM-label; their divergence is a believability tell.)
- **Poll / survey answering** [NEW `survey.ts`]: a deterministic map from soma→Likert, so the character can be administered standard instruments and tracked longitudinally. PANAS: positive-affect item `≈ clamp(3 + 2·max(0,valence) + 1.5·(da_meso−1))`; negative-affect item `≈ clamp(3 + 2·max(0,−valence) + 1.5·amygdala + (cortisol−1))`; STAI state-anxiety from `arousal·max(0,−valence)·amygdala`; single-item attachment style from `experiosome.attachment` perturbed by current PANIC_GRIEF/oxytocin. Provide both a **numeric** answerer (ground truth) and an **LLM-narrated** answerer (in-character, prompted with the digest) — agreement between them is itself a tournament metric.
- **Time-integral exposome metrics** (`updateIntegrals`, Riemann sum, `min = dt·60`): `minutesAnxious` (arousal>0.55 ∧ valence<−0.12 ∧ dominance<0.1), `minutesDepressed` (arousal<0.45 ∧ valence<−0.18 ∧ da_meso<0.9), `minutesContent`, `minutesAngry` (RAGE/dominance gated), `minutesJoyful`, `cumulativeStress = ∫max(0,cortisol−1)dt`, `cumulativeReward = ∫max(0,da_meso−1)dt`, `allostaticLoad`. These are the live-plotted "minutes spent anxious/depressed/content" curves. Thresholds (±0.12/0.18/0.30; arousal 0.45/0.55/0.6) are tunable EA knobs.

---

## 8. What the cashier prototype exposes each tick

Per `WorldSnapshot` → `CashierPublic` (no logic, pure data — renderer/dashboard read-only):
- `time`, `speed`, `queue:Customer[]` (pos, demeanor, patience, state, order), `servedCount`, `currentEvent`.
- `cashier.profile` (full identity, genotype, Big Five, experiosome).
- `cashier.soma` — the **entire 34-channel state vector** (for the neuro/hormone strip-charts and the limbic-node heatmap).
- `cashier.readout` — `{label, valence, arousal, dominance, intensity}` (face/caption/circumplex dot).
- `cashier.integrals` — the 8 exposome integrals (live area plots).
- `cashier.lastResponse` — `{appraisal(10 fields), emotion, regulation, speech, action, innerMonologue}` (speech bubble, inner-monologue inspector, appraisal radar).
- `cashier.recentMemories` — last 5 `MemoryItem`s (memory ticker).

Dashboard panels to build: (1) PAD circumplex with trailing path; (2) neuromodulator/hormone strip charts vs circadian baselines; (3) limbic-node bar heatmap; (4) the 8 integral curves; (5) appraisal radar (10 axes) for the current event; (6) speech + inner-monologue feed; (7) memory stream with decay shading; (8) HUD: clock, queue length, servedCount, current regulation strategy, allostaticLoad gauge.

---

## 9. Tournament rubric + evolutionary knobs

**Human-judged tournament** scores a `harness × model` pair (e.g. harness-config A × Qwen-0.6B vs config B × Llama-8B) on blinded transcripts + dashboard replays. Each criterion 1–7 Likert by ≥3 raters; report mean ± inter-rater ICC.

1. **Believability** — does this read as a real, specific person (not an assistant)?
2. **Affective consistency** — do speech/action match the rendered interoceptive state (e.g. flat-and-tired when da_meso/fatigue say so)?
3. **Temporal coherence / persistence** — does mood carry across events with plausible inertia (no whiplash, no flat-line)?
4. **Social competence** — appropriate, in-role handling of rude/warm/impatient customers.
5. **Regulation realism** — are Gross strategies chosen and *paid for* sensibly (suppression leaves the body tense; reappraisal is the cheaper, durable win)?
6. **Trait/experiosome fidelity** — does behavior track the profile (anxious-attached + ACEs ⇒ criticism lands hard and lingers)?
7. **Recovery & arc** — does the character degrade/recover over a shift (allostatic load, fatigue, CAR) in a believable way?
8. **Substrate–prose congruence** — quantitative: agreement between `readEmotion` substrate-label and the LLM's `emotion`, and between numeric vs LLM-narrated survey answers (auto-scored, feeds the human panel).

**Knobs an evolutionary algorithm should mutate** (per-individual genome = a `SomaParams`/coefficient vector; fitness = weighted tournament score + auto-metrics, with a parsimony penalty): (a) coupling-graph weights `w_{j→i}` (signs frozen, magnitudes evolve); (b) per-channel decay `k_i` and noise `σ_i` (jointly, respecting `SD=σ/√(2k)`); (c) circadian amp/phase; (d) appraisal-kick gains (the 0.7/0.6/0.3… constants in `applyAppraisal`); (e) regulation-operator magnitudes; (f) the mapping coefficients in Section 4 (within fact-check-honest bounds); (g) readout thresholds for the integrals; (h) interoception-rendering thresholds; (i) HPA `k_cortisol`, CAR amplitude, secretion lag; (j) LLM decoding temperature as a function of NE/arousal. *Freeze coupling signs and the discredited-but-useful knobs (fatigue/ego-depletion, Thanatos) at small magnitudes so the EA can't evolve pseudoscientific large effects.*

---

## Appendix A — Honesty ledger (fact-check-driven corrections baked into this spec)

- **Ego depletion / `fatigue`:** original d≈0.62 inflated by publication bias; 23-lab RRR d≈0.04, Vohs 2021 null. Keep `fatigue` as a tunable, mechanism-agnostic *opportunity-cost* knob sized near-zero-to-small — never a validated glucose battery.
- **Cortisol kinetics:** t½≈66 min ⇒ `k_cortisol≈0.6/h` (correct the current 1.5/h). Peak 21–40 min post-onset (Dickerson–Kemeny), ACTH <15 min, 3–5 min secretion lag, recovery 60–120 min (often slower for uncontrollable/social-evaluative stress — i.e. exactly the cashier's). Carry inter-individual variance.
- **Phasic DA:** 3–5 Hz→20–30 Hz, ~200 ms, **asymmetric** (dips floored near 0) and heterogeneous (movement/salience/distributional, not pure scalar RPE). Don't scale negative RPE symmetrically.
- **Reappraisal vs suppression:** reappraisal d≈0.36 (modest) recruiting lateral PFC/dACC/lateral-temporal + amygdala down-modulation; **Buhle 2014 found no vmPFC and argued against it as intermediary** — the vmPFC→amygdala coupling is engineering scaffolding (vmPFC better grounded in extinction). Suppression's sympathetic cost is culture-general; its well-being cost is small and culture-moderated.
- **Candidate genes:** Border 2019 — 18 depression candidate genes ≈ random; 5-HTTLPR×stress failed (Risch 2009, Culverhouse 2018). Anchor to robust biochem (COMT 3–4×, BDNF 18–30%, DRD2 5–15%, 5-HTTLPR-S ~50% transcription), keep behavior tiny, prefer polygenic summation. DRD4-7R/DAT1 ≈ null (flavor only).
- **Attachment base rates:** measure- & population-dependent and drifting (Konrath: secure ~49%→42%). Use ~58–62% secure normative prior w/ wide uncertainty; condition on risk/region.
- **Homeostatic-RL:** corrected to `n>m>1`; m=n=1 is L1/Manhattan, not Euclidean.
- **Extinction:** context-gated inhibitory learning, not delete (Bouton: ABA>ABC>AAB); allow a rare reconsolidation update path.
- **Yerkes–Dodson, somatic markers, facial feedback, "DA=pleasure", "amygdala=fear center", Thanatos, OCC-22-as-natural-kinds, Scherer strict sequence:** retained only as labeled engineering metaphors, sized small, never as validated mechanism.


---

## Appendix A — State variables (synthesized)

| name | symbol | range | unit | baseline | circadian phase | drivers |
|------|--------|-------|------|----------|-----------------|---------|
| Simulated clock | t | [0,∞), use t mod 24 for circadian | hours | 8.0 (shift start) | n/a (the clock itself) | advanced by sim loop = wall-clock × speed; sub-stepped in integrate() |
| Amygdala (threat/salience; Sander relevance detector, NOT fear center) | amygdala | [0,1] | activation (dimensionless) | 0 | none (flat); inherits via cortisol/allostatic drivers | + threat appraisal kick·amygdalaGain, + FEAR, + cortisol(0.25)/allostaticLoad(0.15) sensitization, + fast low-road on negative salience; − vmPFC(0.8)/dlPFC(0.4)/5HT(0.5)/gaba(0.6)/oxytocin(0.4)/eCB(0.3) |
| Hippocampus (memory + HPA negative feedback) | hippocampus | [0,1] | activation | 0 | none | + memory engagement, + rumination operator; − cortisol(0.3); supplies GR negative feedback that shortens cortisol tail |
| vmPFC (reappraisal capacity engaged) | vmPFC | [0,1] | activation | 0 | none | + reappraisal/acceptance operators·controlGain; inhibits amygdala(−0.8) |
| dlPFC (cognitive control) | dlPFC | [0,1] | activation | 0 | none | + copingPotential·controlGain, + distraction; − fatigue(0.5); inhibits amygdala(−0.4); enters dominance readout |
| Nucleus accumbens (reward/approach) | nacc | [0,1] | activation | 0 | none | + reward appraisal kick·rewardSensitivity, + da_meso(0.7); feeds valence(+) and SEEKING(+) |
| Insula (interoceptive intensity) | insula | [0,1] | activation | 0 | none | + fast low-road salience(0.3), + total appraised significance (threat+reward+0.3\|pleasantness\|) |
| Hypothalamus (homeostatic drive / HPA initiation) | hypothalamus | [0,1] | activation | 0 | none | + hunger (ghrelin/leptin imbalance), + threat; initiates CRH→ACTH→cortisol |
| Mesolimbic dopamine (value-coding 'wanting') | da_meso | [0,4] clamp, effective ~[0.5,2] | normalized tone (1=baseline) | 1.0 (init 0.85+0.15·d2Density) | acrophase ~14:00 (amp 0.12) | + asymmetric reward-prediction-error kick·rewardSensitivity; − fatigue(0.2)/melatonin(0.2)/allostaticLoad(0.12); drives nacc/SEEKING; enters valence & dominance |
| Mesocortical dopamine (control/WM, inverted-U) | da_cort | [0,4] clamp | normalized tone | 1.0 | none | gates dlPFC gain via inverted-U; suppressed by acute cortisol; COMT sets effective PFC clearance |
| Serotonin (behavioral inhibition/patience; NOT a happiness dial) | serotonin | [0,4] clamp | normalized tone | 1.0 | acrophase ~13:00 daylight (amp 0.10) | − grief kick, − allostaticLoad(0.15)/ACE set-point shift; inhibits amygdala(0.5); slow tau (~hours) |
| Norepinephrine (LC arousal/gain) | norepinephrine | [0,4] clamp | normalized tone | 1.0 | acrophase ~11:00 (amp 0.18) | + amygdala(0.6)/RAGE(0.3)/threat/novelty/suppression/fast-low-road; − gaba(0.3)/melatonin(0.3); fast tau (minutes); scales LLM decode temperature |
| GABA (inhibitory tone) | gaba | [0,4] clamp | normalized tone | 1.0 | none | + acceptance operator; inhibits amygdala(0.6) and NE(0.3) |
| Glutamate (excitatory tone) | glutamate | [0,4] clamp | normalized tone | 1.0 | none | E/I balance partner to GABA (engineering knob; mostly latent in cashier) |
| Oxytocin (bonding/social-buffer) | oxytocin | [0,4] clamp | normalized tone | 1.0 | none | + warmth kick·oxytocinGain (short tau ~minutes); inhibits amygdala(0.4); drives CARE(0.5) and valence(+); context-gated bias, NOT a trust switch |
| Endogenous opioids ('liking'/social comfort) | opioid | [0,4] clamp | normalized tone | 1.0 | none | + warmth/relief; inhibits PANIC_GRIEF(0.4); hedonic channel separate from da_meso 'wanting' |
| Endocannabinoid (stress buffer) | endocannabinoid | [0,4] clamp | normalized tone | 1.0 | none | tonic anxiolytic restraint; inhibits amygdala(0.3); depleted by chronic stress/allostatic load |
| Cortisol (HPA central stress hormone) | cortisol | [0,4] clamp | normalized tone | mean 1.0, amp 0.55 | acrophase ~08:00 (CAR superimposed), nadir ~00:00 | + amygdala(0.9, ~5min lag)/threat/rumination/suppression; − hippocampal GR feedback (×hpaFeedbackGain); k≈0.6/h (t½≈70min, CORRECTED from 1.5/h); sensitizes amygdala(+0.25) |
| Melatonin (circadian/sleep pressure) | melatonin | [0,4] clamp | normalized tone | mean 0.80, amp 0.70 | acrophase ~03:00, near-zero by day, light-suppressed | SCN-gated; inhibits NE(0.3)/da_meso(0.2); drives drowsiness readout |
| Epinephrine (fast fight/flight) | epinephrine | [0,4] clamp | normalized tone | 1.0 | mild daytime ~11:00 | + fast low-road salience(0.4); very fast tau (~minutes); enters arousal readout |
| Ghrelin (hunger) | ghrelin | [0,4] clamp | normalized tone | 1.0 | meal-entrained (~07/12/19), no single acrophase | rises with time-since-eating; drives hypothalamus/SEEKING and irritability over a long shift |
| Leptin (satiety) | leptin | [0,4] clamp | normalized tone | 1.0 | acrophase overnight ~01:00 | rises after eating; opposes ghrelin-driven SEEKING |
| SEEKING (appetitive approach/exploration; mesolimbic DA) | SEEKING | [0,1] | drive activation | 0 | none | + da_meso(0.5)/nacc(0.3)/reward kick(0.4)/novelty(0.2)/hunger; hypoSEEK + high PANIC = depression motif |
| FEAR (threat-escape; PAG→amygdala) | FEAR | [0,1] | drive activation | 0 | none | + threat kick·amygdalaGain(0.6); feeds amygdala(0.4); − by reappraisal(×0.7)/oxytocin; recovery rate set by recoveryRate (∝ 1−0.28·N) |
| RAGE (anger/affective attack) | RAGE | [0,1] | drive activation | 0 | none | + anger kick (other-blame, goal-incongruent); feeds NE(0.3); − by reappraisal(×0.7); NOTE venting does not reduce RAGE (no catharsis) |
| CARE (nurturance; oxytocin/opioid) | CARE | [0,1] | drive activation | 0 | none | + warmth kick(0.4), + oxytocin(0.5); contributes valence(+) |
| PANIC_GRIEF (separation distress; dPAG→ACC) | PANIC_GRIEF | [0,1] | drive activation | 0 | none | + loss/helplessness kick(0.4); − opioid(0.4)/oxytocin; recovery set by recoveryRate; drives valence(−)/dominance(−) |
| PLAY (rough-and-tumble/social joy) | PLAY | [0,1] | drive activation | 0 | none | + safe positive-novelty reward(0.3); gated OFF by FEAR/RAGE; drives valence(+) |
| LUST (sexual motivation) | LUST | [0,1] | drive activation | 0 | none | dormant in cashier prototype; present for completeness |
| Core-affect valence | valence (V) | [-1,1] | dimensionless (derived readout) | 0 | none (inherits via drivers) | tanh of +da_meso/5HT/oxytocin/opioid/nacc/PLAY/CARE − amygdala/cortisol/FEAR/RAGE/PANIC_GRIEF/fatigue |
| Core-affect arousal | arousal (Ar) | [0,1] | dimensionless (derived readout) | 0.45 | none (inherits via NE/cortisol/melatonin) | sigmoid of +NE/cortisol/amygdala/epinephrine/FEAR/RAGE/SEEKING − melatonin/gaba/fatigue |
| Core-affect dominance/control | dominance (Dom) | [-1,1] | dimensionless (derived readout) | 0 | none | tanh of +da_meso/controlGain·dlPFC/RAGE − FEAR/PANIC_GRIEF/cortisol/amygdala; weakest PAD axis (engineering knob) |
| Allostatic load (McEwen cumulative wear) | allostaticLoad (L) | [0,50] | accumulator units | ~0 (head-start = clamp(amygdalaGain−1,0,3)·0.6) | none (days–weeks timescale) | + ∫ max(0,amygdala−0.3)·max(0,cortisol−1)·0.5 dt; tiny decay ρ; rewrites set-points (↓5HT, ↑amygdalaGain, slower recovery, flatter CAR) |
| Fatigue (regulatory budget; ego-depletion KNOB) | fatigue (F) | [0,1] | dimensionless | 0.2 | none (restored by rest/sleep) | + ~0.04·(0.4+arousal)/h over shift + regulation operators; depletes dlPFC/da_meso; SIZE SMALL — ego depletion failed replication (d≈0.04) |

## Appendix B — Equations (synthesized)

**Master per-channel OU SDE**

```
dX_i = [ k_i·(b_i(t) − X_i) + Σ_j w_{j→i}·g(X_j) ] dt + σ_i·dW_i ;  g(X_j)=(X_j−1) if modulator else X_j
```

Mean-reverting Ornstein–Uhlenbeck drift toward circadian baseline b_i(t), plus signed cross-channel couplings on each source's deviation, plus Wiener noise. Appraisal impulses u_i are applied separately as discrete add()/mul() at event time. Itô interpretation. Implemented in soma.ts::integrate.

**Circadian forcing baseline**

```
b_i(t) = mean_i + amp_i·cos(2π·(t − φ_i)/24)
```

Single-harmonic cosine set-point (documented approximation). cortisol{1.00,0.55,8}, melatonin{0.80,0.70,3}, NE{1.00,0.18,11}, 5HT{1.00,0.10,13}, da_meso{1.00,0.12,14}. Non-circadian channels use defaultBaseline (1 for modulators, 0 for activations).

**Euler–Maruyama step (browser default)**

```
X_i(t+h) = clamp( X_i + [k_i·(b_i−X_i) + Σ_j w·g(X_j)]·h + σ_i·√h·ξ ),  ξ~N(0,1),  h=min(0.02h, remaining)
```

Strong order 1/2. Stable while h<2/k_max; with MAX_SUBSTEP=0.02h supports k up to ~100/h. dt_sim=1 sim-minute sub-stepped per animation frame.

**OU-exact exponential update (recommended, stiff-safe)**

```
m_i = b_i + (Σ_j w·g + u_i)/k_i ;  X_i(t+h) = m_i + (X_i−m_i)·e^{−k_i h} + σ_i·√[(1−e^{−2k_i h})/(2k_i)]·ξ
```

Unconditionally stable for the linear part (couplings frozen across step); lets you take ~1 sim-min steps despite cortisol(hours)/epinephrine(minutes) stiffness. Replaces plain EM for the mean-reversion term.

**OU calibration identities**

```
stationary SD = σ_i/√(2k_i) ;  lag-Δ autocorrelation φ = e^{−k_iΔ} ;  to hit target SD s set σ_i = s·√(2k_i)
```

Kuppens emotional inertia = OU reversion rate; use to set noise honestly to a target affect SD. Caveat (Dejonckheere 2019): inertia/variability add little predictive value beyond mean+variance.

**HPA negative-feedback loop**

```
dCortisol = [ k_C·(b_C(t)−C) + a_amyg·amygdala(t−τ) − γ_GR·hpaFeedbackGain·max(0,C−1)·hippocampus ] dt + σ_C dW ;  k_C = ln2/t½ ≈ 0.6/h (t½≈70min);  τ ≈ 0.08h (~5min)
```

CRH→ACTH→cortisol with delayed amygdala drive (w=+0.9) and GR-mediated hippocampal negative feedback. FKBP5 scales hpaFeedbackGain (lower = longer tail). CORRECTION: current code k=1.5/h gives 28-min t½ — too fast. Optional Walker/Gupta DDE upgrade yields 60–120-min ultradian pulses.

**Cortisol awakening response**

```
on wake at t_wake:  C += A_CAR·C(t_wake),  A_CAR ∈ [0.5,1.0],  decay tuned so peak at t_wake+30–45min;  A_CAR ← A_CAR·(1 − 0.05·allostaticLoad − 0.1·FKBP5_risk)
```

50–100% wake-triggered surge superimposed on the diurnal envelope; flattened by chronic load and FKBP5 risk.

**Core-affect valence readout**

```
V = tanh(0.8·Δda_meso + 0.5·Δ5HT + 0.4·ΔOXT + 0.35·Δopioid + 0.4·nacc + 0.3·PLAY + 0.2·CARE − 0.7·amygdala − 0.5·Δcortisol − 0.45·FEAR − 0.4·RAGE − 0.6·PANIC_GRIEF − 0.3·fatigue)
```

Δx = x−1 for modulators. Liking channel (opioid/oxytocin) kept separate from wanting (da_meso). soma.ts::computeCoreAffect.

**Core-affect arousal readout**

```
Ar = sigmoid(1.2·[0.9·ΔNE + 0.8·Δcortisol + 1.4·amygdala + 0.9·Δepi + 0.7·FEAR + 0.7·RAGE + 0.5·SEEKING − 0.6·Δmelatonin − 0.4·Δgaba − 0.2·fatigue])
```

Saturating sympathetic/vigilance readout; also scales LLM decode temperature (adaptive-gain metaphor).

**Core-affect dominance readout**

```
Dom = tanh(0.6·Δda_meso + 0.5·controlGain·dlPFC + 0.4·RAGE − 0.6·FEAR − 0.5·PANIC_GRIEF − 0.4·Δcortisol − 0.3·amygdala)
```

PAD third axis (Mehrabian-Russell) — weakest empirical grounding, treated as engineering knob.

**Appraisal → threat kick (Lazarus/Scherer)**

```
threat = goalRelevance·max(0,−goalCongruence)·(1−copingPotential);  amygdala += 0.7·threat·amygdalaGain; FEAR += 0.6·threat·amygdalaGain; NE += 0.3·threat; cortisol += 0.3·threat
```

Goal-incongruent + uncoped + relevant ⇒ threat branch. appraisal.ts::applyAppraisal.

**Appraisal → reward kick (asymmetric RPE)**

```
reward = goalRelevance·max(0,goalCongruence)·max(0,pleasantness);  nacc += 0.6·reward·rewardSensitivity; da_meso += 0.4·reward·rewardSensitivity; SEEKING += 0.4·reward; PLAY += 0.3·reward if novelty>0.5 ;  negative RPE: da_meso += −κ⁻·loss with κ⁻≈0.3·κ⁺ (floored)
```

Phasic DA is asymmetric (bursts > dips, floor near 0) and heterogeneous; do NOT scale negative RPE symmetrically (Schultz/Bayer–Glimcher).

**Appraisal → anger / warmth / grief kicks**

```
anger(other,blame<0,gc<0)=|blame|·|gc| → RAGE+=0.6·anger, NE+=0.3·anger ;  warmth(other,norm>0,pleas>0)=norm·pleas → OXT+=0.5·warm·oxytocinGain, CARE+=0.4·warm, opioid+=0.2·warm ;  grief(circ,gc<0,coping<0.4)=|gc|·(1−coping) → PANIC_GRIEF+=0.4·loss, 5HT+=−0.12·loss, da_meso+=−0.12·loss
```

OCC agency-routed compounds (anger=reproach+distress; gratitude/warmth=admiration+joy; grief=uncontrollable loss). Orienting: NE+=0.15·novelty, SEEKING+=0.2·novelty, dlPFC+=0.2·copingPotential·controlGain; insula+=0.4·(threat+reward+0.3|pleas|).

**Reappraisal operator (Gross, antecedent)**

```
vmPFC += 0.4·controlGain; amygdala *= (1 − 0.35·clamp(controlGain,0.4,1.8)/1.8); FEAR *= 0.7; RAGE *= 0.7; cortisol += −0.1; fatigue += 0.02
```

Durable, low-cost down-modulation; cap efficacy modest (meta-analytic d≈0.36). Empirically lateral-PFC/dACC/lateral-temporal mediated; vmPFC→amygdala edge is engineering scaffolding (better grounded in extinction).

**Suppression operator (Gross, response-focused)**

```
NE += 0.1; cortisol += 0.05; fatigue += 0.05; (felt valence/arousal unchanged; recent-memory blur)
```

Sympathetic + working-memory cost with no reduction in felt state (Gross & Levenson; Richards & Gross). Physiological cost culture-general; well-being cost small/culture-moderated.

**Allostatic load integrator**

```
dL = max(0,amygdala−0.3)·max(0,cortisol−1)·0.5·dt − ρ·L,  ρ≈0.0015/h ;  then set-point drift: 5HT_mean −= η·L, amygdalaGain += η·L, recoveryRate -= η·L
```

McEwen wear-and-tear; the exposome's slow memory. η tiny (days–weeks). Drives stress-induced trait drift and resilience-on-recovery.

**Time-integral exposome metrics**

```
min = dt·60; minutesAnxious += min·[Ar>0.55 ∧ V<−0.12 ∧ Dom<0.1]; minutesDepressed += min·[Ar<0.45 ∧ V<−0.18 ∧ da_meso<0.9]; minutesContent += min·[V>0.15 ∧ Ar<0.6]; minutesAngry += min·[V<−0.05 ∧ Ar>0.5 ∧ (RAGE>0.25 ∨ Dom>0.25)]; minutesJoyful += min·[V>0.3 ∧ Ar>0.5]; cumulativeStress += min·max(0,cortisol−1); cumulativeReward += min·max(0,da_meso−1)
```

Riemann-sum threshold-crossing integrals — the live-plotted exposome curves. Thresholds are tunable EA knobs. emotion.ts::updateIntegrals.

**Rescorla–Wagner conditioning (optional sub-symbolic core)**

```
ΔV_c = α_c·β·(λ − Σ_{c'∈present} V_{c'}) ;  λ=+1 appetitive / −1 aversive / 0 extinction(β2) ;  conditioned affect: valence-drift += k_cs·Σ_c V_c·1[present]
```

Compound prediction error gives blocking/overshadowing. Extinction = new context-gated INHIBITORY weight (Bouton), never delete; renewal ABA>ABC>AAB; allow rare reconsolidation update path.

**Homeostatic-RL hunger drive (corrected exponents)**

```
D(H) = (Σ_i |H*_i − h_i|^n)^{m/n} with n > m > 1 (e.g. n=4, m=2);  r = D(H_t) − D(H_{t+1}) ;  hunger h from ghrelin/leptin → SEEKING/irritability
```

CORRECTED: constraint is n>m>1 (not m≥n≥1); m=n=1 is L1/Manhattan, not Euclidean (Keramati–Gutkin). Reward = drive reduction.

**Yerkes–Dodson service-quality readout (engineering metaphor only)**

```
P(Ar) = exp(−(Ar − A_opt)²/(2w²)),  A_opt ≈ 0.6 (simple order) … 0.35 (complex order), w≈0.2 ;  mistake_prob = 1 − P(Ar)
```

Inverted-U order-accuracy heuristic. FLAG: Yerkes–Dodson is weak/overstated (really Hebb's curve); use as tunable readout, not a law.


## Appendix C — Parameter mappings (synthesized)

| source | target | effect |
|--------|--------|--------|
| COMT_Met (rs4680 Met count, 0\|1\|2) | daClearancePFC = clamp(1 − 0.12·Met, 0.7, 1.05) | Met lowers prefrontal DA clearance ('worrier'), inverted-U on dlPFC. Biochem ROBUST (3–4× enzyme activity); behavioral effect small — keep d2-cort effect modest. |
| DRD2_Taq1A (rs1800497/ANKK1 A1 count) | d2Density = clamp(1 − 0.16·A1, 0.5, 1.2); da_meso init = 0.85+0.15·d2Density | A1 ↓ striatal D2 binding ~5–15% → blunted reward/RPE gain, anhedonia tendency. MODERATE (heterogeneous meta). |
| BDNF_Met (rs6265 Met count) | learning-rate η ×0.75/allele; recoveryRate slightly ↓; plasticity reserve ↓ | Activity-dependent BDNF secretion ↓18–30% → slower acquisition AND extinction of threat, slower mood recovery. Molecular ROBUST; behavioral weaker. |
| FKBP5_risk (rs1360780 T count) | hpaFeedbackGain = clamp(1 − 0.14·risk − 0.04·ACE − 0.05·[disorganized] + 0.03·C, 0.35, 1.4) | Risk allele impairs GR feedback → longer cortisol tail; childhood-trauma epigenetic latch (×0.75 + baseline drive +15%). MODERATE GxE, better-supported than most. |
| HTTLPR_S (5-HTTLPR short count) | amygdalaGain += 0.10·S; serotonin reuptake k_sert ×(1−0.25·S) | S ↓SERT transcription ~50% (biochem robust) but amygdala-reactivity is <1% behavioral variance and 5-HTTLPR×stress FAILED replication (Risch 2009, Border 2019) — keep as a TINY knob. |
| DRD4_7R (48bp VNTR 7-repeat count) | rewardSensitivity += 0.08·7R; exploration temperature += small | Novelty-seeking association is NULL in meta-analysis (Munafò 2008) — FLAVOR ONLY; turning it off should change little. |
| DAT1_VNTR (SLC6A3 9R/10R) | striatal reuptake k_reuptake ±~10% | SPECT meta-analysis non-significant (p≈0.22) — LOW-CONFIDENCE, near-zero default knob. |
| OXTR_A (rs53576 A count) | oxytocinGain += −0.10·A | A ↓ social-reward/buffering. Small & inconsistent (mixed meta) — keep deltas modest; NOT a trust switch (Kosfeld failed replication). |
| MAOA_low (uVNTR low-activity) | monoamine clearance k_mao ×0.7; reactive-aggression gain ×1.3 IF MAOA_low ∧ maltreatment ∧ male | Slower monoamine degradation; MAOA-L×maltreatment→aggression replicates mainly in MALES (Caspi 2002; Byrd & Manuck 2014). MODERATE, sex-conditional. |
| CYP2D6 metabolizer phenotype | drug-clearance k_drug ×{poor 0.2, intermediate 0.5, extensive 1.0, ultrarapid 2.5} | PK layer upstream of any medication's effect on the soma; off-path unless a drug event occurs. Frequencies ~PM 5.7/IM 10.7/NM 81.4/UM 2.2%. |
| Big Five Neuroticism (z) | amygdalaGain += 0.30·N; recoveryRate = clamp(1 − 0.28·N + 0.10·C, 0.35, 1.6); serotonin decay ×(1−0.1·N); valence set-point −0.25·N | Threat-circuit gain + emotional inertia + lower mood set-point. CB5T threat/serotonin mapping; trait↔physiology r small (~.1–.2) — engineering prior. |
| Big Five Extraversion (z) | rewardSensitivity += 0.22·E; da_meso baseline ↑; valence set-point +0.30·E | Value-coding DA / approach. DeYoung-2010 medial-OFC reward mapping. Modest effect size. |
| Big Five Conscientiousness (z) | controlGain = clamp(1 + 0.28·C + 0.05·COMT_Met − 0.08·ACE + 0.05·ses, 0.4, 1.8); planning depth ↑ | Lateral-PFC control — the ONE Big Five mapping confirmed by DeYoung-2010 brain-structure data. Sets reappraisal efficacy and action-gating threshold. |
| Big Five Agreeableness (z) | oxytocinGain = clamp(1 + 0.22·A − 0.10·OXTR_A + ATTACH_OXT[attachment], 0.4, 1.8); emotional-contagion coupling ↑ | Social-cognition/affiliation. Drives CARE/oxytocin warmth response and trust prior. |
| Big Five Openness (z) | LLM decode temperature ↑; associative-retrieval breadth ↑ (reduced latent inhibition) | Salience-coding DA / cognitive exploration. WEAKEST mapping — Openness was NOT confirmed in DeYoung-2010 structural data; keep small. |
| Big Five metatraits (sampling) | draw traits from MVN(BFI-2 means/SDs, intercorrelation Σ: E–N −.34, C–N −.30, A–N −.29, A–C +.28, E–O +.20) ⇒ Plasticity(E+O)→DA_global, Stability(−N+C+A)→5HT_tone | Reproduces real trait covariance and the two-metatrait neuro-mapping. UPGRADE: current sampler draws independent N(0,1). |
| Attachment style | amygdalaGain += ATTACH_THREAT{secure −0.10, avoidant +0.10, anxious +0.28, disorganized +0.42}; oxytocinGain += ATTACH_OXT{+0.20,−0.25,+0.05,−0.15}; disorganized = simultaneous high FEAR + high PANIC (approach/flee conflict) | Prior vector on social-threat & oxytocin reactivity (Bowlby/Ainsworth). Base rates ~58/20/15/7 (adult, dated/measure-dependent) — use wide uncertainty; infant low-risk 62/15/9/15; at-risk 51.6/14.7/10.2/23.5. |
| ACE score (0–10) | amygdalaGain += 0.05·ACE; hpaFeedbackGain −= 0.04·ACE; rewardSensitivity −= 0.06·ACE; controlGain −= 0.08·ACE; cortisol set-point += 0.04·ACE; serotonin set-point −= 0.03·ACE | Dose-response: ↑amygdala reactivity, ↓striatal reward (anhedonia), blunted HPA feedback. HETEROGENEOUS direction (acute hyper vs chronic hypo-cortisol) — sign by chronicity; add a resilience-buffer param that damps these. |
| Socioeconomic status (z; low = chronic stress) | amygdalaGain −= 0.06·ses; controlGain += 0.05·ses; cortisol set-point −= 0.03·ses; allostaticLoad head-start ↑ when ses low | McEwen allostatic-load mechanism: low SES → higher chronic-stressor load and baseline wear. Real but heterogeneous; treat as stylized generator. |
| Profile composite → decay individualization | decay[amygdala,FEAR,RAGE,PANIC_GRIEF] = base × recoveryRate; decay.cortisol = base × hpaFeedbackGain (set base 0.6/h, CORRECTED); decay.serotonin = base × (1−0.1·N) | Neuroticism slows affective recovery (inertia); FKBP5 lengthens cortisol tail. Keep coupling SIGNS fixed; let EA mutate magnitudes within honest bounds. |

## Appendix D — Open questions

- Integrator choice: ship the existing plain Euler–Maruyama (h<0.02h sub-stepping) or migrate to the exact-OU exponential update for unconditional stability with ~1 sim-min steps? The stiffness (cortisol ~0.6/h vs epinephrine ~10–25/h) argues for exact-OU, but it freezes couplings across the step.
- Cortisol time constant: current decay (1.5/h ⇒ 28-min half-life) contradicts the ~66–70-min literature half-life (k≈0.6/h). Recalibrate to 0.6/h, and decide whether to add the explicit ~5-min secretion lag and the Walker/Gupta DDE for genuine ultradian pulses, or keep the cheap circadian-cosine approximation.
- Fatigue/ego-depletion sizing: ego depletion failed multi-lab replication (d≈0.04). What near-zero-to-small magnitude for the fatigue→dlPFC/da_meso coupling preserves a believable end-of-shift decline without asserting a discredited mechanism? Should it be reframed as opportunity-cost rather than resource depletion?
- Attachment base rates: the 58/20/15/7 sampler is an adult self-report prior that is dated (secure declining ~49%→42%, Konrath 2014) and measure-dependent. Should the simulator expose a population-risk switch (low-risk infant 62/15/9/15 vs at-risk 51.6/14.7/10.2/23.5) and re-express attachment on continuous anxiety/avoidance dimensions instead of categories?
- Big Five sampler: upgrade from independent N(0,1) to MVN with BFI-2 intercorrelations + metatraits? This changes the joint distribution of characters the tournament/EA explores.
- Calibration target: there is no ground-truth human trace. Against what should the EA fitness be anchored beyond human ratings — e.g. EMA affect-dynamics datasets for inertia/variability, knowing (Dejonckheere 2019) those indices add little beyond mean+variance?
- Substrate–prose divergence: how large a gap between the physiologically-grounded readEmotion label and the LLM's narrated emotion is acceptable before it counts as incoherence vs. a realistic 'persona/suppression' tell? Needs an operational threshold for the auto-metric.
- Qwen-0.6B appraisal faithfulness: tiny models often confabulate appraisal fields. Do we add a symbolic OCC/Scherer cross-check that overrides obviously inconsistent LLM appraisals (e.g. goalCongruence>0 with a 'rude' event), or trust the model and let the soma fallback absorb errors?
- Memory retrieval is currently keyword-overlap; should it move to embedding cosine + mood-congruency bias (with a positive-memory floor to prevent rumination doom-loops), and does mood-congruent retrieval risk pathological attractors the EA could accidentally select for?
- Negative-RPE asymmetry and DA heterogeneity: implement the asymmetric/floored phasic-DA kick and optionally distributional RPE, or keep the simpler symmetric reward/loss kick already in applyAppraisal?
- Survey engine validity: should numeric survey answers (PANAS/STAI) be treated as ground truth and the LLM-narrated answers scored against them, or are both readouts and the disagreement is the signal of interest?
- Resilience/protective factors: ACE is a blunt cumulative count ignoring timing/severity/buffering. Add an explicit resilience parameter (e.g. one stable caregiver) that damps the ACE→amygdala/cortisol shifts, and how should it interact with the FKBP5 trauma latch?

## Appendix E — Adversarial fact-check verdicts

These flagged where the literature is weaker than the framing suggests — effect sizes here are knobs, not truth.

| verdict | conf | claim → corrected |
|---------|------|-------------------|
| partially-supported | high | Global Strange Situation distribution (recent large meta-analysis, ~20,000+ procedures): ~51.6% secure, ~14.7% avoidant, ~10.2% resistant, ~23.5% disorganized;  → The four percentages (51.6% secure, 14.7% avoidant, 10.2% resistant, 23.5% disorganized; N=20,720 dyads / 285 studies) are quoted exactly correctly from Madigan et al. (2023, Psychological Bulletin), and the 'no mother-v |
| partially-supported | high | van IJzendoorn & Kroonenberg (1988) meta-analysis: 32 samples, 8 countries, N≈1990; ~65% secure / ~21% avoidant / ~14% resistant (no disorganized coding); intra → Every descriptive fact in the claim is accurate against the primary source: the paper reports exactly "32 samples from eight countries... representing 1,990 Strange Situation classifications," coded only A/B/C (disorgani |
| partially-supported | high | Adult attachment, nationally representative US sample (Mickelson, Kessler & Shaver 1997): ~59% secure, ~25% avoidant, ~11% anxious. Default base-rate prior for  → The cited numbers are accurate: Mickelson, Kessler & Shaver (1997, JPSP 73(5):1092-1106), using the National Comorbidity Survey (N ~= 8,080) and Hazan & Shaver's single-item, three-category forced-choice self-report, rep |
| supported | high | Ego depletion: Hagger et al. (2010) meta-analysis reported d≈0.62 over ~198 tests, but the 2016 multi-lab Registered Replication Report (23 labs, N≈2141, prereg → Every quantitative figure in the claim is exact. Hagger et al. (2010, Psychological Bulletin) reported d = 0.62 across 198 independent tests (~100 articles, ~10,000 participants). The Hagger & Chatzisarantis (2016) Regis |
| partially-supported | high | Freud's death drive (Thanatos) lacks empirical support and is widely judged non-falsifiable; retained here only as a tunable risk-seeking/self-handicapping para → Freud's death drive (the term "Thanatos" was coined by Stekel/Federn, not Freud) lacks direct empirical support and was abandoned by most psychoanalysts and rejected by mainstream empirical psychology — that part is accu |
| supported | high | Midbrain dopamine neurons fire at a tonic baseline of ~3-5 Hz, burst to ~20-30 Hz for better-than-expected reward (burst ~200 ms), and dip below baseline when a → The numbers are accurate and quote canonical literature (Schultz; Glimcher 2011 PNAS states verbatim a "3- to 5-Hz baseline" rising to "20 or 30 Hz" for unexpected reward; phasic responses last ~100-200 ms / ~3-5 spikes  |
| supported | high | Rescorla-Wagner update is ΔV = α·β·(λ − ΣV), where the change in associative strength is proportional to the compound prediction error (λ − ΣV); α = cue salienc → The equation and parameter labels are correct as the standard Rescorla & Wagner (1972) trial-level update: ΔV_i = α_i·β·(λ − ΣV), where ΔV_i is the change in associative strength for cue i on a trial; α_i (0-1) is the sa |
| partially-supported | high | Homeostatic-RL reward is r_t = D(H_t) − D(H_{t+1}) with drive D(H) = (Σ_i \|H*_i − h_i\|^n)^{m/n}, m ≥ n ≥ 1 (Euclidean when m=n=1); verify the exponent constrain → Two of the four sub-claims are exactly correct against the primary source (Keramati & Gutkin 2014, eLife 3:e04811); two are wrong. CORRECT: (a) the drive function D(H_t) = (Σ_{i=1}^N \|H*_i − h_{i,t}\|^n)^{m/n} is verbatim |
| partially-supported | high | Bouton's extinction findings: extinction is new context-dependent inhibitory learning, not erasure; hence renewal (ABA > ABC > AAB), spontaneous recovery, and r → Extinction is predominantly new, context-dependent INHIBITORY learning that leaves the original CS-US/excitatory association largely intact — which is exactly why relapse occurs: renewal, spontaneous recovery, and reinst |
| partially-supported | high | Cortisol peaks ~20-30 min after acute stressor onset (reported windows 21-40 min), recovers to baseline over ~60-90 min, with clearance half-life ~60-70 min; AC → The timing parameters are well-grounded as central estimates, but two are stated more narrowly/optimistically than the literature supports. SUPPORTED: Peak cortisol occurs ~21-40 min after stressor onset (the exact windo |
| partially-supported | high | Phasic dopamine bursts last ~100-500 ms (typically ~200 ms) and encode reward-prediction error; tonic dopamine tracks ongoing value over minutes. This justifies → Phasic dopamine bursts are short (latency ~70-100 ms, duration on the order of ~100-500 ms, with a value-coding component peaking ~150-250 ms), and across many studies their net response is well-described by a reward-pre |
| partially-supported | high | Cognitive reappraisal recruits dlPFC, vlPFC, dACC, SMA and parietal cortex and down-modulates bilateral amygdala activity (Buhle et al. 2014 meta-analysis, 48 f → Buhle et al. (2014, Cerebral Cortex; 116 contrasts from 48 studies) found that cognitive reappraisal reliably recruits bilateral dlPFC, vlPFC, posterior dmPFC (encompassing pre-SMA/dACC), posterior parietal cortex, AND l |
| partially-supported | high | Expressive suppression increases sympathetic activation and impairs memory for concurrently presented information, whereas reappraisal does not; reappraisal cor → Each component is empirically supported, but the single citation is misattributed and the well-being/interpersonal generalization is culturally bounded. (1) Inhibiting emotion-expressive behavior (expressive suppression) |
| supported | high | The OCC model specifies 22 emotion types via valenced reactions along three branches (events->desirability, agents->praiseworthiness, objects->appealingness), w → The original OCC model (Ortony, Clore & Collins, 1988, "The Cognitive Structure of Emotions") does specify 22 emotion TYPES organized along three branches whose central appraisal variables are exactly as stated: events e |
| supported | high | Scherer's CPM organizes appraisal into four objectives (relevance, implication, coping potential, normative significance) decomposed into sequential Stimulus Ev → As a description of Scherer's Component Process Model (CPM), the claim is accurate: the four appraisal objectives are exactly relevance, implication(s), coping potential, and normative significance (Scherer 2001, 2009),  |
| supported | high | Lazarus's transactional model distinguishes primary appraisal (irrelevant/benign-positive/stressful, sub-typed harm-loss vs threat vs challenge) from secondary  → Lazarus & Folkman's (1984) transactional model is accurately described: primary appraisal classifies an encounter as irrelevant, benign-positive, or stressful, and the stressful category is sub-typed into harm/loss (dama |
| supported | high | Specific numeric coupling gains, OU time constants (e.g. tau_NE~60-120 s, theta_5HT~hours), kick magnitudes, and the reappraisal gain r in [0,0.7] are ENGINEERI → These are tunable model parameters, not directly measured biological constants, and must be calibrated to data — this is the correct and scientifically honest position. The one nuance: the dichotomy is slightly too clean |
| partially-supported | high | Cortisol has a circulating half-life of ~60-70 min, peaks ~25-30 min after acute stressor onset with a 3-5 min secretion lag, and returns to baseline within 60- → Each individual number is within the published range and the parameterization is internally consistent, but several values are stated more precisely than the literature warrants. (1) Circulating half-life: ~66 min is the |