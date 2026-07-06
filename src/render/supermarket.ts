// =============================================================================
// supermarket.ts — a full-size SUPERMARKET modelled as a single-storey BUILDING
// in the house line-work style (paper-filled low-poly solids that occlude, crisp
// ink edges on top). Mirrors foodcourt.ts / building.ts conventions: everything
// is built through the shared kit at REAL metres (1 unit = 1 m, sized against the
// ~1.72 m agents), and the caller places the returned group + calls
// updateMatrixWorld — we freeze nothing here.
//
//   building-local axes: +x runs ACROSS the shop · +z points toward the FRONT
//   (storefront / entrance / town centre). Floor at y=0 · one storey (~3.6 m).
//   Footprint ~18 m (x) × ~14 m (z) — much bigger than the corner-store shell.
//
// The plan, front (+z) to back (-z):
//   · a glass STOREFRONT with a 2.15 m automatic entrance, under a big fascia sign
//   · a row of CHECKOUT stands + two cart CORRALS just inside the doors
//   · five parallel GONDOLA aisles, each a labelled zone (produce · dairy · grains
//     · bakery · meat) stocked with a cluster of food boxes of DIFFERENT
//     proportions + a subtle per-zone tint; ~2.0–2.5 m aisles so a body fits
//   · a DRINKS reach-in cooler run along the (solid) back wall
//
// House-palette discipline: the shared paper `fill` carries every solid; colour
// only ever enters as thin EDGE line-work. The kit gives us ink/soft/faint/green;
// the six zone tints below are extra LineBasicMaterials, deliberately DESATURATED
// toward the sepia stage (never raw supermarket-bright) — same trick foodcourt.ts
// uses for its amber wet-floor sign.
// =============================================================================
import * as THREE from 'three';
import { makeKit, type Kit } from './kit';
import { makeCityMats, type CityMats } from './worldgeo';

const V = THREE.Vector3;

// ---- building envelope (metres) --------------------------------------------
const HX = 9;               // half-width in x → 18 m across
const ZB = -7, ZF = 7;     // back / front faces → 14 m deep
const CEIL = 3.6;          // flat-roof height
const DOOR_H = 2.15;       // entrance clear height
const DOOR_HW = 1.2;       // entrance half-width (2.4 m twin sliding doors)

// ---- gondola aisle geometry (shared by every zone) -------------------------
const GW = 1.0;            // gondola width (x) — double-sided shelving
const GH = 1.5;            // gondola height
const GZ = -0.5;           // gondola centre in z
const GL = 7.0;            // gondola length (z): spans z ∈ [-4.0, 3.0]

// Subtle, sepia-muted zone tints (edge line-work only; fills stay paper). These
// are the ONLY non-kit colours in the module and are intentionally greyed-down.
const tint = (hex: number): THREE.LineBasicMaterial => new THREE.LineBasicMaterial({ color: hex });
const T = {
  produce: tint(0x4f6a34), // muted leaf green
  dairy:   tint(0x9299a1), // pale cool grey
  grains:  tint(0x9c7b3a), // wheat
  bakery:  tint(0xa9762f), // warm tan / bread crust
  meat:    tint(0x8f3a2c), // dull red-brown
  drinks:  tint(0x3f6b76), // muted bottle-teal
};

// Each zone: an aisle at gondola-centre x, its tint, and a POOL of food-box
// proportions [w,h,d] to cycle through — cans, tall cartons, flat trays, boxy
// cereal — so the cluster reads as that department at a glance.
interface Zone { name: string; x: number; tint: THREE.LineBasicMaterial; pool: [number, number, number][]; }
const ZONES: Zone[] = [
  { name: 'PRODUCE', x: -6, tint: T.produce, pool: [[0.42, 0.12, 0.30], [0.34, 0.14, 0.26], [0.24, 0.20, 0.22]] }, // flat trays + a crate
  { name: 'DAIRY',   x: -3, tint: T.dairy,   pool: [[0.14, 0.26, 0.14], [0.20, 0.13, 0.20], [0.12, 0.20, 0.12]] }, // cartons + tubs
  { name: 'GRAINS',  x:  0, tint: T.grains,  pool: [[0.18, 0.30, 0.10], [0.16, 0.28, 0.09], [0.11, 0.15, 0.11]] }, // cereal boxes + cans
  { name: 'BAKERY',  x:  3, tint: T.bakery,  pool: [[0.32, 0.16, 0.18], [0.22, 0.24, 0.20], [0.16, 0.14, 0.16]] }, // loaves + bags
  { name: 'MEAT',    x:  6, tint: T.meat,    pool: [[0.30, 0.08, 0.22], [0.26, 0.10, 0.20], [0.18, 0.11, 0.16]] }, // shrink-wrapped trays
];

// ---------------------------------------------------------------------------
// see-through walls: edge-only rectangles (never boxed in, so the camera can
// look straight into the shop). Copied in spirit from foodcourt.ts.
// ---------------------------------------------------------------------------
function wallRectZY(kit: Kit, x: number, z0: number, z1: number, y0: number, y1: number, tone: 'ink' | 'soft' | 'faint'): THREE.LineSegments {
  return kit.line([x, y0, z0, x, y0, z1, x, y0, z1, x, y1, z1, x, y1, z1, x, y1, z0, x, y1, z0, x, y0, z0], tone);
}

/** a see-through floor plate with a soft ink edge (see building.ts `plate`). */
function plate(kit: Kit, w: number, d: number, x: number, y: number, z: number): THREE.Group {
  return kit.boxAt(w, 0.1, d, x, y - 0.05, z, { edge: 'soft' });
}

/** a paper-filled box whose EDGES carry a custom zone tint (mirrors kit's own
 *  `solid`, which only exposes the four built-in tones). Base sits on y. */
function tintBox(mats: CityMats, w: number, h: number, d: number, x: number, y: number, z: number, edge: THREE.LineBasicMaterial): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, h / 2, 0);
  g.add(new THREE.Mesh(geo, mats.fill));
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge));
  g.position.set(x, y, z);
  return g;
}

/** a few faint vertical ticks suggesting the department's lettering on a board. */
function letters(group: THREE.Object3D, kit: Kit, x: number, y: number, z: number, w: number, name: string): void {
  const n = Math.min(name.length, 10);
  const span = w - 0.24, y0 = y + 0.08, y1 = y + 0.32, pts: number[] = [];
  for (let i = 0; i < n; i++) { const lx = x - span / 2 + (n === 1 ? span / 2 : span * (i / (n - 1))); pts.push(lx, y0, z, lx, y1, z); }
  group.add(kit.line(pts, 'faint'));
}

/** a hanging aisle sign: a tinted board on two faint drop-wires, faint lettering. */
function aisleSign(group: THREE.Object3D, kit: Kit, mats: CityMats, tintMat: THREE.LineBasicMaterial, x: number, y: number, z: number, name: string): void {
  const w = Math.max(1.3, name.length * 0.16 + 0.4);
  group.add(tintBox(mats, w, 0.42, 0.06, x, y, z, tintMat));                 // board
  letters(group, kit, x, y, z - 0.05, w, name);                             // lettering (front face)
  group.add(kit.line([x - w / 2 + 0.15, y + 0.42, z, x - w / 2 + 0.15, y + 0.95, z,
                      x + w / 2 - 0.15, y + 0.42, z, x + w / 2 - 0.15, y + 0.95, z], 'faint')); // drop-wires
}

// ---- one department: a double-sided gondola run + a stocked food cluster ----
function buildZone(group: THREE.Object3D, kit: Kit, mats: CityMats, z: Zone): void {
  const zx = z.x;
  group.add(kit.boxAt(GW, 0.12, GL, zx, 0, GZ, { edge: 'soft' }));           // kick base
  group.add(kit.boxAt(0.12, GH - 0.12, GL, zx, 0.12, GZ, { edge: 'ink' }));  // central spine (back-to-back divider)
  for (const y of [0.5, 1.0, GH]) group.add(kit.slab(GW, GL, zx, y, GZ, { edge: 'soft' })); // two shelf ledges + crown
  for (const ez of [GZ - GL / 2, GZ + GL / 2]) group.add(kit.boxAt(GW, GH, 0.06, zx, 0, ez, { edge: 'soft' })); // end caps

  // food CLUSTER — both faces, both shelf levels, cycling the zone's shape pool
  // so widths/heights/depths vary; each item's outer face lines up with the edge.
  let k = 0;
  for (const level of [0.52, 1.02]) for (const side of [-1, 1]) for (const iz of [GZ - 2.4, GZ, GZ + 2.4]) {
    const [w, h, d] = z.pool[k++ % z.pool.length];
    group.add(tintBox(mats, w, h, d, zx + side * (0.47 - w / 2), level, iz, z.tint));
  }

  aisleSign(group, kit, mats, z.tint, zx, 2.45, GZ + GL / 2 + 0.35, z.name); // hung over the aisle mouth
}

// ---- an upright glass-door reach-in cooler (drinks run, back wall) ----------
function cooler(group: THREE.Object3D, kit: Kit, mats: CityMats, cx: number): void {
  const cz = -6.2, W = 2.7, H = 2.0, D = 0.8, fz = cz + D / 2;
  group.add(kit.boxAt(W, H, D, cx, 0, cz, { edge: 'ink' }));                 // case
  group.add(kit.line([cx - W / 2 + 0.05, 0.1, fz, cx - W / 2 + 0.05, H - 0.1, fz,
                      cx, 0.1, fz, cx, H - 0.1, fz,
                      cx + W / 2 - 0.05, 0.1, fz, cx + W / 2 - 0.05, H - 0.1, fz], 'soft')); // door frames + split
  const sh: number[] = [];
  for (const sy of [0.55, 1.05, 1.55]) sh.push(cx - W / 2 + 0.1, sy, cz, cx + W / 2 - 0.1, sy, cz); // interior shelves
  group.add(kit.line(sh, 'faint'));
  for (const by of [0.58, 1.08]) for (const bx of [cx - 0.55, cx + 0.55])   // tall bottles behind the glass
    group.add(tintBox(mats, 0.10, 0.38, 0.10, bx, by, cz - 0.05, T.drinks));
}

// ---- a checkout stand: counter + belt + register + card screen + queue pole -
function checkout(group: THREE.Object3D, kit: Kit, x: number, z: number): void {
  group.add(kit.boxAt(0.9, 0.95, 1.8, x, 0, z, { edge: 'ink' }));           // counter body
  group.add(kit.slab(0.55, 1.5, x, 0.97, z, { edge: 'soft' }));             // conveyor belt
  group.add(kit.boxAt(0.30, 0.28, 0.32, x, 0.97, z + 0.65, { edge: 'soft' })); // register
  const scr = kit.boxAt(0.26, 0.20, 0.03, x, 1.25, z + 0.6, { edge: 'ink' }); scr.rotation.x = -0.4; group.add(scr); // tilted screen
  group.add(kit.boxAt(0.05, 1.7, 0.05, x - 0.45, 0, z - 0.9, { edge: 'faint' })); // lane number pole
}

// ---- a shopping-cart corral: a wire cage holding a couple of nested carts ----
function cartCorral(kit: Kit): THREE.Group {
  const g = kit.group();
  g.add(kit.boxAt(1.1, 0.85, 2.0, 0, 0, 0, { edge: 'soft', fill: false }));  // wire cage (edge-only)
  for (const dz of [-0.3, 0.3]) {
    const basket = kit.boxAt(0.55, 0.4, 0.7, 0, 0.35, dz, { edge: 'faint', fill: false }); // tilted basket
    basket.rotation.x = -0.12; g.add(basket);
    g.add(kit.line([-0.28, 0.72, dz - 0.35, 0.28, 0.72, dz - 0.35], 'faint'));  // push handle
    g.add(kit.knob(0.06, -0.22, 0.05, dz + 0.3, { edge: 'soft' }));            // wheels
    g.add(kit.knob(0.06, 0.22, 0.05, dz + 0.3, { edge: 'soft' }));
  }
  return g;
}

// =============================================================================
export function buildSupermarket(mats: ReturnType<typeof makeCityMats>): { group: THREE.Group; door: THREE.Vector3 } {
  const kit = makeKit(mats);
  const group = kit.group();

  // --- ground plate + faint floor grid --------------------------------------
  group.add(plate(kit, HX * 2, ZF - ZB, 0, 0, (ZB + ZF) / 2));
  const grid: number[] = [];
  for (let x = -HX + 1; x < HX; x++) grid.push(x, 0.01, ZB, x, 0.01, ZF);
  for (let z = ZB + 1; z < ZF; z++) grid.push(-HX, 0.01, z, HX, 0.01, z);
  group.add(kit.line(grid, 'faint'));

  // --- envelope: solid paper BACK wall (backdrop) + see-through sides + roof -
  group.add(kit.boxAt(HX * 2, CEIL, 0.15, 0, 0, ZB, { edge: 'ink' }));       // occluding back wall
  for (const sx of [-HX, HX]) {
    group.add(wallRectZY(kit, sx, ZB, ZF, 0, CEIL, 'ink'));                  // side wall outline
    group.add(kit.boxAt(0.12, 0.5, ZF - ZB, sx, 0, (ZB + ZF) / 2, { edge: 'soft' })); // low solid kick for substance
  }
  // faint ceiling rectangle + light strips over the aisles
  const ceil: number[] = [
    -HX, CEIL, ZB, HX, CEIL, ZB, HX, CEIL, ZB, HX, CEIL, ZF,
    HX, CEIL, ZF, -HX, CEIL, ZF, -HX, CEIL, ZF, -HX, CEIL, ZB,
  ];
  for (const lx of [-6, -3, 0, 3, 6]) ceil.push(lx, CEIL - 0.02, ZB + 1, lx, CEIL - 0.02, ZF - 1);
  group.add(kit.line(ceil, 'faint'));
  // flat-roof read: a raised parapet rim + a couple of rooftop HVAC units
  const rp = CEIL + 0.25;
  group.add(kit.line([
    -HX, rp, ZB, HX, rp, ZB, HX, rp, ZB, HX, rp, ZF, HX, rp, ZF, -HX, rp, ZF, -HX, rp, ZF, -HX, rp, ZB,
    -HX, CEIL, ZB, -HX, rp, ZB, HX, CEIL, ZB, HX, rp, ZB, HX, CEIL, ZF, HX, rp, ZF, -HX, CEIL, ZF, -HX, rp, ZF,
  ], 'soft'));
  group.add(kit.boxAt(2.2, 0.7, 1.6, -3.5, CEIL, -2.0, { edge: 'soft' }));   // HVAC
  group.add(kit.boxAt(1.6, 0.5, 1.2, 3.5, CEIL, -3.0, { edge: 'soft' }));    // HVAC

  // --- STOREFRONT (+z face): mullioned glass, kick base, fascia, entrance ----
  const front: number[] = [];
  for (const mx of [-9, -7.5, -6, -4.5, -3, -1.5, 1.5, 3, 4.5, 6, 7.5, 9]) front.push(mx, 0, ZF, mx, 2.4, ZF); // mullions
  for (const hy of [0.0, 1.2, 2.4]) front.push(-HX, hy, ZF, -DOOR_HW, hy, ZF, DOOR_HW, hy, ZF, HX, hy, ZF);    // transoms (skip door)
  group.add(kit.line(front, 'faint'));
  group.add(kit.boxAt(7.8, 0.4, 0.14, -5.1, 0, ZF, { edge: 'soft' }));       // glazing kick (left of door)
  group.add(kit.boxAt(7.8, 0.4, 0.14, 5.1, 0, ZF, { edge: 'soft' }));        // glazing kick (right of door)
  group.add(kit.boxAt(HX * 2, 0.9, 0.2, 0, 2.7, ZF + 0.06, { edge: 'ink' })); // fascia signboard
  letters(group, kit, 0, 3.0, ZF + 0.17, 8.0, 'SUPERMARKET');               // fascia lettering

  // --- ENTRANCE (front-centre): jambs, header, twin sliding glass, canopy ----
  for (const jx of [-DOOR_HW, DOOR_HW]) group.add(kit.boxAt(0.1, DOOR_H, 0.16, jx, 0, ZF, { edge: 'soft' })); // jambs
  group.add(kit.boxAt(DOOR_HW * 2 + 0.2, 0.15, 0.16, 0, DOOR_H, ZF, { edge: 'soft' })); // header
  group.add(kit.line([-DOOR_HW, DOOR_H, ZF, -0.5, DOOR_H, ZF, -0.5, DOOR_H, ZF, -0.5, 0, ZF,   // twin leaves, slid open
                      DOOR_HW, DOOR_H, ZF, 0.5, DOOR_H, ZF, 0.5, DOOR_H, ZF, 0.5, 0, ZF], 'faint'));
  group.add(kit.boxAt(2.6, 0.04, 0.7, 0, 0, ZF - 0.35, { edge: 'faint' }));  // threshold mat
  group.add(kit.boxAt(3.2, 0.16, 1.1, 0, 2.35, ZF + 0.45, { edge: 'soft' })); // entrance canopy

  // --- five department GONDOLA aisles ---------------------------------------
  for (const z of ZONES) buildZone(group, kit, mats, z);

  // --- DRINKS cooler run along the back wall + its sign ----------------------
  for (const cx of [-6.4, -3.2, 0, 3.2, 6.4]) cooler(group, kit, mats, cx);
  aisleSign(group, kit, mats, T.drinks, 0, 2.45, -6.2 + 0.4 + 0.3, 'DRINKS');

  // --- CHECKOUT row + cart corrals just inside the doors --------------------
  for (const cx of [-5.5, -2.5, 2.5, 5.5]) checkout(group, kit, cx, 5.0);
  for (const [cx, cz] of [[-8, 5.5], [8, 5.5]] as const) {
    const c = cartCorral(kit); c.position.set(cx, 0, cz); group.add(c);
  }

  // local-space entrance point, on the storefront threshold, for future pathing.
  return { group, door: new V(0, 0, ZF) };
}
