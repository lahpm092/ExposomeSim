// =============================================================================
// branchtree.ts — counterfactual branches as a TREE of frozen exposome
// trajectories, plus a localStorage-backed store that survives a browser close +
// server stop (localStorage is origin-scoped, not server-tied). Each node is a
// full SnapshotV1; branching forks a genuinely different life from one identical
// initial condition — because behaviour EMERGES from the substrate, the fork is a
// real natural experiment, exactly the "field study" framing of the project.
// =============================================================================
import type { SnapshotV1 } from './persist';

export interface BranchNode {
  id: string;
  parentId: string | null;
  label: string;
  createdAtClock: number;   // sim-clock at which this node was frozen/created
  snapshot: SnapshotV1;
  children: string[];
}

export interface BranchTree {
  nodes: Record<string, BranchNode>;
  rootId: string;
  activeId: string;
  seq: number;              // monotonic id source (stable across reload)
}

export function newTree(root: SnapshotV1, label = 'root'): BranchTree {
  const id = 'b0';
  const node: BranchNode = { id, parentId: null, label, createdAtClock: root.savedAtClock, snapshot: root, children: [] };
  return { nodes: { [id]: node }, rootId: id, activeId: id, seq: 1 };
}

/** a lightweight view of the tree for the UI (no snapshots). */
export interface BranchInfo { id: string; parentId: string | null; label: string; clock: number; active: boolean; depth: number; }
export function treeInfo(tree: BranchTree): BranchInfo[] {
  const out: BranchInfo[] = [];
  const walk = (id: string, depth: number): void => {
    const n = tree.nodes[id]; if (!n) return;
    out.push({ id, parentId: n.parentId, label: n.label, clock: n.createdAtClock, active: id === tree.activeId, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(tree.rootId, 0);
  return out;
}

/** ancestors of a node (inclusive) — used so quota pruning never drops the path to active. */
export function ancestors(tree: BranchTree, id: string): Set<string> {
  const out = new Set<string>();
  let cur: string | null = id;
  while (cur) { out.add(cur); cur = tree.nodes[cur]?.parentId ?? null; }
  return out;
}

// ---- persistence store ------------------------------------------------------
const KEY = 'exposome:v1:tree';

export class PersistStore {
  /** write the tree; on quota overflow prune the oldest non-ancestor-of-active node,
   *  then retry. Returns true on success. Never throws into the caller. */
  save(tree: BranchTree): boolean {
    let attempt = { ...tree, nodes: { ...tree.nodes } };
    for (let i = 0; i < 8; i++) {
      try {
        localStorage.setItem(KEY, JSON.stringify(attempt));
        return true;
      } catch (e) {
        if (!isQuota(e)) { console.warn('[persist] save failed:', e); return false; }
        const dropped = this.pruneOne(attempt);
        if (!dropped) { console.warn('[persist] over quota and nothing prunable'); return false; }
      }
    }
    return false;
  }

  load(): BranchTree | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const t = JSON.parse(raw) as BranchTree;
      if (!t || !t.nodes || !t.nodes[t.activeId]) return null;
      return t;
    } catch (e) { console.warn('[persist] load failed:', e); return null; }
  }

  clear(): void { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

  usageBytes(): number {
    try { const raw = localStorage.getItem(KEY); return raw ? raw.length : 0; } catch { return 0; }
  }

  /** drop one leaf that is neither active nor an ancestor of active (oldest first). */
  private pruneOne(tree: BranchTree): boolean {
    const keep = ancestors(tree, tree.activeId);
    const leaves = Object.values(tree.nodes)
      .filter((n) => n.children.every((c) => !tree.nodes[c]) || n.children.length === 0)
      .filter((n) => !keep.has(n.id))
      .sort((a, b) => a.createdAtClock - b.createdAtClock);
    const victim = leaves[0];
    if (!victim) return false;
    const parent = victim.parentId ? tree.nodes[victim.parentId] : null;
    if (parent) parent.children = parent.children.filter((c) => c !== victim.id);
    delete tree.nodes[victim.id];
    return true;
  }
}

function isQuota(e: unknown): boolean {
  const err = e as { name?: string; code?: number };
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
}
