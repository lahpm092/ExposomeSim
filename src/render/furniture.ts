// =============================================================================
// furniture.ts — low-poly, clearly-recognizable appliances & furniture for the
// studio, built against the shared `kit`. These are authored to be replaced /
// refined by the parallel modelling agents; each faces +z, base on y=0, origin
// at the footprint centre. Recognizable-by-silhouette is the bar.
// =============================================================================
import type { Kit } from './kit';
import type { Group } from 'three';

// ---- KITCHEN: base cabinets · worktop · sink · stove+oven · hood · uppers · fridge
export function buildKitchen(kit: Kit): Group {
  const g = kit.group();
  // base cabinets (2.0 wide) + worktop
  kit.add(g, kit.boxAt(2.0, 0.9, 0.6, -0.4, 0, -0.3));
  kit.add(g, kit.boxAt(2.1, 0.06, 0.64, -0.4, 0.9, -0.3, { edge: 'soft' }));
  kit.add(g, kit.line([-1.4, 0, 0.0, -1.4, 0.9, 0.0, -0.4, 0, 0.0, -0.4, 0.9, 0.0, 0.6, 0, 0.0, 0.6, 0.9, 0.0], 'faint')); // door splits
  for (const x of [-1.15, -0.15, 0.35]) kit.add(g, kit.knob(0.04, x, 0.5, 0.02));
  // sink basin + faucet
  kit.add(g, kit.boxAt(0.5, 0.12, 0.4, -1.0, 0.84, -0.3, { fill: false, edge: 'soft' }));
  kit.add(g, kit.cylAt(0.02, 0.28, 6, -1.0, 0.96, -0.42));
  kit.add(g, kit.line([-1.0, 1.24, -0.42, -1.0, 1.24, -0.28], 'ink'));
  // stove: oven box + door handle + 4 burners
  kit.add(g, kit.boxAt(0.62, 0.9, 0.6, 0.35, 0, -0.3));
  kit.add(g, kit.line([0.08, 0.5, 0.0, 0.62, 0.5, 0.0], 'soft')); // oven handle
  for (const [bx, bz] of [[0.2, -0.18], [0.5, -0.18], [0.2, -0.42], [0.5, -0.42]] as const)
    kit.add(g, kit.cylAt(0.09, 0.02, 10, bx, 0.96, bz, { edge: 'soft' }));
  // range hood (wedge) above the stove
  kit.add(g, kit.wedge(0.7, 0.35, 0.5, 0.35, 1.7, -0.35, { edge: 'soft' }));
  // upper wall cabinets
  kit.add(g, kit.boxAt(1.6, 0.6, 0.35, -0.6, 1.5, -0.45, { edge: 'soft' }));
  kit.add(g, kit.line([-0.6, 1.5, -0.27, -0.6, 2.1, -0.27], 'faint'));
  // tall fridge at the right end (two-door split + handles)
  kit.add(g, kit.boxAt(0.62, 1.85, 0.62, 1.15, 0, -0.3));
  kit.add(g, kit.line([0.84, 1.05, 0.01, 1.46, 1.05, 0.01], 'soft'));
  kit.add(g, kit.line([1.4, 0.55, 0.02, 1.4, 0.95, 0.02, 1.4, 1.15, 0.02, 1.4, 1.55, 0.02], 'ink'));
  return g;
}

// ---- BATHROOM: shower stall · toilet · vanity+mirror -----------------------
export function buildBathroom(kit: Kit): Group {
  const g = kit.group();
  // shower stall (glass frame + tray + head)
  kit.add(g, kit.boxAt(0.9, 0.08, 0.9, -0.6, 0, -0.4));                       // tray
  kit.add(g, kit.boxAt(0.9, 2.0, 0.9, -0.6, 0, -0.4, { fill: false }));       // glass frame
  kit.add(g, kit.cylAt(0.015, 1.6, 6, -0.95, 0.1, -0.75));                    // riser
  kit.add(g, kit.cylAt(0.09, 0.03, 10, -0.75, 1.7, -0.75, { edge: 'soft' })); // head
  kit.add(g, kit.line([-0.95, 1.7, -0.75, -0.78, 1.7, -0.75], 'soft'));       // arm
  // toilet: bowl + seat + tank
  kit.add(g, kit.cylAt(0.2, 0.4, 10, 0.55, 0, -0.5));                         // bowl pedestal
  kit.add(g, kit.slab(0.42, 0.5, 0.55, 0.42, -0.5, { edge: 'soft' }));        // seat
  kit.add(g, kit.boxAt(0.5, 0.4, 0.18, 0.55, 0.42, -0.78));                   // tank
  kit.add(g, kit.knob(0.05, 0.55, 0.86, -0.7));                               // flush button
  // vanity + basin + mirror
  kit.add(g, kit.boxAt(0.6, 0.82, 0.4, 0.55, 0, 0.35));
  kit.add(g, kit.boxAt(0.4, 0.1, 0.28, 0.55, 0.82, 0.35, { fill: false, edge: 'soft' })); // basin
  kit.add(g, kit.boxAt(0.5, 0.6, 0.03, 0.55, 1.2, 0.52, { edge: 'soft' }));   // mirror
  return g;
}

// ---- BED: frame · mattress · duvet · pillows · headboard · nightstand+lamp · wardrobe
export function buildBed(kit: Kit): Group {
  const g = kit.group();
  kit.add(g, kit.boxAt(1.5, 0.28, 2.0, 0, 0, 0));                    // frame/base
  kit.add(g, kit.boxAt(1.44, 0.18, 1.94, 0, 0.28, 0, { edge: 'soft' })); // mattress
  kit.add(g, kit.boxAt(1.44, 0.12, 1.3, 0, 0.46, 0.25, { edge: 'faint' })); // duvet
  for (const px of [-0.36, 0.36]) kit.add(g, kit.boxAt(0.5, 0.14, 0.3, px, 0.46, -0.78, { edge: 'soft' })); // pillows
  kit.add(g, kit.boxAt(1.5, 0.7, 0.1, 0, 0.28, -1.0));              // headboard
  // nightstand + lamp
  kit.add(g, kit.boxAt(0.42, 0.5, 0.4, -1.0, 0, -0.7));
  kit.add(g, kit.line([-1.0, 0.5, -0.7, -1.0, 0.78, -0.7], 'soft'));
  kit.add(g, kit.cylAt(0.09, 0.14, 8, -1.0, 0.78, -0.7, { edge: 'soft' }));  // shade
  // wardrobe
  kit.add(g, kit.boxAt(1.0, 2.0, 0.58, 1.05, 0, -0.6));
  kit.add(g, kit.line([1.05, 0.2, -0.3, 1.05, 1.8, -0.3], 'soft'));
  for (const hx of [0.9, 1.2]) kit.add(g, kit.knob(0.04, hx, 1.0, -0.3));
  return g;
}

// ---- LIVING: sofa · coffee table · TV+stand · dining table+chairs · plant --
export function buildLiving(kit: Kit): Group {
  const g = kit.group();
  // sofa
  kit.add(g, kit.boxAt(1.9, 0.35, 0.85, -0.6, 0, -0.9));            // seat base
  kit.add(g, kit.boxAt(1.9, 0.45, 0.18, -0.6, 0.35, -1.25));        // backrest
  for (const ax of [-1.5, 0.3]) kit.add(g, kit.boxAt(0.2, 0.55, 0.85, ax, 0, -0.9, { edge: 'soft' })); // arms
  kit.add(g, kit.line([-1.2, 0.36, -0.5, -1.2, 0.36, -1.2, 0.0, 0.36, -0.5, 0.0, 0.36, -1.2], 'faint')); // cushion split
  // coffee table
  kit.add(g, kit.boxAt(0.9, 0.35, 0.5, -0.6, 0, 0.0, { edge: 'soft' }));
  // TV on a media stand
  kit.add(g, kit.boxAt(1.4, 0.4, 0.4, -0.6, 0, 1.0, { edge: 'soft' }));
  kit.add(g, kit.boxAt(1.1, 0.66, 0.06, -0.6, 0.5, 1.05));          // screen
  // dining table + 2 chairs
  kit.add(g, kit.cylAt(0.5, 0.74, 12, 1.3, 0, -0.3, { edge: 'soft' }));
  for (const cz of [-0.9, 0.3]) {
    kit.add(g, kit.boxAt(0.4, 0.45, 0.4, 1.3, 0, cz));
    kit.add(g, kit.boxAt(0.4, 0.45, 0.06, 1.3, 0.45, cz + (cz < -0.3 ? -0.17 : 0.17), { edge: 'soft' }));
  }
  // potted plant
  kit.add(g, kit.cylAt(0.14, 0.3, 8, 1.5, 0, 0.9, { edge: 'soft' }));
  kit.add(g, kit.ball(0.28, 1.5, 0.55, 0.9, { edge: 'green' }));
  return g;
}

export const FURNITURE = { kitchen: buildKitchen, bathroom: buildBathroom, bed: buildBed, living: buildLiving };
