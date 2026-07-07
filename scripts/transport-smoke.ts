// Headless proof of the transport layer (src/transport/) — no Town, no THREE.
// A synthetic nine-anchor town at real-ish street scale, an imposed 8h/18h
// commute pulse over shadow households, Tier-A trips started on a cadence,
// moving causal centers, a save/load mid-journey, and a pedestrian crossing
// micro-scenario. Asserts: graph generation (intersections, sidewalks,
// connectivity, determinism), O(1)-amortized costEstimate, congestion
// monotonicity + dt-invariance, passenger/trip conservation across hot-cold
// flips and save/load, surrogate learning (hot stop hour-shape r > 0.6),
// emergent transit routes over the top OD flows, freedom checks on the modal
// split (mechanism, not outcome), cold-cost (hotStep count 0), byte-identical
// determinism, and social-force pedestrians (no interpenetration, red-light
// compliance ordered by trait).
// Run: npx tsx scripts/transport-smoke.ts
import { TransportField, Congestion, Fleet, commuteBump, jaywalkP } from '../src/transport/index';
import type { ModeId, NetAnchor, TransportTickInput, TripHandle } from '../src/transport/index';
import { mulberry32 } from '../src/core/util/num';

// ---- the synthetic town: five classic places + four off-core POIs -----------
const ANCHORS: NetAnchor[] = [
  { id: 'home',        x: -800, z:   300, kind: 'place' },
  { id: 'work',        x:  700, z:  -350, kind: 'place' },
  { id: 'market',      x:    0, z:   150, kind: 'place' },
  { id: 'thirdplace',  x:  900, z:   800, kind: 'place' },
  { id: 'park',        x: -350, z:  -350, kind: 'place' },
  { id: 'supermarket', x:    0, z: -1200, kind: 'poi' },
  { id: 'fed',         x:    0, z:  1400, kind: 'poi' },
  { id: 'bank',        x: -700, z:  1350, kind: 'poi' },
  { id: 'office',      x:  400, z:    60, kind: 'poi' },
];

const DAYS = 30;
const TICKS = DAYS * 24;
const SAVE_AT = 360;          // mid-run save/load, with a trip in flight
const DRAIN_H = 72;

const ok = (name: string, cond: boolean) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); return cond; };
let pass = true;

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

function entropy(counts: Record<string, number>): number {
  let n = 0;
  for (const k in counts) n += counts[k];
  if (n === 0) return 0;
  let h = 0;
  for (const k in counts) { const p = counts[k] / n; if (p > 0) h -= p * Math.log2(p); }
  return h;
}

// =============================================================================
// (1) GRAPH — generation, intersections, sidewalks, connectivity, determinism
// =============================================================================
console.log('\n== transport-smoke: netgraph ==');
{
  const g1 = new TransportField(ANCHORS, { seed: 7 }).graph;
  const g2 = new TransportField(ANCHORS, { seed: 7 }).graph;
  const inter = g1.nodes.filter((n) => n.kind === 'intersection');
  pass = ok('every anchor became a node', ANCHORS.every((a) => g1.idx(a.id) >= 0)) && pass;
  pass = ok(`intersection nodes generated where streets cross (${inter.length})`, inter.length >= 1) && pass;
  const x0 = inter[0];
  pass = ok('crossing sits on the home–work × market–park solve (~(-106, -1))',
            !!x0 && Math.abs(x0.x - -105.6) < 1 && Math.abs(x0.z - -0.9) < 1) && pass;
  const splitEdges = g1.edges.filter((e) => e.a.startsWith('x') || e.b.startsWith('x'));
  pass = ok('crossed segments were split at the intersection', splitEdges.length >= 4) && pass;
  // connectivity: BFS over adjacency reaches every node.
  const seen = new Set<number>([0]);
  const q = [0];
  while (q.length) {
    const i = q.pop()!;
    for (const ei of g1.edgesAt(i)) {
      const o = g1.otherEnd(g1.edges[ei], i);
      if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  pass = ok('graph is one connected component (spurs attach off-core anchors)', seen.size === g1.nodes.length) && pass;
  const withWalk = g1.edges.filter((e) => e.sidewalk).length;
  pass = ok(`sidewalks on the core, arterials bare (${withWalk}/${g1.edges.length})`,
            withWalk >= 5 && withWalk < g1.edges.length) && pass;
  const sig = (g: typeof g1) => JSON.stringify({ n: g.nodes, e: g.edges.map((e) => [e.id, e.a, e.b, Math.round(e.lengthM * 1e3), e.sidewalk]) });
  pass = ok('same anchors ⇒ byte-identical graph', sig(g1) === sig(g2)) && pass;
}

// =============================================================================
// (2) UNIT MECHANISMS — congestion, dt-invariance, taxi wait, jaywalk traits
// =============================================================================
console.log('\n== unit mechanisms ==');
{
  const c = new Congestion(2);
  const f0 = c.factor(0);
  c.addLoad(0, 30); c.tick(1);
  const f1 = c.factor(0);
  c.addLoad(0, 90); c.tick(1);
  const f2 = c.factor(0);
  pass = ok(`BPR delay rises monotonically with load (1=${f0.toFixed(2)} → ${f1.toFixed(2)} → ${f2.toFixed(2)})`,
            f0 === 1 && f1 > f0 && f2 > f1) && pass;

  const cA = new Congestion(1), cB = new Congestion(1);
  cA.addLoad(0, 10); cA.tick(1);
  cB.addLoad(0, 5); cB.tick(0.5); cB.addLoad(0, 5); cB.tick(0.5);
  pass = ok('load EMA is dt-invariant (1×1h ≡ 2×0.5h)', Math.abs(cA.loadOf(0) - cB.loadOf(0)) < 1e-9) && pass;

  const fl = new Fleet();
  fl.setTaxis(3);
  fl.tickTaxi(1);
  const wCold = fl.taxiWaitH();
  for (let i = 0; i < 30; i++) { fl.noteRide(2.6); fl.tickTaxi(1); }
  const wHot = fl.taxiWaitH();
  pass = ok(`taxi wait rises with utilization (${wCold.toFixed(3)}h → ${wHot.toFixed(3)}h @ util ${fl.taxiUtil().toFixed(2)})`,
            wHot > wCold * 2 && fl.taxiUtil() > 0.5) && pass;
  fl.setTaxis(0);
  pass = ok('no fleet ⇒ taxi wait Infinity (mode not on offer)', !Number.isFinite(fl.taxiWaitH())) && pass;

  const pLow = jaywalkP({ conscientiousness: 0.9, impulsivity: 0.1 });
  const pMid = jaywalkP({ conscientiousness: 0.5, impulsivity: 0.5 });
  const pHigh = jaywalkP({ conscientiousness: 0.1, impulsivity: 0.9 });
  pass = ok(`p(jaywalk) ordered by trait (${pLow.toFixed(2)} < ${pMid.toFixed(2)} < ${pHigh.toFixed(2)})`,
            pLow < pMid && pMid < pHigh) && pass;
}

// =============================================================================
// (3) MAIN SCENARIO — 30 days, commute pulse, moving centers, save/load
// =============================================================================
console.log('\n== 30-day scenario (transit-friendly: cheap bus, low ownership) ==');

function inputL(clock: number): TransportTickInput {
  // a watcher pinned at the home stop (always hot) + a commuter sweeping the
  // home↔work street on a 31 h period (hot/cold flips at both ends).
  const u = 0.5 + 0.5 * Math.sin((2 * Math.PI * clock) / 31);
  return {
    centers: [
      { id: 'watcher', x: -800, z: 300 },
      { id: 'mover', x: -800 + 1500 * u, z: 300 - 650 * u },
    ],
    shadow: { households: 600, employed: 400, carOwnership: 0.05, bikeOwnership: 0.1 },
    commuteOD: [
      { from: 'home', to: 'work', weight: 0.7 },
      { from: 'home', to: 'office', weight: 0.3 },
    ],
    prices: { busFare: 0.5, taxiBase: 4, taxiPerKm: 2, fuelPerKm: 0.15 },
    fleet: { taxis: 6, taxiOperatorId: 'taxico', transitVehicles: 4, transitOperatorId: 'transitco' },
    subsidy: 0,
  };
}

const TRIP_PAIRS: [NetAnchor, NetAnchor][] = [
  [ANCHORS[0], ANCHORS[3]], [ANCHORS[4], ANCHORS[1]], [ANCHORS[0], ANCHORS[5]],
  [ANCHORS[2], ANCHORS[7]], [ANCHORS[8], ANCHORS[0]], [ANCHORS[1], ANCHORS[6]],
];

function runScenario(seed: number) {
  let field = new TransportField(ANCHORS, { seed });
  const rng = mulberry32(seed ^ 0x51ed);
  let started = 0;
  let fareTaxiCo = 0, fareTransitCo = 0, badFareRow = 0;
  let savedJson = '';
  let roundTripOk = false;
  let savedInFlight = 0;
  let sawReplan = false;
  let latentCar = 0;
  const handles: TripHandle[] = [];

  const hourTick = (clock: number, allowStarts: boolean) => {
    if (allowStarts && clock % 3 === 0) {
      const [a, b] = TRIP_PAIRS[(clock / 3) % TRIP_PAIRS.length];
      const plan = field.planTrip({
        from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z },
        wageRate: 10 + rng() * 8, fatigue: rng() * 0.8, traits: { openness: 0.4 },
      }, clock);
      handles.push(field.startTrip(plan, `agent${clock % 9}`, clock));
      started++;
    }
    const res = field.tick(inputL(clock), clock, 1);
    for (const row of res.fareRevenue) {
      if (row.operatorId === 'taxico') fareTaxiCo += row.amount;
      else if (row.operatorId === 'transitco') fareTransitCo += row.amount;
      else badFareRow++;
      if (!(row.amount > 0) || !Number.isFinite(row.amount)) badFareRow++;
    }
    for (const e of res.historyEvents) if (e.kind === 'replan') sawReplan = true;
    latentCar = res.vehicleDemandSignal.car;
  };

  for (let t = 0; t < TICKS; t++) {
    hourTick(t, true);
    if (t === SAVE_AT) {
      // save mid-journey, reload into a FRESH field, continue on the copy.
      savedJson = JSON.stringify(field.toJSON());
      savedInFlight = (field.toJSON() as { trips: unknown[] }).trips.length;
      const fresh = new TransportField(ANCHORS, { seed });
      fresh.loadJSON(JSON.parse(savedJson));
      roundTripOk = JSON.stringify(fresh.toJSON()) === savedJson;
      field = fresh;
    }
  }
  for (let t = TICKS; t < TICKS + DRAIN_H; t++) hourTick(t, false);

  return {
    field, started, fareTaxiCo, fareTransitCo, badFareRow, savedJson, roundTripOk,
    savedInFlight, sawReplan, latentCar, handles,
    json: JSON.stringify(field.toJSON()),
  };
}

const A = runScenario(4242);
const B = runScenario(4242);

{
  const kpis = A.field.view().kpis;

  // (a) trip conservation — every startTrip resolved to exactly one arrival,
  //     across the save/load with journeys in flight.
  console.log(`  (trips ${A.started} started · ${kpis.tripsArrived} arrived · ${A.savedInFlight} in flight at save)`);
  pass = ok('a journey was in flight at the save point', A.savedInFlight >= 1) && pass;
  pass = ok('every trip resolved to EXACTLY one arrival across save/load', kpis.tripsArrived === A.started && kpis.tripsStarted === A.started) && pass;
  pass = ok('loadJSON→toJSON round-trips byte-identically', A.roundTripOk) && pass;

  // (b) passenger conservation with carries, across hot-cold flips.
  const od = A.field.od, fleet = A.field.fleet;
  const qDrift = Math.abs(od.arrivalsTotal - od.boardedTotal - od.gaveUpTotal - od.waitingSum());
  const bDrift = Math.abs(fleet.boardedTotal - fleet.alightedTotal - fleet.aboard());
  console.log(`  (stops: arrivals ${od.arrivalsTotal.toFixed(2)} = boarded ${od.boardedTotal.toFixed(2)} + gaveUp ${od.gaveUpTotal.toFixed(2)} + waiting ${od.waitingSum().toFixed(4)} · drift ${qDrift.toExponential(2)})`);
  pass = ok('stop queues conserve: Σarrivals == Σboarded + Σgaveup + waiting (1e-6)', qDrift <= 1e-6) && pass;
  pass = ok('vehicles conserve: Σboarded == Σalighted + aboard (1e-6)', bDrift <= 1e-6) && pass;
  pass = ok('queue and vehicle ledgers agree on boardings', Math.abs(od.boardedTotal - fleet.boardedTotal) <= 1e-6) && pass;
  pass = ok('riders actually rode the bus (boarded > 100)', fleet.boardedTotal > 100) && pass;

  // (c) hot/cold gate behaved: flips happened (the mover) and stayed bounded.
  const flips = A.field.gate.flipCount();
  console.log(`  (gate flips ${flips} · hot now: [${A.field.view().hot.join(' ')}])`);
  pass = ok('hot/cold transitions happened (moving center sweeps stops)', flips >= 4) && pass;
  pass = ok('flip count bounded (hysteresis, no flicker)', flips < 1200) && pass;
  pass = ok('pinned watcher keeps the home stop hot', A.field.gate.isHot('home')) && pass;

  // (d) learning: the hot home stop learned the imposed commute pulse.
  const shape = A.field.od.stats.shapeVector('home', 'stop:place');
  const ref: number[] = [];
  for (let h = 0; h < 24; h++) {
    const m = Math.exp(-(((h - 8) / 1.5) ** 2)), e = Math.exp(-(((h - 18) / 1.5) ** 2));
    const split = m + e > 1e-9 ? m / (m + e) : 0.5;
    ref.push(commuteBump(h) * split);
  }
  const rLearn = pearson(shape, ref);
  console.log(`  (home-stop learned-shape ⇄ imposed commute pulse r = ${rLearn.toFixed(3)} · confidence ${A.field.od.stats.confidence('home').toFixed(2)})`);
  pass = ok('surrogate learned the commute pulse from hot episodes (r > 0.6)', rLearn > 0.6) && pass;

  // (e) transit network EMERGED from the OD field (nothing was authored).
  const v = A.field.view();
  pass = ok(`transit routes emerged from demand (${v.routes.length} line(s))`, v.routes.length >= 1 && A.sawReplan) && pass;
  pass = ok('the top OD flow (home→work) is served', A.field.fleet.serving('home', 'work') !== null) && pass;
  pass = ok('schedule-time vehicles ride the line (positions on poly)', v.routes[0].vehicles.length >= 1) && pass;

  // (f) freedom check L: cheap bus + low ownership ⇒ transit share dominates.
  const ms = kpis.modeShare;
  const share = (Object.keys(ms) as ModeId[]).map((m) => `${m} ${(ms[m] * 100).toFixed(0)}%`).join(' · ');
  console.log(`  (modal split: ${share})`);
  pass = ok('bus fare ≪ taxi + low ownership ⇒ transit dominates the split',
            ms.bus > ms.walk && ms.bus > ms.car && ms.bus > ms.taxi && ms.bus > ms.bike) && pass;
  pass = ok('latent car demand > 0 (dealer restock signal at 5% ownership)', A.latentCar > 0.05) && pass;

  // (g) money: fares are COMMANDS to econ, per operator, all finite/positive.
  console.log(`  (fares: taxico $${A.fareTaxiCo.toFixed(0)} · transitco $${A.fareTransitCo.toFixed(0)})`);
  pass = ok('both operators earned fares; no malformed revenue rows', A.fareTaxiCo > 0 && A.fareTransitCo > 0 && A.badFareRow === 0) && pass;
  pass = ok('commuteCostIndex sane (0.2 < cci < 5)', kpis.commuteCostIndex > 0.2 && kpis.commuteCostIndex < 5) && pass;

  // (h) COLD COST: nothing observed ⇒ zero micro work.
  pass = ok('hotStep never called cold: hotSteps() === 0', A.field.hotSteps() === 0) && pass;
  pass = ok('pedsim ran zero substeps in the cold run', A.field.peds.stepCount === 0) && pass;

  // (i) posOf is pure: sampling positions mutates nothing.
  const before = JSON.stringify(A.field.toJSON());
  const h0 = A.handles[A.handles.length - 1];
  for (let i = 0; i < 500; i++) A.field.posOf(h0, h0.departH + (i / 500) * h0.durH * 2);
  const p0 = A.field.posOf(h0, h0.departH + h0.durH * 0.5);
  const p1 = A.field.posOf(h0, h0.departH + h0.durH * 0.5);
  pass = ok('posOf is a pure function of the clock (same t ⇒ same point)', p0.x === p1.x && p0.z === p1.z) && pass;
  pass = ok('500 posOf calls leave state byte-identical', JSON.stringify(A.field.toJSON()) === before) && pass;
  pass = ok('posOf resolves done exactly at departure+duration', !A.field.posOf(h0, h0.departH + h0.durH * 0.99).done
            && A.field.posOf(h0, h0.departH + h0.durH + 1e-6).done) && pass;

  // (j) determinism: same seed, same calls ⇒ byte-identical serialized state.
  pass = ok('two same-seed runs → byte-identical toJSON', A.json === B.json && A.json.length > 500) && pass;

  // (k) view coherence.
  let shapesOk = v.stops.length === 9;
  for (const s of v.stops) {
    const sum = s.hourShape.reduce((x, y) => x + y, 0);
    if (Math.abs(sum - 1) > 1e-9 || s.hourShape.length !== 24 || s.waiting < -1e-9) shapesOk = false;
  }
  pass = ok('view(): 9 stops, hourShapes sum to 1, queues non-negative', shapesOk) && pass;
  pass = ok('view(): every edge at factor ≥ 1 with finite load',
            v.edges.every((e) => e.factor >= 1 && Number.isFinite(e.load))) && pass;
  pass = ok('history recorded the whole run (pair-merge bounded)',
            v.history.n > 100 && v.history.n <= 1440 && v.history.fields.length > 10) && pass;
}

// =============================================================================
// (4) costEstimate — O(1) amortized + distance monotonicity + congestion
// =============================================================================
console.log('\n== costEstimate (the travelTime replacement) ==');
{
  const f = A.field;
  const near = f.costEstimate({ x: -800, z: 300 }, { x: 0, z: 150 }, 0);      // home→market
  const far = f.costEstimate({ x: -800, z: 300 }, { x: -700, z: 1350 }, 0);   // home→bank
  console.log(`  (home→market ${near.durH.toFixed(3)}h $${near.money.toFixed(2)} · home→bank ${far.durH.toFixed(3)}h $${far.money.toFixed(2)})`);
  pass = ok('estimates positive and finite', near.durH > 0 && Number.isFinite(far.durH) && near.money >= 0) && pass;
  pass = ok('farther pair costs more time (distance is real now)', far.durH > near.durH) && pass;
  const builds0 = f.router.matrixBuilds;
  for (let i = 0; i < 5000; i++) f.costEstimate({ x: -800 + i % 7, z: 300 }, { x: 700, z: -350 }, i);
  pass = ok(`5000 costEstimate calls rebuilt no matrices (builds ${builds0} → ${f.router.matrixBuilds})`,
            f.router.matrixBuilds === builds0) && pass;

  // congestion monotonicity through the cached matrices: flood the streets.
  const hIdx = f.graph.idx('home'), wIdx = f.graph.idx('work');
  const carBefore = f.router.carH(hIdx, wIdx);
  const cciBefore = f.view().kpis.commuteCostIndex;
  const flood: TransportTickInput = {
    ...inputL(8),
    shadow: { households: 6000, employed: 5000, carOwnership: 1, bikeOwnership: 0 },
  };
  for (let t = 0; t < 24; t++) f.tick(flood, TICKS + DRAIN_H + t, 1);
  const carAfter = f.router.carH(hIdx, wIdx);
  const cciAfter = f.view().kpis.commuteCostIndex;
  console.log(`  (car home→work: ${carBefore.toFixed(3)}h free-ish → ${carAfter.toFixed(3)}h flooded · mean factor ${f.congestion.meanFactor().toFixed(2)} · cci ${cciBefore.toFixed(2)} → ${cciAfter.toFixed(2)})`);
  pass = ok('congestion monotonicity: car time rises with imposed load', carAfter > carBefore * 1.2) && pass;
  pass = ok('commuteCostIndex rose with the jam (the gov politics input)', cciAfter > cciBefore * 1.15) && pass;
}

// =============================================================================
// (5) mode choice — logit temperature from openness (exploration ordering)
// =============================================================================
console.log('\n== mode choice ==');
{
  const f = new TransportField(ANCHORS, { seed: 99 });
  f.tick(inputL(0), 0, 1);
  f.tick(inputL(1), 1, 1);           // routes planned, taxis live
  const draw = (openness: number) => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 250; i++) {
      const p = f.planTrip({ from: { x: -800, z: 300 }, to: { x: 700, z: -350 }, wageRate: 12, traits: { openness } }, 2);
      counts[p.mode] = (counts[p.mode] ?? 0) + 1;
    }
    return counts;
  };
  const closed = draw(0.05);
  const open = draw(0.95);
  const eClosed = entropy(closed), eOpen = entropy(open);
  console.log(`  (closed: ${JSON.stringify(closed)} H=${eClosed.toFixed(2)} · open: ${JSON.stringify(open)} H=${eOpen.toFixed(2)})`);
  pass = ok('open traveler explores modes more (entropy ordered by openness)', eOpen > eClosed + 0.1) && pass;
}

// =============================================================================
// (6) freedom check H — everyone owns a car, no transit ⇒ driving dominates
// =============================================================================
console.log('\n== 10-day scenario (car-friendly: high ownership, no transit) ==');
{
  const f = new TransportField(ANCHORS, { seed: 4242 });
  const inputH: TransportTickInput = {
    centers: [{ id: 'watcher', x: -800, z: 300 }],
    shadow: { households: 200, employed: 150, carOwnership: 0.95, bikeOwnership: 0.5 },
    commuteOD: [
      { from: 'home', to: 'work', weight: 0.7 },
      { from: 'home', to: 'office', weight: 0.3 },
    ],
    prices: { busFare: 1.5, taxiBase: 2.5, taxiPerKm: 1.2, fuelPerKm: 0.15 },
    fleet: { taxis: 2, taxiOperatorId: 'taxico', transitVehicles: 0 },
  };
  for (let t = 0; t < 240; t++) f.tick(inputH, t, 1);
  const ms = f.view().kpis.modeShare;
  const share = (Object.keys(ms) as ModeId[]).map((m) => `${m} ${(ms[m] * 100).toFixed(0)}%`).join(' · ');
  console.log(`  (modal split: ${share})`);
  pass = ok('ownership high + congestion off ⇒ driving dominates the split',
            ms.car > ms.walk && ms.car > ms.bus && ms.car > ms.taxi && ms.car > ms.bike) && pass;
  pass = ok('no vehicles ⇒ no transit network imposed', f.view().routes.length === 0) && pass;
}

// =============================================================================
// (7) PEDSIM — crossing streams at a signal (hotStep-driven micro-scenario)
// =============================================================================
console.log('\n== pedsim: crossing streams at a signalized intersection ==');
{
  const CROSS: NetAnchor[] = [
    { id: 'home', x: -80, z: 0, kind: 'place' },
    { id: 'work', x: 80, z: 0, kind: 'place' },
    { id: 'market', x: 0, z: 80, kind: 'place' },
    { id: 'park', x: 0, z: -80, kind: 'place' },
  ];
  const f = new TransportField(CROSS, { seed: 1717 });
  const ci = f.signals.controllers.findIndex((c) => c.id === 'x0');
  pass = ok(`signal controller exists at the generated crossing (${f.signals.controllers.length}, x0 at ${ci})`,
            ci >= 0) && pass;
  const ctrl = f.signals.controllers[ci];
  pass = ok('controller split incident edges into two non-empty axes',
            ctrl.axisA.length >= 1 && ctrl.axisB.length >= 1 && ctrl.axisA.length + ctrl.axisB.length >= 4) && pass;
  pass = ok('phase is a pure function of the clock (idempotent + alternating)',
            f.signals.phaseAt(ci, 5.0) === f.signals.phaseAt(ci, 5.0)
            && f.signals.phaseAt(ci, ctrl.offsetH + 0.001) !== f.signals.phaseAt(ci, ctrl.offsetH + 0.001 + ctrl.cycleH / 2)) && pass;

  const S = 1 / 3600;                                  // one real-second in sim-hours
  const stepFor = (secs: number, t0: number): number => {
    for (let s = 0; s < secs; s++) f.hotStep(S, { x: 0, z: 0, clock: t0 + s * S });
    return t0 + secs * S;
  };
  // find the start of an eastbound-red window (≥ 35 s of red ahead).
  let red0 = 0;
  for (let t = 0; t < 2; t += S) {
    if (!f.signals.pedGreenAlong(ci, 0, t) && !f.signals.pedGreenAlong(ci, 0, t + 35 * S)
        && f.signals.pedGreenAlong(ci, 0, t - S)) { red0 = t; break; }
  }
  pass = ok('found a red window for the eastbound crossing', red0 > 0) && pass;

  // (a) two opposing streams during green: nobody interpenetrates.
  const green0 = red0 + 46 * S;                        // just after the phase flips
  for (let i = 0; i < 6; i++) {
    f.peds.spawn({ id: `e${i}`, x: -14 - i * 2, z: -0.8 + 0.35 * i, gx: 26, gz: 0, traits: { conscientiousness: 0.5, impulsivity: 0.5 } });
    f.peds.spawn({ id: `w${i}`, x: 14 + i * 2, z: 0.8 - 0.35 * i, gx: -26, gz: 0, traits: { conscientiousness: 0.5, impulsivity: 0.5 } });
  }
  let minSep = Infinity;
  let t = green0;
  for (let s = 0; s < 80; s++) {
    f.hotStep(0.5 * S, { x: 0, z: 0, clock: t });
    t += 0.5 * S;
    minSep = Math.min(minSep, f.peds.minSeparation());
  }
  const crossed = f.peds.figures().filter((p) => p.id.startsWith('e') && p.x > 5).length
                + f.peds.figures().filter((p) => p.id.startsWith('w') && p.x < -5).length;
  console.log(`  (12 peds, 2 streams · min separation ${minSep.toFixed(3)} m · ${crossed} crossed the middle)`);
  pass = ok('crossing streams: zero interpenetration (min separation > 0.25 m)', minSep > 0.25) && pass;
  pass = ok('streams actually passed through each other (≥ 8 crossed)', crossed >= 8) && pass;
  pass = ok('hotStep drove the substeps (stepCount > 0 when observed)', f.peds.stepCount > 0) && pass;
  f.peds.clear();

  // (b) a compliant walker holds the stop line for the whole red.
  f.peds.spawn({ id: 'comply', x: -12.5, z: 0, gx: 26, gz: 0, traits: { conscientiousness: 0.95, impulsivity: 0.05 } });
  t = red0;
  let heldLine = true;
  for (let s = 0; s < 40; s++) {
    f.hotStep(S, { x: 0, z: 0, clock: t });
    t += S;
    const fig = f.peds.figures()[0];
    if (!f.signals.pedGreenAlong(ci, 0, t) && fig.x > -2.0) heldLine = false;
  }
  const waited = f.peds.figures()[0];
  pass = ok(`compliant walker waited out the red at the stop line (x=${waited.x.toFixed(1)})`, heldLine) && pass;
  for (let s = 0; s < 40; s++) { f.hotStep(S, { x: 0, z: 0, clock: t }); t += S; }
  pass = ok('…and crossed once the light turned', f.peds.figures()[0].x > 3) && pass;
  f.peds.clear();

  // (c) jaywalk propensity ordered by trait — 30 episodes per cohort. A
  //     jaywalker is one who is past the stop line while the light is still
  //     red (the latch clears once they pass the node, so read the position).
  const cohort = (c: number, imp: number): number => {
    let jay = 0;
    for (let ep = 0; ep < 30; ep++) {
      f.peds.clear();
      f.peds.spawn({ id: 'p', x: -12.5, z: 0, gx: 26, gz: 0, traits: { conscientiousness: c, impulsivity: imp } });
      let tc = red0;
      for (let s = 0; s < 14; s++) { f.hotStep(S, { x: 0, z: 0, clock: tc }); tc += S; }
      const fig = f.peds.figures()[0];
      if (fig.sigChoice === 2 || fig.x > -2.0) jay++;
    }
    return jay;
  };
  const jLow = cohort(0.9, 0.1);
  const jMid = cohort(0.5, 0.5);
  const jHigh = cohort(0.1, 0.9);
  console.log(`  (jaywalks/30 episodes: conscientious ${jLow} · average ${jMid} · impulsive ${jHigh})`);
  pass = ok('red-light compliance ordered by trait (impulsive > average > conscientious)',
            jHigh > jMid && jMid > jLow) && pass;
}

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
