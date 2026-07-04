// =============================================================================
// streetlife.ts — ambient STREET PEDESTRIANS: simple wireframe extras (no soma,
// no LLM, no sim state) that wander the city at random and, at random intervals,
// step INTO the fast-food restaurant, mill at a table, then leave. They stay at the
// same real-metre scale as everyone else (INT_SCALE = 1) — street, doorway and
// dining floor are all one scale, so a walk-in never changes size at the door.
//
// This is a purely render-side ambient layer: it owns its own bodies and drives
// them each frame. It never touches the town sim or its snapshot. The point is a
// livelier city (the streets are no longer empty between the ten agents' commutes)
// and a restaurant with a little walk-in trade even when Mara is away. Extras keep
// clear of the office footprint (the office is staffed by the sim's own agents).
// =============================================================================
import * as THREE from 'three';
import { Humanoid } from './humanoid';
import { INT_SCALE } from './worldgeo';
import { swingDoor, type DoorRef } from './doorkit';
import type { FoodBuilding } from './foodcourt';

const V = THREE.Vector3;

// wander (amble the city) → approach (walk to the door) → entering (cross the
// threshold to a table) → dine (mill at the table) → exiting (cross back to the
// door) → leaving (head back out). No size change anywhere — one real-metre scale.
type Phase = 'wander' | 'approach' | 'entering' | 'dine' | 'exiting' | 'leaving';

interface Ped {
  h: Humanoid;
  phase: Phase;
  target: THREE.Vector3;   // current world destination
  timer: number;           // seconds: dwell / stroll countdown
  table: number;           // dining spot chosen for this visit
}

export interface StreetLifeOpts {
  count?: number;            // how many pedestrians
  half?: number;             // wander half-extent (world metres from centre)
  officePos?: THREE.Vector3; // office footprint centre to steer clear of
  officeR?: number;          // avoidance radius around the office
  maxInside?: number;        // cap on how many may be in the restaurant at once
  enterChance?: number;      // per-arrival probability of heading in to eat
}

export class StreetLife {
  private peds: Ped[] = [];
  private readonly half: number;
  private readonly maxInside: number;
  private readonly enterChance: number;
  private readonly door: DoorRef;
  private readonly avoid: { pos: THREE.Vector3; r: number }[] = [];
  // food-building anchors resolved to WORLD space (the building is static)
  private readonly outside = new V();   // ~1.2 m in front of the main door (full size)
  private readonly lobby = new V();     // just inside the door
  private readonly tables: THREE.Vector3[] = [];
  private doorWanted = false;

  constructor(private scene: THREE.Scene, food: FoodBuilding, opts: StreetLifeOpts = {}) {
    const count = opts.count ?? 10;
    this.half = opts.half ?? 28;
    this.maxInside = opts.maxInside ?? 3;
    this.enterChance = opts.enterChance ?? 0.16;
    this.door = food.mainDoor;

    const g = food.group; g.updateMatrixWorld(true);
    this.outside.copy(g.localToWorld(food.mainOutside.clone()));
    this.lobby.copy(g.localToWorld(food.lobbyInside.clone()));
    for (const [x, z] of [[-2.9, 1.7], [2.9, 1.7], [-2.9, 3.0], [2.9, 3.0]] as const) {
      this.tables.push(g.localToWorld(new V(x, 0, z)));  // a stand spot beside each dining table
    }

    // avoid the office (sim-staffed) and the tiny restaurant footprint, so a
    // full-size stroller never wades through the 1/4-scale buildings.
    if (opts.officePos) this.avoid.push({ pos: opts.officePos.clone(), r: opts.officeR ?? 8 });
    this.avoid.push({ pos: g.localToWorld(new V(0, 0, 0)), r: 4.5 });

    for (let i = 0; i < count; i++) {
      const h = new Humanoid('npc');
      const p = this.wanderPoint();
      h.place(p, Math.random() * Math.PI * 2);
      h.snapScale(1);
      scene.add(h.object);
      this.peds.push({ h, phase: 'wander', target: p.clone(), timer: 1 + Math.random() * 9, table: 0 });
    }
  }

  update(dt: number): void {
    const inside = this.peds.reduce((n, p) => n + (p.phase === 'entering' || p.phase === 'dine' ? 1 : 0), 0);
    this.doorWanted = false;
    for (const p of this.peds) this.stepPed(p, dt, inside);
    // We only ever ASK the door to open (while a pedestrian is crossing); the
    // AgentBodies controller runs earlier each frame and closes it when nobody
    // needs it, so the two never fight over the leaf.
    if (this.doorWanted) swingDoor(this.door, true);
    for (const p of this.peds) p.h.tick(dt);
  }

  private stepPed(p: Ped, dt: number, inside: number): void {
    // drive toward the standing target; arrival is measured against it each frame.
    p.h.target.copy(p.target);
    const eps = 0.4 * (p.h.object.scale.x || 1) + 0.18;
    const arrived = p.h.pos.distanceTo(p.target) < eps;
    // stand once settled at the dining table; walk everywhere else.
    p.h.setActivity(p.phase === 'dine' && arrived ? 'stand' : 'walk');
    switch (p.phase) {
      case 'wander': {
        p.h.setScale(1);
        p.timer -= dt;
        if (arrived || p.timer <= 0) {
          if (arrived && inside < this.maxInside && Math.random() < this.enterChance) {
            p.phase = 'approach';                          // head in to eat
            p.table = Math.floor(Math.random() * this.tables.length);
            p.target = this.outside.clone();
          } else {
            p.target = this.wanderPoint();                 // amble to a new spot
            p.timer = 4 + Math.random() * 12;
          }
        }
        break;
      }
      case 'approach': {
        p.h.setScale(1);                                    // still full size on the street
        this.doorWanted = true;
        if (arrived) { p.phase = 'entering'; p.timer = 0.45; }
        break;
      }
      case 'entering': {
        p.h.setScale(INT_SCALE);                            // interior scale == street scale (1)
        this.doorWanted = true;
        p.timer -= dt;
        if (p.timer <= 0) { p.phase = 'dine'; p.target = this.tables[p.table].clone(); p.timer = 6 + Math.random() * 10; }
        break;                                              // cross to a table
      }
      case 'dine': {
        p.h.setScale(INT_SCALE);
        p.timer -= dt;
        if (p.timer <= 0) { p.phase = 'exiting'; p.target = this.lobby.clone(); }
        break;
      }
      case 'exiting': {
        p.h.setScale(INT_SCALE);
        this.doorWanted = true;
        if (arrived) { p.phase = 'leaving'; p.target = this.outside.clone(); }
        break;
      }
      case 'leaving': {
        p.h.setScale(1);                                    // same scale throughout
        this.doorWanted = true;
        if (arrived) { p.phase = 'wander'; p.target = this.wanderPoint(); p.timer = 3 + Math.random() * 10; }
        break;
      }
    }
  }

  /** a random point on the city ground, clear of the avoid zones. */
  private wanderPoint(): THREE.Vector3 {
    for (let i = 0; i < 10; i++) {
      const p = new V((Math.random() * 2 - 1) * this.half, 0, (Math.random() * 2 - 1) * this.half);
      if (this.avoid.every((a) => p.distanceTo(a.pos) > a.r)) return p;
    }
    return new V((Math.random() * 2 - 1) * this.half, 0, (Math.random() * 2 - 1) * this.half);
  }

  dispose(): void {
    for (const p of this.peds) { this.scene.remove(p.h.object); p.h.dispose(); }
    this.peds = [];
  }
}
