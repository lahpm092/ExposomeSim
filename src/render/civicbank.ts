// =============================================================================
// civicbank.ts — two INSTITUTIONAL buildings in the house line-work style (paper
// fill that occludes cleanly + crisp ink edges), sized in REAL metres against the
// ~1.72 m agents (1 world-unit = 1 metre). Built entirely through the shared kit,
// mirroring foodcourt.ts / office.ts: +x runs ACROSS the front · +z points to the
// FRONT (entrance / town centre) · floor at y=0. Everything hangs under one group
// at the origin; the caller places it. Each builder returns { group, door } where
// `door` is the local-space entrance point.
//
//   buildFederalReserve — a monumental neoclassical temple-front: marble plinth,
//     a broad entrance flight, an eight-column fluted colonnade under a full
//     entablature + triangular PEDIMENT, an incised "FEDERAL RESERVE" frieze, a
//     balustraded flat roof with a low central dome and flanking flagpoles.
//   buildCommercialBank — a smaller four-column bank: shorter portico + steps,
//     glass storefront doors, a "BANK" fascia, street windows, a parapet with a
//     rooftop sign box, and — through its see-through walls — a round VAULT door
//     on the back wall (disc + concentric rings + spoke wheel).
//
// Ink-on-sepia only: hierarchy comes from the four edge weights (ink / soft /
// faint), never colour or texture. A few hundred meshes each, at most.
// =============================================================================
import * as THREE from 'three';
import { makeKit, type Kit } from './kit';
import { makeCityMats, type CityMats } from './worldgeo';

const V = THREE.Vector3;

// ---------------------------------------------------------------------------
// tiny incised-lettering font — one stroke set per capital, in a unit cell
// (x,y ∈ [0,1]); every 4 numbers is a segment [x0,y0,x1,y1]. We only need the
// glyphs in "FEDERAL RESERVE" and "BANK". Drawn faint, like foodcourt's signage.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  ' ': [],
  A: [0, 0, 0.5, 1, 0.5, 1, 1, 0, 0.2, 0.42, 0.8, 0.42],
  B: [0, 0, 0, 1, 0, 1, 0.72, 1, 0, 0.55, 0.72, 0.55, 0, 0, 0.72, 0,
    0.72, 1, 0.96, 0.8, 0.96, 0.8, 0.72, 0.55, 0.72, 0.55, 0.96, 0.3, 0.96, 0.3, 0.72, 0],
  D: [0, 0, 0, 1, 0, 1, 0.6, 1, 0, 0, 0.6, 0, 0.6, 1, 1, 0.72, 1, 0.72, 1, 0.28, 1, 0.28, 0.6, 0],
  E: [0, 0, 0, 1, 0, 1, 1, 1, 0, 0.55, 0.72, 0.55, 0, 0, 1, 0],
  F: [0, 0, 0, 1, 0, 1, 1, 1, 0, 0.55, 0.72, 0.55],
  K: [0, 0, 0, 1, 0, 0.5, 1, 1, 0, 0.5, 1, 0],
  L: [0, 0, 0, 1, 0, 0, 1, 0],
  N: [0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1],
  R: [0, 0, 0, 1, 0, 1, 0.7, 1, 0.7, 1, 1, 0.75, 1, 0.75, 0.72, 0.55,
    0, 0.55, 0.72, 0.55, 0.4, 0.55, 1, 0],
  S: [1, 1, 0, 1, 0, 1, 0, 0.55, 0, 0.55, 1, 0.55, 1, 0.55, 1, 0, 1, 0, 0, 0],
  V: [0, 1, 0.5, 0, 0.5, 0, 1, 1],
};

/** incised inscription centred on cx, sitting on the plane z, letters cw×ch. */
function inscribe(
  kit: Kit, text: string, cx: number, y: number, z: number,
  cw: number, ch: number, gap: number, tone: 'faint' | 'soft' = 'faint',
): THREE.LineSegments {
  const pitch = cw + gap;
  const total = text.length * pitch - gap;
  let sx = cx - total / 2;
  const pts: number[] = [];
  for (const c of text) {
    const strokes = FONT[c] ?? [];
    for (let i = 0; i < strokes.length; i += 4) {
      pts.push(sx + strokes[i] * cw, y + strokes[i + 1] * ch, z,
        sx + strokes[i + 2] * cw, y + strokes[i + 3] * ch, z);
    }
    sx += pitch;
  }
  return kit.line(pts, tone);
}

// ---------------------------------------------------------------------------
// small geometry helpers (all return flat [x,y,z,…] segment-pair arrays so many
// can be concatenated into ONE kit.line for cheapness).
// ---------------------------------------------------------------------------
/** the four edges of an axis-aligned rectangle in the XY plane at depth z. */
function rectXY(x0: number, x1: number, y0: number, y1: number, z: number): number[] {
  return [
    x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z,
    x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z,
  ];
}
/** a full ring of `seg` chords, radius r, in the XY plane at depth z. */
function ringXY(r: number, seg: number, z: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, Math.sin(a0) * r, z, Math.cos(a1) * r, Math.sin(a1) * r, z);
  }
  return pts;
}

/** a fluted classical column (square base block + round shaft + square capital),
 *  standing on y0 with shaft height h and radius r. Front-facing flutes are added
 *  by the caller (batched). Everything is added straight to `parent` at (x,z). */
function addColumn(
  kit: Kit, parent: THREE.Object3D, x: number, z: number, y0: number, h: number, r: number,
): void {
  const capW = r * 2.5;
  parent.add(kit.boxAt(capW, 0.4, capW, x, y0, z, { edge: 'soft' }));            // plinth block
  parent.add(kit.cylAt(r, h, 12, x, y0 + 0.2, z, { edge: 'ink' }));              // shaft
  parent.add(kit.boxAt(capW, 0.45, capW, x, y0 + 0.2 + h, z, { edge: 'ink' }));  // capital
}

// ===========================================================================
//  FEDERAL RESERVE — imposing neoclassical civic architecture (~24 × 16 × 18 m)
// ===========================================================================
export function buildFederalReserve(mats: ReturnType<typeof makeCityMats>): { group: THREE.Group; door: THREE.Vector3 } {
  const kit = makeKit(mats);
  const g = kit.group();

  // --- envelope constants (metres) -----------------------------------------
  const HX = 12;                 // half-width → 24 m across
  const ZB = -10, PLINTH_ZF = 8; // stone base runs back(-10) → front(8): 18 m deep
  const PLINTH_H = 1.8;          // raised marble plinth / stylobate
  const CELLA_ZF = 4;            // solid facade (cella) front wall plane
  const COL_Z = 6;               // colonnade stands between facade and steps
  const COL_H = 8.8;             // fluted shaft height
  const COL_TOP = PLINTH_H + 0.2 + COL_H + 0.45; // 11.25 — top of capitals
  const CELLA_TOP = PLINTH_H + 9.45;             // 11.25 — flat roof of the block
  const ENT_ZF = 6.9, ENT_ZB = 4.0;             // entablature ties columns → cella
  const ENT_ZC = (ENT_ZF + ENT_ZB) / 2, ENT_D = ENT_ZF - ENT_ZB;

  // --- marble plinth + a base moulding line ---------------------------------
  g.add(kit.boxAt(HX * 2, PLINTH_H, PLINTH_ZF - ZB, 0, 0, (ZB + PLINTH_ZF) / 2, { edge: 'ink' }));
  g.add(kit.line(rectXY(-HX, HX, 0.35, 0.35, PLINTH_ZF + 0.01).concat( // faint plinth banding
    [-HX, 0.35, PLINTH_ZF + 0.01, -HX, 0.35, ZB, HX, 0.35, PLINTH_ZF + 0.01, HX, 0.35, ZB]), 'faint'));

  // --- broad entrance flight (projects forward of the plinth, +z) -----------
  const STEPS = 6, RISER = PLINTH_H / STEPS, RUN = 0.6, STEP_W = 15;
  for (let i = 0; i < STEPS; i++) {
    const depth = (STEPS - i) * RUN;                 // deeper at the bottom
    g.add(kit.boxAt(STEP_W, RISER, depth, 0, i * RISER, PLINTH_ZF + depth / 2, { edge: 'soft' }));
  }

  // --- solid stone facade block (the cella) ---------------------------------
  g.add(kit.boxAt(22, CELLA_TOP - PLINTH_H, CELLA_ZF - ZB, 0, PLINTH_H, (ZB + CELLA_ZF) / 2, { edge: 'ink' }));

  // --- eight fluted columns across the front + their front flutes -----------
  const cols: number[] = [];
  for (let i = 0; i < 8; i++) cols.push(-9.5 + i * (19 / 7));
  const flutes: number[] = [];
  for (const cx of cols) {
    addColumn(kit, g, cx, COL_Z, PLINTH_H, COL_H, 0.6);
    for (const dx of [-0.42, -0.21, 0, 0.21, 0.42])        // vertical flute hints, just proud of the shaft
      flutes.push(cx + dx, PLINTH_H + 0.3, COL_Z + 0.62, cx + dx, COL_TOP - 0.3, COL_Z + 0.62);
  }
  g.add(kit.line(flutes, 'faint'));

  // --- entablature (architrave/frieze) + projecting cornice -----------------
  g.add(kit.boxAt(20, 1.4, ENT_D, 0, COL_TOP, ENT_ZC, { edge: 'ink' }));         // frieze band
  g.add(kit.boxAt(21, 0.5, ENT_D + 0.2, 0, COL_TOP + 1.4, ENT_ZC, { edge: 'ink' })); // cornice
  const CORNICE_TOP = COL_TOP + 1.9; // 13.15 — springing line of the pediment
  // incised "FEDERAL RESERVE" across the frieze (faint, like foodcourt signage)
  g.add(inscribe(kit, 'FEDERAL RESERVE', 0, COL_TOP + 0.35, ENT_ZF + 0.02, 0.9, 0.72, 0.32));

  // --- triangular PEDIMENT (two mirrored wedges → a clean isoceles gable) ----
  const PED_W = 21, PED_H = 3.3;
  g.add(kit.wedge(PED_W / 2, PED_H, ENT_D + 0.2, PED_W / 4, CORNICE_TOP, ENT_ZC, { edge: 'ink' }));   // right half
  const pedL = kit.wedge(PED_W / 2, PED_H, ENT_D + 0.2, -PED_W / 4, CORNICE_TOP, ENT_ZC, { edge: 'ink' });
  pedL.rotation.y = Math.PI; g.add(pedL);                                        // left half (mirrored)
  g.add(kit.line(ringXY(0.9, 18, ENT_ZF + 0.03).map((v, i) =>                    // tympanum seal
    i % 3 === 1 ? v + CORNICE_TOP + 1.1 : v), 'soft'));

  // --- flat roof furniture: balustrade, low central dome, flagpoles ---------
  // low balustrade around the visible cella roof edges (front is under the pediment)
  const bal: number[] = [];
  for (const [x0, x1, z] of [[-11, 11, -10]] as const)                            // back rail balusters
    for (let x = x0; x <= x1; x += 1.4) bal.push(x, CELLA_TOP, z, x, CELLA_TOP + 0.7, z);
  for (const x of [-11, 11]) for (let z = -10; z <= 4; z += 1.4) bal.push(x, CELLA_TOP, z, x, CELLA_TOP + 0.7, z);
  g.add(kit.line(bal, 'soft'));
  g.add(kit.boxAt(22, 0.75, 0.3, 0, CELLA_TOP, -10, { edge: 'soft' }));           // back parapet cap
  g.add(kit.boxAt(0.3, 0.75, 14, -11, CELLA_TOP, -3, { edge: 'soft' }));          // left parapet cap
  g.add(kit.boxAt(0.3, 0.75, 14, 11, CELLA_TOP, -3, { edge: 'soft' }));           // right parapet cap
  // a small dignified dome (drum + hemisphere + finial) set back on the roof
  g.add(kit.cylAt(2.2, 1.2, 16, 0, CELLA_TOP, -2.5, { edge: 'ink' }));            // drum
  g.add(kit.ball(2.0, 0, CELLA_TOP + 1.2, -2.5, { edge: 'ink' }));               // hemisphere (lower half inside drum)
  g.add(kit.cylAt(0.14, 0.9, 8, 0, CELLA_TOP + 3.0, -2.5, { edge: 'ink' }));      // finial
  // two flagpoles flanking the entrance, on the plinth front corners
  for (const fx of [-10.5, 10.5]) {
    g.add(kit.cylAt(0.11, 7, 6, fx, PLINTH_H, 7.5, { edge: 'ink' }));
    g.add(kit.boxAt(1.2, 0.7, 0.05, fx + 0.7, PLINTH_H + 6.1, 7.5, { edge: 'soft' })); // furled flag
  }

  // --- tall recessed windows flanking the door (nested rects read as depth) --
  const wFrame: number[] = [], wGlass: number[] = [];
  for (const wx of [-7, -3.6, 3.6, 7]) {
    wFrame.push(...rectXY(wx - 0.9, wx + 0.9, 3.0, 8.2, CELLA_ZF + 0.02));         // outer reveal
    wGlass.push(...rectXY(wx - 0.7, wx + 0.7, 3.2, 8.0, CELLA_ZF - 0.2));          // recessed pane
    wGlass.push(wx, 3.2, CELLA_ZF - 0.2, wx, 8.0, CELLA_ZF - 0.2);                 // centre mullion
    wGlass.push(wx - 0.7, 5.6, CELLA_ZF - 0.2, wx + 0.7, 5.6, CELLA_ZF - 0.2);     // transom bar
  }
  g.add(kit.line(wFrame, 'soft'));
  g.add(kit.line(wGlass, 'faint'));

  // --- central bronze double-door (2.4 m double leaf) under a cornice head ---
  g.add(kit.line(rectXY(-1.3, 1.3, PLINTH_H, 5.3, CELLA_ZF + 0.02), 'soft'));      // door surround
  for (const dx of [-0.62, 0.62]) g.add(kit.boxAt(1.2, 3.4, 0.12, dx, PLINTH_H, CELLA_ZF - 0.15, { edge: 'ink' }));
  g.add(kit.line([0, PLINTH_H, CELLA_ZF - 0.08, 0, PLINTH_H + 3.4, CELLA_ZF - 0.08], 'soft')); // meeting stile
  for (const hx of [-0.16, 0.16]) g.add(kit.knob(0.11, hx, PLINTH_H + 1.5, CELLA_ZF - 0.02, { edge: 'soft' }));
  g.add(kit.boxAt(3.2, 0.35, 0.7, 0, 5.3, CELLA_ZF + 0.05, { edge: 'ink' }));      // door cornice head

  // local-space entrance point: sheltered under the portico, before the doors
  return { group: g, door: new V(0, PLINTH_H, COL_Z - 0.4) };
}

// ===========================================================================
//  COMMERCIAL BANK — a smaller solid columned bank (~16 × 10 × 14 m). See-through
//  walls so the camera reads the interior VAULT on the back wall.
// ===========================================================================
export function buildCommercialBank(mats: ReturnType<typeof makeCityMats>): { group: THREE.Group; door: THREE.Vector3 } {
  const kit = makeKit(mats);
  const g = kit.group();

  // --- envelope constants (metres) -----------------------------------------
  const HX = 7.5;                 // interior half-width (walls) → shell ~16 across
  const ZB = -6, ZF = 4;          // back wall / front wall planes (interior 10 deep)
  const BASE_H = 0.6;             // low plinth the whole building sits on
  const CEIL = BASE_H + 7.0;      // 7.6 — wall / roof height
  const COL_Z = 5, COL_H = 4.6;   // portico columns stand out in front (+z)
  const PORT_TOP = BASE_H + 0.2 + COL_H + 0.45; // 5.85 — portico entablature underside-ish

  // --- low plinth + interior floor plate ------------------------------------
  g.add(kit.boxAt(16, BASE_H, 13, 0, 0, -0.5, { edge: 'ink' }));                   // plinth (z -7 → 6)
  g.add(kit.boxAt(HX * 2 + 0.4, 0.1, ZF - ZB, 0, BASE_H - 0.05, (ZB + ZF) / 2, { edge: 'soft' })); // floor

  // --- short entrance flight (front) ----------------------------------------
  const STEPS = 3, RISER = BASE_H / STEPS, RUN = 0.5, STEP_W = 6;
  for (let i = 0; i < STEPS; i++) {
    const depth = (STEPS - i) * RUN;
    g.add(kit.boxAt(STEP_W, RISER, depth, 0, i * RISER, 6 + depth / 2, { edge: 'soft' }));
  }

  // --- see-through shell: perimeter walls + solid roof cap ------------------
  // edge-only walls (never box the camera out — same trick as foodcourt.ts)
  g.add(kit.line(rectXY(-HX, HX, BASE_H, CEIL, ZB), 'faint'));                     // back wall
  g.add(kit.line(rectXY(-HX, HX, BASE_H, CEIL, ZF).concat([                       // front wall + door header
    -1.5, BASE_H + 2.6, ZF, 1.5, BASE_H + 2.6, ZF]), 'faint'));
  g.add(kit.line([                                                                 // side walls (ZY)
    -HX, BASE_H, ZB, -HX, BASE_H, ZF, -HX, CEIL, ZB, -HX, CEIL, ZF,
    -HX, BASE_H, ZB, -HX, CEIL, ZB, -HX, BASE_H, ZF, -HX, CEIL, ZF,
    HX, BASE_H, ZB, HX, BASE_H, ZF, HX, CEIL, ZB, HX, CEIL, ZF,
    HX, BASE_H, ZB, HX, CEIL, ZB, HX, BASE_H, ZF, HX, CEIL, ZF,
  ], 'faint'));
  g.add(kit.boxAt(HX * 2 + 0.4, 0.4, ZF - ZB, 0, CEIL, (ZB + ZF) / 2, { edge: 'ink' })); // solid roof cap

  // --- four-column portico + entablature + "BANK" fascia --------------------
  for (const cx of [-4.6, -1.55, 1.55, 4.6]) addColumn(kit, g, cx, COL_Z, BASE_H, COL_H, 0.42);
  g.add(kit.boxAt(11, 1.0, 1.2, 0, PORT_TOP, COL_Z, { edge: 'ink' }));             // portico beam
  g.add(kit.boxAt(11.6, 0.35, 1.5, 0, PORT_TOP + 1.0, COL_Z, { edge: 'ink' }));    // cornice cap
  g.add(inscribe(kit, 'BANK', 0, PORT_TOP + 0.24, COL_Z + 0.62, 1.1, 0.6, 0.4, 'soft'));

  // --- glass storefront doors (transparent: outlines only, no fill) ----------
  g.add(kit.line(rectXY(-1.4, 1.4, BASE_H, 3.3, ZF + 0.02), 'soft'));              // door surround
  const doorGlass: number[] = [];
  for (const dx of [-0.65, 0.65]) {
    g.add(kit.boxAt(1.25, 2.6, 0.05, dx, BASE_H, ZF - 0.03, { edge: 'faint', fill: false }));
    doorGlass.push(dx, BASE_H + 1.0, ZF, dx, BASE_H + 2.0, ZF);                    // push-bar handle
  }
  doorGlass.push(0, BASE_H, ZF + 0.01, 0, BASE_H + 2.6, ZF + 0.01);               // meeting stile
  g.add(kit.line(doorGlass, 'soft'));

  // --- two street-facing storefront windows (mullioned glazing) -------------
  const win: number[] = [];
  for (const wx of [-4.6, 4.6]) {
    win.push(...rectXY(wx - 1.1, wx + 1.1, 1.0, 4.2, ZF + 0.02));
    win.push(wx, 1.0, ZF + 0.02, wx, 4.2, ZF + 0.02);                             // vertical mullion
    win.push(wx - 1.1, 2.6, ZF + 0.02, wx + 1.1, 2.6, ZF + 0.02);                 // horizontal mullion
  }
  g.add(kit.line(win, 'faint'));

  // --- the VAULT: a thick round door on the interior back wall, facing +z ----
  // built facing +z (near face at local z=0), then stood just off the back wall.
  const vault = kit.group();
  const disc = kit.cyl(1.7, 0.5, 20, { edge: 'ink' });
  disc.rotation.x = -Math.PI / 2;                          // lay the drum flat, faces to ±z
  vault.add(disc);
  const rings: number[] = [];
  for (const r of [1.55, 1.15, 0.75]) rings.push(...ringXY(r, 20, 0.02));          // concentric ink rings
  for (let i = 0; i < 4; i++) {                                                     // spoke-wheel handle
    const a = (i / 4) * Math.PI * 2;
    rings.push(Math.cos(a) * 0.7, Math.sin(a) * 0.7, 0.03, Math.cos(a) * 0.18, Math.sin(a) * 0.18, 0.03);
  }
  vault.add(kit.line(rings, 'ink'));
  const hub = kit.cyl(0.2, 0.25, 10, { edge: 'ink' });    // central spindle boss
  hub.rotation.x = -Math.PI / 2; vault.add(hub);
  const bolts: number[] = [];                                                       // short radial rim bolts
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); bolts.push(c * 1.55, s * 1.55, 0.03, c * 1.68, s * 1.68, 0.03); }
  vault.add(kit.line(bolts, 'soft'));
  vault.position.set(0, 2.8, ZB + 0.55);                   // centred on the back wall
  g.add(vault);

  // --- parapet + rooftop sign box -------------------------------------------
  g.add(kit.boxAt(HX * 2 + 0.4, 0.55, 0.25, 0, CEIL + 0.4, ZB, { edge: 'soft' }));      // back parapet
  for (const px of [-HX - 0.1, HX + 0.1]) g.add(kit.boxAt(0.25, 0.55, ZF - ZB, px, CEIL + 0.4, (ZB + ZF) / 2, { edge: 'soft' }));
  g.add(kit.boxAt(HX * 2 + 0.4, 0.55, 0.25, 0, CEIL + 0.4, ZF, { edge: 'soft' }));      // front parapet
  g.add(kit.boxAt(4.5, 1.3, 0.5, 0, CEIL + 0.55, -1.5, { edge: 'ink' }));               // rooftop sign box
  g.add(inscribe(kit, 'BANK', 0, CEIL + 0.85, -1.24, 0.7, 0.7, 0.32, 'faint'));

  // local-space entrance point: on the top step, before the glass doors
  return { group: g, door: new V(0, BASE_H, COL_Z + 0.6) };
}
