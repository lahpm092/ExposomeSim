// =============================================================================
// building.ts — the apartment BUILDING: a ground lobby with a main entrance,
// then N residential floors, each a central hallway with apartments on the two
// opposite sides, connected by real dogleg stairs in an end shaft. Modelled at
// real metres; the caller shrinks the whole thing to 1/4 (INT_SCALE) to stand it
// in the tower footprint — and each apartment is shrunk 1/4 AGAIN inside it, so a
// resident who crosses the main door shrinks ×1/4 and, crossing their own door,
// ×1/4 again (×1/16 overall). The nav waypoints below are all BUILDING-LOCAL.
//
//   building-local axes: +x along the hallway · +z toward the front (main door)
//   floors stack in +y (STOREY apart); the stair shaft is at the -x end.
// =============================================================================
import * as THREE from 'three';
import type { Kit } from './kit';
import type { CityMats } from './worldgeo';
import { makeKit } from './kit';
import { makeDoor, type DoorRef } from './doorkit';
import { buildApartmentUnit, type ApartmentUnit } from './apartmentUnit';

const V = THREE.Vector3;

// The SECOND projection: each apartment (modelled at real metres) is shrunk by
// this factor again inside the already-INT_SCALE building (×1/16 overall).
export const APT_SCALE = 1 / 4;

// ---- building parameters (parametric: bump N_FLOORS / PER_SIDE for more) ----
export const STOREY = 3.0;
const HALF = STOREY / 2;
export const N_FLOORS = 5;      // residential floors above the ground lobby (5×4 = 20 flats ≥ 18 agents)
const PER_SIDE = 2;             // apartments per side of the hallway, per floor
const COLS = [-2.6, 2.6];       // apartment column centres (x)  (PER_SIDE = COLS.length)
const APT_HALF_DEPTH = 2.8;     // apartment unit ZF (front) offset from its origin
const HALL_HZ = 1.0;            // hallway half-depth (z ∈ [-1,1])
// north apartments (front faces +z toward hallway at z=-HALL_HZ): origin z
const Z_NORTH = -(HALL_HZ + APT_HALF_DEPTH);   // = -3.8
const Z_SOUTH = +(HALL_HZ + APT_HALF_DEPTH);   // = +3.8
// stair shaft (−x end)
const XA = -6.9, XB = -5.7;     // two dogleg flight lanes
const SHAFT_X0 = -7.5, SHAFT_X1 = -5.1;
const SHAFT_Z = 1.5;            // flights run along z within ±SHAFT_Z
const HALL_X_END = 5.1;         // hallway extends to here (past the +x column)
const FRONT_Z = 6.7;            // building front face (main door plane), ground

export interface BuildingApt {
  index: number; floor: number; side: 'north' | 'south'; col: number;
  group: THREE.Group;          // apartment unit group (scaled INT within the building)
  unit: ApartmentUnit;
  door: DoorRef;               // entry door (child of the apartment group)
  hallApproach: THREE.Vector3; // hallway point in front of the door (building-local)
  doorOutside: THREE.Vector3;  // just outside the apartment door (building-local)
  doorInside: THREE.Vector3;   // just inside the threshold (building-local)
  name?: string;               // resident occupying it (assigned by the sim)
}

export interface Building {
  group: THREE.Group;                    // real metres; caller applies INT_SCALE
  mainDoor: DoorRef;
  mainOutside: THREE.Vector3;            // building-local, just outside the main door
  lobbyInside: THREE.Vector3;            // building-local, just inside the main door
  stairFoot: THREE.Vector3;             // building-local, foot of the stairs (ground)
  storeyWaypoints: THREE.Vector3[][];    // [s] climbs storey s (floorY s → s+1), building-local
  apartments: BuildingApt[];
  floorY: (floor: number) => number;
  hallwayEntry: (floor: number) => THREE.Vector3;  // where the stairs meet the floor's hallway
}

const floorY = (floor: number) => STOREY * floor;

// ---------------------------------------------------------------------------
// stair geometry for one storey (dogleg), plus its climb waypoints.
// ---------------------------------------------------------------------------
function doglegStorey(kit: Kit, yBase: number): { group: THREE.Group; waypoints: THREE.Vector3[] } {
  const g = kit.group();
  const steps = 9, riser = HALF / steps, tread = 0.26, width = 1.05;
  const zTopA = SHAFT_Z - 0.2 - steps * tread;   // top of flight A (climbing toward -z)
  const flight = (x: number, z0: number, dir: number, y0: number) => {
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

/** a see-through slab (floor plate) with an ink edge. */
function plate(kit: Kit, w: number, d: number, x: number, y: number, z: number): THREE.Group {
  return kit.boxAt(w, 0.1, d, x, y - 0.05, z, { edge: 'soft' });
}

export function buildBuilding(mats: CityMats): Building {
  const kit = makeKit(mats);
  const group = kit.group();
  const apartments: BuildingApt[] = [];
  const storeyWaypoints: THREE.Vector3[][] = [];

  const bx0 = SHAFT_X0, bx1 = HALL_X_END + 0.4;            // building x-extent
  const bWidth = bx1 - bx0, bCx = (bx0 + bx1) / 2;
  const bz0 = Z_NORTH - APT_HALF_DEPTH, bz1 = Z_SOUTH + APT_HALF_DEPTH; // z-extent

  // --- stairs: one dogleg per storey (ground→1, 1→2, …) --------------------
  for (let s = 0; s < N_FLOORS; s++) {
    const dl = doglegStorey(kit, floorY(s));
    group.add(dl.group);
    storeyWaypoints.push(dl.waypoints);
  }

  // --- ground lobby ---------------------------------------------------------
  group.add(plate(kit, bWidth, bz1 - bz0, bCx, 0, (bz0 + bz1) / 2));
  // main entrance (front-centre, +z face)
  const mainDoor = makeDoor(kit, group, -0.5, 0, FRONT_Z, 0, 1.0, 2.15);
  group.add(kit.boxAt(1.6, 0.05, 0.6, 0.3, 0, FRONT_Z - 0.2, { edge: 'faint' }));  // threshold mat
  group.add(kit.boxAt(1.2, 1.2, 0.15, 2.4, 0, FRONT_Z - 0.12, { edge: 'faint' })); // mailboxes
  const mainOutside = new V(0.0, 0, FRONT_Z + 1.2);
  const lobbyInside = new V(0.0, 0, FRONT_Z - 1.0);
  const stairFoot = new V(XA, 0, SHAFT_Z - 0.3);

  // --- residential floors ---------------------------------------------------
  let idx = 0;
  for (let f = 1; f <= N_FLOORS; f++) {
    const y = floorY(f);
    // floor plate with a stairwell void at the -x end (draw two plates around it)
    group.add(plate(kit, (SHAFT_X1 - bx0), bz1 - bz0, (bx0 + SHAFT_X1) / 2, y, (bz0 + bz1) / 2 + 0)); // (thin, over shaft too — cheap)
    group.add(plate(kit, (bx1 - SHAFT_X1), bz1 - bz0, (SHAFT_X1 + bx1) / 2, y, (bz0 + bz1) / 2));
    // hallway floor tint line + rails
    group.add(kit.line([SHAFT_X1, y + 0.01, -HALL_HZ, bx1, y + 0.01, -HALL_HZ, SHAFT_X1, y + 0.01, HALL_HZ, bx1, y + 0.01, HALL_HZ], 'faint'));
    // ceiling edge for this floor (top of the storey)
    group.add(kit.line([bx0, y + STOREY - 0.15, bz0, bx1, y + STOREY - 0.15, bz0], 'faint'));

    for (const side of ['north', 'south'] as const) {
      for (const col of COLS) {
        const unit = buildApartmentUnit(kit);
        const ug = unit.group;
        ug.scale.setScalar(APT_SCALE);   // the SECOND projection: apartment ×1/4 inside the building
        const yaw = side === 'north' ? 0 : Math.PI;
        // The apartment (modelled at metres) is shrunk ×1/4, so its footprint is
        // ~1.2×1.4 building-metres tucked just off the hallway. Its own front door
        // (unit-local z=ZF) then lands exactly on the hallway edge (z=∓HALL_HZ).
        ug.position.set(col, y, side === 'north' ? -HALL_HZ - unit.size.zf * APT_SCALE : HALL_HZ + unit.size.zf * APT_SCALE);
        ug.rotation.y = yaw;
        group.add(ug);

        // door + hallway anchors in BUILDING-local (unit door at unit-local ~(0.65,0,ZF)).
        const doorBuild = new V(0.65, 0, unit.size.zf).multiplyScalar(APT_SCALE)
          .applyAxisAngle(new V(0, 1, 0), yaw).add(ug.position);   // → (doorX, y, ∓HALL_HZ)
        const s = side === 'north' ? -1 : 1;                        // hallway→door direction in z
        apartments.push({
          index: idx, floor: f, side, col,
          group: ug, unit, door: unit.door,
          hallApproach: new V(doorBuild.x, y, s * (HALL_HZ - 0.5)),  // in the hallway, off the door
          doorOutside: new V(doorBuild.x, y, doorBuild.z - s * 0.12), // hallway side of the leaf
          doorInside: new V(doorBuild.x, y, doorBuild.z + s * 0.28),  // interior side → apartment frame
        });
        idx++;
      }
    }
  }

  // --- outline massing (very faint) so the block reads from a distance ------
  group.add(kit.line([
    bx0, 0, bz0, bx1, 0, bz0, bx1, 0, bz0, bx1, 0, bz1, bx1, 0, bz1, bx0, 0, bz1, bx0, 0, bz1, bx0, 0, bz0,
    bx0, floorY(N_FLOORS) + STOREY, bz0, bx1, floorY(N_FLOORS) + STOREY, bz0,
    bx1, floorY(N_FLOORS) + STOREY, bz0, bx1, floorY(N_FLOORS) + STOREY, bz1,
    bx1, floorY(N_FLOORS) + STOREY, bz1, bx0, floorY(N_FLOORS) + STOREY, bz1,
    bx0, floorY(N_FLOORS) + STOREY, bz1, bx0, floorY(N_FLOORS) + STOREY, bz0,
    bx0, 0, bz0, bx0, floorY(N_FLOORS) + STOREY, bz0, bx1, 0, bz0, bx1, floorY(N_FLOORS) + STOREY, bz0,
    bx1, 0, bz1, bx1, floorY(N_FLOORS) + STOREY, bz1, bx0, 0, bz1, bx0, floorY(N_FLOORS) + STOREY, bz1,
  ], 'faint'));

  const hallwayEntry = (floor: number) => new V(XB, floorY(floor), SHAFT_Z - 0.3);

  return {
    group, mainDoor, mainOutside, lobbyInside, stairFoot,
    storeyWaypoints, apartments, floorY, hallwayEntry,
  };
}
