// =============================================================================
// workshop.ts — the generic LIGHT-INDUSTRIAL archetype: a long shed with a
// raised CLERESTORY ROOF MONITOR riding the ridge, a slatted ROLLER DOOR with
// its drum, a high strip-window band, and a pallet stack by the apron. Steel
// grey accent. Silhouette read at 60m: the monitor "hat" on the long shed.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, h01, inscribe, plankStack, prism, rectXY, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(15, ctx.w - 6), hw = W / 2;
  const D = Math.min(12, ctx.d - 5), zf = D / 2, zb = -D / 2;
  const H = 3.6;
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;         // roller-door side
  const rx = side * (hw - 3.0);                          // roller door centre
  const px2 = -side * (hw - 1.5);                        // person door centre

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- front wall: piers + head band + high strip windows ---------------------
  const wz = zf - 0.09;
  const RHW = 1.9;                                       // roller half-width
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, px2 - 0.55], [px2 + 0.55, rx - RHW], [rx + RHW, hw]]
    : [[-hw, rx - RHW], [rx + RHW, px2 - 0.55], [px2 + 0.55, hw]];
  for (const [x0, x1] of spans) {
    if (x1 - x0 > 0.04) g.add(kit.boxAt(x1 - x0, 2.85, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  }
  g.add(kit.boxAt(W, H - 2.85, 0.18, 0, 2.85, wz, { edge: 'ink' }));
  const strip: number[] = rectXY(-hw + 0.5, hw - 0.5, 2.2, 2.8, zf + 0.02);     // strip windows
  for (let mx = -hw + 1.4; mx < hw - 0.5; mx += 0.9) strip.push(mx, 2.2, zf + 0.02, mx, 2.8, zf + 0.02);
  g.add(kit.line(strip, 'faint'));

  // --- the ROLLER DOOR: rolled HALF-OPEN (slats above, clear opening below) ---
  const slats: number[] = [];
  for (let sy = 1.5; sy <= 2.75; sy += 0.25) slats.push(rx - RHW + 0.08, sy, zf - 0.1, rx + RHW - 0.08, sy, zf - 0.1);
  g.add(kit.line(slats, 'soft'));
  g.add(kit.boxAt(RHW * 2 - 0.16, 1.35, 0.05, rx, 1.5, zf - 0.12, { edge: 'soft' })); // the lowered curtain
  g.add(kit.boxAt(0.16, 2.85, 0.22, rx - RHW, 0, zf - 0.05, { edge: 'ink' }));  // guide rails
  g.add(kit.boxAt(0.16, 2.85, 0.22, rx + RHW, 0, zf - 0.05, { edge: 'ink' }));
  g.add(kit.boxAt(RHW * 2 + 0.3, 0.55, 0.5, rx, 2.85, zf - 0.24, { edge: 'ink' })); // roller drum housing
  g.add(tintLine([rx - RHW + 0.08, 1.44, zf - 0.08, rx + RHW - 0.08, 1.44, zf - 0.08], TONE.amber)); // bottom bar
  g.add(kit.boxAt(RHW * 2 + 0.6, 0.06, 2.0, rx, 0.005, zf + 1.0, { edge: 'faint' })); // apron slab

  // --- person door + small sign ----------------------------------------------
  g.add(kit.boxAt(0.12, 2.15, 0.2, px2 - 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.12, 2.15, 0.2, px2 + 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.12, 0.14, 0.2, px2, 2.15, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.92, 2.1, 0.08, px2, 0, zf - 0.14, { edge: 'ink' }));
  g.add(kit.knob(0.07, px2 + 0.32, 1.05, zf - 0.08, { edge: 'soft' }));
  g.add(kit.boxAt(4.6, 0.55, 0.1, rx - side * 0.4, 3.0, zf + 0.03, { edge: 'ink' })); // sign board
  g.add(inscribe('WORKSHOP', rx - side * 0.4, 3.12, zf + 0.1, 0.4, 0.32, 0.14, { tone: 'soft' }));
  g.add(tintLine([rx - side * 0.4 - 2.1, 2.96, zf + 0.09, rx - side * 0.4 + 2.1, 2.96, zf + 0.09], TONE.steel));

  // --- shallow gable + the CLERESTORY MONITOR ---------------------------------
  const roof = prism([[-(zf + 0.35), 0], [zf + 0.35, 0], [0, 0.85]], W + 0.6, { edge: 'ink' });
  roof.rotation.y = Math.PI / 2;
  roof.position.y = H;
  g.add(roof);
  const MW = W * 0.52, MD = D * 0.36, MH = 1.05;
  g.add(kit.boxAt(MW, MH, MD, 0, H + 0.75, 0, { edge: 'ink' }));               // monitor body
  const mroof = prism([[-(MD / 2 + 0.25), 0], [MD / 2 + 0.25, 0], [0, 0.4]], MW + 0.5, { edge: 'ink' });
  mroof.rotation.y = Math.PI / 2;
  mroof.position.y = H + 0.75 + MH;
  g.add(mroof);
  const mg: number[] = [];                                                      // monitor glazing (front + back)
  for (const mz of [MD / 2 + 0.011, -MD / 2 - 0.011]) {
    mg.push(-MW / 2 + 0.2, H + 0.95, mz, MW / 2 - 0.2, H + 0.95, mz,
      -MW / 2 + 0.2, H + 1.6, mz, MW / 2 - 0.2, H + 1.6, mz);
    for (let mx = -MW / 2 + 0.8; mx < MW / 2 - 0.2; mx += 0.75) mg.push(mx, H + 0.95, mz, mx, H + 1.6, mz);
  }
  g.add(kit.line(mg, 'faint'));
  g.add(kit.cylAt(0.14, 1.3, 5, -side * (hw - 2.0), H + 0.6, zb + 1.6, { edge: 'soft' })); // flue stack
  g.add(kit.knob(0.2, -side * (hw - 2.0), H + 1.95, zb + 1.6, { edge: 'soft', fill: false }));

  // --- pallet stack on the apron ----------------------------------------------
  const pal = kit.group();
  for (let i = 0; i < 3; i++) {
    pal.add(kit.boxAt(1.15, 0.13, 0.95, 0, i * 0.15, 0, { edge: 'soft' }));
    pal.add(kit.line([-0.45, i * 0.15 + 0.14, -0.45, -0.45, i * 0.15 + 0.14, 0.45,
      0.45, i * 0.15 + 0.14, -0.45, 0.45, i * 0.15 + 0.14, 0.45], 'faint'));
  }
  const lean = kit.boxAt(1.15, 0.13, 0.95, 0.35, 0.5, -0.35, { edge: 'soft', fill: false });
  lean.rotation.z = 0.5;
  pal.add(lean);
  pal.position.set(rx + side * 2.9, 0, zf + 1.3);
  pal.rotation.y = h01(ctx.seed, 2) * 0.6 - 0.3;
  g.add(pal);

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // roof trusses under the monitor (faint zig-zag webs)
    const tr: number[] = [];
    for (const tz of [-D / 4, 0, D / 4]) {
      tr.push(-hw + 0.3, H - 0.35, tz, hw - 0.3, H - 0.35, tz);
      for (let k = 0; k < 6; k++) {
        const xa = -hw + 0.3 + (k / 6) * (W - 0.6), xb = -hw + 0.3 + ((k + 1) / 6) * (W - 0.6);
        tr.push(xa, H - 0.35, tz, (xa + xb) / 2, H - 0.02, tz, (xa + xb) / 2, H - 0.02, tz, xb, H - 0.35, tz);
      }
    }
    ig.add(k2.line(tr, 'faint'));
    // long workbench down one flank + a pillar drill + grinder
    k2.add(ig, k2.boxAt(0.9, 0.85, D - 3.5, -side * (hw - 1.0), 0, -0.4, { edge: 'ink' }));
    ig.add(k2.slab(1.0, D - 3.4, -side * (hw - 1.0), 0.9, -0.4, { edge: 'soft' }));
    const drX = -side * (hw - 1.1);
    k2.add(ig, k2.boxAt(0.5, 0.12, 0.5, drX, 0.9, -2.6, { edge: 'ink' }));       // drill base
    ig.add(k2.cylAt(0.07, 1.1, 5, drX, 1.0, -2.6, { edge: 'ink' }));             // column
    k2.add(ig, k2.boxAt(0.45, 0.3, 0.6, drX, 1.85, -2.55, { edge: 'ink' }));     // head
    ig.add(k2.line([drX + 0.2, 1.7, -2.4, drX + 0.34, 1.55, -2.35], 'soft'));    // handle
    // central assembly table with a machine part + oil drums
    k2.add(ig, k2.boxAt(2.4, 0.8, 1.4, side * 0.8, 0, -0.6, { edge: 'ink' }));
    ig.add(tintLine(rectXY(side * 0.8 - 1.0, side * 0.8 + 1.0, 0.82, 0.86, -0.6 + 0.71), TONE.steel));
    k2.add(ig, k2.boxAt(0.6, 0.5, 0.5, side * 0.6, 0.8, -0.7, { edge: 'soft' }));
    for (const [ox, oz] of [[side * (hw - 1.2), zb + 1.0], [side * (hw - 2.0), zb + 0.8]] as const) {
      k2.add(ig, k2.cylAt(0.3, 0.9, 6, ox, 0, oz, { edge: 'ink' }));
      ig.add(tintLine([ox - 0.3, 0.55, oz + 0.31, ox + 0.3, 0.55, oz + 0.31], TONE.amber));
    }
    // stores: pallet + plank stack inside the roller door
    const stores = plankStack();
    stores.position.set(rx, 0, zf - 2.2);
    stores.rotation.y = 0.25;
    ig.add(stores);
    // tool wall ticks
    const tools: number[] = [];
    for (let i = 0; i < 10; i++) {
      const tx = -hw + 1.6 + i * 0.5;
      if (tx > hw - 1.5) break;
      tools.push(tx, 1.9, zb + 0.22, tx, 1.9 - (0.22 + (i % 4) * 0.09), zb + 0.22);
    }
    ig.add(k2.line(tools, 'faint'));
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('workshop', build);
