// =============================================================================
// archetypes/contract.ts — the shared contract for BUSINESS ARCHETYPE kits.
// Each archetype is a visually DISTINCT low-poly building style (exterior) plus
// an optional interior (goods, fittings) that the render mounts ONLY when the
// camera/causal radius is near — render what's needed, nothing else.
//
// Implementers: one file per archetype under src/render/archetypes/, built in
// the house style (see render/kit.ts, render/supermarket.ts, render/building.ts,
// render/palette.ts): paper-fill solids + crisp ink line-work, real-metre
// coordinates, footprint centred at the group origin (x/z), base at y = 0.
// Register via registerArchetype(); index.ts imports every archetype module so
// side-effect registration happens once.
// =============================================================================
import * as THREE from 'three';

/** business archetypes with bespoke architecture. 'market2' is the rival
 *  supermarket look (must read clearly DIFFERENT from render/supermarket.ts). */
export type ArchetypeKind =
  | 'bakery' | 'butcher' | 'greengrocer' | 'dairy' | 'furniture' | 'tailor'
  | 'market2' | 'workshop' | 'conyard';

export const ARCHETYPE_KINDS: ArchetypeKind[] = [
  'bakery', 'butcher', 'greengrocer', 'dairy', 'furniture', 'tailor',
  'market2', 'workshop', 'conyard',
];

export interface ArchetypeCtx {
  w: number;        // footprint width  (metres, x)
  d: number;        // footprint depth  (metres, z)
  floors: number;   // storeys the shell was built with (kits may use fewer)
  seed: number;     // deterministic per-building variation (0..1 hashes off this)
}

export interface ArchetypeBuild {
  group: THREE.Group;                 // the exterior — always mounted
  /** lazily-built interior/goods detail; mounted only when near, disposed when
   *  far. Must be a fresh group each call (the caller owns its lifecycle). */
  buildInterior?: () => THREE.Group;
}

export type ArchetypeBuilder = (ctx: ArchetypeCtx) => ArchetypeBuild;

const REG = new Map<ArchetypeKind, ArchetypeBuilder>();

export function registerArchetype(kind: ArchetypeKind, b: ArchetypeBuilder): void {
  REG.set(kind, b);
}

export function getArchetype(kind: string | undefined | null): ArchetypeBuilder | undefined {
  return kind ? REG.get(kind as ArchetypeKind) : undefined;
}

export function archetypeCount(): number { return REG.size; }
