// =============================================================================
// tailor.ts — the TAILOR archetype: a narrow, elegant two-storey facade with a
// tall canted BAY display window (mannequin on show inside), a hanging scissors
// blade-sign over the door, a dentilled cornice and a deep indigo accent.
// Silhouette read at 60m: the tall thin house between imagined neighbours,
// bay bump + blade sign.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, arcXY, clothBolts, h01, inscribe, rectXY, tintBox, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(8, ctx.w - 10), hw = W / 2;        // deliberately NARROW
  const D = Math.min(11, ctx.d - 6), zf = D / 2, zb = -D / 2;
  const F1 = 3.3;                                       // first-floor head height
  const H = 6.5;                                        // wall top
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;         // bay side (door on the other)
  const bx = side * (hw - 2.0);                         // bay centre
  const dx = -side * (hw - 1.1);                        // door centre

  // --- floor plate + solid back/side walls (full two-storey height) ----------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- ground-floor front: piers around the bay opening + the door -----------
  const wz = zf - 0.09;
  const BAYW = 2.6;                                     // bay opening width
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, dx - 0.55], [dx + 0.55, bx - BAYW / 2], [bx + BAYW / 2, hw]]
    : [[-hw, bx - BAYW / 2], [bx + BAYW / 2, dx - 0.55], [dx + 0.55, hw]];
  for (const [x0, x1] of spans) {
    if (x1 - x0 > 0.04) g.add(kit.boxAt(x1 - x0, 2.55, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  }
  g.add(kit.boxAt(W, F1 - 2.55, 0.18, 0, 2.55, wz, { edge: 'ink' }));  // ground-floor head band

  // --- the tall canted BAY window (edge-glazed so the mannequin shows) --------
  const BP = 0.75;                                       // bay projection
  const sill = 0.45, head = 2.55;
  const p0: [number, number] = [bx - BAYW / 2, zf];      // wall plane corners  (x, z)
  const p1: [number, number] = [bx - BAYW / 2 + 0.55, zf + BP];
  const p2: [number, number] = [bx + BAYW / 2 - 0.55, zf + BP];
  const p3: [number, number] = [bx + BAYW / 2, zf];
  const ring = [p0, p1, p2, p3];
  // floor + roof caps of the bay (thin plates following the plan)
  for (const [py, ph] of [[0, sill], [head, 0.28]] as const) {
    for (let i = 0; i < 3; i++) {                        // stall riser / cap panels
      const [xa, za] = ring[i], [xb, zb2] = ring[i + 1];
      const len = Math.hypot(xb - xa, zb2 - za);
      const panel = kit.box(len, ph, 0.1, { edge: 'ink' });
      panel.position.set((xa + xb) / 2, py, (za + zb2) / 2);
      panel.rotation.y = -Math.atan2(zb2 - za, xb - xa);
      g.add(panel);
    }
  }
  const bayGlass: number[] = [];                          // glazing edges + mullions
  for (let i = 0; i < 4; i++) {
    const [px, pz] = ring[i];
    bayGlass.push(px, sill, pz, px, head, pz);
  }
  for (let i = 0; i < 3; i++) {
    const [xa, za] = ring[i], [xb, zb2] = ring[i + 1];
    for (const t of [0, 0.5, 1]) {
      const mx = xa + (xb - xa) * t, mz2 = za + (zb2 - za) * t;
      bayGlass.push(mx, sill, mz2, mx, head, mz2);
    }
    bayGlass.push(xa, 1.6, za, xb, 1.6, zb2);            // transom
    bayGlass.push(xa, sill, za, xb, sill, zb2, xa, head, za, xb, head, zb2);
  }
  g.add(kit.line(bayGlass, 'faint'));

  // --- door with steps, transom fanlight + the SCISSORS blade sign ------------
  g.add(kit.boxAt(0.12, 2.4, 0.2, dx - 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.12, 2.4, 0.2, dx + 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.12, 0.15, 0.2, dx, 2.4, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.92, 2.1, 0.08, dx, 0.12, zf - 0.14, { edge: 'ink' }));
  g.add(tintLine(rectXY(dx - 0.34, dx + 0.34, 0.4, 1.9, zf - 0.09), TONE.indigo)); // indigo panel
  g.add(kit.knob(0.07, dx + 0.32, 1.15, zf - 0.08, { edge: 'soft' }));
  g.add(kit.line(arcXY(dx, 2.12, 0.44, 0.35, Math.PI - 0.35, 6, zf - 0.1), 'faint')); // fanlight
  g.add(kit.boxAt(1.3, 0.12, 0.5, dx, 0, zf + 0.25, { edge: 'soft' }));
  g.add(kit.boxAt(1.2, 0.06, 0.35, dx, 0.12, zf - 0.06, { edge: 'faint' }));
  // blade sign: wrought bracket + hanging indigo board + scissors glyph
  const sy = 3.1;
  g.add(kit.line([dx, sy + 0.55, zf + 0.02, dx, sy + 0.55, zf + 0.85,
    dx, sy + 0.55, zf + 0.55, dx, sy + 0.35, zf + 0.3], 'ink'));                 // bracket + brace
  g.add(tintBox(0.09, 0.78, 0.6, dx, sy - 0.35, zf + 0.55, TONE.indigo));        // the blade board
  const sc: number[] = [];                                                        // scissors, on both faces
  for (const fx of [dx - 0.06, dx + 0.06]) {                                      // crossed blades
    sc.push(fx, sy + 0.3, zf + 0.4, fx, sy - 0.1, zf + 0.7);
    sc.push(fx, sy + 0.3, zf + 0.7, fx, sy - 0.1, zf + 0.4);
    for (const hz of [0.42, 0.68]) {                                              // finger rings
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI * 2, a1 = ((i + 1) / 6) * Math.PI * 2;
        sc.push(fx, sy - 0.14 + Math.sin(a0) * 0.055, zf + hz + Math.cos(a0) * 0.055,
          fx, sy - 0.14 + Math.sin(a1) * 0.055, zf + hz + Math.cos(a1) * 0.055);
      }
    }
  }
  g.add(kit.line(sc, 'ink'));

  // --- fascia between floors + upper-storey windows + cornice/parapet ---------
  g.add(tintBox(W - 1.0, 0.56, 0.12, 0, 3.0, zf + 0.02, TONE.indigo));
  g.add(inscribe('TAILOR', 0, 3.12, zf + 0.1, 0.4, 0.34, 0.18, { tone: 'soft' }));
  const up: number[] = [];
  for (const ux of [-side * (hw - 1.6), side * (hw - 1.6)]) {
    up.push(...rectXY(ux - 0.65, ux + 0.65, 4.0, 5.9, zf + 0.02));
    up.push(ux, 4.0, zf + 0.02, ux, 5.9, zf + 0.02, ux - 0.65, 4.95, zf + 0.02, ux + 0.65, 4.95, zf + 0.02);
  }
  g.add(kit.line(up, 'faint'));
  for (const ux of [-side * (hw - 1.6), side * (hw - 1.6)])
    g.add(kit.boxAt(1.5, 0.12, 0.26, ux, 3.88, zf - 0.02, { edge: 'soft' }));   // window sills
  g.add(kit.boxAt(W + 0.5, 0.3, 0.4, 0, H, zf - 0.12, { edge: 'ink' }));        // cornice shelf
  const dent: number[] = [];
  for (let dxx = -hw + 0.3; dxx <= hw - 0.3; dxx += 0.34) dent.push(dxx, H - 0.14, zf + 0.1, dxx, H, zf + 0.1);
  g.add(kit.line(dent, 'faint'));                                                // dentils
  g.add(kit.boxAt(W, 0.55, 0.18, 0, H + 0.3, zf - 0.09, { edge: 'ink' }));      // parapet
  g.add(kit.boxAt(W, 0.22, D, 0, H, 0, { edge: 'soft' }));                       // roof slab
  g.add(kit.boxAt(W, 0.4, 0.2, 0, H + 0.2, zb + 0.1, { edge: 'soft' }));         // rear parapet

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // the MANNEQUIN in the bay window — the signature read
    const mx = bx, mz = zf - 0.35;
    k2.add(ig, k2.cylAt(0.26, 0.05, 6, mx, 0.45, mz, { edge: 'ink' }));          // base
    ig.add(k2.line([mx, 0.5, mz, mx, 1.15, mz], 'ink'));                          // stand pole
    k2.add(ig, k2.boxAt(0.4, 0.62, 0.24, mx, 1.15, mz, { edge: 'ink' }));         // torso
    k2.add(ig, k2.slab(0.42, 0.26, mx, 1.77, mz, { edge: 'soft' }));              // shoulders
    ig.add(k2.knob(0.09, mx, 1.87, mz, { edge: 'soft', fill: false }));           // neck cap
    ig.add(tintLine([mx - 0.2, 1.72, mz + 0.13, mx - 0.06, 1.3, mz + 0.13,        // draped sash
      mx - 0.06, 1.3, mz + 0.13, mx - 0.14, 0.9, mz + 0.13], TONE.indigo));
    // cloth-bolt shelving on the back wall (two tiers)
    for (const [sy, oz] of [[0.55, 0], [1.35, 0.06]] as const) {
      const bolts = clothBolts();
      bolts.position.set(-side * 0.6 + oz, sy, zb + 0.45);
      ig.add(bolts);
      const bolts2 = clothBolts();
      bolts2.position.set(side * 1.6 + oz, sy, zb + 0.45);
      bolts2.rotation.y = 0.05;
      ig.add(bolts2);
    }
    k2.add(ig, k2.boxAt(3.6, 0.5, 0.5, side * 0.5, 0, zb + 0.45, { edge: 'soft' })); // shelf base
    // cutting table with a bolt unrolled across it + shears
    k2.add(ig, k2.boxAt(2.0, 0.9, 1.0, -side * 0.8, 0, -0.4, { edge: 'ink' }));
    ig.add(tintBox(1.7, 0.06, 0.6, -side * 0.8, 0.9, -0.4, TONE.indigo));
    ig.add(k2.line([-side * 0.8 - 0.5, 0.98, -0.25, -side * 0.8 - 0.2, 0.98, -0.1], 'soft'));
    // full-length mirror + a change screen
    const mirX = side * (hw - 0.5);
    const mir = k2.boxAt(0.8, 1.9, 0.06, mirX, 0.15, -2.2, { edge: 'soft', fill: false });
    mir.rotation.y = -side * 0.5;
    ig.add(mir);
    const scr = k2.group();
    for (let i = 0; i < 3; i++) {
      const pan = k2.boxAt(0.55, 1.75, 0.04, 0, 0, 0, { edge: 'ink' });
      pan.position.set((i - 1) * 0.52, 0.05, (i % 2) * 0.18);
      pan.rotation.y = (i - 1) * 0.45;
      scr.add(pan);
    }
    scr.position.set(-side * (hw - 1.1), 0, -2.6);
    ig.add(scr);
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('tailor', build);
