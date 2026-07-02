// =============================================================================
// apartment.ts — Mara's apartment COMPLEX, modelled at real-metre scale inside a
// group the caller shrinks to 1/8 (the "step through the door and shrink" trick):
// so the whole building (lobby → dogleg stairs → 2nd-floor hallway → her studio)
// is drawn at human scale yet occupies an eighth of the footprint. A cutaway
// (open front, +z) lets the orbit camera look straight in.
//
//   ground (y=0): lobby + hinged ENTRANCE door
//   stairs: two real half-turn (dogleg) flights + half-landings + handrails
//   2nd floor (y=5.4): hallway → hinged STUDIO door → a realistic studio flat
//
// The furniture/appliances (kitchen, bathroom, bed, living) are injected — they
// are authored by separate low-poly modelling agents against `kit`. The climb
// PATH (enterPath) is owned here so it always tracks the stairs exactly.
// =============================================================================
import * as THREE from 'three';
import type { Kit } from './kit';

const STOREY = 2.7;            // floor-to-floor height
const F2 = 2 * STOREY;         // her floor: y = 5.4
const HALF = STOREY / 2;       // landing height within a storey

export type FurnitureFn = (kit: Kit) => THREE.Group;
export interface Furniture {
  kitchen?: FurnitureFn; bathroom?: FurnitureFn; bed?: FurnitureFn; living?: FurnitureFn;
}

export interface DoorRef { pivot: THREE.Group; open: boolean; }
export interface Apartment {
  group: THREE.Group;
  entrance: DoorRef;
  studioDoor: DoorRef;
  enterPath: THREE.Vector3[];                 // lobby → stairs → hallway → studio
  studioSpots: Record<string, { x: number; y: number; z: number; yaw?: number }>;
}

// ---------------------------------------------------------------------------
// a hinged door leaf: hinge axis at local x=0, leaf extends +x. Rotate the
// returned pivot about y to swing it. Panelled + lever handle.
// ---------------------------------------------------------------------------
function doorLeaf(kit: Kit, w = 0.9, h = 2.05): THREE.Group {
  const pivot = kit.group();
  const leaf = kit.group();
  const slab = kit.boxAt(w, h, 0.045, w / 2, 0, 0); leaf.add(slab);         // base at y=0, extends +x
  // two recessed panels
  const pz = 0.03;
  kit.add(leaf, kit.line([
    0.14, 0.28, pz, w - 0.14, 0.28, pz, w - 0.14, 0.28, pz, w - 0.14, 0.92, pz,
    w - 0.14, 0.92, pz, 0.14, 0.92, pz, 0.14, 0.92, pz, 0.14, 0.28, pz,
    0.14, 1.06, pz, w - 0.14, 1.06, pz, w - 0.14, 1.06, pz, w - 0.14, 1.78, pz,
    w - 0.14, 1.78, pz, 0.14, 1.78, pz, 0.14, 1.78, pz, 0.14, 1.06, pz,
  ], 'faint'));
  // lever handle near the free edge
  const lever = kit.boxAt(0.14, 0.03, 0.03, w - 0.12, 1.02, 0.05); leaf.add(lever);
  pivot.add(leaf);
  return pivot;
}

/** door casing (static jambs + head) around an opening of width w at the leaf's home. */
function doorCasing(kit: Kit, w = 0.9, h = 2.05): THREE.Group {
  const g = kit.group();
  kit.add(g, kit.boxAt(0.06, h + 0.05, 0.12, -0.03, 0, 0));
  kit.add(g, kit.boxAt(0.06, h + 0.05, 0.12, w + 0.03, 0, 0));
  kit.add(g, kit.boxAt(w + 0.12, 0.07, 0.12, w / 2, h, 0));
  return g;
}

// ---------------------------------------------------------------------------
// one storey of a half-turn (dogleg) stair: flight A climbs along -z, a
// half-landing turns 180°, flight B climbs back along +z one bay over in x.
// Returns the group and the climb waypoints (bottom → … → top).
// ---------------------------------------------------------------------------
function doglegStorey(kit: Kit, yBase: number): { group: THREE.Group; waypoints: THREE.Vector3[] } {
  const g = kit.group();
  const steps = 8;                 // per flight
  const riser = HALF / steps;      // ~0.169 m
  const tread = 0.28;
  const width = 1.05;
  const xA = -2.15, xB = -0.85;    // the two flight lanes
  const zTop = -0.35 - steps * tread; // top of flight A (climbing toward -z)

  const flight = (x: number, z0: number, dir: number, y0: number) => {
    for (let i = 0; i < steps; i++) {
      const y = y0 + i * riser;
      const z = z0 + dir * i * tread;
      // a step = tread slab riding on a riser face
      const t = kit.boxAt(width, 0.05, tread, x, y + riser, z + dir * tread / 2); g.add(t);
      const r = kit.boxAt(width, riser, 0.04, x, y, z + dir * 0.0, { edge: 'soft' }); g.add(r);
    }
    // raked stringer along the outer side
    const sx = x + dir * 0 - (width / 2) * 0 + (x === xA ? -width / 2 : width / 2);
    void sx;
    // handrail: a raked bar ~0.9 above the nosings with a few balusters
    const rail: number[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const y = y0 + i * riser + 0.9, z = z0 + dir * i * tread;
      if (i < steps) { const y2 = y0 + (i + 1) * riser + 0.9, z2 = z0 + dir * (i + 1) * tread; rail.push(x - width / 2, y, z, x - width / 2, y2, z2); }
      if (i % 2 === 0) rail.push(x - width / 2, y - 0.9, z, x - width / 2, y, z); // baluster
    }
    kit.add(g, kit.line(rail, 'soft'));
  };

  flight(xA, -0.35, -1, yBase);                 // flight A: y0..y0+1.35 toward -z
  // half-landing (full-width slab) at mid height
  const landing = kit.boxAt(1.7, 0.06, 1.0, -1.5, yBase + HALF, zTop - 0.3); g.add(landing);
  flight(xB, zTop + 0.15, +1, yBase + HALF);    // flight B: back toward +z, up to y0+2.7
  // newel posts at the landing
  kit.add(g, kit.boxAt(0.08, 0.95, 0.08, -0.35, yBase + HALF, zTop - 0.3));

  const waypoints = [
    new THREE.Vector3(xA, yBase + 0.1, -0.2),
    new THREE.Vector3(xA, yBase + HALF, zTop - 0.1),
    new THREE.Vector3(xB, yBase + HALF, zTop),
    new THREE.Vector3(xB, yBase + STOREY, -0.2),
  ];
  return { group: g, waypoints };
}

// ---------------------------------------------------------------------------
// the whole complex
// ---------------------------------------------------------------------------
export function buildApartment(kit: Kit, F: Furniture = {}): Apartment {
  const group = kit.group();
  const HX = 3.0;                // half-width
  const ZBACK = -3.4, ZFRONT = 0.4; // open cutaway at +z (ZFRONT)
  const DEPTH = ZFRONT - ZBACK;
  // walls are EDGE-ONLY wireframe (no paper fill) so the camera sees the whole
  // sectioned building through them — a black-mesh dollhouse.
  const wall = (w: number, h: number, d: number, x: number, y: number, z: number) =>
    kit.add(group, kit.boxAt(w, h, d, x, y, z, { edge: 'faint', fill: false }));

  // --- shell: back + side walls, floor slabs per storey (cutaway front) -----
  wall(HX * 2, F2 + 2.6, 0.12, 0, 0, ZBACK - 0.06);            // back wall (full height)
  wall(0.12, F2 + 2.6, DEPTH, -HX - 0.06, 0, (ZBACK + ZFRONT) / 2); // left wall
  wall(0.12, F2 + 2.6, DEPTH, HX + 0.06, 0, (ZBACK + ZFRONT) / 2);  // right wall
  for (const y of [0, STOREY, F2]) {
    // floor slab with a stairwell void on the left third
    kit.add(group, kit.boxAt(HX * 2 - 2.2, 0.12, DEPTH, 1.1, y - 0.12, (ZBACK + ZFRONT) / 2, { edge: 'soft' }));
    if (y === 0) kit.add(group, kit.boxAt(2.2, 0.12, DEPTH, -1.9, y - 0.12, (ZBACK + ZFRONT) / 2, { edge: 'soft' }));
  }
  // roof over the studio (edge-only so we can see down into the flat)
  kit.add(group, kit.boxAt(HX * 2, 0.12, DEPTH, 0, F2 + 2.5, (ZBACK + ZFRONT) / 2, { edge: 'soft', fill: false }));

  // --- stairs: two dogleg storeys, placed in the left shaft ------------------
  const s1 = doglegStorey(kit, 0), s2 = doglegStorey(kit, STOREY);
  group.add(s1.group, s2.group);

  // --- ground-floor lobby + hinged ENTRANCE door (front-right) ---------------
  kit.add(group, kit.boxAt(1.2, 1.2, 0.15, 2.2, 0, ZFRONT - 0.1, { edge: 'faint' })); // mailboxes
  const entCasing = doorCasing(kit, 1.0, 2.1); entCasing.position.set(0.2, 0, ZFRONT); group.add(entCasing);
  const entrance = doorLeaf(kit, 1.0, 2.1); entrance.position.set(0.2, 0, ZFRONT); entrance.rotation.y = -0.02; group.add(entrance);
  kit.add(group, kit.boxAt(1.4, 0.04, 0.5, 0.7, 0, ZFRONT + 0.1, { edge: 'faint' })); // threshold mat

  // --- 2nd-floor hallway partition + her hinged STUDIO door ------------------
  // partition between the front hallway strip and the studio behind it
  wall(HX * 2 - 2.4, 2.4, 0.1, 1.1, F2, -0.5);
  const studCasing = doorCasing(kit, 0.9, 2.05); studCasing.position.set(1.0, F2, -0.45); group.add(studCasing);
  const studioDoor = doorLeaf(kit, 0.9, 2.05); studioDoor.position.set(1.0, F2, -0.45); group.add(studioDoor);
  // a neighbour's (static, closed) door further along the hallway
  const nb = doorLeaf(kit, 0.9, 2.05); nb.position.set(-0.2, F2, -0.45); group.add(nb);

  // --- the STUDIO (floor 2, behind the partition) — realistic zoned plan -----
  // bathroom nook (back-right corner) with its own walls + door
  wall(1.7, 2.3, 0.1, 2.15, F2, -1.5);                    // nook front wall
  wall(0.1, 2.3, 1.9, 1.35, F2, -2.35);                   // nook side wall
  const bathCasing = doorCasing(kit, 0.7, 2.0); bathCasing.position.set(1.5, F2, -1.5); group.add(bathCasing);
  const bathDoor = doorLeaf(kit, 0.7, 2.0); bathDoor.position.set(1.5, F2, -1.5); bathDoor.rotation.y = -1.0; group.add(bathDoor);
  // a window on the studio back wall
  kit.add(group, kit.line([
    -2.4, F2 + 0.9, ZBACK + 0.02, -1.2, F2 + 0.9, ZBACK + 0.02, -1.2, F2 + 0.9, ZBACK + 0.02, -1.2, F2 + 1.9, ZBACK + 0.02,
    -1.2, F2 + 1.9, ZBACK + 0.02, -2.4, F2 + 1.9, ZBACK + 0.02, -2.4, F2 + 1.9, ZBACK + 0.02, -2.4, F2 + 0.9, ZBACK + 0.02,
    -1.8, F2 + 0.9, ZBACK + 0.02, -1.8, F2 + 1.9, ZBACK + 0.02,
  ], 'faint'));

  // --- inject the agent-modelled furniture (with simple fallbacks) -----------
  const place = (fn: FurnitureFn | undefined, x: number, z: number, yaw: number, fb: () => THREE.Group) => {
    const m = (fn ? safe(fn, kit) : null) ?? fb();
    m.position.set(x, F2, z); m.rotation.y = yaw; group.add(m);
  };
  place(F.kitchen, -1.6, ZBACK + 0.35, 0, () => kit.boxAt(2.4, 0.9, 0.6, 0, 0, 0));            // kitchen: back-left, faces +z
  place(F.bed, -2.3, -1.9, Math.PI / 2, () => kit.boxAt(1.3, 0.45, 2.0, 0, 0, 0));             // bed: left wall, faces +x
  place(F.living, 0.5, -2.0, 0, () => kit.boxAt(1.6, 0.5, 0.7, 0, 0, 0));                      // living: centre
  place(F.bathroom, 2.15, -2.6, Math.PI, () => kit.boxAt(0.9, 0.9, 0.9, 0, 0, 0));             // bath: nook, faces -z (into nook)

  const enterPath = [
    new THREE.Vector3(0.7, 0, ZFRONT - 0.4),   // just inside the entrance
    new THREE.Vector3(-1.5, 0, -0.4),          // cross the lobby to the stair foot
    ...s1.waypoints,
    ...s2.waypoints,
    new THREE.Vector3(-0.85, F2, 0.05),        // arrive on the 2nd floor (hallway)
    new THREE.Vector3(1.0, F2, 0.0),           // walk the hallway to her door
    new THREE.Vector3(1.0, F2, -0.9),          // step through into the studio
    new THREE.Vector3(0.4, F2, -1.6),          // studio centre
  ];

  const studioSpots: Apartment['studioSpots'] = {
    eat: { x: -1.4, y: F2, z: ZBACK + 0.95, yaw: Math.PI }, drink: { x: -1.4, y: F2, z: ZBACK + 0.95, yaw: Math.PI },
    rest: { x: -1.7, y: F2, z: -1.9, yaw: -Math.PI / 2 },
    bathe: { x: 2.15, y: F2, z: -2.0, yaw: Math.PI }, relieve: { x: 1.7, y: F2, z: -2.0, yaw: Math.PI },
    go_home: { x: 0.5, y: F2, z: -1.5, yaw: 0 },
  };

  return {
    group,
    entrance: { pivot: entrance, open: false },
    studioDoor: { pivot: studioDoor, open: false },
    enterPath, studioSpots,
  };
}

function safe(fn: FurnitureFn, kit: Kit): THREE.Group | null {
  try { const g = fn(kit); return g instanceof THREE.Group || (g && (g as any).isObject3D) ? g : null; }
  catch { return null; }
}
