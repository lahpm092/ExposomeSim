// =============================================================================
// apartmentUnit.ts — ONE reusable apartment, modelled at real metres. A clean
// multi-room flat: a bedroom zone (proper bed), a SEPARATE walled bathroom room
// (toilet + shower + sink, own door), a living zone (couch facing a TV), and a
// kitchen run. Built from the low-poly kit so every activity SPOT is placed by
// hand and lands exactly on its fixture.
//
//   local frame: floor at y=0 · front (+z) faces the building hallway (the door
//   is here) · back wall at -z · width spans x∈[-HX,HX].
//
// The building instances this many times (one per resident) and shrinks each to
// 1/4 within the already-1/4 building group — the double-projection trick.
// =============================================================================
import * as THREE from 'three';
import type { Kit } from './kit';
import { makeDoor, type DoorRef } from './doorkit';

export interface Spot { x: number; y: number; z: number; yaw: number; }
export interface ApartmentUnit {
  group: THREE.Group;
  door: DoorRef;                     // entry door on the +z (hallway) wall
  doorLocal: THREE.Vector3;          // entry hinge, unit-local
  bathDoor: DoorRef;                 // interior bathroom door
  spots: Record<string, Spot>;       // activity anchors, unit-local
  size: { hx: number; zf: number; zb: number; ceil: number };
}

// room envelope (metres)
const HX = 2.4, ZB = -2.8, ZF = 2.8, CEIL = 2.5;

/** a see-through wall drawn as an edge rectangle in the x–y or z–y plane. */
function wallRectXY(kit: Kit, z: number, x0: number, x1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z], 'faint');
}
function wallRectZY(kit: Kit, x: number, z0: number, z1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x, y0, z0, x, y0, z1, x, y0, z1, x, y1, z1, x, y1, z1, x, y0, z1, x, y1, z1, x, y1, z0, x, y1, z0, x, y0, z0], 'faint');
}

function bed(kit: Kit): THREE.Group {
  const g = kit.group();               // faces +z, head (pillows) at -z
  kit.add(g, kit.boxAt(1.4, 0.30, 2.0, 0, 0, 0, { edge: 'ink' }));           // frame
  kit.add(g, kit.boxAt(1.3, 0.22, 1.9, 0, 0.30, 0, { edge: 'soft' }));       // mattress
  kit.add(g, kit.boxAt(1.32, 0.14, 1.15, 0, 0.44, 0.30, { edge: 'soft' }));  // duvet (lower 2/3)
  kit.add(g, kit.boxAt(1.06, 0.12, 0.34, 0, 0.46, -0.72, { edge: 'soft' })); // pillow
  kit.add(g, kit.boxAt(1.42, 0.95, 0.08, 0, 0, -1.02, { edge: 'ink' }));     // headboard
  kit.add(g, kit.boxAt(0.42, 0.5, 0.42, 1.0, 0, -0.72, { edge: 'ink' }));    // nightstand
  return g;
}

function couch(kit: Kit): THREE.Group {
  const g = kit.group();               // faces +z; backrest at -z
  kit.add(g, kit.boxAt(1.5, 0.30, 0.78, 0, 0, 0, { edge: 'ink' }));          // base
  kit.add(g, kit.boxAt(1.28, 0.14, 0.6, 0, 0.30, 0.06, { edge: 'soft' }));   // seat cushion
  kit.add(g, kit.boxAt(1.5, 0.52, 0.16, 0, 0.30, -0.35, { edge: 'ink' }));   // backrest
  kit.add(g, kit.boxAt(0.16, 0.52, 0.74, -0.75, 0, 0, { edge: 'soft' }));    // left arm
  kit.add(g, kit.boxAt(0.16, 0.52, 0.74, 0.75, 0, 0, { edge: 'soft' }));     // right arm
  return g;
}

function tvStand(kit: Kit): THREE.Group {
  const g = kit.group();               // screen faces -z (toward the couch)
  kit.add(g, kit.boxAt(1.3, 0.4, 0.35, 0, 0, 0, { edge: 'ink' }));           // console
  kit.add(g, kit.boxAt(0.34, 0.05, 0.16, 0, 0.4, -0.02, { edge: 'soft' }));  // foot
  kit.add(g, kit.boxAt(1.12, 0.66, 0.05, 0, 0.44, -0.04, { edge: 'ink' }));  // panel
  kit.add(g, kit.line([                                                       // screen bezel (-z face)
    -0.5, 0.52, -0.07, 0.5, 0.52, -0.07, 0.5, 0.52, -0.07, 0.5, 0.98, -0.07,
    0.5, 0.98, -0.07, -0.5, 0.98, -0.07, -0.5, 0.98, -0.07, -0.5, 0.52, -0.07,
  ], 'faint'));
  return g;
}

function toilet(kit: Kit): THREE.Group {
  const g = kit.group();               // faces +z; tank at -z
  kit.add(g, kit.boxAt(0.36, 0.42, 0.46, 0, 0, -0.06, { edge: 'ink' }));     // pedestal
  const bowl = kit.cyl(0.19, 0.14, 12, { edge: 'ink' }); bowl.scale.set(1, 1, 1.15); bowl.position.set(0, 0.30, 0.06); g.add(bowl);
  kit.add(g, kit.slab(0.42, 0.5, 0, 0.44, 0.06, { edge: 'ink' }));           // seat/lid
  kit.add(g, kit.boxAt(0.46, 0.5, 0.18, 0, 0.30, -0.30, { edge: 'ink' }));   // cistern/tank
  kit.add(g, kit.knob(0.05, 0, 0.82, -0.30, { edge: 'soft' }));              // flush button
  return g;
}

function shower(kit: Kit): THREE.Group {
  const g = kit.group();               // head on the -x/-z back corner
  kit.add(g, kit.boxAt(0.95, 0.06, 0.95, 0, 0, 0, { edge: 'ink' }));         // tray
  kit.add(g, kit.boxAt(0.95, 1.95, 0.03, 0, 0.06, 0.48, { edge: 'ink', fill: false }));  // front glass
  kit.add(g, kit.boxAt(0.03, 1.95, 0.95, 0.48, 0.06, 0, { edge: 'ink', fill: false }));  // side glass
  kit.add(g, kit.cylAt(0.025, 1.7, 6, -0.42, 0.06, -0.42, { edge: 'soft' }));// riser
  kit.add(g, kit.boxAt(0.05, 0.06, 0.32, -0.42, 1.62, -0.30, { edge: 'soft' })); // arm
  kit.add(g, kit.cylAt(0.12, 0.05, 10, -0.42, 1.56, -0.16, { edge: 'ink' })); // head disc
  return g;
}

function sink(kit: Kit): THREE.Group {
  const g = kit.group();               // faces -x
  kit.add(g, kit.boxAt(0.42, 0.80, 0.6, 0, 0, 0, { edge: 'ink' }));          // cabinet
  kit.add(g, kit.slab(0.48, 0.66, 0, 0.80, 0, { edge: 'ink' }));             // counter
  const basin = kit.cyl(0.13, 0.09, 10, { edge: 'soft' }); basin.position.set(-0.02, 0.82, 0); g.add(basin);
  kit.add(g, kit.boxAt(0.42, 0.62, 0.02, -0.19, 1.0, 0, { edge: 'soft' }));  // mirror
  return g;
}

function kitchen(kit: Kit): THREE.Group {
  const g = kit.group();               // counter run along +z, opens toward -x (into room)
  kit.add(g, kit.boxAt(0.6, 0.9, 2.0, 0, 0, 0, { edge: 'ink' }));            // base run
  kit.add(g, kit.slab(0.64, 2.04, 0, 0.92, 0, { edge: 'ink' }));            // worktop
  kit.add(g, kit.cylAt(0.09, 0.02, 10, -0.12, 0.93, 0.4, { edge: 'soft' })); // burner
  kit.add(g, kit.cylAt(0.09, 0.02, 10, -0.12, 0.93, 0.72, { edge: 'soft' }));// burner
  kit.add(g, kit.boxAt(0.62, 1.8, 0.6, 0, 0, -1.3, { edge: 'ink' }));        // fridge
  kit.add(g, kit.line([-0.31, 1.1, -1.0, 0.31, 1.1, -1.0], 'soft'));         // fridge door split
  kit.add(g, kit.boxAt(0.6, 0.5, 2.0, 0, 1.6, 0.0, { edge: 'soft' }));       // upper cabinets
  return g;
}

/** place a furniture group at (x,z) with yaw, add to parent. */
function put(parent: THREE.Object3D, m: THREE.Group, x: number, z: number, yaw = 0): void {
  m.position.set(x, 0, z); m.rotation.y = yaw; parent.add(m);
}

export function buildApartmentUnit(kit: Kit): ApartmentUnit {
  const group = kit.group();

  // --- floor + rug + ceiling ------------------------------------------------
  const floor = kit.boxAt(HX * 2, 0.1, ZF - ZB, 0, -0.1, (ZB + ZF) / 2, { edge: 'soft' });
  group.add(floor);
  group.add(kit.line(ring(1.0, 20, 0.02, -1.2, 0.9), 'faint'));  // living-room rug
  // ceiling as an edge rectangle only (see down into the flat)
  group.add(wallRectXY(kit, ZB, -HX, HX, CEIL, CEIL));

  // --- outer walls (edge-only, see-through) ---------------------------------
  group.add(wallRectXY(kit, ZB, -HX, HX, 0, CEIL));             // back
  group.add(wallRectZY(kit, -HX, ZB, ZF, 0, CEIL));            // left
  group.add(wallRectZY(kit, HX, ZB, ZF, 0, CEIL));             // right
  group.add(wallRectXY(kit, ZF, -HX, 0.2, 0, CEIL));           // front (left of door)
  group.add(wallRectXY(kit, ZF, 1.1, HX, 0, CEIL));            // front (right of door)
  group.add(kit.line([0.2, 2.05, ZF, 1.1, 2.05, ZF], 'faint')); // door header

  // --- bathroom room (back-right): partition walls + interior door ----------
  group.add(wallRectZY(kit, 0.8, ZB, -1.0, 0, CEIL));                    // partition (x=0.8)
  group.add(wallRectXY(kit, -1.0, 0.8, 1.55, 0, CEIL));                  // partition (z=-1.0, left of door)
  group.add(kit.line([1.55, 2.0, -1.0, 2.35, 2.0, -1.0], 'faint'));      // bath door header
  const bathDoor = makeDoor(kit, group, 1.6, 0, -1.0, 0, 0.75, 2.0);

  // --- fixtures -------------------------------------------------------------
  put(group, bed(kit), -1.5, -1.85, 0);        // bedroom: back-left, head at -z
  put(group, couch(kit), -1.2, 0.55, 0);       // living: couch faces +z (toward TV)
  put(group, tvStand(kit), -1.2, 2.55, 0);     // TV on the front wall, screen faces -z
  put(group, kit.boxAt(0.9, 0.3, 0.5, 0, 0.15, 0, { edge: 'soft' }), -1.2, 1.5, 0); // coffee table
  put(group, toilet(kit), 1.95, -2.35, 0);     // bathroom: toilet faces +z
  put(group, shower(kit), 1.25, -2.30, 0);     // bathroom: shower stall
  put(group, sink(kit), 2.28, -1.5, 0);        // bathroom: sink on right wall
  put(group, kitchen(kit), 2.1, 1.2, 0);       // kitchen: right wall, front half

  // --- entry door (front wall, hallway side) --------------------------------
  const door = makeDoor(kit, group, 0.2, 0, ZF, 0, 0.9, 2.05);

  // --- activity spots (unit-local; pose rootDY handles seat/bed height) -----
  const spots: Record<string, Spot> = {
    sleep: { x: -1.5, y: 0, z: -1.75, yaw: 0 },          // lie on the bed, head toward -z
    couch_tv: { x: -1.2, y: 0, z: 0.55, yaw: 0 },        // sit facing +z (TV)
    couch_phone: { x: -1.2, y: 0, z: 0.55, yaw: 0 },
    toilet_defecate: { x: 1.95, y: 0, z: -2.18, yaw: 0 },// sit on the bowl, face +z
    toilet_pee: { x: 1.95, y: 0, z: -1.75, yaw: Math.PI },// stand facing the bowl (-z)
    shower: { x: 1.25, y: 0, z: -2.25, yaw: Math.PI },   // stand on the tray, face the head
    kitchen: { x: 1.4, y: 0, z: 1.2, yaw: Math.PI / 2 }, // stand at the counter (face +x)
    entry: { x: 0.65, y: 0, z: 2.15, yaw: Math.PI },     // just inside, facing the room (-z)
  };

  return { group, door, doorLocal: door.hingeLocal.clone(), bathDoor, spots, size: { hx: HX, zf: ZF, zb: ZB, ceil: CEIL } };
}

// a flat ring of line segments (rug), centred at (cx,cz), height y.
function ring(r: number, seg: number, y: number, cx = 0, cz = 0): number[] {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r, cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r);
  }
  return pts;
}
