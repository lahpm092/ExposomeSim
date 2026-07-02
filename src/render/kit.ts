// =============================================================================
// kit.ts — a tiny low-poly modelling kit in the house style (paper fill that
// occludes cleanly + crisp ink edges). Every primitive is a solid whose visible
// edges are drawn as black line-work, so furniture reads as clear geometric
// shapes with as few polygons as possible. Coordinates are in REAL metres; the
// caller scales the whole interior down (the 1/8 apartment trick) as one group.
//
// This is the shared vocabulary the apartment-modelling agents build against —
// they never touch THREE directly, only these helpers, so their output drops in.
// =============================================================================
import * as THREE from 'three';
import type { CityMats } from './worldgeo';

export type Tone = 'ink' | 'soft' | 'faint' | 'green';
export interface KitOpts { edge?: Tone; fill?: boolean; }

export interface Kit {
  THREE: typeof THREE;
  group(): THREE.Group;
  /** solid box, base centred on y=0, centred in x/z. */
  box(w: number, h: number, d: number, o?: KitOpts): THREE.Group;
  /** solid box placed with its base-centre at (x,y,z). */
  boxAt(w: number, h: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  /** low-poly cylinder (radialSegments = seg), base on y=0. */
  cyl(r: number, h: number, seg: number, o?: KitOpts): THREE.Group;
  cylAt(r: number, h: number, seg: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  /** low-poly sphere-ish blob (icosahedron), centre at (x,y,z). */
  ball(r: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  /** a horizontal quad (worktop / shelf) centred at (x,y,z), size w×d. */
  slab(w: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  /** a triangular prism (hood, wedge) — right-triangle cross-section w×h, length d. */
  wedge(w: number, h: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  /** disjoint ink line segments from flat [x,y,z, …] pairs. */
  line(pts: number[], tone?: Tone): THREE.LineSegments;
  /** a thin knob / handle nub at (x,y,z). */
  knob(r: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group;
  add(parent: THREE.Object3D, ...kids: THREE.Object3D[]): THREE.Object3D;
  mat(tone: Tone): THREE.LineBasicMaterial;
}

export function makeKit(mats: CityMats): Kit {
  const edgeMat = (t: Tone): THREE.LineBasicMaterial =>
    t === 'soft' ? mats.soft : t === 'faint' ? mats.faint : t === 'green' ? mats.green : mats.ink;

  const solid = (geo: THREE.BufferGeometry, o?: KitOpts): THREE.Group => {
    const g = new THREE.Group();
    if (o?.fill !== false) g.add(new THREE.Mesh(geo, mats.fill));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), edgeMat(o?.edge ?? 'ink')));
    return g;
  };

  const box = (w: number, h: number, d: number, o?: KitOpts): THREE.Group => {
    const geo = new THREE.BoxGeometry(w, h, d); geo.translate(0, h / 2, 0);
    return solid(geo, o);
  };
  const boxAt = (w: number, h: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    const g = box(w, h, d, o); g.position.set(x, y, z); return g;
  };
  const cyl = (r: number, h: number, seg: number, o?: KitOpts): THREE.Group => {
    const geo = new THREE.CylinderGeometry(r, r, h, Math.max(3, seg | 0)); geo.translate(0, h / 2, 0);
    return solid(geo, o);
  };
  const cylAt = (r: number, h: number, seg: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    const g = cyl(r, h, seg, o); g.position.set(x, y, z); return g;
  };
  const ball = (r: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    const geo = new THREE.IcosahedronGeometry(r, 0); geo.translate(x, y, z);
    return solid(geo, o);
  };
  const slab = (w: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    const g = box(w, 0.04, d, o); g.position.set(x, y, z); return g;
  };
  const wedge = (w: number, h: number, d: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    // right-triangle cross-section in the x–y plane (0,0)-(w,0)-(0,h), extruded along z by d
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(-w / 2, h); shape.lineTo(-w / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    geo.translate(0, 0, -d / 2);
    const g = solid(geo, o); g.position.set(x, y, z); return g;
  };
  const line = (pts: number[], tone: Tone = 'ink'): THREE.LineSegments => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, edgeMat(tone));
  };
  const knob = (r: number, x: number, y: number, z: number, o?: KitOpts): THREE.Group => {
    const geo = new THREE.BoxGeometry(r, r, r); geo.translate(x, y, z);
    return solid(geo, o);
  };
  const add = (parent: THREE.Object3D, ...kids: THREE.Object3D[]): THREE.Object3D => { parent.add(...kids); return parent; };

  return {
    THREE, group: () => new THREE.Group(),
    box, boxAt, cyl, cylAt, ball, slab, wedge, line, knob, add, mat: edgeMat,
  };
}
