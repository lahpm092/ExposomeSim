// =============================================================================
// office.ts — the OFFICE building: a ground lobby with a main entrance, then ONE
// office floor reached by real dogleg stairs in an end shaft. The office floor is
// a central hallway with SIX identical small offices (three per side, opposite
// walls, just like the apartment building) plus ONE larger boss office at the far
// end of the hall. Every office holds a desk and a WHEELED office chair (its own
// group, so the sim can roll/spin it). Modelled at real metres; the caller shrinks
// the whole thing to 1/4 (INT_SCALE) to stand it in the town footprint. All nav +
// seat anchors below are BUILDING-LOCAL (before INT_SCALE).
//
//   building-local axes: +x along the hallway · +z toward the front (main door)
//   floors stack in +y (STOREY apart); the stair shaft is at the -x end.
//
// Mirrors building.ts: the dogleg-stair helper, floorY, storeyWaypoints and
// hallwayEntry are the same shapes; the small offices are placed north/south of
// the hall exactly as building.ts places its apartments (yaw 0 vs π).
// =============================================================================
import * as THREE from 'three';
import type { CityMats } from './worldgeo';
import type { Kit } from './kit';
import { makeKit } from './kit';
import { makeDoor, type DoorRef } from './doorkit';
import { OFFICE_FLOORS, OFFICE_COMMONS_PER_FLOOR } from '../mind/roster';

const V = THREE.Vector3;
const YAXIS = new THREE.Vector3(0, 1, 0);

// ---- building parameters ---------------------------------------------------
export const STOREY = 3.0;
const HALF = STOREY / 2;
const HALL_HZ = 1.4;               // hallway half-depth (z ∈ [-HALL_HZ, HALL_HZ])
const OFFICE_DEPTH = 2.6;          // small-office depth (front z=0 → back z=-DEPTH)
const Z_EXT = HALL_HZ + OFFICE_DEPTH + 0.2;      // building z half-extent (= 4.2)
const OFFICE_COLS = [-3.0, 0.0, 3.0];            // small-office column centres (x)

/** column x-centres for `perSide` small offices on one side of a hallway. */
function columnsFor(perSide: number): number[] {
  if (perSide >= 3) return OFFICE_COLS;
  if (perSide === 2) return [OFFICE_COLS[0], OFFICE_COLS[2]]; // -3, +3
  if (perSide === 1) return [OFFICE_COLS[1]];                 // 0
  return [];
}
// stair shaft (−x end) — identical layout to building.ts
const XA = -6.9, XB = -5.7;        // two dogleg flight lanes
const SHAFT_X0 = -7.5, SHAFT_X1 = -5.1;
const SHAFT_Z = 1.5;               // flights run along z within ±SHAFT_Z
const FRONT_Z = Z_EXT;             // building front face (main door plane), ground
// boss office (far +x end): front on the hall, extends into +x
const BOSS_FRONT_X = 5.6;
const BOSS_DEPTH = 3.6;

export interface OfficeDesk {
  index: number;               // 0..5 = employees, 6 = boss
  isBoss: boolean;
  walkTo: THREE.Vector3;       // building-local floor point beside the chair (stand before sitting)
  seat: THREE.Vector3;         // sit point on the chair
  seatYaw: number;             // facing (0 = +z)
  chair: THREE.Group;          // the wheeled chair (child of group)
  floor: number;               // which storey the desk is on
  door: DoorRef;               // this office's door
}

export interface OfficeBuilding {
  group: THREE.Group;                 // real metres; caller applies INT_SCALE
  mainDoor: DoorRef;
  mainOutside: THREE.Vector3;         // ~1.2 m OUTSIDE the main door (+z)
  lobbyInside: THREE.Vector3;         // just inside the main door
  stairFoot: THREE.Vector3;           // foot of the stairs (ground)
  storeyWaypoints: THREE.Vector3[][]; // [s] = climb waypoints for storey s (ground→1, ...)
  hallwayEntry: (floor: number) => THREE.Vector3;  // where stairs meet that floor's hallway
  desks: OfficeDesk[];                // all desks across every floor (index === array pos)
  commonsByFloor: THREE.Vector3[][];  // [floor] → hallway gather points on that storey
  floorY: (floor: number) => number;
}

const floorY = (floor: number): number => STOREY * floor;

// ---------------------------------------------------------------------------
// stair geometry for one storey (dogleg), plus its climb waypoints.
// Replicated from building.ts (the helper there is not exported).
// ---------------------------------------------------------------------------
function doglegStorey(kit: Kit, yBase: number): { group: THREE.Group; waypoints: THREE.Vector3[] } {
  const g = kit.group();
  const steps = 9, riser = HALF / steps, tread = 0.26, width = 1.05;
  const zTopA = SHAFT_Z - 0.2 - steps * tread;   // top of flight A (climbing toward -z)
  const flight = (x: number, z0: number, dir: number, y0: number): void => {
    for (let i = 0; i < steps; i++) {
      const y = y0 + i * riser, z = z0 + dir * i * tread;
      g.add(kit.boxAt(width, 0.05, tread, x, y + riser, z + dir * tread / 2, { edge: 'soft' }));
      g.add(kit.boxAt(width, riser, 0.035, x, y, z, { edge: 'faint' }));
    }
    const rail: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const y = y0 + i * riser + 0.9, z = z0 + dir * i * tread;
      if (i < steps) { const y2 = y0 + (i + 1) * riser + 0.9, z2 = z0 + dir * (i + 1) * tread; rail.push(x - width / 2, y, z, x - width / 2, y2, z2); }
      if (i % 3 === 0) rail.push(x - width / 2, y - 0.9, z, x - width / 2, y, z);
    }
    kit.add(g, kit.line(rail, 'soft'));
  };
  flight(XA, SHAFT_Z - 0.2, -1, yBase);                                       // A: +z → -z
  g.add(kit.boxAt(XB - XA + width, 0.06, 1.0, (XA + XB) / 2, yBase + HALF, zTopA - 0.3, { edge: 'soft' })); // landing
  flight(XB, zTopA + 0.1, +1, yBase + HALF);                                  // B: -z → +z
  const waypoints = [
    new V(XA, yBase + 0.05, SHAFT_Z - 0.3),
    new V(XA, yBase + HALF, zTopA - 0.1),
    new V(XB, yBase + HALF, zTopA),
    new V(XB, yBase + STOREY, SHAFT_Z - 0.3),
  ];
  return { group: g, waypoints };
}

/** a see-through slab (floor plate) with a soft ink edge. */
function plate(kit: Kit, w: number, d: number, x: number, y: number, z: number): THREE.Group {
  return kit.boxAt(w, 0.1, d, x, y - 0.05, z, { edge: 'soft' });
}

// ---- see-through partition walls (edge-only, so the camera looks in) --------
function wallXY(kit: Kit, z: number, x0: number, x1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z], 'faint');
}
function wallZY(kit: Kit, x: number, z0: number, z1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x, y0, z0, x, y0, z1, x, y0, z1, x, y1, z1, x, y1, z1, x, y0, z1, x, y1, z1, x, y1, z0, x, y1, z0, x, y0, z0], 'faint');
}

// ---------------------------------------------------------------------------
// a low-poly WHEELED office chair — its own group so the sim can roll/spin it.
// Seat faces +z by default; backrest at -z. Central gas post over a 5-star base
// whose splayed legs each end in a little castor wheel. Sit-point ≈ (0,0.50,0).
// ---------------------------------------------------------------------------
function officeChair(kit: Kit): THREE.Group {
  const g = kit.group();
  const legLen = 0.30;
  for (let i = 0; i < 5; i++) {                                   // 5-star base + castors
    const leg = kit.group();
    leg.add(kit.boxAt(legLen, 0.05, 0.07, legLen / 2, 0.03, 0, { edge: 'soft' }));   // splayed leg
    leg.add(kit.cylAt(0.05, 0.07, 6, legLen, 0, 0, { edge: 'soft' }));               // castor wheel
    leg.rotation.y = (i / 5) * Math.PI * 2;
    g.add(leg);
  }
  g.add(kit.cylAt(0.06, 0.03, 8, 0, 0.05, 0, { edge: 'soft' }));                      // hub
  g.add(kit.cylAt(0.035, 0.40, 8, 0, 0.09, 0, { edge: 'ink' }));                      // gas post
  g.add(kit.boxAt(0.50, 0.09, 0.48, 0, 0.46, 0, { edge: 'ink' }));                    // seat pan (top ≈0.55)
  g.add(kit.boxAt(0.46, 0.52, 0.08, 0, 0.55, -0.24, { edge: 'ink' }));               // backrest (-z)
  g.add(kit.boxAt(0.06, 0.20, 0.34, -0.27, 0.46, 0.02, { edge: 'soft' }));           // left armrest
  g.add(kit.boxAt(0.06, 0.20, 0.34, 0.27, 0.46, 0.02, { edge: 'soft' }));            // right armrest
  return g;
}

/** a desk with worktop, side panels, a drawer pedestal + a monitor facing the sitter (+z side). */
function officeDesk(kit: Kit, big: boolean): THREE.Group {
  const g = kit.group();                                          // worktop faces +z; monitor on the -z side
  const w = big ? 1.9 : 1.4, d = big ? 0.9 : 0.7, top = 0.74;
  g.add(kit.boxAt(w, 0.05, d, 0, top, 0, { edge: 'ink' }));                            // worktop
  g.add(kit.boxAt(0.06, top, d - 0.08, -w / 2 + 0.05, 0, 0, { edge: 'soft' }));       // left leg panel
  g.add(kit.boxAt(0.06, top, d - 0.08, w / 2 - 0.05, 0, 0, { edge: 'soft' }));        // right leg panel
  g.add(kit.boxAt(w - 0.12, top - 0.12, 0.04, 0, 0, -d / 2 + 0.05, { edge: 'soft' })); // modesty panel (-z)
  g.add(kit.boxAt(0.42, top - 0.06, d - 0.14, w / 2 - 0.3, 0, 0, { edge: 'soft' }));  // drawer pedestal
  g.add(kit.line([w / 2 - 0.3, 0.5, 0.02 + (d - 0.14) / 2, w / 2 - 0.3, 0.5, -0.02 + (d - 0.14) / 2], 'faint')); // drawer pull
  g.add(kit.boxAt(0.07, 0.16, 0.07, 0, top, -d / 2 + 0.16, { edge: 'soft' }));        // monitor stand
  g.add(kit.boxAt(big ? 0.62 : 0.52, 0.34, 0.03, 0, top + 0.20, -d / 2 + 0.18, { edge: 'ink' })); // screen (faces +z)
  g.add(kit.boxAt(0.36, 0.02, 0.14, 0, top, 0.12, { edge: 'faint' }));                // keyboard hint
  return g;
}

interface OfficeRoom {
  group: THREE.Group;
  door: DoorRef;
  chair: THREE.Group;
  walkToLocal: THREE.Vector3;
  seatLocal: THREE.Vector3;
  seatYawLocal: number;
}

// ---------------------------------------------------------------------------
// ONE office room, modelled at real metres. Local frame: front (+z) faces the
// hallway (the door is here); back wall at z=-depth; width spans x∈[-hx,hx]. The
// desk sits against the back wall (monitor facing +z); the chair sits in front of
// it, spun 180° so the worker faces -z (into the desk). walkTo is on the floor
// beside the chair; seat is the sit-point on the chair (facing -z ⇒ yaw = π).
// ---------------------------------------------------------------------------
function buildOfficeRoom(kit: Kit, hx: number, depth: number, ceil: number, doorW: number, big: boolean): OfficeRoom {
  const g = kit.group();
  const zb = -depth;
  const doorHz = doorW / 2;
  // partition walls (edge-only, see-through)
  g.add(wallXY(kit, zb, -hx, hx, 0, ceil));                       // back
  g.add(wallZY(kit, -hx, zb, 0, 0, ceil));                       // left
  g.add(wallZY(kit, hx, zb, 0, 0, ceil));                        // right
  g.add(wallXY(kit, 0, -hx, -doorHz, 0, ceil));                  // front (left of door)
  g.add(wallXY(kit, 0, doorHz, hx, 0, ceil));                    // front (right of door)
  g.add(kit.line([-doorHz, 2.05, 0, doorHz, 2.05, 0], 'faint')); // door header
  g.add(kit.line([                                                // ceiling edge rectangle
    -hx, ceil, 0, hx, ceil, 0, hx, ceil, 0, hx, ceil, zb,
    hx, ceil, zb, -hx, ceil, zb, -hx, ceil, zb, -hx, ceil, 0,
  ], 'faint'));

  // furniture
  const deskZ = zb + (big ? 0.85 : 0.7);                          // desk against the back wall
  const desk = officeDesk(kit, big); desk.position.set(0, 0, deskZ); g.add(desk);
  const chairZ = deskZ + (big ? 0.9 : 0.75);                      // chair just in front of the desk
  const chair = officeChair(kit); chair.position.set(0, 0, chairZ); chair.rotation.y = Math.PI; g.add(chair);
  if (big) {                                                      // boss: a bookshelf against the left wall
    const shelf = kit.boxAt(0.4, 1.8, 1.4, -hx + 0.25, 0, zb + 1.6, { edge: 'ink' }); g.add(shelf);
    g.add(kit.line([-hx + 0.05, 0.9, zb + 0.9, -hx + 0.05, 0.9, zb + 2.3], 'faint'));
  }

  // door on the front wall (z=0), hinge at -doorHz so the leaf spans the gap
  const door = makeDoor(kit, g, -doorHz, 0, 0, 0, doorW, 2.05);

  return {
    group: g, door, chair,
    walkToLocal: new V(hx - 0.55, 0, chairZ + 0.25),
    seatLocal: new V(0, 0.50, chairZ),
    seatYawLocal: Math.PI,
  };
}

const smallOffice = (kit: Kit): OfficeRoom => buildOfficeRoom(kit, 1.3, OFFICE_DEPTH, 2.6, 0.9, false);
const bossOffice = (kit: Kit): OfficeRoom => buildOfficeRoom(kit, 2.0, BOSS_DEPTH, 2.8, 1.0, true);

export function buildOfficeBuilding(mats: CityMats): OfficeBuilding {
  const kit = makeKit(mats);
  const group = kit.group();
  const desks: OfficeDesk[] = [];
  const storeyWaypoints: THREE.Vector3[][] = [];
  const commonsByFloor: THREE.Vector3[][] = [];

  const N = OFFICE_FLOORS.length;                               // office storeys (above the lobby)
  const bx0 = SHAFT_X0, bx1 = BOSS_FRONT_X + BOSS_DEPTH + 0.4;   // building x-extent
  const bWidth = bx1 - bx0, bCx = (bx0 + bx1) / 2;
  const bz0 = -Z_EXT, bz1 = Z_EXT;                               // building z-extent

  // local→building transform for a placed room (position + yaw about y)
  const toBuild = (local: THREE.Vector3, pos: THREE.Vector3, yaw: number): THREE.Vector3 =>
    local.clone().applyAxisAngle(YAXIS, yaw).add(pos);

  // --- stairs: one dogleg per storey (ground→1, 1→2, 2→3) -------------------
  for (let s = 0; s < N; s++) {
    const dl = doglegStorey(kit, floorY(s));
    group.add(dl.group);
    storeyWaypoints.push(dl.waypoints);
  }

  // --- ground lobby ---------------------------------------------------------
  group.add(plate(kit, bWidth, bz1 - bz0, bCx, 0, 0));
  const mainDoor = makeDoor(kit, group, -0.5, 0, FRONT_Z, 0, 1.0, 2.15);          // main entrance (front-centre)
  group.add(kit.boxAt(1.7, 0.05, 0.6, 0.0, 0, FRONT_Z - 0.25, { edge: 'faint' })); // threshold mat
  group.add(kit.boxAt(1.9, 1.05, 0.6, -2.2, 0, FRONT_Z - 1.5, { edge: 'ink' }));  // reception desk
  group.add(kit.boxAt(0.9, 1.4, 0.12, -2.2, 0, FRONT_Z - 2.0, { edge: 'faint' })); // reception sign board
  const mainOutside = new V(0.0, 0, FRONT_Z + 1.2);
  const lobbyInside = new V(0.0, 0, FRONT_Z - 1.0);
  const stairFoot = new V(XA, 0, SHAFT_Z - 0.3);

  // --- the office storeys ---------------------------------------------------
  // desks are pushed in EXACTLY officeDeskSlots() order (worker desks per floor,
  // then that floor's boss desk if any) so a desk's array index is its global id.
  for (const spec of OFFICE_FLOORS) {
    const Yf = floorY(spec.floor);
    // floor plate split around the stairwell void at the -x end
    group.add(plate(kit, (SHAFT_X1 - bx0), bz1 - bz0, (bx0 + SHAFT_X1) / 2, Yf, 0));
    group.add(plate(kit, (bx1 - SHAFT_X1), bz1 - bz0, (SHAFT_X1 + bx1) / 2, Yf, 0));
    group.add(kit.line([SHAFT_X1, Yf + 0.01, -HALL_HZ, bx1, Yf + 0.01, -HALL_HZ, SHAFT_X1, Yf + 0.01, HALL_HZ, bx1, Yf + 0.01, HALL_HZ], 'faint'));
    group.add(kit.line([bx0, Yf + STOREY - 0.15, bz0, bx1, Yf + STOREY - 0.15, bz0], 'faint'));

    // small offices: `perSide` NORTH (yaw 0), `perSide` SOUTH (yaw π)
    const perSide = Math.ceil(spec.workerDesks / 2);
    const cols = columnsFor(perSide);
    let placed = 0;
    for (const side of ['north', 'south'] as const) {
      for (const col of cols) {
        if (placed >= spec.workerDesks) break;
        const room = smallOffice(kit);
        const yaw = side === 'north' ? 0 : Math.PI;
        const pos = new V(col, Yf, side === 'north' ? -HALL_HZ : HALL_HZ);
        room.group.position.copy(pos);
        room.group.rotation.y = yaw;
        group.add(room.group);
        desks.push({
          index: desks.length, isBoss: false,
          walkTo: toBuild(room.walkToLocal, pos, yaw),
          seat: toBuild(room.seatLocal, pos, yaw),
          seatYaw: room.seatYawLocal + yaw,
          chair: room.chair, floor: spec.floor, door: room.door,
        });
        placed++;
      }
    }

    // boss office at the far +x end (front faces -x, into the hall)
    if (spec.hasBoss) {
      const room = bossOffice(kit);
      const yaw = -Math.PI / 2;
      const pos = new V(BOSS_FRONT_X, Yf, 0);
      room.group.position.copy(pos);
      room.group.rotation.y = yaw;
      group.add(room.group);
      desks.push({
        index: desks.length, isBoss: true,
        walkTo: toBuild(room.walkToLocal, pos, yaw),
        seat: toBuild(room.seatLocal, pos, yaw),
        seatYaw: room.seatYawLocal + yaw,
        chair: room.chair, floor: spec.floor, door: room.door,
      });
    }

    // hallway commons for this floor — evenly spaced along the hall, alternating
    // sides so a pair drifting to the same spot reads as meeting, not merging.
    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < OFFICE_COMMONS_PER_FLOOR; i++) {
      const t = OFFICE_COMMONS_PER_FLOOR > 1 ? i / (OFFICE_COMMONS_PER_FLOOR - 1) : 0.5;
      const x = -4.2 + t * 9.0;              // span the hall from the stair end toward +x
      const z = (i % 2 === 0 ? 0.35 : -0.35);
      spots.push(new V(x, Yf, z));
    }
    commonsByFloor[spec.floor] = spots;
  }

  // --- outline massing (very faint) so the block reads from a distance ------
  const top = floorY(N) + STOREY;
  group.add(kit.line([
    bx0, 0, bz0, bx1, 0, bz0, bx1, 0, bz0, bx1, 0, bz1, bx1, 0, bz1, bx0, 0, bz1, bx0, 0, bz1, bx0, 0, bz0,
    bx0, top, bz0, bx1, top, bz0, bx1, top, bz0, bx1, top, bz1, bx1, top, bz1, bx0, top, bz1, bx0, top, bz1, bx0, top, bz0,
    bx0, 0, bz0, bx0, top, bz0, bx1, 0, bz0, bx1, top, bz0, bx1, 0, bz1, bx1, top, bz1, bx0, 0, bz1, bx0, top, bz1,
  ], 'faint'));

  const hallwayEntry = (floor: number): THREE.Vector3 => new V(XB, floorY(floor), SHAFT_Z - 0.3);

  return {
    group, mainDoor, mainOutside, lobbyInside, stairFoot,
    storeyWaypoints, hallwayEntry, desks, commonsByFloor, floorY,
  };
}
