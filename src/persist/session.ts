// =============================================================================
// session.ts — the single object main.ts + the UI talk to. It owns the LIVE Town,
// the branch TREE and the localStorage store, and hot-swaps the Town on load /
// restart / jump so the (stateless-per-frame) renderer transparently follows. On
// construction it resumes the last autosaved branch if the roster still matches,
// so closing the browser and reopening drops you back where you were.
// =============================================================================
import { type TownOpts } from '../world/town';
import { serializeSim, restoreInto, rosterHash, buildFreshTown } from './persist';
import { newTree, treeInfo, PersistStore, type BranchTree, type BranchInfo } from './branchtree';

const fmt = (t: number): string => {
  const h = Math.floor(((t % 24) + 24) % 24), m = Math.floor((t - Math.floor(t)) * 60);
  const day = Math.floor(t / 24);
  return `d${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export class SimSession {
  private _town;
  private tree: BranchTree;
  private readonly store = new PersistStore();
  private readonly opts: TownOpts;
  private autosaveAcc = 0;
  resumed = false;

  constructor(opts: TownOpts) {
    this.opts = opts;
    const saved = this.store.load();
    if (saved && saved.nodes[saved.activeId]?.snapshot?.rosterHash === rosterHash()) {
      // resume exactly where we left off (localStorage survives browser/server restart).
      this._town = buildFreshTown(opts);
      restoreInto(this._town, saved.nodes[saved.activeId].snapshot);
      this.tree = saved;
      this.resumed = true;
    } else {
      this._town = buildFreshTown(opts);
      this.tree = newTree(serializeSim(this._town));
    }
  }

  get town() { return this._town; }

  /** freeze the currently-active branch's snapshot to the live state. */
  private freezeActive(): void {
    const n = this.tree.nodes[this.tree.activeId];
    if (!n) return;
    n.snapshot = serializeSim(this._town);
    n.createdAtClock = this._town.clock;
  }

  save(): boolean { this.freezeActive(); return this.store.save(this.tree); }

  /** fork a counterfactual: freeze current, create a child, make it active. */
  branch(label?: string): string {
    this.freezeActive();
    const id = `b${this.tree.seq++}`;
    const parentId = this.tree.activeId;
    this.tree.nodes[id] = {
      id, parentId, label: label || `fork ${fmt(this._town.clock)}`,
      createdAtClock: this._town.clock, snapshot: serializeSim(this._town), children: [],
    };
    this.tree.nodes[parentId].children.push(id);
    this.tree.activeId = id;
    this.store.save(this.tree);
    return id;
  }

  /** jump to another branch: the current one is FROZEN + SAVED first, then target
   *  is restored into the live Town and becomes active. */
  jump(id: string): boolean {
    if (!this.tree.nodes[id]) return false;
    if (id === this.tree.activeId) return true;
    this.freezeActive();
    restoreInto(this._town, this.tree.nodes[id].snapshot);
    this.tree.activeId = id;
    this.store.save(this.tree);
    return true;
  }

  /** start a brand-new life (a fresh root) — the old tree is replaced. */
  restart(seed?: number): void {
    this._town = buildFreshTown({ ...this.opts, seed: seed ?? (this.opts.seed ?? 7) + 1 });
    this.tree = newTree(serializeSim(this._town));
    this.store.save(this.tree);
  }

  listBranches(): BranchInfo[] { return treeInfo(this.tree); }
  activeId(): string { return this.tree.activeId; }
  usageBytes(): number { return this.store.usageBytes(); }

  /** export the WHOLE branch tree (including all frozen branches) to a JSON string. */
  exportJSON(): string { this.freezeActive(); return JSON.stringify(this.tree); }

  importJSON(json: string): boolean {
    try {
      const t = JSON.parse(json) as BranchTree;
      if (!t?.nodes?.[t.activeId]) return false;
      this._town = buildFreshTown(this.opts);
      restoreInto(this._town, t.nodes[t.activeId].snapshot);
      this.tree = t;
      this.store.save(this.tree);
      return true;
    } catch { return false; }
  }

  /** periodic autosave of the active branch (so a browser close loses ≤ one interval). */
  autosaveTick(dtReal: number): void {
    this.autosaveAcc += dtReal;
    if (this.autosaveAcc >= 30) { this.autosaveAcc = 0; this.save(); }
  }
}
