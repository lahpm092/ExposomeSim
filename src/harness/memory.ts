// =============================================================================
// memory.ts — an affect-gated episodic memory stream (Generative-Agents-style).
// Encoding strength is gated by arousal × stress (amygdala modulation of
// hippocampal consolidation): emotionally charged events stick.
// =============================================================================
import type { MemoryItem, SomaState } from '../types';

let _seq = 0;
const uid = () => `m${(_seq++).toString(36)}`;

const tokens = (s: string) => s.toLowerCase().match(/[a-z']+/g) ?? [];

export class MemoryStream {
  items: MemoryItem[] = [];

  /** seed durable formative memories (from the experiosome) */
  seed(texts: string[], t = 0): void {
    for (const text of texts) {
      this.items.push({ id: uid(), t, text, salience: 0.85, valence: 0, decay: 1 });
    }
  }

  /** encode an event; salience gated by current arousal & stress */
  add(t: number, text: string, soma: SomaState): MemoryItem {
    const salience = Math.min(1,
      0.2 + 0.5 * soma.arousal + 0.3 * Math.max(0, soma.cortisol - 1) +
      0.3 * Math.abs(soma.valence) + 0.2 * soma.amygdala,
    );
    const item: MemoryItem = { id: uid(), t, text, salience, valence: soma.valence, decay: 1 };
    this.items.push(item);
    if (this.items.length > 200) this.items.splice(0, this.items.length - 200);
    return item;
  }

  /** forgetting curve — salient memories decay slower */
  decayAll(dtHours: number): void {
    for (const it of this.items) {
      const rate = 0.06 * (1 - 0.6 * it.salience);
      it.decay *= Math.exp(-rate * dtHours);
    }
  }

  recent(k = 5): MemoryItem[] {
    return this.items.slice(-k).reverse();
  }

  /** retrieve by recency×salience×relevance (cheap keyword overlap) */
  retrieve(query: string, k = 4): MemoryItem[] {
    const q = new Set(tokens(query));
    return [...this.items]
      .map((it) => {
        const overlap = tokens(it.text).filter((w) => q.has(w)).length;
        const score = it.decay * (0.6 + 0.4 * it.salience) + 0.5 * overlap;
        return { it, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.it);
  }
}
