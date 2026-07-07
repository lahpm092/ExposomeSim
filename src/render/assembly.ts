// =============================================================================
// assembly.ts — the POLIS made visible. When the gov view carries a live
// assembly (the movement crossed its percolation threshold and called one),
// the borrowed venue — the park or the food court plaza; there is no city
// hall until the government builds one — gets a small dais prop and a
// BankCrowd-style gathering facing it. The crowd is pure set dressing for the
// shadow attendance the opinion field already computes; the main characters
// who decide to attend walk over with their OWN bodies (decidePlace's
// assembly pull), so nothing here double-counts anyone.
//
// Same discipline as every ambient layer: the dais mounts for the assembly
// window only; bodies spawn only while the camera is near (or forceHot for
// captures) and are pooled/reused; deterministic hash placement, no RNG.
// =============================================================================
import * as THREE from 'three';
import type { TownSnapshot } from '../core/types';
import { PLACES } from '../world/places';
import { Humanoid } from './humanoid';
import { hash01 } from './palette';
import { CITY, type CityMats } from './worldgeo';

const NEAR = 55;            // camera radius inside which the gathering spawns
const HYST = 10;
const SWEEP_PERIOD = 0.25;  // 4 Hz near-set sweep
const CROWD = 9;            // set-dressing bodies (shadow attendance, not roster)
const DT_MIN = 0.006, DT_MAX = 0.05;
const EARLY_H = 0.5;        // the dais goes up half a sim-hour before start

type GovLike = NonNullable<TownSnapshot['gov']>;

/** venue id ('park' | 'foodcourt') → world metres. Mirrors town's CIVIC_VENUES. */
function venueXZ(place: string): { x: number; z: number } {
  const p = place === 'foodcourt' ? PLACES.work.pos2D : PLACES.park.pos2D;
  return { x: (p.x - 0.5) * CITY, z: (p.y - 0.5) * CITY };
}

export class CivicAssembly {
  /** dev/capture: spawn the gathering regardless of camera distance. */
  forceHot = false;

  private dais: THREE.Group | null = null;
  private daisKey = '';               // venue the mounted dais belongs to
  private figs: Humanoid[] = [];
  private live = 0;
  private cooldown = 0;
  private cx = 0; private cz = 0;     // dais world position
  private yaw = 0;
  private readonly _p = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private mats: CityMats) {}

  update(gov: GovLike | undefined, clock: number, camPos: THREE.Vector3, dtReal: number): void {
    const dt = dtReal > 0 ? Math.min(Math.max(dtReal, DT_MIN), DT_MAX) : 0;
    try {
      const asm = gov?.assembly ?? null;
      const on = !!asm && clock >= asm.startH - EARLY_H && clock <= asm.endH;
      this.cooldown -= dtReal;
      if (this.cooldown <= 0) {
        this.cooldown = SWEEP_PERIOD;
        if (on && asm) {
          if (!this.dais || this.daisKey !== asm.place) this.mountDais(asm.place);
          const near = this.forceHot
            || Math.hypot(camPos.x - this.cx, camPos.z - this.cz) < NEAR + (this.live > 0 ? HYST : 0);
          this.setCrowd(near ? CROWD : 0);
        } else if (this.dais || this.live > 0) {
          this.unmount();
        }
      }
      for (let i = 0; i < this.live; i++) this.figs[i].tick(dt);
    } catch { /* cosmetic layer: never break the render loop */ }
  }

  dispose(): void {
    this.unmount();
    for (const f of this.figs) f.dispose();
    this.figs.length = 0;
  }

  // ---------------------------------------------------------------------------
  private mountDais(place: string): void {
    this.unmount();
    const v = venueXZ(place);
    // stand the dais a few paces toward open ground (the town-centre side),
    // facing back at the venue where the crowd gathers.
    const d = Math.hypot(v.x, v.z) || 1;
    const ux = -v.x / d, uz = -v.z / d;
    this.cx = v.x + ux * 6.5;
    this.cz = v.z + uz * 6.5;
    this.yaw = Math.atan2(ux, uz);
    this.dais = buildDais(this.mats);
    this.dais.position.set(this.cx, 0, this.cz);
    this.dais.rotation.y = this.yaw;
    this.scene.add(this.dais);
    this.daisKey = place;
  }

  private unmount(): void {
    if (this.dais) {
      this.scene.remove(this.dais);
      this.dais.traverse((o) => {
        (o as unknown as { geometry?: { dispose?: () => void } }).geometry?.dispose?.();
      });
      this.dais = null;
      this.daisKey = '';
    }
    this.setCrowd(0);
  }

  /** grow/shrink the pooled gathering, fanned out in front of the dais. */
  private setCrowd(n: number): void {
    if (n === this.live) return;
    while (this.figs.length < n) {
      const h = new Humanoid('npc');
      const s = hash01('asm:' + this.figs.length);
      h.setPose(s < 0.4 ? 'polite' : 'neutral', 1 - s * 0.35);
      this.figs.push(h);
    }
    for (let i = this.live; i < n; i++) {
      const h = this.figs[i];
      const s1 = hash01(`asm:${i}:a`), s2 = hash01(`asm:${i}:r`);
      // a loose arc facing the dais, ahead of it (the side it faces).
      const ang = this.yaw + (s1 - 0.5) * 1.9;
      const r = 2.6 + s2 * 3.4 + (i % 3) * 0.7;
      this._p.set(this.cx + Math.sin(ang) * r, 0, this.cz + Math.cos(ang) * r);
      h.place(this._p, Math.atan2(this.cx - this._p.x, this.cz - this._p.z));
      h.snapScale(1);
      h.setActivity('stand');
      h.target.copy(this._p);
      this.scene.add(h.object);
    }
    for (let i = n; i < this.live; i++) this.scene.remove(this.figs[i].object);
    this.live = n;
  }
}

// ---------------------------------------------------------------------------
// the dais prop: a low platform, a lectern, and a banner between two poles.
// ---------------------------------------------------------------------------
function buildDais(mats: CityMats): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BoxGeometry, edge = mats.ink): void => {
    g.add(new THREE.Mesh(geo, mats.fill));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edge));
  };
  const plat = new THREE.BoxGeometry(3.2, 0.34, 2.2);
  plat.translate(0, 0.17, 0);
  add(plat);
  const step = new THREE.BoxGeometry(1.0, 0.17, 0.5);
  step.translate(0, 0.085, 1.35);
  add(step, mats.soft);
  const lect = new THREE.BoxGeometry(0.5, 0.95, 0.36);
  lect.translate(0, 0.34 + 0.475, 0.55);
  add(lect);
  const board = new THREE.BoxGeometry(0.56, 0.06, 0.44);
  board.translate(0, 1.66, 0.52);
  add(board, mats.soft);
  for (const x of [-1.5, 1.5]) {
    const pole = new THREE.BoxGeometry(0.09, 2.9, 0.09);
    pole.translate(x, 1.45, -0.95);
    add(pole, mats.soft);
  }
  // the banner cloth: a soft-line rectangle with a slack bottom edge.
  const banner = new THREE.BufferGeometry();
  banner.setAttribute('position', new THREE.Float32BufferAttribute([
    -1.5, 2.75, -0.95, 1.5, 2.75, -0.95,
    -1.5, 2.15, -0.95, -0.5, 2.05, -0.95,
    -0.5, 2.05, -0.95, 0.5, 2.05, -0.95,
    0.5, 2.05, -0.95, 1.5, 2.15, -0.95,
    -1.5, 2.75, -0.95, -1.5, 2.15, -0.95,
    1.5, 2.75, -0.95, 1.5, 2.15, -0.95,
  ], 3));
  g.add(new THREE.LineSegments(banner, mats.soft));
  return g;
}
