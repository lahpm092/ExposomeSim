// =============================================================================
// butcher.ts — the BUTCHER archetype: a flat-roofed shop with a stepped
// art-deco parapet, a glazed-tile stall riser along the base, one WIDE display
// window (the hanging-cuts rail shows through it when the interior is mounted)
// and a bold oxblood striped awning. Silhouette read at 60m: stepped parapet +
// deep dark awning band.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, h01, hangingCuts, inscribe, rectXY, tintBox, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(13, ctx.w - 6), hw = W / 2;
  const D = Math.min(12, ctx.d - 5), zf = D / 2, zb = -D / 2;
  const H = 3.5;
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;          // door side
  const dx = side * (hw - 1.6);                          // door centre
  const wx0 = side > 0 ? -hw + 0.6 : dx + 1.1;           // window span
  const wx1 = side > 0 ? dx - 1.1 : hw - 0.6;
  const wz = zf - 0.09;

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- front facade: piers + band over the openings --------------------------
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, wx0], [wx1, dx - 0.55], [dx + 0.55, hw]]
    : [[-hw, dx - 0.55], [dx + 0.55, wx0], [wx1, hw]];
  for (const [x0, x1] of spans) g.add(kit.boxAt(x1 - x0, 2.5, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  g.add(kit.boxAt(W, H - 2.5, 0.18, 0, 2.5, wz, { edge: 'ink' }));

  // --- glazed-tile stall riser along the base (grid + oxblood course) --------
  const bx1 = side > 0 ? dx - 0.75 : hw;                 // band stops at the door
  const bx0 = side > 0 ? -hw : dx + 0.75;
  g.add(kit.boxAt(bx1 - bx0, 0.78, 0.1, (bx0 + bx1) / 2, 0, zf - 0.02, { edge: 'soft' }));
  const tiles: number[] = [];
  for (let tx = bx0 + 0.35; tx < bx1 - 0.05; tx += 0.35) tiles.push(tx, 0.06, zf + 0.04, tx, 0.72, zf + 0.04);
  tiles.push(bx0 + 0.05, 0.4, zf + 0.04, bx1 - 0.05, 0.4, zf + 0.04);
  g.add(kit.line(tiles, 'faint'));
  g.add(tintLine([bx0 + 0.05, 0.72, zf + 0.045, bx1 - 0.05, 0.72, zf + 0.045], TONE.oxblood)); // cap course

  // --- the WIDE window: sill + mullions + transom -----------------------------
  const win: number[] = rectXY(wx0, wx1, 0.78, 2.5, zf + 0.02);
  const nM = Math.max(2, Math.round((wx1 - wx0) / 1.2));
  for (let i = 1; i < nM; i++) {
    const mx = wx0 + (wx1 - wx0) * (i / nM);
    win.push(mx, 0.78, zf + 0.02, mx, 2.5, zf + 0.02);
  }
  win.push(wx0, 2.1, zf + 0.02, wx1, 2.1, zf + 0.02);
  g.add(kit.line(win, 'faint'));

  // --- door: jambs + half-glazed leaf + step ---------------------------------
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx - 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx + 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.12, 0.14, 0.2, dx, 2.15, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.92, 2.1, 0.08, dx, 0, zf - 0.14, { edge: 'ink' }));
  g.add(kit.line(rectXY(dx - 0.32, dx + 0.32, 1.15, 1.95, zf - 0.09), 'faint'));
  g.add(kit.knob(0.07, dx - side * 0.32, 1.05, zf - 0.08, { edge: 'soft' }));
  g.add(kit.boxAt(1.3, 0.09, 0.5, dx, 0, zf + 0.25, { edge: 'soft' }));

  // --- flat roof + stepped parapet + sign -------------------------------------
  g.add(kit.boxAt(W, 0.22, D, 0, H, 0, { edge: 'ink' }));                     // roof slab
  g.add(kit.boxAt(W, 0.5, 0.22, 0, H + 0.2, zb + 0.11, { edge: 'soft' }));    // back parapet
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.22, 0.5, D, sx * (hw - 0.11), H + 0.2, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, 0.55, 0.26, 0, H + 0.2, zf - 0.13, { edge: 'ink' }));    // front parapet
  const stepW = 4.4 + h01(ctx.seed, 2) * 1.2;
  for (const [sw, sh] of [[stepW + 2.2, 0.5], [stepW, 1.05]] as const)        // the deco steps
    g.add(kit.boxAt(sw, sh, 0.3, 0, H + 0.55, zf - 0.15, { edge: 'ink' }));
  g.add(inscribe('BUTCHER', 0, H + 0.85, zf + 0.03, 0.44, 0.5, 0.16, { tone: 'soft' }));
  g.add(tintLine([-stepW / 2 + 0.3, H + 0.72, zf + 0.02, stepW / 2 - 0.3, H + 0.72, zf + 0.02], TONE.oxblood));
  g.add(kit.boxAt(1.6, 0.5, 1.1, -side * 2.2, H + 0.22, -2.0, { edge: 'soft' })); // rooftop vent

  // --- the BOLD oxblood awning over the window --------------------------------
  const aw = wx1 - wx0 + 0.5, ax = (wx0 + wx1) / 2;
  const awn = kit.group();
  awn.add(kit.boxAt(aw, 0.07, 1.25, 0, -0.04, 0.625, { edge: 'ink' }));
  const stripes: number[] = [];
  const nS = Math.max(8, Math.round(aw / 0.55) * 2);
  for (let i = 0; i <= nS; i++) {
    const sx = -aw / 2 + aw * (i / nS);
    stripes.push(sx, 0.05, 0.06, sx, 0.05, 1.2);
    if (i < nS && i % 2 === 0) {                        // solid-read stripes: three passes per bay
      const sx2 = -aw / 2 + aw * ((i + 0.33) / nS), sx3 = -aw / 2 + aw * ((i + 0.66) / nS);
      stripes.push(sx2, 0.05, 0.06, sx2, 0.05, 1.2, sx3, 0.05, 0.06, sx3, 0.05, 1.2);
    }
  }
  for (let i = 0; i < nS; i += 2) {                     // valance scallops
    const x0 = -aw / 2 + aw * (i / nS), x1 = -aw / 2 + aw * ((i + 1) / nS);
    stripes.push(x0, 0.03, 1.25, (x0 + x1) / 2, -0.2, 1.25, (x0 + x1) / 2, -0.2, 1.25, x1, 0.03, 1.25);
  }
  awn.add(tintLine(stripes, TONE.oxblood));
  awn.position.set(ax, 2.55, zf);
  awn.rotation.x = 0.42;
  g.add(awn);

  // ================= interior / window goods (fresh each call) ===============
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // hanging-cuts rail right behind the window — the signature read
    for (const [cx, cz] of [[(wx0 + wx1) / 2 - 0.9, zf - 0.7], [(wx0 + wx1) / 2 + 0.9, zf - 0.75]] as const) {
      const cuts = hangingCuts(); cuts.position.set(cx, 0, cz); ig.add(cuts);
    }
    // the BLOCK counter: massive maple block on a base + cleaver
    const bx = -side * 1.0;
    k2.add(ig, k2.boxAt(1.9, 0.72, 1.1, bx, 0, zf - 3.2, { edge: 'ink' }));
    ig.add(tintBox(1.7, 0.24, 0.95, bx, 0.72, zf - 3.2, TONE.timber));
    ig.add(k2.line([bx - 0.3, 0.98, zf - 3.1, bx - 0.05, 1.2, zf - 3.25], 'ink')); // cleaver, standing
    // service counter with meat trays under a glass line
    const scx = side * 1.8;
    k2.add(ig, k2.boxAt(2.6, 0.92, 0.9, scx, 0, zf - 3.3, { edge: 'ink' }));
    for (const [tx, tone] of [[scx - 0.8, TONE.oxblood], [scx, TONE.tomato], [scx + 0.8, TONE.oxblood]] as const)
      ig.add(tintBox(0.6, 0.1, 0.5, tx, 0.92, zf - 3.3, tone));
    ig.add(k2.line([scx - 1.3, 1.45, zf - 3.0, scx + 1.3, 1.45, zf - 3.0], 'faint')); // sneeze glass
    // back wall: tiled wainscot grid + a cold-room door
    const tiles: number[] = [];
    for (let tx = -hw + 0.6; tx < hw - 0.5; tx += 0.4) tiles.push(tx, 0.1, zb + 0.2, tx, 1.7, zb + 0.2);
    tiles.push(-hw + 0.5, 0.95, zb + 0.2, hw - 0.5, 0.95, zb + 0.2);
    ig.add(k2.line(tiles, 'faint'));
    k2.add(ig, k2.boxAt(1.3, 2.2, 0.12, -side * (hw - 1.6), 0, zb + 0.26, { edge: 'ink' }));
    ig.add(k2.line([-side * (hw - 1.6) - 0.45, 1.1, zb + 0.34, -side * (hw - 1.6) - 0.2, 1.1, zb + 0.34], 'soft')); // latch
    // a second rail of cuts over the back counter
    const back = hangingCuts(); back.position.set(side * 1.5, 0.4, zb + 1.0); ig.add(back);
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('butcher', build);
