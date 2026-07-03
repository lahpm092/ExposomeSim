// =============================================================================
// foodcourt.ts — a fast-food RESTAURANT modelled as a single-storey BUILDING,
// in the house line-work style (paper-filled low-poly solids that occlude, crisp
// black ink edges on top). Mirrors building.ts / apartmentUnit.ts conventions:
// everything is built through the shared kit at REAL metres, and the caller
// scales the whole group by INT_SCALE (1/4) to stand it in the town footprint.
//
//   building-local axes: +x runs ACROSS the building · +z points toward the FRONT
//   (main entrance / town centre). Floor at y=0 · one storey (~3.2 m ceiling).
//   Footprint ~9 m (x) × ~7 m (z).
//
// The plan, front (+z) to back (-z):
//   · a DINING area of tables + stools/benches by the front windows
//   · a SERVICE COUNTER across the middle (two registers), cashier behind it
//     facing the customers/door, an overhead HEAT-LAMP pass shelf, and a KITCHEN
//     line (grill / fryer / prep tower) behind that
//   · a small walled CLEANING CLOSET tucked in the back-left corner — its own
//     door, a MOP standing "at the end" (far corner) and a CHAIR to rest on
// Two movable props ride along with the group but stay individually reachable:
//   the cleaner's MOP (`mopProp`) and an amber A-frame WET-FLOOR sign (`wetSign`).
// Every nav anchor below is BUILDING-LOCAL metres (before the caller's INT_SCALE).
// =============================================================================
import * as THREE from 'three';
import type { Kit } from './kit';
import type { CityMats } from './worldgeo';
import { makeKit } from './kit';
import { makeDoor, type DoorRef } from './doorkit';

const V = THREE.Vector3;

// ---- building envelope (metres) --------------------------------------------
const HX = 4.5;              // half-width in x → 9 m across
const ZB = -3.5, ZF = 3.5;  // back / front faces → 7 m deep
const CEIL = 3.2;           // ceiling height

export interface FoodBuilding {
  group: THREE.Group;             // real metres; caller applies INT_SCALE
  mainDoor: DoorRef;
  mainOutside: THREE.Vector3;     // building-local point ~1.2 m OUTSIDE the main door (on +z)
  lobbyInside: THREE.Vector3;     // building-local point just INSIDE the main door
  counterStaff: { pos: THREE.Vector3; yaw: number };  // cashier stands behind the counter (faces +z/door)
  bossSpot:     { pos: THREE.Vector3; yaw: number };   // where the food-shop boss stands/supervises
  cleanWaypoints: THREE.Vector3[]; // floor points across the dining area where the cleaner mops (a route)
  cleanRoomChair: { pos: THREE.Vector3; yaw: number };  // sit spot on the chair inside the cleaning closet
  cleanRoomStand: THREE.Vector3;  // a stand point just inside the closet door (where the mop rests nearby)
  closetDoor: DoorRef;            // the cleaning closet's door
  mopProp: THREE.Group;           // movable mop (child of group)
  wetSign: THREE.Group;           // movable wet-floor A-frame sign (child of group)
}

// ---------------------------------------------------------------------------
// see-through walls: edge-only rectangles (never boxed in, so the camera can
// look straight into the room). Copied in spirit from apartmentUnit.ts.
// ---------------------------------------------------------------------------
function wallRectXY(kit: Kit, z: number, x0: number, x1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z], 'faint');
}
function wallRectZY(kit: Kit, x: number, z0: number, z1: number, y0: number, y1: number): THREE.LineSegments {
  return kit.line([x, y0, z0, x, y0, z1, x, y0, z1, x, y1, z1, x, y1, z1, x, y0, z1, x, y1, z1, x, y1, z0, x, y1, z0, x, y0, z0], 'faint');
}

/** a see-through floor plate with a soft ink edge (see building.ts `plate`). */
function plate(kit: Kit, w: number, d: number, x: number, y: number, z: number): THREE.Group {
  return kit.boxAt(w, 0.1, d, x, y - 0.05, z, { edge: 'soft' });
}

/** place a furniture group at (x,z) with yaw, add to parent (apartmentUnit `put`). */
function put(parent: THREE.Object3D, m: THREE.Group, x: number, z: number, yaw = 0): void {
  m.position.set(x, 0, z); m.rotation.y = yaw; parent.add(m);
}

// ---- furniture kits --------------------------------------------------------
/** a low-poly mop: a slim handle rising from a bundled head (strands splayed). */
function makeMop(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.cylAt(0.02, 1.3, 6, 0, 0.16, 0, { edge: 'ink' }));   // handle
  g.add(kit.cylAt(0.10, 0.16, 8, 0, 0, 0, { edge: 'soft' }));    // head bundle
  const st: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    st.push(Math.cos(a) * 0.05, 0.16, Math.sin(a) * 0.05, Math.cos(a) * 0.13, 0, Math.sin(a) * 0.13);
  }
  g.add(kit.line(st, 'soft'));                                   // strands
  return g;
}

/** a simple resting chair (seat + backrest + four legs); seat centred on x/z. */
function chair(kit: Kit): THREE.Group {
  const g = kit.group();               // faces +z (backrest at -z)
  g.add(kit.boxAt(0.42, 0.05, 0.42, 0, 0.45, 0, { edge: 'ink' }));      // seat
  g.add(kit.boxAt(0.42, 0.45, 0.05, 0, 0.45, -0.19, { edge: 'ink' }));  // backrest
  for (const [lx, lz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]] as const)
    g.add(kit.boxAt(0.04, 0.45, 0.04, lx, 0, lz, { edge: 'soft' }));    // legs
  return g;
}

/** a bar stool: a disc seat on a slim post. */
function stool(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.cylAt(0.04, 0.45, 6, 0, 0, 0, { edge: 'soft' }));    // post
  g.add(kit.cylAt(0.17, 0.05, 10, 0, 0.45, 0, { edge: 'ink' })); // seat
  return g;
}

/** a bench seat on two end panels (runs along local x). */
function bench(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.boxAt(1.1, 0.06, 0.34, 0, 0.44, 0, { edge: 'ink' }));       // seat
  g.add(kit.boxAt(0.06, 0.44, 0.30, -0.5, 0, 0, { edge: 'soft' }));     // left leg panel
  g.add(kit.boxAt(0.06, 0.44, 0.30, 0.5, 0, 0, { edge: 'soft' }));      // right leg panel
  return g;
}

/** a pedestal dining table with two seats (stools or benches). */
function diningTable(kit: Kit, seat: 'stool' | 'bench'): THREE.Group {
  const g = kit.group();
  g.add(kit.boxAt(0.5, 0.03, 0.5, 0, 0, 0, { edge: 'soft' }));   // foot
  g.add(kit.cylAt(0.06, 0.72, 6, 0, 0, 0, { edge: 'ink' }));     // pedestal
  g.add(kit.cylAt(0.45, 0.05, 12, 0, 0.72, 0, { edge: 'ink' })); // top
  if (seat === 'stool') {
    put(g, stool(kit), -0.72, 0);
    put(g, stool(kit), 0.72, 0);
  } else {
    put(g, bench(kit), 0, -0.62);
    put(g, bench(kit), 0, 0.62);
  }
  return g;
}

/** the service counter: body + overhanging top + two registers with tilted screens.
 *  customer side faces +z; the cashier works the -z side. */
function serviceCounter(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.boxAt(3.8, 1.0, 0.7, 0, 0, 0, { edge: 'ink' }));     // counter body
  g.add(kit.slab(4.0, 0.82, 0, 1.0, 0.04, { edge: 'ink' }));     // countertop (slight +z overhang)
  for (const rx of [-1.2, 0.9]) {                                // two registers
    g.add(kit.boxAt(0.5, 0.22, 0.4, rx, 1.04, 0.05, { edge: 'soft' }));   // register base
    const scr = kit.boxAt(0.42, 0.30, 0.03, rx, 1.26, 0.12, { edge: 'ink' });
    scr.rotation.x = -0.4; g.add(scr);                           // tilted screen
  }
  return g;
}

/** the kitchen line behind the counter: grill (with grate), fryer (baskets),
 *  and a prep/storage tower. Appliances face the pass (+z). */
function kitchenLine(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.boxAt(1.4, 0.9, 0.7, -1.6, 0, 0, { edge: 'ink' }));  // grill
  const grate: number[] = [];
  for (let i = 0; i < 5; i++) { const x = -2.2 + i * 0.3; grate.push(x, 0.92, -0.28, x, 0.92, 0.28); }
  g.add(kit.line(grate, 'soft'));                                // grill grate
  g.add(kit.boxAt(1.0, 0.9, 0.7, 0.2, 0, 0, { edge: 'ink' }));   // fryer
  g.add(kit.cylAt(0.12, 0.02, 10, 0.0, 0.9, 0, { edge: 'soft' }));  // fryer basket
  g.add(kit.cylAt(0.12, 0.02, 10, 0.4, 0.9, 0, { edge: 'soft' }));  // fryer basket
  g.add(kit.boxAt(1.2, 1.6, 0.6, 1.6, 0, -0.05, { edge: 'soft' })); // prep/storage tower
  return g;
}

/** a thin isoceles triangular panel (apex at the local origin, base hanging
 *  down), paper-filled so it occludes, outlined in the amber sign material. */
function triPanel(mats: CityMats, amber: THREE.LineBasicMaterial, wBase: number, hTop: number, thick: number): THREE.Group {
  const shape = new THREE.Shape();
  shape.moveTo(-wBase / 2, -hTop);
  shape.lineTo(wBase / 2, -hTop);
  shape.lineTo(0, 0);
  shape.lineTo(-wBase / 2, -hTop);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  geo.translate(0, 0, -thick / 2);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), amber));
  return g;
}

/** the movable A-frame "caution wet floor" sign: two triangular panels meeting
 *  at a top ridge, splayed apart at the base, outlined in amber for legibility. */
function makeWetSign(kit: Kit, mats: CityMats): THREE.Group {
  const g = kit.group();
  const amber = new THREE.LineBasicMaterial({ color: 0xc98a1f });
  const wBase = 0.46, hTop = 0.7, thick = 0.03, tilt = 0.3, ridgeY = 0.69;
  const front = triPanel(mats, amber, wBase, hTop, thick);
  front.position.y = ridgeY; front.rotation.x = tilt;   // base swings toward -z
  const back = triPanel(mats, amber, wBase, hTop, thick);
  back.position.y = ridgeY; back.rotation.x = -tilt;    // base swings toward +z
  g.add(front, back);
  return g;
}

export function buildFoodBuilding(mats: CityMats): FoodBuilding {
  const kit = makeKit(mats);
  const group = kit.group();

  // --- ground plate + faint floor grid --------------------------------------
  group.add(plate(kit, HX * 2, ZF - ZB, 0, 0, (ZB + ZF) / 2));
  const grid: number[] = [];
  for (let x = -4; x <= 4; x++) grid.push(x, 0.01, ZB, x, 0.01, ZF);
  for (let z = -3; z <= 3; z++) grid.push(-HX, 0.01, z, HX, 0.01, z);
  group.add(kit.line(grid, 'faint'));

  // --- see-through perimeter walls + ceiling outline (never box her in) ------
  group.add(wallRectXY(kit, ZB, -HX, HX, 0, CEIL));            // back
  group.add(wallRectZY(kit, -HX, ZB, ZF, 0, CEIL));           // left
  group.add(wallRectZY(kit, HX, ZB, ZF, 0, CEIL));            // right
  group.add(wallRectXY(kit, ZF, -HX, -0.6, 0, CEIL));         // front (left of door)
  group.add(wallRectXY(kit, ZF, 0.6, HX, 0, CEIL));           // front (right of door)
  group.add(kit.line([-0.6, 2.15, ZF, 0.6, 2.15, ZF], 'faint'));  // door header
  group.add(kit.line([                                        // ceiling rectangle
    -HX, CEIL, ZB, HX, CEIL, ZB, HX, CEIL, ZB, HX, CEIL, ZF,
    HX, CEIL, ZF, -HX, CEIL, ZF, -HX, CEIL, ZF, -HX, CEIL, ZB,
  ], 'faint'));

  // --- MAIN ENTRANCE (front-centre, +z face) --------------------------------
  const mainDoor = makeDoor(kit, group, -0.5, 0, ZF, 0, 1.0, 2.15);
  group.add(kit.boxAt(1.6, 0.05, 0.6, 0, 0, ZF - 0.35, { edge: 'faint' }));  // threshold mat
  group.add(kit.boxAt(1.8, 0.14, 0.7, 0, 2.35, ZF - 0.1, { edge: 'soft' })); // entrance canopy
  group.add(kit.boxAt(2.4, 0.8, 0.1, 0, 2.6, ZF + 0.02, { edge: 'ink' }));   // fascia sign board
  const mainOutside = new V(0, 0, ZF + 1.2);
  const lobbyInside = new V(0, 0, ZF - 1.0);

  // --- SERVICE COUNTER + registers ------------------------------------------
  put(group, serviceCounter(kit), -0.3, 0.35);
  const counterStaff = { pos: new V(-0.3, 0, -0.35), yaw: 0 };  // behind counter, faces +z/door

  // --- HEAT-LAMP pass shelf + KITCHEN line -----------------------------------
  group.add(kit.slab(3.2, 0.35, -0.3, 1.6, -0.55, { edge: 'soft' }));        // heat-lamp shelf
  for (const lx of [-1.4, -0.3, 0.8]) group.add(kit.cylAt(0.05, 0.1, 8, lx, 1.5, -0.55, { edge: 'soft' })); // heat lamps
  group.add(kit.boxAt(0.05, 1.6, 0.05, -1.8, 0, -0.5, { edge: 'soft' }));    // shelf post
  group.add(kit.boxAt(0.05, 1.6, 0.05, 1.2, 0, -0.5, { edge: 'soft' }));     // shelf post
  put(group, kitchenLine(kit), 0, -1.5);
  group.add(kit.boxAt(2.4, 0.7, 0.06, -0.4, 2.3, -1.9, { edge: 'ink' }));    // menu board
  group.add(kit.line([                                                        // menu text ticks
    -1.4, 2.5, -1.87, -0.2, 2.5, -1.87, -1.4, 2.3, -1.87, 0.2, 2.3, -1.87,
    -1.4, 2.1, -1.87, -0.4, 2.1, -1.87,
  ], 'faint'));

  // --- boss / supervisor spot (right end, watching the line & counter) ------
  const bossSpot = { pos: new V(1.9, 0, -0.9), yaw: -Math.PI / 2 };  // faces -x

  // --- DINING area (front windows) ------------------------------------------
  put(group, diningTable(kit, 'stool'), -2.9, 1.7);
  put(group, diningTable(kit, 'bench'), 2.9, 1.7);
  put(group, diningTable(kit, 'stool'), -2.9, 3.0);
  put(group, diningTable(kit, 'bench'), 2.9, 3.0);

  // --- CLEANING CLOSET (back-left corner): partition walls + door -----------
  group.add(wallRectZY(kit, -3.0, ZB, -2.0, 0, CEIL));         // partition (x=-3.0)
  group.add(wallRectXY(kit, -2.0, -HX, -3.75, 0, CEIL));       // partition (z=-2.0, left of door)
  group.add(kit.line([-3.75, 2.0, -2.0, -3.0, 2.0, -2.0], 'faint'));  // closet door header
  const closetDoor = makeDoor(kit, group, -3.75, 0, -2.0, 0, 0.75, 2.0);
  // the MOP "at the end" — standing in the far (back-left) corner
  put(group, makeMop(kit), -4.25, -3.25);
  // a CHAIR to rest on, against the back wall, facing the door (+z)
  put(group, chair(kit), -3.7, -3.0, 0);
  const cleanRoomChair = { pos: new V(-3.7, 0, -3.0), yaw: 0 };  // sit on the chair
  const cleanRoomStand = new V(-3.4, 0, -2.45);                  // just inside the door

  // --- movable props (children of group, individually reachable) ------------
  const mopProp = makeMop(kit);
  mopProp.position.set(-3.3, 0, -2.5);   // starts resting by the closet door
  group.add(mopProp);
  const wetSign = makeWetSign(kit, mats);
  wetSign.position.set(0, 0, 1.8);       // starts out in the dining area
  group.add(wetSign);

  // --- cleaning route across the dining floor -------------------------------
  const cleanWaypoints = [
    new V(0, 0, 1.3),
    new V(-1.9, 0, 2.3),
    new V(0, 0, 2.9),
    new V(1.9, 0, 2.3),
    new V(0, 0, 1.9),
  ];

  return {
    group, mainDoor, mainOutside, lobbyInside,
    counterStaff, bossSpot, cleanWaypoints,
    cleanRoomChair, cleanRoomStand, closetDoor,
    mopProp, wetSign,
  };
}
