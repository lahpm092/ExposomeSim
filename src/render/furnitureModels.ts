// @ts-nocheck
// =============================================================================
// furnitureModels.ts — low-poly appliances & furniture authored by the parallel
// modelling agents (apartment-models workflow) against the shared kit. Kept in a
// no-typecheck module because it is generated geometry; buildApartment falls back
// to simple placeholders if any builder throws.
// =============================================================================
import type { Kit } from './kit';

function buildKitchen(kit) {
  const g = kit.group();
  const rcyl = (r, h, seg, x, y, z, rx, ry, rz, o) => {
    const c = kit.cyl(r, h, seg, o);
    c.position.set(x, y, z);
    c.rotation.set(rx, ry, rz);
    return c;
  };

  // ---------- BASE CABINET RUN (left of the stove) ----------
  const baseW = 1.41, baseCx = -0.695, baseZ = -0.01, baseFront = 0.29;
  kit.add(g, kit.boxAt(baseW, 0.9, 0.6, baseCx, 0, baseZ, { edge: 'ink' }));
  kit.add(g, kit.line([
    -0.93, 0, baseFront, -0.93, 0.9, baseFront,
    -0.46, 0, baseFront, -0.46, 0.9, baseFront,
    -1.4, 0.72, baseFront, 0.01, 0.72, baseFront,
    -1.4, 0.09, baseFront, 0.01, 0.09, baseFront
  ], 'faint'));
  [-1.165, -0.695, -0.225].forEach(x => kit.add(g, kit.knob(0.03, x, 0.62, 0.3, { edge: 'soft' })));

  // ---------- WORKTOP built as a frame around a SINK hole ----------
  // hole x[-0.85,-0.35] z[-0.20,0.20]; counter top = 0.94, basin floor = cabinet top 0.90
  kit.add(g, kit.slab(baseW, 0.11, baseCx, 0.9, -0.255, { edge: 'ink' }));
  kit.add(g, kit.slab(baseW, 0.11, baseCx, 0.9, 0.255, { edge: 'ink' }));
  kit.add(g, kit.slab(0.55, 0.40, -1.125, 0.9, 0.0, { edge: 'ink' }));
  kit.add(g, kit.slab(0.36, 0.40, -0.17, 0.9, 0.0, { edge: 'ink' }));
  kit.add(g, kit.line([
    -0.85, 0.941, -0.20, -0.35, 0.941, -0.20,
    -0.35, 0.941, -0.20, -0.35, 0.941, 0.20,
    -0.35, 0.941, 0.20, -0.85, 0.941, 0.20,
    -0.85, 0.941, 0.20, -0.85, 0.941, -0.20
  ], 'faint'));
  kit.add(g, kit.knob(0.04, -0.6, 0.9, 0.0, { edge: 'soft' }));
  // faucet: vertical post + horizontal spout + down tip
  kit.add(g, kit.cylAt(0.018, 0.24, 8, -0.6, 0.94, -0.26, { edge: 'soft' }));
  kit.add(g, rcyl(0.016, 0.20, 8, -0.6, 1.16, -0.26, Math.PI / 2, 0, 0, { edge: 'soft' }));
  kit.add(g, kit.cylAt(0.016, 0.06, 8, -0.6, 1.10, -0.06, { edge: 'soft' }));

  // ---------- STOVE: OVEN body + COOKTOP + 4 BURNERS ----------
  const stCx = 0.38;
  kit.add(g, kit.boxAt(0.74, 0.9, 0.6, stCx, 0, -0.01, { edge: 'ink' }));
  kit.add(g, kit.line([
    0.05, 0.10, 0.291, 0.71, 0.10, 0.291,
    0.71, 0.10, 0.291, 0.71, 0.70, 0.291,
    0.71, 0.70, 0.291, 0.05, 0.70, 0.291,
    0.05, 0.70, 0.291, 0.05, 0.10, 0.291,
    0.03, 0.80, 0.291, 0.73, 0.80, 0.291
  ], 'faint'));
  kit.add(g, rcyl(0.016, 0.62, 8, 0.69, 0.76, 0.31, 0, 0, Math.PI / 2, { edge: 'soft' }));
  [0.15, 0.61].forEach(x => kit.add(g, kit.knob(0.03, x, 0.85, 0.3, { edge: 'soft' })));
  kit.add(g, kit.slab(0.74, 0.6, stCx, 0.9, -0.01, { edge: 'ink' }));
  [[0.22, -0.16], [0.54, -0.16], [0.22, 0.14], [0.54, 0.14]].forEach(b => {
    const bx = b[0], bz = b[1];
    kit.add(g, kit.cylAt(0.10, 0.02, 10, bx, 0.94, bz, { edge: 'soft' }));
    kit.add(g, kit.cylAt(0.045, 0.03, 10, bx, 0.94, bz, { edge: 'faint' }));
  });

  // ---------- RANGE HOOD (sloped trapezoid on the wall) ----------
  const hood = kit.wedge(0.5, 0.45, 0.84, stCx, 1.55, -0.06, { edge: 'ink' });
  hood.rotation.y = -Math.PI / 2;
  kit.add(g, hood);
  kit.add(g, kit.boxAt(0.84, 0.06, 0.06, stCx, 1.55, 0.17, { edge: 'soft' }));

  // ---------- BACKSPLASH ----------
  kit.add(g, kit.boxAt(2.19, 0.56, 0.03, -0.305, 0.94, -0.3, { edge: 'soft' }));
  kit.add(g, kit.line([
    -1.4, 1.22, -0.283, 0.79, 1.22, -0.283,
    -0.9, 0.94, -0.283, -0.9, 1.5, -0.283,
    -0.3, 0.94, -0.283, -0.3, 1.5, -0.283,
    0.3, 0.94, -0.283, 0.3, 1.5, -0.283
  ], 'faint'));

  // ---------- UPPER WALL CABINETS ----------
  kit.add(g, kit.boxAt(1.41, 0.6, 0.34, -0.695, 1.5, -0.14, { edge: 'ink' }));
  kit.add(g, kit.line([
    -0.93, 1.5, 0.03, -0.93, 2.1, 0.03,
    -0.46, 1.5, 0.03, -0.46, 2.1, 0.03
  ], 'faint'));
  [-1.165, -0.695, -0.225].forEach(x => kit.add(g, kit.knob(0.03, x, 1.58, 0.04, { edge: 'soft' })));
  kit.add(g, kit.boxAt(0.6, 0.25, 0.34, 1.1, 1.85, -0.14, { edge: 'ink' }));
  kit.add(g, kit.line([1.1, 1.85, 0.03, 1.1, 2.1, 0.03], 'faint'));
  [0.95, 1.25].forEach(x => kit.add(g, kit.knob(0.03, x, 1.92, 0.04, { edge: 'soft' })));

  // ---------- TALL FRIDGE (right end) ----------
  kit.add(g, kit.boxAt(0.6, 1.85, 0.62, 1.1, 0, 0, { edge: 'ink' }));
  kit.add(g, kit.line([0.8, 1.15, 0.311, 1.4, 1.15, 0.311], 'soft'));
  kit.add(g, kit.cylAt(0.02, 0.6, 8, 0.86, 0.45, 0.34, { edge: 'soft' }));
  kit.add(g, kit.cylAt(0.02, 0.42, 8, 0.86, 1.28, 0.34, { edge: 'soft' }));

  return g;
}

function buildBathroom(kit) {
  const g = kit.group();

  // small helper: closed oval ring as line-segment pairs (in the xz plane at height cy)
  const oval = (cx, cy, cz, rx, rz, n) => {
    const p = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      p.push(cx + Math.cos(a0) * rx, cy, cz + Math.sin(a0) * rz,
             cx + Math.cos(a1) * rx, cy, cz + Math.sin(a1) * rz);
    }
    return p;
  };

  // ===================== SHOWER STALL (back-left corner) =====================
  // low kerb base tray (~0.9 x 0.9)
  kit.add(g, kit.boxAt(0.9, 0.06, 0.9, -0.62, 0, -0.25, { edge: 'ink' }));
  // two glass side panels -> fill:false so only the ink frame reads (transparent)
  kit.add(g, kit.boxAt(0.9, 1.9, 0.03, -0.62, 0.06, 0.185, { edge: 'ink', fill: false })); // front pane
  kit.add(g, kit.boxAt(0.03, 1.9, 0.9, -0.17, 0.06, -0.25, { edge: 'ink', fill: false }));  // side pane
  kit.add(g, kit.line([-0.62, 0.06, 0.185, -0.62, 1.96, 0.185], 'faint'));                  // pane seam hint
  // shower head on riser: thin wall pipe + short arm + round head disc
  kit.add(g, kit.cylAt(0.025, 1.68, 6, -0.9, 0.06, -0.6, { edge: 'soft' }));  // riser pipe up the wall
  kit.add(g, kit.boxAt(0.05, 0.06, 0.32, -0.9, 1.6, -0.45, { edge: 'soft' })); // arm reaching into stall
  kit.add(g, kit.cylAt(0.12, 0.05, 10, -0.9, 1.55, -0.3, { edge: 'ink' }));    // flat round head disc
  kit.add(g, kit.line(oval(-0.9, 1.548, -0.3, 0.07, 0.07, 6), 'faint'));       // spray face ring

  // ============================ TOILET (centre) =============================
  // cistern / tank against the back wall, resting on the pedestal back
  kit.add(g, kit.boxAt(0.40, 0.52, 0.16, 0.15, 0.30, -0.62, { edge: 'ink' }));
  kit.add(g, kit.knob(0.06, 0.15, 0.83, -0.62, { edge: 'soft' })); // flush button
  kit.add(g, kit.line([-0.05, 0.30, -0.62, 0.35, 0.30, -0.62], 'faint')); // tank base line
  // pedestal + rounded bowl (cyl ovalised toward the front) + seat/lid slab
  kit.add(g, kit.boxAt(0.22, 0.30, 0.40, 0.15, 0, -0.42, { edge: 'ink' })); // pedestal
  const bowl = kit.cyl(0.19, 0.12, 10, { edge: 'ink' });
  bowl.scale.set(1, 1, 1.2); bowl.position.set(0.15, 0.30, -0.30);
  kit.add(g, bowl);
  kit.add(g, kit.slab(0.42, 0.50, 0.15, 0.42, -0.28, { edge: 'ink' })); // seat / lid
  kit.add(g, kit.line(oval(0.15, 0.47, -0.29, 0.11, 0.15, 10), 'faint')); // seat opening

  // ========================= SINK VANITY (right) ============================
  kit.add(g, kit.boxAt(0.64, 0.80, 0.42, 0.78, 0, -0.46, { edge: 'ink' })); // cabinet
  kit.add(g, kit.slab(0.70, 0.48, 0.78, 0.80, -0.45, { edge: 'ink' }));     // counter top
  kit.add(g, kit.line([0.43, 0.80, -0.21, 1.13, 0.80, -0.21], 'faint'));    // counter front edge
  // oval vessel basin sitting on the counter + faint rim recess line
  const basin = kit.cyl(0.14, 0.09, 10, { edge: 'soft' });
  basin.scale.set(1.25, 1, 1); basin.position.set(0.78, 0.84, -0.44);
  kit.add(g, basin);
  kit.add(g, kit.line(oval(0.78, 0.93, -0.44, 0.16, 0.12, 12), 'faint')); // basin recess rim
  // faucet: riser + forward spout + tip, and two tap handles
  kit.add(g, kit.cylAt(0.02, 0.16, 6, 0.78, 0.84, -0.60, { edge: 'soft' }));   // riser
  kit.add(g, kit.boxAt(0.03, 0.03, 0.13, 0.78, 0.97, -0.55, { edge: 'soft' })); // spout arm
  kit.add(g, kit.knob(0.035, 0.78, 0.955, -0.49, { edge: 'soft' }));            // spout tip
  kit.add(g, kit.knob(0.03, 0.66, 0.85, -0.58, { edge: 'faint' }));            // tap handle L
  kit.add(g, kit.knob(0.03, 0.90, 0.85, -0.58, { edge: 'faint' }));            // tap handle R
  // mirror on the wall above the vanity (thin upright panel, soft edges)
  kit.add(g, kit.boxAt(0.56, 0.66, 0.025, 0.78, 1.02, -0.685, { edge: 'soft' }));

  return g;
}

function buildBed(kit) {
  const g = kit.group();

  // ---------- DOUBLE BED (left side, head at back z=-1.0) ----------
  const bx = -0.48;                                   // bed centre x
  kit.add(g, kit.boxAt(1.00, 0.30, 2.00, bx, 0, 0));  // low frame / base
  kit.add(g, kit.boxAt(0.92, 0.18, 1.90, bx, 0.30, 0.00, {edge:'soft'})); // mattress
  // duvet: a slightly thicker slab covering the lower 2/3, head left bare
  kit.add(g, kit.boxAt(0.96, 0.14, 1.42, bx, 0.46, 0.28, {edge:'soft'}));
  // rumpled folds across the duvet
  kit.add(g, kit.line([
    bx-0.46,0.605,-0.10, bx+0.46,0.605,-0.10,
    bx-0.42,0.605, 0.34, bx+0.42,0.605, 0.34,
    bx-0.30,0.605, 0.72, bx+0.34,0.605, 0.62
  ], 'faint'));
  // two pillows at the head
  kit.add(g,
    kit.boxAt(0.42, 0.14, 0.32, bx-0.23, 0.48, -0.72, {edge:'soft'}),
    kit.boxAt(0.42, 0.14, 0.32, bx+0.23, 0.48, -0.72, {edge:'soft'}));
  // upright headboard panel at the back
  kit.add(g, kit.boxAt(1.04, 0.95, 0.08, bx, 0, -1.04));

  // ---------- NIGHTSTAND (right of the bed head) ----------
  const nx = 0.30, nz = -0.75, nTop = 0.50;
  kit.add(g, kit.boxAt(0.44, nTop, 0.42, nx, 0, nz));
  // little drawer split + knob on the front face (+z)
  kit.add(g, kit.line([nx-0.17,0.32,nz+0.215, nx+0.17,0.32,nz+0.215], 'faint'));
  kit.add(g, kit.knob(0.025, nx, 0.20, nz+0.22));
  // small table lamp: base disc + thin stem + drum/cone shade
  kit.add(g,
    kit.cylAt(0.055, 0.03, 6, nx, nTop, nz),
    kit.cylAt(0.018, 0.20, 6, nx, nTop+0.03, nz),
    kit.cylAt(0.110, 0.15, 8, nx, nTop+0.20, nz, {edge:'soft'}));

  // ---------- WARDROBE / CLOSET (right, doors facing +z) ----------
  const wx = 0.50, wz = 0.50, wf = wz + 0.275;        // front face z
  kit.add(g, kit.boxAt(0.90, 2.00, 0.55, wx, 0, wz));
  // centre door split (two doors)
  kit.add(g, kit.line([wx,0.06,wf+0.006, wx,1.94,wf+0.006], 'soft'));
  // top cornice + base plinth lines
  kit.add(g, kit.line([
    wx-0.44,1.90,wf+0.006, wx+0.44,1.90,wf+0.006,
    wx-0.44,0.12,wf+0.006, wx+0.44,0.12,wf+0.006
  ], 'faint'));
  // a handle on each door, flanking the split
  kit.add(g,
    kit.knob(0.03, wx-0.06, 1.00, wf+0.012),
    kit.knob(0.03, wx+0.06, 1.00, wf+0.012));

  return g;
}

function buildLiving(kit) {
  const g = kit.group();

  // ---- SOFA (2-3 seat, faces +z) : base + backrest + two arms + cushions ----
  kit.add(g,
    kit.boxAt(1.60, 0.30, 0.75, -0.55, 0,    -0.90),                  // base block
    kit.boxAt(0.16, 0.52, 0.72, -1.27, 0,    -0.90),                  // left arm
    kit.boxAt(0.16, 0.52, 0.72,  0.17, 0,    -0.90),                  // right arm
    kit.boxAt(1.24, 0.50, 0.16, -0.55, 0.30, -1.195),                 // backrest
    kit.boxAt(1.24, 0.14, 0.60, -0.55, 0.30, -0.85, { edge: 'soft' }),// seat cushion pad
    kit.line([                                                        // seat cushion splits (3 seats)
      -0.757, 0.445, -0.55,  -0.757, 0.445, -1.15,
      -0.343, 0.445, -0.55,  -0.343, 0.445, -1.15,
      -0.757, 0.445, -0.55,  -0.757, 0.30,  -0.55,
      -0.343, 0.445, -0.55,  -0.343, 0.30,  -0.55
    ], 'soft'),
    kit.line([                                                        // back cushion splits
      -0.757, 0.36, -1.11,  -0.757, 0.76, -1.11,
      -0.343, 0.36, -1.11,  -0.343, 0.76, -1.11
    ], 'soft')
  );

  // ---- LOW COFFEE TABLE (in front of sofa) : top + 4 legs ----
  kit.add(g,
    kit.boxAt(0.90, 0.06, 0.50, -0.55, 0.30, -0.10),
    kit.boxAt(0.05, 0.30, 0.05, -0.95, 0,    -0.30, { edge: 'soft' }),
    kit.boxAt(0.05, 0.30, 0.05, -0.15, 0,    -0.30, { edge: 'soft' }),
    kit.boxAt(0.05, 0.30, 0.05, -0.95, 0,     0.10, { edge: 'soft' }),
    kit.boxAt(0.05, 0.30, 0.05, -0.15, 0,     0.10, { edge: 'soft' })
  );

  // ---- MEDIA STAND + FLATSCREEN TV (opposite sofa, screen faces -z) ----
  kit.add(g,
    kit.boxAt(1.40, 0.40, 0.40, -0.55, 0,    1.05),                   // console
    kit.boxAt(0.35, 0.04, 0.16, -0.55, 0.40, 1.03),                   // TV foot
    kit.boxAt(1.10, 0.62, 0.05, -0.55, 0.44, 1.03),                   // TV panel
    kit.line([                                                        // screen bezel
      -1.0, 0.52, 1.0,  -0.1, 0.52, 1.0,
      -0.1, 0.52, 1.0,  -0.1, 0.98, 1.0,
      -0.1, 0.98, 1.0,  -1.0, 0.98, 1.0,
      -1.0, 0.98, 1.0,  -1.0, 0.52, 1.0
    ], 'soft'),
    kit.line([ -0.55, 0.05, 1.251,  -0.55, 0.35, 1.251 ], 'faint'),   // console door split
    kit.knob(0.03, -0.75, 0.20, 1.26),
    kit.knob(0.03, -0.35, 0.20, 1.26)
  );

  // ---- POTTED PLANT (a bit of life) : pot + trunk + green foliage ----
  kit.add(g,
    kit.cylAt(0.15, 0.32, 8, -1.35, 0,    0.25),
    kit.cylAt(0.03, 0.30, 6, -1.35, 0.30, 0.25, { edge: 'soft' }),
    kit.ball(0.24, -1.35, 0.62, 0.25, { edge: 'green' }),
    kit.ball(0.15, -1.22, 0.80, 0.28, { edge: 'green' }),
    kit.ball(0.15, -1.47, 0.74, 0.22, { edge: 'green' })
  );

  // ---- ROUND DINING TABLE (right side) : foot + pedestal + round top ----
  kit.add(g,
    kit.cylAt(0.20, 0.04, 8,  1.05, 0,    0),
    kit.cylAt(0.06, 0.68, 8,  1.05, 0,    0, { edge: 'soft' }),
    kit.cylAt(0.42, 0.05, 10, 1.05, 0.68, 0)
  );

  // ---- TWO DINING CHAIRS : seat + backrest + legs ----
  const chair = function (cx, cz, front) {
    const bz = cz - front * 0.175;
    kit.add(g,
      kit.boxAt(0.40, 0.05, 0.40, cx,        0.42, cz),
      kit.boxAt(0.40, 0.42, 0.05, cx,        0.47, bz),
      kit.boxAt(0.04, 0.42, 0.04, cx - 0.16, 0,    cz - 0.16, { edge: 'soft' }),
      kit.boxAt(0.04, 0.42, 0.04, cx + 0.16, 0,    cz - 0.16, { edge: 'soft' }),
      kit.boxAt(0.04, 0.42, 0.04, cx - 0.16, 0,    cz + 0.16, { edge: 'soft' }),
      kit.boxAt(0.04, 0.42, 0.04, cx + 0.16, 0,    cz + 0.16, { edge: 'soft' })
    );
  };
  chair(1.05, -0.62,  1);
  chair(1.05,  0.62, -1);

  return g;
}

export const FURNITURE = { kitchen: buildKitchen, bathroom: buildBathroom, bed: buildBed, living: buildLiving };
