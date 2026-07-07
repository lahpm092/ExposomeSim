# ExposomeSim — TRANSPORT: streets, modes, crowds, and the price of distance

`src/transport/` — a pure module (no THREE, no DOM, no world imports),
sibling of `causal/` and `gov/`: `core ← {llm, mind, econ, causal, gov,
transport} ← world ← persist`. The world composes it; render *reads* it.

## The thesis

Today distance is telescoped: `travelTime()` (places.ts:210) clamps every
journey into [0.15, 0.5] sim-h regardless of geometry, the nine roster agents
teleport (`commuteT: 0`, society.ts:534), and streets are seven hardcoded
decorative edges (citystage.ts:46). Transport makes distance REAL — and
priced. Everything downstream (mode choice, dealerships, taxis, transit,
signal crowds, and the political demand for public transport that
`src/gov/` feeds on) emerges from one substitution: a street graph with a
generalized cost, replacing the telescoped stub.

No timetable behaviors are scripted. Modal split, transit routes, fleet
sizes, and ridership all emerge from prices, congestion, traits, and memory.

## Resolution ladder (the efficiency contract)

| Tier | What runs | When | Cost |
|------|-----------|------|------|
| 0 — bookkeeping | trips as (departure, arrival, mode, cost) events; arrival times sampled from the learned surrogate; OD-field EMAs | always (econ-tick cadence, keyed off `economy.tickSeq`) | O(active trips + stops) per hour |
| 1 — mesoscopic | per-edge flow densities animated on the 2D map | only while `CityView.isOpen` or free-cam altitude above a threshold | O(edges) per frame, no bodies |
| 2 — microscopic | vehicle kinematics, signal cycles, social-force pedestrians, boarding beats | only inside the hot radius (own `CausalGate` over stops/intersections; centers = Tier-A positions **including in-transit ones** + the camera-observer) | O(hot entities) per frame |

A Tier-A agent riding a bus IS a causal center — the hot radius travels with
the vehicle (extend `causalCenters()`, town.ts:252). The camera becomes a
sim-side observer via a new `town.setObserver(camX, camZ, mapOpen)`
back-channel beside `setFocus` (main.ts:93). Flip hygiene: hysteresis via
`CausalGate` (radius per entity class), 4 Hz sweeps (the buildsite.ts:52
pattern), and cold→hot transitions must not spawn teleporting vehicles —
positions interpolate from schedule-time.

## Subsystems

### netgraph — the one true street graph
Nodes: the five PLACES (world metres via `(p−0.5)·66`), the off-core anchors
(supermarket (0,0,−78), fed (0,0,112), bank (−50,0,110), office (26,0,4)),
BUILD_LOTS, plus generated intersection nodes where segments cross. Edges
carry length, modes allowed, base speeds, and live load. This module becomes
the single source both `citystage.ts` and `cityview.ts` render from (their
duplicated `STREETS` literals die). Pure data + math; render imports it
read-only (as render already imports econ types).

### routing + mode choice — the price of distance
A* over the graph per mode; generalized cost
`g = time·VoT + money + energyCost·fatigue + comfort(traits) + habitBias`,
with VoT derived from the agent's wage (walletOf), habitBias from
`recall('bus stop ride taxi bike', 3)` mean salience — the town.ts:334
habit pattern, so one bad ride causally suppresses ridership. Logit choice
over available modes (ownership-gated). `costEstimate(a,b,clock)` is a
cached cheap matrix the arbiter's K_TRAVEL term reads — replacing
`travelTime()` coherently in BOTH decision and execution (the places.ts:210
seam). Congestion: BPR-style edge delay from load (simulated + shadow flows)
feeding back into cost — and into gov's `commuteCostIndex` (the
politics loop).

### odfield — learned demand
VenueStats-style hour-bucketed EMAs (stats.ts hierarchy: stop ⊕
stop-archetype ⊕ flat), learned ONLY from hot/executed trips; shadow commute
demand derived from econ employed-household counts and the density grid's
8h/18h mixed-use bumps (city.ts:78). Conservation-with-carry at every stop:
the carry IS the queue (flow.ts pattern); Σ boarded === Σ alighted +
in-transit, to 1e-6.

### fleet + operators — the economy of movement
- **Dealers**: `car` and `bike` become GoodIds; dealers are plain retail
  Businesses with shelves (RETAIL_SHELF, config.ts:290) restocking from
  WholesaleMarkets whose import channel models out-of-town manufacture.
  Shadow households buy via the exact durable-wear mechanism
  (shadowpop.ts:310): a `vehicleWear`-style accumulator + budget gate.
  Ownership flags gate mode availability — the modal split emerges from
  wealth. Tier-A: a `buy_vehicle` affordance (market, while dealer-stocked).
- **Taxis**: a service Business (capacityPerWorker = rides/driver-hour);
  `decide()` gives emergent fleet staffing. Hot: dispatched cab entities;
  cold: waiting time sampled from fleet utilization. Drivers hire through
  the LaborMarket; a hot ride's driver is `sampleProfile(seed keyed by cab
  id)` + MindLite.
- **Transit authority**: founded EITHER privately (extend `maybeFoundFirm`
  signals: persistent high commute cost = the shortage) OR publicly (a gov
  spend order seeds it from the treasury, bypassing the wealth gate,
  econsim.ts:805 machinery). Whichever triggers first — the race is real.
  Routes are synthesized from the OD field's top flows (`transitplan.ts`),
  re-planned on a slow cadence — network design emerges from demand.
  Vehicle capex borrows via `Financier` (construction.ts:26): dear money
  delays fleet expansion for free.

### signals + pedestrians — the street as a place
Intersection controllers (fixed cycles first; actuated later) exist as data
always, simulated only in Tier 2. Pedestrian dynamics: social-force
(goal attraction + inter-agent repulsion + wall/kerb repulsion + signal
compliance) on a spatial hash, for hot figures only. Signal compliance is a
trait readout — conscientiousness complies, impulsivity jaywalks
(deriveNeuro, params.ts:182): behavior↔phenotype coupling, measurable in
the exposome. Crowd stress (crush, near-miss) routes through
`socialThreat`/`applyNeedFeedback` — commuting causally wears on the soma.
NpcLite figures gain `wait_signal`/`board`/`alight` goal tokens; the
VenueFlowTick discrete arrivals Town currently discards (town.ts:244)
become the spawn source for street figures — transport is the first
consumer of the causal layer's return value.

## Module contract

`src/transport/` files — pure, importing only `core/` (+ `econ/types` types):
`types.ts`, `netgraph.ts`, `routing.ts`, `odfield.ts`, `congestion.ts`,
`fleet.ts` (taxi/transit operations), `transitplan.ts`, `signals.ts`,
`pedsim.ts` (social force), `transportsim.ts` + `index.ts` (facade),
`history.ts`.

```ts
class TransportField {
  constructor(anchors: NetAnchor[], opts?: { seed?: number });
  readonly graph: StreetGraph;
  /** cheap cached cost for the arbiter (replaces travelTime coherently). */
  costEstimate(a: XZ, b: XZ, clock: number): { durH: number; money: number };
  /** full plan at departure: mode, legs (polyline), duration, price. */
  planTrip(req: TripRequest, clock: number): TripPlan;
  startTrip(plan: TripPlan, travelerId: string, clock: number): TripHandle;
  /** drives macroPos + the moving causal center; pure function of clock. */
  posOf(h: TripHandle, clock: number): { x: number; z: number; done: boolean; mode: ModeId };
  /** econ-cadence tick: OD learning, congestion relax, fleets, transit ops. */
  tick(input: TransportTickInput, clock: number, dtH: number): TransportTickResult;
  /** per-frame microscopic step — called ONLY when hot set nonempty. */
  hotStep(dtH: number, obs: ObserverContext): void;
  view(): TransportView;   // edge flows, hot entities, stop stats, KPIs
  toJSON(): unknown; loadJSON(j: unknown): void;
}
```

`TransportTickInput`: shadow employment/ownership aggregates, econ prices
(fare, fuel proxy), venue/stop centers, hot centers, gov subsidy in force.
`TransportTickResult` (commands, executed by world/econ — transport moves no
money): `fareRevenue { operatorId, amount }[]` (econ credits firms, debits
riders/shadow), `vehicleDemandSignal` (dealer restock pressure),
`hires FirmDemandRow[]`, `commuteCostIndex` (gov input), `historyEvents`.

Trips by Tier-A agents: world calls planTrip/startTrip inside
`startTravel` (town.ts:346) and drives `macroPos` from `posOf` in
`advanceTravel` (town.ts:359), preserving the arrival contract
(travelling=false → enterLocale). The nine get a real `commuting` state in
decidePlace (society.ts:262) with `commuteT` finally nonzero
(society.ts:534). Mara's render path (updateProtagonistCity,
citystage.ts:449) follows the polyline in `TripPlan.legs`.

## Conservation & determinism invariants (smoke-checked)

- Passenger conservation: Σ boarded === Σ alighted + aboard, to 1e-6, across
  hot/cold flips (carry pattern; cold flush spikes accounted).
- Trip conservation: every startTrip resolves to exactly one arrival; no
  trips lost across save/load mid-journey (TripHandles serialize like active
  conversations, society.ts:584 pattern).
- Money: transport never mutates a wallet; all fares/purchases through econ
  (audited by `conservationError`).
- Byte-identical `toJSON()` across same-seed runs; own mulberry32 streams.
- dt-invariance everywhere; gate flip counts bounded.
- Cold cost: with no observer and no Tier-A trips, tick() cost is
  O(stops+edges) *per econ tick* and hotStep is never called (assert call
  count 0 in the smoke).
- **Freedom checks**: no imposed modal split — assert only that when bus
  fare ≪ taxi fare and ownership is low, transit share dominates, and when
  everyone owns cars and congestion is off, driving dominates. Mechanism,
  not outcome.

## scripts/transport-smoke.ts

Standalone: build the graph from synthetic anchors, impose commute pulses
(8h/18h), run 30 sim-days at 1h ticks with moving centers; assert the
invariants + determinism + surrogate learning (stop hour-shape r > 0.6) +
congestion monotonicity (cost rises with load) + a pedsim micro-scenario
(two crossing streams at a signal: zero interpenetration below a distance
epsilon, compliant agents wait on red, jaywalk propensity ordered by trait).

## Wiring appendix (exact anchors, for the integration agent)

- town.ts:80 field; tick beside causal (town.ts:240); causalCenters gains
  in-transit positions (town.ts:252); travel takeover (town.ts:346/359);
  snapshot (town.ts:757) + TownJSON slot (town.ts:838); `setObserver`
  back-channel fed from main.ts tick (main.ts:93).
- society.ts: decidePlace commuting state (262), commuteT (534),
  occupiedPlaces reports route positions (163).
- places.ts:210 `travelTime` → transport costEstimate (keep signature via a
  town-installed hook so arbiter stays pure).
- econ: GoodIds `car`/`bike` + sector `transit` fan-out (~15 total tables,
  compiler-enforced); dealer/taxi/authority templates; SEED_PREMISES for a
  t0 taxi rank is allowed, transit authority is NOT seeded (it must emerge);
  shadow `vehicleWear`/ownership floats with loadJSON backfill
  (shadowpop.ts:565); fare debits beside consumption (shadowpop.ts:300);
  founding channels (econsim.ts:805).
- render: streets/signals/vehicles from `transport.view()` — new
  `src/render/transitlife.ts` (vehicles, stop queues via the BankCrowd
  spawn/dispose pattern, InstancedMesh only if needed), cityview flow layer,
  `debugHotTransit` force flag (the debugHotVenues pattern citystage.ts:399).
- Balance lessons to respect (ECONOMY_EMERGENCE.md): warmup before t0 fares
  count as GDP growth (BOOM_WARMUP_H precedent); capacityPerWorker sized so
  1 driver ≈ 70% utilization (no hire-fire oscillation); administered fares
  (public transit) bypass GoodsMarket tâtonnement — the setPrice gotcha.
