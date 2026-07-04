// =============================================================================
// agentbodies.ts — the bodies of the ten agents, driven by the SIM (not by an
// autonomous render loop). Each frame every humanoid is told, from its agent's
// public state (place · role · station · activity), where to be and what to do,
// and this module walks it there across three buildings:
//   home    — the apartment tower  (lobby → stairs → hallway → flat)
//   food    — the fast-food venue   (counter · kitchen · mop route · supply room)
//   office  — the office building    (lobby → stairs → desks · hallway commons)
//
// ONE REAL-METRE SCALE THROUGHOUT. The body is the same size on the street, in a
// building and in a flat (INT_SCALE = APT_SCALE = 1), so it never changes size at a
// door. On entering a building it walks to the outside approach, pauses a beat at
// the leaf while the door swings, and steps through — the leg scales below all
// resolve to 1, so the pause is just a natural beat, not a projection change.
// (This module used to shrink the body ×1/4 at the main door and ×1/4 again at the
// flat door; the shrink legs remain as door-pause beats now that the scales are 1.)
//
// Positions are resolved to WORLD once per route (the buildings are static), so a
// leg is just {world, scale, activity, door}. When the route is spent the body
// HOLDS at its station and retargets live as the sim changes the station/activity.
// =============================================================================
import * as THREE from 'three';
import type { Building } from './building';
import type { FoodBuilding } from './foodcourt';
import type { OfficeBuilding } from './office';
import { APT_SCALE } from './building';
import { INT_SCALE } from './worldgeo';
import type { Humanoid } from './humanoid';
import type { ActivityKind } from './poses';
import { swingDoor, type DoorRef } from './doorkit';
import type { AgentPublic } from '../types';
import { ROSTER, OFFICE_DESK_BY_ID } from '../harness/roster';

const V = THREE.Vector3;
const INT = INT_SCALE;              // building-interior body scale (now 1 — unified)
const INT2 = INT_SCALE * APT_SCALE; // apartment-interior body scale (now 1 — unified)

type Region = 'outside' | 'home' | 'food' | 'office';
type DoorTag = 'home_main' | 'food_main' | 'office_main' | 'apt' | 'closet' | 'desk';

interface Leg {
  world: THREE.Vector3;
  scale: number;
  yaw?: number;
  activity?: ActivityKind;
  dwell?: number;       // sim-seconds to hold here (for the shrink-in-place beat)
  door?: DoorTag;       // this door is "in use" while the body is on this leg
  doorIndex?: number;   // apt/desk index for the specific door
}

interface Body {
  idx: number;
  h: Humanoid;
  region: Region;
  legs: Leg[];
  li: number;
  hold: number;
  transiting: boolean;
}

export interface Buildings {
  home: Building; homeGroup: THREE.Group;
  food: FoodBuilding; foodGroup: THREE.Group;
  office: OfficeBuilding; officeGroup: THREE.Group;
}

export class AgentBodies {
  private bodies: Body[] = [];
  // door-open flags gathered each frame
  private doorState = {
    home_main: false, food_main: false, office_main: false, closet: false,
    apt: new Set<number>(), desk: new Set<number>(),
  };

  constructor(private b: Buildings, humanoids: Humanoid[]) {
    // freeze world matrices so localToWorld is stable for anchor resolution.
    this.b.homeGroup.updateMatrixWorld(true);
    this.b.foodGroup.updateMatrixWorld(true);
    this.b.officeGroup.updateMatrixWorld(true);
    humanoids.forEach((h, idx) => {
      h.setHat(ROSTER[idx].hatColor);
      this.bodies.push({ idx, h, region: 'outside', legs: [], li: 0, hold: 0, transiting: false });
    });
  }

  // ------------------------------------------------------------- per frame
  /** drive every agent whose body we own. `skip(idx)` lets the caller keep control
   *  of an agent elsewhere (e.g. Mara out in the wider city). */
  update(agents: AgentPublic[], dt: number, skip: (idx: number) => boolean): void {
    this.resetDoors();
    for (const body of this.bodies) {
      const a = agents[body.idx];
      if (!a || skip(body.idx)) continue;
      const want = regionOf(a.place);
      // a change of destination INTERRUPTS a stale route immediately (don't finish
      // walking all the way home just to turn round and leave for work).
      if (want !== 'outside' && want !== body.region) {
        this.beginEnter(body, want, a);
      }
      if (body.transiting) this.stepTransit(body, dt);
      else this.hold(body, a);
    }
    this.applyDoors();
  }

  /** snap-to-approach + build the shrink-before-door entrance route into `want`. */
  private beginEnter(body: Body, want: Region, a: AgentPublic): void {
    body.region = want;
    body.transiting = true;
    body.li = 0; body.hold = 0;
    body.legs = this.enterRoute(want, a);
    if (body.legs.length) {
      const first = body.legs[0];
      body.h.place(first.world, first.yaw ?? body.h.yaw);
      body.h.setScale(first.scale);
    }
  }

  private stepTransit(body: Body, dt: number): void {
    if (body.li >= body.legs.length) { body.transiting = false; return; }
    const leg = body.legs[body.li];
    body.h.setScale(leg.scale);
    const onStairs = leg.activity === 'stairs';
    body.h.setActivity(leg.door ? 'door' : (leg.activity ?? 'walk'));
    body.h.target.copy(leg.world);
    if (leg.yaw != null && (onStairs || leg.dwell)) body.h.targetYaw = leg.yaw;
    if (leg.door) this.flagDoor(leg);

    const eps = 0.32 * leg.scale + 0.01;
    const arrived = body.h.pos.distanceTo(leg.world) < eps;
    if (leg.dwell != null && leg.dwell > 0) {
      if (arrived) { body.hold += dt; if (body.hold >= leg.dwell) { body.hold = 0; body.li++; } }
    } else if (arrived) {
      body.li++;
    }
    if (body.li >= body.legs.length) body.transiting = false;
  }

  /** hold at the sim-chosen station, retargeting live. */
  private hold(body: Body, a: AgentPublic): void {
    const dst = this.station(body.region, a);
    if (!dst) return;
    body.h.setScale(dst.scale);
    // the phone swaps the POSE (head down, screen up) while leaving the STATION keyed
    // on the real activity — so a desk worker scrolls at their desk, a sleeper in bed.
    const pose: ActivityKind = a.onPhone ? phonePoseFor((a.activity as ActivityKind) ?? 'stand') : ((a.activity as ActivityKind) ?? 'stand');
    body.h.setActivity(pose);
    body.h.target.copy(dst.world);
    if (dst.yaw != null) body.h.targetYaw = dst.yaw;
    // keep the relevant door ajar while someone is present in that pocket of space
    if (a.place === 'home' && a.mode !== 'commuting') this.doorState.apt.add(a.homeIndex);
    if (body.region === 'food' && a.role === 'cleaner' && a.station < 0) this.doorState.closet = true;
    if (body.region === 'office' && (a.activity === 'sit_desk')) this.doorState.desk.add(deskIndexFor(a));
    // move the cleaning props with the mopping cleaner
    if (body.region === 'food' && a.role === 'cleaner') this.placeCleanProps(a);
  }

  // ------------------------------------------------------------- stations
  private station(region: Region, a: AgentPublic): { world: THREE.Vector3; scale: number; yaw?: number } | null {
    if (region === 'home') {
      const apt = this.b.home.apartments[a.homeIndex % this.b.home.apartments.length];
      const spot = apt.unit.spots[String(a.activity)] ?? apt.unit.spots.couch_tv ?? apt.unit.spots.entry;
      return { world: apt.group.localToWorld(new V(spot.x, spot.y, spot.z)), scale: INT2, yaw: this.groupYaw(apt.group) + (spot.yaw ?? 0) };
    }
    if (region === 'food') {
      const f = this.b.food;
      if (a.role === 'cleaner') {
        if (a.station < 0) return this.foodWorld(f.cleanRoomChair.pos, f.cleanRoomChair.yaw);
        const wp = f.cleanWaypoints[a.station % f.cleanWaypoints.length];
        return this.foodWorld(wp, this.groupYaw(this.b.foodGroup));
      }
      if (a.role === 'food_boss') return this.foodWorld(f.bossSpot.pos, f.bossSpot.yaw);
      return this.foodWorld(f.counterStaff.pos, f.counterStaff.yaw); // cashier / default
    }
    if (region === 'office') {
      const o = this.b.office;
      const di = deskIndexFor(a);
      const desk = o.desks[di % o.desks.length];
      if (a.activity === 'sit_desk') {
        return { world: this.b.officeGroup.localToWorld(desk.seat.clone()), scale: INT, yaw: this.groupYaw(this.b.officeGroup) + desk.seatYaw };
      }
      // wandering to a hallway gathering spot ON THIS AGENT'S FLOOR — so a floor-2
      // worker mills on floor 2, never teleporting to floor 1's hall.
      const floor = desk?.floor ?? 1;
      const cs = o.commonsByFloor[floor] ?? o.commonsByFloor[1] ?? [];
      if (!cs.length) return null;
      const c = cs[a.station % cs.length];
      // stand a little apart at the gathering spot and face its centre, so a pair
      // of talkers read as facing each other rather than merging into one figure.
      const off = ((di % 3) - 1) * 0.6;   // -0.6 / 0 / +0.6 lateral
      const spot = c.clone(); spot.x += off;
      const world = this.b.officeGroup.localToWorld(spot.clone());
      const centre = this.b.officeGroup.localToWorld(c.clone());
      const yaw = Math.atan2(centre.x - world.x, centre.z - world.z);
      return { world, scale: INT, yaw: off === 0 ? this.groupYaw(this.b.officeGroup) : yaw };
    }
    return null;
  }

  private foodWorld(local: THREE.Vector3, yaw: number): { world: THREE.Vector3; scale: number; yaw: number } {
    return { world: this.b.foodGroup.localToWorld(local.clone()), scale: INT, yaw };
  }

  // ------------------------------------------------------------- routes
  private enterRoute(want: Region, a: AgentPublic): Leg[] {
    if (want === 'home') return this.homeRoute(a);
    if (want === 'food') return this.foodRoute();
    if (want === 'office') return this.officeRoute(a);
    return [];
  }

  private homeRoute(a: AgentPublic): Leg[] {
    const b = this.b.home, g = this.b.homeGroup;
    const apt = b.apartments[a.homeIndex % b.apartments.length];
    const W = (local: THREE.Vector3) => g.localToWorld(local.clone());
    const aptW = (local: { x: number; y: number; z: number }) => apt.group.localToWorld(new V(local.x, local.y, local.z));
    const approach = W(b.mainOutside);
    const legs: Leg[] = [];
    legs.push({ world: approach.clone(), scale: 1, door: 'home_main', dwell: 0.15 });          // arrive full size
    legs.push({ world: approach.clone(), scale: INT, door: 'home_main', dwell: 0.35 });         // SHRINK in place, at the door
    legs.push({ world: W(b.lobbyInside), scale: INT, door: 'home_main' });                       // cross (already small)
    legs.push({ world: W(b.stairFoot), scale: INT });
    for (let s = 0; s < apt.floor; s++) for (const wp of b.storeyWaypoints[s]) legs.push({ world: W(wp), scale: INT, activity: 'stairs' });
    legs.push({ world: W(b.hallwayEntry(apt.floor)), scale: INT });
    legs.push({ world: W(apt.hallApproach), scale: INT });
    legs.push({ world: W(apt.doorOutside), scale: INT, door: 'apt', doorIndex: apt.index, dwell: 0.15 });       // at the flat door
    legs.push({ world: W(apt.doorOutside), scale: INT2, door: 'apt', doorIndex: apt.index, dwell: 0.3 });        // SHRINK again before it opens
    const e = apt.unit.spots.entry;
    legs.push({ world: aptW(e), scale: INT2, yaw: this.groupYaw(apt.group) + e.yaw, door: 'apt', doorIndex: apt.index });
    return legs;
  }

  private foodRoute(): Leg[] {
    const f = this.b.food, g = this.b.foodGroup;
    const W = (local: THREE.Vector3) => g.localToWorld(local.clone());
    const approach = W(f.mainOutside);
    return [
      { world: approach.clone(), scale: 1, door: 'food_main', dwell: 0.15 },
      { world: approach.clone(), scale: INT, door: 'food_main', dwell: 0.35 },   // shrink before the door
      { world: W(f.lobbyInside), scale: INT, door: 'food_main' },
    ];
  }

  private officeRoute(a: AgentPublic): Leg[] {
    const o = this.b.office, g = this.b.officeGroup;
    const W = (local: THREE.Vector3) => g.localToWorld(local.clone());
    const approach = W(o.mainOutside);
    const desk = o.desks[deskIndexFor(a) % o.desks.length];
    const floor = desk?.floor ?? 1;
    const legs: Leg[] = [
      { world: approach.clone(), scale: 1, door: 'office_main', dwell: 0.15 },
      { world: approach.clone(), scale: INT, door: 'office_main', dwell: 0.35 },  // shrink before the door
      { world: W(o.lobbyInside), scale: INT, door: 'office_main' },
      { world: W(o.stairFoot), scale: INT },
    ];
    for (let s = 0; s < floor; s++) for (const wp of (o.storeyWaypoints[s] ?? [])) legs.push({ world: W(wp), scale: INT, activity: 'stairs' });
    legs.push({ world: W(o.hallwayEntry(floor)), scale: INT });
    if (desk) legs.push({ world: W(desk.walkTo), scale: INT });
    return legs;
  }

  // ------------------------------------------------------------- props + doors
  private placeCleanProps(a: AgentPublic): void {
    const f = this.b.food;
    if (a.station >= 0) {
      // cleaning: mop + wet-floor sign travel to the current waypoint
      const wp = f.cleanWaypoints[a.station % f.cleanWaypoints.length];
      f.mopProp.position.set(wp.x + 0.25, wp.y, wp.z);
      f.mopProp.visible = true;
      f.wetSign.position.set(wp.x - 0.5, wp.y, wp.z + 0.3);
      f.wetSign.visible = true;
    } else {
      // resting: park the mop back by the closet, hide the sign
      f.mopProp.position.copy(f.cleanRoomStand);
      f.wetSign.visible = false;
    }
  }

  private resetDoors(): void {
    this.doorState.home_main = this.doorState.food_main = this.doorState.office_main = this.doorState.closet = false;
    this.doorState.apt.clear(); this.doorState.desk.clear();
    // the wet-floor sign only shows while someone is actively mopping; the mop
    // rests by the supply-room door unless a cleaner is carrying it along the route.
    this.b.food.wetSign.visible = false;
    this.b.food.mopProp.position.copy(this.b.food.cleanRoomStand);
  }
  private flagDoor(leg: Leg): void {
    if (leg.door === 'home_main') this.doorState.home_main = true;
    else if (leg.door === 'food_main') this.doorState.food_main = true;
    else if (leg.door === 'office_main') this.doorState.office_main = true;
    else if (leg.door === 'apt' && leg.doorIndex != null) this.doorState.apt.add(leg.doorIndex);
    else if (leg.door === 'closet') this.doorState.closet = true;
    else if (leg.door === 'desk' && leg.doorIndex != null) this.doorState.desk.add(leg.doorIndex);
  }
  private applyDoors(): void {
    swingDoor(this.b.home.mainDoor, this.doorState.home_main);
    swingDoor(this.b.food.mainDoor, this.doorState.food_main);
    swingDoor(this.b.office.mainDoor, this.doorState.office_main);
    swingDoor(this.b.food.closetDoor, this.doorState.closet);
    for (const apt of this.b.home.apartments) swingDoor(apt.door, this.doorState.apt.has(apt.index));
    for (const desk of this.b.office.desks) swingDoorSafe(desk.door, this.doorState.desk.has(desk.index));
  }

  /** debug snapshot of each body's routing state. */
  debug(): { idx: number; region: Region; transiting: boolean; li: number; legs: number; scale: number; pose: string }[] {
    return this.bodies.map((b) => ({
      idx: b.idx, region: b.region, transiting: b.transiting, li: b.li, legs: b.legs.length,
      scale: +b.h.object.scale.x.toFixed(3), pose: b.h.currentActivity,
    }));
  }

  private groupYaw(g: THREE.Object3D): number {
    g.updateMatrixWorld(true);
    const o = g.localToWorld(new V(0, 0, 0));
    const f = g.localToWorld(new V(0, 0, 1));
    return Math.atan2(f.x - o.x, f.z - o.z);
  }
}

// ---- helpers ----------------------------------------------------------------
function regionOf(place: AgentPublic['place']): Region {
  return place === 'home' ? 'home' : place === 'foodcourt' ? 'food' : place === 'office' ? 'office' : 'outside';
}

/** the phone pose to play over a given base activity (position stays keyed on the
 *  base activity; only the arms/head + phone prop change). */
function phonePoseFor(base: ActivityKind): ActivityKind {
  switch (base) {
    case 'sleep': return 'phone_bed';
    case 'couch_tv': case 'couch_phone': return 'couch_phone';
    case 'sit_desk': case 'sit_rest': return 'phone_desk';
    default: return 'phone_stand';
  }
}

/** an office agent's GLOBAL desk index (from the shared roster assignment). While
 *  desk-working the sim already puts that index in station; otherwise derive the
 *  stable seat from the roster's per-floor assignment. */
function deskIndexFor(a: AgentPublic): number {
  if (a.activity === 'sit_desk') return a.station;
  return OFFICE_DESK_BY_ID[a.id] ?? 0;
}

function swingDoorSafe(d: DoorRef | undefined, open: boolean): void {
  if (d) swingDoor(d, open);
}
