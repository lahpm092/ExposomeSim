# Mara's memory — design notes (neuroscience → cheap real-time graph)

The memory system is a **graph of text-bearing nodes updated numerically every frame,
consolidated symbolically (optionally by a small local LLM) off the hot path**. Principle:
*numeric retrieval, symbolic/LLM consolidation*. Implemented in `src/harness/memgraph.ts`,
driven per-character by `Character`.

## Mechanisms modelled (ranked bang-for-buck)

1. **Base-level decay (forgetting curve)** — ACT-R: retrievability falls as a power law of
   time-since-use; frequency/recency raise it. One scalar per node, computed lazily.
2. **Emotional salience gating** — amygdala/NE/cortisol scale *consolidation* (McGaugh):
   arousal at encode ↑ initial strength and *slows* the decay exponent.
3. **Spreading activation / cue-dependent recall** — cues pre-activate associates; bounded
   to ≤2 hops over `ASSOC`/`ABOUT` edges to stay O(k).
4. **Recency + frequency + primacy** — fall out of ACT-R base-level for free.
5. **Complementary Learning Systems** — `episodic` (fast encode, fast decay) vs `semantic`
   (slow, near-permanent), the two node classes.
6. **Schema/gist + semanticization** — periodic consolidation fuses similar episodics into a
   `semantic` gist; episodics then decay away.
7. **Availability vs accessibility** — `encodingStrength` (near-permanent) vs `retrievability`
   (decays). Recall failure ≠ deletion ("I know I knew this").
8. **Reconsolidation / drift** — recall strengthens *and* nudges the trace's keyword/affect
   toward the current cue/mood (Nader 2000).
9. **Pattern separation vs completion** — separation = dedupe-by-similarity on encode;
   completion = the spread in (3).
10. **Replay during rest** — the batched consolidation job *is* replay; runs on idle/sleep ticks.
11. **Mood-congruent retrieval** — current mood valence is an extra cue term.

## The equations that are ported directly

ACT-R base-level (recency+frequency), O(1) Petrov approximation, `d≈0.5`, salience-slowed:
```
B_i ≈ ln( n / (1-d_eff) ) − d_eff · ln(L),   d_eff = d·(1 − 0.4·salience),  L = now − createdAt
```
Generative-Agents additive retrieval (each term min-max ~[0,1]):
```
score = wR·recency + wI·salience + wV·relevance(cue) + wA·spread + wM·moodFit
recency  = 0.995^(hoursSinceLastRecall)
relevance= keyword/embedding overlap with the cue
spread   = one-hop activation from matched seeds along ASSOC/ABOUT edges
moodFit  = 1 − |mood − node.valence|/2
```
Reconsolidation on successful recall: `recallCount++`, `encodingStrength += 1`,
`retrievability = max(retrievability, B_i) + 1`, drift keyword-weights/valence toward the cue.

## LLM on / off the hot path

- **LLM (async, batched, off hot path):** event→first-person memory prose; entity/relation
  extraction (`ABOUT`/`CAUSAL` edges); consolidation gist; periodic reflection → `schema`.
- **Pure-numeric (every frame):** retrieval scoring, decay, spread, reconsolidation, edge
  updates. If Ollama is down, a template string + keyword bag keeps everything running.

## Sources
ACT-R base-level & spreading (Anderson; Petrov 2006 O(1) approximation); Generative Agents
retrieval+reflection (Park et al. 2023); Complementary Learning Systems (McClelland/McNaughton/
O'Reilly 1995; Kumaran/Hassabis/McClelland 2016); emotional consolidation gating (McGaugh);
reconsolidation/updating (Nader 2000).
