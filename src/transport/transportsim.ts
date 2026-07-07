// =============================================================================
// ExposomeSim — TRANSPORT FIELD: the one-call facade over the street layer.
// -----------------------------------------------------------------------------
// The world composes it; render reads view(); econ executes the tick-result
// commands. Resolution ladder:
//   Tier 0 (always, econ cadence)  — tick(): shadow commute pulse, stop queues,
//     trip arrivals, congestion relax, fleet ops, OD learning, KPIs.
//   Tier 1 (map open / high cam)   — view(): per-edge flows, schedule-time
//     vehicle positions. Pure reads of tick state.
//   Tier 2 (hot radius only)       — hotStep(): social-force pedestrians.
//     Never called cold — the smoke asserts hotSteps() === 0 unobserved.
//
// Trips are the module's atoms: planTrip prices every mode through one
// generalized cost, startTrip registers a schedule-resolved journey, posOf is
// a pure function of the clock (save/load mid-flight resolves to exactly one
// arrival), and tick() retires arrivals into OD learning + fare commands.
//
// Conservation: transport never mutates a wallet or creates a person — fares
// are commands, queues carry, and the fleet FIFO makes Σboarded == Σalighted
// + aboard exact across hot/cold flips. Determinism: one owned mulberry32
// (logit draws + pedsim's own), cursor serialized; byte-identical toJSON
// across same-seed runs is smoke-asserted.
// =============================================================================

import { mulberry32, type RNG } from '../core/util/num';
import { CausalGate, type VenuePoint } from '../causal/index';
import { StreetGraph } from './netgraph';
import { Congestion } from './congestion';
import { SignalPlan } from './signals';
import {
  Router, MODE_PARAMS, valueOfTime, generalizedCost, chooseMode, logitShares,
  DEFAULT_WAGE, type ModeOption,
} from './routing';
import { ODField } from './odfield';
import { Fleet, DEFAULT_BUS_CAPACITY, pointOnPoly } from './fleet';
import { planRoutes, type TransitRoute } from './transitplan';
import { PedSim } from './pedsim';
import { TransportHistory } from './history';
import type {
  ModeId, NetAnchor, ObserverContext, TransportTickInput, TransportTickResult,
  TransportView, TripHandle, TripLeg, TripPlan, TripRequest, XZ, TransportEvent,
  FirmDemandRow, RouteView,
} from './types';
import { MODE_IDS } from './types';

/** attention radius over stops/intersections — a bit wider than the venue
 *  gate (street scenes read from further away). */
const TRANSPORT_RADIUS = 60;
/** minimum sim-hours between gate sweeps (the causal GATE_PERIOD idiom). */
const GATE_PERIOD_H = 0.25;
/** transit network replan cadence — network design moves slowly. */
const REPLAN_PERIOD_H = 24;
/** aggregate (shadow) logit temperature, $. */
const SHADOW_T = 1.2;
/** mode-share / commute-index EMA half-lives, sim-hours. */
const SHARE_HALF_LIFE_H = 24;
const CCI_HALF_LIFE_H = 12;
/** default fatigue weight for estimates when the caller has no soma. */
const EST_FATIGUE = 0.4;
/** taxi trip circuity vs straight line, for O(1) fare estimates. */
const CIRCUITY = 1.3;
const JAM_FACTOR = 1.5;

const DEFAULT_PRICES = { busFare: 1.5, taxiBase: 2.5, taxiPerKm: 1.2, fuelPerKm: 0.15 };

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface BuiltOption { opt: ModeOption; legs: TripLeg[]; distM: number; busStops?: { o: string; d: string } }

export class TransportField {
  readonly graph: StreetGraph;
  readonly congestion: Congestion;
  readonly signals: SignalPlan;
  readonly router: Router;
  readonly od: ODField;
  readonly fleet: Fleet;
  readonly peds: PedSim;
  readonly gate: CausalGate;
  readonly history = new TransportHistory();

  private rng: RNG;
  private readonly seed: number;
  private trips = new Map<string, TripHandle>();
  private tripSeq = 0;
  private lastClock = 0;
  private lastGateH: number | null = null;
  private lastPlanH: number | null = null;
  private _hotSteps = 0;

  private prices = { ...DEFAULT_PRICES };
  private subsidy = 0;
  private busCapacity = DEFAULT_BUS_CAPACITY;
  private taxiOperatorId: string | null = null;
  private transitOperatorId: string | null = null;

  private shareEma: Record<ModeId, number> = { walk: 1, bike: 0, car: 0, taxi: 0, bus: 0 };
  private cciEma = 1;
  private tripsStartedTotal = 0;
  private tripsArrivedTotal = 0;
  private prevJam = false;

  /** gate points (stops + intersections) — built once, positions never move. */
  private gatePoints: VenuePoint[] = [];
  private stopArch = new Map<string, string>();
  private anchorPairs: [number, number][] = [];
  private baseCarH: number;

  constructor(anchors: NetAnchor[], opts: { seed?: number } = {}) {
    this.seed = (opts.seed ?? 1) >>> 0;
    this.rng = mulberry32(this.seed);
    this.graph = new StreetGraph(anchors);
    this.congestion = new Congestion(this.graph.edges.length);
    this.signals = new SignalPlan(this.graph);
    this.router = new Router(this.graph, this.congestion);
    this.od = new ODField();
    this.fleet = new Fleet();
    this.peds = new PedSim((this.seed ^ 0x9e3779b9) >>> 0);

    this.gate = new CausalGate(TRANSPORT_RADIUS);
    for (const i of this.graph.anchorNodes()) {
      const n = this.graph.nodes[i];
      const arch = `stop:${n.anchorKind ?? 'poi'}`;
      this.stopArch.set(n.id, arch);
      this.gatePoints.push({ id: n.id, x: n.x, z: n.z, archetype: arch });
    }
    for (const i of this.graph.intersections()) {
      const n = this.graph.nodes[i];
      if (n.kind === 'intersection') this.gatePoints.push({ id: n.id, x: n.x, z: n.z, archetype: 'intersection' });
    }
    const stops = this.graph.anchorNodes();
    for (let i = 0; i < stops.length; i++) for (let j = i + 1; j < stops.length; j++) {
      this.anchorPairs.push([stops[i], stops[j]]);
    }
    // free-flow baseline for the commute cost index (no load exists yet).
    this.baseCarH = Math.max(this.router.meanCarH(this.anchorPairs), 1e-6);
  }

  // ---------------------------------------------------------------------------
  // costEstimate — the arbiter's cheap read (replaces travelTime coherently).
  //   O(1) amortized: nearest-node scans over tens + cached all-pairs matrices
  //   that rebuild only on congestion regime change.
  // ---------------------------------------------------------------------------
  costEstimate(a: XZ, b: XZ, _clock: number): { durH: number; money: number } {
    const na = this.graph.nearestNode(a.x, a.z);
    const nb = this.graph.nearestNode(b.x, b.z);
    const accA = dist(a, this.graph.nodes[na]);
    const accB = dist(b, this.graph.nodes[nb]);
    const vot = valueOfTime(undefined);
    const kmLine = (Math.max(dist(a, b), 1) / 1000) * CIRCUITY;

    // the universally available set: walk, taxi (if fleet), bus (if served).
    let best: { durH: number; money: number; g: number } | null = null;
    const consider = (mode: ModeId, durH: number, money: number, distM: number) => {
      if (!Number.isFinite(durH)) return;
      const g = generalizedCost(mode, durH, money, distM, vot, EST_FATIGUE, 0);
      if (!best || g < best.g) best = { durH, money, g };
    };
    const walkH = (accA + accB) / MODE_PARAMS.walk.speed + this.router.walkH(na, nb);
    consider('walk', walkH, 0, walkH * MODE_PARAMS.walk.speed);
    if (this.fleet.taxiCount() > 0) {
      const durH = this.fleet.taxiWaitH() + (accA + accB) / MODE_PARAMS.taxi.speed + this.router.carH(na, nb);
      consider('taxi', durH, this.prices.taxiBase + this.prices.taxiPerKm * kmLine, kmLine * 1000);
    }
    const bus = this.busEstimate(a, b, na, nb);
    if (bus) consider('bus', bus.durH, bus.money, bus.distM);
    const done = best as { durH: number; money: number; g: number } | null;
    return done ? { durH: done.durH, money: done.money } : { durH: walkH, money: 0 };
  }

  /** cheapest bus journey a→b over the current network, matrix-cost only. */
  private busEstimate(a: XZ, b: XZ, na: number, nb: number):
      { durH: number; money: number; distM: number; route: TransitRoute; o: string; d: string } | null {
    let best: { durH: number; money: number; distM: number; route: TransitRoute; o: string; d: string } | null = null;
    for (const r of this.fleet.routeList()) {
      if (r.vehicles <= 0) continue;
      for (const s of r.stops) for (const t of r.stops) {
        if (s.nodeId === t.nodeId) continue;
        const walkIn = dist(a, this.graph.nodes[na]) / MODE_PARAMS.walk.speed + this.router.walkH(na, s.nodeIdx);
        const walkOut = this.router.walkH(t.nodeIdx, nb) + dist(b, this.graph.nodes[nb]) / MODE_PARAMS.walk.speed;
        const durH = walkIn + r.headwayH / 2 + this.fleet.rideDurH(r, s.nodeId, t.nodeId) + walkOut;
        if (!Number.isFinite(durH)) continue;
        if (!best || durH < best.durH) {
          best = {
            durH,
            money: this.prices.busFare * (1 - this.subsidy),
            distM: Math.abs(t.at - s.at) + (walkIn + walkOut) * MODE_PARAMS.walk.speed,
            route: r, o: s.nodeId, d: t.nodeId,
          };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // planTrip — full plan at departure: A* per mode, generalized cost, logit.
  // ---------------------------------------------------------------------------
  planTrip(req: TripRequest, _clock: number): TripPlan {
    const na = this.graph.nearestNode(req.from.x, req.from.z);
    const nb = this.graph.nearestNode(req.to.x, req.to.z);
    const vot = valueOfTime(req.wageRate);
    const fatigue = req.fatigue ?? EST_FATIGUE;
    const modes = req.modes ?? (['walk', 'taxi', 'bus'] as ModeId[]);
    const bias = (m: ModeId) => req.habitBias?.[m] ?? 0;
    const built: BuiltOption[] = [];

    const walkPath = this.router.route(na, nb, 'walk');
    for (const mode of modes) {
      if (mode === 'walk' || mode === 'bike') {
        if (!walkPath) continue;
        const poly = this.legPoly(req.from, walkPath.path, req.to);
        const distM = polyLen(poly);
        const durH = distM / MODE_PARAMS[mode].speed;
        built.push(this.opt(mode, durH, 0, distM, vot, fatigue, bias(mode),
                            [{ mode, poly, durH, money: 0 }]));
      } else if (mode === 'car' || mode === 'taxi') {
        if (mode === 'taxi' && this.fleet.taxiCount() <= 0) continue;
        const r = this.router.route(na, nb, 'car');
        if (!r) continue;
        const poly = this.legPoly(req.from, r.path, req.to);
        const distM = polyLen(poly);
        const rideH = r.durH + (dist(req.from, this.graph.nodes[na]) + dist(req.to, this.graph.nodes[nb])) / MODE_PARAMS.car.speed;
        if (mode === 'car') {
          const money = this.prices.fuelPerKm * (distM / 1000);
          built.push(this.opt('car', rideH, money, distM, vot, fatigue, bias('car'),
                              [{ mode: 'car', poly, durH: rideH, money }]));
        } else {
          const wait = this.fleet.taxiWaitH();
          if (!Number.isFinite(wait)) continue;
          const money = this.prices.taxiBase + this.prices.taxiPerKm * (distM / 1000);
          built.push(this.opt('taxi', wait + rideH, money, distM, vot, fatigue, bias('taxi'), [
            { mode: 'taxi', poly: [{ x: req.from.x, z: req.from.z }], durH: wait, money: 0 },
            { mode: 'taxi', poly, durH: rideH, money },
          ]));
        }
      } else if (mode === 'bus') {
        const est = this.busEstimate(req.from, req.to, na, nb);
        if (!est) continue;
        const r = est.route;
        const sIdx = this.graph.idx(est.o), tIdx = this.graph.idx(est.d);
        const inPath = this.router.route(na, sIdx, 'walk');
        const outPath = this.router.route(tIdx, nb, 'walk');
        if (!inPath || !outPath) continue;
        const inPoly = this.legPoly(req.from, inPath.path, this.graph.nodes[sIdx]);
        const outPoly = this.legPoly(this.graph.nodes[tIdx], outPath.path, req.to);
        const ridePoly = slicePoly(r, est.o, est.d);
        const inH = polyLen(inPoly) / MODE_PARAMS.walk.speed;
        const outH = polyLen(outPoly) / MODE_PARAMS.walk.speed;
        const waitH = r.headwayH / 2;
        const rideH = this.fleet.rideDurH(r, est.o, est.d);
        const money = est.money;
        const distM = polyLen(inPoly) + polyLen(ridePoly) + polyLen(outPoly);
        built.push({
          ...this.opt('bus', inH + waitH + rideH + outH, money, distM, vot, fatigue, bias('bus'), [
            { mode: 'walk', poly: inPoly, durH: inH, money: 0 },
            { mode: 'bus', poly: [{ x: this.graph.nodes[sIdx].x, z: this.graph.nodes[sIdx].z }], durH: waitH, money: 0 },
            { mode: 'bus', poly: ridePoly, durH: rideH, money },
            { mode: 'walk', poly: outPoly, durH: outH, money: 0 },
          ]),
          busStops: { o: est.o, d: est.d },
        });
      }
    }

    if (built.length === 0) {
      // degenerate graph/request: stand still for a beat, arrive where you are.
      const poly = [{ x: req.from.x, z: req.from.z }, { x: req.to.x, z: req.to.z }];
      const durH = dist(req.from, req.to) / MODE_PARAMS.walk.speed;
      return { mode: 'walk', legs: [{ mode: 'walk', poly, durH, money: 0 }], durH, money: 0, distM: polyLen(poly), genCost: 0 };
    }
    const chosen = chooseMode(built.map((b) => b.opt), req.traits?.openness, this.rng);
    const pick = built.find((b) => b.opt === chosen) ?? built[0];
    const plan: TripPlan = {
      mode: pick.opt.mode,
      legs: pick.legs,
      durH: pick.opt.durH,
      money: pick.opt.money,
      distM: pick.distM,
      genCost: pick.opt.g,
    };
    if (pick.busStops) plan.busStops = pick.busStops;
    return plan;
  }

  /** polyline through the graph path, book-ended by the raw endpoints. */
  private legPoly(from: XZ, path: readonly number[], to: XZ): XZ[] {
    const pts: XZ[] = [{ x: from.x, z: from.z }];
    for (const i of path) {
      const n = this.graph.nodes[i];
      const last = pts[pts.length - 1];
      if (Math.hypot(n.x - last.x, n.z - last.z) > 1e-6) pts.push({ x: n.x, z: n.z });
    }
    const last = pts[pts.length - 1];
    if (Math.hypot(to.x - last.x, to.z - last.z) > 1e-6 || pts.length === 1) pts.push({ x: to.x, z: to.z });
    return pts;
  }

  private opt(mode: ModeId, durH: number, money: number, distM: number, vot: number,
              fatigue: number, habit: number, legs: TripLeg[]): BuiltOption {
    return { opt: { mode, durH, money, g: generalizedCost(mode, durH, money, distM, vot, fatigue, habit) }, legs, distM };
  }

  // ---------------------------------------------------------------------------
  // startTrip / posOf — the journey lifecycle.
  // ---------------------------------------------------------------------------
  startTrip(plan: TripPlan, travelerId: string, clock: number): TripHandle {
    const first = plan.legs[0]?.poly[0] ?? { x: 0, z: 0 };
    const lastLeg = plan.legs[plan.legs.length - 1];
    const last = lastLeg ? lastLeg.poly[lastLeg.poly.length - 1] : first;
    const stops = plan.busStops;
    const h: TripHandle = {
      id: `t${this.tripSeq++}`,
      travelerId,
      mode: plan.mode,
      departH: clock,
      durH: plan.durH,
      money: plan.money,
      legs: plan.legs,
      oStop: stops ? stops.o : this.graph.nodes[this.graph.nearestNode(first.x, first.z)].id,
      dStop: stops ? stops.d : this.graph.nodes[this.graph.nearestNode(last.x, last.z)].id,
      operator: plan.mode === 'taxi' ? 'taxi' : null,
    };
    this.trips.set(h.id, h);
    this.tripsStartedTotal++;
    this.startedTick[plan.mode]++;

    if (plan.mode === 'car' || plan.mode === 'taxi') {
      this.depositAlong(h.legs, 1);
      if (plan.mode === 'taxi') this.fleet.noteRide(Math.max(plan.durH - this.fleet.taxiWaitH(), 0.01));
    } else if (plan.mode === 'bus') {
      // the rider joins the real queue — conservation counts them like anyone.
      this.od.arrive(h.oStop, h.dStop, 1);
    }
    return h;
  }

  /** pure schedule-time position — drives macroPos + the moving causal center. */
  posOf(h: TripHandle, clock: number): { x: number; z: number; done: boolean; mode: ModeId } {
    const legs = h.legs;
    const lastLeg = legs[legs.length - 1];
    const end = lastLeg ? lastLeg.poly[lastLeg.poly.length - 1] : { x: 0, z: 0 };
    let u = clock - h.departH;
    if (h.durH <= 1e-9 || u >= h.durH - 1e-9) return { x: end.x, z: end.z, done: true, mode: h.mode };
    if (u < 0) u = 0;
    for (const leg of legs) {
      if (u > leg.durH) { u -= leg.durH; continue; }
      if (leg.poly.length <= 1 || leg.durH <= 1e-9) {
        const p = leg.poly[0] ?? end;
        return { x: p.x, z: p.z, done: false, mode: leg.mode };
      }
      const cum: number[] = [0];
      for (let i = 1; i < leg.poly.length; i++) {
        cum.push(cum[i - 1] + Math.hypot(leg.poly[i].x - leg.poly[i - 1].x, leg.poly[i].z - leg.poly[i - 1].z));
      }
      const p = pointOnPoly(leg.poly, cum, (u / leg.durH) * cum[cum.length - 1]);
      return { x: p.x, z: p.z, done: false, mode: leg.mode };
    }
    return { x: end.x, z: end.z, done: true, mode: h.mode };
  }

  private depositAlong(legs: readonly TripLeg[], vehicles: number): void {
    // congestion deposit: rebuild the edge chain from the ride leg's vertices.
    for (const leg of legs) {
      if ((leg.mode !== 'car' && leg.mode !== 'taxi') || leg.poly.length < 2) continue;
      for (let i = 0; i + 1 < leg.poly.length; i++) {
        const a = this.graph.nearestNode(leg.poly[i].x, leg.poly[i].z);
        const b = this.graph.nearestNode(leg.poly[i + 1].x, leg.poly[i + 1].z);
        if (a === b) continue;
        for (const ei of this.graph.edgesAt(a)) {
          const e = this.graph.edges[ei];
          if (this.graph.otherEnd(e, a) === b) { this.congestion.addLoad(ei, vehicles); break; }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // tick — the econ-cadence aggregate step.
  // ---------------------------------------------------------------------------
  private startedTick: Record<ModeId, number> = { walk: 0, bike: 0, car: 0, taxi: 0, bus: 0 };

  tick(input: TransportTickInput, clock: number, dtH: number): TransportTickResult {
    const events: TransportEvent[] = [];
    this.od.beginTick();

    // ---- 0. adopt the world's prices/fleet posture --------------------------
    if (input.prices) {
      this.prices.busFare = input.prices.busFare ?? this.prices.busFare;
      this.prices.taxiBase = input.prices.taxiBase ?? this.prices.taxiBase;
      this.prices.taxiPerKm = input.prices.taxiPerKm ?? this.prices.taxiPerKm;
      this.prices.fuelPerKm = input.prices.fuelPerKm ?? this.prices.fuelPerKm;
    }
    this.subsidy = Math.min(Math.max(input.subsidy ?? 0, 0), 1);
    this.busCapacity = input.fleet?.capacityPerBus ?? this.busCapacity;
    this.taxiOperatorId = input.fleet?.taxiOperatorId ?? this.taxiOperatorId;
    this.transitOperatorId = input.fleet?.transitOperatorId ?? this.transitOperatorId;
    this.fleet.setTaxis(input.fleet?.taxis ?? this.fleet.taxiCount());
    const transitVehicles = input.fleet?.transitVehicles ?? this.fleet.routeList().reduce((s, r) => s + r.vehicles, 0);

    // ---- 1. gate sweep (throttled): stops/intersections near any center,
    //         WITH the moving centers of in-transit journeys ------------------
    if (this.lastGateH === null || clock - this.lastGateH >= GATE_PERIOD_H - 1e-9) {
      const centers = input.centers.slice();
      for (const h of this.trips.values()) {
        const p = this.posOf(h, clock);
        if (!p.done) centers.push({ id: h.id, x: p.x, z: p.z });
      }
      this.gate.update(centers, this.gatePoints, clock);
      this.lastGateH = clock;
    }

    const hour = hourOf(clock);
    let fareTaxi = 0, fareBus = 0;

    // ---- 2. shadow commute pulse: employed households on the move -----------
    this.od.setShadowRates(input.commuteOD, input.shadow.employed, hour);
    const tickShare: Record<ModeId, number> = { walk: 0, bike: 0, car: 0, taxi: 0, bus: 0 };
    let idealCar = 0, idealBike = 0, idealN = 0;
    for (const [key, rate] of this.od.shadowRates()) {
      const n = rate * dtH;
      if (!(n > 0)) continue;
      const [o, d] = key.split('>');
      const co = this.graph.idx(o), cd = this.graph.idx(d);
      if (co < 0 || cd < 0) continue;
      const split = this.shadowSplit(o, d, co, cd, input.shadow.carOwnership, input.shadow.bikeOwnership);
      for (const m of MODE_IDS) tickShare[m] += n * split.share[m];
      idealCar += split.idealCar; idealBike += split.idealBike; idealN++;
      const nBus = n * split.share.bus;
      if (nBus > 0) this.od.arrive(o, d, nBus);
      const nCar = n * split.share.car;
      if (nCar > 0) {
        const r = this.router.route(co, cd, 'car');
        if (r) for (let i = 0; i + 1 < r.path.length; i++) this.depositEdge(r.path[i], r.path[i + 1], nCar);
      }
      const nTaxi = n * split.share.taxi;
      if (nTaxi > 0) {
        this.fleet.noteRide(nTaxi * this.router.carH(co, cd));
        fareTaxi += nTaxi * (this.prices.taxiBase + this.prices.taxiPerKm * (this.router.carH(co, cd) * MODE_PARAMS.car.speed / 1000));
      }
    }

    // ---- 3. retire arrived trips: exactly one arrival each -------------------
    for (const [id, h] of this.trips) {
      if (h.departH + h.durH > clock + 1e-9) continue;
      this.trips.delete(id);
      this.tripsArrivedTotal++;
      this.od.learnTrip(h.oStop, h.dStop);       // executed trips teach the OD field
      if (h.operator === 'taxi') fareTaxi += h.money;
    }
    for (const m of MODE_IDS) { tickShare[m] += this.startedTick[m]; this.startedTick[m] = 0; }

    // ---- 4. transit operations: alight → board, fares at the door ------------
    const tt = this.fleet.transitTick(this.od, dtH, clock);
    fareBus += tt.boarded * this.prices.busFare * (1 - this.subsidy);
    const gaveUp = this.od.giveUp(this.fleet.servedPairs(), dtH);
    if (gaveUp > 1) events.push({ t: clock, kind: 'strand', label: `${gaveUp.toFixed(1)} riders gave up waiting` });

    // ---- 5. hot stops teach the surrogate (exogenous arrivals only — the
    //         echo-chamber rule: nothing here was generated FROM the stats) ----
    for (const [stopId, arch] of this.stopArch) {
      if (this.gate.isHot(stopId)) this.od.observeHot(stopId, arch, hour, dtH);
    }

    // ---- 6. replan the network on the slow cadence ---------------------------
    if (this.lastPlanH === null || clock - this.lastPlanH >= REPLAN_PERIOD_H - 1e-9) {
      const before = routeSig(this.fleet.routeList());
      const routes = transitVehicles > 0
        ? planRoutes(this.graph, this.router, this.od.topFlows(8), transitVehicles, this.busCapacity)
        : [];
      if (routeSig(routes) !== before) {
        this.fleet.setRoutes(routes);
        events.push({
          t: clock, kind: routes.length > 0 ? 'replan' : 'service',
          label: routes.length > 0
            ? `network replanned: ${routes.length} line(s), ${routes.reduce((s, r) => s + r.vehicles, 0)} vehicle(s)`
            : 'transit service withdrawn',
        });
      }
      this.lastPlanH = clock;
    }

    // ---- 7. relax the physics + the learned surfaces --------------------------
    this.congestion.tick(dtH);
    this.fleet.tickTaxi(dtH);
    this.od.decay(dtH);

    const meanF = this.congestion.meanFactor();
    const jam = meanF > JAM_FACTOR;
    if (jam && !this.prevJam) events.push({ t: clock, kind: 'jam', label: `congestion ${meanF.toFixed(2)}× free flow` });
    this.prevJam = jam;

    // ---- 8. KPIs ---------------------------------------------------------------
    const totalTick = MODE_IDS.reduce((s, m) => s + tickShare[m], 0);
    if (totalTick > 1e-9) {
      const lam = 1 - Math.pow(0.5, dtH / SHARE_HALF_LIFE_H);
      for (const m of MODE_IDS) this.shareEma[m] += lam * (tickShare[m] / totalTick - this.shareEma[m]);
    }
    // half congestion (time vs free flow), half fare level — so a jam OR a
    // fare hike both push the index above its calm-town baseline.
    const cciNow = 0.5 * (this.router.meanCarH(this.anchorPairs) / this.baseCarH)
                 + 0.5 * (this.prices.busFare * (1 - this.subsidy)) / DEFAULT_PRICES.busFare;
    this.cciEma += (1 - Math.pow(0.5, dtH / CCI_HALF_LIFE_H)) * (cciNow - this.cciEma);

    // ---- 9. record + command -----------------------------------------------------
    this.history.record({
      t: clock,
      tripsStarted: this.tripsStartedTotal,
      tripsArrived: this.tripsArrivedTotal,
      shareWalk: this.shareEma.walk, shareBike: this.shareEma.bike, shareCar: this.shareEma.car,
      shareTaxi: this.shareEma.taxi, shareBus: this.shareEma.bus,
      congestion: meanF,
      commuteCost: this.cciEma,
      boarded: tt.boarded,
      aboard: this.fleet.aboard(),
      waiting: this.od.waitingSum(),
      taxiUtil: this.fleet.taxiUtil(),
      taxiWaitH: this.fleet.taxiCount() > 0 ? this.fleet.taxiWaitH() : 0,
      fare: fareTaxi + fareBus,
      routes: this.fleet.routeList().length,
    });
    for (const e of events) this.history.event(e.t, e.kind, e.label);

    const fareRevenue: TransportTickResult['fareRevenue'] = [];
    if (fareTaxi > 1e-9 && this.taxiOperatorId) fareRevenue.push({ operatorId: this.taxiOperatorId, amount: fareTaxi });
    if (fareBus > 1e-9 && this.transitOperatorId) fareRevenue.push({ operatorId: this.transitOperatorId, amount: fareBus });

    const hires: FirmDemandRow[] = [];
    if (this.taxiOperatorId && this.fleet.taxiUtil() > 0.75) {
      hires.push({ id: this.taxiOperatorId, name: 'taxi co', sector: 'transit',
                   wage: DEFAULT_WAGE, headcount: this.fleet.taxiCount(), desired: this.fleet.taxiCount() + 1 });
    }
    if (this.transitOperatorId && transitVehicles > 0
        && this.od.waitingSum() > transitVehicles * this.busCapacity) {
      hires.push({ id: this.transitOperatorId, name: 'transit authority', sector: 'transit',
                   wage: DEFAULT_WAGE, headcount: transitVehicles, desired: transitVehicles + 1 });
    }

    this.lastClock = clock;
    return {
      fareRevenue,
      vehicleDemandSignal: {
        car: idealN > 0 ? Math.max(0, idealCar / idealN - input.shadow.carOwnership) : 0,
        bike: idealN > 0 ? Math.max(0, idealBike / idealN - input.shadow.bikeOwnership) : 0,
      },
      hires,
      commuteCostIndex: this.cciEma,
      historyEvents: events,
    };
  }

  /** aggregate mode split for one shadow OD pair — ownership-segmented logit. */
  private shadowSplit(o: string, d: string, co: number, cd: number,
                      carOwn: number, bikeOwn: number):
      { share: Record<ModeId, number>; idealCar: number; idealBike: number } {
    const vot = valueOfTime(undefined);
    const walkH = this.router.walkH(co, cd);
    const carH = this.router.carH(co, cd);
    const kmCar = (carH * MODE_PARAMS.car.speed) / 1000;
    const optOf = (mode: ModeId): ModeOption | null => {
      switch (mode) {
        case 'walk': return mk('walk', walkH, 0, walkH * MODE_PARAMS.walk.speed);
        case 'bike': return mk('bike', walkH * MODE_PARAMS.walk.speed / MODE_PARAMS.bike.speed, 0, walkH * MODE_PARAMS.walk.speed);
        case 'car': return mk('car', carH, this.prices.fuelPerKm * kmCar, kmCar * 1000);
        case 'taxi': {
          if (this.fleet.taxiCount() <= 0) return null;
          const w = this.fleet.taxiWaitH();
          if (!Number.isFinite(w)) return null;
          return mk('taxi', w + carH, this.prices.taxiBase + this.prices.taxiPerKm * kmCar, kmCar * 1000);
        }
        case 'bus': {
          const r = this.fleet.serving(o, d);
          if (!r) return null;
          const rideH = this.fleet.rideDurH(r, o, d);
          return mk('bus', r.headwayH / 2 + rideH,
                    this.prices.busFare * (1 - this.subsidy), rideH * MODE_PARAMS.bus.speed);
        }
      }
      return null;
    };
    const mk = (mode: ModeId, durH: number, money: number, distM: number): ModeOption =>
      ({ mode, durH, money, g: generalizedCost(mode, durH, money, distM, vot, EST_FATIGUE, 0) });

    const share: Record<ModeId, number> = { walk: 0, bike: 0, car: 0, taxi: 0, bus: 0 };
    const segments: { w: number; modes: ModeId[] }[] = [
      { w: carOwn, modes: ['walk', 'bike', 'car', 'taxi', 'bus'] },
      { w: (1 - carOwn) * bikeOwn, modes: ['walk', 'bike', 'taxi', 'bus'] },
      { w: (1 - carOwn) * (1 - bikeOwn), modes: ['walk', 'taxi', 'bus'] },
    ];
    for (const seg of segments) {
      if (!(seg.w > 0)) continue;
      const opts = seg.modes.map(optOf).filter((x): x is ModeOption => !!x);
      if (opts.length === 0) continue;
      const shares = logitShares(opts, SHADOW_T);
      for (let i = 0; i < opts.length; i++) share[opts[i].mode] += seg.w * shares[i];
    }
    // latent demand: what car/bike would take if everyone had one.
    const all = (['walk', 'bike', 'car', 'taxi', 'bus'] as ModeId[]).map(optOf).filter((x): x is ModeOption => !!x);
    const allShares = logitShares(all, SHADOW_T);
    let idealCar = 0, idealBike = 0;
    for (let i = 0; i < all.length; i++) {
      if (all[i].mode === 'car') idealCar = allShares[i];
      if (all[i].mode === 'bike') idealBike = allShares[i];
    }
    return { share, idealCar, idealBike };
  }

  private depositEdge(a: number, b: number, vehicles: number): void {
    for (const ei of this.graph.edgesAt(a)) {
      const e = this.graph.edges[ei];
      if (this.graph.otherEnd(e, a) === b) { this.congestion.addLoad(ei, vehicles); return; }
    }
  }

  // ---------------------------------------------------------------------------
  // hotStep — per-frame microscopic step; the WORLD calls it only when the hot
  // set is nonempty. A cold run must leave hotSteps() at exactly 0.
  // ---------------------------------------------------------------------------
  hotStep(dtH: number, obs: ObserverContext): void {
    this._hotSteps++;
    this.peds.step(dtH, obs.clock, this.signals, this.graph);
  }

  hotSteps(): number { return this._hotSteps; }

  // ---------------------------------------------------------------------------
  // view — the render/observatory snapshot.
  // ---------------------------------------------------------------------------
  view(): TransportView {
    const routes: RouteView[] = this.fleet.routeList().map((r) => {
      const vehicles: XZ[] = [];
      for (let v = 0; v < r.vehicles; v++) vehicles.push(this.fleet.vehiclePos(r, v, this.lastClock));
      return { id: r.id, stops: r.stops.map((s) => s.nodeId), poly: r.poly, vehicles, headwayH: r.headwayH };
    });
    const signals = this.signals.controllers.map((c, i) => ({
      id: c.id, x: c.x, z: c.z, phase: this.signals.phaseAt(i, this.lastClock),
    }));
    const stops: TransportView['stops'] = [];
    for (const [stopId, arch] of this.stopArch) {
      stops.push({ ...this.od.stats.statsView(stopId, arch), waiting: this.od.waitingAt(stopId) });
    }
    const trips: TransportView['trips'] = [];
    for (const h of this.trips.values()) {
      const p = this.posOf(h, this.lastClock);
      trips.push({ id: h.id, travelerId: h.travelerId, mode: p.mode, x: p.x, z: p.z });
    }
    return {
      nodes: this.graph.nodes.map((n) => ({ id: n.id, x: n.x, z: n.z, kind: n.kind })),
      edges: this.graph.edges.map((e, i) => ({
        id: e.id, a: e.a, b: e.b, sidewalk: e.sidewalk, lengthM: e.lengthM,
        load: this.congestion.loadOf(i), factor: this.congestion.factor(i),
      })),
      routes,
      signals,
      stops,
      hot: [...this.gate.hotList()],
      trips,
      kpis: {
        commuteCostIndex: this.cciEma,
        congestion: this.congestion.meanFactor(),
        taxiUtil: this.fleet.taxiUtil(),
        taxiWaitH: this.fleet.taxiCount() > 0 ? this.fleet.taxiWaitH() : 0,
        aboard: this.fleet.aboard(),
        waiting: this.od.waitingSum(),
        modeShare: { ...this.shareEma },
        tripsStarted: this.tripsStartedTotal,
        tripsArrived: this.tripsArrivedTotal,
      },
      history: this.history.view(),
    };
  }

  // ---------------------------------------------------------------------------
  // persistence — trips serialize like active conversations; the rng cursor,
  // gate hysteresis, carries and EMAs ARE the state.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      seed: this.seed,
      rng: this.rng.save ? this.rng.save() : 0,
      tripSeq: this.tripSeq,
      lastClock: r6(this.lastClock),
      lastGateH: this.lastGateH === null ? null : r6(this.lastGateH),
      lastPlanH: this.lastPlanH === null ? null : r6(this.lastPlanH),
      hotSteps: this._hotSteps,
      started: this.tripsStartedTotal,
      arrived: this.tripsArrivedTotal,
      prices: { ...this.prices },
      subsidy: r6(this.subsidy),
      busCap: this.busCapacity,
      ops: [this.taxiOperatorId, this.transitOperatorId],
      share: MODE_IDS.map((m) => r6(this.shareEma[m])),
      pendShare: MODE_IDS.map((m) => this.startedTick[m]),
      cci: r6(this.cciEma),
      jam: this.prevJam ? 1 : 0,
      trips: [...this.trips.values()].map(tripJSON),
      gate: this.gate.toJSON(),
      od: this.od.toJSON(),
      congestion: this.congestion.toJSON(),
      fleet: this.fleet.toJSON(),
      peds: this.peds.toJSON(),
      history: this.history.toJSON(),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as Record<string, unknown> | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    this.tripSeq = numOr(o.tripSeq, 0);
    this.lastClock = numOr(o.lastClock, 0);
    this.lastGateH = typeof o.lastGateH === 'number' ? o.lastGateH : null;
    this.lastPlanH = typeof o.lastPlanH === 'number' ? o.lastPlanH : null;
    this._hotSteps = numOr(o.hotSteps, 0);
    this.tripsStartedTotal = numOr(o.started, 0);
    this.tripsArrivedTotal = numOr(o.arrived, 0);
    const pr = o.prices as Record<string, number> | undefined;
    if (pr) this.prices = { busFare: numOr(pr.busFare, DEFAULT_PRICES.busFare), taxiBase: numOr(pr.taxiBase, DEFAULT_PRICES.taxiBase), taxiPerKm: numOr(pr.taxiPerKm, DEFAULT_PRICES.taxiPerKm), fuelPerKm: numOr(pr.fuelPerKm, DEFAULT_PRICES.fuelPerKm) };
    this.subsidy = numOr(o.subsidy, 0);
    this.busCapacity = numOr(o.busCap, DEFAULT_BUS_CAPACITY);
    if (Array.isArray(o.ops)) {
      this.taxiOperatorId = typeof o.ops[0] === 'string' ? o.ops[0] : null;
      this.transitOperatorId = typeof o.ops[1] === 'string' ? o.ops[1] : null;
    }
    if (Array.isArray(o.share)) MODE_IDS.forEach((m, i) => { this.shareEma[m] = numOr((o.share as unknown[])[i], 0); });
    if (Array.isArray(o.pendShare)) MODE_IDS.forEach((m, i) => { this.startedTick[m] = numOr((o.pendShare as unknown[])[i], 0); });
    this.cciEma = numOr(o.cci, 1);
    this.prevJam = o.jam === 1;
    this.trips.clear();
    if (Array.isArray(o.trips)) for (const row of o.trips) {
      const h = tripLoad(row);
      if (h) this.trips.set(h.id, h);
    }
    this.gate.loadJSON(o.gate);
    this.od.loadJSON(o.od);
    this.congestion.loadJSON(o.congestion);
    this.fleet.loadJSON(o.fleet, this.graph, this.router);
    this.peds.loadJSON(o.peds);
    this.history.loadJSON(o.history);
  }
}

// ---- helpers -------------------------------------------------------------------

function tripJSON(h: TripHandle): unknown {
  return {
    id: h.id, tr: h.travelerId, m: h.mode, dep: r6(h.departH), dur: r6(h.durH),
    money: r6(h.money), o: h.oStop, d: h.dStop, op: h.operator,
    legs: h.legs.map((l) => ({ m: l.mode, dur: r6(l.durH), money: r6(l.money), poly: l.poly.map((p) => [r4(p.x), r4(p.z)]) })),
  };
}

function tripLoad(row: unknown): TripHandle | null {
  const o = row as Record<string, unknown> | null;
  if (!o || typeof o.id !== 'string') return null;
  const legs: TripLeg[] = [];
  if (Array.isArray(o.legs)) for (const lr of o.legs) {
    const l = lr as Record<string, unknown>;
    const poly: XZ[] = [];
    if (Array.isArray(l.poly)) for (const p of l.poly) {
      if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') poly.push({ x: p[0], z: p[1] });
    }
    legs.push({ mode: (l.m as ModeId) ?? 'walk', durH: numOr(l.dur, 0), money: numOr(l.money, 0), poly });
  }
  return {
    id: o.id,
    travelerId: typeof o.tr === 'string' ? o.tr : '',
    mode: (o.m as ModeId) ?? 'walk',
    departH: numOr(o.dep, 0),
    durH: numOr(o.dur, 0),
    money: numOr(o.money, 0),
    legs,
    oStop: typeof o.o === 'string' ? o.o : '',
    dStop: typeof o.d === 'string' ? o.d : '',
    operator: o.op === 'taxi' ? 'taxi' : null,
  };
}

function routeSig(routes: readonly TransitRoute[]): string {
  return routes.map((r) => `${r.id}:${r.nodePath.join(',')}:${r.vehicles}`).join('|');
}

/** ride polyline between two stops of a route (direction-aware slice). */
function slicePoly(r: TransitRoute, o: string, d: string): XZ[] {
  let ao = -1, ad = -1;
  for (const s of r.stops) {
    if (s.nodeId === o) ao = s.at;
    if (s.nodeId === d) ad = s.at;
  }
  if (ao < 0 || ad < 0) return r.poly.slice();
  const lo = Math.min(ao, ad), hi = Math.max(ao, ad);
  const cum0: number[] = [0];
  for (let i = 1; i < r.poly.length; i++) {
    cum0.push(cum0[i - 1] + Math.hypot(r.poly[i].x - r.poly[i - 1].x, r.poly[i].z - r.poly[i - 1].z));
  }
  const pts: XZ[] = [pointOnPoly(r.poly, cum0, lo)];
  for (let i = 0; i < r.poly.length; i++) {
    if (cum0[i] > lo + 1e-9 && cum0[i] < hi - 1e-9) pts.push({ x: r.poly[i].x, z: r.poly[i].z });
  }
  pts.push(pointOnPoly(r.poly, cum0, hi));
  if (ao > ad) pts.reverse();
  return pts;
}

function polyLen(poly: readonly XZ[]): number {
  let s = 0;
  for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
  return s;
}

function dist(a: XZ, b: XZ): number { return Math.hypot(a.x - b.x, a.z - b.z); }

function hourOf(clock: number): number { return ((Math.floor(clock) % 24) + 24) % 24; }

function numOr(x: unknown, d: number): number { return typeof x === 'number' && Number.isFinite(x) ? x : d; }
