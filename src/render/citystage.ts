// =============================================================================
// citystage.ts — the primary 3D view: a low-poly black-mesh city the protagonist
// inhabits and traverses over time, seen from a virtual camera that ORBITS her at
// a fixed radius (drag to rotate, wheel to zoom). The camera follows her; the sim
// only needs to render what is near her, so distant geometry is abstracted away
// (LOD): far building interiors and filler blocks are hidden, near ones detailed.
//
//   world axes:  +x → east · +y → up · +z → south (toward pos2D.y = 1)
//
// Mara walks door-to-door across the plaza while `travelling`, then stands at the
// current locale's forecourt where its figures (customers, café regulars, the
// promoted partner) are staged. One Humanoid per visible figure; a small pool is
// reused. Everything shares a handful of materials so the M1 GPU stays cool.
// =============================================================================
import * as THREE from 'three';
import type { TownSnapshot, PlaceId, Vec2, NpcLite, IntentionKind } from '../types';
import { PALETTE, clampNum } from './palette';
import { Humanoid } from './humanoid';
import {
  CITY, mapToWorld, makeCityMats, buildLocale, fillerBlock, lamp, parkedCar, INT_SCALE,
  type CityMats, type Locale,
} from './worldgeo';
import type { DoorRef } from './apartment';
import { PLACES } from '../sim/places';

const PLACE_IDS: PlaceId[] = ['home', 'work', 'market', 'thirdplace', 'park'];
const STREETS: [PlaceId, PlaceId][] = [
  ['home', 'work'], ['home', 'market'], ['work', 'market'],
  ['market', 'thirdplace'], ['work', 'thirdplace'], ['home', 'park'], ['market', 'park'],
];

// LOD radii (metres from Mara). City is CITY across, so this shows the near half.
const R_DETAIL = 24;   // locale detail + interior props
const R_FILLER = 30;   // decorative filler blocks
const F2_LOCAL = 5.4;  // her floor in the apartment's real-metre frame

const hash01 = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

export class CityStage {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly mats: CityMats;

  private readonly locales = new Map<PlaceId, Locale>();
  private readonly fillers: THREE.Object3D[] = [];

  private readonly mara: Humanoid;
  private readonly figures = new Map<string, Humanoid>();

  // camera orbit state
  private readonly camTarget = new THREE.Vector3();
  private theta = 0.7;          // azimuth
  private phi = 1.0;            // polar (0=top, π=bottom)
  private radius = 9.5;
  private dragging = false;
  private autoRot = true;
  private lastX = 0; private lastY = 0;
  private idleT = 0;

  private clock = 0;
  private maraWorld = new THREE.Vector3();

  // home arrival choreography (door → shrink → climb → hallway → room door)
  private homePhase: 'out' | 'entering' | 'settled' = 'out';
  private enterIdx = 0;
  private enterWorld: THREE.Vector3[] = [];

  // speech bubble (a DOM chip that tracks Mara's head)
  private readonly bubble: HTMLDivElement;
  private bubbleText = '';
  private bubbleTTL = 0;
  private readonly headWorld = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.paper, 1);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 260);
    this.scene.fog = new THREE.Fog(PALETTE.paper, 42, 96); // distant city dissolves into paper

    this.mats = makeCityMats();
    this.buildGround();
    this.buildStreets();
    this.buildLocales();
    this.buildFiller();

    this.mara = new Humanoid('protagonist');
    const home = this.locales.get('home')!;
    let start: THREE.Vector3;
    if (home.apartment) {
      home.apartment.group.updateMatrixWorld(true);
      start = home.apartment.group.localToWorld(new THREE.Vector3(0.4, F2_LOCAL, -1.6));
      this.mara.setScale(INT_SCALE);
      this.homePhase = 'settled';
    } else {
      start = home.interior.localToWorld(new THREE.Vector3(home.occupant.x, 0, home.occupant.z));
    }
    this.mara.place(start, home.yaw);
    this.maraWorld.copy(start);
    this.camTarget.set(start.x, start.y + 0.95 * INT_SCALE, start.z);
    this.scene.add(this.mara.object);

    // speech bubble DOM chip
    this.bubble = document.createElement('div');
    this.bubble.className = 'speech-bubble';
    this.bubble.style.display = 'none';
    (this.canvas.parentElement ?? document.body).appendChild(this.bubble);

    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    this.resize();
  }

  // ------------------------------------------------------------- build
  private buildGround(): void {
    const half = CITY * 0.62;
    const grid: number[] = [];
    const step = 6;
    for (let x = -half; x <= half; x += step) grid.push(x, 0, -half, x, 0, half);
    for (let z = -half; z <= half; z += step) grid.push(-half, 0, z, half, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    this.scene.add(new THREE.LineSegments(g, this.mats.faint));
  }

  private buildStreets(): void {
    for (const [a, b] of STREETS) {
      const pa = mapToWorld(PLACES[a].pos2D), pb = mapToWorld(PLACES[b].pos2D);
      const dir = new THREE.Vector3().subVectors(pb, pa);
      const len = dir.length(); dir.normalize();
      const nrm = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(1.6); // half-width
      const pts = [
        pa.x + nrm.x, 0.01, pa.z + nrm.z, pb.x + nrm.x, 0.01, pb.z + nrm.z,
        pa.x - nrm.x, 0.01, pa.z - nrm.z, pb.x - nrm.x, 0.01, pb.z - nrm.z,
      ];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.scene.add(new THREE.LineSegments(g, this.mats.soft));
      // dashed centre line
      const dash: number[] = [];
      const n = Math.max(2, Math.floor(len / 2));
      for (let i = 0; i < n; i += 2) {
        const t0 = i / n, t1 = Math.min(1, (i + 0.9) / n);
        dash.push(pa.x + dir.x * len * t0, 0.02, pa.z + dir.z * len * t0,
                  pa.x + dir.x * len * t1, 0.02, pa.z + dir.z * len * t1);
      }
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.Float32BufferAttribute(dash, 3));
      this.scene.add(new THREE.LineSegments(dg, this.mats.faint));
      // lamps along the street
      const lampN = Math.max(1, Math.floor(len / 9));
      for (let i = 1; i <= lampN; i++) {
        const t = i / (lampN + 1);
        const L = lamp(this.mats);
        L.position.set(pa.x + dir.x * len * t + nrm.x, 0, pa.z + dir.z * len * t + nrm.z);
        this.scene.add(L);
      }
    }
  }

  private buildLocales(): void {
    for (const id of PLACE_IDS) {
      const loc = buildLocale(id, this.mats);
      this.locales.set(id, loc);
      this.scene.add(loc.group);
    }
    // a few parked cars near the market/work forecourts
    for (const id of ['work', 'market'] as PlaceId[]) {
      const w = this.locales.get(id)!.world;
      for (let i = 0; i < 3; i++) {
        const car = parkedCar(this.mats);
        car.position.set(w.x + (i - 1) * 2.4, 0, w.z + 7 + i * 0.5);
        car.rotation.y = 0.1 * i;
        this.scene.add(car);
      }
    }
  }

  private buildFiller(): void {
    // deterministic filler blocks on a coarse grid, skipping cells near a locale.
    const half = CITY * 0.5;
    const placesW = PLACE_IDS.map((id) => mapToWorld(PLACES[id].pos2D));
    for (let gx = -4; gx <= 4; gx++) {
      for (let gz = -4; gz <= 4; gz++) {
        const seed = (gx + 8) * 131 + (gz + 8) * 17;
        const h = hash01(seed);
        if (h < 0.42) continue; // sparse
        const x = gx * (CITY / 9) + (hash01(seed + 3) - 0.5) * 4;
        const z = gz * (CITY / 9) + (hash01(seed + 7) - 0.5) * 4;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        const p = new THREE.Vector3(x, 0, z);
        if (placesW.some((pw) => pw.distanceTo(p) < 11)) continue; // clear of locales
        const bw = 3 + hash01(seed + 11) * 4;
        const bd = 3 + hash01(seed + 13) * 4;
        const bh = 3 + hash01(seed + 17) * 9;
        const blk = fillerBlock(this.mats, bw, bh, bd, h > 0.6);
        blk.position.set(x, 0, z);
        blk.rotation.y = Math.round(hash01(seed + 19) * 4) * (Math.PI / 2);
        this.scene.add(blk);
        this.fillers.push(blk);
      }
    }
  }

  // ------------------------------------------------------------- public API
  resize(): void {
    const parent = this.canvas.parentElement;
    const w = Math.max(1, this.canvas.clientWidth || parent?.clientWidth || window.innerWidth);
    const hgt = Math.max(1, this.canvas.clientHeight || parent?.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  update(snap: TownSnapshot, dtReal: number): void {
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;
    try {
      this.updateMara(snap);
      this.syncFigures(snap);
      this.updateLOD(snap);
    } catch { /* never break the loop */ }

    this.mara.tick(dt);
    for (const f of this.figures.values()) f.tick(dt);
    this.updateCamera(dt);
    this.updateBubble(snap, dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Mara's world position: home choreography, else door-to-door / act spot. */
  private updateMara(snap: TownSnapshot): void {
    const home = this.locales.get('home');
    const atHome = !snap.travelling && snap.place === 'home' && !!home?.apartment;

    if (atHome) {
      this.updateHome(snap, home!);
    } else {
      if (this.homePhase !== 'out') { this.homePhase = 'out'; this.enterIdx = 0; }
      this.mara.setScale(1);
      if (snap.travelling) {
        const from = this.locales.get(snap.place);
        const dest = this.locales.get(snap.intention.place);
        if (from && dest) {
          const p = this.progress(snap.macroPos, PLACES[snap.place].pos2D, PLACES[snap.intention.place].pos2D);
          this.mara.target.lerpVectors(this.doorWorld(from), this.doorWorld(dest), p);
        } else {
          this.mara.target.copy(mapToWorld(snap.macroPos));
        }
      } else {
        const loc = this.locales.get(snap.place);
        if (loc) {
          const spot = loc.spots[snap.intention.kind as IntentionKind] ?? loc.occupant;
          this.mara.target.copy(loc.interior.localToWorld(new THREE.Vector3(spot.x, 0, spot.z)));
          this.mara.targetYaw = loc.yaw + (spot.yaw ?? loc.occupant.yaw ?? 0);
        }
      }
    }
    // animate the two apartment doors toward their desired state
    if (home?.apartment) {
      const entOpen = this.homePhase === 'entering' && this.enterIdx <= 2;
      const studOpen = this.homePhase === 'entering' && this.enterIdx >= this.enterWorld.length - 4;
      this.swingDoor(home.apartment.entrance, entOpen);
      this.swingDoor(home.apartment.studioDoor, studOpen);
    }

    this.mara.embody(snap.cashier?.soma, snap.cashier?.readout);
    this.maraWorld.copy(this.mara.pos);
  }

  /** the arrival choreography inside the 1/8 apartment complex. */
  private updateHome(snap: TownSnapshot, home: Locale): void {
    const apt = home.apartment!;
    if (this.homePhase === 'out') {
      // just arrived: precompute the world climb path and begin entering full-size
      this.homePhase = 'entering'; this.enterIdx = 0;
      apt.group.updateMatrixWorld(true);
      this.enterWorld = apt.enterPath.map((p) => apt.group.localToWorld(p.clone()));
    }
    if (this.homePhase === 'entering') {
      const wp = this.enterWorld[Math.min(this.enterIdx, this.enterWorld.length - 1)];
      this.mara.target.copy(wp);
      // she is full-size until she steps over the threshold (waypoint 0→1), then 1/8
      this.mara.setScale(this.enterIdx >= 1 ? INT_SCALE : 1);
      const reach = this.enterIdx >= 1 ? 0.04 : 0.5; // world metres (tiny once shrunk)
      if (this.mara.pos.distanceTo(wp) < reach) {
        this.enterIdx++;
        if (this.enterIdx >= this.enterWorld.length) this.homePhase = 'settled';
      }
    } else { // settled — stand at the studio fixture for the current act
      this.mara.setScale(INT_SCALE);
      const spot = apt.studioSpots[snap.intention.kind] ?? apt.studioSpots.go_home ?? { x: 0.4, y: F2_LOCAL, z: -1.6, yaw: 0 };
      this.mara.target.copy(apt.group.localToWorld(new THREE.Vector3(spot.x, spot.y, spot.z)));
      this.mara.targetYaw = home.yaw + (spot.yaw ?? 0);
    }
  }

  private swingDoor(d: DoorRef, open: boolean): void {
    const target = open ? -1.35 : -0.02;
    d.pivot.rotation.y += (target - d.pivot.rotation.y) * 0.2;
  }

  private progress(cur: Vec2, from: Vec2, to: Vec2): number {
    const dfx = to.x - from.x, dfy = to.y - from.y;
    const denom = dfx * dfx + dfy * dfy;
    if (denom < 1e-6) return 1;
    return clampNum(((cur.x - from.x) * dfx + (cur.y - from.y) * dfy) / denom, 0, 1);
  }

  /** the street-level door she walks to/from (ground level even for the top flat). */
  private doorWorld(loc: Locale): THREE.Vector3 {
    return loc.group.localToWorld(new THREE.Vector3(0, 0, 3.0));
  }

  /** create/place a Humanoid per current-locale figure; retire the rest. */
  private syncFigures(snap: TownSnapshot): void {
    const loc = this.locales.get(snap.place);
    const list: NpcLite[] = (!snap.travelling && loc) ? (snap.locale?.figures ?? []) : [];
    const seen = new Set<string>();
    const pv = snap.partner;

    for (const f of list) {
      if (!f || typeof f.id !== 'string') continue;
      seen.add(f.id);
      let h = this.figures.get(f.id);
      const isPartner = f.goalToken === 'approach_mara' && !!pv;
      const worldPos = loc!.interior.localToWorld(new THREE.Vector3(f.pos.x, 0, f.pos.z));
      if (!h) {
        h = new Humanoid(isPartner ? 'partner' : 'npc');
        h.place(worldPos, (loc!.yaw + (f.dir || 0)));
        this.scene.add(h.object);
        this.figures.set(f.id, h);
      }
      h.target.copy(worldPos);
      h.targetYaw = loc!.yaw + (f.dir || Math.PI); // face the counter/Mara by default
      if (isPartner && pv) {
        // embody the abstracted partner: build a partial soma from its coarse axes
        h.embody(
          { valence: pv.valence, arousal: pv.arousal, dominance: pv.dominance, amygdala: pv.threat, cortisol: 1 + pv.threat },
          { label: pv.label, valence: pv.valence, arousal: pv.arousal, dominance: pv.dominance, intensity: Math.abs(pv.valence) },
        );
      } else {
        h.setPose(undefined, 1 - Math.abs(f.mood ?? 0), 'ordering');
      }
    }

    for (const [id, h] of this.figures) {
      if (!seen.has(id)) { this.scene.remove(h.object); h.dispose(); this.figures.delete(id); }
    }
  }

  /** dollhouse LOD: the building she is inside opens up (shell hidden, room shown);
   *  every other building keeps its massing; far filler blocks are culled. */
  private updateLOD(snap: TownSnapshot): void {
    for (const loc of this.locales.values()) {
      const inside = !snap.travelling && snap.place === loc.id;
      loc.shell.visible = !inside;
      loc.interior.visible = inside;
      // the home tower massing hides entirely when she's inside — the 1/8 complex
      // (stairs/hallway/studio) is the building she inhabits.
      if (loc.id === 'home') loc.base.visible = !inside;
    }
    for (const blk of this.fillers) {
      blk.visible = blk.position.distanceTo(this.maraWorld) < R_FILLER;
    }
  }

  private updateCamera(dt: number): void {
    // follow Mara, scaling the framing with her body-size (auto-zoom when she
    // shrinks to 1/8 inside the apartment so she stays the same size on screen)
    const sc = this.mara.object.scale.x || 1;
    const k = 1 - Math.exp(-4 * dt);
    this.camTarget.lerp(new THREE.Vector3(this.maraWorld.x, this.maraWorld.y + 0.95 * sc, this.maraWorld.z), k);
    this.idleT += dt;
    if (this.autoRot && !this.dragging) this.theta += dt * 0.06;
    const sp = this.phi, st = this.theta, r = this.radius * sc;   // wheel sets the base; scale multiplies
    this.camera.position.set(
      this.camTarget.x + r * Math.sin(sp) * Math.cos(st),
      this.camTarget.y + r * Math.cos(sp),
      this.camTarget.z + r * Math.sin(sp) * Math.sin(st),
    );
    this.camera.lookAt(this.camTarget);
  }

  /** the speech/thought bubble: show Mara's latest utterance above her head. */
  private updateBubble(snap: TownSnapshot, dt: number): void {
    const r = snap?.cashier?.lastResponse;
    const say = (r?.speech ?? '').trim();
    if (say && say !== this.bubbleText) { this.bubbleText = say; this.bubbleTTL = 6; }
    this.bubbleTTL -= dt;
    if (this.bubbleTTL <= 0 || !this.bubbleText) { this.bubble.style.display = 'none'; return; }

    // project a point ~0.5 m above her head to screen space
    this.headWorld.set(this.mara.pos.x, this.mara.pos.y + 2.1, this.mara.pos.z).project(this.camera);
    if (this.headWorld.z > 1) { this.bubble.style.display = 'none'; return; }
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    const sx = (this.headWorld.x * 0.5 + 0.5) * W;
    const sy = (-this.headWorld.y * 0.5 + 0.5) * H;
    this.bubble.textContent = this.bubbleText;
    this.bubble.style.display = '';
    this.bubble.style.left = `${Math.round(sx)}px`;
    this.bubble.style.top = `${Math.round(sy)}px`;
    this.bubble.style.opacity = String(clampNum(this.bubbleTTL / 1.2, 0, 1));
  }

  // ------------------------------------------------------------- input
  private onDown = (e: PointerEvent) => {
    this.dragging = true; this.autoRot = false;
    this.lastX = e.clientX; this.lastY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };
  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.theta -= (e.clientX - this.lastX) * 0.007;
    this.phi = clampNum(this.phi - (e.clientY - this.lastY) * 0.007, 0.28, 1.5);
    this.lastX = e.clientX; this.lastY = e.clientY;
  };
  private onUp = () => { this.dragging = false; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius = clampNum(this.radius * (1 + Math.sign(e.deltaY) * 0.08), 5, 30);
  };

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.bubble.remove();
    this.renderer.dispose();
  }
}
