// =============================================================================
// socialfeed.ts — a live X/Twitter-like feed panel for the dashboard. It makes
// the emergent public social network legible: who posted, what's on their mind,
// who replied and how warmly. WHAT is posted emerges from each author's soma +
// a salient memory + interests; WHO engages emerges from interest overlap + the
// relationship ledger (see sim/feed.ts). This panel is a pure READ of that.
//
// Self-contained: it self-mounts into the dashboard aside like TownPanel, and
// injects its own scoped <style> once (using the house palette CSS vars) so it
// looks right even before any external CSS exists. It only re-renders when the
// visible content actually changes, so it never clobbers scroll/selection.
// =============================================================================
import type { TownSnapshot, FeedView, FeedPost, FeedComment } from '../types';

const MAX_POSTS = 8;    // most-recent posts shown as threads
const MAX_COMMENTS = 3; // replies shown under each post

export class SocialFeedPanel {
  private readonly sub: HTMLElement;
  private readonly list: HTMLElement;
  private cache = '';

  constructor(dashEl: HTMLElement) {
    injectStyleOnce();

    const panel = document.createElement('div');
    panel.className = 'panel feed-panel';
    panel.innerHTML = "<h2>The Feed · what's on their mind</h2>";

    this.sub = el('div', 'feed-sub');
    this.sub.textContent = '— quiet so far —';
    panel.appendChild(this.sub);

    this.list = el('div', 'feed-list');
    panel.appendChild(this.list);

    // append into the dashboard aside (main.ts wires ordering)
    dashEl.appendChild(panel);
  }

  update(snap: TownSnapshot): void {
    try {
      const feed: FeedView | undefined = snap?.feed;
      const posts = (feed?.posts ?? []).slice(0, MAX_POSTS);
      const total = feed?.postCount ?? 0;

      // subtitle: cheap text-only update every frame (never clobbers scroll)
      this.sub.textContent = total > 0
        ? `${total} post${total === 1 ? '' : 's'} · ${posts.length} shown`
        : '— quiet so far —';

      // signature of the VISIBLE content — only rebuild the list when it changes
      const sig = feedSignature(total, posts);
      if (sig === this.cache) return;
      this.cache = sig;

      this.list.innerHTML = '';
      if (!posts.length) {
        const empty = el('div', 'feed-empty');
        empty.textContent = '— quiet so far —';
        this.list.appendChild(empty);
        return;
      }

      for (const post of posts) this.list.appendChild(renderPost(post));
    } catch {
      // never throw from a render pass
    }
  }
}

// ---- rendering helpers ------------------------------------------------------

function renderPost(post: FeedPost): HTMLElement {
  const thread = el('div', 'feed-post');

  // header: colour dot · author · time · topic tag
  const head = el('div', 'feed-head');
  const dot = el('span', 'feed-dot');
  dot.style.background = hexColor(post.hatColor);
  const name = el('span', 'feed-author');
  name.textContent = post.authorName ?? '—';
  const time = el('span', 'feed-time');
  time.textContent = clock(post.t);
  head.append(dot, name, time);
  if (post.topic) {
    const tag = el('span', 'feed-tag');
    tag.textContent = `#${post.topic}`;
    head.appendChild(tag);
  }
  thread.appendChild(head);

  // body text
  const body = el('div', 'feed-text');
  body.textContent = post.text ?? '';
  if (typeof post.valence === 'number') {
    if (post.valence > 0.35) body.classList.add('glad');
    else if (post.valence < -0.35) body.classList.add('sore');
  }
  thread.appendChild(body);

  // footer: likes · comment count
  const likes = post.likes?.length ?? 0;
  const cmts = post.comments?.length ?? 0;
  const foot = el('div', 'feed-foot');
  const heart = el('span', likes > 0 ? 'feed-likes on' : 'feed-likes');
  heart.textContent = `♥ ${likes}`;
  const reply = el('span', 'feed-cmt-n');
  reply.textContent = `↩ ${cmts}`;
  foot.append(heart, reply);
  thread.appendChild(foot);

  // comments (indented)
  const shown = (post.comments ?? []).slice(0, MAX_COMMENTS);
  if (shown.length) {
    const box = el('div', 'feed-comments');
    for (const c of shown) box.appendChild(renderComment(c));
    if (cmts > shown.length) {
      const more = el('div', 'feed-more');
      more.textContent = `+${cmts - shown.length} more`;
      box.appendChild(more);
    }
    thread.appendChild(box);
  }

  return thread;
}

function renderComment(c: FeedComment): HTMLElement {
  const row = el('div', 'feed-comment');
  const warmth = typeof c.warmth === 'number' ? c.warmth : 0;
  if (warmth > 0.25) row.classList.add('warm');
  else if (warmth < 0) row.classList.add('cold');
  const who = el('span', 'feed-cmt-a');
  who.textContent = c.authorName ?? '—';
  const txt = el('span', 'feed-cmt-t');
  txt.textContent = c.text ?? '';
  row.append(who, txt);
  return row;
}

// ---- pure utilities ---------------------------------------------------------

/** Build a stable signature of what's visible so we only redraw on change. */
function feedSignature(total: number, posts: FeedPost[]): string {
  let s = `n${total}|`;
  for (const p of posts) {
    s += `${p.id}:${p.likes?.length ?? 0}:${p.comments?.length ?? 0};`;
    for (const c of p.comments ?? []) s += `${c.id}~`;
  }
  return s;
}

/** number (0xRRGGBB) → "#rrggbb"; tolerant of NaN/negatives. */
function hexColor(n: number): string {
  const v = Number.isFinite(n) ? (n >>> 0) & 0xffffff : 0x000000;
  return '#' + v.toString(16).padStart(6, '0');
}

/** continuous sim-hours → HH:MM on a 24h circadian clock. */
function clock(t: number): string {
  if (!Number.isFinite(t)) return '--:--';
  const day = ((t % 24) + 24) % 24;
  const h = Math.floor(day);
  const m = Math.floor((day - h) * 60);
  return `${pad2(h)}:${pad2(m)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

// ---- one-time scoped style injection (house palette) ------------------------

const STYLE_ID = 'socialfeed-styles';

function injectStyleOnce(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = FEED_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

const FEED_CSS = `
.feed-sub {
  font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-soft); margin-bottom: 6px;
}
.feed-list {
  display: flex; flex-direction: column; gap: 8px;
  max-height: 340px; overflow-y: auto;
}
.feed-list::-webkit-scrollbar { width: 8px; }
.feed-list::-webkit-scrollbar-thumb { background: var(--line-faint); }

.feed-post {
  border-top: 1px solid var(--line-faint); padding-top: 7px;
}
.feed-post:first-child { border-top: 0; padding-top: 0; }

.feed-head { display: flex; align-items: baseline; gap: 6px; }
.feed-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  align-self: center; border: 1px solid rgba(32, 24, 15, 0.4);
}
.feed-author { color: var(--ink); font-weight: 600; font-size: 11px; }
.feed-time {
  color: var(--ink-faint); font-size: 10px; font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
}
.feed-tag {
  margin-left: auto; color: var(--ink-soft); font-size: 9.5px;
  letter-spacing: 0.08em; text-transform: lowercase;
  border: 1px solid var(--line-faint); padding: 0 4px;
}

.feed-text {
  font-family: var(--serif); font-size: 14px; line-height: 1.4;
  color: var(--ink); margin: 4px 0 3px;
}
.feed-text.glad { color: var(--good); }
.feed-text.sore { color: var(--accent); }

.feed-foot {
  display: flex; gap: 12px; font-size: 10px; color: var(--ink-faint);
  font-variant-numeric: tabular-nums; letter-spacing: 0.04em;
}
.feed-likes.on { color: var(--accent); }

.feed-comments {
  margin: 5px 0 1px 12px; padding-left: 8px;
  border-left: 1px solid var(--line-faint);
  display: flex; flex-direction: column; gap: 2px;
}
.feed-comment {
  display: flex; gap: 6px; font-size: 11px; align-items: baseline; line-height: 1.35;
}
.feed-cmt-a { color: var(--ink-soft); font-weight: 600; flex: 0 0 auto; }
.feed-cmt-t { color: var(--ink-soft); }
.feed-comment.warm .feed-cmt-a,
.feed-comment.warm .feed-cmt-t { color: var(--good); }
.feed-comment.cold .feed-cmt-a,
.feed-comment.cold .feed-cmt-t { color: var(--accent); }

.feed-more { font-size: 10px; color: var(--ink-faint); font-style: italic; }
.feed-empty { font-size: 11px; color: var(--ink-faint); font-style: italic; }
`;
