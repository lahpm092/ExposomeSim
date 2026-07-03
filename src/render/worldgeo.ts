// =============================================================================
// worldgeo.ts — the low-poly black-mesh CITY: geometry for a compressed
// modern-western town, built once and shared. Everything is paper-filled (to
// occlude cleanly) with crisp ink edges on top — solid low-poly massing that
// still reads as black line-work on aged sepia. Distinct silhouettes per locale:
//   home → apartment tower · work → fast-food restaurant · market → supermarket
//   thirdplace → café · park → trees + pond + benches.
//
// Coordinates: town pos2D ∈ [0,1] maps to a CITY-metre world plane on XZ (y up).
// Each locale exposes an interior anchor (where its figures + the occupant stand)
// and LOD groups (shell = always cheap; detail = shown only near the camera).
//
// Materials are shared across the whole city (one paper fill + three ink line
// weights) so the M1 stays cool: the cost is tiny box geometry, not state churn.
// =============================================================================
import * as THREE from 'three';
import type { PlaceId, Vec2, IntentionKind } from '../types';
import { PLACES } from '../sim/places';
import { PALETTE, lineMaterial } from './palette';
import { buildBuilding, type Building } from './building';

/** the "shrink on entering" scale: the apartment building is modelled at real
 *  metres, then drawn at 1/4 so it fits the tower and residents shrink to match.
 *  Each apartment inside is shrunk 1/4 AGAIN (→ 1/16) — the double projection. */
export const INT_SCALE = 1 / 4;

export const CITY = 66;            // metres across the town plane
export const GROUND_Y = 0;

/** town [0,1] → world metres on the XZ plane (centred on origin). */
export function mapToWorld(v: Vec2): THREE.Vector3 {
  return new THREE.Vector3((v.x - 0.5) * CITY, 0, (v.y - 0.5) * CITY);
}

// shared materials (created once, owned by CityGeo)
export interface CityMats {
  fill: THREE.MeshBasicMaterial;   // paper, occluding
  ink: THREE.LineBasicMaterial;    // strong edges
  soft: THREE.LineBasicMaterial;   // secondary
  faint: THREE.LineBasicMaterial;  // windows / grid / ticks
  green: THREE.LineBasicMaterial;  // park foliage
}

export function makeCityMats(): CityMats {
  const fill = new THREE.MeshBasicMaterial({
    color: PALETTE.paper, side: THREE.FrontSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  return {
    fill,
    ink: lineMaterial(PALETTE.ink, 0.82),
    soft: lineMaterial(PALETTE.inkSoft, 0.6),
    faint: lineMaterial(PALETTE.ink, 0.14),
    green: lineMaterial(PALETTE.good, 0.5),
  };
}

// ---------------------------------------------------------------------------
// low-level solid box: paper fill (occludes) + ink edges. width w, height h,
// depth d, base sitting on y=y0 unless `centered`.
// ---------------------------------------------------------------------------
function box(
  w: number, h: number, d: number, mats: CityMats, edge = mats.ink,
): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, 0); // base on the ground
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge));
  return g;
}

function seg(pts: number[], mat: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}

/** faint window grid on one face of a box (front = +z by default). */
function windowGrid(
  w: number, h: number, z: number, cols: number, rows: number,
  mats: CityMats, y0 = 0.6, top?: number,
): THREE.LineSegments {
  const pts: number[] = [];
  const hy = top ?? h - 0.4;
  const x0 = -w / 2 + 0.4, x1 = w / 2 - 0.4;
  for (let c = 1; c < cols; c++) { const x = x0 + (x1 - x0) * (c / cols); pts.push(x, y0, z, x, hy, z); }
  for (let r = 0; r <= rows; r++) { const y = y0 + (hy - y0) * (r / rows); pts.push(x0, y, z, x1, y, z); }
  return seg(pts, mats.faint);
}

// ===========================================================================
//  Locale buildings — a DOLLHOUSE model. Each returns { base, shell, interior }:
//    base     : always-visible ground structure (footprint / lower floors)
//    shell    : exterior massing shown ONLY when she is NOT inside
//    interior : the open-plan room (floor + furniture) shown when she IS inside
//  When she enters, the renderer hides `shell` and reveals `interior`, so the
//  camera looks straight into the room (the building "opens up"). The home
//  interior sits on the TOP FLOOR (floorY); others at ground.
// ===========================================================================
export type Spot = { x: number; z: number; yaw?: number };
export interface Locale {
  id: PlaceId;
  group: THREE.Group;
  base: THREE.Group;       // always visible
  shell: THREE.Group;      // massing, hidden when she is inside
  interior: THREE.Group;   // room, revealed when she is inside (at floorY)
  world: THREE.Vector3;
  yaw: number;
  floorY: number;          // Y of the interior floor (home = top storey)
  occupant: Spot;          // default stand-spot inside
  spots: Partial<Record<IntentionKind, Spot>>; // where she stands to do a given act
  building?: Building;      // home: the 1/4 apartment building (lobby/stairs/hallways/flats)
  intScale: number;        // interior draw-scale (1, or 1/4 for the home building)
}

/** angle so local +z points from the building toward town centre */
function faceCentre(world: THREE.Vector3): number {
  return Math.atan2(-world.x, -world.z);
}

const TOP_FLOOR = 6.2; // Y of the apartment's top-storey floor

export function buildLocale(id: PlaceId, mats: CityMats): Locale {
  const world = mapToWorld(PLACES[id].pos2D);
  const yaw = faceCentre(world);
  const group = new THREE.Group();
  group.position.copy(world);
  group.rotation.y = yaw;
  const base = new THREE.Group();
  const shell = new THREE.Group();
  const interior = new THREE.Group();
  group.add(base, shell, interior);

  let floorY = 0;
  let occupant: Spot = { x: 0, z: 0 };
  let spots: Partial<Record<IntentionKind, Spot>> = {};
  let building: Building | undefined;
  let intScale = 1;

  switch (id) {
    case 'home': {
      // exterior tower massing (base storeys + top) — hidden when focused inside
      apartmentBase(base, mats); apartmentTop(shell, mats);
      // the detailed BUILDING (lobby → dogleg stairs → hallways → 10+ flats),
      // modelled at real metres then shrunk to 1/4 and stood at the tower front so
      // its main door lands on the tower stoop; each flat is shrunk 1/4 again.
      building = buildBuilding(mats);
      building.group.scale.setScalar(INT_SCALE);
      // Keep the main-door plane (building-local z = FRONT_Z = 6.7) on the tower
      // stoop / approach (locale z ≈ 3.0) at the new scale: 3.0 − 6.7·INT_SCALE.
      building.group.position.set(0.06, 0, 3.0 - 6.7 * INT_SCALE);
      interior.add(building.group);
      intScale = INT_SCALE;
      occupant = { x: 0, z: 0, yaw: 0 };
      break;
    }
    case 'work':
      floorParquet(base, 7, 5, mats); restaurantShell(shell, mats); counterRoom(interior, mats);
      occupant = { x: 0, z: -1.4, yaw: 0 };
      spots = { relieve: { x: 2.1, z: -1.4, yaw: -Math.PI / 2 }, drink: { x: -1.6, z: -1.4, yaw: 0 }, buy_meal: { x: 0, z: -1.0, yaw: 0 } };
      break;
    case 'market':
      floorParquet(base, 10, 7, mats); supermarketShell(shell, mats); marketRoom(interior, mats);
      occupant = { x: 0, z: 0.4, yaw: Math.PI };
      spots = { shop: { x: -0.2, z: -0.4, yaw: Math.PI } };
      break;
    case 'thirdplace':
      floorParquet(base, 4.4, 3.4, mats); cafeShell(shell, mats); cafeRoom(interior, mats);
      occupant = { x: -1.0, z: 0.5, yaw: 0.5 };
      spots = {};
      break;
    case 'park':
      parkGround(base, mats);
      occupant = { x: 0, z: 2.0, yaw: Math.PI };
      spots = {};
      break;
  }
  group.updateMatrixWorld(true); // static: freeze world matrices for localToWorld()
  return { id, group, base, shell, interior, world, yaw, floorY, occupant, spots, building, intScale };
}

// ---- interior helpers ------------------------------------------------------
/** a thin opaque floor slab (occludes the ground far below for the top storey). */
function floorSlab(w: number, d: number, mats: CityMats): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, 0.1, d);
  geo.translate(0, -0.05, 0);
  return new THREE.Mesh(geo, mats.fill);
}
/** low perimeter wall rail (knee-high) so the room reads without occluding her. */
function roomRail(w: number, d: number, h: number, mats: CityMats): THREE.LineSegments {
  const hw = w / 2, hd = d / 2;
  return seg([
    -hw, 0, -hd, hw, 0, -hd, hw, 0, -hd, hw, 0, hd, hw, 0, hd, -hw, 0, hd, -hw, 0, hd, -hw, 0, -hd,
    -hw, h, -hd, hw, h, -hd, hw, h, -hd, hw, h, hd, hw, h, hd, -hw, h, hd, -hw, h, hd, -hw, h, -hd,
    -hw, 0, -hd, -hw, h, -hd, hw, 0, -hd, hw, h, -hd, hw, 0, hd, hw, h, hd, -hw, 0, hd, -hw, h, hd,
  ], mats.faint);
}
function floorParquet(g: THREE.Group, w: number, d: number, mats: CityMats): void {
  g.add(floorSlab(w, d, mats));
  g.add(roomRail(w, d, 0.5, mats));
}
/** a small cube "food object" on a shelf/counter. */
function foodBox(mats: CityMats, s = 0.24): THREE.Group { return box(s, s, s, mats); }

// ---- HOME · apartment (base = lower storeys; top = massing; room = the flat) ----
function apartmentBase(g: THREE.Group, mats: CityMats): void {
  const tiers = [{ w: 5.4, d: 5.0, h: 3.2, y: 0 }, { w: 4.6, d: 4.2, h: 3.0, y: 3.2 }];
  for (const t of tiers) {
    const b = box(t.w, t.h, t.d, mats); b.position.y = t.y; g.add(b);
    g.add(windowGrid(t.w, t.h, t.d / 2 + 0.01, 3, Math.round(t.h), mats, t.y + 0.5, t.y + t.h - 0.3));
    g.add(windowGrid(t.w, t.h, -t.d / 2 - 0.01, 3, Math.round(t.h), mats, t.y + 0.5, t.y + t.h - 0.3));
  }
  // door + stoop
  g.add(seg([-0.6, 0, 2.5, -0.6, 1.7, 2.5, 0.6, 1.7, 2.5, 0.6, 0, 2.5], mats.ink));
  const stoop = box(1.8, 0.18, 0.8, mats); stoop.position.set(0, 0, 2.9); g.add(stoop);
}
function apartmentTop(g: THREE.Group, mats: CityMats): void {
  const b = box(3.8, 2.6, 3.4, mats); b.position.y = TOP_FLOOR; g.add(b);
  g.add(windowGrid(3.8, 2.6, 3.4 / 2 + 0.01, 3, 2, mats, TOP_FLOOR + 0.5, TOP_FLOOR + 2.3));
  const tank = box(1.0, 0.9, 1.0, mats); tank.position.set(1.0, TOP_FLOOR + 2.6, 0); g.add(tank);
}
/** the detailed top-floor flat: bed, bath, toilet, kitchen+fridge+stove, sofa. */
function apartmentRoom(g: THREE.Group, mats: CityMats): void {
  g.add(floorSlab(4.4, 4.4, mats));
  g.add(roomRail(4.4, 4.4, 0.5, mats));
  g.add(seg(ring(1.0, 20, 0.02), mats.faint)); // a rug

  // BED (with a pillow line) — bottom-left
  const bed = box(1.3, 0.4, 2.0, mats); bed.position.set(-1.4, 0, -0.9); g.add(bed);
  g.add(seg([-1.9, 0.42, -1.6, -0.9, 0.42, -1.6], mats.faint)); // pillow edge

  // BATH TUB — top-left, an inset rim
  const tub = box(1.4, 0.5, 0.85, mats); tub.position.set(0.9, 0, -1.5); g.add(tub);
  g.add(seg([0.35, 0.52, -1.75, 1.45, 0.52, -1.75, 1.45, 0.52, -1.25, 0.35, 0.52, -1.25, 0.35, 0.52, -1.75, 0.35, 0.52, -1.25, 1.45, 0.52, -1.75, 1.45, 0.52, -1.25], mats.faint));

  // TOILET — top-right corner (bowl + tank)
  const bowl = box(0.42, 0.42, 0.5, mats); bowl.position.set(1.7, 0, 1.5); g.add(bowl);
  const tank = box(0.5, 0.4, 0.18, mats); tank.position.set(1.7, 0.42, 1.85); g.add(tank);

  // KITCHEN — counter + stove burners + fridge — bottom-right
  const counter = box(1.8, 0.9, 0.6, mats); counter.position.set(-1.4, 0, 1.5); g.add(counter);
  for (const dx of [-0.4, 0.4]) g.add(seg(ring(0.14, 12, 0.92).map((v, i) => i % 3 === 0 ? v - 1.4 + dx : i % 3 === 2 ? v + 1.5 : v), mats.faint));
  const fridge = box(0.7, 1.7, 0.65, mats); fridge.position.set(-1.95, 0, 0.7); g.add(fridge);
  g.add(seg([-1.95, 0.85, 1.04, -1.6, 0.85, 1.04], mats.faint));   // fridge door split
  g.add(seg([-1.66, 0.5, 1.04, -1.66, 1.2, 1.04], mats.soft));      // handle

  // SOFA + coffee table — centre-right
  const sofa = box(1.5, 0.5, 0.65, mats); sofa.position.set(0.7, 0, 1.7); g.add(sofa);
  g.add(seg([0.0, 0.5, 1.4, 0.0, 0.85, 1.9, 1.4, 0.85, 1.9, 1.4, 0.5, 1.4], mats.faint)); // backrest
  const cofT = box(0.8, 0.35, 0.5, mats); cofT.position.set(0.7, 0, 0.95); g.add(cofT);
}

// ---- WORK · restaurant shell + counter room (with a restroom) --------------
function restaurantShell(g: THREE.Group, mats: CityMats): void {
  const b = box(8.4, 3.4, 6.0, mats); g.add(b);
  g.add(windowGrid(8.4, 2.6, 3.01, 6, 1, mats, 0.5, 2.6));
  const canopy = box(3.4, 0.16, 1.4, mats); canopy.position.set(0, 2.5, 3.6); g.add(canopy);
  const pole = box(0.22, 5.4, 0.22, mats); pole.position.set(4.6, 0, 3.4); g.add(pole);
  const board = box(2.0, 1.3, 0.3, mats); board.position.set(4.6, 4.4, 3.4); g.add(board);
  g.add(seg([3.8, 5.1, 3.56, 5.4, 5.1, 3.56, 3.8, 4.85, 3.56, 5.4, 4.85, 3.56, 3.8, 4.6, 3.56, 5.4, 4.6, 3.56], mats.soft));
}
function counterRoom(g: THREE.Group, mats: CityMats): void {
  g.add(floorSlab(7.2, 5.4, mats));
  g.add(roomRail(7.2, 5.4, 0.5, mats));
  // service counter + two registers
  const counter = box(3.4, 1.0, 0.7, mats); counter.position.set(0, 0, -0.7); g.add(counter);
  for (const x of [-1.0, 1.0]) {
    const r = box(0.5, 0.26, 0.4, mats); r.position.set(x, 1.0, -0.7); g.add(r);
    const scr = box(0.42, 0.3, 0.03, mats); scr.position.set(x, 1.26, -0.6); scr.rotation.x = -0.5; g.add(scr);
  }
  // kitchen line behind
  const line = box(1.6, 1.2, 0.6, mats); line.position.set(-2.4, 0, -1.9); g.add(line);
  // restroom cubicle (back-right) — a little room with a toilet
  const stall = box(1.2, 2.0, 1.3, mats); stall.position.set(2.4, 0, -1.6); g.add(stall);
  g.add(seg([1.85, 0, -1.0, 1.85, 1.9, -1.0], mats.soft)); // door jamb
  const wc = box(0.4, 0.42, 0.45, mats); wc.position.set(2.4, 0, -1.7); g.add(wc);
}

// ---- MARKET · supermarket shell + aisle room (fridges, food boxes, checkout) ----
function supermarketShell(g: THREE.Group, mats: CityMats): void {
  const b = box(12.0, 4.0, 9.0, mats); g.add(b);
  g.add(seg([-5.5, 3.0, 4.51, 5.5, 3.0, 4.51, 5.5, 3.7, 4.51, -5.5, 3.7, 4.51, -5.5, 3.0, 4.51, -5.5, 3.7, 4.51, 5.5, 3.0, 4.51, 5.5, 3.7, 4.51], mats.ink));
  g.add(windowGrid(12.0, 2.6, 4.52, 8, 1, mats, 0.4, 2.6));
  const saw: number[] = [];
  for (let i = -5; i <= 5; i++) { saw.push(i * 1.0, 4.0, -3, i * 1.0 + 0.5, 4.6, -3, i * 1.0 + 0.5, 4.6, -3, i * 1.0 + 1.0, 4.0, -3); }
  g.add(seg(saw, mats.faint));
}
function marketRoom(g: THREE.Group, mats: CityMats): void {
  g.add(floorSlab(10, 7, mats));
  g.add(roomRail(10, 7, 0.5, mats));
  // shelf gondolas with little food boxes on the shelves
  for (const x of [-3.2, -1.1, 1.1, 3.2]) {
    const s = box(1.0, 1.5, 2.6, mats); s.position.set(x, 0, -0.2); g.add(s);
    for (const z of [-0.9, 0, 0.9]) for (const yy of [0.7, 1.15]) {
      const fb = foodBox(mats, 0.22); fb.position.set(x - 0.25 + (z > 0 ? 0.25 : 0), yy, z + (-0.2)); g.add(fb);
    }
  }
  // refrigerated cases along the back wall (glass doors + food inside)
  for (const x of [-3.5, 0, 3.5]) {
    const fr = box(2.0, 2.0, 0.8, mats); fr.position.set(x, 0, -2.9); g.add(fr);
    g.add(seg([x, 0.2, -2.5, x, 1.9, -2.5], mats.soft)); // door split
    for (const yy of [0.5, 1.1]) { const fb = foodBox(mats, 0.24); fb.position.set(x - 0.4, yy, -2.7); g.add(fb); const fb2 = foodBox(mats, 0.24); fb2.position.set(x + 0.4, yy, -2.7); g.add(fb2); }
  }
  // produce counter up front + fruit boxes
  const prod = box(2.4, 0.8, 0.9, mats); prod.position.set(-3.2, 0, 2.2); g.add(prod);
  for (const dx of [-0.7, 0, 0.7]) { const fb = foodBox(mats, 0.28); fb.position.set(-3.2 + dx, 0.8, 2.2); g.add(fb); }
  // checkout
  const chk = box(1.6, 0.9, 0.6, mats); chk.position.set(2.6, 0, 2.4); g.add(chk);
}

// ---- THIRDPLACE · café shell + room ----------------------------------------
function cafeShell(g: THREE.Group, mats: CityMats): void {
  const b = box(5.0, 2.8, 4.2, mats); g.add(b);
  const rp: number[] = [
    -2.7, 2.8, -2.3, 0, 3.9, -2.3, 0, 3.9, -2.3, 2.7, 2.8, -2.3,
    -2.7, 2.8, 2.3, 0, 3.9, 2.3, 0, 3.9, 2.3, 2.7, 2.8, 2.3,
    0, 3.9, -2.3, 0, 3.9, 2.3,
    -2.7, 2.8, -2.3, -2.7, 2.8, 2.3, 2.7, 2.8, -2.3, 2.7, 2.8, 2.3,
  ];
  g.add(seg(rp, mats.ink));
  const aw = box(3.4, 0.12, 0.9, mats); aw.position.set(0, 2.2, 2.6); g.add(aw);
}
function cafeRoom(g: THREE.Group, mats: CityMats): void {
  g.add(floorSlab(4.4, 3.4, mats));
  g.add(roomRail(4.4, 3.4, 0.5, mats));
  const bar = box(2.2, 1.0, 0.6, mats); bar.position.set(0, 0, -1.0); g.add(bar);
  for (const dx of [-1.2, 1.2]) {   // two small round tables
    const t = box(0.02, 0.72, 0.02, mats); t.position.set(dx, 0, 0.6); g.add(t);
    g.add(seg(ring(0.34, 14, 0.74).map((v, i) => i % 3 === 0 ? v + dx : i % 3 === 2 ? v + 0.6 : v), mats.soft));
  }
}

// ---- PARK · open ground (always visible) -----------------------------------
function parkGround(g: THREE.Group, mats: CityMats): void {
  g.add(seg(ringPts(9, 8.5, 28), mats.green));
  const path: number[] = [];
  for (let i = 0; i <= 20; i++) { const t = i / 20; path.push(-7 + t * 14, 0.02, Math.sin(t * Math.PI) * 3); }
  const pl = new THREE.BufferGeometry();
  pl.setAttribute('position', new THREE.Float32BufferAttribute(path, 3));
  g.add(new THREE.Line(pl, mats.faint));
  const pond = seg(ring(2.4, 22, 0.02), mats.soft); pond.scale.set(1.5, 1, 1); pond.position.set(3, 0, -2.5); g.add(pond);
  for (const [x, z, s] of [[-5, 2, 1.1], [-2, -3, 0.9], [4, 3, 1.2], [6, -4, 1.0], [-6, -2, 0.85], [1, 4, 1.0]] as const) {
    g.add(tree(mats, s).translateX(x).translateZ(z));
  }
  for (const [x, z, r] of [[-3, 1.4, 0.3], [2.5, 1.6, -0.4]] as const) g.add(bench(mats).translateX(x).translateZ(z).rotateY(r));
  g.add(lamp(mats));
}

function bistro(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  const top = box(0.02, 0.7, 0.02, mats); g.add(top); // stem
  const disc = seg(ring(0.35, 16, 0.72), mats.soft); g.add(disc);
  // umbrella
  const um: number[] = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; um.push(0, 1.9, 0, Math.cos(a) * 0.7, 1.55, Math.sin(a) * 0.7); }
  g.add(seg([0, 0.7, 0, 0, 1.9, 0], mats.soft));
  g.add(seg(um, mats.faint));
  return g;
}

// ---- PARK · trees, pond, paths, benches ------------------------------------
function park(shell: THREE.Group, detail: THREE.Group, mats: CityMats): void {
  // plot boundary
  shell.add(seg(ringPts(9, 8.5, 28), mats.green));
  // winding path (two arcs)
  const path: number[] = [];
  for (let i = 0; i <= 20; i++) { const t = i / 20; path.push(-7 + t * 14, 0.02, Math.sin(t * Math.PI) * 3); }
  const pl = new THREE.BufferGeometry();
  pl.setAttribute('position', new THREE.Float32BufferAttribute(path, 3));
  shell.add(new THREE.Line(pl, mats.faint));
  // pond
  const pond = seg(ring(2.4, 22, 0.02), mats.soft); pond.scale.set(1.5, 1, 1); pond.position.set(3, 0, -2.5); shell.add(pond);
  // trees
  for (const [x, z, s] of [[-5, 2, 1.1], [-2, -3, 0.9], [4, 3, 1.2], [6, -4, 1.0], [-6, -2, 0.85], [1, 4, 1.0]] as const) {
    detail.add(tree(mats, s).translateX(x).translateZ(z));
  }
  // benches along the path
  for (const [x, z, r] of [[-3, 1.4, 0.3], [2.5, 1.6, -0.4]] as const) detail.add(bench(mats).translateX(x).translateZ(z).rotateY(r));
  // a lamp
  detail.add(lamp(mats).translateX(0).translateZ(0));
}

function tree(mats: CityMats, s = 1): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.18, 1.2 * s, 0.18, mats)); // trunk
  const crown = new THREE.IcosahedronGeometry(0.95 * s, 0);
  crown.translate(0, 1.2 * s + 0.7 * s, 0);
  g.add(new THREE.Mesh(crown, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(crown, 1), mats.green));
  return g;
}

function bench(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  g.add(seg([-0.6, 0.42, 0, 0.6, 0.42, 0, -0.6, 0.42, 0.3, 0.6, 0.42, 0.3, -0.6, 0.7, 0.32, 0.6, 0.7, 0.32], mats.soft));
  g.add(seg([-0.5, 0, 0, -0.5, 0.42, 0, 0.5, 0, 0, 0.5, 0.42, 0, -0.5, 0, 0.3, -0.5, 0.42, 0.3, 0.5, 0, 0.3, 0.5, 0.42, 0.3], mats.faint));
  return g;
}

// ---- shared street props ---------------------------------------------------
export function lamp(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.1, 3.2, 0.1, mats));
  g.add(seg([0, 3.2, 0, 0.6, 3.4, 0], mats.soft));
  const head = new THREE.IcosahedronGeometry(0.16, 0); head.translate(0.6, 3.4, 0);
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(head, 1), mats.ink));
  return g;
}

export function parkedCar(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  const body = box(1.7, 0.7, 3.6, mats); g.add(body);
  const cab = box(1.5, 0.6, 1.8, mats); cab.position.y = 0.7; g.add(cab);
  return g;
}

/** a plain low-poly filler building (deterministic massing for the far city). */
export function fillerBlock(mats: CityMats, w: number, h: number, d: number, windows: boolean): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w, h, d, mats));
  if (windows && h > 2) { g.add(windowGrid(w, h, d / 2 + 0.01, Math.max(2, Math.round(w / 1.6)), Math.max(2, Math.round(h / 1.4)), mats)); }
  return g;
}

// ---- tiny geometry helpers -------------------------------------------------
function ring(r: number, seg: number, y: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
  }
  return pts;
}
function ringPts(r: number, r2: number, seg: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, 0.02, Math.sin(a0) * r2, Math.cos(a1) * r, 0.02, Math.sin(a1) * r2);
  }
  return pts;
}
