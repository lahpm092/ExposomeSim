// =============================================================================
// ExposomeSim — TRANSPORT shared contract.
// -----------------------------------------------------------------------------
// Pure types for the street/mode/crowd layer (TRANSPORT_DESIGN.md). Everything
// under src/transport/ imports ONLY this file + core/util + src/causal — no
// THREE, no DOM, no econ classes, no world. The world composes the module;
// the render reads view(); econ executes the tick-result COMMANDS (transport
// itself never moves money, people or votes — it only reports flows).
//
// Units: positions are WORLD METRES on the XZ plane ((townCoord−0.5)·66 for
// the core places); every dt is SIM-HOURS; every rate is per-sim-hour.
// =============================================================================

import type { VenueStatsView } from '../causal/types';
import type { Money, AgentId } from '../econ/types';

/** the five travel modes. Availability is ownership/service-gated, never scripted. */
export type ModeId = 'walk' | 'bike' | 'car' | 'taxi' | 'bus';
export const MODE_IDS: readonly ModeId[] = ['walk', 'bike', 'car', 'taxi', 'bus'];

export interface XZ { x: number; z: number }

/** what the world hands the graph builder: a named point that must be on the
 *  network — the five PLACES, the off-core anchors (supermarket/fed/bank/
 *  office), build lots. `kind` pools stop statistics ('place'|'poi'|'lot'…). */
export interface NetAnchor { id: string; x: number; z: number; kind: string }

export interface NetNode {
  id: string;                       // anchor id, or 'x<n>' for generated crossings
  x: number;
  z: number;
  kind: 'anchor' | 'intersection';
  anchorKind?: string;              // the NetAnchor.kind, for anchor nodes
}

export interface NetEdge {
  id: string;
  a: string; b: string;             // node ids
  ai: number; bi: number;           // node indices (hot-path adjacency)
  lengthM: number;
  sidewalk: boolean;                // walkable kerb — core blocks yes, arterials no
  modes: ModeId[];
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

/** trait readouts a traveler carries into mode choice / crowd behavior. */
export interface TravelerTraits {
  openness?: number;                // 0..1 → logit temperature (exploration)
}

export interface TripRequest {
  from: XZ;
  to: XZ;
  /** $/sim-h — VoT derives from it (walletOf → wage). Default modest wage. */
  wageRate?: number;
  /** 0..1 current fatigue — scales the energy term of walking/cycling. */
  fatigue?: number;
  traits?: TravelerTraits;
  /** ownership-gated available modes. Default: walk + taxi + bus (nobody owns). */
  modes?: ModeId[];
  /** $-equivalent per-mode bias from memory salience (negative favors a mode) —
   *  the recall('bus stop ride taxi bike') habit channel; world supplies it. */
  habitBias?: Partial<Record<ModeId, number>>;
}

export interface TripLeg {
  mode: ModeId;                     // 'walk' access legs inside a bus/taxi trip
  poly: XZ[];                       // polyline in world metres; 1 point = stand
  durH: number;
  money: Money;
}

export interface TripPlan {
  mode: ModeId;                     // the chosen primary mode
  legs: TripLeg[];
  durH: number;                     // Σ leg durations
  money: Money;                     // Σ leg fares/fuel
  distM: number;
  genCost: number;                  // the generalized cost that won the logit
  /** the boarding/alighting stops of a bus plan — OD learning keys. */
  busStops?: { o: string; d: string };
}

/** a live journey — serialized like an active conversation, so save/load
 *  mid-flight resolves to exactly one arrival. posOf() is pure in the clock. */
export interface TripHandle {
  id: string;
  travelerId: AgentId;
  mode: ModeId;
  departH: number;
  durH: number;
  money: Money;
  legs: TripLeg[];
  oStop: string;                    // nearest graph nodes — OD learning keys
  dStop: string;
  operator: 'taxi' | null;          // taxi fares settle at arrival; bus at boarding
}

// ---------------------------------------------------------------------------
// Tick I/O — the facade's econ-cadence contract with the world
// ---------------------------------------------------------------------------

export interface TransportTickInput {
  /** causal centers: Tier-A positions INCLUDING in-transit ones + the observer. */
  centers: { id: string; x: number; z: number }[];
  /** shadow-population aggregates (econ-derived ground truth, never surrogate). */
  shadow: {
    households: number;
    employed: number;
    carOwnership: number;           // 0..1 fraction of households
    bikeOwnership: number;          // 0..1
  };
  /** where the shadow commute flows: anchor-id pairs with weights (~sum 1).
   *  The 8h/18h bump SHAPE lives in this module; the endpoints are econ's. */
  commuteOD?: { from: string; to: string; weight: number }[];
  prices?: {
    busFare?: Money;
    taxiBase?: Money;
    taxiPerKm?: Money;
    fuelPerKm?: Money;
  };
  fleet?: {
    taxis?: number;
    taxiOperatorId?: string;
    transitVehicles?: number;
    transitOperatorId?: string;
    capacityPerBus?: number;
  };
  /** gov transit subsidy in force — 0..1 fare discount riders see. */
  subsidy?: number;
}

/** hiring pressure row (structural mirror of econ FirmDemand — the world/econ
 *  adapter fills the callback fields; sector string until econ adds 'transit'). */
export interface FirmDemandRow {
  id: string;
  name: string;
  sector: string;
  wage: Money;
  headcount: number;
  desired: number;
}

export type TransportEventKind = 'replan' | 'jam' | 'strand' | 'service';

export interface TransportEvent { t: number; kind: TransportEventKind; label: string }

/** COMMANDS for the world/econ — transport moves no money itself. */
export interface TransportTickResult {
  fareRevenue: { operatorId: string; amount: Money }[];
  /** dealer restock pressure 0..1 per vehicle good — latent demand minus ownership. */
  vehicleDemandSignal: { car: number; bike: number };
  hires: FirmDemandRow[];
  /** the politics loop input — congested, expensive commutes raise it above 1. */
  commuteCostIndex: number;
  historyEvents: TransportEvent[];
}

/** the camera/attention back-channel for hotStep (per-frame, hot only). */
export interface ObserverContext {
  x: number;
  z: number;
  clock: number;                    // absolute sim-hours (signals need it)
  mapOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Pedestrians (Tier-2 micro, hotStep-only)
// ---------------------------------------------------------------------------

/** trait inputs for signal compliance — conscientiousness complies,
 *  impulsivity jaywalks (deriveNeuro projection; world supplies them). */
export interface PedTraits { conscientiousness: number; impulsivity: number }

export interface PedFigure {
  id: string;
  x: number; z: number;             // world metres
  vx: number; vz: number;           // m/s (micro integrator's native unit)
  gx: number; gz: number;           // goal
  traits: PedTraits;
  state: 'go' | 'wait' | 'done';
  sig: number;                      // controller idx currently latched (-1 none)
  sigChoice: 0 | 1 | 2;             // 0 undecided · 1 comply · 2 jaywalk
}

// ---------------------------------------------------------------------------
// View — the render/observatory snapshot (read-only, plain data)
// ---------------------------------------------------------------------------

export interface TransportHistoryView {
  version: number;
  n: number;
  stride: number;
  fields: readonly string[];
  data: number[][];
  events: TransportEvent[];
}

export interface RouteView {
  id: string;
  stops: string[];
  poly: XZ[];
  vehicles: XZ[];                   // schedule-time positions at the last tick clock
  headwayH: number;
}

export interface TransportView {
  nodes: { id: string; x: number; z: number; kind: string }[];
  edges: { id: string; a: string; b: string; sidewalk: boolean; lengthM: number; load: number; factor: number }[];
  routes: RouteView[];
  signals: { id: string; x: number; z: number; phase: number }[];
  /** per-stop learned surrogate + live queue (explicit ids — no archetype join). */
  stops: (VenueStatsView & { waiting: number })[];
  hot: string[];
  trips: { id: string; travelerId: string; mode: ModeId; x: number; z: number }[];
  kpis: {
    commuteCostIndex: number;
    congestion: number;             // mean BPR factor (1 = free flow)
    taxiUtil: number;
    taxiWaitH: number;
    aboard: number;
    waiting: number;
    modeShare: Record<ModeId, number>;
    tripsStarted: number;
    tripsArrived: number;
  };
  history: TransportHistoryView;
}
