// =============================================================================
// memgraph.ts — a symbolic memory GRAPH: text-bearing nodes updated numerically
// every frame, consolidated symbolically (optionally by a small local LLM) off
// the hot path. Design principle: *numeric retrieval, symbolic consolidation*.
// See MEMORY_DESIGN.md for the neuroscience grounding and the ported equations.
//
//   nodes : episodic event · semantic gist · entity (person/place) · schema
//   edges : temporal · assoc (co-occurrence) · about (→entity) · is_a · causal
//
// Every frame (pure numeric, O(k)):
//   encode()   — salience-gated (McGaugh); pattern-separation dedupe → reconsolidate
//   retrieve() — ACT-R base-level × Generative-Agents additive score + 1-hop spread
//   decay()    — power-law forgetting; salient traces decay slower
// Off the hot path (async, optional LLM, during "rest"):
//   consolidate() — fuse similar episodics into a semantic gist (replay)
//   reflect()     — synthesize a higher-order schema/insight (à la Generative Agents)
//
// Drop-in for MemoryStream: same seed/add/decayAll/recent/retrieve surface, plus
// graph accessors for the live visualization.
// =============================================================================
import type { MemoryItem, SomaState, LLMClient, MemGraphView, MemNodeKind, MemEdgeKind } from '../core/types';
import { getEmbedder, cosine, EMBED_DIM, type Embedder } from '../llm/embed';
import { clamp } from '../core/util/num';

export type NodeKind = MemNodeKind;
export type EdgeKind = MemEdgeKind;

export interface MemNode {
  id: string;
  kind: NodeKind;
  text: string;
  tokens: Set<string>;      // keyword bag — the lexical "embedding" (always-on fallback tier)
  vec?: Float32Array;       // dense embedding (256-d, unit-norm), filled async off the hot path
  vec0?: Float32Array;      // the encoding-time vector — an anchor that bounds reconsolidation drift
  valence: number;
  arousal: number;
  salience: number;         // emotional importance at encode [0,1]
  encodingStrength: number; // availability (near-permanent)
  retrievability: number;   // accessibility (decays)
  createdAt: number;
  lastRecalledAt: number;
  recallCount: number;
}
export interface MemEdge { to: string; kind: EdgeKind; w: number; }

// ---- tuning (report §5) ----------------------------------------------------
const D = 0.5;              // ACT-R decay exponent
const RECALL_BUMP = 0.8;    // strength added per recall
const DRIFT = 0.14;         // reconsolidation pull toward current context
const W_R = 1.0, W_I = 1.0, W_A = 0.55, W_M = 0.35; // score weights (relevance now hybrid — see W_LEX/W_VEC)
const RETR_FLOOR = 0.04;    // below this an episodic is inaccessible (still available)
const MAX_EPISODIC = 220;   // prune the coldest episodics beyond this
const SIM_SEPARATE = 0.82;  // encode similarity above which we reconsolidate not add

// ---- v3: embeddings × graph (MEMORY_V3_DESIGN.md; research §a,b) ------------
// The dense tier is ADDITIVE: it augments the lexical scorer, never replaces it.
const W_LEX = 0.5;          // weight on lexical token-overlap relevance
const W_VEC = 1.0;          // weight on dense cosine relevance (0-contribution if no vec)
const CUE_Q = 0.6;          // cue = CUE_Q·query-embed ⊕ CUE_C·context-vector (TCM/CMR)
const CUE_C = 0.4;
const BETA_ENC = 0.70;      // context drift rate while PERCEIVING (encoding)  [CMR: β_enc>β_rec]
const BETA_REC = 0.35;      // context drift rate while RECALLING
const NN_SEED = 12;         // #vector nearest-neighbours injected as spreading seeds
const NN_SEED_ENERGY = 0.9; // energy injected per vector-NN seed
// reconsolidation drift (research §B.2): PE-gated, type-dependent, strength-damped
const DRIFT_ALPHA: Record<NodeKind, number> = { episodic: 0.10, semantic: 0.03, schema: 0.008, entity: 0.02 };
const DRIFT_THETA: Record<NodeKind, number> = { episodic: 0.10, semantic: 0.20, schema: 0.30, entity: 0.20 };
const DRIFT_GAMMA = 0.20;   // pull of the drift target toward the schema prototype (Bartlett bias)
const DRIFT_KAPPA = 0.7;    // strength-damping: older/stronger memories drift less
const DRIFT_ANCHOR = 0.02;  // restoring force toward the encoding vector (keeps the gist)
const CONSOLIDATE_COS = 0.55; // vector-space cluster threshold for gist formation
const ASSOC_COS = 0.60;     // materialize an assoc edge when two episodics are this close

const STOP = new Set(('a an the you your i my me we it is are was were be to of and or but in on at ' +
  'for with as by that this these those he she they them his her not no yes do did done so if then ' +
  'from up down out over under again once here there what who how when why all any some one two').split(' '));

let _seq = 0;
const uid = (p = 'n') => `${p}${(_seq++).toString(36)}`;

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z']{3,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  return out;
}
// interjections / sentence-openers that are capitalized but are NOT entities.
// (real names/places survive: Mara, Café, Counter, Market, Apartment, Park, Eli…)
const NAME_STOP = new Set(('sorry hurry sure thanks thank okay please yes well look hey ' +
  'are you your this that these those what how when why who right fine good great maybe ' +
  'here there just really still even also always never once youre its lets everything something ' +
  'nothing someone anyone everyone today tomorrow tonight morning evening').split(' '));

// a lexicon of salient people/places that recur in this world but aren't always
// capitalized — so the graph grows real entity nodes for them (title-cased).
const LEXICON: Record<string, string> = {
  counter: 'The Counter', café: 'Café', cafe: 'Café', market: 'Market', apartment: 'Home',
  park: 'Park', manager: 'the manager', mother: 'her mother', customer: 'a customer',
  customers: 'customers', regular: 'a regular', tuition: 'tuition', nursing: 'nursing school',
};

/** proper-noun + lexicon entities in the text, skipping sentence-initial words
 *  and common interjections (capitalized by grammar, not because they name a thing). */
function properNouns(s: string): string[] {
  const out = new Set<string>();
  const re = /([A-Z][a-zé]{2,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const w = m[1];
    if (NAME_STOP.has(w.toLowerCase()) || STOP.has(w.toLowerCase())) continue;
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(s[j])) j--;
    const prev = j >= 0 ? s[j] : '';
    if (prev === '' || prev === '.' || prev === '!' || prev === '?' || prev === '"' || prev === '“' || prev === '—') continue;
    out.add(w);
  }
  // lexicon hits (case-insensitive), title-cased to a canonical entity name.
  for (const w of s.toLowerCase().match(/[a-zé]{3,}/g) ?? []) {
    const canon = LEXICON[w];
    if (canon) out.add(canon);
  }
  return [...out];
}
/** overlap-cosine of two token bags in [0,1]. */
function sim(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const t of small) if (big.has(t)) inter++;
  return inter / Math.sqrt(a.size * b.size);
}

export class MemoryGraph {
  private readonly map = new Map<string, MemNode>();
  private readonly out = new Map<string, MemEdge[]>();   // adjacency (directed)
  private readonly entityByName = new Map<string, string>(); // lower name → node id
  private lastEpisodic: string | null = null;
  private readonly activation = new Map<string, number>(); // last retrieval activation (for viz)
  private consolidating = false;

  // ---- v3: dense embeddings + the drifting context vector -------------------
  private readonly embedder: Embedder = getEmbedder();   // shared singleton (shared cache/batching)
  private ctx = new Float32Array(EMBED_DIM);             // CMR context vector (unit-norm; the retrieval cue)
  private backfillAcc = 0;                               // throttle async embed backfill

  // ---- construction ---------------------------------------------------------
  /** seed durable formative memories (from the experiosome). */
  seed(texts: string[], t = 0): void {
    for (const text of texts) {
      const n = this.addNode('semantic', text, 0, 0.4, 0.85, t);
      n.encodingStrength = 2.2; n.retrievability = 2.2;
      this.linkEntities(n);
    }
  }

  // ---- ENCODE (hot path, numeric) ------------------------------------------
  /** encode an event; salience gated by current arousal & stress. */
  add(t: number, text: string, soma: SomaState): MemoryItem {
    const salience = Math.min(1,
      0.2 + 0.5 * soma.arousal + 0.3 * Math.max(0, soma.cortisol - 1) +
      0.3 * Math.abs(soma.valence) + 0.2 * soma.amygdala);
    const tokens = tokenize(text);

    // pattern separation: if a very similar episodic is fresh, reconsolidate it.
    let near: MemNode | null = null, nearS = SIM_SEPARATE;
    for (const n of this.map.values()) {
      if (n.kind !== 'episodic') continue;
      const s = sim(tokens, n.tokens);
      if (s > nearS) { nearS = s; near = n; }
    }
    if (near) { this.reconsolidate(near, tokens, soma.valence, t, this.embedder.cached(text) ?? undefined); return this.project(near); }

    const node = this.addNode('episodic', text, soma.valence, soma.arousal, salience, t);
    node.encodingStrength = 1 + salience;
    node.retrievability = 1 + salience;

    // associate with recently-active context (co-occurrence) + temporal succession.
    if (this.lastEpisodic && this.map.has(this.lastEpisodic)) {
      this.link(this.lastEpisodic, node.id, 'temporal', 0.7);
      this.link(node.id, this.lastEpisodic, 'assoc', 0.4);
    }
    for (const [id, a] of this.activation) {
      if (a > 0.4 && id !== node.id && this.map.has(id)) this.link(node.id, id, 'assoc', Math.min(0.6, a * 0.5));
    }
    this.linkEntities(node);
    this.lastEpisodic = node.id;

    this.prune();
    return this.project(node);
  }

  private addNode(kind: NodeKind, text: string, valence: number, arousal: number, salience: number, t: number): MemNode {
    const n: MemNode = {
      id: uid(kind[0]), kind, text, tokens: tokenize(text),
      valence, arousal, salience,
      encodingStrength: 1, retrievability: 1,
      createdAt: t, lastRecalledAt: t, recallCount: 1,
    };
    // grab a dense vector if the shared cache already has this text (memory strings
    // repeat heavily across the 18 agents); else this enqueues it for async backfill.
    this.assignVec(n, this.embedder.cached(text));
    this.map.set(n.id, n);
    return n;
  }

  /** assign a COPY of a cached embedding to a node (never the shared cache object —
   *  reconsolidation drift mutates node.vec in place). Also seeds the anchor vec0. */
  private assignVec(n: MemNode, vec: Float32Array | null): void {
    if (!vec) return;
    n.vec = vec.slice();
    n.vec0 = vec.slice();
  }

  private link(a: string, b: string, kind: EdgeKind, w: number): void {
    let arr = this.out.get(a);
    if (!arr) { arr = []; this.out.set(a, arr); }
    const ex = arr.find((e) => e.to === b && e.kind === kind);
    if (ex) ex.w = Math.min(1, ex.w + w * 0.3);
    else arr.push({ to: b, kind, w });
  }

  /** create/find entity nodes for the proper nouns in a node's text; link ABOUT. */
  private linkEntities(node: MemNode): void {
    for (const name of properNouns(node.text)) {
      const key = name.toLowerCase();
      let id = this.entityByName.get(key);
      if (!id) {
        const e = this.addNode('entity', name, 0, 0, 0.5, node.createdAt);
        e.encodingStrength = 1.6; e.retrievability = 1.6;
        id = e.id; this.entityByName.set(key, id);
      }
      this.link(node.id, id, 'about', 0.8);
      this.link(id, node.id, 'about', 0.5);
    }
  }

  // ---- DECAY (hot path) -----------------------------------------------------
  /** power-law-ish forgetting; salient traces decay slower (availability persists). */
  decayAll(dtHours: number): void {
    for (const n of this.map.values()) {
      if (n.kind === 'entity' || n.kind === 'schema') continue; // near-permanent
      const rate = (n.kind === 'semantic' ? 0.015 : 0.06) * (1 - 0.6 * n.salience);
      n.retrievability *= Math.exp(-rate * dtHours);
    }
    // activation trace cools between retrievals (for the viz)
    for (const [id, a] of this.activation) {
      const na = a * Math.exp(-0.9 * dtHours);
      if (na < 0.02) this.activation.delete(id); else this.activation.set(id, na);
    }
    // v3: opportunistically fill dense vectors + advance the context vector — batched,
    // fire-and-forget, fully off the hot path. Throttled to ~one beat.
    this.backfillAcc += dtHours;
    if (this.backfillAcc >= 0.05) { this.backfillAcc = 0; void this.backfill(); }
  }

  /** compute a batch of pending embeddings and bind freshly-available vectors to
   *  the nodes that still lack them, advancing the CMR context vector per new
   *  episodic (in Map insertion order) — the leaky-integrator context, reconstructed
   *  asynchronously so the tick never waits on the embedder. */
  private async backfill(): Promise<void> {
    await this.embedder.flush();
    for (const n of this.map.values()) {
      if (n.vec) continue;
      const v = this.embedder.cached(n.text);
      if (!v) continue;
      this.assignVec(n, v);
      if (n.kind === 'episodic' && n.vec) this.driftContext(n.vec, BETA_ENC);
    }
  }

  /** drift the context vector toward `v`: ctx ← normalize(ρ·ctx + β·v)  (TCM/CMR). */
  private driftContext(v: Float32Array, beta: number): void {
    const rho = Math.sqrt(Math.max(0, 1 - beta * beta));
    const c = this.ctx;
    for (let i = 0; i < c.length; i++) c[i] = rho * c[i] + beta * v[i];
    unitInPlace(c);
  }

  /** the retrieval cue: the query embedding blended with the ambient context vector
   *  (encoding specificity + recency + contiguity). Zero when no embeddings exist yet
   *  → the scorer falls back cleanly to the lexical tier. */
  private cueVector(query: string): Float32Array {
    const out = new Float32Array(EMBED_DIM);
    const q = this.embedder.cached(query);   // sync hit or null (enqueues the miss)
    const c = this.ctx;
    for (let i = 0; i < out.length; i++) out[i] = CUE_Q * (q ? q[i] : 0) + CUE_C * c[i];
    return unitInPlace(out);
  }

  // ---- RETRIEVE (hot path, bounded spreading activation) --------------------
  retrieve(query: string, k = 4, mood = 0): MemoryItem[] {
    return this.retrieveNodes(query, k, mood).map((n) => this.project(n));
  }

  retrieveNodes(query: string, k = 4, mood = 0): MemNode[] {
    const cue = tokenize(query);
    const cueVec = this.cueVector(query);   // query-embed ⊕ context (TCM/CMR)
    const now = this.now();
    const act = new Map<string, number>();
    const bySim: { id: string; cos: number }[] = [];   // for vector-NN seeding

    // seed: every node scored by recency + HYBRID relevance (lexical ⊕ dense) +
    // salience + mood congruence + ACT-R base level.
    for (const n of this.map.values()) {
      if (n.retrievability < RETR_FLOOR && n.kind === 'episodic') continue;
      const recency = Math.pow(0.995, Math.max(0, now - n.lastRecalledAt));
      const lex = sim(cue, n.tokens);
      const cos = n.vec ? cosine(cueVec, n.vec) : 0;
      const relevance = W_LEX * lex + W_VEC * cos;
      const base = this.baseLevel(n, now);
      const moodFit = 1 - Math.abs(mood - n.valence) / 2;
      const s = W_R * recency + W_I * n.salience + relevance + W_M * moodFit + 0.15 * base;
      if (s > 0.05) act.set(n.id, s);
      if (cos > 0.15) bySim.push({ id: n.id, cos });
    }

    // vector-seeded spreading activation (research §a: "cosine finds the door"):
    // inject energy at the cue's nearest neighbours in embedding space, so a memory
    // can light up by MEANING even with zero shared tokens, then pull in its graph
    // neighbours below.
    bySim.sort((a, b) => b.cos - a.cos);
    for (const { id, cos } of bySim.slice(0, NN_SEED)) {
      act.set(id, (act.get(id) ?? 0) + NN_SEED_ENERGY * cos);
    }

    // one-hop spread along assoc/about/is_a/temporal edges (pattern completion).
    const seeds = [...act.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [id, a] of seeds) {
      for (const e of this.out.get(id) ?? []) {
        act.set(e.to, (act.get(e.to) ?? 0) + W_A * e.w * 0.5 * a);
      }
    }

    const ranked = [...act.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    // publish activation for the viz, and reconsolidate the winners (strengthen + drift).
    for (const [id, a] of ranked) {
      this.activation.set(id, Math.max(this.activation.get(id) ?? 0, Math.min(1, a)));
      const n = this.map.get(id);
      if (n) this.reconsolidate(n, cue, mood, now, cueVec);
    }
    // context maintenance: the cue reshapes context (recall drift), then the winning
    // memories reinstate THEIR context (temporal-contiguity chaining).
    this.driftContext(cueVec, BETA_REC);
    for (const [id] of ranked) { const n = this.map.get(id); if (n?.vec) this.driftContext(n.vec, BETA_REC * 0.4); }
    return ranked.map(([id]) => this.map.get(id)!).filter(Boolean);
  }

  /** ACT-R base-level activation (Petrov O(1) approximation), salience-slowed. */
  private baseLevel(n: MemNode, now: number): number {
    const L = Math.max(1e-3, now - n.createdAt);
    const dEff = D * (1 - 0.4 * n.salience);
    return Math.log(n.recallCount / (1 - dEff)) - dEff * Math.log(L);
  }

  // ---- RECONSOLIDATION (recall strengthens AND distorts) --------------------
  private reconsolidate(n: MemNode, cue: Set<string>, mood: number, now: number, cueVec?: Float32Array): void {
    n.recallCount += 1;
    n.lastRecalledAt = now;
    n.encodingStrength += RECALL_BUMP;
    n.retrievability = Math.max(n.retrievability, 1) + RECALL_BUMP * 0.5;
    // distortion channel 1 (lexical, keeps the viz legible): absorb a couple cue tokens.
    let added = 0;
    for (const t of cue) { if (!n.tokens.has(t) && added < 2) { n.tokens.add(t); added++; } }
    // distortion channel 2 (affective): nudge the tag toward the current mood.
    n.valence += DRIFT * (mood - n.valence);
    // distortion channel 3 (semantic): drift the dense vector toward the retrieval
    // context — PE-gated, type-dependent, strength-damped, schema-biased, anchored.
    if (cueVec) this.driftVec(n, cueVec);
  }

  /** reconsolidation vector drift (research §B.2). Bounded so cumulative recall
   *  reshapes a memory toward its retrieval context + schema without erasing its gist. */
  private driftVec(n: MemNode, cueVec: Float32Array): void {
    const v = n.vec, v0 = n.vec0;
    if (!v || !v0) return;
    const d = 1 - cosine(v, cueVec);                 // prediction error (0 = identical)
    const theta = DRIFT_THETA[n.kind];
    if (d < theta) return;                            // a matching recall doesn't overwrite
    const gate = clamp((d - theta) / (1 - theta), 0, 1);
    const s = clamp(n.recallCount / 8, 0, 1);        // strength proxy → older memories drift less
    const alpha = DRIFT_ALPHA[n.kind] * gate / (1 + DRIFT_KAPPA * s);
    const proto = this.prototypeOf(n) ?? cueVec;     // drift target biased toward the gist prototype
    for (let i = 0; i < v.length; i++) {
      const target = (1 - DRIFT_GAMMA) * cueVec[i] + DRIFT_GAMMA * proto[i];
      v[i] += alpha * (target - v[i]) - DRIFT_ANCHOR * (v[i] - v0[i]);
    }
    unitInPlace(v);
  }

  /** the schema/gist prototype a node is filed under (its is_a parent's vector), if any. */
  private prototypeOf(n: MemNode): Float32Array | null {
    for (const e of this.out.get(n.id) ?? []) {
      if (e.kind !== 'is_a') continue;
      const p = this.map.get(e.to);
      if (p?.vec) return p.vec;
    }
    return null;
  }

  /** similarity between two nodes — dense cosine when both are embedded, else lexical. */
  private memSim(a: MemNode, b: MemNode): number {
    if (a.vec && b.vec) return cosine(a.vec, b.vec);
    return sim(a.tokens, b.tokens);
  }

  /** renormalized centroid of a cluster's dense vectors (the prototype); null if none. */
  private centroid(cluster: MemNode[]): Float32Array | null {
    const acc = new Float32Array(EMBED_DIM);
    let n = 0;
    for (const c of cluster) { if (!c.vec) continue; for (let i = 0; i < acc.length; i++) acc[i] += c.vec[i]; n++; }
    if (!n) return null;
    return unitInPlace(acc);
  }

  /** materialize assoc edges between the meaning-nearest members of a cluster. */
  private linkAssocByVec(cluster: MemNode[]): void {
    for (let i = 0; i < cluster.length; i++) {
      const a = cluster[i]; if (!a.vec) continue;
      for (let j = i + 1; j < cluster.length; j++) {
        const b = cluster[j]; if (!b.vec) continue;
        if (cosine(a.vec, b.vec) >= ASSOC_COS) { this.link(a.id, b.id, 'assoc', 0.5); this.link(b.id, a.id, 'assoc', 0.5); }
      }
    }
  }

  // ---- CONSOLIDATION / REFLECTION (off hot path; optional LLM) --------------
  /**
   * Replay: fuse clusters of similar episodics into a semantic gist. Runs during
   * "rest". If an LLM is supplied it writes the gist; otherwise a template does.
   * Fire-and-forget — never blocks the sim.
   */
  async consolidate(now: number, llm?: LLMClient | null): Promise<void> {
    if (this.consolidating) return;
    this.consolidating = true;
    try {
      const eps = [...this.map.values()].filter((n) => n.kind === 'episodic' && n.retrievability > RETR_FLOOR);
      const used = new Set<string>();
      for (const seed of eps) {
        if (used.has(seed.id)) continue;
        // cluster by MEANING (dense cosine) when vectors exist, else the lexical tier.
        const cluster = eps.filter((n) => !used.has(n.id) && this.memSim(seed, n) > (seed.vec && n.vec ? CONSOLIDATE_COS : 0.5));
        if (cluster.length < 3) continue;
        cluster.forEach((c) => used.add(c.id));
        const gist = await this.gist(cluster, llm);
        const sem = this.addNode('semantic', gist, mean(cluster.map((c) => c.valence)),
          0.3, Math.max(...cluster.map((c) => c.salience)), now);
        sem.encodingStrength = 2; sem.retrievability = 2;
        sem.recallCount = cluster.reduce((s, c) => s + c.recallCount, 0);
        // the gist's dense vector is the renormalized centroid of its members
        // (prototype theory) — so the gist is itself retrievable, and it becomes the
        // schema prototype that member reconsolidation drifts toward.
        const centroid = this.centroid(cluster);
        if (centroid) { sem.vec = centroid; sem.vec0 = centroid.slice(); }
        this.linkEntities(sem);
        for (const c of cluster) { this.link(c.id, sem.id, 'is_a', 0.8); c.retrievability *= 0.6; }
        // learned association: wire the meaning-nearest members together (assoc edges
        // discovered from embedding geometry, not just co-occurrence).
        this.linkAssocByVec(cluster);
      }
    } finally { this.consolidating = false; }
  }

  private async gist(cluster: MemNode[], llm?: LLMClient | null): Promise<string> {
    if (llm) {
      try {
        const txt = cluster.slice(0, 6).map((c) => '- ' + c.text).join('\n');
        const out = await llm.complete([
          { role: 'system', content: 'You compress episodic memories into ONE first-person semantic takeaway (a belief or pattern), <=18 words, no preamble.' },
          { role: 'user', content: `Memories:\n${txt}\n\nOne-sentence takeaway:` },
        ], { temperature: 0.5 });
        const line = out.replace(/^["'\s-]+/, '').split('\n')[0].trim();
        if (line) return line.length > 120 ? line.slice(0, 119) + '…' : line;
      } catch { /* fall through to template */ }
    }
    // template fallback: the most salient shared entity + tone
    const ent = this.topEntity(cluster);
    const tone = mean(cluster.map((c) => c.valence)) > 0.1 ? 'tends to go well'
      : mean(cluster.map((c) => c.valence)) < -0.1 ? 'tends to be hard' : 'is part of my days';
    return ent ? `${ent} ${tone}.` : `This kind of moment ${tone}.`;
  }

  /** Reflection: synthesize a higher-order schema from recent high-salience nodes. */
  async reflect(now: number, llm?: LLMClient | null): Promise<void> {
    const recent = [...this.map.values()]
      .filter((n) => n.kind === 'episodic' && n.salience > 0.5)
      .sort((a, b) => b.lastRecalledAt - a.lastRecalledAt).slice(0, 8);
    if (recent.length < 4) return;
    let text = '';
    if (llm) {
      try {
        const out = await llm.complete([
          { role: 'system', content: 'From these memories, state ONE higher-level insight about myself or my life, first person, <=16 words.' },
          { role: 'user', content: recent.map((r) => '- ' + r.text).join('\n') + '\n\nInsight:' },
        ], { temperature: 0.6 });
        text = out.replace(/^["'\s-]+/, '').split('\n')[0].trim();
      } catch { /* template below */ }
    }
    if (!text) {
      const v = mean(recent.map((r) => r.valence));
      text = v < -0.15 ? 'Lately everything asks more of me than I have.'
        : v > 0.15 ? 'Things have been quietly going better than I expect.'
        : 'I am getting through the days, one at a time.';
    }
    const s = this.addNode('schema', text, mean(recent.map((r) => r.valence)), 0.2, 0.8, now);
    s.encodingStrength = 2.4; s.retrievability = 2.4;
    const centroid = this.centroid(recent);
    if (centroid) { s.vec = centroid; s.vec0 = centroid.slice(); }
    for (const r of recent) this.link(s.id, r.id, 'is_a', 0.6);
  }

  // ---- accessors ------------------------------------------------------------
  recent(k = 5): MemoryItem[] {
    return [...this.map.values()]
      .filter((n) => n.kind === 'episodic')
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, k).map((n) => this.project(n));
  }

  /** a bounded snapshot of the graph for the live visualization. */
  view(limit = 60): MemGraphView {
    const nodes = [...this.map.values()]
      .map((n) => ({ n, rank: (this.activation.get(n.id) ?? 0) * 2 + n.retrievability + (n.kind !== 'episodic' ? 0.6 : 0) }))
      .sort((a, b) => b.rank - a.rank).slice(0, limit).map((x) => x.n);
    const keep = new Set(nodes.map((n) => n.id));
    const edges: MemGraphView['edges'] = [];
    for (const [a, arr] of this.out) {
      if (!keep.has(a)) continue;
      for (const e of arr) if (keep.has(e.to)) edges.push({ a, b: e.to, kind: e.kind, w: e.w });
    }
    return {
      nodes: nodes.map((n) => ({
        id: n.id, kind: n.kind, text: n.text, salience: n.salience, valence: n.valence,
        retr: Math.min(1, n.retrievability / 2.5), act: this.activation.get(n.id) ?? 0,
      })),
      edges,
    };
  }

  get size(): number { return this.map.size; }

  // ---- internals ------------------------------------------------------------
  private now(): number {
    let t = 0;
    for (const n of this.map.values()) if (n.lastRecalledAt > t) t = n.lastRecalledAt;
    return t;
  }

  private topEntity(cluster: MemNode[]): string | null {
    const counts = new Map<string, number>();
    for (const c of cluster) {
      for (const e of this.out.get(c.id) ?? []) {
        const n = this.map.get(e.to);
        if (n?.kind === 'entity') counts.set(n.text, (counts.get(n.text) ?? 0) + 1);
      }
    }
    let best: string | null = null, bc = 0;
    for (const [name, c] of counts) if (c > bc) { bc = c; best = name; }
    return best;
  }

  private prune(): void {
    const eps = [...this.map.values()].filter((n) => n.kind === 'episodic');
    if (eps.length <= MAX_EPISODIC) return;
    eps.sort((a, b) => a.retrievability - b.retrievability);
    const drop = eps.slice(0, eps.length - MAX_EPISODIC);
    for (const n of drop) {
      // keep a "cold" trace only if it was ever strongly encoded (availability),
      // otherwise remove entirely. Cold traces are demoted to inaccessible.
      if (n.encodingStrength > 2.5) { n.retrievability = RETR_FLOOR * 0.5; continue; }
      this.map.delete(n.id);
      this.out.delete(n.id);
      this.activation.delete(n.id);
    }
    // drop dangling edges lazily on next view()/retrieve (guarded by map.has)
  }

  private project(n: MemNode): MemoryItem {
    return { id: n.id, t: n.createdAt, text: n.text, salience: n.salience, valence: n.valence,
      decay: Math.min(1, n.retrievability / (1 + n.salience)) };
  }

  // ---- persistence ----------------------------------------------------------
  /** flatten to plain JSON: Set<string> tokens → space-joined; Maps → entries. */
  toJSON(): MemGraphJSON {
    const nodes: MemNodeJSON[] = [];
    for (const n of this.map.values()) {
      nodes.push({ id: n.id, kind: n.kind, text: n.text, tokens: [...n.tokens].join(' '),
        valence: n.valence, arousal: n.arousal, salience: n.salience,
        encodingStrength: n.encodingStrength, retrievability: n.retrievability,
        createdAt: n.createdAt, lastRecalledAt: n.lastRecalledAt, recallCount: n.recallCount,
        vec: n.vec ? Array.from(n.vec) : undefined, vec0: n.vec0 ? Array.from(n.vec0) : undefined });
    }
    const out: [string, MemEdge[]][] = [];
    for (const [a, arr] of this.out) out.push([a, arr.map((e) => ({ ...e }))]);
    return {
      nodes, out, entities: [...this.entityByName.entries()],
      activation: [...this.activation.entries()], lastEpisodic: this.lastEpisodic,
      ctx: Array.from(this.ctx),
    };
  }

  /** repopulate IN PLACE from JSON (ids preserved; module _seq restored separately). */
  loadJSON(j: MemGraphJSON): void {
    this.map.clear(); this.out.clear(); this.entityByName.clear(); this.activation.clear();
    this.consolidating = false;
    for (const n of j.nodes) {
      const tokens = new Set<string>(n.tokens ? n.tokens.split(' ').filter(Boolean) : []);
      const node: MemNode = {
        id: n.id, kind: n.kind, text: n.text, tokens,
        valence: n.valence, arousal: n.arousal, salience: n.salience,
        encodingStrength: n.encodingStrength, retrievability: n.retrievability,
        createdAt: n.createdAt, lastRecalledAt: n.lastRecalledAt, recallCount: n.recallCount,
        vec: n.vec ? Float32Array.from(n.vec) : undefined,
        vec0: n.vec0 ? Float32Array.from(n.vec0) : undefined,
      };
      this.map.set(n.id, node);
    }
    for (const [a, arr] of j.out) this.out.set(a, arr.map((e) => ({ ...e })));
    for (const [k, v] of j.entities) this.entityByName.set(k, v);
    for (const [k, v] of j.activation) this.activation.set(k, v);
    this.lastEpisodic = j.lastEpisodic;
    this.ctx = (j.ctx && j.ctx.length === EMBED_DIM) ? Float32Array.from(j.ctx) : new Float32Array(EMBED_DIM);
  }
}

interface MemNodeJSON {
  id: string; kind: NodeKind; text: string; tokens: string;
  valence: number; arousal: number; salience: number;
  encodingStrength: number; retrievability: number;
  createdAt: number; lastRecalledAt: number; recallCount: number;
  vec?: number[]; vec0?: number[];
}
export interface MemGraphJSON {
  nodes: MemNodeJSON[];
  out: [string, MemEdge[]][];
  entities: [string, string][];
  activation: [string, number][];
  lastEpisodic: string | null;
  ctx?: number[];
}

/** module id-counter accessors (for save/load reconciliation). */
export function getMemSeq(): number { return _seq; }
export function setMemSeq(n: number): void { _seq = n; }

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

/** L2-normalize a vector in place (unit vectors make cosine a plain dot product). */
function unitInPlace(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 1e-9) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
