// =============================================================================
// citystage.ts — the primary 3D view. A low-poly black-mesh city with a
// multi-floor apartment BUILDING at its heart, inhabited by 10 agents who live
// their home lives (climb stairs, open doors, sleep / watch TV / use a phone /
// use the toilet / shower) at the compressed 1/4 → 1/16 projection scale.
//
// Camera has two modes:
//   FOLLOW — orbit any of the 10 agents; the framing auto-scales with the agent's
//            body size, so as she shrinks 1/4 (entering the building) and 1/4 again
//            (entering her flat) the camera zooms in to keep her the same on screen.
//   FREE   — fly: drag to look, arrow keys to move (fwd/back/left/right), W/S for
//            elevation. Move-speed + near-plane auto-scale with whichever space the
//            camera is in (city → building interior → apartment interior).
// A small on-screen panel switches between Free roam and each agent.
// =============================================================================
import * as THREE from 'three';
import type { TownSnapshot, PlaceId, Vec2, NpcLite, IntentionKind } from '../types';
import { PALETTE, clampNum } from './palette';
import { Humanoid } from './humanoid';
import type { ActivityKind } from './poses';
import {
  CITY, INT_SCALE, mapToWorld, makeCityMats, buildLocale, fillerBlock, lamp, parkedCar,
  type CityMats, type Locale,
} from './worldgeo';
import { APT_SCALE } from './building';
import { AgentBodies } from './agentbodies';
import { buildFoodBuilding, type FoodBuilding } from './foodcourt';
import { buildOfficeBuilding, type OfficeBuilding } from './office';
import { ROSTER } from '../harness/roster';
import { PLACES } from '../sim/places';

const V = THREE.Vector3;
const PLACE_IDS: PlaceId[] = ['home', 'work', 'market', 'thirdplace', 'park'];
const STREETS: [PlaceId, PlaceId][] = [
  ['home', 'work'], ['home', 'market'], ['work', 'market'],
  ['market', 'thirdplace'], ['work', 'thirdplace'], ['home', 'park'], ['market', 'park'],
];
const R_FILLER = 30;

const hash01 = (n: number) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

/** map Mara's current sim intention to a home activity pose. */
function activityFor(kind: IntentionKind): ActivityKind {
  switch (kind) {
    case 'rest': return 'sleep';
    case 'bathe': return 'shower';
    case 'relieve': return 'toilet_pee';
    case 'eat': case 'drink': return 'couch_tv';
    default: return 'couch_tv';
  }
}

type CamMode = 'follow' | 'free';

export class CityStage {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly mats: CityMats;

  private readonly locales = new Map<PlaceId, Locale>();
  private readonly fillers: THREE.Object3D[] = [];

  private readonly mara: Humanoid;
  private readonly residentHumans: Humanoid[] = [];  // the 9 other agents
  private readonly agents: Humanoid[] = [];           // [mara, ...residentHumans]
  private agentBodies!: AgentBodies;
  private food!: FoodBuilding;
  private office!: OfficeBuilding;
  private readonly figures = new Map<string, Humanoid>();
  private focus = 0;

  // camera — follow (orbit) state
  private mode: CamMode = 'follow';
  private followIndex = 0;
  private readonly camTarget = new THREE.Vector3();
  private theta = 0.7; private phi = 1.0; private radius = 9.5;
  private dragging = false; private autoRot = true;
  private lastX = 0; private lastY = 0;
  private lastNear = 0.1;

  // camera — free-fly state
  private freePos = new THREE.Vector3(0, 14, 26);
  private freeYaw = Math.PI; private freePitch = -0.4;
  private readonly keys = new Set<string>();

  private clock = 0;
  private maraWorld = new THREE.Vector3();

  // speech bubble + camera UI (DOM)
  private readonly bubble: HTMLDivElement;
  private bubbleText = ''; private bubbleTTL = 0;
  private readonly headWorld = new THREE.Vector3();
  private camPanel!: HTMLDivElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE.paper, 1);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.02, 300);
    this.scene.fog = new THREE.Fog(PALETTE.paper, 46, 110);

    this.mats = makeCityMats();
    this.buildGround();
    this.buildStreets();
    this.buildLocales();
    this.buildFiller();

    // protagonist + the nine other agents (ten full-sim characters total)
    this.mara = new Humanoid('protagonist');
    this.scene.add(this.mara.object);
    this.agents.push(this.mara);
    for (let i = 1; i < ROSTER.length; i++) {
      const h = new Humanoid('npc');
      this.scene.add(h.object);
      this.residentHumans.push(h);
      this.agents.push(h);
    }

    // the two WORKPLACES, each a building with the same shrink-through-the-door
    // rule as home: the fast-food venue stands in the work locale; the office is a
    // standalone building set a little apart in the city.
    const home = this.locales.get('home')!;
    home.group.updateMatrixWorld(true);
    const work = this.locales.get('work')!;
    this.food = buildFoodBuilding(this.mats);
    const foodGroup = this.food.group;
    foodGroup.scale.setScalar(INT_SCALE);
    foodGroup.position.set(0, 0, 3.0 - 3.5 * INT_SCALE);   // main-door plane onto the work stoop
    work.interior.clear();                                   // drop the old flat counter room
    work.interior.add(foodGroup);
    work.group.updateMatrixWorld(true);

    this.office = buildOfficeBuilding(this.mats);
    const officeGroup = this.office.group;
    officeGroup.scale.setScalar(INT_SCALE);
    officeGroup.position.set(26, 0, 4);
    officeGroup.rotation.y = Math.atan2(-26, -4);           // face town centre
    this.scene.add(officeGroup);
    officeGroup.updateMatrixWorld(true);

    // one sim-driven controller places all ten bodies across the three buildings.
    this.agentBodies = new AgentBodies({
      home: home.building!, homeGroup: home.building!.group,
      food: this.food, foodGroup,
      office: this.office, officeGroup,
    }, this.agents);

    const start = home.group.localToWorld(new V(0, 0, 3.0));
    this.mara.place(start, home.yaw);
    this.maraWorld.copy(start);
    this.camTarget.set(start.x, start.y + 0.95, start.z);

    // speech bubble
    this.bubble = document.createElement('div');
    this.bubble.className = 'speech-bubble';
    this.bubble.style.display = 'none';
    (this.canvas.parentElement ?? document.body).appendChild(this.bubble);

    this.buildCameraUI(ROSTER.map((r, i) => ({ index: i, name: r.profile.name, color: r.hatColor })));

    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointerleave', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);

    this.resize();
  }

  // ------------------------------------------------------------- build
  private buildGround(): void {
    const half = CITY * 0.62, grid: number[] = [], step = 6;
    for (let x = -half; x <= half; x += step) grid.push(x, 0, -half, x, 0, half);
    for (let z = -half; z <= half; z += step) grid.push(-half, 0, z, half, 0, z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    this.scene.add(new THREE.LineSegments(g, this.mats.faint));
  }

  private buildStreets(): void {
    for (const [a, b] of STREETS) {
      const pa = mapToWorld(PLACES[a].pos2D), pb = mapToWorld(PLACES[b].pos2D);
      const dir = new V().subVectors(pb, pa);
      const len = dir.length(); dir.normalize();
      const nrm = new V(-dir.z, 0, dir.x).multiplyScalar(1.6);
      this.scene.add(seg([
        pa.x + nrm.x, 0.01, pa.z + nrm.z, pb.x + nrm.x, 0.01, pb.z + nrm.z,
        pa.x - nrm.x, 0.01, pa.z - nrm.z, pb.x - nrm.x, 0.01, pb.z - nrm.z,
      ], this.mats.soft));
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
    const half = CITY * 0.5;
    const placesW = PLACE_IDS.map((id) => mapToWorld(PLACES[id].pos2D));
    for (let gx = -4; gx <= 4; gx++) {
      for (let gz = -4; gz <= 4; gz++) {
        const s = (gx + 8) * 131 + (gz + 8) * 17, h = hash01(s);
        if (h < 0.42) continue;
        const x = gx * (CITY / 9) + (hash01(s + 3) - 0.5) * 4;
        const z = gz * (CITY / 9) + (hash01(s + 7) - 0.5) * 4;
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        const p = new V(x, 0, z);
        if (placesW.some((pw) => pw.distanceTo(p) < 11)) continue;
        const blk = fillerBlock(this.mats, 3 + hash01(s + 11) * 4, 3 + hash01(s + 17) * 9, 3 + hash01(s + 13) * 4, h > 0.6);
        blk.position.set(x, 0, z);
        blk.rotation.y = Math.round(hash01(s + 19) * 4) * (Math.PI / 2);
        this.scene.add(blk);
        this.fillers.push(blk);
      }
    }
  }

  /** the camera-mode DOM panel (Free roam + the 10 agents). */
  private buildCameraUI(list: { index: number; name: string; color: number }[]): void {
    const panel = document.createElement('div');
    panel.className = 'cam-panel';
    const title = document.createElement('div');
    title.className = 'cam-title'; title.textContent = 'CAMERA';
    panel.appendChild(title);
    const mk = (label: string, on: () => void, id: string, color?: number) => {
      const b = document.createElement('button');
      b.className = 'cam-btn'; b.dataset.id = id;
      if (color != null) {
        const dot = document.createElement('span');
        dot.className = 'cam-dot';
        dot.style.background = '#' + color.toString(16).padStart(6, '0');
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(label));
      b.addEventListener('click', on);
      panel.appendChild(b);
      return b;
    };
    mk('◇ free roam', () => this.setMode('free'), 'free');
    for (const a of list) mk(` ${a.name}`, () => { this.followIndex = a.index; this.focus = a.index; this.setMode('follow'); }, `f${a.index}`, a.color);
    const hint = document.createElement('div');
    hint.className = 'cam-hint'; hint.textContent = 'free: drag look · ↑↓←→ move · W/S up·down';
    panel.appendChild(hint);
    (this.canvas.parentElement ?? document.body).appendChild(panel);
    this.camPanel = panel;
    this.refreshCamUI();
  }

  private refreshCamUI(): void {
    if (!this.camPanel) return;
    const activeId = this.mode === 'free' ? 'free' : `f${this.followIndex}`;
    this.camPanel.querySelectorAll('.cam-btn').forEach((el) => {
      (el as HTMLElement).classList.toggle('on', (el as HTMLElement).dataset.id === activeId);
    });
  }

  private setMode(m: CamMode): void {
    if (m === 'free' && this.mode !== 'free') {
      // seed the free camera from the current view so it doesn't jump
      this.freePos.copy(this.camera.position);
      const dir = new V().subVectors(this.camTarget, this.camera.position).normalize();
      this.freeYaw = Math.atan2(dir.x, dir.z);
      this.freePitch = Math.asin(clampNum(dir.y, -1, 1));
    }
    this.mode = m;
    this.refreshCamUI();
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

  /** which agent the inspector panels should track (last-followed agent). */
  get focusIndex(): number { return this.focus; }

  /** debug: per-body routing state (region / transiting / scale / pose). */
  agentDebug(): unknown { return this.agentBodies.debug(); }

  update(snap: TownSnapshot, dtReal: number): void {
    const dt = Number.isFinite(dtReal) ? clampNum(dtReal, 0, 0.1) : 0;
    this.clock += dt;
    try {
      const agents = snap.agents ?? [];
      // Mara: AgentBodies drives her through home + the fast-food venue; when she is
      // out in the wider city (market / café / park / commuting) the city walker
      // stages her door-to-door instead.
      const maraA = agents[0];
      const maraInCity = !maraA || (maraA.place !== 'home' && maraA.place !== 'foodcourt');
      if (maraInCity) this.updateProtagonistCity(snap);
      this.agentBodies.update(agents, dt, (idx) => idx === 0 && maraInCity);
      // every body wears its own psyche: posture + tint from its own soma.
      for (let i = 0; i < this.agents.length; i++) {
        const a = agents[i];
        if (a) this.agents[i].embody(a.soma, a.readout);
      }
      this.maraWorld.copy(this.mara.pos);
      this.syncFigures(snap);
      this.updateLOD(snap);
    } catch { /* never break the loop */ }

    for (const a of this.agents) a.tick(dt);
    for (const f of this.figures.values()) f.tick(dt);
    this.updateCamera(dt);
    this.updateBubble(snap, dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Mara out in the city: travel door-to-door, else stand at the locale act spot. */
  private updateProtagonistCity(snap: TownSnapshot): void {
    this.mara.setScale(1);
    this.mara.setActivity('walk');
    if (snap.travelling) {
      const from = this.locales.get(snap.place), dest = this.locales.get(snap.intention.place);
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
        this.mara.target.copy(loc.interior.localToWorld(new V(spot.x, 0, spot.z)));
        this.mara.targetYaw = loc.yaw + (spot.yaw ?? loc.occupant.yaw ?? 0);
        this.mara.setActivity('stand');
      }
    }
  }

  private progress(cur: Vec2, from: Vec2, to: Vec2): number {
    const dfx = to.x - from.x, dfy = to.y - from.y;
    const denom = dfx * dfx + dfy * dfy;
    if (denom < 1e-6) return 1;
    return clampNum(((cur.x - from.x) * dfx + (cur.y - from.y) * dfy) / denom, 0, 1);
  }

  private doorWorld(loc: Locale): THREE.Vector3 {
    return loc.group.localToWorld(new V(0, 0, 3.0));
  }

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
      const worldPos = loc!.interior.localToWorld(new V(f.pos.x, 0, f.pos.z));
      if (!h) {
        h = new Humanoid(isPartner ? 'partner' : 'npc');
        h.place(worldPos, (loc!.yaw + (f.dir || 0)));
        this.scene.add(h.object);
        this.figures.set(f.id, h);
      }
      h.target.copy(worldPos);
      h.targetYaw = loc!.yaw + (f.dir || Math.PI);
      if (isPartner && pv) {
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

  /** dollhouse LOD. Locales open up when Mara is inside. The home building is
   *  ALWAYS shown (its 10 flats are always inhabited); its solid tower massing is
   *  hidden when the camera is near home so we can see straight into the flats. */
  private updateLOD(snap: TownSnapshot): void {
    const camNearHome = this.camera.position.distanceTo(this.locales.get('home')!.world) < 30;
    for (const loc of this.locales.values()) {
      if (loc.id === 'home') {
        loc.interior.visible = true;
        loc.base.visible = !camNearHome;
        loc.shell.visible = !camNearHome;
        continue;
      }
      if (loc.id === 'work') {
        // the fast-food venue is always inhabited (boss + cleaner work here even
        // when Mara doesn't) — always show its interior building, drop the old shell.
        loc.interior.visible = true;
        loc.base.visible = false;
        loc.shell.visible = false;
        continue;
      }
      const inside = !snap.travelling && snap.place === loc.id;
      loc.shell.visible = !inside;
      loc.interior.visible = inside;
    }
    for (const blk of this.fillers) blk.visible = blk.position.distanceTo(this.maraWorld) < R_FILLER;
  }

  // ------------------------------------------------------------- camera
  private updateCamera(dt: number): void {
    if (this.mode === 'free') this.updateFreeCamera(dt);
    else this.updateFollowCamera(dt);
  }

  private updateFollowCamera(dt: number): void {
    const ag = this.agents[this.followIndex] ?? this.mara;
    const sc = ag.object.scale.x || 1;
    const k = 1 - Math.exp(-4 * dt);
    this.camTarget.lerp(new V(ag.pos.x, ag.pos.y + 0.95 * sc, ag.pos.z), k);
    if (this.autoRot && !this.dragging) this.theta += dt * 0.05;
    const r = this.radius * sc;
    this.camera.position.set(
      this.camTarget.x + r * Math.sin(this.phi) * Math.cos(this.theta),
      this.camTarget.y + r * Math.cos(this.phi),
      this.camTarget.z + r * Math.sin(this.phi) * Math.sin(this.theta),
    );
    this.camera.lookAt(this.camTarget);
    this.applyNear(0.02 * r);
  }

  private updateFreeCamera(dt: number): void {
    const ctx = this.contextScale(this.freePos);
    // look direction from yaw/pitch
    const cp = Math.cos(this.freePitch), sp = Math.sin(this.freePitch);
    const dir = new V(cp * Math.sin(this.freeYaw), sp, cp * Math.cos(this.freeYaw));
    const right = new V(Math.cos(this.freeYaw), 0, -Math.sin(this.freeYaw));
    const spd = 7 * ctx * dt;               // ~7 world-units/s at full scale, scaled by context
    if (this.keys.has('arrowup')) this.freePos.addScaledVector(dir, spd);
    if (this.keys.has('arrowdown')) this.freePos.addScaledVector(dir, -spd);
    if (this.keys.has('arrowleft')) this.freePos.addScaledVector(right, -spd);
    if (this.keys.has('arrowright')) this.freePos.addScaledVector(right, spd);
    if (this.keys.has('w')) this.freePos.y += spd;
    if (this.keys.has('s')) this.freePos.y -= spd;
    this.camera.position.copy(this.freePos);
    this.camera.lookAt(new V().addVectors(this.freePos, dir));
    this.applyNear(Math.max(0.004, 0.4 * ctx));
  }

  /** the scale of whatever space the camera is currently in (city 1 · building
   *  INT_SCALE · apartment INT_SCALE·APT_SCALE), used to auto-scale free-fly
   *  speed + near-plane. Thresholds are world-radii sized to each space. */
  private contextScale(pos: THREE.Vector3): number {
    const home = this.locales.get('home')!;
    const b = home.building;
    if (!b) return 1;
    // nearest apartment interior (small sphere) → INT_SCALE·APT_SCALE (1/16)
    let nearestApt = Infinity;
    for (const apt of b.apartments) {
      const c = apt.group.localToWorld(new V(0, 1.2, 0));
      nearestApt = Math.min(nearestApt, pos.distanceTo(c));
    }
    if (nearestApt < 0.5) return INT_SCALE * APT_SCALE;
    // building interior sphere → INT_SCALE (1/4)
    const bc = b.group.localToWorld(new V(0, 4.5, 0));
    if (pos.distanceTo(bc) < 3.5) return INT_SCALE;
    return 1;
  }

  private applyNear(n: number): void {
    if (Math.abs(n - this.lastNear) / this.lastNear > 0.1) {
      this.camera.near = clampNum(n, 0.002, 1);
      this.camera.updateProjectionMatrix();
      this.lastNear = this.camera.near;
    }
  }

  // ------------------------------------------------------------- speech bubble
  private updateBubble(snap: TownSnapshot, dt: number): void {
    const idx = this.focus;
    const a = snap.agents?.[idx];
    const say = (a?.saying ?? a?.lastResponse?.speech ?? '').trim();
    if (say && say !== this.bubbleText) { this.bubbleText = say; this.bubbleTTL = 6; }
    this.bubbleTTL -= dt;
    const h = this.agents[idx] ?? this.mara;
    if (this.bubbleTTL <= 0 || !this.bubbleText || this.mode !== 'follow') {
      this.bubble.style.display = 'none'; return;
    }
    const sc = h.object.scale.x || 1;
    this.headWorld.set(h.pos.x, h.pos.y + 2.1 * sc, h.pos.z).project(this.camera);
    if (this.headWorld.z > 1) { this.bubble.style.display = 'none'; return; }
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    this.bubble.textContent = this.bubbleText;
    this.bubble.style.display = '';
    this.bubble.style.left = `${Math.round((this.headWorld.x * 0.5 + 0.5) * W)}px`;
    this.bubble.style.top = `${Math.round((-this.headWorld.y * 0.5 + 0.5) * H)}px`;
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
    const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY;
    if (this.mode === 'free') {
      this.freeYaw -= dx * 0.005;
      this.freePitch = clampNum(this.freePitch - dy * 0.005, -1.4, 1.4);
    } else {
      this.theta -= dx * 0.007;
      this.phi = clampNum(this.phi - dy * 0.007, 0.28, 1.5);
    }
  };
  private onUp = () => { this.dragging = false; };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.mode === 'free') {
      const ctx = this.contextScale(this.freePos);
      const cp = Math.cos(this.freePitch), sp = Math.sin(this.freePitch);
      const dir = new V(cp * Math.sin(this.freeYaw), sp, cp * Math.cos(this.freeYaw));
      this.freePos.addScaledVector(dir, -Math.sign(e.deltaY) * 1.5 * ctx);
    } else {
      this.radius = clampNum(this.radius * (1 + Math.sign(e.deltaY) * 0.08), 5, 30);
    }
  };
  private onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 's'].includes(k)) {
      this.keys.add(k);
      if (this.mode === 'free' && k.startsWith('arrow')) e.preventDefault();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointerleave', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    this.bubble.remove();
    this.camPanel?.remove();
    this.renderer.dispose();
  }
}

function seg(pts: number[], mat: THREE.LineBasicMaterial): THREE.LineSegments {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, mat);
}
