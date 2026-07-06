// Headless proof of the causal radius + evolving surrogate (src/causal/) — no
// Town, no THREE. Six venues (two archetypes), three moving centers, an imposed
// diurnal demand curve, 40 sim-days at dt=1h. Asserts: hysteresis (no boundary
// flicker), exact run-level conservation (carry included), that the surrogate
// LEARNS the imposed diurnal shape from hot episodes only, that a never-hot
// venue inherits its archetype's pooled shape, that a mid-run demand collapse
// pulls the learned level down, and byte-identical determinism across runs.
// Run: npx tsx scripts/causal-smoke.ts
import { CausalField } from '../src/causal/index';
import type { CausalCenter, VenueFlowInput, VenuePoint } from '../src/causal/index';

const R = 55;
const DAYS = 40;
const TICKS = DAYS * 24;
const DT_H = 1;
const PRICE = 3;

// ---- the world: 6 venues on a strip, one far beyond any center's reach ------
const VENUES: VenuePoint[] = [
  { id: 'v0', x: 0,    z: 0,  archetype: 'bakery' },
  { id: 'v1', x: 120,  z: 8,  archetype: 'grocer' },
  { id: 'v2', x: 240,  z: -6, archetype: 'bakery' },
  { id: 'v3', x: 360,  z: 4,  archetype: 'grocer' },
  { id: 'v4', x: 480,  z: 0,  archetype: 'grocer' },  // parked-on: permanently hot
  { id: 'v5', x: 2000, z: 0,  archetype: 'bakery' },  // never hot → pure shrinkage
];
const SCALE = [8, 9, 7.5, 8.5, 8, 6]; // units/h at curve=1, per venue

// Three centers: two sweep the strip on periods co-prime with 24h (so their
// passes drift across the day and every hour-bucket eventually gets observed),
// one LINGERS at v4's boundary, oscillating its distance 52..58m across R=55 —
// the raw radius test flips constantly; the hysteresis latch must not.
function centers(t: number): CausalCenter[] {
  return [
    { id: 'walker',   x: 240 + 300 * Math.sin((2 * Math.PI * t) / 31),       z: 0 },
    { id: 'cyclist',  x: 240 + 300 * Math.sin((2 * Math.PI * t) / 53 + 2.1), z: 6 },
    { id: 'lingerer', x: 480 + 55 + 3 * Math.sin((2 * Math.PI * t) / 5),     z: 0 },
  ];
}

// ---- the imposed diurnal demand curve (mean 1): lunch peak + evening bump ---
const CURVE: number[] = [];
{
  let s = 0;
  for (let h = 0; h < 24; h++) {
    const v = 0.25 + 1.9 * Math.exp(-(((h - 12.5) / 3.2) ** 2)) + 1.1 * Math.exp(-(((h - 19) / 1.8) ** 2));
    CURVE.push(v); s += v;
  }
  for (let h = 0; h < 24; h++) CURVE[h] *= 24 / s;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

// ---- one full scenario run (called twice for the determinism check) ---------
function runScenario(seed: number) {
  const field = new CausalField({ radius: R, seed });
  let unitsIn = 0, revIn = 0, unitsOut = 0, revOut = 0;
  let discreteTicks = 0, coldFractional = 0, nonIntegerDiscrete = 0;
  const prevHot = new Map<string, boolean>();
  const flips = new Map<string, number>();
  let totalFlips = 0;
  let rawInside = false, rawCrossV4 = 0, rawSeen = false;
  let preLevel = 0;

  for (let t = 0; t < TICKS; t++) {
    const regime = t < TICKS / 2 ? 1 : 0.5;              // demand halves at day 20
    if (t === TICKS / 2) preLevel = field.stats.meanRate('v4');
    const hour = t % 24;
    const cs = centers(t);

    // raw (hysteresis-free) boundary test for the lingerer↔v4 pair
    const dx = cs[2].x - VENUES[4].x, dz = cs[2].z - VENUES[4].z;
    const inside = dx * dx + dz * dz <= R * R;
    if (rawSeen && inside !== rawInside) rawCrossV4++;
    rawInside = inside; rawSeen = true;

    const flows: VenueFlowInput[] = VENUES.map((v, i) => {
      const u = SCALE[i] * CURVE[hour] * regime;
      unitsIn += u; revIn += u * PRICE;
      return { venueId: v.id, units: u, revenue: u * PRICE };
    });

    const out = field.tick(cs, VENUES, flows, t, DT_H);
    for (const o of out) {
      unitsOut += o.arrivals * o.basket;
      revOut += o.revenue;
      if (o.discrete) {
        if (o.arrivals > 0) discreteTicks++;
        if (!Number.isInteger(o.arrivals)) nonIntegerDiscrete++;
      } else if (o.arrivals > 0 && !Number.isInteger(o.arrivals)) coldFractional++;
    }

    for (const v of VENUES) {
      const hot = field.gate.isHot(v.id);
      const was = prevHot.get(v.id);
      if (was !== undefined && was !== hot) { flips.set(v.id, (flips.get(v.id) ?? 0) + 1); totalFlips++; }
      prevHot.set(v.id, hot);
    }
  }

  let carryU = 0, carryR = 0;
  for (const v of VENUES) { carryU += field.flow.carryUnits(v.id); carryR += field.flow.carryRevenue(v.id); }

  return {
    field,
    unitsIn, revIn, unitsOut, revOut, carryU, carryR,
    discreteTicks, coldFractional, nonIntegerDiscrete,
    flips, totalFlips, rawCrossV4,
    preLevel, postLevel: field.stats.meanRate('v4'),
    json: JSON.stringify(field.toJSON()),
  };
}

// ---- run + assert ------------------------------------------------------------
const ok = (name: string, cond: boolean) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); return cond; };
let pass = true;

const A = runScenario(1234);
const B = runScenario(1234);

// (a) hot/cold flips happen, with hysteresis (bounded; the boundary-jitter
//     venue latches once instead of flickering with the raw crossings)
const v4Flips = A.flips.get('v4') ?? 0;
console.log(`\n== causal-smoke: 6 venues · 3 centers · ${DAYS} days @ ${DT_H}h ==`);
console.log(`  (flips total ${A.totalFlips} · v4 ${v4Flips} vs ${A.rawCrossV4} raw boundary crossings · hot now: [${A.field.view().hot.join(' ')}])`);
pass = ok('hot/cold transitions happen (centers sweep venues)', A.totalFlips >= 8) && pass;
pass = ok('flip count bounded (no runaway churn)', A.totalFlips < 2000) && pass;
pass = ok(`hysteresis: jittering boundary latched once (v4 flips ${v4Flips} ≤ 2, raw crossings ${A.rawCrossV4} ≥ 50)`, v4Flips <= 2 && A.rawCrossV4 >= 50) && pass;
pass = ok('never-hot venue stayed cold (v5)', (A.flips.get('v5') ?? 0) === 0 && !A.field.gate.isHot('v5')) && pass;

// (b) conservation: Σ units in == Σ arrivals×basket out + final carry
const unitsDrift = Math.abs(A.unitsIn - A.unitsOut - A.carryU);
const revDrift = Math.abs(A.revIn - A.revOut - A.carryR);
console.log(`  (units in ${A.unitsIn.toFixed(2)} · out ${A.unitsOut.toFixed(2)} · carry ${A.carryU.toFixed(4)} · drift ${unitsDrift.toExponential(2)})`);
pass = ok('units conserved to 1e-6 (carry included)', unitsDrift <= 1e-6) && pass;
pass = ok('revenue conserved to 1e-6 (carry included)', revDrift <= 1e-6) && pass;
pass = ok('hot ticks produced integer arrivals; cold ticks fractional', A.discreteTicks > 100 && A.nonIntegerDiscrete === 0 && A.coldFractional > 100) && pass;

// (c) learning: the always-hot venue's shape correlates with the imposed curve
const learned = A.field.stats.shapeVector('v4', 'grocer');
const rLearn = pearson(learned, CURVE);
console.log(`  (v4 learned-shape ⇄ imposed-curve Pearson r = ${rLearn.toFixed(3)} · confidence ${A.field.stats.confidence('v4').toFixed(3)} · version ${A.field.stats.version()})`);
pass = ok('surrogate learned the diurnal shape (r > 0.6)', rLearn > 0.6) && pass;

// (d) shrinkage: the never-hot venue's shape ≡ the archetype pooled shape
const v5Shape = A.field.stats.shapeVector('v5', 'bakery');
const pooled = A.field.stats.shapeVector('__ghost__', 'bakery'); // unknown id ⇒ pure pooled prior
let maxDiff = 0;
for (let h = 0; h < 24; h++) maxDiff = Math.max(maxDiff, Math.abs(v5Shape[h] - pooled[h]));
const rInherit = pearson(v5Shape, CURVE);
console.log(`  (v5 vs pooled-bakery max|Δ| = ${maxDiff.toExponential(2)} · v5 confidence ${A.field.stats.confidence('v5')} · inherited r = ${rInherit.toFixed(3)})`);
pass = ok('never-hot venue inherits pooled archetype shape', maxDiff < 1e-9 && A.field.stats.confidence('v5') === 0) && pass;
pass = ok('inherited shape still tracks the true curve (r > 0.5)', rInherit > 0.5) && pass;

// (e) regime shift: demand halved at day 20 → learned level tracks down
console.log(`  (v4 level: before shift ${A.preLevel.toFixed(3)}/h · after ${A.postLevel.toFixed(3)}/h · ratio ${(A.postLevel / A.preLevel).toFixed(3)})`);
pass = ok('learned level tracked the demand collapse (post < 0.75×pre)', A.postLevel < 0.75 * A.preLevel && A.postLevel > 0.2 * A.preLevel) && pass;

// (f) determinism: same seed ⇒ byte-identical serialized state
pass = ok('two runs, same seed → identical toJSON', A.json === B.json && A.json.length > 100) && pass;

// sanity: the view is coherent (hourShape sums to 1 per venue)
const view = A.field.view();
let shapesOk = view.stats.length === 6;
for (const s of view.stats) {
  const sum = s.hourShape.reduce((x, y) => x + y, 0);
  if (Math.abs(sum - 1) > 1e-9 || s.hourShape.length !== 24) shapesOk = false;
}
pass = ok('view(): 6 venues, each hourShape sums to 1', shapesOk) && pass;

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
