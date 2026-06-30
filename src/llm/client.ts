// =============================================================================
// client.ts — swappable LLM backend. OllamaClient talks to a local model via the
// Vite proxy (/ollama → :11434). Swap this implementation for a remote API later;
// the rest of the app only depends on the LLMClient interface.
// =============================================================================
import type { LLMClient, ChatMessage } from '../types';

export interface OllamaOpts { model?: string; baseUrl?: string; }

export class OllamaClient implements LLMClient {
  readonly name: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: OllamaOpts = {}) {
    this.model = opts.model ?? 'qwen3:0.6b';
    this.baseUrl = opts.baseUrl ?? '/ollama';
    this.name = `ollama:${this.model}`;
  }

  async complete(
    messages: ChatMessage[],
    opts: { format?: 'json'; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false, // critical for Qwen3: otherwise it spends the budget "thinking"
        format: opts.format === 'json' ? 'json' : undefined,
        options: { temperature: opts.temperature ?? 0.6, num_predict: 280 },
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
