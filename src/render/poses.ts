// =============================================================================
// poses.ts — activity pose library for the Humanoid rig.
//
// These joint-keyframe specs were authored by a 5-way parallel design workflow
// (one agent per activity family), each reasoning against the documented rig:
//   root at the feet · faces +z · hips pivot at y=0.90 · limbs hang downward.
// Every field is a target Euler angle in RADIANS (0 = neutral standing), except
// bodyTiltX (tips the whole torso+legs assembly about the hip x-axis, for lying),
// rootDY (metres, lower/raise the root onto a seat/bed) and rootForward (metres,
// nudge along facing). The Humanoid eases toward the active frame and, for looped
// activities, ping-pongs / cycles through the frames on a per-activity clock.
// =============================================================================

export interface PoseFrame {
  bodyTiltX?: number; rootDY?: number; rootForward?: number;
  torsoX?: number; torsoZ?: number; headX?: number; headZ?: number;
  hipLX?: number; hipRX?: number; kneeLX?: number; kneeRX?: number;
  shLX?: number; shRX?: number; shLZ?: number; shRZ?: number;
  elLX?: number; elRX?: number;
}

export type PoseLoop = 'none' | 'pingpong' | 'cycle';

export interface Pose {
  frames: PoseFrame[];
  loop: PoseLoop;
  loopSeconds: number;   // 0 for static
  prop: 'phone' | 'none';
}

/** All joint keys a frame can carry (used by the blender to zero-fill omitted joints). */
export const POSE_JOINTS: (keyof PoseFrame)[] = [
  'bodyTiltX', 'rootDY', 'rootForward',
  'torsoX', 'torsoZ', 'headX', 'headZ',
  'hipLX', 'hipRX', 'kneeLX', 'kneeRX',
  'shLX', 'shRX', 'shLZ', 'shRZ', 'elLX', 'elRX',
];

// ---- activity identifiers the sim/nav uses -------------------------------
export type ActivityKind =
  | 'stand' | 'walk'
  | 'sleep' | 'couch_tv' | 'couch_phone'
  | 'toilet_pee' | 'toilet_defecate' | 'shower'
  | 'sit_desk' | 'talk' | 'mop' | 'sit_rest'
  | 'phone_stand' | 'phone_desk' | 'phone_bed'
  | 'door' | 'stairs';

// ---------------------------------------------------------------------------
// The baked pose library (verbatim from the design workflow, lightly organised).
// ---------------------------------------------------------------------------
export const POSES: Record<Exclude<ActivityKind, 'stand' | 'walk' | 'door' | 'stairs'>, Pose> = {
  // — sleeping supine, slow breathing —
  sleep: {
    loop: 'pingpong', loopSeconds: 5, prop: 'none',
    frames: [
      { bodyTiltX: -1.5708, rootDY: -0.30, torsoX: 0.03, headX: 0.22, headZ: 0.08,
        hipLX: 0.04, hipRX: 0.06, kneeLX: -0.08, kneeRX: -0.12,
        shLX: 0.02, shLZ: 0.10, elLX: -0.10, shRX: 0.05, shRZ: -0.08, elRX: -1.35 },
      { bodyTiltX: -1.5708, rootDY: -0.30, torsoX: -0.02, headX: 0.20, headZ: 0.08,
        hipLX: 0.04, hipRX: 0.06, kneeLX: -0.08, kneeRX: -0.12,
        shLX: 0.02, shLZ: 0.12, elLX: -0.10, shRX: 0.05, shRZ: -0.10, elRX: -1.30 },
    ],
  },

  // — seated, watching TV (head level, no phone) —
  couch_tv: {
    loop: 'none', loopSeconds: 0, prop: 'none',
    frames: [
      { rootDY: -0.45, rootForward: 0.10, torsoX: 0.05, headX: 0.0,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.30, shRX: 0.30, shLZ: 0.08, shRZ: -0.08, elLX: -0.40, elRX: -0.40 },
    ],
  },

  // — seated, using phone (head dropped, forearms up, phone prop, subtle scroll) —
  couch_phone: {
    loop: 'pingpong', loopSeconds: 3.5, prop: 'phone',
    frames: [
      { rootDY: -0.45, rootForward: 0.10, torsoX: 0.08, headX: 0.45,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.70, shRX: 0.70, shLZ: 0.18, shRZ: -0.18, elLX: -1.60, elRX: -1.60 },
      { rootDY: -0.45, rootForward: 0.10, torsoX: 0.10, headX: 0.52, headZ: 0.04,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.72, shRX: 0.72, shLZ: 0.19, shRZ: -0.19, elLX: -1.68, elRX: -1.68 },
    ],
  },

  // — seated on the toilet (defecate) —
  toilet_defecate: {
    loop: 'none', loopSeconds: 0, prop: 'none',
    frames: [
      { rootDY: -0.48, rootForward: 0.02, torsoX: 0.35, headX: 0.30,
        hipLX: 1.50, hipRX: 1.50, kneeLX: -1.50, kneeRX: -1.50,
        shLX: 0.35, shRX: 0.35, shLZ: 0.12, shRZ: -0.12, elLX: -1.05, elRX: -1.05 },
    ],
  },

  // — standing at the toilet (pee) —
  toilet_pee: {
    loop: 'none', loopSeconds: 0, prop: 'none',
    frames: [
      { torsoX: 0.15, headX: 0.30,
        shLX: 0.20, shRX: 0.20, shLZ: 0.05, shRZ: -0.05, elLX: -0.55, elRX: -0.55 },
    ],
  },

  // — showering: hands to scalp, alternating scrub + weight-shift sway —
  shower: {
    loop: 'pingpong', loopSeconds: 2.5, prop: 'none',
    frames: [
      { torsoX: 0.05, headX: -0.10, rootDY: -0.05, hipLX: 0.15, hipRX: 0.15, kneeLX: -0.30, kneeRX: -0.30,
        shLX: 1.35, shLZ: 0.45, elLX: -1.90, shRX: 1.35, shRZ: -0.45, elRX: -1.90 },
      { torsoX: 0.05, torsoZ: 0.13, headX: -0.05, headZ: -0.08, rootDY: -0.05,
        hipLX: 0.18, hipRX: 0.12, kneeLX: -0.34, kneeRX: -0.26,
        shLX: 1.55, shLZ: 0.55, elLX: -2.05, shRX: 1.05, shRZ: -0.30, elRX: -1.60 },
      { torsoX: 0.05, torsoZ: -0.13, headX: -0.05, headZ: 0.08, rootDY: -0.05,
        hipLX: 0.12, hipRX: 0.18, kneeLX: -0.26, kneeRX: -0.34,
        shLX: 1.05, shLZ: 0.30, elLX: -1.60, shRX: 1.55, shRZ: -0.55, elRX: -2.05 },
    ],
  },

  // — seated at a desk, typing (hands on the keyboard, subtle finger/forearm work) —
  sit_desk: {
    loop: 'pingpong', loopSeconds: 2.2, prop: 'none',
    frames: [
      { rootDY: -0.45, rootForward: 0.06, torsoX: 0.12, headX: 0.14,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.55, shRX: 0.55, shLZ: 0.10, shRZ: -0.10, elLX: -1.10, elRX: -1.10 },
      { rootDY: -0.45, rootForward: 0.06, torsoX: 0.12, headX: 0.17,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.55, shRX: 0.55, shLZ: 0.10, shRZ: -0.10, elLX: -1.18, elRX: -1.02 },
    ],
  },

  // — standing, conversing: alternating hand gestures + gentle sway/head-bob —
  talk: {
    loop: 'pingpong', loopSeconds: 2.8, prop: 'none',
    frames: [
      { torsoX: 0.02, torsoZ: 0.04, headX: 0.05, headZ: 0.06,
        shLX: 0.65, shLZ: 0.20, elLX: -1.05, shRX: 0.40, shRZ: -0.12, elRX: -0.75 },
      { torsoX: 0.04, torsoZ: 0.0, headX: 0.02, headZ: 0.0,
        shLX: 0.45, shLZ: 0.12, elLX: -0.80, shRX: 0.45, shRZ: -0.12, elRX: -0.80 },
      { torsoX: 0.02, torsoZ: -0.04, headX: 0.05, headZ: -0.06,
        shLX: 0.40, shLZ: 0.12, elLX: -0.75, shRX: 0.65, shRZ: -0.20, elRX: -1.05 },
    ],
  },

  // — standing, mopping: both hands on the handle, push-forward / pull-back sway —
  mop: {
    loop: 'pingpong', loopSeconds: 2.0, prop: 'none',
    frames: [
      { rootForward: 0.06, torsoX: 0.34, headX: 0.20,
        hipLX: 0.10, hipRX: 0.10, kneeLX: -0.14, kneeRX: -0.14,
        shLX: 0.90, shLZ: 0.10, elLX: -0.55, shRX: 0.90, shRZ: -0.10, elRX: -0.55 },
      { rootForward: -0.04, torsoX: 0.20, headX: 0.12,
        hipLX: 0.02, hipRX: 0.02, kneeLX: -0.08, kneeRX: -0.08,
        shLX: 0.60, shLZ: 0.10, elLX: -0.90, shRX: 0.60, shRZ: -0.10, elRX: -0.90 },
    ],
  },

  // — standing, on the phone: head dropped, both forearms up cradling the screen —
  phone_stand: {
    loop: 'pingpong', loopSeconds: 3.5, prop: 'phone',
    frames: [
      { torsoX: 0.10, headX: 0.46,
        shLX: 0.72, shRX: 0.72, shLZ: 0.20, shRZ: -0.20, elLX: -1.60, elRX: -1.60 },
      { torsoX: 0.12, headX: 0.52, headZ: 0.03,
        shLX: 0.74, shRX: 0.74, shLZ: 0.21, shRZ: -0.21, elLX: -1.66, elRX: -1.66 },
    ],
  },

  // — seated at a desk, on the phone: same seat as sit_desk, screen up, head down —
  phone_desk: {
    loop: 'pingpong', loopSeconds: 3.5, prop: 'phone',
    frames: [
      { rootDY: -0.45, rootForward: 0.06, torsoX: 0.14, headX: 0.44,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.70, shRX: 0.70, shLZ: 0.18, shRZ: -0.18, elLX: -1.62, elRX: -1.62 },
      { rootDY: -0.45, rootForward: 0.06, torsoX: 0.16, headX: 0.50, headZ: 0.03,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.72, shRX: 0.72, shLZ: 0.19, shRZ: -0.19, elLX: -1.68, elRX: -1.68 },
    ],
  },

  // — lying in bed on the phone: supine like sleep, but shoulders raised so the
  //   screen rides above the face (the classic late-night scroll that delays sleep) —
  phone_bed: {
    loop: 'pingpong', loopSeconds: 4, prop: 'phone',
    frames: [
      { bodyTiltX: -1.5708, rootDY: -0.30, torsoX: 0.05, headX: 0.30, headZ: 0.05,
        hipLX: 0.04, hipRX: 0.06, kneeLX: -0.08, kneeRX: -0.12,
        shLX: 1.20, shLZ: 0.16, elLX: -1.55, shRX: 1.20, shRZ: -0.16, elRX: -1.55 },
      { bodyTiltX: -1.5708, rootDY: -0.30, torsoX: 0.03, headX: 0.28, headZ: 0.05,
        hipLX: 0.04, hipRX: 0.06, kneeLX: -0.08, kneeRX: -0.12,
        shLX: 1.24, shLZ: 0.17, elLX: -1.60, shRX: 1.24, shRZ: -0.17, elRX: -1.60 },
    ],
  },

  // — seated, tired: slumped forward, head dropped, arms resting on thighs —
  sit_rest: {
    loop: 'pingpong', loopSeconds: 4, prop: 'none',
    frames: [
      { rootDY: -0.45, rootForward: 0.08, torsoX: 0.25, headX: 0.40,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.15, shRX: 0.15, shLZ: 0.06, shRZ: -0.06, elLX: -0.70, elRX: -0.70 },
      { rootDY: -0.45, rootForward: 0.08, torsoX: 0.27, headX: 0.44,
        hipLX: 1.57, hipRX: 1.57, kneeLX: -1.57, kneeRX: -1.57,
        shLX: 0.13, shRX: 0.13, shLZ: 0.06, shRZ: -0.06, elLX: -0.68, elRX: -0.68 },
    ],
  },
};

// — door interaction: reach the handle, then retract (played reach→retract as
//   the leaf swings; near arm is the right arm) —
export const DOOR_REACH: PoseFrame = {
  torsoX: 0.10, torsoZ: 0.12, headX: 0.15, headZ: -0.10,
  shRX: 1.20, shRZ: -0.05, elRX: -0.50, shLX: 0.0, elLX: -0.15,
};
export const DOOR_RETRACT: PoseFrame = {
  torsoX: 0.0, headX: 0.0, shRX: 0.05, shRZ: 0.0, elRX: -0.15, shLX: 0.0, elLX: -0.15,
};

// — stair climb: two-frame cycle (leading leg high-knee lift + counter-swing) —
export const STAIR_FRAMES: [PoseFrame, PoseFrame] = [
  { torsoX: 0.20, hipLX: 0.90, kneeLX: -1.10, hipRX: -0.15, kneeRX: -0.10,
    shRX: 0.60, elRX: -0.50, shLX: -0.40, elLX: -0.30, headX: 0.0 },
  { torsoX: 0.20, hipRX: 0.90, kneeRX: -1.10, hipLX: -0.15, kneeLX: -0.10,
    shLX: 0.60, elLX: -0.50, shRX: -0.40, elRX: -0.30, headX: 0.0 },
];
export const STAIR_SECONDS = 0.9;

// ---------------------------------------------------------------------------
// pose maths — blend two frames, and sample a looped pose at time t.
// ---------------------------------------------------------------------------
export function blendFrame(a: PoseFrame, b: PoseFrame, u: number): PoseFrame {
  const out: PoseFrame = {};
  for (const k of POSE_JOINTS) out[k] = (a[k] ?? 0) * (1 - u) + (b[k] ?? 0) * u;
  return out;
}

export function samplePose(pose: Pose, t: number): PoseFrame {
  const n = pose.frames.length;
  if (n === 1 || pose.loop === 'none' || pose.loopSeconds <= 0) return pose.frames[0];
  const dur = pose.loopSeconds;
  if (pose.loop === 'pingpong') {
    const segs = 2 * (n - 1);                       // 0→…→n-1→…→1
    const phase = ((((t / dur) % 1) + 1) % 1) * segs;
    const i = Math.floor(phase), u = phase - i;
    const reflect = (idx: number) => (idx < n ? idx : segs - idx);
    return blendFrame(pose.frames[reflect(i % segs)], pose.frames[reflect((i + 1) % segs)], u);
  }
  const phase = ((((t / dur) % 1) + 1) % 1) * n;    // cycle 0→…→n-1→0
  const i = Math.floor(phase), u = phase - i;
  return blendFrame(pose.frames[i % n], pose.frames[(i + 1) % n], u);
}

/** triangle wave 0→1→0 over period 1 (for the two-frame stair cycle). */
export function triWave(t: number): number {
  const x = (((t % 1) + 1) % 1);
  return x < 0.5 ? x * 2 : 2 - x * 2;
}
