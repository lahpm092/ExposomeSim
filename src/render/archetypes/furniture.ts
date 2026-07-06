// =============================================================================
// furniture.ts — the FURNITURE WORKSHOP archetype: a gable-fronted timber-frame
// shop with exposed post-and-beam line-work, a wide sliding BARN DOOR (one leaf
// rolled open), an open wood-store lean-to stacked with planks, and a working
// yard (sawhorse, plank stacks, a finished chair on show). Sawdust-warm accent.
// Silhouette read at 60m: steep front gable + the low lean-to shoulder.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, chairPiece, h01, inscribe, plankStack, prism, rectXY, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(10.5, ctx.w - 9), hw = W / 2;      // main body (lean-to takes the rest)
  const D = Math.min(13, ctx.d - 5), zf = D / 2, zb = -D / 2;
  const H = 3.0;                                        // eave height
  const RISE = 2.3;                                     // gable rise
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;         // lean-to side
  const dx = -side * 0.9;                               // barn-door centre

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- front wall: piers + band, with the wide barn-door opening -------------
  const wz = zf - 0.09;
  const DOOR_HW = 1.6;                                  // barn door half-width
  const wx = side * (hw - 1.35);                        // small display window centre
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, dx - DOOR_HW], [dx + DOOR_HW, wx - 0.95], [wx + 0.95, hw]]
    : [[-hw, wx - 0.95], [wx + 0.95, dx - DOOR_HW], [dx + DOOR_HW, hw]];
  for (const [x0, x1] of spans) g.add(kit.boxAt(Math.max(x1 - x0, 0.05), 2.7, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  g.add(kit.boxAt(W, H - 2.7, 0.18, 0, 2.7, wz, { edge: 'ink' }));

  // --- gable roof (ridge along z) + gable-end infills -------------------------
  const tri: Array<[number, number]> = [[-(hw + 0.35), 0], [0, RISE], [hw + 0.35, 0]];
  const roof = prism(tri, D + 0.7, { edge: 'ink' });
  roof.position.y = H;
  g.add(roof);
  const gable = prism(tri.map(([x, y]) => [x * 0.94, y * 0.95] as [number, number]), 0.16, { edge: 'soft' });
  gable.position.set(0, H, zf - 0.1);
  g.add(gable);
  const gback = gable.clone(); gback.position.set(0, H, zb + 0.1); g.add(gback);

  // --- EXPOSED TIMBER FRAME on the front face (sawdust-warm line-work) --------
  const tf: number[] = [];
  for (const px of [-hw + 0.12, dx - DOOR_HW - 0.05, dx + DOOR_HW + 0.05, hw - 0.12])   // posts
    tf.push(px, 0.05, zf + 0.03, px, H - 0.05, zf + 0.03);
  tf.push(-hw, H - 0.12, zf + 0.03, hw, H - 0.12, zf + 0.03);                            // top plate
  tf.push(-hw, 2.62, zf + 0.03, hw, 2.62, zf + 0.03);                                    // door-head rail
  // corner braces
  tf.push(-hw + 0.12, 2.0, zf + 0.03, dx - DOOR_HW - 0.05, 2.62, zf + 0.03);
  tf.push(hw - 0.12, 2.0, zf + 0.03, dx + DOOR_HW + 0.05, 2.62, zf + 0.03);
  // gable frame: king post + struts (proud of the roof's front end cap)
  const gz = zf + 0.38;
  tf.push(0, H + 0.02, gz, 0, H + RISE - 0.15, gz);
  tf.push(-hw * 0.42, H + RISE * 0.4, gz, 0, H + 0.66, gz);
  tf.push(hw * 0.42, H + RISE * 0.4, gz, 0, H + 0.66, gz);
  // flank frames: posts + rails + corner braces on both long walls
  for (const fxs of [-1, 1]) {
    const fx = fxs * (hw + 0.015);
    for (const pz of [zb + 0.15, zb + D / 3, zb + (2 * D) / 3, zf - 0.15])
      tf.push(fx, 0.05, pz, fx, H - 0.05, pz);
    for (const ry of [1.5, H - 0.12]) tf.push(fx, ry, zb + 0.1, fx, ry, zf - 0.1);
    tf.push(fx, H - 0.12, zb + 0.15, fx, 1.9, zb + D / 3, fx, H - 0.12, zf - 0.15, fx, 1.9, zb + (2 * D) / 3);
  }
  g.add(tintLine(tf, TONE.timber));

  // --- the BARN DOOR: track, one leaf shut, one leaf rolled open --------------
  g.add(kit.boxAt(DOOR_HW * 2 + 1.6, 0.12, 0.1, dx, 2.78, zf + 0.12, { edge: 'ink' })); // track
  const leaf = (lx: number, open: boolean): void => {
    g.add(kit.boxAt(1.55, 2.6, 0.08, lx, 0.08, zf + (open ? 0.22 : 0.16), { edge: 'ink' }));
    const xb: number[] = [];                                                             // X-brace
    xb.push(lx - 0.7, 0.2, zf + (open ? 0.27 : 0.21), lx + 0.7, 2.5, zf + (open ? 0.27 : 0.21));
    xb.push(lx - 0.7, 2.5, zf + (open ? 0.27 : 0.21), lx + 0.7, 0.2, zf + (open ? 0.27 : 0.21));
    xb.push(lx - 0.7, 1.35, zf + (open ? 0.27 : 0.21), lx + 0.7, 1.35, zf + (open ? 0.27 : 0.21));
    g.add(tintLine(xb, TONE.timber));
    g.add(kit.line([lx - 0.3, 2.68, zf + 0.16, lx - 0.3, 2.78, zf + 0.16,               // hangers
      lx + 0.3, 2.68, zf + 0.16, lx + 0.3, 2.78, zf + 0.16], 'soft'));
  };
  leaf(dx - 0.8, false);
  leaf(dx + DOOR_HW + 0.75, true);                       // rolled clear of the opening

  // --- display window (a finished chair sits here when interior mounts) ------
  g.add(kit.line(rectXY(wx - 0.95, wx + 0.95, 0.55, 2.3, zf + 0.02), 'faint'));
  g.add(kit.line([wx, 0.55, zf + 0.02, wx, 2.3, zf + 0.02], 'faint'));
  g.add(kit.boxAt(1.95, 0.55, 0.25, wx, 0, zf - 0.14, { edge: 'soft' }));      // window base

  // --- open LEAN-TO wood store on the flank ----------------------------------
  const LD = 2.4;                                       // lean-to depth out from the wall
  const lx0 = side * hw, lx1 = side * (hw + LD);
  const lroof = prism([[0, 0.55], [side * LD, 0], [side * LD, -0.12], [0, 0.43]] as Array<[number, number]>, D * 0.62, { edge: 'ink' });
  lroof.position.set(lx0, 2.15, -1.1);
  g.add(lroof);
  for (const pz of [-1.1 - D * 0.31 + 0.25, -1.1 + D * 0.31 - 0.25])
    g.add(kit.boxAt(0.14, 2.15, 0.14, lx1 - side * 0.1, 0, pz, { edge: 'ink' }));
  const store1 = plankStack(); store1.position.set((lx0 + lx1) / 2, 0, -2.2); store1.rotation.y = Math.PI / 2; g.add(store1);
  const store2 = plankStack(); store2.position.set((lx0 + lx1) / 2, 0.28, -2.15); store2.rotation.y = Math.PI / 2 + 0.08; g.add(store2);
  const store3 = plankStack(); store3.position.set((lx0 + lx1) / 2, 0, 0.4); store3.rotation.y = Math.PI / 2 - 0.06; g.add(store3);

  // --- working yard out front: sawhorse + planks + sawdust --------------------
  const yardX = -side * (hw - 1.6);
  const sh = kit.group();                               // sawhorse: two A-frames + a beam
  for (const az of [-0.55, 0.55]) {
    sh.add(kit.line([
      -0.3, 0, az, 0, 0.75, az, 0.3, 0, az, 0, 0.75, az,
      -0.18, 0.28, az, 0.18, 0.28, az,
    ], 'ink'));
  }
  sh.add(kit.boxAt(0.16, 0.12, 1.4, 0, 0.75, 0, { edge: 'ink' }));
  const plank = kit.boxAt(0.28, 0.05, 2.2, 0, 0.87, 0.2, { edge: 'soft' });
  plank.rotation.y = 0.15; sh.add(plank);
  sh.position.set(yardX, 0, zf + 1.7);
  sh.rotation.y = h01(ctx.seed, 2) * 0.8 - 0.4;
  g.add(sh);
  const yardPlanks = plankStack();
  yardPlanks.position.set(yardX + side * 2.2, 0, zf + 1.9);
  yardPlanks.rotation.y = 0.3;
  g.add(yardPlanks);
  const dust: number[] = [];                            // sawdust scatter ticks
  for (let i = 0; i < 9; i++) {
    const ax = yardX + (h01(ctx.seed, 10 + i) - 0.5) * 2.4, az = zf + 1.7 + (h01(ctx.seed, 20 + i) - 0.5) * 1.6;
    dust.push(ax, 0.01, az, ax + 0.12, 0.01, az + 0.05);
  }
  g.add(tintLine(dust, TONE.timber));

  // --- gable sign board (proud of the roof cap so it always reads) -----------
  g.add(kit.boxAt(4.9, 0.75, 0.14, 0, H + 0.35, zf + 0.34, { edge: 'ink' }));
  g.add(inscribe('FURNITURE', 0, H + 0.55, zf + 0.43, 0.4, 0.36, 0.13, { tone: 'soft' }));
  g.add(tintLine([-2.2, H + 0.48, zf + 0.43, 2.2, H + 0.48, zf + 0.43], TONE.timber));
  // loft vent high in the gable
  g.add(kit.line(rectXY(-0.45, 0.45, H + 1.35, H + 1.85, gz).concat(
    [-0.45, H + 1.6, gz, 0.45, H + 1.6, gz]), 'soft'));

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // the WORKBENCH: heavy top on trestles + a vice + tools
    k2.add(ig, k2.boxAt(2.6, 0.85, 1.0, -side * 1.2, 0, -0.6, { edge: 'ink' }));
    ig.add(k2.slab(2.8, 1.1, -side * 1.2, 0.9, -0.6, { edge: 'soft' }));
    k2.add(ig, k2.boxAt(0.22, 0.2, 0.3, -side * 1.2 - 1.1, 0.9, -0.25, { edge: 'ink' })); // vice
    ig.add(k2.line([-side * 1.2 - 1.1, 1.0, -0.1, -side * 1.2 - 1.1, 1.0, 0.15], 'soft')); // vice bar
    // finished pieces: a chair in the window, a chair + table mid-floor
    const c1 = chairPiece(); c1.position.set(wx, 0.55, zf - 0.55); c1.rotation.y = Math.PI + 0.3; ig.add(c1);
    const c2 = chairPiece(); c2.position.set(side * 1.6, 0, zf - 3.4); c2.rotation.y = -0.5; ig.add(c2);
    k2.add(ig, k2.slab(1.3, 0.9, side * 2.4, 0.74, zf - 4.3, { edge: 'soft' }));   // table top
    const tl: number[] = [];
    for (const [px, pz] of [[-0.55, -0.35], [0.55, -0.35], [-0.55, 0.35], [0.55, 0.35]] as const)
      tl.push(side * 2.4 + px, 0, zf - 4.3 + pz, side * 2.4 + px, 0.74, zf - 4.3 + pz);
    ig.add(k2.line(tl, 'ink'));
    // work-in-progress: planks + a half-built frame leaning on the back wall
    const wip = plankStack(); wip.position.set(-side * 2.0, 0, zb + 1.3); wip.rotation.y = 0.2; ig.add(wip);
    const frame = k2.boxAt(1.1, 1.5, 0.06, side * 1.0, 0.1, zb + 0.5, { edge: 'ink', fill: false });
    frame.rotation.x = -0.18; ig.add(frame);
    // pegboard tool wall: faint ticks along the flank
    const tools: number[] = [];
    for (let i = 0; i < 8; i++) {
      const tz = zb + 1.2 + i * 0.55;
      tools.push(-side * (hw - 0.24), 1.7, tz, -side * (hw - 0.24), 1.7 - (0.25 + (i % 3) * 0.12), tz);
    }
    ig.add(k2.line(tools, 'faint'));
    // shavings around the bench
    const shav: number[] = [];
    for (let i = 0; i < 7; i++) {
      const ax = -side * 1.2 + (h01(ctx.seed, 30 + i) - 0.5) * 2.6, az = -0.6 + (h01(ctx.seed, 40 + i) - 0.5) * 1.8;
      shav.push(ax, 0.02, az, ax + 0.1, 0.02, az + 0.08);
    }
    ig.add(tintLine(shav, TONE.timber));
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('furniture', build);
