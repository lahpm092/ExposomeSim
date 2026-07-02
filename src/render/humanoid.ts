// =============================================================================
// humanoid.ts — a low-poly humanoid drawn in the house style: solid low-poly
// volume in paper colour so it occludes cleanly, over crisp black ink edges.
// Volumetric (not stick-figure), yet still reads as black line-work on sepia.
//
// One class serves the protagonist, the interaction partner and proximate NPCs.
// It is ARTICULATED (hip/knee/shoulder/elbow/neck joints) so a walk cycle plays
// as the character traverses the city, and EMBODIED — the protagonist's posture,
// tint, tremor and breath are driven from the soma each frame.
//
// Rig (local, root at the feet, faces +z by default):
//   root ─ hips ─┬─ legL[hip]→[knee]   ─ legR[hip]→[knee]
//               └─ torso[waist lean]  ─┬─ head[neck]
//                                      ├─ armL[shoulder]→[elbow]
//                                      └─ armR[shoulder]→[elbow]
//
// Cost discipline: two materials per figure (paper fill + ink edge). The fill
// meshes write depth so the far side of the body never shows through; the edge
// lines ride on top. Geometry is cheap boxes; the walk is pure joint rotation.
// =============================================================================
import * as THREE from 'three';
import type { SomaState, EmotionReadout, Demeanor, Customer } from '../types';
import { C, PALETTE, clampNum } from './palette';

export type FigureRole = 'protagonist' | 'partner' | 'npc';

// --- proportions (metres, ~1.72 m tall) -------------------------------------
const HIP_Y = 0.90;
const THIGH = 0.44;
const SHIN = 0.44;
const TORSO_H = 0.56;      // waist → shoulders
const SHOULDER_Y = TORSO_H; // in torso-local space
const SH_HALF = 0.19;
const UPPER_ARM = 0.29;
const FORE_ARM = 0.26;
const NECK = 0.10;
const HEAD_R = 0.13;

const BASE_OPACITY = 0.9;

/** spring-smoothed scalar chasing a target each tick. */
class Smooth {
  constructor(public v: number) {}
  toward(t: number, k: number): number { this.v += (t - this.v) * k; return this.v; }
}

/** A solid low-poly box whose TOP face sits at local y=0 (it hangs downward). */
function limbBox(
  w: number, h: number, d: number, fill: THREE.Material, edge: THREE.LineBasicMaterial,
  taper = 0.75,
): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  // taper the bottom face inward for a low-poly limb silhouette
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) { pos.setX(i, pos.getX(i) * taper); pos.setZ(i, pos.getZ(i) * taper); }
  }
  geo.translate(0, -h / 2, 0);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, fill);
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge);
  g.add(mesh, lines);
  return g;
}

/** A centred solid box (torso, pelvis) with edges. */
function solidBox(
  w: number, h: number, d: number, fill: THREE.Material, edge: THREE.LineBasicMaterial,
): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geo, fill);
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge);
  g.add(mesh, lines);
  return g;
}

export class Humanoid {
  readonly object = new THREE.Group();

  // kinematics (world). The stage writes targets; tick() chases them + drives gait.
  pos = new THREE.Vector3();
  target = new THREE.Vector3();
  yaw = 0;
  targetYaw = 0;

  private readonly role: FigureRole;
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private hipL = new THREE.Group();
  private hipR = new THREE.Group();
  private kneeL = new THREE.Group();
  private kneeR = new THREE.Group();
  private shL = new THREE.Group();
  private shR = new THREE.Group();
  private elL = new THREE.Group();
  private elR = new THREE.Group();

  private fill: THREE.MeshBasicMaterial;
  private ink: THREE.LineBasicMaterial;
  private headFill?: THREE.MeshBasicMaterial; // protagonist: a red head (a clear marker)

  // smoothed articulation
  private leanX = new Smooth(0);
  private hunch = new Smooth(0);
  private headX = new Smooth(0);
  private headZ = new Smooth(0);
  private tremor = new Smooth(0);
  private breathAmp = new Smooth(0.006);
  private fade = new Smooth(1);
  private gait = 0;          // walk-cycle phase
  private gaitAmp = new Smooth(0);

  // desired (set per frame)
  private dLean = 0; private dHunch = 0; private dHeadX = 0; private dHeadZ = 0;
  private dTremor = 0; private dBreath = 0.006; private dFade = 1;
  private readonly dColor = C.ink.clone();

  private clock = Math.random() * 10;
  private speed = 0;         // world units/s, measured from motion
  private scaleTarget = 1;   // 1 outside, 1/8 inside the shrunk apartment
  private scaleV = new Smooth(1);

  /** target body scale (smoothly approached) — the "shrink on entering" trick. */
  setScale(s: number): void { this.scaleTarget = s; }

  constructor(role: FigureRole) {
    this.role = role;
    this.fill = new THREE.MeshBasicMaterial({
      color: PALETTE.paper, side: THREE.FrontSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.ink = new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: BASE_OPACITY });
    if (role === 'protagonist') {
      this.headFill = new THREE.MeshBasicMaterial({
        color: 0xb23020, side: THREE.FrontSide,   // a clear red head, so Mara reads at a glance
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
    }
    this.build();
  }

  private build(): void {
    const F = this.fill, E = this.ink;

    // --- hips / pelvis ------------------------------------------------------
    this.hips.position.y = HIP_Y;
    this.object.add(this.hips);
    const pelvis = solidBox(0.30, 0.20, 0.20, F, E);
    pelvis.position.y = 0.02;
    this.hips.add(pelvis);

    // --- legs ---------------------------------------------------------------
    this.hipL.position.set(0.09, -0.02, 0);
    this.hipR.position.set(-0.09, -0.02, 0);
    this.hips.add(this.hipL, this.hipR);
    this.hipL.add(limbBox(0.15, THIGH, 0.16, F, E, 0.8));
    this.hipR.add(limbBox(0.15, THIGH, 0.16, F, E, 0.8));
    this.kneeL.position.y = -THIGH;
    this.kneeR.position.y = -THIGH;
    this.hipL.add(this.kneeL); this.hipR.add(this.kneeR);
    const shinL = limbBox(0.12, SHIN, 0.14, F, E, 0.7); this.kneeL.add(shinL);
    const shinR = limbBox(0.12, SHIN, 0.14, F, E, 0.7); this.kneeR.add(shinR);
    // feet
    const footGeo = new THREE.BoxGeometry(0.12, 0.06, 0.24);
    footGeo.translate(0, -0.03, 0.06);
    const footL = new THREE.Mesh(footGeo, F); footL.position.y = -SHIN;
    const footLe = new THREE.LineSegments(new THREE.EdgesGeometry(footGeo, 1), E); footLe.position.y = -SHIN;
    this.kneeL.add(footL, footLe);
    const footR = new THREE.Mesh(footGeo.clone(), F); footR.position.y = -SHIN;
    const footRe = new THREE.LineSegments(new THREE.EdgesGeometry(footGeo, 1), E); footRe.position.y = -SHIN;
    this.kneeR.add(footR, footRe);

    // --- torso (waist pivot, leans with valence) ----------------------------
    this.torso.position.set(0, 0.06, 0);
    this.hips.add(this.torso);
    // a tapered chest block: wider at the shoulders
    const chest = new THREE.Group();
    const chestGeo = new THREE.BoxGeometry(0.34, TORSO_H, 0.22);
    const cp = chestGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) {           // taper toward the waist
      if (cp.getY(i) < 0) { cp.setX(i, cp.getX(i) * 0.78); cp.setZ(i, cp.getZ(i) * 0.9); }
    }
    chestGeo.translate(0, TORSO_H / 2, 0);
    chest.add(new THREE.Mesh(chestGeo, F), new THREE.LineSegments(new THREE.EdgesGeometry(chestGeo, 1), E));
    this.torso.add(chest);

    // --- head ---------------------------------------------------------------
    this.head.position.y = SHOULDER_Y + NECK;
    this.torso.add(this.head);
    const headGeo = new THREE.IcosahedronGeometry(HEAD_R, 0);
    headGeo.scale(0.92, 1.06, 0.98);
    headGeo.translate(0, HEAD_R * 0.7, 0);
    this.head.add(new THREE.Mesh(headGeo, this.headFill ?? F), new THREE.LineSegments(new THREE.EdgesGeometry(headGeo, 1), E));
    // a short gaze tick — the direction the figure attends to
    const gaze = new THREE.BufferGeometry();
    gaze.setAttribute('position', new THREE.Float32BufferAttribute(
      [0, HEAD_R * 0.7, HEAD_R * 0.7, 0, HEAD_R * 0.62, HEAD_R + 0.1], 3));
    this.head.add(new THREE.Line(gaze, E));

    // --- arms ---------------------------------------------------------------
    this.shL.position.set(SH_HALF, SHOULDER_Y - 0.03, 0);
    this.shR.position.set(-SH_HALF, SHOULDER_Y - 0.03, 0);
    this.torso.add(this.shL, this.shR);
    this.shL.add(limbBox(0.10, UPPER_ARM, 0.11, F, E, 0.85));
    this.shR.add(limbBox(0.10, UPPER_ARM, 0.11, F, E, 0.85));
    this.elL.position.y = -UPPER_ARM; this.elR.position.y = -UPPER_ARM;
    this.shL.add(this.elL); this.shR.add(this.elR);
    this.elL.add(limbBox(0.085, FORE_ARM, 0.095, F, E, 0.8));
    this.elR.add(limbBox(0.085, FORE_ARM, 0.095, F, E, 0.8));
  }

  // ---------------------------------------------------------------------------
  // per-frame intent
  // ---------------------------------------------------------------------------

  /** Protagonist/partner: translate soma + readout into posture, tint, tremor. */
  embody(soma?: Partial<SomaState>, readout?: Partial<EmotionReadout>): void {
    const val = clampNum(readout?.valence ?? soma?.valence ?? 0, -1, 1);
    const aro = clampNum(readout?.arousal ?? soma?.arousal ?? 0.45, 0, 1);
    const dom = clampNum(readout?.dominance ?? soma?.dominance ?? 0, -1, 1);
    const amyg = clampNum(soma?.amygdala ?? 0, 0, 1);
    const cort = Number.isFinite(soma?.cortisol) ? (soma!.cortisol as number) : 1;
    const stress = clampNum(cort - 1, 0, 1.5) / 1.5;

    const tension = clampNum(0.55 * amyg + 0.5 * stress + 0.2 * Math.max(0, aro - 0.5), 0, 1);
    const content = clampNum(Math.max(0, val) * (1 - 0.7 * tension) * (1 - 0.4 * Math.max(0, aro - 0.6)), 0, 1);

    this.dLean = val < 0 ? -val * 0.30 : -val * 0.08;
    this.dHunch = tension * 0.5 - clampNum(-val, 0, 1) * 0.15;
    this.dHeadX = val < 0 ? -val * 0.42 : -Math.max(0, val) * 0.18;
    this.dHeadZ = dom * 0.16;

    const col = C.ink.clone();
    if (tension >= content) col.lerp(C.accent, 0.55 * tension);
    else col.lerp(C.good, 0.5 * content);
    this.dColor.copy(col);

    this.dTremor = tension * tension * 0.012;
    this.dBreath = 0.005 + aro * 0.012;
    this.dFade = 1;
  }

  /** NPC/customer: a faint, tasteful demeanour — almost no tint. */
  setPose(demeanor: Demeanor | undefined, patience: number | undefined, state?: Customer['state']): void {
    const p = clampNum(Number.isFinite(patience) ? (patience as number) : 1, 0, 1);
    const restless = 1 - p;
    const edgy = demeanor === 'impatient' || demeanor === 'rude';
    const warm = demeanor === 'warm' || demeanor === 'polite';
    this.dLean = edgy ? 0.08 + restless * 0.12 : warm ? -0.03 : 0.02;
    this.dHunch = edgy ? 0.12 + restless * 0.12 : 0;
    this.dHeadX = edgy ? 0.05 : warm ? -0.05 : 0;
    this.dHeadZ = 0;
    const col = C.ink.clone();
    if (demeanor === 'rude') col.lerp(C.accent, 0.14 + restless * 0.12);
    else if (demeanor === 'warm') col.lerp(C.good, 0.14);
    this.dColor.copy(col);
    this.dTremor = edgy ? restless * 0.004 : 0;
    this.dBreath = 0.006;
    this.dFade = state === 'leaving' || state === 'gone' ? 0 : 1;
  }

  /** Snap kinematics on spawn so a new figure does not lerp in from the origin. */
  place(pos: THREE.Vector3, yaw: number): void {
    this.pos.copy(pos); this.target.copy(pos);
    this.yaw = yaw; this.targetYaw = yaw;
    this.object.position.copy(pos);
    this.object.rotation.y = yaw;
  }

  setDetail(on: boolean): void { this.object.visible = on; }

  // ---------------------------------------------------------------------------
  // integrate + write transforms
  // ---------------------------------------------------------------------------
  tick(dtReal: number): void {
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;
    const k = 1 - Math.exp(-7 * dt);
    const kc = 1 - Math.exp(-3 * dt);

    // body scale (smooth shrink/grow); gait is measured in BODY units so the walk
    // cadence stays natural whether she's full-size outside or 1/8 inside.
    const sc = this.scaleV.toward(this.scaleTarget, 1 - Math.exp(-5 * dt));
    this.object.scale.setScalar(sc);

    // motion: measure speed from displacement toward target, normalised by scale
    const prev = this.pos.clone();
    this.pos.lerp(this.target, k);
    const moved = this.pos.distanceTo(prev);
    const bodySpeed = dt > 0 ? (moved / dt) / Math.max(sc, 0.03) : 0;
    this.speed = bodySpeed;

    // face the direction of travel when moving fast enough, else the target yaw
    if (bodySpeed > 0.4) {
      const dir = this.target.clone().sub(prev);
      if (dir.lengthSq() > 1e-5) this.targetYaw = Math.atan2(dir.x, dir.z);
    }
    let d = (this.targetYaw - this.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * k;

    // articulation smoothing
    const lean = this.leanX.toward(this.dLean, k);
    const hunch = this.hunch.toward(this.dHunch, k);
    const hx = this.headX.toward(this.dHeadX, k);
    const hz = this.headZ.toward(this.dHeadZ, k);
    const tr = this.tremor.toward(this.dTremor, k);
    const bAmp = this.breathAmp.toward(this.dBreath, k);
    const fade = this.fade.toward(this.dFade, 1 - Math.exp(-4 * dt));

    // gait: amplitude tracks speed; phase advances with distance covered
    const targetGaitAmp = clampNum(this.speed * 0.42, 0, 1);
    const gAmp = this.gaitAmp.toward(targetGaitAmp, 1 - Math.exp(-8 * dt));
    this.gait += this.speed * 3.4 * dt + (gAmp > 0.02 ? dt * 2.0 : 0);
    const swing = Math.sin(this.gait) * gAmp;
    const swing2 = Math.sin(this.gait + Math.PI) * gAmp;
    const lift = Math.max(0, Math.cos(this.gait)) * gAmp;
    const lift2 = Math.max(0, Math.cos(this.gait + Math.PI)) * gAmp;

    // colour
    this.ink.color.lerp(this.dColor, kc);

    // breath + tremor oscillators
    const breath = Math.sin(this.clock * 2.2) * bAmp;
    const trX = tr * (Math.sin(this.clock * 33) + 0.5 * Math.sin(this.clock * 51));

    // write root
    this.object.position.set(this.pos.x + trX, this.pos.y, this.pos.z);
    this.object.rotation.y = this.yaw;

    // hips bob with gait/breath
    this.hips.position.y = HIP_Y + breath + gAmp * 0.02 * Math.abs(Math.sin(this.gait * 2));

    // torso lean + hunch
    this.torso.rotation.x = lean + hunch * 0.2;

    // legs: swing at hip, bend at knee on the lifting phase
    this.hipL.rotation.x = swing;
    this.hipR.rotation.x = swing2;
    this.kneeL.rotation.x = lift * 1.1;
    this.kneeR.rotation.x = lift2 * 1.1;

    // arms: counter-swing to the legs; hunch draws them inward
    this.shL.rotation.x = swing2 * 0.8 - hunch * 0.5;
    this.shR.rotation.x = swing * 0.8 - hunch * 0.5;
    this.shL.rotation.z = 0.06 + hunch * 0.35;
    this.shR.rotation.z = -0.06 - hunch * 0.35;
    this.elL.rotation.x = -0.15 - Math.abs(swing2) * 0.4;
    this.elR.rotation.x = -0.15 - Math.abs(swing) * 0.4;

    // head
    this.head.rotation.x = hx + tr * 1.1 * Math.sin(this.clock * 40);
    this.head.rotation.z = hz;

    // fade (leaving figures)
    this.ink.opacity = BASE_OPACITY * fade;
    this.fill.opacity = fade;
    this.fill.transparent = fade < 0.999;
    this.object.visible = this.object.visible && fade > 0.02;
  }

  dispose(): void {
    this.object.traverse((o) => {
      const any = o as unknown as { geometry?: { dispose?: () => void } };
      any.geometry?.dispose?.();
    });
    this.fill.dispose();
    this.ink.dispose();
    this.headFill?.dispose();
  }
}
