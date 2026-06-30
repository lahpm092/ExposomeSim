// =============================================================================
// main.ts — bootstrap & the render/sim loop.
//   substrate + world  → World.update(dt)  (always runs)
//   visualization      → Stage.update(snapshot)  (three.js)
//   instrument readout → Dashboard.update(snapshot)  (canvas panels)
// =============================================================================
import { World } from './sim/world';
import { OllamaClient, probeOllama } from './llm/client';
import { Stage } from './render/stage';
import { BrainPanel } from './render/brain';
import { Dashboard } from './ui/dashboard';
import type { WorldSnapshot } from './types';

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
  const llm = online ? new OllamaClient({ model: 'qwen3:0.6b' }) : null;
  if (!online) {
    captionEl.innerHTML =
      '<span class="who">system</span>Ollama not reachable — running on the soma-derived fallback driver. ' +
      'Start it with <code>ollama serve</code> and reload to put the LLM in the loop.';
  }

  const world = new World({ llm, startHour: 11, speed: 0.05 });
  const stage = new Stage(canvas);
  const dashboard = new Dashboard(dashEl);
  const brain = new BrainPanel(dashEl, document.getElementById('titlebar')!);

  addEventListener('resize', () => { stage.resize(); brain.resize(); });
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); world.togglePause(); }
    else if (e.key === '+' || e.key === '=') world.setSpeed(Math.min(0.4, world.speed * 1.5));
    else if (e.key === '-') world.setSpeed(Math.max(0.01, world.speed / 1.5));
    else if (e.key === 'ArrowUp') { e.preventDefault(); brain.selectPrev(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); brain.selectNext(); }
  });

  let last = performance.now();
  function frame(now: number) {
    const dtReal = Math.min(0.05, (now - last) / 1000); // clamp tab-switch jumps
    last = now;

    world.update(dtReal);
    const snap = world.snapshot();
    stage.update(snap, dtReal);
    dashboard.update(snap);
    brain.update(snap, dtReal);

    clockEl.textContent = fmtClock(snap.time);
    renderCaption(snap);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderCaption(snap: WorldSnapshot) {
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
