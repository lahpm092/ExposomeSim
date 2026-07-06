// =============================================================================
// market2.ts — the RIVAL supermarket. Deliberately the opposite of
// render/supermarket.ts (flat parapet box, one big fascia, centred entrance,
// z-run gondolas): here a SAWTOOTH roofline with clerestory glass, a tall
// vertical SIGN FIN at one corner with stacked lettering, an OFFSET entrance,
// a rhythm of small flat canopies (not one long fascia awning), a cool teal
// accent, and interiors of freestanding x-run shelf modules.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, h01, inscribe, prism, produceCrate, rectXY, shelfModule, tintBox, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(20, ctx.w - 3), hw = W / 2;
  const D = Math.min(14, ctx.d - 4), zf = D / 2, zb = -D / 2;
  const H = 3.8;
  const side = h01(ctx.seed, 1) < 0.5 ? -1 : 1;         // fin corner + door offset side
  const dx = -side * 3.2;                                // entrance centre (OFFSET, not centred)

  // --- floor plate + faint floor grid + solid back/side walls ----------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  const grid: number[] = [];
  for (let x = -hw + 2; x < hw; x += 2) grid.push(x, 0.01, zb + 0.4, x, 0.01, zf - 0.4);
  g.add(kit.line(grid, 'faint'));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- glazed storefront: mullions + kick panels + the offset entrance -------
  const front: number[] = [];
  for (let mx = -hw + 1; mx <= hw - 1; mx += 1.6) {
    if (Math.abs(mx - dx) < 1.6) continue;
    front.push(mx, 0, zf, mx, 2.5, zf);
  }
  for (const hy of [0.5, 2.5]) front.push(-hw, hy, zf, dx - 1.5, hy, zf, dx + 1.5, hy, zf, hw, hy, zf);
  g.add(kit.line(front, 'faint'));
  g.add(kit.boxAt(dx - 1.5 + hw, 0.5, 0.14, (-hw + dx - 1.5) / 2, 0, zf, { edge: 'soft' }));   // kick L
  g.add(kit.boxAt(hw - dx - 1.5, 0.5, 0.14, (dx + 1.5 + hw) / 2, 0, zf, { edge: 'soft' }));    // kick R
  g.add(kit.boxAt(W, H - 2.5, 0.18, 0, 2.5, zf - 0.09, { edge: 'ink' }));                       // head band
  // entrance: jambs + slid-open leaves + a deeper entry canopy
  for (const jx of [dx - 1.5, dx + 1.5]) g.add(kit.boxAt(0.12, 2.3, 0.16, jx, 0, zf, { edge: 'soft' }));
  g.add(kit.boxAt(3.2, 0.15, 0.16, dx, 2.3, zf, { edge: 'soft' }));
  g.add(kit.line([dx - 1.5, 2.3, zf, dx - 0.6, 2.3, zf, dx - 0.6, 2.3, zf, dx - 0.6, 0, zf,
    dx + 1.5, 2.3, zf, dx + 0.6, 2.3, zf, dx + 0.6, 2.3, zf, dx + 0.6, 0, zf], 'faint'));
  g.add(kit.boxAt(3.6, 0.14, 1.5, dx, 2.42, zf + 0.65, { edge: 'ink' }));
  g.add(tintLine([dx - 1.8, 2.42, zf + 1.38, dx + 1.8, 2.42, zf + 1.38], TONE.teal));
  g.add(kit.boxAt(2.9, 0.05, 0.8, dx, 0, zf - 0.4, { edge: 'faint' }));                          // entry mat

  // --- the rhythm of SMALL FLAT CANOPIES over each window bay -----------------
  let bay = 0;
  for (let cxx = -hw + 2.2; cxx <= hw - 1.8; cxx += 2.6) {
    if (Math.abs(cxx - dx) < 2.2) continue;                    // skip the entrance bay
    g.add(kit.boxAt(2.1, 0.08, 0.95, cxx, 2.62, zf + 0.42, { edge: 'ink' }));
    const rods: number[] = [];                                  // tension rods back to the wall
    for (const rx of [cxx - 0.85, cxx + 0.85]) rods.push(rx, 2.7, zf + 0.8, rx, 3.3, zf + 0.02);
    g.add(kit.line(rods, 'soft'));
    if (bay % 2 === 0) g.add(tintLine([cxx - 1.05, 2.6, zf + 0.9, cxx + 1.05, 2.6, zf + 0.9], TONE.teal));
    bay++;
  }

  // --- SAWTOOTH roof: three north-light teeth + clerestory glazing ------------
  const teeth = 3, tw = W / teeth;
  for (let i = 0; i < teeth; i++) {
    const x0 = -hw + i * tw;
    const tooth = prism([[x0, 0], [x0 + tw, 1.6], [x0 + tw, 0]], D - 0.2, { edge: 'ink' });
    tooth.position.y = H;
    g.add(tooth);
    const cg: number[] = [];                                    // clerestory on each vertical face
    const gx = x0 + tw - 0.011;
    cg.push(...[
      gx, H + 0.25, zb + 0.6, gx, H + 1.35, zb + 0.6,
      gx, H + 0.25, zf - 0.6, gx, H + 1.35, zf - 0.6,
      gx, H + 0.25, zb + 0.6, gx, H + 0.25, zf - 0.6,
      gx, H + 1.35, zb + 0.6, gx, H + 1.35, zf - 0.6,
    ]);
    for (let mz = zb + 2.2; mz < zf - 0.7; mz += 1.6) cg.push(gx, H + 0.25, mz, gx, H + 1.35, mz);
    g.add(kit.line(cg, 'faint'));
  }

  // --- the VERTICAL SIGN FIN: a projecting pylon blade at the corner ----------
  const fx = side * (hw - 0.5), fz = zf + 0.55;         // proud of the facade
  g.add(kit.boxAt(1.0, 0.35, 1.9, fx, 0, fz, { edge: 'ink' }));                 // plinth
  g.add(tintBox(0.36, 6.6, 1.45, fx, 0.35, fz, TONE.teal));
  g.add(kit.boxAt(0.52, 0.18, 1.6, fx, 6.95, fz, { edge: 'ink' }));             // cap
  const letters = 'MARKET';
  for (let i = 0; i < letters.length; i++) {
    const ly = 6.3 - i * 0.85;
    for (const face of [-1, 1]) {                       // lettering on BOTH fin faces
      const lg = new THREE.Group();
      lg.add(inscribe(letters[i], 0, 0, 0, 0.52, 0.62, 0, { tone: 'ink' }));
      lg.position.set(fx + face * 0.2, ly, fz);
      lg.rotation.y = face * Math.PI / 2;
      g.add(lg);
    }
  }
  g.add(tintLine([fx - 0.18, 0.45, fz + 0.74, fx + 0.18, 0.45, fz + 0.74], TONE.teal));

  // --- rooftop plant (kept behind the sawtooth) + basket stack by the door ----
  g.add(kit.boxAt(1.8, 0.6, 1.3, -side * 4.5, H + 0.02, zb + 2.2, { edge: 'soft' }));
  for (let i = 0; i < 3; i++)
    g.add(kit.boxAt(0.55, 0.16, 0.4, dx + 2.3, 0.55 + i * 0.14, zf - 0.7, { edge: 'soft', fill: false }));
  g.add(kit.boxAt(0.6, 0.55, 0.45, dx + 2.3, 0, zf - 0.7, { edge: 'soft' }));

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // x-run shelf modules in two banks (aisles run ACROSS the shop, not front-
    // to-back like Meridian Fresh) — each bank a row of freestanding modules.
    const tones = [TONE.teal, TONE.amber, TONE.leaf, TONE.tomato, TONE.indigo, TONE.bread];
    let t = Math.floor(h01(ctx.seed, 2) * 6);
    for (const rz of [-3.4, -0.8, 1.8]) {
      for (const rx of [-6.2, -4.2, -2.2, 0.6, 2.6, 4.6]) {
        if (Math.abs(rx) > hw - 2.2) continue;
        const m = shelfModule(tones[t++ % tones.length]);
        m.position.set(rx + (rz === -0.8 ? 0.8 : 0), 0, rz);
        ig.add(m);
      }
    }
    // produce bins just inside the offset entrance
    for (const [px, pz] of [[dx + 0.4, zf - 1.6], [dx - 0.7, zf - 1.9], [dx + 1.3, zf - 2.1]] as const) {
      const c = produceCrate(tones[(t + 1) % 6]);
      c.position.set(px, 0.5, pz);
      c.rotation.y = h01(ctx.seed, 10 + t++) * 0.8;
      ig.add(c);
      ig.add(tintBox(0.7, 0.5, 0.6, px, 0, pz, TONE.steel, false));            // bin stand
    }
    // cold cases along the back wall (teal glass doors)
    for (const cx of [-5.4, -2.7, 0, 2.7, 5.4]) {
      if (Math.abs(cx) > hw - 2.0) continue;
      k2.add(ig, k2.boxAt(2.4, 2.0, 0.8, cx, 0, zb + 0.6, { edge: 'ink' }));
      ig.add(tintLine(rectXY(cx - 1.05, cx - 0.1, 0.2, 1.85, zb + 1.02), TONE.teal));
      ig.add(tintLine(rectXY(cx + 0.1, cx + 1.05, 0.2, 1.85, zb + 1.02), TONE.teal));
    }
    // two checkout stands near the entrance
    for (const cx of [dx + 2.6, dx + 5.0]) {
      if (cx > hw - 1.5) continue;
      k2.add(ig, k2.boxAt(0.9, 0.95, 1.9, cx, 0, zf - 2.6, { edge: 'ink' }));
      ig.add(k2.slab(0.6, 1.5, cx, 0.98, zf - 2.6, { edge: 'soft' }));
      k2.add(ig, k2.boxAt(0.3, 0.3, 0.3, cx, 0.98, zf - 1.95, { edge: 'soft' }));
      ig.add(k2.line([cx, 0.98, zf - 3.4, cx, 2.4, zf - 3.4], 'faint'));        // lane pole
      ig.add(tintBox(0.4, 0.28, 0.06, cx, 2.4, zf - 3.4, TONE.teal, false));    // lane number
    }
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('market2', build);
