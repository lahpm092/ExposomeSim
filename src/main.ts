// =============================================================================
// main.ts — bootstrap & the render/sim loop.
//   substrate + world  → World.update(dt)  (always runs)
//   visualization      → Stage.update(snapshot)  (three.js)
//   instrument readout → Dashboard.update(snapshot)  (canvas panels)
// =============================================================================
import { Town } from './sim/town';
import { OllamaClient, probeOllama } from './llm/client';
import { CityStage } from './render/citystage';
import { BrainPanel } from './render/brain';
import { CityView } from './render/cityview';
import { PsychePanel } from './render/psycheviz';
import { MemoryPanel } from './render/memoryviz';
import { TownPanel } from './ui/townpanel';
import { Dashboard } from './ui/dashboard';
import type { TownSnapshot } from './types';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const dashEl = document.getElementById('dashboard') as HTMLElement;
const captionEl = document.getElementById('caption') as HTMLElement;
const clockEl = document.getElementById('clock') as HTMLElement;

const fmtClock = (t: number) => {
  const h = Math.floor(((t % 24) + 24) % 24);
  const m = Math.floor((t - Math.floor(t)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

async function boot() {
  const online = await probeOllama();
  // Deliberate driver: 1.7B with CoT thinking ON. Every beat, Mara reasons about
  // the other mind and plays the consequences forward before committing — the
  // schema (structured output) keeps her answer on-contract despite the free
  // reasoning. Slower per beat (~10s), so the sim clock is slowed to match.
  const llm = online ? new OllamaClient({ model: 'qwen3:1.7b', think: true }) : null;
  // same reasoner does off-hot-path memory consolidation/reflection during rest.
  const consolidator = llm;
  if (!online) {
    captionEl.innerHTML =
      '<span class="who">system</span>Ollama not reachable — running on the soma-derived fallback driver. ' +
      'Start it with <code>ollama serve</code> and reload to put the LLM in the loop.';
  }

  const titlebar = document.getElementById('titlebar')!;
  const stageEl = document.getElementById('stage')!;
  // clock: 0.02 sim-h per real-second — lively enough that the quiet morning-at-home
  // doesn't read as "stuck" (she bathes in ~30s, reaches the café in ~2 min), while a
  // ~10s thought still only drifts ~12 sim-minutes so the event stays reasonably fresh.
  // Use '-' to slow toward the old faithful 0.005 pace; '+' to speed up.
  const town = new Town({ llm, consolidator, startHour: 7.5, speed: 0.02 });
  const stage = new CityStage(canvas);
  const dashboard = new Dashboard(dashEl);
  const townPanel = new TownPanel(dashEl);
  const brain = new BrainPanel(dashEl, titlebar);
  const city = new CityView(stageEl, titlebar);
  const psyche = new PsychePanel(stageEl, titlebar);
  const memory = new MemoryPanel(stageEl, titlebar);

  addEventListener('resize', () => { stage.resize(); brain.resize(); city.resize(); psyche.resize(); memory.resize(); });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); town.togglePause(); }
    else if (e.key === '+' || e.key === '=') town.setSpeed(Math.min(0.6, town.speed * 1.5));
    else if (e.key === '-') town.setSpeed(Math.max(0.002, town.speed / 1.5));
    else if (e.key === 'c' || e.key === 'C') city.toggle();
    else if (e.key === 'ArrowUp') { e.preventDefault(); brain.selectPrev(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); brain.selectNext(); }
  });

  function tick(dtReal: number) {
    town.update(dtReal);
    const snap = town.snapshot();
    stage.update(snap, dtReal);
    dashboard.update(snap);
    townPanel.update(snap);
    brain.update(snap, dtReal);
    city.update(snap, dtReal);
    psyche.update(snap, dtReal);
    memory.update(snap, dtReal);
    clockEl.textContent = fmtClock(snap.time);
    renderCaption(snap);
  }

  // debug/verification hook: drive the whole frame loop deterministically even
  // when the tab is backgrounded (requestAnimationFrame is throttled while hidden).
  (window as any).__dbg = { town, stage, brain, psyche, memory, tick };

  let last = performance.now();
  function frame(now: number) {
    const dtReal = Math.min(0.05, (now - last) / 1000); // clamp tab-switch jumps
    last = now;
    tick(dtReal);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderCaption(snap: TownSnapshot) {
  const r = snap.cashier.lastResponse;
  const name = snap.cashier.profile.name.toUpperCase();
  const ev = snap.currentEvent?.description ?? '';
  if (!r) return;
  captionEl.innerHTML =
    `<span class="who">${name} · ${r.action.replace(/_/g, ' ')}</span>` +
    (ev ? `<em style="color:var(--ink-soft)">${escapeHtml(ev)}</em><br>` : '') +
    `“${escapeHtml(r.speech)}”`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

boot();
