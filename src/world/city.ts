// =============================================================================
// ExposomeSim · Tier-3 statistical city
// -----------------------------------------------------------------------------
// The far field. There are NO stored agents here — only a low-resolution
// occupancy grid that *breathes* over the day. Land-use class and cell position
// are PURE functions of the cell index (a hashed land-use prior), so the city's
// "shape" is frame-stable and free; only the occupancy values relax over time.
//
//   occupancy(cell) = clamp( BASE · landUsePrior(hash01(cellId))
//                                 · cityCircadian(hour, landUse)
//                                 + placeAttractor, 0, 1 )
//
// Residential cells crowd at night, commercial cells at midday, so the whole
// field inhales and exhales across 24h. Place cells get an extra attractor bump
// driven by a per-place busyness curve (work daytime, thirdplace evening, …),
// which `expectedAt` turns into a Poisson-ish proximate-NPC count for spawning.
//
// Cost: O(cells) per step, O(1) per query. No DOM, no rendering, no allocation
// beyond a tiny per-call attractor lookup.
// =============================================================================

import type { DensityField, PlaceId, Place } from '../core/types';
import { clamp, lerp } from '../core/util/num';
import { PLACES } from './places';

// --- authored places, indexed for O(1) lookup (array OR record both work) ----
const PLACE_LIST: Place[] = Object.values(PLACES) as Place[];
const PLACE_BY_ID: Partial<Record<PlaceId, Place>> = {};
for (const p of PLACE_LIST) PLACE_BY_ID[p.id] = p;

// --- tuning ------------------------------------------------------------------
const BASE = 1.12;          // headroom so the densest class can saturate to 1
const PLACE_ATTRACT = 0.5;  // how hard a busy place pulls its own cell upward
const DEFAULT_CAP = 8;      // fallback expected-count scale if a place is unknown

// =============================================================================
// hash01 — deterministic [0,1) hash (lowbias32 finalizer). Land-use prior.
// =============================================================================
export function hash01(n: number): number {
  let h = (Math.floor(n) | 0) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// --- helpers (all pure) ------------------------------------------------------

/** wrap a clock to hour-of-day in [0,24) */
const hourOf = (clock: number): number => ((clock % 24) + 24) % 24;

/** circular Gaussian bump on the 24h clock, peak 1 at `center`, falloff `width` */
function circ(hour: number, center: number, width: number): number {
  let d = Math.abs(hour - center);
  if (d > 12) d = 24 - d;                 // shortest way around the clock
  return Math.exp(-(d * d) / (2 * width * width));
}

/**
 * Per-cell target occupancy = land-use prior × time-of-day circadian.
 * Land-use class is derived from the hashed cell id, so it never changes —
 * the city's zoning is fixed; only how full each zone is moves with the hour.
 */
function cellTarget(cellId: number, hour: number): number {
  const h = hash01(cellId);
  let weight: number;
  let circadian: number;

  if (h < 0.45) {
    // RESIDENTIAL — dense, crowds overnight, empties during the work day.
    weight = 0.55 + 0.45 * (h / 0.45);
    circadian = 0.18 + 0.82 * circ(hour, 1.5, 5);
  } else if (h < 0.78) {
    // COMMERCIAL — peaks midday, dead overnight.
    weight = 0.60 + 0.40 * ((h - 0.45) / 0.33);
    circadian = 0.08 + 0.92 * circ(hour, 13, 4);
  } else if (h < 0.92) {
    // MIXED-USE — twin commute bumps morning & evening.
    weight = 0.50;
    circadian = 0.20 + 0.60 * Math.max(circ(hour, 8, 1.8), circ(hour, 18, 3));
  } else {
    // GREEN / OPEN — sparse, gentle afternoon swell.
    weight = 0.30;
    circadian = 0.05 + 0.55 * circ(hour, 16, 4.5);
  }

  return clamp(BASE * weight * circadian, 0, 1);
}

/** A small per-place busyness curve in [0,1] over the hour-of-day. */
function placeBusyness(place: PlaceId, hour: number): number {
  switch (place) {
    case 'home':       // morning + evening occupancy at the dwelling
      return clamp(0.25 + 0.75 * Math.max(circ(hour, 7, 1.6), circ(hour, 21, 4.5)), 0, 1);
    case 'work':       // the working day, broad midday plateau
      return clamp(0.05 + 0.95 * circ(hour, 12.5, 3.2), 0, 1);
    case 'market':     // lunchtime run + after-work shop
      return clamp(0.10 + 0.85 * Math.max(circ(hour, 11, 2), circ(hour, 17.5, 2.2)), 0, 1);
    case 'thirdplace': // a little morning coffee, mostly an evening crowd
      return clamp(0.10 + 0.85 * Math.max(circ(hour, 19.5, 3), 0.5 * circ(hour, 9, 1.3)), 0, 1);
    case 'park':       // afternoon
      return clamp(0.05 + 0.80 * circ(hour, 15.5, 3.5), 0, 1);
    default:
      return 0.2;
  }
}

// =============================================================================
// createDensity — allocate the grid and pin each place to its cell.
// =============================================================================
export function createDensity(cols = 32, rows = 32): DensityField {
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  const cell = new Float32Array(c * r);

  // Seed with a plausible mid-morning state so the very first frame isn't blank;
  // stepDensity will relax it toward the live hour within ~1s.
  for (let i = 0; i < cell.length; i++) cell[i] = cellTarget(i, 8);

  const placeCell: Partial<Record<PlaceId, number>> = {};
  for (const p of PLACE_LIST) {
    const col = clamp(Math.floor(p.pos2D.x * c), 0, c - 1);
    const row = clamp(Math.floor(p.pos2D.y * r), 0, r - 1);
    placeCell[p.id] = row * c + col;
  }

  return { cols: c, rows: r, cell, t: 0, placeCell };
}

// =============================================================================
// stepDensity — relax every cell toward its time-of-day target (~1Hz).
// =============================================================================
export function stepDensity(field: DensityField, clock: number, dtReal: number): void {
  const hour = hourOf(clock);
  const k = clamp(dtReal, 0, 1); // ~1s time constant: a 1s frame ≈ full catch-up

  // Precompute the attractor bump for the handful of place cells (≤ a few).
  const attract: Record<number, number> = {};
  const ids = Object.keys(field.placeCell) as PlaceId[];
  for (const id of ids) {
    const ci = field.placeCell[id];
    if (ci === undefined || ci < 0 || ci >= field.cell.length) continue;
    attract[ci] = (attract[ci] ?? 0) + PLACE_ATTRACT * placeBusyness(id, hour);
  }

  const cells = field.cell;
  for (let i = 0; i < cells.length; i++) {
    let target = cellTarget(i, hour);
    const a = attract[i];
    if (a !== undefined) target += a;
    if (target > 1) target = 1; else if (target < 0) target = 0;
    cells[i] = lerp(cells[i], target, k);
  }

  field.t = clock;
}

// =============================================================================
// expectedAt — expected proximate-NPC count at a place right now (Poisson λ).
//   base · occupancy(placeCell) · placeBusyness(place, hour)
// =============================================================================
export function expectedAt(field: DensityField, place: PlaceId, clock: number): number {
  const hour = hourOf(clock);
  const ci = field.placeCell[place];
  const occ = (ci !== undefined && ci >= 0 && ci < field.cell.length) ? field.cell[ci] : 0;
  const base = clamp(PLACE_BY_ID[place]?.capacity ?? DEFAULT_CAP, 1, 64);
  const lambda = base * occ * placeBusyness(place, hour);
  return lambda > 0 ? lambda : 0;
}
