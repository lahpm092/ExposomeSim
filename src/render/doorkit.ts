// =============================================================================
// doorkit.ts — a shared hinged door (leaf + casing) in the house line-work style,
// used by both the apartment units and the building lobby. The leaf's hinge axis
// is at local x=0 and the leaf extends +x; rotate `pivot.rotation.y` to swing it.
// =============================================================================
import * as THREE from 'three';
import type { Kit } from './kit';

export interface DoorRef {
  /** rotate .rotation.y to swing the leaf (0 = closed, ~-1.4 = open inward). */
  pivot: THREE.Group;
  open: boolean;
  /** hinge world-less local position, for choreography if needed. */
  hingeLocal: THREE.Vector3;
}

/** a panelled leaf with a lever handle; base at y=0, extends +x by width w. */
export function doorLeaf(kit: Kit, w = 0.9, h = 2.05, tone: 'ink' | 'soft' = 'ink'): THREE.Group {
  const pivot = kit.group();
  const leaf = kit.group();
  leaf.add(kit.boxAt(w, h, 0.045, w / 2, 0, 0, { edge: tone }));
  const pz = 0.03;
  leaf.add(kit.line([
    0.14, 0.28, pz, w - 0.14, 0.28, pz, w - 0.14, 0.28, pz, w - 0.14, 0.92, pz,
    w - 0.14, 0.92, pz, 0.14, 0.92, pz, 0.14, 0.92, pz, 0.14, 0.28, pz,
    0.14, 1.06, pz, w - 0.14, 1.06, pz, w - 0.14, 1.06, pz, w - 0.14, 1.78, pz,
    w - 0.14, 1.78, pz, 0.14, 1.78, pz, 0.14, 1.78, pz, 0.14, 1.06, pz,
  ], 'faint'));
  leaf.add(kit.boxAt(0.14, 0.03, 0.03, w - 0.12, 1.02, 0.05, { edge: 'soft' }));
  pivot.add(leaf);
  return pivot;
}

/** static jambs + head around an opening of width w. */
export function doorCasing(kit: Kit, w = 0.9, h = 2.05): THREE.Group {
  const g = kit.group();
  kit.add(g, kit.boxAt(0.06, h + 0.05, 0.12, -0.03, 0, 0, { edge: 'soft' }));
  kit.add(g, kit.boxAt(0.06, h + 0.05, 0.12, w + 0.03, 0, 0, { edge: 'soft' }));
  kit.add(g, kit.boxAt(w + 0.12, 0.07, 0.12, w / 2, h, 0, { edge: 'soft' }));
  return g;
}

/**
 * Build a complete hinged door at a given placement.
 *   parent   — group to add to
 *   x,y,z    — hinge position in parent-local metres
 *   yaw      — orientation of the doorway (leaf extends +x rotated by yaw)
 *   w,h      — leaf size
 * Returns a DoorRef whose pivot swings about y.
 */
export function makeDoor(
  kit: Kit, parent: THREE.Object3D, x: number, y: number, z: number, yaw: number,
  w = 0.9, h = 2.05,
): DoorRef {
  const casing = doorCasing(kit, w, h);
  casing.position.set(x, y, z); casing.rotation.y = yaw; parent.add(casing);
  const pivot = doorLeaf(kit, w, h);
  pivot.position.set(x, y, z); pivot.rotation.y = yaw; pivot.userData.baseYaw = yaw; parent.add(pivot);
  return { pivot, open: false, hingeLocal: new THREE.Vector3(x, y, z) };
}

/** ease a door leaf toward open/closed (call each frame). */
export function swingDoor(d: DoorRef, open: boolean, k = 0.2): void {
  const base = d.pivot.rotation.y;
  // the leaf's *rest* yaw was baked into the pivot at creation; swing is relative.
  // We store the doorway yaw on the pivot and swing an extra hinge angle child-free
  // by rotating toward rest (closed) or rest-1.4 (open). To keep it simple the caller
  // passes the doorway yaw via userData.baseYaw.
  const baseYaw = (d.pivot.userData.baseYaw as number) ?? base;
  const target = baseYaw + (open ? -1.4 : -0.02);
  d.pivot.rotation.y += (target - d.pivot.rotation.y) * k;
  d.open = open;
}
