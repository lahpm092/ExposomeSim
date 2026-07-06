// =============================================================================
// main.ts — bootstrap & the render/sim loop.
//   substrate + world  → World.update(dt)  (always runs)
//   visualization      → Stage.update(snapshot)  (three.js)
//   instrument readout → Dashboard.update(snapshot)  (canvas panels)
// =============================================================================
import { SimSession } from './sim/session';
import { OllamaClient, probeOllama } from './llm/client';
import { CityStage } from './render/citystage';
import { BrainPanel } from './render/brain';
import { CityView } from './render/cityview';
import { PsychePanel } from './render/psycheviz';
import { MemoryPanel } from './render/memoryviz';
import { SkyClock } from './render/skyclock';
import { TownPanel } from './ui/townpanel';
import { Dashboard } from './ui/dashboard';
import { SocialFeedPanel } from './ui/socialfeed';
import { CompanyPanel } from './ui/companypanel';
import { EconomyPanel } from './ui/econpanel';
import { BranchBar } from './ui/branchbar';
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
  // Driver: the smallest Qwen3 (0.6B) with thinking OFF — cheap and fast per beat,
  // so the sim can afford many more agents in the loop. The structured-output
  // schema keeps even this tiny model's answer on-contract.
  const llm = online ? new OllamaClient({ model: 'qwen3:0.6b', think: false }) : null;
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
  const session = new SimSession({ llm, consolidator, startHour: 7.5, speed: 0.02 });
  const stage = new CityStage(canvas);
  // dev-only: expose the stage so headless screenshots can park the free camera
  // at fixed vantage points (scale-verification — follow-zoom would hide it).
  // (import.meta.env is a Vite injection; typed inline since tsconfig pins `types`.)
  if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) {
    (window as unknown as { __stage: CityStage }).__stage = stage;
  }
  const dashboard = new Dashboard(dashEl);
  const branchBar = new BranchBar(dashEl, session);
  const townPanel = new TownPanel(dashEl);
  const companyPanel = new CompanyPanel(dashEl);
  const econPanel = new EconomyPanel({ mount: dashEl });
  const socialFeed = new SocialFeedPanel(dashEl);
  const brain = new BrainPanel(dashEl, titlebar);
  const city = new CityView(stageEl, titlebar);
  const psyche = new PsychePanel(stageEl, titlebar);
  const memory = new MemoryPanel(stageEl, titlebar);
  const skyclock = new SkyClock(stageEl, titlebar);

  addEventListener('resize', () => { stage.resize(); brain.resize(); city.resize(); psyche.resize(); memory.resize(); skyclock.resize(); });
  addEventListener('keydown', (e) => {
    const town = session.town;
    if (e.code === 'Space') { e.preventDefault(); town.togglePause(); }
    else if (e.key === '+' || e.key === '=') town.setSpeed(Math.min(0.6, town.speed * 1.5));
    else if (e.key === '-') town.setSpeed(Math.max(0.002, town.speed / 1.5));
    else if (e.key === 'c' || e.key === 'C') city.toggle();
    else if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); session.save(); branchBar.render(true); }
    else if (e.key === 'b' || e.key === 'B') { session.branch(); branchBar.render(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); brain.selectPrev(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); brain.selectNext(); }
  });

  function tick(dtReal: number) {
    const town = session.town;           // read fresh: load/restart/jump hot-swaps it
    town.update(dtReal);
    town.setFocus(stage.focusIndex);     // the camera's followed agent drives the inspectors
    const snap = town.snapshot();
    stage.update(snap, dtReal);
    dashboard.update(snap);
    townPanel.update(snap);
    companyPanel.update(snap);
    econPanel.update(snap);
    socialFeed.update(snap);
    brain.update(snap, dtReal);
    city.update(snap, dtReal);
    psyche.update(snap, dtReal);
    memory.update(snap, dtReal);
    skyclock.update(snap);
    branchBar.render();
    session.autosaveTick(dtReal);
    clockEl.textContent = fmtClock(snap.time);
    renderCaption(snap);
  }

  // debug/verification hook: drive the whole frame loop deterministically even
  // when the tab is backgrounded (requestAnimationFrame is throttled while hidden).
  const dbg: any = { session, stage, brain, psyche, memory, skyclock, branchBar, tick };
  Object.defineProperty(dbg, 'town', { get: () => session.town });
  (window as any).__dbg = dbg;

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
  const a: any = snap.agents?.[snap.focus ?? 0] ?? snap.cashier;
  const r = a.lastResponse;
  const name = a.profile.name.toUpperCase();
  // the focused agent's role + what it's doing right now
  const doing = a.mode ? String(a.mode).replace(/_/g, ' ') : (r ? r.action.replace(/_/g, ' ') : '');
  // an emergent conversation line wins the caption; else the driver's last speech.
  const speech = (a.saying ?? r?.speech ?? '').trim();
  const ev = (snap.focus ?? 0) === 0 ? (snap.currentEvent?.description ?? '') : '';
  if (!r && !speech) return;
  captionEl.innerHTML =
    `<span class="who">${name}${doing ? ' · ' + doing : ''}</span>` +
    (ev ? `<em style="color:var(--ink-soft)">${escapeHtml(ev)}</em><br>` : '') +
    (speech ? `“${escapeHtml(speech)}”` : '');
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

boot();
