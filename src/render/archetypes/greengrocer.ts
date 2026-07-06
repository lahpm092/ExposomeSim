// =============================================================================
// greengrocer.ts — the GREENGROCER archetype: a low flat shop whose whole front
// is OPEN, sheltered by a canvas canopy on two posts, with tiered crate stands
// spilling produce (green/red/amber cube-heap crates) onto the sidewalk.
// Silhouette read at 60m: low box + big post canopy + the cascade of crates.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, h01, inscribe, produceCrate, tintBox, tintLine, TONE,
} from './goodsassets';

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = Math.min(15, ctx.w - 6), hw = W / 2;
  const D = Math.min(11, ctx.d - 6), zf = D / 2, zb = -D / 2;
  const H = 3.1;
  const side = h01(ctx.seed, 5) < 0.5 ? -1 : 1;         // roof-vent side

  // --- floor plate + solid back/side walls ----------------------------------
  g.add(kit.boxAt(W, 0.1, D, 0, -0.05, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, H, 0.18, 0, 0, zb + 0.09, { edge: 'ink' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.18, H, D, sx * (hw - 0.09), 0, 0, { edge: 'ink' }));

  // --- OPEN front: corner piers only + a deep header band --------------------
  const wz = zf - 0.09;
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.9, 2.35, 0.18, sx * (hw - 0.45), 0, wz, { edge: 'ink' }));
  g.add(kit.boxAt(W, H - 2.35, 0.18, 0, 2.35, wz, { edge: 'ink' }));
  // roll-down shutter box tucked under the header (the shop can close)
  g.add(kit.boxAt(W - 1.9, 0.28, 0.3, 0, 2.1, zf - 0.2, { edge: 'soft' }));

  // --- flat roof + parapet + a raised SIGN BOARD breaking the roofline --------
  g.add(kit.boxAt(W, 0.22, D, 0, H, 0, { edge: 'ink' }));
  g.add(kit.boxAt(W, 0.4, 0.2, 0, H + 0.2, zb + 0.1, { edge: 'soft' }));
  for (const sx of [-1, 1]) g.add(kit.boxAt(0.2, 0.4, D, sx * (hw - 0.1), H + 0.2, 0, { edge: 'soft' }));
  g.add(kit.boxAt(W, 0.42, 0.2, 0, H + 0.2, zf - 0.1, { edge: 'ink' }));
  g.add(kit.boxAt(8.2, 0.95, 0.24, 0, H + 0.35, zf - 0.12, { edge: 'ink' }));  // raised sign board
  g.add(inscribe('GREENGROCER', 0, H + 0.62, zf + 0.02, 0.44, 0.42, 0.16, { tone: 'soft' }));
  g.add(tintLine([-3.7, H + 0.5, zf + 0.02, 3.7, H + 0.5, zf + 0.02], TONE.leaf));
  g.add(kit.boxAt(1.3, 0.5, 0.9, -side * 3.6, H + 0.22, -2.2, { edge: 'soft' })); // roof vent
  g.add(kit.boxAt(0.9, 0.35, 0.7, side * 4.4, H + 0.22, -3.4, { edge: 'soft' }));  // roof vent

  // --- canvas CANOPY on posts, sloping out over the stands -------------------
  const CD = 2.3;                                       // canopy depth past the face
  const CW = W - 3.6;                                   // canopy width (windows peek past it)
  const canopy = kit.group();
  canopy.add(kit.boxAt(CW, 0.06, CD, 0, 0, CD / 2, { edge: 'ink' }));
  const cl: number[] = [];
  const nS = 8 + Math.floor(h01(ctx.seed, 1) * 3);
  for (let i = 0; i <= nS; i++) {                       // canvas seams along the slope
    const sx = -CW / 2 + CW * (i / nS);
    cl.push(sx, 0.045, 0.05, sx, 0.045, CD - 0.05);
  }
  for (let i = 0; i < nS; i += 2) {                     // valance scallops on the leading edge
    const x0 = -CW / 2 + CW * (i / nS), x1 = -CW / 2 + CW * ((i + 1) / nS);
    cl.push(x0, 0.02, CD, (x0 + x1) / 2, -0.17, CD, (x0 + x1) / 2, -0.17, CD, x1, 0.02, CD);
  }
  canopy.add(tintLine(cl, TONE.leaf));
  canopy.position.set(0, 2.98, zf);
  canopy.rotation.x = 0.3;
  g.add(canopy);
  for (const sx of [-1, 1]) {                           // the two support posts
    const px = sx * (CW / 2 - 0.4), pz = zf + CD - 0.45, ph = 2.98 - Math.sin(0.3) * (CD - 0.5);
    g.add(kit.cylAt(0.07, ph, 5, px, 0, pz, { edge: 'ink' }));
    g.add(kit.line([px, ph, pz, px, ph + 0.14, pz - 0.35], 'soft')); // raked strut top
  }

  // --- TIERED CRATE STANDS spilling onto the sidewalk -------------------------
  const toneWheel = [TONE.leaf, TONE.tomato, TONE.amber, TONE.leaf, TONE.amber, TONE.tomato];
  const spin = Math.floor(h01(ctx.seed, 2) * 6);
  let ci = spin;
  for (const sx of [-1, 1]) {
    const stand = kit.group();
    stand.add(kit.boxAt(3.6, 0.42, 0.9, 0, 0, 0.55, { edge: 'ink' }));        // low tier
    stand.add(kit.boxAt(3.6, 0.85, 0.9, 0, 0, -0.4, { edge: 'ink' }));        // high tier
    for (const [tx, tz, ty] of [[-1.3, 0.55, 0.42], [-0.15, 0.55, 0.42], [1.15, 0.55, 0.42],
      [-1.2, -0.4, 0.85], [0.0, -0.4, 0.85], [1.25, -0.4, 0.85]] as const) {
      const c = produceCrate(toneWheel[ci++ % toneWheel.length]);
      c.position.set(tx, ty, tz);
      c.rotation.y = (h01(ctx.seed, ci) - 0.5) * 0.5;
      stand.add(c);
    }
    stand.position.set(sx * (hw - 2.9), 0, zf + 1.2);
    g.add(stand);
  }
  // a lone crate askew by the entrance + a chalk A-board
  const stray = produceCrate(toneWheel[(spin + 1) % 6]);
  stray.position.set(h01(ctx.seed, 3) * 2 - 1, 0, zf + 2.3);
  stray.rotation.y = 0.7;
  g.add(stray);
  const ab = kit.group();
  ab.add(kit.boxAt(0.62, 0.9, 0.05, 0, 0, 0.14, { edge: 'ink' }));
  ab.add(kit.boxAt(0.62, 0.9, 0.05, 0, 0, -0.14, { edge: 'ink', fill: false }));
  ab.add(kit.line([-0.2, 0.62, 0.17, 0.2, 0.62, 0.17, -0.2, 0.45, 0.17, 0.14, 0.45, 0.17, -0.2, 0.28, 0.17, 0.2, 0.28, 0.17], 'faint'));
  ab.position.set(-h01(ctx.seed, 4) * 1.5 - 0.5, 0, zf + 2.6);
  ab.rotation.y = -0.3;
  g.add(ab);

  // ================= interior (fresh each call) ==============================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // central island table stacked with crates
    k2.add(ig, k2.boxAt(3.4, 0.75, 1.5, 0, 0, -0.2, { edge: 'ink' }));
    let cj = spin + 3;
    for (const [tx, tz] of [[-1.2, -0.5], [-0.1, 0.1], [1.1, -0.4], [0.2, -0.6]] as const) {
      const c = produceCrate(toneWheel[cj++ % toneWheel.length]);
      c.position.set(tx, 0.75, tz - 0.2);
      c.rotation.y = (h01(ctx.seed, cj) - 0.5) * 0.7;
      ig.add(c);
    }
    // stepped wall shelving along the back with more crates
    k2.add(ig, k2.boxAt(W - 2.4, 0.5, 0.8, 0, 0, zb + 0.65, { edge: 'soft' }));
    k2.add(ig, k2.boxAt(W - 2.4, 1.0, 0.6, 0, 0, zb + 0.35, { edge: 'soft' }));
    for (const tx of [-4.2, -2.1, 0, 2.1, 4.2]) {
      if (Math.abs(tx) > hw - 2.2) continue;
      const c1 = produceCrate(toneWheel[cj++ % toneWheel.length]);
      c1.position.set(tx, 0.5, zb + 0.75); ig.add(c1);
      const c2 = produceCrate(toneWheel[cj++ % toneWheel.length]);
      c2.position.set(tx + 0.5, 1.0, zb + 0.42); c2.rotation.y = 0.2; ig.add(c2);
    }
    // hanging scale over the island + a till on a small counter
    ig.add(k2.line([0.6, 2.9, -0.2, 0.6, 2.15, -0.2], 'soft'));
    k2.add(ig, k2.boxAt(0.34, 0.16, 0.34, 0.6, 1.99, -0.2, { edge: 'ink' }));   // scale pan
    ig.add(k2.knob(0.12, 0.6, 2.2, -0.2, { edge: 'soft' }));                    // dial
    k2.add(ig, k2.boxAt(1.5, 0.95, 0.7, hw - 1.6, 0, zf - 1.6, { edge: 'ink' })); // till counter
    k2.add(ig, k2.boxAt(0.3, 0.3, 0.3, hw - 1.6, 0.95, zf - 1.6, { edge: 'soft' }));
    // a leaning stack of empty crates in the corner
    for (let i = 0; i < 3; i++) {
      const e = tintBox(0.52, 0.3, 0.42, -hw + 1.1 + i * 0.05, i * 0.3, zb + 1.4, TONE.timber, false);
      e.rotation.y = i * 0.12;
      ig.add(e);
    }
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('greengrocer', build);
