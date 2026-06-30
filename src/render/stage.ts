// =============================================================================
// stage.ts — the three.js stage: a minimalist burger counter drawn as black
// edge/line-work on a sepia ground. The cashier stands behind the counter and
// EMBODIES the soma each frame; customers approach from +z and queue.
//
// The renderer owns no animation loop and adds no window listeners: the host
// calls update(snap, dtReal) every frame and resize() on layout change. The
// whole update path is defended so a missing/empty snapshot never throws.
//
//   world axes:  +x → stage right · +y → up · +z → toward the camera/door
//   the cashier faces +z (toward the queue); customers face −z (the counter).
// =============================================================================
import * as THREE from 'three';
import type { WorldSnapshot, Customer } from '../types';
import {
  PALETTE,
  lineMaterial,
  boxEdges,
  segments,
  circleXZ,
  disposeObject,
  hash01,
  clampNum,
} from './palette';
import { Figure } from './figure';

// --- layout constants (metres) ----------------------------------------------
const COUNTER_HALF_X = 2.4;
const COUNTER_Z0 = 0.3; // back edge of counter
const COUNTER_Z1 = 1.0; // front edge of counter (faces queue)
const COUNTER_TOP = 1.05;
const REGISTER_X = 1.1;
const REGISTER_Z = 0.6;
const CASHIER_Z = -0.4;
const MENU_Z = -1.85;
const WALL_Z = -1.98;
const ORDER_Z = 1.7; // where the front customer stands
const QUEUE_GAP = 1.12; // spacing between waiting customers
const FLOOR_X = 6;
const FLOOR_Z0 = -2;
const FLOOR_Z1 = 9;

export class Stage {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly camTarget = new THREE.Vector3(0, 1.0, 0.3);

  private readonly cashier: Figure;
  private readonly customers = new Map<string, Figure>();

  // materials shared by the static set (disposed explicitly on dispose()).
  private readonly matInk = lineMaterial(PALETTE.ink, 0.82);
  private readonly matSoft = lineMaterial(PALETTE.inkSoft, 0.7);
  private readonly matFaint = lineMaterial(PALETTE.ink, 0.16);

  private clock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(PALETTE.paper, 1);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

    this.buildRoom();

    this.cashier = new Figure('cashier');
    this.cashier.place(new THREE.Vector3(0, 0, CASHIER_Z), 0); // faces +z
    this.scene.add(this.cashier.object);

    this.resize();
  }

  // ---------------------------------------------------------------------------
  // static set: floor, counter, registers, menu board, seating
  // ---------------------------------------------------------------------------
  private buildRoom(): void {
    // floor grid (faint ink) + a slightly stronger plate border
    const grid: number[] = [];
    for (let x = -FLOOR_X; x <= FLOOR_X; x++) grid.push(x, 0, FLOOR_Z0, x, 0, FLOOR_Z1);
    for (let z = FLOOR_Z0; z <= FLOOR_Z1; z++) grid.push(-FLOOR_X, 0, z, FLOOR_X, 0, z);
    this.scene.add(segments(grid, this.matFaint));
    this.scene.add(
      segments(
        [
          -FLOOR_X, 0, FLOOR_Z0, FLOOR_X, 0, FLOOR_Z0,
          FLOOR_X, 0, FLOOR_Z0, FLOOR_X, 0, FLOOR_Z1,
          FLOOR_X, 0, FLOOR_Z1, -FLOOR_X, 0, FLOOR_Z1,
          -FLOOR_X, 0, FLOOR_Z1, -FLOOR_X, 0, FLOOR_Z0,
        ],
        this.matSoft,
      ),
    );

    // counter — a long box, top rail emphasised
    const counter = boxEdges(COUNTER_HALF_X * 2, COUNTER_TOP, COUNTER_Z1 - COUNTER_Z0, this.matInk);
    counter.position.set(0, COUNTER_TOP / 2, (COUNTER_Z0 + COUNTER_Z1) / 2);
    this.scene.add(counter);
    // a faint shelf line along the counter front
    this.scene.add(
      segments(
        [-COUNTER_HALF_X, COUNTER_TOP * 0.45, COUNTER_Z1, COUNTER_HALF_X, COUNTER_TOP * 0.45, COUNTER_Z1],
        this.matFaint,
      ),
    );

    // two registers on the counter top
    this.scene.add(this.register(-REGISTER_X));
    this.scene.add(this.register(REGISTER_X));

    // back wall frame + menu board
    this.scene.add(this.backWall());
    this.scene.add(this.menuBoard());

    // a little sparse seating to stage right
    this.scene.add(this.table(3.7, 1.6));
    this.scene.add(this.table(4.5, 4.2));
  }

  private register(x: number): THREE.Group {
    const g = new THREE.Group();
    const base = boxEdges(0.5, 0.26, 0.4, this.matInk);
    base.position.set(x, COUNTER_TOP + 0.13, REGISTER_Z);
    g.add(base);
    // the screen, tilted back toward the cashier
    const screen = boxEdges(0.42, 0.3, 0.03, this.matSoft);
    screen.position.set(x, COUNTER_TOP + 0.42, REGISTER_Z + 0.02);
    screen.rotation.x = -0.5;
    g.add(screen);
    return g;
  }

  private backWall(): THREE.Group {
    const g = new THREE.Group();
    const top = 3.0;
    const hx = 3.4;
    g.add(
      segments(
        [
          -hx, 0, WALL_Z, -hx, top, WALL_Z,
          hx, 0, WALL_Z, hx, top, WALL_Z,
          -hx, top, WALL_Z, hx, top, WALL_Z,
          // two faint mullions
          -1.3, 0, WALL_Z, -1.3, top, WALL_Z,
          1.3, 0, WALL_Z, 1.3, top, WALL_Z,
        ],
        this.matFaint,
      ),
    );
    return g;
  }

  private menuBoard(): THREE.Group {
    const g = new THREE.Group();
    g.position.set(0, 2.2, MENU_Z);
    const hw = 2.0;
    const hh = 0.5;
    // panel frame
    g.add(boxEdges(hw * 2, hh * 2, 0.03, this.matInk));
    // columns, header rule, and a few item/price ticks per column
    const rule: number[] = [];
    rule.push(-hw, hh * 0.5, 0.02, hw, hh * 0.5, 0.02); // header rule
    const cols = [-1.33, 0, 1.33];
    rule.push(-0.67, -hh, 0.02, -0.67, hh, 0.02);
    rule.push(0.67, -hh, 0.02, 0.67, hh, 0.02);
    const z = 0.02;
    for (const cx of cols) {
      const rows = [0.12, -0.08, -0.28];
      for (const ry of rows) {
        rule.push(cx - 0.5, ry, z, cx - 0.08, ry, z); // item name
        rule.push(cx + 0.22, ry, z, cx + 0.46, ry, z); // price
      }
    }
    g.add(segments(rule, this.matSoft));
    return g;
  }

  private table(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const topY = 0.95;
    const top = circleXZ(0.5, 28, this.matSoft);
    top.position.set(x, topY, z);
    g.add(top);
    g.add(segments([x, topY, z, x, 0, z], this.matSoft)); // central stem
    const foot = circleXZ(0.28, 20, this.matFaint);
    foot.position.set(x, 0.005, z);
    g.add(foot);
    // two stools flanking the table
    g.add(this.stool(x + 0.95, z + 0.15));
    g.add(this.stool(x - 0.9, z - 0.2));
    return g;
  }

  private stool(x: number, z: number): THREE.Group {
    const g = new THREE.Group();
    const seatY = 0.55;
    const seat = circleXZ(0.22, 20, this.matSoft);
    seat.position.set(x, seatY, z);
    g.add(seat);
    const legs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const lx = x + Math.cos(a) * 0.16;
      const lz = z + Math.sin(a) * 0.16;
      legs.push(x, seatY, z, lx, 0, lz);
    }
    g.add(segments(legs, this.matFaint));
    return g;
  }

  // ---------------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------------
  resize(): void {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, this.canvas.clientWidth || parent?.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || parent?.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false); // false: CSS controls the element size
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(snap: WorldSnapshot, dtReal: number): void {
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;

    try {
      // cashier embodiment
      const cp = snap?.cashier;
      this.cashier.embody(cp?.soma, cp?.readout);

      // customers
      this.syncCustomers(Array.isArray(snap?.queue) ? snap.queue : []);
    } catch {
      // never let a malformed snapshot break the render loop
    }

    this.cashier.tick(dt);
    for (const fig of this.customers.values()) fig.tick(dt);

    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    disposeObject(this.scene);
    this.scene.clear();
    this.customers.clear();
    this.matInk.dispose();
    this.matSoft.dispose();
    this.matFaint.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  private updateCamera(): void {
    // a slow, slight orbit around a fixed 3/4 vantage from the +x/+z side
    const az = 0.55 + Math.sin(this.clock * 0.05) * 0.16;
    const r = 7.4;
    const camY = 3.2 + Math.sin(this.clock * 0.037) * 0.18;
    this.camera.position.set(
      this.camTarget.x + Math.sin(az) * r,
      camY,
      this.camTarget.z + Math.cos(az) * r,
    );
    this.camera.lookAt(this.camTarget);
  }

  /** Lazily create/remove customer figures to match the live queue. */
  private syncCustomers(queue: Customer[]): void {
    const seen = new Set<string>();
    let rank = 0;

    for (const c of queue) {
      if (!c || typeof c.id !== 'string') continue;
      if (c.state === 'gone') continue; // drop below
      seen.add(c.id);

      let fig = this.customers.get(c.id);
      const tgt = this.customerTarget(c, rank);

      if (!fig) {
        fig = new Figure('customer');
        // enter from further down the queue (toward +z) and walk in
        const spawn = tgt.clone();
        spawn.z += 3.2;
        fig.place(spawn, Math.PI); // faces −z, toward the counter
        this.scene.add(fig.object);
        this.customers.set(c.id, fig);
      }

      fig.target.copy(tgt);
      fig.targetYaw = c.state === 'leaving' ? 0 : Math.PI; // turn away when leaving
      fig.setPose(c.demeanor, c.patience, c.state);

      if (c.state !== 'leaving') rank++;
    }

    // remove figures whose customer left the queue or went 'gone'
    for (const [id, fig] of this.customers) {
      if (!seen.has(id)) {
        this.scene.remove(fig.object);
        disposeObject(fig.object);
        this.customers.delete(id);
      }
    }
  }

  /** World target for a customer: trust a meaningful Customer.pos, else queue. */
  private customerTarget(c: Customer, rank: number): THREE.Vector3 {
    if (c.state === 'leaving') {
      // walk off toward the door (+z), drifting to stage right
      return new THREE.Vector3(2.4, 0, FLOOR_Z1 - 1.5);
    }

    const p = c.pos;
    const valid =
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.z) &&
      Math.abs(p.x) + Math.abs(p.z) > 1e-4;

    if (valid) {
      return new THREE.Vector3(
        clampNum(p.x, -FLOOR_X + 0.5, FLOOR_X - 0.5),
        0,
        clampNum(p.z, FLOOR_Z0 + 0.5, FLOOR_Z1 - 0.5),
      );
    }

    // fallback queue: front at the counter, the rest lined up toward +z
    const jitter = (hash01(c.id) - 0.5) * 0.42;
    return new THREE.Vector3(jitter, 0, ORDER_Z + rank * QUEUE_GAP);
  }
}
