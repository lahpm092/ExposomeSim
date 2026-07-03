// =============================================================================
// residents.ts — the home-life navigation for every agent living in the building.
//
// Each resident owns one apartment. A resident walks a LOOP of "legs": approach
// the tower door at full size → cross it and SHRINK to 1/4 (building interior) →
// climb the stairs to their floor → walk the hallway → open their door and cross
// it, SHRINKING AGAIN to 1/16 (apartment interior) → cycle through home activities
// (sleep / couch+TV / couch+phone / toilet / shower) → then reverse it all back
// out. The doors swing as agents pass; the humanoid plays the matching pose.
//
// Positions are expressed in one of three FRAMES and resolved to world each tick:
//   world     — absolute (outside, full size)
//   building  — building.group.localToWorld  (interior, 1/4)
//   apt       — apartment.group.localToWorld (flat, 1/16)
// The desired body SCALE is carried per-leg, so the shrink/grow happens exactly at
// the door crossings and the camera (which tracks body scale) follows it down.
// =============================================================================
import * as THREE from 'three';
import type { Building, BuildingApt } from './building';
import { APT_SCALE } from './building';
import { INT_SCALE } from './worldgeo';
import type { Humanoid } from './humanoid';
import type { ActivityKind } from './poses';
import { swingDoor } from './doorkit';

const V = THREE.Vector3;
// body scale in each frame: building interior = INT_SCALE (1/4); apartment
// interior = INT_SCALE·APT_SCALE (1/16). Derived so the two never drift.
const INT = INT_SCALE, INT2 = INT_SCALE * APT_SCALE;

type Frame = 'world' | 'building' | 'apt';
interface Leg {
  frame: Frame; x: number; y: number; z: number;
  scale: number; yaw?: number;
  activity?: ActivityKind; dwell?: number;
  mainDoor?: boolean; aptDoor?: boolean;
}

export interface ResidentView { index: number; name: string; floor: number; }
export interface ResCtx {
  mainApproachWorld: THREE.Vector3;         // full-size point just outside the tower/main door
  awayWorld: (index: number) => THREE.Vector3;  // a full-size point to wander to when "out"
}

// home-activity rotation — every resident cycles all the poses (order varies by
// index so at any moment different flats show different activities).
const PLAN: { spot: string; activity: ActivityKind; dwell: number }[] = [
  { spot: 'couch_tv', activity: 'couch_tv', dwell: 6 },
  { spot: 'couch_phone', activity: 'couch_phone', dwell: 6 },
  { spot: 'toilet_pee', activity: 'toilet_pee', dwell: 3.5 },
  { spot: 'shower', activity: 'shower', dwell: 5 },
  { spot: 'sleep', activity: 'sleep', dwell: 9 },
  { spot: 'toilet_defecate', activity: 'toilet_defecate', dwell: 3.5 },
  { spot: 'kitchen', activity: 'stand', dwell: 3 },
];

class Resident {
  legs: Leg[] = [];
  li = 0;
  hold = 0;
  constructor(
    public index: number, public name: string, public apt: BuildingApt,
    public h: Humanoid, public isMara: boolean,
  ) {}
}

export class Residents {
  private list: Resident[] = [];
  private buildingYaw = 0;
  private maraControlled = false;
  private maraPhase: 'away' | 'entering' | 'inside' = 'away';
  private maraActivity: ActivityKind = 'stand';

  constructor(
    private b: Building,
    private ctx: ResCtx,
    seats: { h: Humanoid; name: string; isMara: boolean }[],
  ) {
    this.buildingYaw = this.yawOf(b.group);
    seats.forEach((s, i) => {
      const apt = b.apartments[i % b.apartments.length];
      apt.name = s.name;
      const r = new Resident(i, s.name, apt, s.h, s.isMara);
      if (!s.isMara) {
        r.legs = this.buildLoop(apt, i);
        // stagger where each autonomous resident starts, so the building is lively
        r.li = Math.floor((i * 2654435761 % 100) / 100 * r.legs.length) % r.legs.length;
        const wt = this.worldOf(r, r.legs[r.li]);
        s.h.place(wt, this.worldYaw(r, r.legs[r.li]) ?? this.buildingYaw);
        s.h.setScale(r.legs[r.li].scale);
      }
      this.list.push(r);
    });
  }

  views(): ResidentView[] {
    return this.list.map((r) => ({ index: r.index, name: r.name, floor: r.apt.floor }));
  }

  // ---- Mara (index 0): slaved to the sim's home state ----------------------
  /** returns true if residents is CONTROLLING Mara's humanoid this frame. */
  driveMara(homeActive: boolean, activity: ActivityKind): boolean {
    const r = this.list[0];
    if (!r || !r.isMara) return false;
    if (!homeActive) { this.maraPhase = 'away'; this.maraControlled = false; return false; }
    this.maraActivity = activity;
    if (this.maraPhase === 'away') {
      r.legs = this.buildEnter(r.apt);       // approach → shrink → climb → into flat
      r.li = 0; r.hold = 0; this.maraPhase = 'entering';
      // snap to the start so she doesn't lerp across the map
      r.h.place(this.worldOf(r, r.legs[0]), this.buildingYaw);
      r.h.setScale(1);
    }
    this.maraControlled = true;
    return true;
  }

  // ---- per-frame advance of the autonomous residents + Mara + doors --------
  update(dtReal: number): void {
    const dt = Math.min(0.05, Math.max(0, dtReal));
    for (const r of this.list) {
      if (r.isMara) { if (this.maraControlled) this.stepMara(r, dt); continue; }
      this.stepLeg(r, dt, true);
    }
    this.swingDoors();
  }

  private stepMara(r: Resident, dt: number): void {
    if (this.maraPhase === 'entering') {
      const done = this.stepLeg(r, dt, false);   // walk the enter route once
      if (done) this.maraPhase = 'inside';
    } else { // inside — hold the sim-chosen activity at its spot, retarget on change
      const spot = this.spotFor(this.maraActivity);
      const s = r.apt.unit.spots[spot] ?? r.apt.unit.spots.couch_tv;
      const wt = r.apt.group.localToWorld(new V(s.x, s.y, s.z));
      r.h.setScale(INT2);
      r.h.setActivity(this.maraActivity);
      r.h.target.copy(wt);
      r.h.targetYaw = this.yawOf(r.apt.group) + (s.yaw ?? 0);
    }
  }

  private spotFor(a: ActivityKind): string {
    switch (a) {
      case 'sleep': return 'sleep';
      case 'shower': return 'shower';
      case 'toilet_pee': return 'toilet_pee';
      case 'toilet_defecate': return 'toilet_defecate';
      case 'couch_phone': return 'couch_phone';
      case 'couch_tv': return 'couch_tv';
      default: return 'kitchen';
    }
  }

  /** advance one resident along its legs. Returns true if the leg list finished
   *  (only meaningful for one-shot routes like Mara's enter). */
  private stepLeg(r: Resident, dt: number, loop: boolean): boolean {
    if (!r.legs.length) return true;
    if (r.li >= r.legs.length) { if (loop) r.li = 0; else return true; }
    const leg = r.legs[r.li];
    const wt = this.worldOf(r, leg);
    r.h.setScale(leg.scale);
    const doorReach = (leg.aptDoor || leg.mainDoor) && (!leg.activity || leg.activity === 'walk');
    r.h.setActivity(doorReach ? 'door' : (leg.activity ?? 'walk'));
    r.h.target.copy(wt);
    const wy = this.worldYaw(r, leg);
    if (wy != null && leg.activity && leg.activity !== 'walk' && leg.activity !== 'stairs') r.h.targetYaw = wy;

    const eps = 0.30 * leg.scale + 0.008;
    const arrived = r.h.pos.distanceTo(wt) < eps;
    if (leg.dwell != null && leg.dwell > 0) {
      if (arrived) { r.hold += dt; if (r.hold >= leg.dwell) { r.hold = 0; return this.advance(r, loop); } }
    } else if (arrived) {
      return this.advance(r, loop);
    }
    return false;
  }

  private advance(r: Resident, loop: boolean): boolean {
    r.li++;
    if (r.li >= r.legs.length) { if (loop) r.li = 0; return true; }
    return false;
  }

  private swingDoors(): void {
    let mainOpen = false;
    const aptOpen = new Map<number, boolean>();
    for (const r of this.list) {
      if (r.isMara && !this.maraControlled) continue;
      const leg = r.legs[Math.min(r.li, r.legs.length - 1)];
      if (!leg) continue;
      if (leg.mainDoor) mainOpen = true;
      if (leg.aptDoor) aptOpen.set(r.apt.index, true);
    }
    // Mara's apt door while she is entering/near
    if (this.maraControlled) {
      const r = this.list[0];
      const leg = r.legs[Math.min(r.li, r.legs.length - 1)];
      if (leg?.mainDoor) mainOpen = true;
      if (this.maraPhase === 'inside' || leg?.aptDoor) { /* leave closed unless crossing */ }
    }
    swingDoor(this.b.mainDoor, mainOpen);
    for (const apt of this.b.apartments) swingDoor(apt.door, aptOpen.get(apt.index) ?? false);
  }

  // ---- leg construction ----------------------------------------------------
  /** full round-trip loop: outside → flat (climb) → live → reverse → out → away. */
  private buildLoop(apt: BuildingApt, index: number): Leg[] {
    const legs: Leg[] = [...this.buildEnter(apt)];
    // LIVE — rotate the activity plan by index so flats differ
    const n = PLAN.length;
    for (let j = 0; j < n; j++) {
      const p = PLAN[(index + j) % n];
      const s = apt.unit.spots[p.spot];
      if (!s) continue;
      legs.push({ frame: 'apt', x: s.x, y: s.y, z: s.z, scale: INT2, yaw: s.yaw, activity: p.activity, dwell: p.dwell });
    }
    // LEAVE (reverse of enter)
    legs.push(...this.buildLeave(apt));
    // OUT AND ABOUT (full size, brief)
    const away = this.ctx.awayWorld(index);
    legs.push({ frame: 'world', x: away.x, y: away.y, z: away.z, scale: 1, dwell: 5 });
    return legs;
  }

  private buildEnter(apt: BuildingApt): Leg[] {
    const legs: Leg[] = [];
    const a = this.ctx.mainApproachWorld;
    const B = (p: THREE.Vector3, extra: Partial<Leg> = {}) =>
      legs.push({ frame: 'building', x: p.x, y: p.y, z: p.z, scale: INT, ...extra });
    legs.push({ frame: 'world', x: a.x, y: a.y, z: a.z, scale: 1, mainDoor: true });
    B(this.b.lobbyInside, { mainDoor: true });
    B(this.b.stairFoot);
    for (let s = 0; s < apt.floor; s++) {
      for (const wp of this.b.storeyWaypoints[s]) B(wp, { activity: 'stairs' });
    }
    B(this.b.hallwayEntry(apt.floor));
    B(apt.hallApproach);
    B(apt.doorOutside, { aptDoor: true });
    B(apt.doorInside, { aptDoor: true });
    const e = apt.unit.spots.entry;
    legs.push({ frame: 'apt', x: e.x, y: e.y, z: e.z, scale: INT2, yaw: e.yaw, aptDoor: true });
    return legs;
  }

  private buildLeave(apt: BuildingApt): Leg[] {
    const legs: Leg[] = [];
    const B = (p: THREE.Vector3, extra: Partial<Leg> = {}) =>
      legs.push({ frame: 'building', x: p.x, y: p.y, z: p.z, scale: INT, ...extra });
    const e = apt.unit.spots.entry;
    legs.push({ frame: 'apt', x: e.x, y: e.y, z: e.z, scale: INT2, yaw: e.yaw, aptDoor: true });
    B(apt.doorInside, { aptDoor: true });
    B(apt.doorOutside, { aptDoor: true });
    B(apt.hallApproach);
    B(this.b.hallwayEntry(apt.floor));
    for (let s = apt.floor - 1; s >= 0; s--) {
      const wps = this.b.storeyWaypoints[s];
      for (let k = wps.length - 1; k >= 0; k--) B(wps[k], { activity: 'stairs' });
    }
    B(this.b.stairFoot);
    B(this.b.lobbyInside, { mainDoor: true });
    const a = this.ctx.mainApproachWorld;
    legs.push({ frame: 'world', x: a.x, y: a.y, z: a.z, scale: 1, mainDoor: true });
    return legs;
  }

  // ---- frame → world resolution -------------------------------------------
  private worldOf(r: Resident, leg: Leg): THREE.Vector3 {
    if (leg.frame === 'world') return new V(leg.x, leg.y, leg.z);
    if (leg.frame === 'building') return this.b.group.localToWorld(new V(leg.x, leg.y, leg.z));
    return r.apt.group.localToWorld(new V(leg.x, leg.y, leg.z));
  }
  private worldYaw(r: Resident, leg: Leg): number | undefined {
    if (leg.yaw == null) return undefined;
    if (leg.frame === 'world') return leg.yaw;
    if (leg.frame === 'building') return this.buildingYaw + leg.yaw;
    return this.yawOf(r.apt.group) + leg.yaw;
  }
  private yawOf(g: THREE.Object3D): number {
    g.updateMatrixWorld(true);
    const o = g.localToWorld(new V(0, 0, 0));
    const f = g.localToWorld(new V(0, 0, 1));
    return Math.atan2(f.x - o.x, f.z - o.z);
  }
}
