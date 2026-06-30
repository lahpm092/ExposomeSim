# ExposomeSim

A neurosymbolic simulator of the **exposome** — the cumulative psychological toll of
lived experience. An LLM drives a human character whose *persistent self* is not in the
prompt but in a **dynamical limbic/endocrine substrate**: coupled stochastic differential
equations for neuromodulators and hormones, with circadian rhythm, an HPA stress axis, and
a slow **allostatic-load** integrator that is the exposome's memory.

> Field study I: **the counter** — a fast-food cashier interacting with customers,
> rendered in 3D as black wireframe on aged sepia, with a live neuropsychological instrument
> panel (core affect, neurochemistry, limbic activation, and **time-integrals of emotion**).

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
| contract | `types.ts` | shared domain types — the single source of truth |
| harness | `harness/params.ts` | genotype × CB5T Big Five × experiosome → soma physics; population sampling |
| | `harness/soma.ts` | Euler–Maruyama integrator, circadian forcing, couplings, core-affect readout |
| | `harness/appraisal.ts` | OCC/Scherer appraisal → soma kicks; Gross regulation strategies |
| | `harness/emotion.ts` | constructed-emotion readout + **exposome integrals** |
| | `harness/memory.ts` | affect-gated episodic memory stream |
| | `harness/character.ts` | the unit: soma + memory an LLM drives |
| llm | `llm/client.ts` | swappable backend (Ollama now → remote API later) |
| | `llm/prompt.ts` | interoception rendering, role-play contract, tolerant JSON parsing |
| sim | `sim/events.ts`, `sim/world.ts` | the burger counter; async LLM beats over a living substrate |
| render | `render/stage.ts` | three.js — wireframe restaurant + embodied cashier |
| ui | `ui/dashboard.ts` | canvas instrument panels |

## Running it

```bash
# 1. local model (smallest decent Qwen; ~522 MB)
ollama serve &              # if not already running
ollama pull qwen3:0.6b

# 2. the app
npm install
npm run dev                 # http://localhost:5173  (Vite proxies /ollama → :11434)
```

Controls: **space** pause · **+ / −** sim speed. If Ollama is unreachable the sim falls back
to a soma-derived driver so it still runs (no LLM in the loop).

Headless check of the dynamics (no browser, no LLM):

```bash
npx tsx scripts/harness-smoke.ts
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
  them*, then distilled to a one-line **ledger** summary and demoted (`src/sim/town.ts`).
- **Tier 1 — proximate NPCs** are cheap symbolic minds (path + goal token, no soma).
- **Tier 3 — the city** is a pure population-density field — thousands implied, zero
  instantiated (`src/sim/city.ts`).

Her day is **not scripted**. A Maslow **needs** layer is read off the soma
(`src/harness/needs.ts`: hunger←ghrelin, energy←fatigue, belonging←a slow social
reservoir + PANIC/GRIEF, safety←cortisol/amygdala, …) and an **arbiter**
(`src/sim/arbiter.ts`) scores those deficits against place **affordances**
(`src/sim/places.ts` — home · work · market · café · park) bound by money / food /
energy / time (`src/sim/economy.ts`). The work→eat→home→shop→café loop is the *limit
cycle* of those drives, not a calendar. **Relationships emerge** unscripted from
reciprocated, oxytocin-rewarding encounters (`src/sim/relationship.ts`) — over a week
Mara forms a warm friendship with one café regular while another stays strained, with
no `befriend` verb anywhere.

Verify the emergence headless (no browser, no LLM):

```bash
npx tsx scripts/town-smoke.ts   # prints the emergent day + the relationship ledger
```

Press **C** (or the CITY button) to zoom out to the town map — places, streets, the
breathing density field, and Mara's marker tracing her path, with the relationship
constellation condensing at the café. The dashboard's **a life by need** panel shows
where she is, *why* (the arbiter's reason), her need deficits, money/food, and the
ledger. It runs without Ollama (soma-derived fallback); start Ollama to put the LLM
back in Mara's loop.

## The neuroanatomy panel

The dashboard's **Neuroanatomy · soma vector** panel (toggle with the **BRAIN** button)
renders a real, MRI-derived brain as black wireframe on sepia: the pial cortex (true
gyri/sulci, depth-occluded to the near surface), Desikan–Killiany cortical regions, and
segmented subcortical nuclei, with a brainstem · cerebellum · basal-ganglia · corpus-callosum
context. The tiny brainstem nuclei MRI can't segment (VTA, raphe, locus coeruleus, PAG,
pituitary, pineal) are shown as markers placed in the real coordinate frame. **Drag** to
rotate, **wheel** to zoom; **↑/↓** step the soma vector and the responsible structure(s)
light up in ink with labeled leader-arrows. See `src/render/brain.ts`; the mesh bundle
`public/brain-mesh.json` is built by `scripts/build-brain-mesh.mjs`.

## Credits & data

The brain surfaces are derived from **Brainder "Brain for Blender"** by Anderson M. Winkler
(real MRI FreeSurfer surfaces), licensed **CC-BY-SA 3.0** —
<https://brainder.org/research/brain-for-blender/>. The preprocessed mesh bundle
(`public/brain-mesh.json`) is therefore a derivative work distributed under the same license.
