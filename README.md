# ExposomeSim

A neurosymbolic simulator of the **exposome** — the cumulative psychological toll of
lived experience. An LLM drives a human character whose *persistent self* is not in the
prompt but in a **dynamical limbic/endocrine substrate**: coupled stochastic differential
equations for neuromodulators and hormones, with circadian rhythm, an HPA stress axis, and
a slow **allostatic-load** integrator that is the exposome's memory.

> Field study I: **a life in the city** — Mara Voss, a fast-food cashier, *inhabits and
> traverses* a low-poly black-mesh town (apartments · the fast-food counter · a supermarket ·
> a café · a public park), seen from a virtual camera that **orbits her** (drag to rotate,
> wheel to zoom). Her day is not scripted: it emerges from Maslow needs read off the soma —
> down to **hypothalamic detectors for hunger and thirst** — arbitrated against place
> affordances. A live neuropsychological instrument panel reads out core affect,
> neurochemistry, the **anatomical brain lighting up in real time**, a **psyche-vector
> signature**, and the **symbolic memory graph** as it forms.

---

## The idea in one diagram

```
 event ─▶ fast appraisal (low road) ─▶┐
 (world)                              │   ┌─────────────────────────────┐
                                      ├──▶│  SOMA  (the persistent self) │  ← integrated every tick
 LLM driver (high road) ◀── render ───┘   │  SDEs: DA·5HT·NE·cortisol…   │     (circadian, HPA,
   │  reads felt body state               │  + limbic nodes + allostasis │      couplings, OU noise)
   │  returns appraisal + regulation       └─────────────┬───────────────┘
   │  + speech + action                                  │ core affect (V,A,D)
   └────────── feeds back into the soma ◀─────────────────┘ → constructed emotion + metrics
```

- **The LLM is stateless cognition; the soma is the persistent self.** This kills personality
  drift — who the character *is* lives in numbers (genotype × Big Five × experiosome → params),
  not in the context window.
- **Constructed-emotion seam (Barrett):** the soma yields continuous *core affect*
  (valence/arousal/dominance); the LLM *constructs* the discrete emotion from it + context.
- **The body biases the model.** The soma is rendered into felt language ("everything feels
  flat; it is hard to care") and injected into the prompt, so physiology shapes behavior.

## Architecture (`src/`)

| area | files | role |
|------|-------|------|
| contract | `core/types.ts` | shared domain types — the single source of truth |
| mind | `mind/params.ts` | genotype × CB5T Big Five × experiosome → soma physics; population sampling |
| | `mind/soma.ts` | Euler–Maruyama integrator, circadian forcing, couplings, core-affect readout |
| | `mind/appraisal.ts` | OCC/Scherer appraisal → soma kicks; Gross regulation strategies |
| | `mind/emotion.ts` | constructed-emotion readout + **exposome integrals** |
| | `mind/physiology.ts` | **causal homeostatic reservoirs** (satiety/hydration/bladder/bowel/hygiene) |
| | `mind/needs.ts` | Maslow needs read off the soma + physiology (hunger, thirst, elimination, hygiene, …) |
| | `mind/memgraph.ts` | **symbolic memory GRAPH** — ACT-R + Generative-Agents (see `MEMORY_DESIGN.md`) |
| | `mind/mindlite.ts` | **abstracted interlocutor psyche** (lower causal resolution) |
| | `mind/character.ts` | the unit: full soma + memory graph an LLM drives |
| llm | `llm/client.ts` | swappable backend (Ollama now → remote API later) |
| | `llm/prompt.ts` | interoception rendering, role-play contract, tolerant JSON parsing |
| world | `world/town.ts`, `world/arbiter.ts`, `world/places.ts` | the level-of-detail town; needs-arbitrated agency |
| econ | `econ/econsim.ts` + module | the emergent market economy: firms/supply chains/premises, banking + Fed, shadow population (`ECONOMY_EMERGENCE.md`, `WORLD_EXPANSION.md`) |
| causal | `causal/index.ts` | the **causal radius**: full event-resolution near main characters; everywhere else drifts on a **learned average-causality surrogate** |
| gov | `gov/index.ts` + module | **emergent government**: seeded civic memories → opinion contagion → assemblies → ballots → treasury/levies/offices — a phase transition, never a script (`POLIS_DESIGN.md`) |
| transport | `transport/index.ts` + module | **the price of distance**: street graph, mode choice, congestion, taxis/transit/dealers, signals + social-force pedestrians — hot when observed, bookkeeping when not (`TRANSPORT_DESIGN.md`) |
| render | `render/citystage.ts` | three.js — the **orbit-camera 3D city** + LOD |
| | `render/worldgeo.ts` · `render/humanoid.ts` | low-poly black-mesh buildings & **articulated humanoids** |
| | `render/brain.ts` | MRI brain instrument with **live activation glow** |
| | `render/psycheviz.ts` · `render/memoryviz.ts` | psyche-vector signature · memory-graph view |
| ui | `ui/dashboard.ts` · `ui/townpanel.ts` | canvas instrument panels |

## Running it locally

> **For a coding agent setting this up:** the steps below are a deterministic runbook.
> Run them in order; each has a verification command whose expected output is shown. The
> character is driven by a **local** LLM — **`qwen3:1.7b` in _thinking_ mode** — served by
> [Ollama](https://ollama.com). Nothing is sent to the cloud; no API key is needed.

### Prerequisites

| need | version | notes |
|------|---------|-------|
| Node.js | ≥ 18 | Vite 6 requires it. `node -v` |
| Ollama | latest | the local model server (installed below) |
| disk | ~2 GB free | the model is ~1.4 GB |
| RAM / VRAM | ~3 GB free | the model loads to ~2 GB; runs on Apple-Silicon GPU, CUDA, or CPU |

### 1 — Install Ollama

```bash
# macOS
brew install ollama            # or download the app from https://ollama.com/download
# Linux
curl -fsSL https://ollama.com/install.sh | sh
# Windows: download the installer from https://ollama.com/download
```

### 2 — Start Ollama and pull the thinking model

```bash
ollama serve &                 # start the daemon (skip if the macOS/Windows app is already running)
ollama pull qwen3:1.7b         # ~1.4 GB; the 1.7B Qwen3 reasoning model this sim is tuned for
```

**Verify it downloaded:**

```bash
ollama list                    # expect a row:  qwen3:1.7b   ...   1.4 GB
```

### 3 — Warm the model and confirm it's served & active

Load the model into memory and confirm **thinking mode** works end-to-end (it should print a
short reasoning trace **and** a JSON answer):

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:1.7b", "stream": false, "think": true, "format": "json",
  "keep_alive": "30m",
  "messages": [{ "role": "user", "content": "Reply with ONLY {\"ok\":true} as JSON." }]
}'
# expect JSON like: {"message":{"thinking":"...","content":"{\"ok\": true}"}, ...}

ollama ps                      # expect qwen3:1.7b listed as loaded (100% GPU or CPU), "UNTIL" in the future
```

If `thinking` is non-empty and `content` is valid JSON, the model is **served and active**.

### 4 — Run the app

```bash
npm install
npm run dev                    # → http://localhost:5173   (Vite proxies /ollama → :11434)
```

Open **http://localhost:5173**. Within ~30 s Mara starts her morning (bathes, eats), commutes
to the counter, and begins serving customers — her spoken lines and inner appraisals in the
caption are generated by `qwen3:1.7b` each beat. **Keep the tab focused:** browsers throttle
background tabs, which nearly freezes the sim.

### How the thinking model is wired (don't "fix" this)

- The driver requests **`think: true`** and passes a **JSON Schema** (`format`) for structured
  output (`src/llm/client.ts`, `src/llm/prompt.ts`). The model reasons freely in its separate
  `thinking` channel while the schema keeps the **answer** on the appraisal contract.
- **Qwen3 gotcha (already handled):** with thinking on but no budget, Qwen3 spends its whole
  token budget reasoning and returns **empty content**. `client.ts` gives the thinking driver a
  larger `num_predict` (1024) so it has room to answer. Leave that in place.
- The world clock is deliberately paced (`speed` in `src/main.ts`) so a ~10 s thought doesn't
  skip much in-world time. Use **`+` / `−`** in the app to taste; `+` speeds it up.

**Controls**
- **Drag** the 3D view to orbit the camera around Mara · **wheel** to zoom.
- **space** pause · **+ / −** sim speed.
- Titlebar toggles: **BRAIN** (anatomical brain) · **CITY** (2D density map, `c`) · **PSYCHE**
  (live psyche-vector signature) · **MEMORY** (symbolic memory graph) · **ECON** (`e`, the
  **Economy Observatory** — the whole macro history t0→now: output/prices/rates/money/labour/
  firm demography/wealth/housing strips, the Phillips phase trail, the event lane, and the
  live now-board; see `ECONOMY_EMERGENCE.md`).
- In the brain panel: **LIVE** toggles activation-glow vs. static inspect · **↑/↓** step the
  soma vector to light the responsible structure(s).

### Troubleshooting

| symptom | cause / fix |
|---------|-------------|
| caption says "Ollama not reachable" | daemon isn't running → `ollama serve`; the sim still runs on a **soma-derived fallback driver** (no LLM), so this is non-fatal |
| Mara looks frozen / does nothing | the browser tab is **backgrounded** (rAF throttled) — focus it; or press **`+`** to speed the clock |
| first customer interaction stalls a few seconds | the model was cold — it's loading; the `keep_alive` warm-up in step 3 avoids this |
| `npm run dev` prints "Port 5173 is in use" | another instance is running; use the URL Vite prints (e.g. `:5174`) or stop the other one |
| want a different / smaller model | pass it in `src/main.ts` (`new OllamaClient({ model, think })`); the tiny `qwen3:0.6b` works with `think:false` but is far less articulate |

If Ollama is unreachable the sim falls back to an event-grounded soma driver so it still runs
(no LLM in the loop); memory consolidation/reflection then use templates instead of the model.

Headless check of the dynamics (no browser, no LLM):

```bash
npx tsx scripts/harness-smoke.ts
```

### The causal-structure diagram

`causal-dag/index.html` is a **standalone** interactive map of the whole architecture (event →
physiology → soma → LLM → back). It needs no build or server — open it directly:

```bash
open causal-dag/index.html            # macOS  (Linux: xdg-open, Windows: start)
```

## Why this design (the science)

Effect sizes are deliberately modest and **interpretable**, not deterministic — candidate-gene
associations are small and partly non-replicating (esp. 5-HTTLPR×stress). We use them as
readable knobs: `DRD2 Taq1A → striatal D2 density → reward gain`, `COMT → prefrontal DA
clearance`, `FKBP5 → HPA negative-feedback efficiency`, `Big Five → neuromodulator systems`
(DeYoung's Cybernetic Big Five Theory). See `HARNESS_DESIGN.md` (generated from a multi-framework
literature pass) for the full grounding.

## The larger program

This prototype is one cell of a planned **tournament**: many (harness × model) pairs drive
characters through the same scenarios; humans grade recordings on believability / consistency /
social competence; the best pairs are kept and **mutated by an evolutionary algorithm** to
search for the ideal neurosymbolic harness and the cheapest model with enough emotional and
situational intelligence to drive a human-psychology / exposome simulation. Later: connect this
top abstraction layer down to organ/tissue and receptor/PPI layers via the shared
hormone/neurotransmitter interface.

## The town — a life by need (level-of-detail cognition)

ExposomeSim scales from one room to a compressed modern-western life by spending its
one expensive resource — a full ~33-channel soma — only where **attention** is:

- **Tier 0 — Mara** runs the full psychological simulator every tick.
- **Tier 2 — a partner** is promoted to a full soma *only while she's interacting with
  them*, then distilled to a one-line **ledger** summary and demoted (`src/world/town.ts`).
- **Tier 1 — proximate NPCs** are cheap symbolic minds (path + goal token, no soma).
- **Tier 3 — the city** is a pure population-density field — thousands implied, zero
  instantiated (`src/world/city.ts`).

Her day is **not scripted**. A Maslow **needs** layer is read off the soma
(`src/mind/needs.ts`: hunger←ghrelin, energy←fatigue, belonging←a slow social
reservoir + PANIC/GRIEF, safety←cortisol/amygdala, …) and an **arbiter**
(`src/world/arbiter.ts`) scores those deficits against place **affordances**
(`src/world/places.ts` — home · work · market · café · park) bound by money / food /
energy / time (`src/econ/economy.ts`). The work→eat→home→shop→café loop is the *limit
cycle* of those drives, not a calendar. **Relationships emerge** unscripted from
reciprocated, oxytocin-rewarding encounters (`src/world/relationship.ts`) — over a week
Mara forms a warm friendship with one café regular while another stays strained, with
no `befriend` verb anywhere.

Verify the emergence headless (no browser, no LLM):

```bash
npx tsx scripts/town-smoke.ts   # prints the emergent day + the relationship ledger
```

Press **C** (or the CITY button) to zoom out to the 2D town map — places, streets, the
breathing density field, and Mara's marker tracing her path, with the relationship
constellation condensing at the café. The dashboard's **a life by need** panel shows
where she is, *why* (the arbiter's reason), her need deficits, money/food, and the
ledger. It runs without Ollama (soma-derived fallback); start Ollama to put the LLM
back in Mara's loop.

## The 3D city — inhabit and traverse (`render/citystage.ts`)

The primary view is the **whole town in low-poly black mesh on sepia**, built once and shared
(`render/worldgeo.ts`) — an apartment tower (home), the fast-food restaurant (work), a big-box
supermarket with **fridges and food-counter boxes** (market), a pitched-roof café (thirdplace),
and a park with trees, a pond and benches — joined by lamplit streets and filler blocks. A
**virtual camera orbits Mara** (drag to rotate, wheel to zoom) and **follows her everywhere** —
including *up to her top-floor apartment* — so she is always in view. Mara is a **red-headed**
articulated low-poly humanoid (`render/humanoid.ts`) whose posture/tint/tremor **embody the soma**;
a **speech bubble** shows her verbal thoughts above her head.

Interiors are a **dollhouse**: the building she is inside opens up so the orbiting camera looks
straight in. To stay cool on an M1 Air, only the current interior is drawn, filler culls with
distance, the far city dissolves into fog, and everything shares a handful of materials.

**Her home is a real apartment complex** (`render/apartment.ts`), modelled at human scale then
drawn at **1/8** — so when Mara steps through the entrance she **shrinks to an eighth** and the
whole building (lobby → half-turn **dogleg stairs** → 2nd-floor hallway → her studio) fits the
tower without being enormous. On arriving home she plays the full **sequence**: the entrance door
swings open, she walks in and shrinks, the door closes, she **climbs the switchback stairs**, walks
the hallway, opens her **room door**, and settles. The building is drawn as a wireframe **section**
(walls as edges) so you see every floor at once; the camera auto-zooms with her body-size.

Her **studio** follows a real floor plan — a kitchen zone, a bathroom nook, a sleeping area and a
living/dining area — and she walks to the right fixture for each act (the stove to cook, the tub to
bathe, the toilet to relieve). The low-poly **appliances and furniture** (a kitchen with sink,
oven, hood, cabinets and fridge; a glass shower stall, toilet and vanity; bed, sofa, dining set,
plant) were authored by a fleet of **parallel modelling agents** against a shared geometry kit
(`render/kit.ts`), with hand-built fallbacks.

## The body — a causal homeostatic layer (`mind/physiology.ts`)

Beneath the neural soma sits a low-abstraction **reservoir layer** — the plumbing that *causes*
felt need. Five reservoirs drain and fill by real-ish flux and drive the soma's interoceptive
signals, so behaviour **emerges** with nothing scripted:

- **satiety** (gut energy): basal+activity metabolism empties it; eating refills it → sets
  ghrelin/leptin → hunger.
- **hydration** (body water): insensible loss + sweat drain it; drinking refills it → writes the
  **thirst osmostat** → she'll *drink mid-shift when parched, overriding work*.
- **bladder / bowel**: fill from fluid throughput and food mass; a steep near-full **urgency**
  makes her *slip away to a toilet* (at home **or** work) — a full bladder outranks the counter.
- **hygiene**: decays across the day; a **warm bath** restores it — and a seeded memory ("*every
  morning I bathe…*") plus a morning circadian fit make the **morning bath** a ritual, not a script.

Food is a **Pokémon-style abstract inventory**: at the supermarket she has an *emergent thought*
(LLM, memory-informed by her food preferences) about what to buy; a basket is stocked into the
fridge, carried home and **stowed**, then **cooked at the stove**. The staff burger at work is a
convenient fallback, but she mostly cooks — grocery runs are proactive (restock before empty).

## The psyche — an abstracted interlocutor

Mara runs the full ~34-channel soma. Whoever she talks to is modelled by a **`MindLite`**
(`mind/mindlite.ts`) — seven coarse scalars (valence, arousal, dominance, warmth, threat,
energy, openness) with mood-inertia dynamics, at *lower causal resolution*. It is created when
the exchange begins and **discarded when it ends**; only a one-line ledger gist survives.

## The symbolic memory graph (`mind/memgraph.ts`, `MEMORY_DESIGN.md`)

Memory is a **graph of text-bearing nodes updated numerically every frame, consolidated
symbolically off the hot path** — *numeric retrieval, symbolic consolidation*. Nodes are
episodic events, semantic gists, entities (people/places) and schemas; edges are temporal,
associative, about-entity, is-a and causal. Retrieval combines **ACT-R base-level activation**
(power-law forgetting, recency×frequency, salience-slowed) with a **Generative-Agents additive
score** (recency + importance + relevance + mood-congruence) and a **one-hop spreading
activation** — all O(k), real-time. Encoding is **salience-gated** (McGaugh); recall triggers
**reconsolidation drift**; during **rest**, the graph **consolidates** similar episodics into
semantic gists and **reflects** into schemas — using the local LLM when present, templates when
not. Toggle **MEMORY** to watch it: nodes glow as they are recalled, and the currently-retrieved
memory names itself. Toggle **PSYCHE** for the live psyche-vector signature.

## The neuroanatomy panel

The dashboard's **Neuroanatomy · soma vector** panel (toggle with the **BRAIN** button)
renders a real, MRI-derived brain as black wireframe on sepia: the pial cortex (true
gyri/sulci, depth-occluded to the near surface), Desikan–Killiany cortical regions, and
segmented subcortical nuclei, with a brainstem · cerebellum · basal-ganglia · corpus-callosum
context. The tiny brainstem nuclei MRI can't segment (VTA, raphe, locus coeruleus, PAG,
pituitary, pineal) are shown as markers placed in the real coordinate frame. With **LIVE** on,
every region **glows in real time** with the activation of the soma channels that drive it —
threat regions in oxblood, reward/affiliation regions in green — so you watch the brain light up
as the psyche runs. **Drag** to rotate, **wheel** to zoom; **↑/↓** step the soma vector and the
responsible structure(s) light up in ink with labeled leader-arrows. See `src/render/brain.ts`; the mesh bundle
`public/brain-mesh.json` is built by `scripts/build-brain-mesh.mjs`.

## Where next — the exposome program

The whole point of this prototype is to grow into a **modular, validatable simulator of human
exposure to risk factors** (psychological, nutritional, pollution, sedentarism) that can identify
therapeutic targets and run virtual clinical trials. **[EXPOSOME_ROADMAP.md](EXPOSOME_ROADMAP.md)**
is a code-grounded, phased roadmap for that (produced by a multi-perspective agent workflow with an
adversarial review pass). Its thesis: replace the single opaque `allostaticLoad` scalar with a
**mechanistic mediator spine** (chronic stress → glucocorticoid-receptor resistance → inflammation →
sickness-behavior + cardiometabolic drift) expressed as **clinically-measured biomarkers**, riding a
**typed flux bus** so lower-scale modules (PBPK, receptor occupancy, organ ODEs) superpose without
touching the core, inside a **deterministic, cohort-scale, headless** runtime that makes likelihood-free
calibration against real cohorts (NHANES/MIDUS/UK Biobank) and a frontier-model-in-the-loop structure
search feasible. It also flags concrete first fixes (honest HPA feedback, a Borbély sleep homeostat,
decoupling metabolism from arousal, per-agent RNG streams).

## Credits & data

The brain surfaces are derived from **Brainder "Brain for Blender"** by Anderson M. Winkler
(real MRI FreeSurfer surfaces), licensed **CC-BY-SA 3.0** —
<https://brainder.org/research/brain-for-blender/>. The preprocessed mesh bundle
(`public/brain-mesh.json`) is therefore a derivative work distributed under the same license.
