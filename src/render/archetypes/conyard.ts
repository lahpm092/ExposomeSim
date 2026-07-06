// =============================================================================
// conyard.ts — the CONSTRUCTION YARD archetype: an open fenced lot instead of a
// building — a small flat-roofed site office, a lattice TOWER CRANE (mast, jib,
// counter-jib, hook line), and material piles (planks, blocks, sand, pipes).
// Muted hazard-amber accent. Silhouette read at 60m: the crane over a low fence.
// =============================================================================
import * as THREE from 'three';
import { registerArchetype, type ArchetypeBuild, type ArchetypeCtx } from './contract';
import {
  archKit, archMats, h01, inscribe, plankStack, tintBox, tintLine, TONE,
} from './goodsassets';

/** shared paper fill (for the couple of bespoke geometries below). */
function archMatsFill(): THREE.MeshBasicMaterial { return archMats().fill; }

function build(ctx: ArchetypeCtx): ArchetypeBuild {
  const kit = archKit();
  const g = kit.group();

  const W = ctx.w - 2, hw = W / 2;
  const D = ctx.d - 2, hd = D / 2;
  const gateHW = 1.9;                                   // gate half-width (front centre)

  // --- the lot: gravel pad + faint scatter ------------------------------------
  g.add(kit.boxAt(W, 0.08, D, 0, -0.04, 0, { edge: 'soft' }));
  const scatter: number[] = [];
  for (let i = 0; i < 14; i++) {
    const sx = (h01(ctx.seed, 50 + i) - 0.5) * (W - 2), sz = (h01(ctx.seed, 70 + i) - 0.5) * (D - 2);
    scatter.push(sx, 0.012, sz, sx + 0.15, 0.012, sz + 0.07);
  }
  g.add(kit.line(scatter, 'faint'));

  // --- perimeter FENCE: posts + two rails, with a front gate ------------------
  const rails: number[] = [];
  const post = (px: number, pz: number, solid = false): void => {
    g.add(kit.boxAt(0.09, 1.35, 0.09, px, 0, pz, { edge: 'ink', fill: solid }));
  };
  const run = (x0: number, z0: number, x1: number, z1: number): void => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.round(len / 2.3));
    for (let i = 0; i <= n; i++) post(x0 + (x1 - x0) * (i / n), z0 + (z1 - z0) * (i / n), i === 0 || i === n);
    for (const ry of [0.55, 1.2]) rails.push(x0, ry, z0, x1, ry, z1);
  };
  run(-hw, -hd, hw, -hd);                                // back
  run(-hw, -hd, -hw, hd);                                // left
  run(hw, -hd, hw, hd);                                  // right
  run(-hw, hd, -gateHW, hd);                             // front left of gate
  run(gateHW, hd, hw, hd);                               // front right of gate
  g.add(kit.line(rails, 'soft'));
  // gate: one leaf swung open, one shut — braced frames
  const gate = (open: boolean): THREE.Group => {
    const leaf = kit.group();
    leaf.add(kit.boxAt(gateHW, 1.3, 0.06, gateHW / 2, 0.05, 0, { edge: 'ink', fill: false }));
    leaf.add(tintLine([0.06, 0.1, 0.02, gateHW - 0.06, 1.3, 0.02, 0.06, 1.3, 0.02, gateHW - 0.06, 0.1, 0.02], TONE.amber));
    if (open) leaf.rotation.y = -1.25;
    return leaf;
  };
  const gl = gate(true); gl.position.set(-gateHW, 0, hd); gl.scale.x = 1;
  const gr = gate(false); gr.position.set(gateHW, 0, hd); gr.rotation.y = Math.PI;
  g.add(gl, gr);
  // yard sign on the fence beside the gate
  g.add(tintBox(1.9, 0.85, 0.08, gateHW + 1.6, 0.5, hd + 0.05, TONE.amber));
  g.add(inscribe('YARD', gateHW + 1.6, 0.72, hd + 0.12, 0.32, 0.36, 0.12, { tone: 'soft' }));

  // --- SITE OFFICE cabin in a back corner --------------------------------------
  const ox = -hw + 3.0, oz = -hd + 2.2;
  g.add(kit.boxAt(4.4, 2.55, 2.5, ox, 0.25, oz, { edge: 'ink' }));
  g.add(kit.boxAt(4.7, 0.12, 2.8, ox, 2.8, oz, { edge: 'soft' }));               // roof lip
  for (const bx of [-1.6, -0.4, 0.8]) {                                          // blocks it sits on
    g.add(kit.boxAt(0.45, 0.25, 0.45, ox + bx, 0, oz, { edge: 'soft' }));
  }
  const owin: number[] = [];                                                     // window band
  owin.push(ox - 1.9, 1.3, oz + 1.27, ox + 0.6, 1.3, oz + 1.27, ox - 1.9, 2.2, oz + 1.27, ox + 0.6, 2.2, oz + 1.27,
    ox - 1.9, 1.3, oz + 1.27, ox - 1.9, 2.2, oz + 1.27, ox + 0.6, 1.3, oz + 1.27, ox + 0.6, 2.2, oz + 1.27,
    ox - 0.65, 1.3, oz + 1.27, ox - 0.65, 2.2, oz + 1.27);
  g.add(kit.line(owin, 'faint'));
  g.add(kit.boxAt(0.85, 1.95, 0.08, ox + 1.55, 0.28, oz + 1.27, { edge: 'ink' })); // door
  g.add(kit.knob(0.06, ox + 1.85, 1.25, oz + 1.34, { edge: 'soft' }));
  g.add(kit.boxAt(1.1, 0.25, 0.6, ox + 1.55, 0, oz + 1.65, { edge: 'soft' }));     // step
  g.add(tintLine([ox - 2.2, 2.62, oz + 1.42, ox + 2.2, 2.62, oz + 1.42], TONE.amber)); // cabin trim

  // --- the TOWER CRANE ----------------------------------------------------------
  const cx = hw - 4.2 - h01(ctx.seed, 1) * 2.5, cz = -hd + 3.6;
  const MH = 8.6;                                        // mast height
  g.add(kit.boxAt(2.0, 0.3, 2.0, cx, 0, cz, { edge: 'ink' }));                   // ballast base
  g.add(kit.boxAt(0.78, MH, 0.78, cx, 0.3, cz, { edge: 'ink', fill: false }));   // lattice mast (open)
  const lat: number[] = [];                               // X-bracing on all four faces
  for (let y = 0.5; y < MH - 0.4; y += 1.35) {
    for (const f of [-0.39, 0.39]) {
      lat.push(cx - 0.39, y, cz + f, cx + 0.39, y + 1.35, cz + f, cx + 0.39, y, cz + f, cx - 0.39, y + 1.35, cz + f);
      lat.push(cx + f, y, cz - 0.39, cx + f, y + 1.35, cz + 0.39, cx + f, y, cz + 0.39, cx + f, y + 1.35, cz - 0.39);
    }
  }
  g.add(kit.line(lat, 'faint'));
  const ty = MH + 0.3;                                    // top of mast
  const jibYaw = h01(ctx.seed, 2) * Math.PI * 0.9 - 0.6;  // slew angle
  const crane = kit.group();                              // slewing assembly
  crane.add(kit.boxAt(0.9, 0.55, 0.9, 0, 0, 0, { edge: 'ink' }));                // turntable/cab
  crane.add(kit.boxAt(0.35, 0.35, 6.6, 0, 0.25, 3.55, { edge: 'ink', fill: false })); // jib (lattice)
  const jl: number[] = [];
  for (let z = 0.6; z < 6.4; z += 1.1) jl.push(-0.17, 0.28, z, 0.17, 0.62, z + 0.55, 0.17, 0.28, z, -0.17, 0.62, z + 0.55);
  crane.add(kit.line(jl, 'faint'));
  crane.add(kit.boxAt(0.35, 0.35, 2.3, 0, 0.25, -1.5, { edge: 'ink', fill: false })); // counter-jib
  crane.add(kit.boxAt(0.7, 0.75, 0.6, 0, 0.05, -2.35, { edge: 'ink' }));          // counterweight
  crane.add(kit.boxAt(0.28, 1.5, 0.28, 0, 0.55, 0, { edge: 'ink' }));             // apex pylon
  crane.add(kit.line([0, 2.0, 0, 0, 0.75, 4.6, 0, 2.0, 0, 0, 0.75, -2.3], 'soft')); // tie bars
  const HOOK_Z = 4.6, HOOK_DROP = 4.6;
  crane.add(kit.line([0, 0.32, HOOK_Z, 0, 0.32 - HOOK_DROP, HOOK_Z], 'ink'));     // hoist line
  crane.add(kit.boxAt(0.22, 0.3, 0.22, 0, 0.32 - HOOK_DROP - 0.3, HOOK_Z, { edge: 'ink' })); // hook block
  crane.add(tintLine([-0.19, 0.45, 3.0, 0.19, 0.45, 3.0, -0.19, 0.45, 5.9, 0.19, 0.45, 5.9], TONE.amber));
  crane.position.set(cx, ty, cz);
  crane.rotation.y = jibYaw;
  g.add(crane);

  // --- MATERIAL PILES -----------------------------------------------------------
  const p1 = plankStack(); p1.position.set(-2.2, 0, 1.6); p1.rotation.y = 0.25; g.add(p1);
  const p2 = plankStack(); p2.position.set(-3.6, 0, 2.4); p2.rotation.y = -0.15; g.add(p2);
  const blocks = kit.group();                              // block/brick pile, staggered
  for (const [bx2, by, bz2] of [[-0.5, 0, 0], [0.15, 0, 0.1], [0.8, 0, -0.05], [-0.2, 0.34, 0.05], [0.45, 0.34, 0]] as const)
    blocks.add(tintBox(0.6, 0.34, 0.45, bx2, by, bz2, TONE.steel));
  blocks.position.set(2.6, 0, 0.6);
  blocks.rotation.y = 0.35;
  g.add(blocks);
  const sandGeo = new THREE.IcosahedronGeometry(1.0, 0);   // sand heap (squashed)
  sandGeo.scale(1.15, 0.42, 1.0);
  sandGeo.translate(0.4, 0.35, 3.6);
  const sand = new THREE.Group();
  sand.add(new THREE.Mesh(sandGeo, archMatsFill()));
  sand.add(new THREE.LineSegments(new THREE.EdgesGeometry(sandGeo, 12), kit.mat('soft')));
  g.add(sand);
  const pipes = kit.group();                               // pipe stack (2 + 1)
  for (const [py, px] of [[0, -0.28], [0, 0.28], [0.42, 0]] as const) {
    const geo = new THREE.CylinderGeometry(0.24, 0.24, 2.6, 5, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(px, 0.26 + py, 0);
    pipes.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), kit.mat('ink')));
  }
  pipes.position.set(cx - 2.6, 0, cz + 2.6);
  pipes.rotation.y = 0.9;
  g.add(pipes);

  // ================= interior (near-camera site clutter) =====================
  const buildInterior = (): THREE.Group => {
    const k2 = archKit();
    const ig = k2.group();
    // cement mixer: tilted drum + stand + wheel
    const mx = 2.0, mz = 3.4;
    const drumGeo = new THREE.CylinderGeometry(0.42, 0.25, 0.85, 6);
    drumGeo.translate(0, 0.5, 0);
    drumGeo.rotateX(-0.7);
    const drum = new THREE.Group();
    drum.add(new THREE.Mesh(drumGeo, archMatsFill()));
    drum.add(new THREE.LineSegments(new THREE.EdgesGeometry(drumGeo, 20), k2.mat('ink')));
    drum.position.set(mx, 0.45, mz);
    ig.add(drum);
    ig.add(k2.line([mx - 0.35, 0, mz - 0.3, mx, 0.5, mz, mx + 0.35, 0, mz - 0.3, mx, 0.5, mz], 'ink'));
    ig.add(k2.knob(0.14, mx, 0.15, mz + 0.4, { edge: 'soft' }));
    // wheelbarrow
    const wx = -1.0, wz2 = 4.0;
    k2.add(ig, k2.boxAt(0.55, 0.3, 0.9, wx, 0.3, wz2, { edge: 'ink' }));
    ig.add(k2.line([wx - 0.2, 0.3, wz2 + 0.45, wx - 0.2, 0.05, wz2 + 0.75, wx + 0.2, 0.3, wz2 + 0.45, wx + 0.2, 0.05, wz2 + 0.75], 'soft'));
    ig.add(k2.knob(0.15, wx, 0.15, wz2 - 0.5, { edge: 'ink' }));
    // rebar bundle + barrels + a cable reel
    const rb: number[] = [];
    for (let i = 0; i < 5; i++) rb.push(-4.6 + i * 0.07, 0.05 + (i % 2) * 0.05, -1.0, -1.8 + i * 0.07, 0.05 + (i % 2) * 0.05, -2.2);
    ig.add(k2.line(rb, 'soft'));
    for (const [bx2, bz2] of [[3.6, 2.8], [4.2, 2.3]] as const) {
      k2.add(ig, k2.cylAt(0.3, 0.85, 6, bx2, 0, bz2, { edge: 'ink' }));
      ig.add(tintLine([bx2 - 0.3, 0.5, bz2 + 0.31, bx2 + 0.3, 0.5, bz2 + 0.31], TONE.amber));
    }
    const reel = k2.group();
    for (const rz of [-0.22, 0.22]) {
      const disc = new THREE.CylinderGeometry(0.5, 0.5, 0.06, 8);
      disc.rotateX(Math.PI / 2);
      disc.translate(0, 0.5, rz);
      reel.add(new THREE.Mesh(disc, archMatsFill()));
      reel.add(new THREE.LineSegments(new THREE.EdgesGeometry(disc, 20), k2.mat('ink')));
    }
    reel.add(k2.cylAt(0.16, 0.4, 5, 0, 0.3, -0.2, { edge: 'soft', fill: false }));
    reel.position.set(-3.8, 0, 0.2);
    ig.add(reel);
    // a second, half-unloaded plank stack near the gate
    const p3 = plankStack();
    p3.position.set(0.6, 0, hd - 2.0);
    p3.rotation.y = 1.2;
    ig.add(p3);
    return ig;
  };

  return { group: g, buildInterior };
}

registerArchetype('conyard', build);
