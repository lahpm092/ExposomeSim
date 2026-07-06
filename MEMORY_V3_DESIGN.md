# Memory v3 — Embeddings × Graph (research-grounded)

Extends the symbolic memory graph (`harness/memgraph.ts`, see MEMORY_DESIGN.md)
with dense vector embeddings **without replacing** the validated ACT-R /
spreading-activation / reconsolidation machinery. The guiding result from the
research pass (see MEMORY_RESEARCH_REPORT.md for the full brief + citations):

> *Cosine finds the door; graph propagation walks the rooms.*

Every SOTA agent-memory system (HippoRAG, Graphiti/Zep, SA-RAG, SYNAPSE) converges
on the same move: **seed spreading activation from the cue's vector nearest
neighbors, then propagate over the typed graph.** We adopt exactly that, plus a
drifting **context vector** as the psychological retrieval cue (Temporal Context
Model / CMR), and upgrade reconsolidation from "absorb a couple cue tokens" to a
principled **vector drift** rule (PE-gated, type-dependent, strength-damped,
schema-biased, anchored — the ReKAM/CLS shape).

## Isolation

Memory-track files ONLY: `harness/memgraph.ts` (extend), `llm/embed.ts` (new),
`render/memoryviz.ts` (optional viz). **No change to `character.ts`** — the
embedder is a self-configuring singleton pulled in by `memgraph.ts`, and async
embedding backfill piggybacks the existing per-tick `decayAll`. Fully
backward-compatible: with no Ollama, a deterministic hashed fallback vector keeps
it running, and the original lexical token-overlap tier stays always-on.

## 1. Embedding client (`llm/embed.ts`)

- **Model:** `nomic-embed-text` via the existing `/ollama` proxy (`/api/embed`,
  batched array API). Vectors **truncated to 256-d (Matryoshka) and L2-normalized
  at store time** → cosine = plain dot product; halves RAM + cost (MTEB −1.2 only).
- **Never awaited on the tick.** `embed()` returns cached vectors synchronously
  when present; misses are enqueued and computed in **batches off the hot path**.
- **Content-hash cache** (memory strings repeat heavily across 18 agents).
- **Graceful degrade:** Ollama down → a deterministic hashed bag-of-words vector
  (still 256-d, unit-norm) so semantic-ish behaviour survives; and the lexical
  relevance tier never goes away.
- Gotcha [established]: Ollama's `nomic-embed-text` defaults to 2K ctx — fine for
  our short memory strings; we set `num_ctx` explicitly anyway.

API: `getEmbedder()` singleton; `embedder.cached(text): Float32Array|null` (sync),
`embedder.enqueue(text)`, `embedder.flush(): Promise<void>` (batched), `dim=256`.

## 2. Node vectors + the drifting context vector

- Each `MemNode` gains `vec?: Float32Array` (unit-norm, filled async) and `vec0`
  (the encoding-time vector, an anchor for drift). Nodes without a vec yet fall
  back to lexical-only relevance.
- The graph maintains a per-agent **context vector** `ctx` — a leaky integrator,
  the CMR "current mental context":
  ```
  encode:  ctx ← normalize(ρ·ctx + β_enc·e_event)     β_enc = 0.70
  recall:  ctx ← normalize(ρ·ctx + β_rec·e_cue)        β_rec = 0.35
  reinstate (after recall): ctx ← normalize(ρ·ctx + β_rec·e_winner)  // contiguity
  ```
  This buys encoding-specificity, recency, temporal contiguity and mood-congruence
  from one mechanism.

## 3. Hybrid retrieval (additive, ACT-R-native)

Keep the existing seed score; add a **dense relevance** term and **vector-seeded
spreading**. The cue vector is the query embedding (if cached) blended with `ctx`:
```
cueVec   = normalize(w_q·cached(query) + w_c·ctx)         w_q=0.6, w_c=0.4
rel_i    = W_LEX·lexicalSim(cueTokens, node.tokens)       W_LEX=0.5
         + W_VEC·cos(cueVec, node.vec)                     W_VEC=1.0   (0 if no vec)
score_i  = W_R·recency + W_I·salience + rel_i + W_M·moodFit + 0.15·baseLevel
```
**Vector-seeded spreading activation:** before the 1-hop spread, add the **top-N
cosine neighbors of `cueVec`** (N≈12) to the seed set with injected energy — so a
memory can surface by *meaning* even with zero shared tokens, then pull in its
graph neighbors (pattern completion). Brute-force cosine over a few hundred nodes
is ~0.05 ms — negligible.

## 4. Reconsolidation as vector drift (§B of the brief)

On recall of a node with a vector, drift it toward the cue/context, gated and
bounded so it strengthens-and-distorts like real memory but never runs away:
```
d      = 1 − cos(vec, cueVec)                        // prediction error
if d < θ(kind):  no drift                            // matches don't overwrite
gate   = clamp((d−θ)/(1−θ), 0, 1)
s      = normalizedStrength(node)                    // grows with recallCount
α_eff  = α_base(kind)·gate/(1 + κ·s)                 // κ=0.7
target = (1−γ)·cueVec + γ·schemaPrototype(node)      // γ=0.2 schema bias
vec    = normalize( vec + α_eff·(target−vec) − β_anchor·(vec−vec0) )   // β_anchor=0.02
```
`α_base`: episodic 0.10, semantic 0.03, schema 0.008. `θ`: 0.10 / 0.20 / 0.30.
McGaugh tie-in: high-arousal memories start with high strength → drift less. The
token-absorption drift stays too (viz stays legible), but affect + vector drift
are now the primary distortion channels.

## 5. Embedding-driven consolidation (offline, "rest")

In `consolidate()`: cluster episodics in **vector space** (greedy cosine ≥ ~0.55,
min 3) instead of token overlap; the resulting `semantic` gist node gets the
**renormalized centroid** as its vec (`‖mean‖` before renorm = a free coherence
score). Also materialize `assoc` edges by **mutual-kNN cosine ≥ ~0.6** so the
associative graph is *learned from meaning*, not just co-occurrence. Novel
(outlier) episodes stay episodic (CLS: schema-consistent → fast; novel → slow).

## 6. Persistence

`toJSON`/`loadJSON` serialize `vec`/`vec0` (as plain number[]) and `ctx`. Absent
vectors on old saves are simply re-embedded lazily.

## Constants (defaults; tune on observed recall)

β_enc 0.70 · β_rec 0.35 · w_q 0.6 · w_c 0.4 · W_LEX 0.5 · W_VEC 1.0 ·
drift α {epi .10, sem .03, sch .008} · θ {.10,.20,.30} · γ 0.2 · κ 0.7 ·
β_anchor 0.02 · dim 256 · NN-seed 12 · consolidate-cos 0.55 · assoc-cos 0.60.
