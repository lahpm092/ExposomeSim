// =============================================================================
// embed.ts — dense text embeddings for the memory graph (Memory v3).
// -----------------------------------------------------------------------------
// A self-configuring singleton that turns memory text into unit-norm vectors so
// the graph can retrieve by MEANING, not just shared tokens. Design constraints
// (see MEMORY_V3_DESIGN.md, grounded in MEMORY_RESEARCH_REPORT.md):
//
//   · NEVER awaited on the hot path. `cached(text)` returns a vector synchronously
//     when we already have it, else null (and quietly enqueues it). Misses are
//     computed in BATCHES off the tick via `flush()`.
//   · Ollama `nomic-embed-text` over the existing /ollama proxy; vectors are
//     truncated to 256-d (Matryoshka) and L2-normalized at store time, so cosine
//     is a plain dot product.
//   · Degrade gracefully: if Ollama is unreachable (e.g. headless Node, or it's
//     just down), fall back to a DETERMINISTIC hashed bag-of-words vector — still
//     256-d and unit-norm — so the dense tier keeps working (weaker) and stays
//     reproducible. The graph's lexical token-overlap tier is always on regardless.
// =============================================================================

/** stored/most-used embedding dimensionality (nomic 768 → first 256, renormed). */
export const EMBED_DIM = 256;

export interface EmbedOpts {
  baseUrl?: string;   // default '/ollama'
  model?: string;     // default 'nomic-embed-text'
  dim?: number;       // default EMBED_DIM
  numCtx?: number;    // Ollama num_ctx (nomic defaults to 2K — fine for short mems)
  batch?: number;     // max texts per network call
}

const STOP = new Set(('a an the you your i my me we it is are was were be to of and or but in on at ' +
  'for with as by that this these those he she they them his her not no yes do did done so if then ' +
  'from up down out over under again once here there what who how when why all any some one two').split(' '));

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z']{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** FNV-1a → uint32 */
function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** in-place L2 normalize; leaves an all-zero vector alone. */
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 1e-9) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** cosine similarity of two UNIT vectors == dot product. Guards length/degenerate. */
export function cosine(a: Float32Array | undefined, b: Float32Array | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export class Embedder {
  readonly dim: number;
  private baseUrl: string;
  private model: string;
  private numCtx: number;
  private batch: number;

  private cache = new Map<string, Float32Array>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private flushing = false;

  // network health: avoid hammering a dead endpoint from a 60fps loop.
  private net: 'unknown' | 'up' | 'down' = 'unknown';
  private fails = 0;
  private downUntil = 0;   // wall-free logical gate: re-probe after some flushes
  private flushTicks = 0;

  constructor(opts: EmbedOpts = {}) {
    this.dim = opts.dim ?? EMBED_DIM;
    this.baseUrl = opts.baseUrl ?? '/ollama';
    this.model = opts.model ?? 'nomic-embed-text';
    this.numCtx = opts.numCtx ?? 2048;
    this.batch = opts.batch ?? 24;
  }

  /** SYNC accessor for the hot path: a cached vector, or null (miss → enqueued). */
  cached(text: string): Float32Array | null {
    const key = norm(text);
    const hit = this.cache.get(key);
    if (hit) return hit;
    this.enqueue(text);
    return null;
  }

  enqueue(text: string): void {
    const key = norm(text);
    if (this.cache.has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
    if (this.queue.length > 4000) { const drop = this.queue.shift()!; this.queued.delete(drop); } // safety cap
  }

  get pending(): number { return this.queue.length; }

  /**
   * Drain up to one batch from the queue, filling the cache. Safe to call every
   * tick (it self-throttles + no-ops when idle). Fire-and-forget; never throws.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    this.flushTicks++;
    const take = this.queue.splice(0, this.batch);

    let vated = false;
    const useNet = this.net !== 'down' || this.flushTicks >= this.downUntil;
    if (useNet) {
      try {
        const vecs = await this.remote(take);
        for (let i = 0; i < take.length; i++) this.store(take[i], vecs[i]);
        this.net = 'up'; this.fails = 0;
        vated = true;
      } catch {
        this.fails++;
        if (this.fails >= 2) { this.net = 'down'; this.downUntil = this.flushTicks + 400; } // back off ~400 flushes
      }
    }
    if (!vated) {
      // fallback: deterministic hashed embeddings so the dense tier still works.
      for (const t of take) this.store(t, this.fallback(t));
    }
    for (const t of take) this.queued.delete(t);
    this.flushing = false;
  }

  /** For offline/awaitable paths (e.g. tests): resolve a vector now (may use fallback). */
  async embedNow(text: string): Promise<Float32Array> {
    const key = norm(text);
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.net !== 'down') {
      try { const [v] = await this.remote([key]); this.store(key, v); this.net = 'up'; this.fails = 0; return this.cache.get(key)!; }
      catch { this.fails++; if (this.fails >= 2) this.net = 'down'; }
    }
    const fb = this.fallback(key); this.store(key, fb); return fb;
  }

  // ---- internals ------------------------------------------------------------
  private store(key: string, vec: Float32Array): void {
    this.cache.set(key, vec);
    if (this.cache.size > 20000) { const first = this.cache.keys().next().value; if (first) this.cache.delete(first); }
  }

  /** POST a batch to Ollama /api/embed; truncate each to `dim` and renormalize. */
  private async remote(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, options: { num_ctx: this.numCtx } }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}`);
    const data = await res.json();
    const rows: number[][] = data?.embeddings ?? (data?.embedding ? [data.embedding] : []);
    if (!rows.length || !Array.isArray(rows[0])) throw new Error('embed: no vectors');
    return rows.map((r) => {
      const v = new Float32Array(this.dim);
      const n = Math.min(this.dim, r.length);
      for (let i = 0; i < n; i++) v[i] = r[i];
      return normalize(v);
    });
  }

  /** deterministic hashed bag-of-words vector (signed random projection). */
  private fallback(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const toks = tokenize(text);
    if (!toks.length) { v[hash32(text) % this.dim] = 1; return v; }
    for (const t of toks) {
      const h = hash32(t);
      v[h % this.dim] += (h & 0x10000) ? 1 : -1;
      const h2 = hash32(t + '');
      v[h2 % this.dim] += ((h2 & 0x10000) ? 1 : -1) * 0.7;
    }
    return normalize(v);
  }

  toJSON(): { cache: [string, number[]][] } {
    // persist only a bounded slice of the cache (vectors re-embed lazily anyway).
    const out: [string, number[]][] = [];
    let i = 0;
    for (const [k, v] of this.cache) { out.push([k, Array.from(v)]); if (++i >= 4000) break; }
    return { cache: out };
  }
  loadJSON(j: { cache?: [string, number[]][] } | null | undefined): void {
    if (!j?.cache) return;
    for (const [k, arr] of j.cache) this.cache.set(k, Float32Array.from(arr));
  }
}

function norm(text: string): string { return text.trim().toLowerCase(); }

// ---- singleton --------------------------------------------------------------
let _embedder: Embedder | null = null;
export function getEmbedder(): Embedder { return (_embedder ??= new Embedder()); }
export function configureEmbedder(opts: EmbedOpts): Embedder { return (_embedder = new Embedder(opts)); }
