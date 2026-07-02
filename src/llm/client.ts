// =============================================================================
// client.ts — swappable LLM backend. OllamaClient talks to a local model via the
// Vite proxy (/ollama → :11434). Swap this implementation for a remote API later;
// the rest of the app only depends on the LLMClient interface.
// =============================================================================
import type { LLMClient, ChatMessage, JsonSchema } from '../types';

export interface OllamaOpts { model?: string; baseUrl?: string; think?: boolean; numPredict?: number; }

export class OllamaClient implements LLMClient {
  readonly name: string;
  private baseUrl: string;
  private model: string;
  private think: boolean;
  private numPredict: number;

  constructor(opts: OllamaOpts = {}) {
    this.model = opts.model ?? 'qwen3:0.6b';
    this.baseUrl = opts.baseUrl ?? '/ollama';
    // thinking (CoT) is OFF by default so the tiny hot-path driver never stalls.
    // A reasoning model used off the hot path (consolidation) turns it on and gets
    // a bigger token budget so it has room to reason before answering.
    this.think = opts.think ?? false;
    this.numPredict = opts.numPredict ?? (this.think ? 1024 : 280);
    this.name = `ollama:${this.model}`;
  }

  async complete(
    messages: ChatMessage[],
    opts: { format?: 'json' | JsonSchema; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    // format may be the string "json" or a full JSON Schema (structured output).
    // With thinking ON, the schema keeps the ANSWER on-contract while the model
    // still reasons freely in its separate `thinking` field.
    const format = opts.format ?? undefined;
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: this.think, // false for the hot-path driver (Qwen3 would burn its budget "thinking")
        format,
        options: { temperature: opts.temperature ?? 0.6, num_predict: this.numPredict },
        messages,
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    return data?.message?.content ?? '';
  }
}

/** quick availability probe so the UI can show a clear message if Ollama is down */
export async function probeOllama(baseUrl = '/ollama'): Promise<boolean> {
  try { return (await fetch(`${baseUrl}/api/tags`)).ok; } catch { return false; }
}
