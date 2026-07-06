// =============================================================================
// bankcrowd.ts — the CHEAPEST tier of people: bank / Fed staff + customers that
// are only RENDERED near their building and despawned otherwise. They exist
// purely as BODIES with a tiny probabilistic FSM — no soma, no LLM, no economy,
// no sim state, no snapshot. Cosmetic street-furniture with legs.
//
// Mirrors StreetLife's shape: this layer owns its own Humanoid bodies, drives
// them each frame, and never touches the town sim. It differs in one way — it is
// CAMERA-CULLED: an anchor's figures are only added to the scene (and ticked)
// while the camera is close to that building, and scene.remove()'d when it drifts
// away. Bodies are pooled per anchor and reused, so a pass-by is cheap and never
// re-allocates geometry. Cost is O(bodies actually in range) per frame.
//
// Each figure runs a small state machine near its anchor:
//   wander — small ambling steps around the plinth
//   queue  — line up toward the door / steps (front of the line steps inside)
//   idle   — linger a pace off the plinth
//   enter  — walk to the door, then recede (shrink + fade) through it
//   exit   — emerge at the door (grow + fade in) and walk back out
// The Fed anchor reads "orderly" (mostly a tidy queue toward its steps); the bank
// reads as a mix of queue + walk-ups + loiterers. All of it is Math.random — it
// is never persisted, so determinism does not matter here.
// =============================================================================
import * as THREE from 'three';
import { Humanoid } from './humanoid';

const V = THREE.Vector3;

// --- tuning (metres / seconds) ----------------------------------------------
const SPAWN_MARGIN = 18;   // spawn a little before the camera arrives at the plinth
const DESPAWN_HYST = 8;    // extra slack before culling, so a body never flickers on the edge
const DT_MIN = 0.006;      // floor the per-frame step so figures never freeze at slow sim speeds
const DT_MAX = 0.05;       // cap it so a fast-forward never teleports them across the plaza
const FRONT_GAP = 1.1;     // the front of a queue stands this far out from the door
const QUEUE_GAP = 0.95;    // spacing between people down the line
const ENTER_SCALE = 0.32;  // scale a body recedes to at the doorway (reads as "through the door")
const FADE_DWELL = 0.6;    // seconds a body stays faded "inside" before it recycles back out

// The mild demeanours we tint figures with (a subset of the body's Demeanor union;
// passed straight to Humanoid.setPose — 'leaving' state fades a body out, undefined fades it in).
type Mood = 'polite' | 'neutral' | 'impatient';
const MOODS: readonly Mood[] = ['polite', 'neutral', 'impatient'];

type State = 'wander' | 'queue' | 'idle' | 'enter' | 'exit';

/** one pooled figure at an anchor (created once, reused across pass-bys). */
interface Fig {
  h: Humanoid;
  state: State;
  target: THREE.Vector3;   // current world destination
  timer: number;           // seconds until the next decision (telescoped step)
  seq: number;             // FIFO ticket for queue ordering (front = lowest live seq)
  slot: number;            // current place in line (0 = front), recomputed each frame
  fading: boolean;         // enter: has the recede/fade already been triggered?
  mood: Mood;
}

/** A building the crowd clusters around. `orderly` is optional: true → tidy queue
 *  (the Fed), false → loose mix (the bank). If omitted, a stable per-position hash
 *  decides, so two unmarked anchors still feel different. */
export interface CrowdAnchor {
  pos: THREE.Vector3;      // plinth / building centre (crowd stays within `radius` of it)
  radius: number;          // how far figures may roam from the plinth
  count: number;           // how many bodies live here when the camera is near
  door: THREE.Vector3;     // the entrance / steps a queue points at
  orderly?: boolean;       // optional: force orderly (Fed) vs mixed (bank)
}

/** internal, resolved anchor (world-space direction + pooled bodies + live flag). */
interface Anchor {
  pos: THREE.Vector3;
  radius: number;
  count: number;
  door: THREE.Vector3;
  outward: THREE.Vector3;  // unit XZ direction from plinth → door (the queue extends this way)
  orderliness: number;     // 0..1 — high = tidy queue (Fed), low = loose mix (bank)
  figs: Fig[];             // pooled bodies (created lazily on first spawn)
  live: boolean;           // currently added to the scene?
  seqNext: number;         // monotonic queue-ticket counter
}

/** stable [0,1) hash of a plinth position, so unmarked anchors differ in feel. */
function hash01(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const distXZ = (a: THREE.Vector3, b: THREE.Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);

export class BankCrowd {
  private anchors: Anchor[] = [];
  private readonly _q = new V();     // scratch target (copied out immediately, never retained)
  private readonly _line: Fig[] = []; // scratch queue-ordering buffer

  constructor(private scene: THREE.Scene, anchors: CrowdAnchor[]) {
    for (const c of anchors) {
      const pos = c.pos.clone();
      const door = c.door.clone();
      const outward = new V(door.x - pos.x, 0, door.z - pos.z);
      if (outward.lengthSq() < 1e-6) outward.set(0, 0, 1); else outward.normalize();
      const orderliness = c.orderly === true ? 0.85
        : c.orderly === false ? 0.35
        : 0.35 + hash01(pos.x, pos.z) * 0.4;
      this.anchors.push({
        pos, door, outward, orderliness,
        radius: Math.max(4, c.radius),
        count: Math.max(0, c.count | 0),
        figs: [], live: false, seqNext: 0,
      });
    }
  }

  /** Per-frame with the CAMERA world position. Spawns/ticks anchors in range,
   *  despawns the rest. `dtHours` is telescoped (floored + capped) into a bounded
   *  animation step so the crowd neither freezes at slow sim speed nor teleports at
   *  fast — it reads at any sim speed, like StreetLife. Never throws. */
  update(cameraPos: THREE.Vector3, dtHours: number): void {
    const dt = dtHours > 0 ? Math.min(Math.max(dtHours, DT_MIN), DT_MAX) : 0;
    try {
      for (const a of this.anchors) {
        const d = distXZ(cameraPos, a.pos);
        if (a.live) {
          if (d > a.radius + SPAWN_MARGIN + DESPAWN_HYST) { this.despawn(a); continue; }
        } else {
          if (d < a.radius + SPAWN_MARGIN) this.spawn(a); else continue;
        }
        // in range and live → drive + integrate its bodies (O(bodies-in-range))
        this.stepAnchor(a, dt);
        for (const f of a.figs) f.h.tick(dt);
      }
    } catch { /* cosmetic layer: never break the render loop */ }
  }

  dispose(): void {
    for (const a of this.anchors) {
      for (const f of a.figs) { this.scene.remove(f.h.object); f.h.dispose(); }
      a.figs.length = 0;
      a.live = false;
    }
  }

  // ---------------------------------------------------------------------------
  // spawn / despawn (bodies are pooled — created once, then added/removed)
  // ---------------------------------------------------------------------------
  private spawn(a: Anchor): void {
    if (a.figs.length === 0) {
      for (let i = 0; i < a.count; i++) {
        a.figs.push({
          h: new Humanoid('npc'), state: 'wander', target: new V(),
          timer: 0, seq: 0, slot: 0, fading: false,
          mood: MOODS[(Math.random() * MOODS.length) | 0],
        });
      }
    }
    for (const f of a.figs) {
      const p = this.wanderPoint(a, this._q);
      f.h.place(p, Math.random() * Math.PI * 2);
      f.h.snapScale(1);
      f.state = 'wander';
      f.fading = false;
      f.target.copy(this.wanderPoint(a, this._q));
      f.timer = 0.5 + Math.random() * 4;   // stagger so they don't all decide at once
      this.setFade(f, true);
      this.scene.add(f.h.object);
    }
    a.live = true;
  }

  private despawn(a: Anchor): void {
    for (const f of a.figs) this.scene.remove(f.h.object);
    a.live = false;
  }

  // ---------------------------------------------------------------------------
  // per-frame stepping
  // ---------------------------------------------------------------------------
  private stepAnchor(a: Anchor, dt: number): void {
    // recompute the line: queued figures ordered by their FIFO ticket (front = slot 0)
    this._line.length = 0;
    for (const f of a.figs) if (f.state === 'queue') this._line.push(f);
    this._line.sort((x, y) => x.seq - y.seq);
    for (let i = 0; i < this._line.length; i++) this._line[i].slot = i;

    for (const f of a.figs) this.stepFig(a, f, dt);
  }

  private stepFig(a: Anchor, f: Fig, dt: number): void {
    f.h.target.copy(f.target);
    const eps = 0.35 * (f.h.object.scale.x || 1) + 0.2;
    const arrived = f.h.pos.distanceTo(f.target) < eps;
    // stand while lingering / waiting at the door; walk everywhere else.
    const settled = f.state === 'idle'
      || (f.state === 'queue' && arrived)
      || (f.state === 'enter' && arrived);
    f.h.setActivity(settled ? 'stand' : 'walk');
    f.timer -= dt;

    switch (f.state) {
      case 'wander': {
        if (arrived || f.timer <= 0) {
          const r = Math.random();
          // orderly anchors funnel most walkers into the queue; loose ones scatter
          // them into idling, a few walk-ins, and more ambling.
          if (r < a.orderliness * 0.6) this.toQueue(a, f);
          else if (r < a.orderliness * 0.6 + 0.12) this.toEnter(a, f);
          else if (r < a.orderliness * 0.6 + 0.30) this.toIdle(a, f);
          else { f.target.copy(this.wanderPoint(a, this._q)); f.timer = 2 + Math.random() * 5; }
        }
        break;
      }
      case 'queue': {
        f.target.copy(this.queuePos(a, f.slot, this._q)); // shuffle forward as the line advances
        if (f.timer <= 0) {
          if (f.slot === 0 && arrived) this.toEnter(a, f);                          // front → step inside
          else if (f.slot > 0 && Math.random() < (1 - a.orderliness) * 0.4) this.toWander(a, f); // impatient walk-off (mostly the bank)
          else f.timer = 1.5 + Math.random() * 3;                                   // wait a bit longer
        }
        break;
      }
      case 'idle': {
        if (f.timer <= 0) {
          if (Math.random() < a.orderliness) this.toQueue(a, f); else this.toWander(a, f);
        }
        break;
      }
      case 'enter': {
        f.target.copy(a.door);
        if (arrived) {
          if (!f.fading) {                       // reached the door → recede through it
            f.fading = true;
            f.h.setScale(ENTER_SCALE);
            this.setFade(f, false);              // shrink + fade out
            f.timer = FADE_DWELL + Math.random() * 0.5;
          }
          if (f.timer <= 0) this.reemerge(a, f); // ...then recycle back into circulation
        }
        break;
      }
      case 'exit': {
        if (arrived) this.toWander(a, f);        // walked out into the plaza → go amble
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // state transitions
  // ---------------------------------------------------------------------------
  private toWander(a: Anchor, f: Fig, teleport = false): void {
    f.state = 'wander';
    f.fading = false;
    f.h.setScale(1);
    if (teleport) {                              // reappear as a fresh passer-by elsewhere
      f.h.place(this.wanderPoint(a, this._q), Math.random() * Math.PI * 2);
      f.h.snapScale(1);
      this.setFade(f, true);
    }
    f.target.copy(this.wanderPoint(a, this._q));
    f.timer = 2 + Math.random() * 5;
  }

  private toQueue(a: Anchor, f: Fig): void {
    f.state = 'queue';
    f.fading = false;
    f.h.setScale(1);
    f.seq = a.seqNext++;                         // take a ticket → joins the back of the line
    f.timer = 3 + Math.random() * 4;
  }

  private toIdle(a: Anchor, f: Fig): void {
    f.state = 'idle';
    f.fading = false;
    f.h.setScale(1);
    const ang = Math.random() * Math.PI * 2, r = a.radius * 0.25;
    f.target.set(a.pos.x + Math.cos(ang) * r, a.pos.y, a.pos.z + Math.sin(ang) * r);
    this.clampInside(a, f.target);
    f.timer = 3 + Math.random() * 5;
  }

  private toEnter(a: Anchor, f: Fig): void {
    f.state = 'enter';
    f.fading = false;
    f.h.setScale(1);
    f.target.copy(a.door);
    f.timer = FADE_DWELL;
  }

  /** a faded-"inside" body pops back into circulation: mostly it steps back OUT of
   *  the door (a departing customer), otherwise it reappears as a fresh passer-by. */
  private reemerge(a: Anchor, f: Fig): void {
    if (Math.random() < 0.6) {
      f.state = 'exit';
      f.fading = false;
      f.h.place(a.door, Math.atan2(a.outward.x, a.outward.z)); // at the door, facing out
      f.h.snapScale(ENTER_SCALE);
      f.h.setScale(1);                           // grow back to full size stepping out
      this.setFade(f, true);                     // fade in
      f.target.copy(this.outPoint(a, this._q));  // walk out into the plaza
      f.timer = 3 + Math.random() * 4;
    } else {
      this.toWander(a, f, true);
    }
  }

  // ---------------------------------------------------------------------------
  // geometry helpers (all clamped to stay within `radius` of the plinth)
  // ---------------------------------------------------------------------------
  /** a random amble point around the plinth (well within radius). */
  private wanderPoint(a: Anchor, out: THREE.Vector3): THREE.Vector3 {
    const ang = Math.random() * Math.PI * 2;
    const r = a.radius * (0.35 + Math.random() * 0.5);
    return out.set(a.pos.x + Math.cos(ang) * r, a.pos.y, a.pos.z + Math.sin(ang) * r);
  }

  /** world position of the `slot`-th person in the line (0 = front, at the door). */
  private queuePos(a: Anchor, slot: number, out: THREE.Vector3): THREE.Vector3 {
    const want = FRONT_GAP + slot * QUEUE_GAP;
    const maxD = Math.max(FRONT_GAP, a.radius - 1.0);
    const d = Math.min(want, maxD);
    out.set(a.door.x + a.outward.x * d, a.pos.y, a.door.z + a.outward.z * d);
    return this.clampInside(a, out);
  }

  /** a spot out in the plaza in front of the door (for a body leaving the building). */
  private outPoint(a: Anchor, out: THREE.Vector3): THREE.Vector3 {
    out.set(a.door.x + a.outward.x * a.radius * 0.6, a.pos.y, a.door.z + a.outward.z * a.radius * 0.6);
    return this.clampInside(a, out);
  }

  /** pull a point back onto the disc of `radius` around the plinth if it strayed out. */
  private clampInside(a: Anchor, p: THREE.Vector3): THREE.Vector3 {
    const dx = p.x - a.pos.x, dz = p.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > a.radius) { const s = a.radius / d; p.x = a.pos.x + dx * s; p.z = a.pos.z + dz * s; }
    return p;
  }

  /** fade a body in (visible) or out (through the door) via its NPC demeanour pose. */
  private setFade(f: Fig, visible: boolean): void {
    f.h.setPose(f.mood, 1, visible ? undefined : 'leaving');
  }
}
