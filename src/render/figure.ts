// =============================================================================
// figure.ts — a minimal articulated wireframe humanoid drawn entirely in ink
// lines. One class serves both the cashier and the customers. The point of the
// piece is EMBODIMENT: the cashier's posture, a footprint aura, tint and tremor
// are driven from the soma each frame; customers carry only a faint demeanour.
//
// Rig (local, root at the feet on the floor, figure faces +z by default):
//   root
//   ├─ legs + pelvis            (static)
//   ├─ aura (cashier only)      (footprint ring on the floor)
//   └─ upper  [pivot at hips]   ← leans with valence, bobs with breath
//        ├─ spine · shoulders · apron(cashier)
//        ├─ lArm / rArm [shoulder pivots]  ← hunch with tension
//        └─ head [pivot at neck]           ← nods with valence, cocks w/ dominance
// =============================================================================
import * as THREE from 'three';
import type { SomaState, EmotionReadout, Demeanor, Customer } from '../types';
import { C, lineMaterial, polyline, segments, circleXZ, clampNum } from './palette';

export type FigureRole = 'cashier' | 'customer';

// --- proportions (metres, ~1.75 m tall) -------------------------------------
const HIP_Y = 0.92;
const KNEE_Y = 0.46;
const LEG_DX = 0.13;
const TORSO = 0.52; // hip → shoulder, in upper-local y
const SH_LOCAL_Y = 0.5; // shoulder bar height in upper-local y
const SH_HALF = 0.2; // half shoulder width
const NECK_TOP = 0.6; // head-group pivot, in upper-local y
const HEAD_R = 0.115;
const HEAD_OFFSET = 0.13; // head centre above the neck pivot

const BASE_OPACITY = 0.92;

/** A spring-smoothed scalar that chases a target each tick. */
class Smooth {
  constructor(public v: number) {}
  toward(target: number, k: number): number {
    this.v += (target - this.v) * k;
    return this.v;
  }
}

export class Figure {
  readonly object = new THREE.Group();

  // kinematics (world). Stage writes targets; tick() chases them.
  pos = new THREE.Vector3();
  target = new THREE.Vector3();
  yaw = 0;
  targetYaw = 0;

  private readonly role: FigureRole;
  private upper = new THREE.Group();
  private head = new THREE.Group();
  private lArm = new THREE.Group();
  private rArm = new THREE.Group();

  private body!: THREE.LineBasicMaterial; // all ink line-work for this figure
  private aura?: THREE.LineLoop;
  private auraMat?: THREE.LineBasicMaterial;

  // smoothed articulation state
  private leanX = new Smooth(0);
  private shoulder = new Smooth(0);
  private headTiltX = new Smooth(0);
  private headTiltZ = new Smooth(0);
  private auraR = new Smooth(0.6);
  private auraOp = new Smooth(0);
  private tremor = new Smooth(0);
  private breathRate = new Smooth(1.6);
  private breathAmp = new Smooth(0.006);
  private fade = new Smooth(1);

  // desired (set per frame by embody()/setPose())
  private dLeanX = 0;
  private dShoulder = 0;
  private dHeadX = 0;
  private dHeadZ = 0;
  private dAuraR = 0.6;
  private dAuraOp = 0;
  private dTremor = 0;
  private dBreathRate = 1.6;
  private dBreathAmp = 0.006;
  private dFade = 1;
  private readonly dColor = C.ink.clone();
  private readonly dAuraColor = C.inkSoft.clone();

  private clock = Math.random() * 10; // desync breathing between figures

  constructor(role: FigureRole) {
    this.role = role;
    this.build();
  }

  // ---------------------------------------------------------------------------
  // construction
  // ---------------------------------------------------------------------------
  private build(): void {
    const mat = lineMaterial(C.ink.getHex(), BASE_OPACITY);
    this.body = mat;
    const cashier = this.role === 'cashier';

    // legs + pelvis (static)
    this.object.add(this.leg(-1), this.leg(1));
    this.object.add(segments([-0.06, HIP_Y, 0, 0.06, HIP_Y, 0], mat));

    // upper torso group, pivoting at the hips
    this.upper.position.set(0, HIP_Y, 0);
    this.object.add(this.upper);

    // spine with a faint forward chest curve
    this.upper.add(polyline([0, 0, 0, 0, 0.3, 0.02, 0, TORSO, 0], mat));
    // shoulder bar
    this.upper.add(segments([-SH_HALF, SH_LOCAL_Y, 0, SH_HALF, SH_LOCAL_Y, 0], mat));
    // neck
    this.upper.add(polyline([0, SH_LOCAL_Y, 0, 0, NECK_TOP, 0], mat));
    if (cashier) this.upper.add(this.apron(mat));

    // arms
    this.lArm.position.set(-SH_HALF, SH_LOCAL_Y, 0);
    this.rArm.position.set(SH_HALF, SH_LOCAL_Y, 0);
    this.lArm.add(this.arm(-1, cashier));
    this.rArm.add(this.arm(1, cashier));
    this.upper.add(this.lArm, this.rArm);

    // head (pivot at neck top)
    this.head.position.set(0, NECK_TOP, 0);
    const headGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(HEAD_R, 0), 1);
    const headMesh = new THREE.LineSegments(headGeo, mat);
    headMesh.position.set(0, HEAD_OFFSET, 0);
    this.head.add(headMesh);
    // a short gaze tick forward — reads the direction the figure attends to
    this.head.add(
      segments([0, HEAD_OFFSET, HEAD_R * 0.6, 0, HEAD_OFFSET - 0.01, HEAD_R + 0.09], mat),
    );
    this.upper.add(this.head);

    // cashier footprint aura ring (the arousal read-out)
    if (cashier) {
      this.auraMat = lineMaterial(C.inkSoft.getHex(), 0);
      this.aura = circleXZ(1, 56, this.auraMat);
      this.aura.position.y = 0.015;
      this.object.add(this.aura);
    }
  }

  private leg(side: number): THREE.Line {
    const x = side * LEG_DX;
    return polyline(
      [x, 0, 0.02, x * 0.85, KNEE_Y, 0.015, side * 0.05, HIP_Y, 0],
      this.body,
    );
  }

  private apron(mat: THREE.LineBasicMaterial): THREE.LineLoop {
    // a slim trapezoid on the chest/belly front — marks the one who serves
    const z = 0.035;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-0.11, 0.36, z, 0.11, 0.36, z, 0.15, 0.04, z, -0.15, 0.04, z],
        3,
      ),
    );
    return new THREE.LineLoop(g, mat);
  }

  private arm(side: number, cashier: boolean): THREE.Line {
    // shoulder-local: hangs from (0,0,0). Cashier rests hands forward over the
    // counter; customers let arms fall to the side.
    const pts = cashier
      ? [0, 0, 0, side * 0.03, -0.22, 0.06, side * 0.01, -0.3, 0.3]
      : [0, 0, 0, side * 0.05, -0.24, 0.0, side * 0.07, -0.46, 0.05];
    return polyline(pts, this.body);
  }

  // ---------------------------------------------------------------------------
  // per-frame intent
  // ---------------------------------------------------------------------------

  /** Cashier: translate soma + readout into posture, tint, aura, tremor. */
  embody(soma?: Partial<SomaState>, readout?: Partial<EmotionReadout>): void {
    const val = clampNum(readout?.valence ?? soma?.valence ?? 0, -1, 1);
    const aro = clampNum(readout?.arousal ?? soma?.arousal ?? 0.45, 0, 1);
    const dom = clampNum(readout?.dominance ?? soma?.dominance ?? 0, -1, 1);
    const amyg = clampNum(soma?.amygdala ?? 0, 0, 1);
    const cort = Number.isFinite(soma?.cortisol) ? (soma!.cortisol as number) : 1;
    const stress = clampNum(cort - 1, 0, 1.5) / 1.5; // baseline 1 → 0; ~2.5 → 1

    // physiological threat (drives oxblood + tremor) vs. settled contentment (green)
    const tension = clampNum(0.55 * amyg + 0.5 * stress + 0.2 * Math.max(0, aro - 0.5), 0, 1);
    const content = clampNum(
      Math.max(0, val) * (1 - 0.7 * tension) * (1 - 0.4 * Math.max(0, aro - 0.6)),
      0,
      1,
    );

    // posture: slump forward when valence is low, open slightly when high
    this.dLeanX = val < 0 ? -val * 0.34 : -val * 0.1;
    this.dShoulder = tension * 0.3 - clampNum(-val, 0, 1) * 0.12;
    this.dHeadX = val < 0 ? -val * 0.42 : -Math.max(0, val) * 0.18; // look down / lift
    this.dHeadZ = dom * 0.16; // a slight cock of the head with felt control

    // aura footprint tracks arousal
    this.dAuraR = 0.45 + aro * 0.95;
    this.dAuraOp = clampNum(0.08 + aro * 0.22, 0, 0.32);

    // tint — restrained: never fully saturates to red/green
    const col = C.ink.clone();
    const acol = C.inkSoft.clone();
    if (tension >= content) {
      col.lerp(C.accent, 0.55 * tension);
      acol.lerp(C.accent, 0.7 * tension);
    } else {
      col.lerp(C.good, 0.5 * content);
      acol.lerp(C.good, 0.6 * content);
    }
    this.dColor.copy(col);
    this.dAuraColor.copy(acol);

    // tremor + breathing
    this.dTremor = tension * tension * 0.01;
    this.dBreathRate = 1.4 + aro * 3.2;
    this.dBreathAmp = 0.004 + aro * 0.01;
    this.dFade = 1;
  }

  /** Customers: a faint, tasteful demeanour — no aura, almost no tint. */
  setPose(demeanor: Demeanor | undefined, patience: number | undefined, state: Customer['state']): void {
    const p = clampNum(Number.isFinite(patience) ? (patience as number) : 1, 0, 1);
    const restless = 1 - p;
    const edgy = demeanor === 'impatient' || demeanor === 'rude';
    const warm = demeanor === 'warm' || demeanor === 'polite';

    this.dLeanX = edgy ? 0.1 + restless * 0.14 : warm ? -0.04 : 0.02;
    this.dShoulder = edgy ? 0.08 + restless * 0.1 : 0;
    this.dHeadX = edgy ? 0.06 : warm ? -0.06 : 0;
    this.dHeadZ = 0;

    const col = C.ink.clone();
    if (demeanor === 'rude') col.lerp(C.accent, 0.14 + restless * 0.12);
    else if (demeanor === 'warm') col.lerp(C.good, 0.16);
    this.dColor.copy(col);

    this.dTremor = edgy ? restless * 0.004 : 0;
    this.dBreathRate = 1.6 + restless * 1.2;
    this.dBreathAmp = 0.006;
    this.dAuraR = 0.6;
    this.dAuraOp = 0;
    this.dFade = state === 'leaving' || state === 'gone' ? 0 : 1;
  }

  /** Snap kinematics on spawn so a new figure does not lerp in from the origin. */
  place(pos: THREE.Vector3, yaw: number): void {
    this.pos.copy(pos);
    this.target.copy(pos);
    this.yaw = yaw;
    this.targetYaw = yaw;
    this.object.position.copy(pos);
    this.object.rotation.y = yaw;
  }

  // ---------------------------------------------------------------------------
  // integrate + write transforms
  // ---------------------------------------------------------------------------
  tick(dtReal: number): void {
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;
    const k = 1 - Math.exp(-6 * dt); // motion smoothing
    const kc = 1 - Math.exp(-3 * dt); // colour smoothing (slower)

    // position + facing
    this.pos.lerp(this.target, k);
    let d = (this.targetYaw - this.yaw) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * k;

    // articulation
    const lean = this.leanX.toward(this.dLeanX, k);
    const sh = this.shoulder.toward(this.dShoulder, k);
    const hx = this.headTiltX.toward(this.dHeadX, k);
    const hz = this.headTiltZ.toward(this.dHeadZ, k);
    const aR = this.auraR.toward(this.dAuraR, k);
    const aOp = this.auraOp.toward(this.dAuraOp, k);
    const tr = this.tremor.toward(this.dTremor, k);
    const bRate = this.breathRate.toward(this.dBreathRate, k);
    const bAmp = this.breathAmp.toward(this.dBreathAmp, k);
    const fade = this.fade.toward(this.dFade, 1 - Math.exp(-4 * dt));

    // colour
    this.body.color.lerp(this.dColor, kc);
    if (this.auraMat) this.auraMat.color.lerp(this.dAuraColor, kc);

    // oscillators
    const breath = Math.sin(this.clock * bRate) * bAmp;
    const trX = tr * (Math.sin(this.clock * 34) + 0.5 * Math.sin(this.clock * 51.3));
    const trY = tr * 0.5 * Math.sin(this.clock * 47);

    // write transforms
    this.object.position.set(this.pos.x + trX, this.pos.y, this.pos.z);
    this.object.rotation.y = this.yaw;

    this.upper.rotation.x = lean;
    this.upper.position.y = HIP_Y + breath + trY;

    // shoulder hunch: lift + draw the arms inward under tension
    this.lArm.position.y = SH_LOCAL_Y + sh * 0.04;
    this.rArm.position.y = SH_LOCAL_Y + sh * 0.04;
    this.lArm.rotation.x = -sh * 0.6;
    this.rArm.rotation.x = -sh * 0.6;
    this.lArm.rotation.z = sh * 0.4;
    this.rArm.rotation.z = -sh * 0.4;

    this.head.rotation.x = hx + tr * 1.2 * Math.sin(this.clock * 40);
    this.head.rotation.z = hz;

    // opacity + aura
    this.body.opacity = BASE_OPACITY * fade;
    if (this.aura && this.auraMat) {
      this.aura.scale.set(aR, 1, aR);
      this.auraMat.opacity = aOp * fade;
      this.aura.visible = aOp * fade > 0.012;
    }
  }
}
