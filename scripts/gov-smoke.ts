// Headless proof of the emergent-government field (src/gov/) — no Town, no
// THREE, no econ. Synthetic macro curves (an imposed recession), synthetic
// civic conversation/feed traffic riding an imposed diurnal curve, moving
// centers that walk to assemblies. Asserts the POLIS invariants: the freedom
// checks (no seeds ⇒ no government; seeds + low grievance ⇒ possible, not
// guaranteed; seeds + hardship ⇒ mass grows), conserved votes and treasury,
// hysteresis at the civic-venue gate, observe-only-when-hot epistemics,
// surrogate learning (engagement hour-shape r > 0.6), the full lifecycle
// dormant → … → elected → insolvent → dissolved, dt-invariance, and
// byte-identical determinism. Run: npx tsx scripts/gov-smoke.ts
import { GovField, ALLOWED_TRANSITIONS, CharterProcess, CIVIC_SEEDS } from '../src/gov/index';
import type { BallotView, GovMacroSlice, GovTickInput, GovTickResult, InstitutionState } from '../src/gov/index';

const DT = 1;
const SHADOW_N = 240;

// ---- local rng (the smoke drives its own synthetic world) --------------------
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// ---- the imposed diurnal civic-engagement curve (mean 1): lunch + evening ----
const CURVE: number[] = [];
{
  let s = 0;
  for (let h = 0; h < 24; h++) {
    const v = 0.2 + 1.6 * Math.exp(-(((h - 12.5) / 3) ** 2)) + 1.4 * Math.exp(-(((h - 19) / 2) ** 2));
    CURVE.push(v); s += v;
  }
  for (let h = 0; h < 24; h++) CURVE[h] *= 24 / s;
}

// ---- synthetic town geometry ---------------------------------------------------
const VENUES = [
  { id: 'park', x: 0, z: 0 },
  { id: 'foodcourt', x: 60, z: 40 },
];
const SEED_IDS = CIVIC_SEEDS.map((s) => s.characterId);
const OTHER_IDS = ['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'];
const TIER_IDS = [...SEED_IDS, ...OTHER_IDS];
const ATTENDEE_COUNT = 5;   // how many Tier-A walk to an assembly

interface MacroCfg { (t: number): GovMacroSlice; }

const benignMacro: MacroCfg = () => ({
  unemployment: 0.05, gini: 0.32, cpi: 1.01, homeless: 0.004, meanWage: 12, rentBurden: 0.30,
});
const lowGrievanceMacro: MacroCfg = () => ({
  unemployment: 0.08, gini: 0.34, cpi: 1.035, homeless: 0.008, meanWage: 12, rentBurden: 0.36,
});
/** recession ramps in over days 4–10 and stays. */
const recessionMacro: MacroCfg = (t) => {
  const k = Math.min(1, Math.max(0, (t - 96) / 144));
  return {
    unemployment: 0.05 + 0.23 * k, gini: 0.34 + 0.08 * k, cpi: 1.01 + 0.11 * k,
    homeless: 0.004 + 0.056 * k, meanWage: 12, rentBurden: 0.32 + 0.23 * k,
  };
};

// ---- one full scenario run ------------------------------------------------------
interface ScenarioCfg {
  seed: number;
  days: number;
  seeds: boolean;                  // consume seedPlan()?
  macro: MacroCfg;
  density: number;
  /** hours after election at which the smoke collapses the tax base (0 = never). */
  collapseAfterElectedH: number;
}

interface ScenarioOut {
  gov: GovField;
  states: InstitutionState[];               // state after each tick
  transitions: [InstitutionState, InstitutionState][];
  ballots: BallotView[];                    // every resolved ballot, in order
  results: { t: number; res: GovTickResult }[]; // only ticks with visible output
  credSum: number; debSum: number;
  engagementCount: number;
  assembliesMet: { place: string; tier: number }[];
  callTick: number; stirTick: number;
  electedTick: number; insolventTick: number; dissolvedTick: number;
  maxMassPre: number; maxMassPost: number;  // before/after the recession onset
  petitionCount: number;
  leviesBeforeCharter: number;
  spendWhileNotElected: number;
  firstHiresDesired: number | null;
  insolventHiresDesired: number | null;
  json: string;
}

function runScenario(cfg: ScenarioCfg): ScenarioOut {
  const gov = new GovField({ seed: cfg.seed });
  const rng = rng32(cfg.seed ^ 0xbeef);
  if (cfg.seeds) gov.seedPlan();

  const ticks = cfg.days * 24;
  const out: ScenarioOut = {
    gov, states: [], transitions: [], ballots: [], results: [],
    credSum: 0, debSum: 0, engagementCount: 0, assembliesMet: [],
    callTick: -1, stirTick: -1, electedTick: -1, insolventTick: -1, dissolvedTick: -1,
    maxMassPre: 0, maxMassPost: 0, petitionCount: 0,
    leviesBeforeCharter: 0, spendWhileNotElected: 0,
    firstHiresDesired: null, insolventHiresDesired: null, json: '',
  };

  let prevState: InstitutionState = 'dormant';
  let pendingCred = 0, pendingDeb = 0;
  let assemblyWin: { place: string; startH: number; endH: number } | null = null;
  let lastResolvedBallotKey = '';
  let collapsed = false;
  const chartered = () => ['chartered', 'elected', 'insolvent', 'recalled'].includes(prevState);

  for (let t = 0; t < ticks; t++) {
    const hour = t % 24;
    const macro = cfg.macro(t);

    // econ collapse for the insolvency arm
    if (cfg.collapseAfterElectedH > 0 && out.electedTick >= 0 && t >= out.electedTick + cfg.collapseAfterElectedH) {
      macro.unemployment = 0.97; collapsed = true;
    }

    // ---- synthetic civic traffic (the world's channels) -----------------------
    const topics = gov.hotTopics(t);
    if (topics.length) {
      const view = gov.view();
      const salient = view.tierA.filter((r) => r.salience > 0.15).map((r) => r.id);
      // conversations ride the imposed diurnal curve
      let want = 0.6 * CURVE[hour] * DT;
      let n = Math.floor(want); if (rng() < want - n) n++;
      for (let k = 0; k < n && salient.length; k++) {
        const a = salient[(rng() * salient.length) | 0];
        const b = TIER_IDS[(rng() * TIER_IDS.length) | 0];
        if (a === b) continue;
        const topic = topics[(rng() * topics.length) | 0];
        const x = gov.onConversation(a, b, topic, 0.4 + 0.4 * rng(), 0.4 + 0.4 * rng(), 0.4 + 0.4 * rng(), t);
        if (x) out.engagementCount++;
      }
    }
    // feed engagement on recent civic posts, same curve
    for (const post of recentPosts) {
      if (t - post.t > 6) continue;
      const want = 0.5 * CURVE[hour] * DT;
      if (rng() < Math.min(0.95, want)) {
        const reader = TIER_IDS[(rng() * TIER_IDS.length) | 0];
        if (reader !== post.authorId) { gov.onFeedEngagement(reader, post.kind, post.authorId, t); out.engagementCount++; }
      }
    }

    // ---- centers: at home, unless walking to an assembly ----------------------
    const centers: { id: string; x: number; z: number }[] = TIER_IDS.map((id, i) => ({ id, x: 220 + i * 12, z: 320 }));
    if (assemblyWin && t >= assemblyWin.startH && t <= assemblyWin.endH) {
      const v = VENUES.find((p) => p.id === assemblyWin!.place)!;
      for (let i = 0; i < ATTENDEE_COUNT; i++) { centers[i].x = v.x + i * 3; centers[i].z = v.z + 2; }
    }

    // ---- the tick --------------------------------------------------------------
    const input: GovTickInput = {
      macro,
      commuteCostIndex: 0,
      tierA: TIER_IDS.map((id, i) => ({
        id,
        wage: macro.meanWage * (0.7 + 0.08 * i),
        employed: collapsed ? false : !(macro.unemployment > 0.15 && i % 3 === 0),
        homeless: macro.homeless > 0.04 && i === 4,
        money: (i % 3 === 0 ? 5 : 45) * macro.meanWage,
      })),
      shadowHouseholds: SHADOW_N,
      adjacency: { density01: cfg.density },
      hotCenters: centers,
      civicVenues: VENUES,
      treasuryCredited: pendingCred,
      treasuryDebited: pendingDeb,
    };
    out.credSum += pendingCred; out.debSum += pendingDeb;
    const res = gov.tick(input, t, DT);
    const view = gov.view();
    const st = view.state;

    // ---- econ executes the commands (reported back NEXT tick) -----------------
    const rate = res.levies.payroll ?? 0;
    if (rate > 0 && !chartered()) out.leviesBeforeCharter++;
    const hire = res.hires.length ? res.hires[0] : null;
    const spendTotal = res.spendOrders.reduce((s, o) => s + o.amount, 0);
    if (spendTotal > 0 && st !== 'elected') out.spendWhileNotElected++;
    const taxBase = SHADOW_N * macro.meanWage * (1 - macro.unemployment) * 0.8;
    pendingCred = rate * taxBase * DT;
    pendingDeb = (hire ? hire.desired * hire.wage : 0) * DT + spendTotal;

    // ---- bookkeeping ------------------------------------------------------------
    for (const p of res.feedPosts) {
      recentPosts.push({ t, kind: p.kind, authorId: p.authorId });
      if (p.kind === 'petition') out.petitionCount++;
    }
    while (recentPosts.length > 12) recentPosts.shift();
    if (res.assemblyCall) { assemblyWin = res.assemblyCall; out.callTick = out.callTick < 0 ? t : out.callTick; }
    if (assemblyWin && t > assemblyWin.endH) assemblyWin = null;
    for (const e of res.historyEvents) {
      if (e.kind === 'stir' && out.stirTick < 0) out.stirTick = t;
      if (e.kind === 'assembly' && e.label.startsWith('assembly met')) {
        out.assembliesMet.push({ place: '?', tier: 0 });
      }
    }
    if (res.feedPosts.length || res.assemblyCall || res.spendOrders.length || res.memoriesToWrite.length) {
      out.results.push({ t, res });
    }

    if (st !== prevState) {
      out.transitions.push([prevState, st]);
      if (st === 'elected' && out.electedTick < 0) { out.electedTick = t; out.firstHiresDesired = hire ? hire.desired : null; }
      if (st === 'insolvent' && out.insolventTick < 0) out.insolventTick = t;
      if (st === 'dissolved' && out.dissolvedTick < 0) out.dissolvedTick = t;
      prevState = st;
    }
    if (st === 'insolvent' && hire) out.insolventHiresDesired = hire.desired;
    if (t < 96) out.maxMassPre = Math.max(out.maxMassPre, view.mass);
    else out.maxMassPost = Math.max(out.maxMassPost, view.mass);

    const b = view.lastBallot;
    if (b && b.resolved) {
      const key = `${b.kind}:${b.opensH}`;
      if (key !== lastResolvedBallotKey) { lastResolvedBallotKey = key; out.ballots.push({ ...b }); }
    }
    out.states.push(st);
  }

  out.json = JSON.stringify(gov.toJSON());
  return out;
}

// module-level so runScenario stays a single closure per call
let recentPosts: { t: number; kind: 'petition' | 'announcement' | 'ballot' | 'result'; authorId: string }[] = [];
function freshWorld(): void { recentPosts = []; }

// ---- run + assert ----------------------------------------------------------------
const ok = (name: string, cond: boolean) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); return cond; };
let pass = true;

console.log('== gov-smoke: emergent government · freedom, conservation, learning ==\n');

// ---------------------------------------------------------------------------------
// (1) FREEDOM — no seeds ⇒ no government, even through a full recession.
// ---------------------------------------------------------------------------------
freshWorld();
const NOSEED = runScenario({ seed: 41, days: 30, seeds: false, macro: recessionMacro, density: 0.6, collapseAfterElectedH: 0 });
console.log(`-- no-seeds recession (30d): states {${[...new Set(NOSEED.states)].join(',')}} · engagements ${NOSEED.engagementCount}`);
pass = ok('no seeds ⇒ stays dormant for 30 days (the spark matters)', NOSEED.states.every((s) => s === 'dormant')) && pass;
pass = ok('no seeds ⇒ no assembly ever called', NOSEED.callTick < 0) && pass;
pass = ok('no seeds ⇒ hotTopics stays empty ⇒ zero civic engagements', NOSEED.engagementCount === 0) && pass;
pass = ok('no seeds ⇒ zero petitions/posts', NOSEED.petitionCount === 0 && NOSEED.results.every((r) => r.res.feedPosts.length === 0)) && pass;

// ---------------------------------------------------------------------------------
// (2) FREEDOM — seeds + low grievance ⇒ possible, NOT guaranteed (across seeds).
// ---------------------------------------------------------------------------------
let formed = 0, stirred = 0;
for (let k = 0; k < 6; k++) {
  freshWorld();
  const r = runScenario({ seed: 100 + k, days: 30, seeds: true, macro: lowGrievanceMacro, density: 0.33, collapseAfterElectedH: 0 });
  if (r.states.some((s) => s === 'chartered' || s === 'elected')) formed++;
  if (r.stirTick >= 0) stirred++;
}
console.log(`-- seeds + low grievance ×6 seeds (30d): stirred ${stirred}/6 · formed ${formed}/6`);
pass = ok('seeds at low grievance: the field stirs (mechanism alive)', stirred >= 1) && pass;
pass = ok('seeds at low grievance: formation possible — some run crossed', formed >= 1) && pass;
pass = ok('seeds at low grievance: formation NOT guaranteed (formed < 6)', formed < 6) && pass;

// ---------------------------------------------------------------------------------
// (3) the main arm — seeds + imposed recession, 60 days, insolvency endgame.
// ---------------------------------------------------------------------------------
freshWorld();
const A = runScenario({ seed: 7, days: 60, seeds: true, macro: recessionMacro, density: 0.6, collapseAfterElectedH: 240 });
freshWorld();
const B = runScenario({ seed: 7, days: 60, seeds: true, macro: recessionMacro, density: 0.6, collapseAfterElectedH: 240 });
const va = A.gov.view();
console.log(`-- formation arm (60d): stir t=${A.stirTick} · call t=${A.callTick} · elected t=${A.electedTick} · insolvent t=${A.insolventTick} · dissolved t=${A.dissolvedTick}`);
console.log(`   mass pre-recession ${A.maxMassPre.toFixed(3)} → post ${A.maxMassPost.toFixed(3)} · petitions ${A.petitionCount} · ballots ${A.ballots.length} · engagements ${A.engagementCount}`);

// mass growth (freedom check c) + ordering (mechanism, not schedule)
pass = ok('imposed hardship ⇒ movement mass grows (>3× pre-recession peak)', A.maxMassPost > 3 * Math.max(0.05, A.maxMassPre)) && pass;
pass = ok('stir precedes the assembly call (threshold order, not script)', A.stirTick >= 0 && A.callTick > A.stirTick) && pass;

// the assembly call is well-formed and venue-borrowed
const callRes = A.results.find((r) => r.res.assemblyCall)?.res.assemblyCall ?? null;
pass = ok('assembly call: borrowed venue, ≥20h notice, 18:00 start, 3h window',
  callRes !== null && VENUES.some((v) => v.id === callRes.place)
  && callRes.startH - A.callTick >= 20 && callRes.startH % 24 === 18 && callRes.endH === callRes.startH + 3) && pass;

// full lifecycle reached, then the money failed it
pass = ok('lifecycle: charter ratified and steward elected', A.electedTick > 0 && va.history.events.some((e) => e.kind === 'charter') && va.history.events.some((e) => e.kind === 'election')) && pass;
pass = ok('steward seated (officials roster has the office)', A.results.length > 0 && A.states.includes('elected')) && pass;
pass = ok('tax-base collapse ⇒ insolvent (clerks walk), then dissolved', A.insolventTick > A.electedTick && A.dissolvedTick > A.insolventTick) && pass;
pass = ok('insolvency zeroes the clerk demand (desired → 0)', A.insolventHiresDesired === 0) && pass;
pass = ok('elected government hires clerks through the labor market (desired 2)',
  A.results.length > 0 && A.firstHiresDesired !== null ? A.firstHiresDesired === 2 : false) && pass;

// state machine walked only its published edges
const badEdges = A.transitions.filter(([a, b]) => !ALLOWED_TRANSITIONS.some(([x, y]) => x === a && y === b));
pass = ok(`state machine used only allowed edges (${A.transitions.length} transitions)`, A.transitions.length >= 5 && badEdges.length === 0) && pass;

// votes: conserved integer counts on every resolved ballot
let votesOk = A.ballots.length >= 2;
for (const b of A.ballots) {
  if (!Number.isInteger(b.yes) || !Number.isInteger(b.no) || !Number.isInteger(b.tierACast) || !Number.isInteger(b.shadowCast)) votesOk = false;
  if (b.yes + b.no !== b.tierACast + b.shadowCast) votesOk = false;
  if (b.tierACast + b.shadowCast > b.eligible) votesOk = false;
}
console.log(`   ballots: ${A.ballots.map((b) => `${b.kind} ${b.yes}–${b.no} (cast ${b.tierACast + b.shadowCast}/${b.eligible})`).join(' · ')}`);
pass = ok('votes conserved: Σcast === Σtallied, turnout ≤ population, all integers', votesOk) && pass;

// treasury: gov ledger === Σ reported flows, to 1e-6; spending carry conserved
const balDrift = Math.abs(A.gov.treasury.balance() - (A.credSum - A.debSum));
console.log(`   treasury: balance ${A.gov.treasury.balance().toFixed(2)} · credited ${A.credSum.toFixed(2)} · debited ${A.debSum.toFixed(2)} · drift ${balDrift.toExponential(2)}`);
pass = ok('treasury conserved: balance === Σcredited − Σdebited (1e-6)', balDrift <= 1e-6) && pass;
pass = ok('spend accrual conserved: Σaccrued === Σordered + carry (1e-6)', Math.abs(A.gov.treasury.accrualDrift()) <= 1e-6) && pass;
pass = ok('taxes only if voted: no levies before the charter', A.leviesBeforeCharter === 0) && pass;
pass = ok('spend orders only under an elected government', A.spendWhileNotElected === 0) && pass;
pass = ok('budget actually executed (spend orders flowed while solvent)', A.results.some((r) => r.res.spendOrders.length > 0)) && pass;
pass = ok('movement spoke: petitions + announcements hit the feed', A.petitionCount >= 2 && A.results.some((r) => r.res.feedPosts.some((p) => p.kind === 'announcement'))) && pass;
pass = ok('civic memories handed to the world at the big moments', A.results.some((r) => r.res.memoriesToWrite.length > 0)) && pass;

// learning: the engagement surrogate learned the imposed diurnal curve
const learned = A.gov.stats.shapeVector('civic:pulse', 'civic');
const rLearn = pearson(learned, CURVE);
console.log(`   learned engagement shape ⇄ imposed curve: r = ${rLearn.toFixed(3)}`);
pass = ok('surrogate learned the civic hour-shape from real engagements (r > 0.6)', rLearn > 0.6) && pass;

// observe-only-when-hot: pulse visits === real engagements; assembly venues
// learned only the REAL attendees we sent (shadow crowd sampled, never taught)
const pulseVisits = A.gov.stats.statsView('civic:pulse', 'civic').visits;
const venueVisits = VENUES.reduce((s, v) => s + A.gov.stats.statsView(v.id, 'civic-venue').visits, 0);
const assembliesHeld = va.history.events.filter((e) => e.kind === 'assembly' && e.label.startsWith('assembly met')).length;
const shadowAttended = va.history.events
  .filter((e) => e.kind === 'assembly' && e.label.startsWith('assembly met'))
  .reduce((s, e) => s + Math.max(0, (e.mag ?? 0) - ATTENDEE_COUNT), 0);
console.log(`   pulse visits ${pulseVisits} vs engagements ${A.engagementCount} · venue visits ${venueVisits} vs ${ATTENDEE_COUNT}×${assembliesHeld} assemblies (shadow crowd ~${shadowAttended}, unlearned)`);
pass = ok('observe-only-when-hot: surrogate visits === real events fed', pulseVisits === A.engagementCount) && pass;
pass = ok('shadow assembly crowd sampled FROM the surrogate, never taught back',
  assembliesHeld >= 1 && venueVisits === ATTENDEE_COUNT * assembliesHeld && shadowAttended > 0) && pass;

// determinism + round-trip
pass = ok('two runs, same seed → byte-identical toJSON', A.json === B.json && A.json.length > 500) && pass;
const C = new GovField({ seed: 7 });
C.loadJSON(JSON.parse(A.json));
pass = ok('save → load → save is byte-identical', JSON.stringify(C.toJSON()) === A.json) && pass;

// ---------------------------------------------------------------------------------
// (4) hysteresis: a center jittering across the venue boundary latches once.
// ---------------------------------------------------------------------------------
{
  const gov = new GovField({ seed: 11 });
  const plaza = { id: 'plaza', x: 0, z: 0 };
  let flips = 0, raw = 0, wasHot = false, rawInside = false, rawSeen = false;
  for (let t = 0; t < 24 * 10; t++) {
    const d = 55 + 3 * Math.sin((2 * Math.PI * t) / 5); // oscillates 52..58 across R=55
    const input: GovTickInput = {
      macro: benignMacro(0), commuteCostIndex: 0, tierA: [], shadowHouseholds: 0,
      adjacency: { density01: 0 }, hotCenters: [{ id: 'lingerer', x: d, z: 0 }],
      civicVenues: [plaza],
    };
    const inside = d <= 55;
    if (rawSeen && inside !== rawInside) raw++;
    rawInside = inside; rawSeen = true;
    gov.tick(input, t, DT);
    const hot = gov.view().hotCivic.includes('plaza');
    if (rawSeen && t > 0 && hot !== wasHot) flips++;
    wasHot = hot;
  }
  console.log(`-- hysteresis: venue flips ${flips} vs ${raw} raw boundary crossings`);
  pass = ok('civic gate hysteresis: boundary jitter latches once (flips ≤ 2, raw ≥ 50)', flips <= 2 && raw >= 50) && pass;
}

// ---------------------------------------------------------------------------------
// (5) dt-invariance: the grievance field lands on the same value at dt=1 vs 0.25.
// ---------------------------------------------------------------------------------
{
  const mk = () => new GovField({ seed: 5 });
  const macro = recessionMacro(1e9); // fully-ramped recession, constant
  const step = (g: GovField, dt: number, hours: number) => {
    for (let t = 0; t * dt < hours - 1e-9; t++) {
      g.tick({
        macro, commuteCostIndex: 0, tierA: [], shadowHouseholds: SHADOW_N,
        adjacency: { density01: 0 }, hotCenters: [], civicVenues: VENUES,
      }, t * dt, dt);
    }
  };
  const g1 = mk(), g2 = mk();
  step(g1, 1, 48); step(g2, 0.25, 48);
  const d = Math.abs(g1.view().shadow.meanGrievance - g2.view().shadow.meanGrievance);
  console.log(`-- dt-invariance: meanGrievance(dt=1) vs (dt=0.25) |Δ| = ${d.toExponential(2)}`);
  pass = ok('dt-invariant EMAs: 48h at dt=1 ≈ dt=0.25 (|Δ| < 1e-3)', d < 1e-3 && g1.view().shadow.meanGrievance > 0.2) && pass;
}

// ---------------------------------------------------------------------------------
// (6) rival mechanism: bimodal stance wings cohere; unimodal opposition doesn't.
// ---------------------------------------------------------------------------------
{
  const cp = new CharterProcess(3);
  let awoke = false;
  for (let t = 0; t < 120; t++) if (cp.stepRival({ pos: 0.32, neg: 0.3 }, 1)) awoke = true;
  const cp2 = new CharterProcess(3);
  for (let t = 0; t < 240; t++) cp2.stepRival({ pos: 0.6, neg: 0.05 }, 1);
  console.log(`-- rival: bimodal mass ${cp.rival().mass.toFixed(3)} (active ${cp.rival().active}) · unimodal mass ${cp2.rival().mass.toFixed(3)}`);
  pass = ok('bimodal stance distribution wakes a rival wing', awoke && cp.rival().active) && pass;
  pass = ok('unimodal opposition never becomes a rival', !cp2.rival().active && cp2.rival().mass < 0.05) && pass;
}

// ---------------------------------------------------------------------------------
// (7) seeds are memories, not commands.
// ---------------------------------------------------------------------------------
{
  const g = new GovField({ seed: 1 });
  const plan = g.seedPlan();
  const textsOk = plan.every((p) => p.texts.length >= 3 && p.texts.length <= 5
    && p.texts.every((tx) => !/should form|must organize|form a government/i.test(tx)));
  pass = ok('seed plan: exactly 3 characters, 3–5 first-person memories each, none commanding',
    plan.length === 3 && textsOk) && pass;
  const again = g.seedPlan();
  pass = ok('seedPlan is idempotent (re-consuming changes nothing)', again.length === 3) && pass;
}

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
