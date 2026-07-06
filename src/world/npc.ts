// =============================================================================
// npc.ts — Tier-1 proximate NPCs: cheap symbolic minds with NO soma.
//   An NpcLite is a plain struct: position + a goal-token FSM + three scalars
//   (hunger/energy/mood). It is stepped by closed-form decay + ease-to-target in
//   an O(N) sweep — no integrator, no LLM. It becomes a wireframe Figure in the
//   locale. When it needs to interact with Mara it sets wantsMara, and the Town
//   promotes it to a full-sim Character only for the duration of that exchange.
// =============================================================================
import type { NpcLite, Vec3 } from '../core/types';
import { sampleProfile } from '../mind/params';
import { mulberry32, clamp, type RNG } from '../core/util/num';

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** the display name a stable seed resolves to (shared with the full-sim profile) */
export function npcName(seed: number): string {
  return sampleProfile(seed).name;
}

export function makeNpcLite(id: string, seed: number, pos: Vec3): NpcLite {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  return {
    id,
    profileSeed: seed,
    name: npcName(seed),
    pos: { ...pos },
    dir: 0,
    path: [],
    goalToken: 'linger',
    hunger: rng(),
    energy: 0.4 + rng() * 0.5,
    mood: (rng() - 0.5) * 0.8,
    wantsMara: false,
  };
}

export interface LiteCtx {
  maraPos: Vec3;
  exit: Vec3;
  wander: Vec3;     // a focal point to mill around (counter / shelves / a table)
  rng: RNG;
}

/** O(1) per-NPC update: ease toward the current waypoint, advance the FSM. */
export function stepNpcLite(npc: NpcLite, dtHours: number, ctx: LiteCtx): boolean {
  // pick a target from the goal token
  let target: Vec3;
  switch (npc.goalToken) {
    case 'approach_mara': target = ctx.maraPos; break;
    case 'leave': target = ctx.exit; break;
    case 'queue': target = npc.path[0] ?? ctx.wander; break;
    case 'browse':
    case 'linger':
    default:
      target = npc.path[0] ?? ctx.wander;
  }
  const d = dist(npc.pos, target);
  // ease toward target (speed telescoped with sim-time so motion reads at any speed)
  const speed = 14 * dtHours; // locale units per sim-hour
  if (d > 0.05) {
    const step = Math.min(d, speed);
    npc.pos.x += ((target.x - npc.pos.x) / d) * step;
    npc.pos.z += ((target.z - npc.pos.z) / d) * step;
    npc.dir = Math.atan2(target.x - npc.pos.x, target.z - npc.pos.z);
  } else {
    // arrived
    if (npc.goalToken === 'leave') return true; // signal despawn
    if (npc.path.length) npc.path.shift();
    if ((npc.goalToken === 'browse' || npc.goalToken === 'linger') && npc.path.length === 0) {
      // wander to a fresh nearby point
      npc.path.push({
        x: ctx.wander.x + (ctx.rng() - 0.5) * 2.4,
        y: 0,
        z: ctx.wander.z + (ctx.rng() - 0.5) * 2.4,
      });
    }
  }
  // cheap scalar drift
  npc.hunger = clamp(npc.hunger + dtHours * 0.05, 0, 1);
  npc.energy = clamp(npc.energy - dtHours * 0.02, 0, 1);
  return false;
}
