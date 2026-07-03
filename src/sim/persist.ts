// =============================================================================
// persist.ts — capture & restore the ENTIRE dynamical state of a run. The self
// already lives in plain serializable state (somas, memory graphs, ledgers,
// physiology), never in the LLM context, so a save is literally a serialization of
// the substrate and a load reattaches the stateless driver. Restore uses a
// "rebuild fresh, then overwrite in place" strategy: a fresh Town gives us the
// correct object graph (shared Mara identity, valid profile-id-keyed ledgers,
// canonical runtime order) and we overwrite every dynamical field from the
// snapshot — so cross-references stay valid without hand-topological restore.
//
// Determinism: every stochastic draw is threaded through a resumable mulberry32,
// so capturing each PRNG cursor + the module id-counters reproduces the future
// substrate EXACTLY (in Ollama-off fallback mode the whole forward trajectory
// replays; with a live LLM the state at the resume instant is byte-identical but
// the narration diverges).
// =============================================================================
import { Town, getTownEid, setTownEid, type TownJSON, type TownOpts } from './town';
import type { CharacterJSON } from '../harness/character';
import { getMemSeq, setMemSeq } from '../harness/memgraph';
import { getSocietyEid, setSocietyEid, type SocietyJSON } from './society';
import { getCompanySeq, setCompanySeq } from './company';
import { getFeedSeq, setFeedSeq } from './feed';
import { getEventSeq, setEventSeq } from './events';
import { ROSTER } from '../harness/roster';

export const SNAPSHOT_VERSION = 1;

export interface SnapshotV1 {
  version: number;
  rosterHash: string;
  savedAtClock: number;
  counters: { mem: number; townEid: number; societyEid: number; eventSeq: number; companyCid: number; companyEid: number; feedFid: number };
  characters: CharacterJSON[];
  society: SocietyJSON;
  town: TownJSON;
}

/** a fingerprint of the authored cast, to detect drift between save and load. */
export function rosterHash(): string {
  let h = 2166136261 >>> 0;
  const s = ROSTER.map((r) => r.profile.id + r.role + r.homeIndex + (r.officeFloor ?? '')).join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function serializeSim(town: Town): SnapshotV1 {
  const [companyCid, companyEid] = getCompanySeq();
  return {
    version: SNAPSHOT_VERSION,
    rosterHash: rosterHash(),
    savedAtClock: town.clock,
    counters: {
      mem: getMemSeq(), townEid: getTownEid(), societyEid: getSocietyEid(),
      eventSeq: getEventSeq(), companyCid, companyEid, feedFid: getFeedSeq(),
    },
    characters: town.society.characters.map((ch) => ch.toJSON()),
    society: town.society.toJSON(),
    town: town.toJSON(),
  };
}

/** overwrite a live Town with a saved snapshot, in the load-bearing order. */
export function restoreInto(town: Town, snap: SnapshotV1): void {
  // 1) module id-counters FIRST — so any post-load id (>= saved) can never collide
  //    with a restored id (< saved), and matches an uninterrupted run's next id.
  setMemSeq(snap.counters.mem);
  setTownEid(snap.counters.townEid);
  setSocietyEid(snap.counters.societyEid);
  setEventSeq(snap.counters.eventSeq);
  setCompanySeq(snap.counters.companyCid, snap.counters.companyEid);
  setFeedSeq(snap.counters.feedFid);

  // 2) every Character's substrate (idx 0 IS town.mara — one object, three slots).
  const chars = town.society.characters;
  chars.forEach((ch, i) => { if (snap.characters[i]) ch.loadJSON(snap.characters[i]); });

  // 3) society runtimes + ledgers + active conversations + company + feed. The
  //    conversations bind to the already-restored Characters/ledgers + the Town rng.
  town.society.loadJSON(snap.society, town.sharedRng);

  // 4) town macro state (resources, ledger, density, needs, goal, travel, figures,
  //    the promoted partner, Mara's phone, the work queue, focus/speed/paused).
  town.loadJSON(snap.town);

  // 5) invalidate any in-flight LLM promise from the pre-load state.
  town.epoch++;
}

export function buildFreshTown(opts: TownOpts): Town {
  return new Town(opts);
}
