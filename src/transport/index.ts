// =============================================================================
// ExposomeSim — TRANSPORT: public surface.
// -----------------------------------------------------------------------------
// The world composes TransportField; the render reads its view() and the
// graph; econ executes its tick-result commands. The parts stay individually
// reachable (readonly fields on the facade) because the renderer wants the
// graph/signals directly and the observatory wants the history — the facade
// composes, it does not hide.
// =============================================================================

export { TransportField } from './transportsim';
export { StreetGraph } from './netgraph';
export { Router, MODE_PARAMS, valueOfTime, generalizedCost, chooseMode, logitShares } from './routing';
export { Congestion } from './congestion';
export { SignalPlan, type SignalController } from './signals';
export { ODField, commuteBump, TRIPS_PER_EMPLOYED_H, type ODFlow } from './odfield';
export { Fleet, DEFAULT_BUS_CAPACITY, pointOnPoly } from './fleet';
export { planRoutes, buildRoute, routeServes, MAX_ROUTES, type TransitRoute } from './transitplan';
export { PedSim, jaywalkP } from './pedsim';
export { TransportHistory, THIST_FIELDS, type THistField } from './history';
export type {
  ModeId, XZ, NetAnchor, NetNode, NetEdge,
  TravelerTraits, TripRequest, TripLeg, TripPlan, TripHandle,
  TransportTickInput, TransportTickResult, FirmDemandRow,
  TransportEvent, TransportEventKind, ObserverContext,
  PedTraits, PedFigure,
  TransportView, TransportHistoryView, RouteView,
} from './types';
export { MODE_IDS } from './types';
