// =============================================================================
// companypanel.ts — a dashboard panel making the OFFICE's emergent life legible:
//   the boss's current company goal (a narrative that re-derives itself), the
//   theme priorities behind it, the teams grinding toward their subgoals with
//   emergent leaders and cohesion/tension, and the internal coordination net as
//   messages fly between them. Self-mounts into the dashboard aside, redraws
//   only when the picture actually changes, and never throws into the loop.
//
//   Self-contained: injects its own scoped <style> once (house palette CSS vars)
//   so it looks right even without the external stylesheet. Mirrors TownPanel.
// =============================================================================
import type {
  TownSnapshot,
  CompanySnapshot,
  GoalTheme,
  TeamState,
  NetMessage,
  NetMsgKind,
} from '../types';

const STYLE_ID = 'company-panel-style';

// kind → tag class (color-coding lives in the injected stylesheet)
const KIND_LABEL: Record<NetMsgKind, string> = {
  directive: 'DIRECT',
  propose: 'PROPOSE',
  report: 'REPORT',
  support: 'SUPPORT',
  question: 'ASK',
  block: 'BLOCK',
  ack: 'ACK',
};

export class CompanyPanel {
  private readonly body: HTMLElement;
  private cache = '';
  private lastVersion = -1;

  constructor(dashEl: HTMLElement) {
    injectStyleOnce();

    const panel = el('div', 'panel company-panel');
    panel.innerHTML = '<h2>The Company · goals that evolve</h2>';

    this.body = el('div', 'company-body');
    panel.appendChild(this.body);

    // sits at the foot of the dashboard aside — out of the brain/town panels' way
    dashEl.appendChild(panel);

    this.renderEmpty();
  }

  update(snap: TownSnapshot | undefined): void {
    try {
      const co = snap?.company;
      if (!co) {
        if (this.cache !== '∅') {
          this.cache = '∅';
          this.renderEmpty();
        }
        return;
      }

      const sig = signature(co);
      if (sig === this.cache) return;
      this.cache = sig;

      const bumped = co.goal.version > this.lastVersion && this.lastVersion >= 0;
      this.lastVersion = co.goal.version;

      this.body.textContent = '';
      this.body.appendChild(this.buildGoal(co, bumped));
      this.body.appendChild(subHead('Teams'));
      this.body.appendChild(this.buildTeams(co.teams));
      this.body.appendChild(subHead('Internal net'));
      this.body.appendChild(this.buildFeed(co.feed));
    } catch {
      // the dashboard must never throw into the render loop
    }
  }

  // -- goal block ----------------------------------------------------------
  private buildGoal(co: CompanySnapshot, bumped: boolean): HTMLElement {
    const wrap = el('div', 'company-goal');

    const head = el('div', 'company-goal-head');
    const boss = el('span', 'company-boss');
    boss.textContent = `${co.bossName || 'the boss'} · goal`;
    const rev = el('span', 'company-rev');
    if (bumped) rev.classList.add('bumped');
    rev.textContent = `rev ${co.goal.version}`;
    head.append(boss, rev);
    wrap.appendChild(head);

    const narr = el('div', 'company-narr');
    narr.textContent = co.goal.narrative || '(no direction yet)';
    wrap.appendChild(narr);

    const replan = el('div', 'company-replan');
    const h = Math.max(0, co.planCountdown);
    replan.textContent = `re-plans in ~${h < 1 ? h.toFixed(1) : Math.round(h)}h`;
    wrap.appendChild(replan);

    const themes = el('div', 'company-themes');
    const sorted = [...(co.goal.themes || [])].sort((a, b) => b.priority - a.priority);
    if (!sorted.length) {
      const e = el('div', 'company-empty');
      e.textContent = '— no themes —';
      themes.appendChild(e);
    }
    for (const t of sorted.slice(0, 6)) themes.appendChild(themeRow(t));
    wrap.appendChild(themes);

    return wrap;
  }

  // -- teams block ---------------------------------------------------------
  private buildTeams(teams: TeamState[]): HTMLElement {
    const wrap = el('div', 'company-teams');
    if (!teams || !teams.length) {
      const e = el('div', 'company-empty');
      e.textContent = '— no teams formed —';
      wrap.appendChild(e);
      return wrap;
    }
    for (const t of teams) wrap.appendChild(teamRow(t));
    return wrap;
  }

  // -- net feed block ------------------------------------------------------
  private buildFeed(feed: NetMessage[]): HTMLElement {
    const wrap = el('div', 'company-feed');
    const msgs = (feed || []).slice(0, 8);
    if (!msgs.length) {
      const e = el('div', 'company-empty');
      e.textContent = '— net is silent —';
      wrap.appendChild(e);
      return wrap;
    }
    for (const m of msgs) wrap.appendChild(msgRow(m));
    return wrap;
  }

  private renderEmpty(): void {
    this.body.textContent = '';
    const e = el('div', 'company-empty');
    e.textContent = '— the office is quiet —';
    this.body.appendChild(e);
  }
}

// ---------------------------------------------------------------------------
// row builders
// ---------------------------------------------------------------------------
function themeRow(t: GoalTheme): HTMLElement {
  const row = el('div', 'company-theme');
  const lab = el('span', 'company-theme-l');
  lab.textContent = t.topic || '—';
  lab.title = t.topic || '';
  const track = el('div', 'company-bar');
  const fill = el('div', 'company-bar-f');
  fill.style.width = `${Math.round(clamp01(t.priority) * 100)}%`;
  track.appendChild(fill);
  row.append(lab, track);
  return row;
}

function teamRow(t: TeamState): HTMLElement {
  const wrap = el('div', 'company-team');

  const head = el('div', 'company-team-head');
  const name = el('span', 'company-team-n');
  name.textContent = t.name || `team ${t.id}`;
  head.appendChild(name);

  if (t.leaderId) {
    const lead = el('span', 'company-leader');
    lead.textContent = `★ ${shortId(t.leaderId)}`;
    head.appendChild(lead);
  }

  const chip = el('span', 'company-chip');
  const tense = (t.tension ?? 0) > 0.5 || (t.tension ?? 0) >= (t.cohesion ?? 0);
  if (tense) chip.classList.add('tense');
  chip.textContent = tense
    ? `tension ${pct(t.tension)}`
    : `cohesion ${pct(t.cohesion)}`;
  head.appendChild(chip);
  wrap.appendChild(head);

  // subgoal progress (--good fill) with a thin momentum tick overlaid
  const prog = el('div', 'company-prog');
  const fill = el('div', 'company-prog-f');
  fill.style.width = `${Math.round(clamp01(t.subgoal?.progress ?? 0) * 100)}%`;
  const tick = el('div', 'company-mom');
  tick.style.left = `${Math.round(clamp01(t.subgoal?.momentum ?? 0) * 100)}%`;
  tick.title = `momentum ${pct(t.subgoal?.momentum ?? 0)}`;
  prog.append(fill, tick);
  wrap.appendChild(prog);

  const topic = el('div', 'company-team-topic');
  topic.textContent = t.subgoal?.topic || '(no subgoal)';
  topic.title = t.subgoal?.topic || '';
  wrap.appendChild(topic);

  return wrap;
}

function msgRow(m: NetMessage): HTMLElement {
  const row = el('div', 'company-msg');
  if (m.team === -1) row.classList.add('cross'); // boss / cross-team

  const tag = el('span', `company-tag company-tag--${m.kind}`);
  tag.textContent = KIND_LABEL[m.kind] ?? String(m.kind).toUpperCase();

  const from = el('span', 'company-from');
  from.textContent = truncate(m.fromName || '—', 10);

  const txt = el('span', 'company-txt');
  txt.textContent = truncate(m.text || '', 64);
  txt.title = m.text || '';

  row.append(tag, from, txt);
  return row;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function signature(co: CompanySnapshot): string {
  const g = co.goal;
  const themes = (g.themes || [])
    .map((t) => `${t.topic}:${t.priority.toFixed(2)}`)
    .join(',');
  const teams = (co.teams || [])
    .map(
      (t) =>
        `${t.id}|${(t.subgoal?.progress ?? 0).toFixed(2)}|${(t.subgoal?.momentum ?? 0).toFixed(2)}|${t.subgoal?.topic ?? ''}|${t.leaderId ?? ''}|${(t.cohesion ?? 0).toFixed(2)}|${(t.tension ?? 0).toFixed(2)}`,
    )
    .join(';');
  const feed = (co.feed || []).slice(0, 8).map((m) => m.id).join(',');
  return `v${g.version}~${g.narrative}~${co.bossName}~${Math.round(co.planCountdown * 10)}~${themes}~${teams}~${feed}`;
}

function subHead(text: string): HTMLElement {
  const e = el('div', 'company-sub');
  e.textContent = text;
  return e;
}

function shortId(id?: string): string {
  if (!id) return '—';
  const stripped = id.replace(/^agent-/i, '');
  const parts = stripped.split(/[-_:./]/).filter(Boolean);
  const token = parts.length ? parts[parts.length - 1] : stripped;
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : '—';
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

function pct(v: number): string {
  return `${Math.round(clamp01(v) * 100)}`;
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

// ---------------------------------------------------------------------------
// scoped stylesheet — injected exactly once, keyed on CSS custom props so it
// matches the .town-* idiom (ink on aged sepia) even with no external CSS.
// ---------------------------------------------------------------------------
function injectStyleOnce(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.company-body { display: flex; flex-direction: column; }
.company-empty { font-size: 11px; color: var(--ink-faint); font-style: italic; }

/* -- goal -- */
.company-goal { margin-bottom: 4px; }
.company-goal-head { display: flex; align-items: baseline; gap: 6px; }
.company-boss { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); flex: 1; }
.company-rev {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em;
  color: var(--paper); background: var(--ink-soft); padding: 0 4px; border-radius: 2px;
  font-variant-numeric: tabular-nums;
}
.company-rev.bumped { background: var(--good); }
.company-narr {
  font-family: var(--serif); font-style: italic; font-size: 14px; color: var(--ink);
  margin: 3px 0 3px; line-height: 1.35;
}
.company-replan { font-size: 10px; color: var(--ink-faint); letter-spacing: 0.06em; margin-bottom: 6px; }

.company-themes { display: flex; flex-direction: column; gap: 3px; }
.company-theme { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--ink-soft); }
.company-theme-l { width: 92px; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.company-bar { flex: 1; height: 6px; background: var(--line-faint); }
.company-bar-f { height: 100%; background: var(--ink-soft); width: 0%; transition: width 0.3s; }

/* -- shared sub-header (mirrors .town-sub) -- */
.company-sub {
  font-size: 10px; font-weight: 600; letter-spacing: 0.28em; text-transform: uppercase;
  color: var(--ink-soft); margin: 10px 0 4px;
}

/* -- teams -- */
.company-teams { display: flex; flex-direction: column; gap: 6px; }
.company-team { display: flex; flex-direction: column; gap: 2px; }
.company-team-head { display: flex; align-items: baseline; gap: 6px; }
.company-team-n { font-size: 11px; color: var(--ink); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.company-leader { font-size: 9px; color: var(--good); letter-spacing: 0.04em; flex-shrink: 0; }
.company-chip {
  font-size: 8.5px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0 4px; border: 1px solid var(--line-faint); border-radius: 2px;
  color: var(--good); flex-shrink: 0; font-variant-numeric: tabular-nums;
}
.company-chip.tense { color: var(--accent); border-color: rgba(122, 31, 18, 0.5); }
.company-prog { position: relative; height: 6px; background: var(--line-faint); }
.company-prog-f { height: 100%; background: var(--good); width: 0%; transition: width 0.3s; }
.company-mom { position: absolute; top: -1px; width: 1.5px; height: 8px; background: var(--ink); opacity: 0.75; }
.company-team-topic {
  font-size: 9.5px; color: var(--ink-faint); letter-spacing: 0.04em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* -- internal net feed -- */
.company-feed {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 150px; overflow-y: auto; margin-top: 2px;
}
.company-feed::-webkit-scrollbar { width: 8px; }
.company-feed::-webkit-scrollbar-thumb { background: var(--line-faint); }
.company-msg { display: flex; gap: 6px; align-items: baseline; font-size: 10px; line-height: 1.35; }
.company-msg.cross {
  padding-left: 4px; border-left: 2px solid var(--accent);
  background: rgba(122, 31, 18, 0.05);
}
.company-tag {
  flex-shrink: 0; width: 48px; font-size: 8px; letter-spacing: 0.06em; text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}
.company-from { flex-shrink: 0; color: var(--ink); max-width: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.company-txt { color: var(--ink-soft); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* kind colors — the 7 NetMsgKind */
.company-tag--directive { color: var(--ink); font-weight: 700; }
.company-tag--report    { color: var(--good); }
.company-tag--support   { color: var(--good); opacity: 0.6; }
.company-tag--propose   { color: var(--accent); opacity: 0.85; }
.company-tag--question  { color: var(--ink-soft); }
.company-tag--block     { color: var(--accent); font-weight: 700; }
.company-tag--ack       { color: var(--ink-faint); }
`;
  document.head.appendChild(style);
}
