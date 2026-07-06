// =============================================================================
// bakery.ts — the BAKERY archetype: a side-gabled shop with a big tapered
// masonry oven chimney breaking the ridge, an arched shopfront display window
// under a striped awning, and a warm sand/amber accent. Silhouette read at 60m:
// gable + fat chimney. Window goods (loaf/baguette displays) live in the
// interior pass; the exterior stays complete on its own.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, arcXY, breadLoaves, h01, inscribe, prism, rectXY, tintBox, tintLine, TONE,
} from './goodsassets';

/** a faint horizontal band loop around a box footprint w×w at height y. */
function bandLoop(x: number, z: number, w: number, y: number): number[] {
  const h = w / 2;
  return [
    x - h, y, z - h, x + h, y, z - h, x + h, y, z - h, x + h, y, z + h,
    x + h, y, z + h, x - h, y, z + h, x - h, y, z + h, x - h, y, z - h,
  ];
}

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(14, ctx.w - 6), hw = W / 2;
  const D = Math.min(12, ctx.d - 5), zf = D / 2, zb = -D / 2;
  const H = 3.3;                                     // eave height
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;      // chimney side
  const wx = -1.8 * side;                            // arched window centre
  const dx = 2.6 * side;                             // door centre

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- front facade: piers + lintel band, window + door openings ------------
  const wHalf = 1.7;                                  // window half-width
  const wz = zf - 0.09;
  const pier = (x0: number, x1: number): void => {
    g.add(kit.boxAt(x1 - x0, 2.2, 0.18, (x0 + x1) / 2, 0, wz, { edge: 'ink' }));
  };
  const spans: Array<[number, number]> = side > 0
    ? [[-hw, wx - wHalf], [wx + wHalf, dx - 0.55], [dx + 0.55, hw]]
    : [[-hw, dx - 0.55], [dx + 0.55, wx - wHalf], [wx + wHalf, hw]];
  for (const [x0, x1] of spans) pier(x0, x1);
  g.add(kit.boxAt(W, H - 2.2, 0.18, 0, 2.2, wz, { edge: 'ink' }));  // band above openings

  // --- the ARCHED window: sill plinth, mullions, incised arch fanlight -------
  g.add(kit.boxAt(wHalf * 2 + 0.3, 0.55, 0.3, wx, 0, zf - 0.18, { edge: 'ink' })); // display plinth
  const win: number[] = rectXY(wx - wHalf, wx + wHalf, 0.55, 2.2, zf + 0.02);
  for (const mx of [wx - wHalf / 2, wx, wx + wHalf / 2]) win.push(mx, 0.55, zf + 0.02, mx, 2.2, zf + 0.02);
  g.add(kit.line(win, 'faint'));
  // arch incised on the band above (radius picked so the spring points meet the corners)
  const r = 2.2, cy = 2.2 - Math.sqrt(r * r - wHalf * wHalf);
  const a = Math.atan2(2.2 - cy, wHalf);
  g.add(kit.line(arcXY(wx, cy, r, a, Math.PI - a, 10, zf + 0.03), 'soft'));
  g.add(kit.line(arcXY(wx, cy, r - 0.18, a, Math.PI - a, 10, zf + 0.03), 'faint'));
  const fan: number[] = [];                                                   // fan mullions
  for (const fa of [Math.PI * 0.3, Math.PI * 0.5, Math.PI * 0.7])
    fan.push(wx, 2.2, zf + 0.03, wx + Math.cos(fa) * (r - 0.18), cy + Math.sin(fa) * (r - 0.18), zf + 0.03);
  g.add(kit.line(fan, 'faint'));

  // --- door (jambs + recessed leaf + knob + step) ----------------------------
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx - 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.12, 2.15, 0.2, dx + 0.5, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(1.12, 0.14, 0.2, dx, 2.15, zf, { edge: 'soft' }));
  g.add(kit.boxAt(0.92, 2.1, 0.08, dx, 0, zf - 0.14, { edge: 'ink' }));
  g.add(kit.knob(0.07, dx + 0.32, 1.05, zf - 0.08, { edge: 'soft' }));
  g.add(kit.boxAt(1.4, 0.09, 0.5, dx, 0, zf + 0.25, { edge: 'soft' }));

  // --- gabled roof (ridge along x) -------------------------------------------
  const roof = prism([[-(zf + 0.45), 0], [zf + 0.45, 0], [0, 1.7]], W + 0.7, { edge: 'ink' });
  roof.rotation.y = Math.PI / 2;
  roof.position.y = H;
  g.add(roof);

  // --- the masonry OVEN CHIMNEY: tapered stack + ink band courses ------------
  const cx = side * (hw - 1.2), cz = -1.0;
  g.add(kit.boxAt(1.5, H + 0.9, 1.5, cx, 0, cz, { edge: 'ink' }));   // oven mass, ground → past eave
  g.add(kit.boxAt(1.2, 1.1, 1.2, cx, H + 0.9, cz, { edge: 'ink' })); // taper 1
  g.add(kit.boxAt(0.9, 1.0, 0.9, cx, H + 2.0, cz, { edge: 'ink' })); // taper 2
  g.add(kit.boxAt(1.14, 0.14, 1.14, cx, H + 3.0, cz, { edge: 'soft' })); // cap
  const bands: number[] = [];
  for (const by of [1.1, 2.2, 3.3]) bands.push(...bandLoop(cx, cz, 1.5, by));
  bands.push(...bandLoop(cx, cz, 1.2, H + 1.55));
  g.add(kit.line(bands, 'soft'));

  // --- fascia sign over the DOOR (leaves the arch fully visible) -------------
  g.add(kit.boxAt(3.3, 0.6, 0.12, dx, 2.58, zf + 0.07, { edge: 'ink' }));
  g.add(inscribe('BAKERY', dx, 2.7, zf + 0.14, 0.4, 0.36, 0.14, { tone: 'soft' }));
  g.add(tintLine([dx - 1.5, 2.52, zf + 0.14, dx + 1.5, 2.52, zf + 0.14], TONE.bread));
  // --- striped awning tucked under the arch spring (warm amber) --------------
  const awn = kit.group();
  awn.add(kit.boxAt(wHalf * 2 + 0.5, 0.05, 1.15, 0, -0.03, 0.575, { edge: 'ink' }));
  const stripes: number[] = [];
  const nS = 6 + Math.floor(h01(ctx.seed, 2) * 3);
  for (let i = 0; i <= nS; i++) {
    const sx2 = -wHalf - 0.25 + (wHalf * 2 + 0.5) * (i / nS);
    stripes.push(sx2, 0.04, 0.05, sx2, 0.04, 1.1);
  }
  for (let i = 0; i < nS; i += 2) {                              // scallop drops on alternate bays
    const x0 = -wHalf - 0.25 + (wHalf * 2 + 0.5) * (i / nS);
    const x1 = -wHalf - 0.25 + (wHalf * 2 + 0.5) * ((i + 1) / nS);
    stripes.push(x0, 0.02, 1.15, (x0 + x1) / 2, -0.16, 1.15, (x0 + x1) / 2, -0.16, 1.15, x1, 0.02, 1.15);
  }
  awn.add(tintLine(stripes, TONE.bread));
  awn.position.set(wx, 2.26, zf);
  awn.rotation.x = 0.34;
  g.add(awn);

  // --- side-wall detail: two faint windows + eave shadow line ---------------
  for (const sx of [-1, 1]) {
    const sw: number[] = [];
    for (const szz of [-2.2, 1.6]) {
      sw.push(
        sx * hw + sx * 0.02, 1.0, szz - 0.7, sx * hw + sx * 0.02, 2.3, szz - 0.7,
        sx * hw + sx * 0.02, 1.0, szz + 0.7, sx * hw + sx * 0.02, 2.3, szz + 0.7,
        sx * hw + sx * 0.02, 1.0, szz - 0.7, sx * hw + sx * 0.02, 1.0, szz + 0.7,
        sx * hw + sx * 0.02, 2.3, szz - 0.7, sx * hw + sx * 0.02, 2.3, szz + 0.7,
        sx * hw + sx * 0.02, 1.65, szz - 0.7, sx * hw + sx * 0.02, 1.65, szz + 0.7,
      );
    }
    g.add(kit.line(sw, 'faint'));
  }

  // ================= interior / window goods (fresh each call) ===============
  const buildInterior = (): THREE.Group => {
    const ig = archKit().group();
    const k2 = archKit();
    // window display: table behind the plinth stacked with bread
    k2.add(ig, k2.boxAt(3.0, 0.78, 0.9, wx, 0, zf - 0.85, { edge: 'soft' }));
    for (const [lx, lz, ry] of [[wx - 0.8, zf - 0.75, 0.2], [wx + 0.7, zf - 0.95, -0.35]] as const) {
      const bl = breadLoaves(); bl.position.set(lx, 0.78, lz); bl.rotation.y = ry; ig.add(bl);
    }
    // service counter with a register + a basket
    k2.add(ig, k2.boxAt(3.4, 0.95, 0.8, dx - side * 0.4, 0, zf - 3.4, { edge: 'ink' }));
    k2.add(ig, k2.boxAt(0.3, 0.3, 0.3, dx + side * 0.6, 0.95, zf - 3.4, { edge: 'soft' }));
    const bk = breadLoaves(); bk.position.set(dx - side * 1.2, 0.95, zf - 3.4); bk.rotation.y = 0.5; ig.add(bk);
    // the masonry OVEN under the chimney: mass + arched mouth + amber glow arc
    const ox = side * (hw - 1.2);
    k2.add(ig, k2.boxAt(2.8, 2.3, 1.2, ox, 0, zb + 0.85, { edge: 'ink' }));
    const mz = zb + 1.46;
    ig.add(k2.line(arcXY(ox, 1.0, 0.62, 0, Math.PI, 8, mz), 'ink'));
    ig.add(k2.line([ox - 0.62, 0.45, mz, ox - 0.62, 1.0, mz, ox + 0.62, 0.45, mz, ox + 0.62, 1.0, mz,
      ox - 0.62, 0.45, mz, ox + 0.62, 0.45, mz], 'ink'));
    ig.add(tintLine(arcXY(ox, 0.85, 0.4, 0.3, Math.PI - 0.3, 6, mz + 0.01), TONE.bread));
    k2.add(ig, k2.slab(1.4, 0.5, ox, 0.45, mz + 0.3, { edge: 'soft' }));      // hearth ledge
    ig.add(k2.line([ox + 0.9, 0, mz + 0.2, ox + 1.5, 1.7, mz - 0.2], 'soft')); // the peel, leaning
    // bread rack on the far side wall
    const rx = -side * (hw - 0.65);
    k2.add(ig, k2.boxAt(0.9, 2.0, 2.6, rx, 0, -1.0, { edge: 'soft', fill: false }));
    for (const sy of [0.6, 1.15, 1.7]) k2.add(ig, k2.slab(0.9, 2.6, rx, sy, -1.0, { edge: 'soft' }));
    for (const [sy, rz] of [[0.6, -1.7], [1.15, -0.4], [1.7, -1.2]] as const) {
      const bl = breadLoaves(); bl.position.set(rx, sy, rz); bl.rotation.y = Math.PI / 2; ig.add(bl);
    }
    // flour sacks by the oven
    for (const [fx, fz] of [[ox - 1.9, zb + 0.8], [ox - 2.5, zb + 1.1]] as const) {
      k2.add(ig, k2.boxAt(0.55, 0.7, 0.5, fx, 0, fz, { edge: 'soft' }));
      ig.add(k2.line([fx - 0.14, 0.7, fz, fx + 0.14, 0.7, fz], 'faint'));      // tied neck
    }
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('bakery', build);
