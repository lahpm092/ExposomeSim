// =============================================================================
// dairy.ts — the DAIRY CO-OP archetype: a gambrel-roofed barn facing the street
// gable-on, with a round SILO (domed cap, banded) standing at one side, a
// loading stoop with a huddle of milk cans by the door, and a pale cream
// accent. Silhouette read at 60m: the gambrel hat + the silo drum.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, archMats, h01, inscribe, milkCans, prism, rectXY, tintBox, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(11, ctx.w - 9), hw = W / 2;       // barn body (leave room for the silo)
  const D = Math.min(12, ctx.d - 5), zf = D / 2, zb = -D / 2;
  const H = 2.7;                                        // eave height
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;         // silo side
  const dx = -side * 1.2;                               // door centre (away from silo)

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- front gable wall: piers + the gable-triangle infill -------------------
  const wz = zf - 0.09;
  const wx = side * 1.6;                                // shop window centre
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, dx - 0.55], [dx + 0.55, wx - 1.05], [wx + 1.05, hw]]
    : [[-hw, wx - 1.05], [wx + 1.05, dx - 0.55], [dx + 0.55, hw]];
  for (const [x0, x1] of spans) g.add(kit.boxAt(x1 - x0, 2.25, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  g.add(kit.boxAt(W, H - 2.25, 0.18, 0, 2.25, wz, { edge: 'ink' }));
  // the GAMBREL cross-section, extruded the barn's length (ridge along z)
  const RB = 1.9, RT = 2.9;                             // break / ridge rise over the eave
  const gam: Array<[number, number]> = [
    [-(hw + 0.35), 0], [-(hw + 0.35) * 0.52, RB], [0, RT], [(hw + 0.35) * 0.52, RB], [hw + 0.35, 0],
  ];
  const roof = prism(gam, D + 0.7, { edge: 'ink' });
  roof.position.y = H;
  g.add(roof);
  // gable-end infill wall under the roof (front + back), with a hayloft door
  const gfront = prism(gam.map(([x, y]) => [x * 0.94, y * 0.96] as [number, number]), 0.16, { edge: 'soft' });
  gfront.position.set(0, H, zf - 0.1);
  g.add(gfront);
  const gback = gfront.clone();
  gback.position.set(0, H, zb + 0.1);
  g.add(gback);
  // hayloft door + hoist beam at the ridge apex (proud of the roof's end cap)
  const gz = zf + 0.37;
  g.add(kit.line(rectXY(-0.55, 0.55, H + 0.35, H + 1.55, gz), 'soft'));
  g.add(kit.line([0, H + 0.35, gz, 0, H + 1.55, gz], 'faint'));                  // leaf split
  g.add(kit.boxAt(0.14, 0.14, 1.0, 0, H + RT - 0.55, zf + 0.7, { edge: 'ink' })); // hoist beam
  g.add(kit.line([0, H + RT - 0.5, zf + 1.12, 0, H + 1.85, zf + 1.12], 'soft'));  // hoist rope
  g.add(kit.knob(0.09, 0, H + 1.8, zf + 1.12, { edge: 'soft' }));                 // pulley block

  // --- shop window + door + stoop with MILK CANS ------------------------------
  const win: number[] = rectXY(wx - 1.05, wx + 1.05, 0.7, 2.25, zf + 0.02);
  win.push(wx, 0.7, zf + 0.02, wx, 2.25, zf + 0.02, wx - 1.05, 1.5, zf + 0.02, wx + 1.05, 1.5, zf + 0.02);
  g.add(kit.line(win, 'faint'));
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx - 0.55, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx + 0.55, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.22, 0.14, 0.2, dx, 2.15, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.0, 2.1, 0.08, dx, 0, zf - 0.14, { edge: 'ink' }));
  g.add(tintLine(rectXY(dx - 0.38, dx + 0.38, 0.25, 1.85, zf - 0.09), TONE.cream)); // cream door panel
  g.add(kit.knob(0.07, dx + 0.34, 1.05, zf - 0.08, { edge: 'soft' }));
  g.add(kit.boxAt(2.6, 0.32, 1.3, dx, 0, zf + 0.75, { edge: 'ink' }));          // loading stoop
  const cans = milkCans();
  cans.position.set(dx + side * 0.7, 0.32, zf + 0.75);
  g.add(cans);
  const cans2 = milkCans();
  cans2.position.set(dx - side * 1.1, 0, zf + 1.6);
  cans2.rotation.y = 1.1;
  g.add(cans2);

  // --- the SILO: banded drum + domed cap + chute back to the barn -------------
  const sx = side * (hw + 1.75), sz = -1.2;
  const SR = 1.55, SH = 6.0;
  g.add(kit.cylAt(SR, SH, 8, sx, 0, sz, { edge: 'ink' }));
  const capGeo = new THREE.CylinderGeometry(0.34, SR * 0.99, 1.35, 8);          // conical cap
  capGeo.translate(sx, SH + 0.675, sz);
  const cap = new THREE.Group();
  cap.add(new THREE.Mesh(capGeo, archMats().fill));
  cap.add(new THREE.LineSegments(new THREE.EdgesGeometry(capGeo, 12), archKit().mat('ink')));
  g.add(cap);
  g.add(kit.cylAt(0.12, 0.7, 5, sx, SH + 1.3, sz, { edge: 'soft' }));           // finial vent
  const bands: number[] = [];                            // silo hoops, in the XZ plane
  for (const by of [1.2, 2.4, 3.6, 4.8]) {
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
      bands.push(sx + Math.cos(a0) * (SR + 0.01), by, sz + Math.sin(a0) * (SR + 0.01),
        sx + Math.cos(a1) * (SR + 0.01), by, sz + Math.sin(a1) * (SR + 0.01));
    }
  }
  g.add(kit.line(bands, 'faint'));
  const chute = kit.boxAt(1.4, 0.18, 0.5, side * (hw + 0.55), 0, sz, { edge: 'soft' });
  chute.rotation.z = side * 0.5;
  chute.position.y = H + 0.4;
  g.add(chute);
  g.add(kit.boxAt(0.9, 0.5, 0.9, sx - side * 0.2, 0, sz + SR + 0.3, { edge: 'soft' })); // feed hopper

  // --- fascia sign over the door + window, proud of the eave overhang --------
  g.add(kit.boxAt(4.6, 0.62, 0.14, side * 0.2, 2.24, zf + 0.34, { edge: 'ink' }));
  g.add(inscribe('DAIRY', side * 0.2, 2.38, zf + 0.43, 0.46, 0.38, 0.2, { tone: 'soft' }));
  g.add(tintLine([side * 0.2 - 2.1, 2.32, zf + 0.43, side * 0.2 + 2.1, 2.32, zf + 0.43], TONE.cream));

  // --- vertical plank siding hints (front gable + flanks) ---------------------
  const siding: number[] = [];
  for (let px = -hw + 0.75; px < hw - 0.4; px += 0.75) {
    if (Math.abs(px - dx) < 0.75 || Math.abs(px - wx) < 1.3) continue;
    siding.push(px, 0.15, zf + 0.015, px, 2.1, zf + 0.015);
  }
  for (const sxx of [-1, 1]) for (let pz = zb + 0.9; pz < zf - 0.4; pz += 0.9)
    siding.push(sxx * (hw + 0.015), 0.15, pz, sxx * (hw + 0.015), 2.4, pz);
  g.add(kit.line(siding, 'faint'));

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // cheese counter: wheels stacked on a marble-top counter
    k2.add(ig, k2.boxAt(2.8, 0.92, 0.9, -side * 0.8, 0, zf - 3.0, { edge: 'ink' }));
    k2.add(ig, k2.slab(2.9, 1.0, -side * 0.8, 0.95, zf - 3.0, { edge: 'soft' }));
    let w = 0;
    for (const [cx, cz, r] of [[-1.5, -0.15, 0.3], [-0.7, 0.1, 0.26], [0.1, -0.1, 0.32]] as const) {
      const geo = new THREE.CylinderGeometry(r, r, 0.16 + (w % 2) * 0.04, 6);
      geo.translate(-side * 0.8 + cx + 0.7, 0.95 + 0.08, zf - 3.0 + cz);
      const wheel = new THREE.Group();
      wheel.add(new THREE.Mesh(geo, archMats().fill));
      wheel.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), archKit().mat('soft')));
      ig.add(wheel);
      w++;
    }
    ig.add(tintBox(0.34, 0.2, 0.34, -side * 0.8 + 1.1, 0.95, zf - 3.15, TONE.amber)); // waxed block
    // butter churns: two tall staved drums with crank lines
    for (const [cx, cz] of [[side * (hw - 1.1), -0.8], [side * (hw - 1.9), -1.3]] as const) {
      k2.add(ig, k2.cylAt(0.3, 1.0, 6, cx, 0, cz, { edge: 'ink' }));
      ig.add(k2.line([cx, 1.0, cz, cx, 1.25, cz, cx, 1.25, cz, cx + 0.22, 1.32, cz], 'soft'));
    }
    // cold cabinet along the back wall with cream-tinted bottle rows
    k2.add(ig, k2.boxAt(W - 2.2, 1.9, 0.7, 0, 0, zb + 0.55, { edge: 'ink' }));
    const rows: number[] = [];
    for (const ry of [0.6, 1.1, 1.6]) rows.push(-(W - 2.6) / 2, ry, zb + 0.92, (W - 2.6) / 2, ry, zb + 0.92);
    ig.add(k2.line(rows, 'faint'));
    for (const bx of [-2.4, -1.2, 0, 1.2, 2.4]) {
      if (Math.abs(bx) > hw - 1.6) continue;
      ig.add(tintBox(0.14, 0.34, 0.14, bx, 0.62, zb + 0.75, TONE.cream));
      ig.add(tintBox(0.14, 0.34, 0.14, bx + 0.35, 1.12, zb + 0.75, TONE.cream, false));
    }
    // more cans staged inside + a hand scale on the counter
    const more = milkCans();
    more.position.set(side * 1.6, 0, zf - 1.6);
    ig.add(more);
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('dairy', build);
