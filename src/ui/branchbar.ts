// =============================================================================
// branchbar.ts — the save / restart / branch controls + the branch TREE, drawn in
// the house style (ink on aged sepia). Talks only to the SimSession: Save freezes
// the active branch to localStorage; Branch forks a counterfactual; Restart starts
// a fresh life; the tree lists every frozen branch (indented by depth) with the
// active one marked — click any node to JUMP (the current one is frozen + saved
// first). Export/Import round-trips the whole tree as a file.
// =============================================================================
import type { SimSession } from '../sim/session';

const STYLE_ID = 'branchbar-style';
const CSS = `
.branch-panel .bb-row { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.branch-panel .bb-btn { font: 600 10px/1 var(--mono); letter-spacing:.12em; text-transform:uppercase;
  color:var(--ink); background:var(--paper); border:1px solid var(--line); padding:6px 8px; cursor:pointer; border-radius:2px; }
.branch-panel .bb-btn:hover { background:var(--paper-deep); }
.branch-panel .bb-btn.warn { color:var(--accent); border-color:var(--accent); }
.branch-panel .bb-meter { font:10px/1.4 var(--mono); color:var(--ink-faint); margin-bottom:6px; }
.branch-panel .bb-tree { max-height:180px; overflow-y:auto; border-top:1px solid var(--line-faint); padding-top:6px; }
.branch-panel .bb-node { font:11px/1.5 var(--mono); color:var(--ink-soft); cursor:pointer; padding:2px 4px; border-radius:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.branch-panel .bb-node:hover { background:var(--paper-deep); }
.branch-panel .bb-node.active { color:var(--ink); font-weight:700; background:var(--paper-deep); }
.branch-panel .bb-node .bb-dot { color:var(--good); }
.branch-panel .bb-node.active .bb-dot { color:var(--accent); }
.branch-panel .bb-hint { font:9px/1.4 var(--mono); color:var(--ink-faint); margin-top:6px; }
`;

export class BranchBar {
  private readonly tree: HTMLElement;
  private readonly meter: HTMLElement;
  private cache = '';

  constructor(dashEl: HTMLElement, private readonly session: SimSession) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
    }
    const panel = document.createElement('div');
    panel.className = 'panel branch-panel';
    panel.innerHTML = '<h2>Save · Branches · Counterfactuals</h2>';

    const row = document.createElement('div'); row.className = 'bb-row';
    row.appendChild(this.btn('Save', () => { this.session.save(); this.render(true); }));
    row.appendChild(this.btn('Branch', () => { this.session.branch(); this.render(true); }));
    row.appendChild(this.btn('Restart', () => { if (confirm('Start a fresh life? The current tree is replaced.')) { this.session.restart(); this.render(true); } }, true));
    row.appendChild(this.btn('Export', () => this.exportTree()));
    row.appendChild(this.btn('Import', () => this.importTree()));
    panel.appendChild(row);

    this.meter = document.createElement('div'); this.meter.className = 'bb-meter';
    panel.appendChild(this.meter);

    this.tree = document.createElement('div'); this.tree.className = 'bb-tree';
    panel.appendChild(this.tree);

    const hint = document.createElement('div'); hint.className = 'bb-hint';
    hint.textContent = 'click a branch to jump (current is frozen + saved) · autosaves every ~30s';
    panel.appendChild(hint);

    // mount near the top of the dashboard aside
    dashEl.insertBefore(panel, dashEl.children[1] ?? null);
    this.render(true);
  }

  private btn(label: string, on: () => void, warn = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'bb-btn' + (warn ? ' warn' : '');
    b.textContent = label;
    b.addEventListener('click', on);
    return b;
  }

  /** call each frame; only re-renders the tree when it changes. */
  render(force = false): void {
    try {
      const list = this.session.listBranches();
      const kb = (this.session.usageBytes() / 1024).toFixed(0);
      this.meter.textContent = `${list.length} branch${list.length === 1 ? '' : 'es'} · ${kb} KB stored`;
      const sig = list.map((n) => `${n.id}${n.active ? '*' : ''}${n.label}`).join('|');
      if (!force && sig === this.cache) return;
      this.cache = sig;
      this.tree.innerHTML = '';
      for (const n of list) {
        const el = document.createElement('div');
        el.className = 'bb-node' + (n.active ? ' active' : '');
        el.style.paddingLeft = `${4 + n.depth * 14}px`;
        el.innerHTML = `<span class="bb-dot">${n.active ? '●' : '○'}</span> ${escapeHtml(n.label)}`;
        el.title = `jump to ${n.label}`;
        el.addEventListener('click', () => { this.session.jump(n.id); this.render(true); });
        this.tree.appendChild(el);
      }
    } catch { /* never break the loop */ }
  }

  private exportTree(): void {
    try {
      const blob = new Blob([this.session.exportJSON()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'exposome-branches.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { console.warn('[branchbar] export failed', e); }
  }

  private importTree(): void {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json';
    input.addEventListener('change', () => {
      const f = input.files?.[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { if (this.session.importJSON(String(r.result))) this.render(true); else alert('Import failed — not a valid branch tree.'); };
      r.readAsText(f);
    });
    input.click();
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
