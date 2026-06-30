import { defineConfig } from 'vite';

// The harness runs client-side. The only thing we proxy is the LLM backend:
//   - local dev: Ollama on :11434  (POST /ollama/api/chat)
//   - later: swap LLMClient implementation to hit a remote API instead.
export default defineConfig({
  server: {
    proxy: {
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ''),
      },
    },
  },
});
