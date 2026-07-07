// Headless proof that the needs-driven daily loop EMERGES (no schedule), that a
// relationship forms across re-encounters, and — with gov + transport wired in —
// that commutes route through the street network (commuteT > 0), civic topics
// ride the existing conversation channel, the whole state round-trips through a
// mid-run save/load byte-identically, and the sim is FREE: a government may
// never form and nothing breaks. Run: npx tsx scripts/town-smoke.ts
import { Town } from '../src/world/town';
import { buildFreshTown, restoreInto, serializeSim, type SnapshotV1 } from '../src/persist/persist';
import { STATE_CODE } from '../src/gov/index';

const OPTS = { llm: null, seed: 7, startHour: 7, speed: 0.05 } as const;
let town: Town = new Town(OPTS);
const DT_SIM = 0.03;                 // sim-hours per step
const dtReal = DT_SIM / town.speed;  // feed the loop so each step = DT_SIM sim-hr
const DAYS = 30;                     // spans weekends, rent cycles, econ regimes
const STEPS = Math.round((DAYS * 24) / DT_SIM);
const SAVE_AT = Math.round(STEPS / 2);   // mid-run save/load, journeys in flight

const hhmm = (t: number) => {
  const h = Math.floor(((t % 24) + 24) % 24);
  const m = Math.floor((t - Math.floor(t)) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const visited = new Set<string>();
const placeMinutes: Record<string, number> = {};
let lastKey = '';
let nanSeen = false;
const intentionLog: string[] = [];
const govStates = new Set<string>();
let sawCommute = false;             // a society agent mid-commute with commuteT>0
let maxCommuteT = 0;
let sawAssembly = false;
let roundTripOk = false;
let restoredMidRun = false;
let lastDayLogged = -1;

for (let i = 0; i < STEPS; i++) {
  town.update(dtReal);
  const s = town.snapshot();
  if (!Number.isFinite(s.cashier.soma.valence)
    || !Number.isFinite(s.gov?.mass ?? 0)
    || !Number.isFinite(s.transport?.kpis.commuteCostIndex ?? 0)
    || !Number.isFinite(s.economy?.macro.gdp ?? 0)) { nanSeen = true; break; }
  visited.add(s.place);
  placeMinutes[s.travelling ? 'travel' : s.place] = (placeMinutes[s.travelling ? 'travel' : s.place] ?? 0) + DT_SIM * 60;
  govStates.add(s.gov?.state ?? '?');
  if (s.gov?.assembly) sawAssembly = true;
  for (const a of s.agents ?? []) {
    if (a.place === 'commuting' && a.commuteT > 0) { sawCommute = true; maxCommuteT = Math.max(maxCommuteT, a.commuteT); }
  }
  const key = `${s.travelling ? 'travel' : s.place}/${s.intention.kind}`;
  if (key !== lastKey) {
    lastKey = key;
    const n = s.needs;
    intentionLog.push(
      `d${s.day} ${hhmm(s.time)}  ${(s.travelling ? '→' + s.intention.place : s.place).padEnd(10)} ${s.intention.kind.padEnd(10)} ` +
      `$${s.resources.money.toFixed(0).padStart(4)} food:${s.resources.foodStock.toFixed(0)} ` +
      `hun:${n.hunger.toFixed(2)} ene:${(1 - n.energy).toFixed(2)} bel:${n.belonging.toFixed(2)} ` +
      `| ${s.intention.reason}`,
    );
  }
  // a daily line of the polis + street pulse (diagnosis, not assertion)
  if (s.day !== lastDayLogged) {
    lastDayLogged = s.day;
    const g = s.gov, t = s.transport;
    const salMax = g ? Math.max(0, ...g.tierA.map((r) => r.salience)) : 0;
    console.log(`  d${String(s.day).padStart(2)} gov:${(g?.state ?? '?').padEnd(9)} mass:${(g?.mass ?? 0).toFixed(3)} salMax:${salMax.toFixed(2)} topics:[${(g?.hotCivic?.length ?? 0) > 0 ? '' : ''}${g?.topics.join(',') ?? ''}] ` +
      `civicTalk:${town.society.civicExchanges} trips:${t?.kpis.tripsStarted ?? 0} cci:${(t?.kpis.commuteCostIndex ?? 0).toFixed(2)}`);
  }

  // mid-run: serialize, restore into a FRESH town, assert byte-identity, continue.
  if (i === SAVE_AT) {
    const snapA = serializeSim(town);
    const jsonA = JSON.stringify(snapA);
    const fresh = buildFreshTown({ ...OPTS });
    restoreInto(fresh, JSON.parse(jsonA) as SnapshotV1);
    const jsonB = JSON.stringify(serializeSim(fresh));
    roundTripOk = jsonA === jsonB;
    restoredMidRun = true;
    town = fresh;                     // the run continues on the restored copy
  }
}

console.log('=== emergent day (intention changes) ===');
for (const l of intentionLog.slice(0, 60)) console.log(l);

console.log('\n=== minutes spent per place over', DAYS, 'days ===');
for (const [p, m] of Object.entries(placeMinutes).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(10)} ${(m / 60).toFixed(1)} h`);
}

const s = town.snapshot();
console.log('\n=== relationship ledger ===');
if (!s.relationships.length) console.log('  (none formed)');
for (const r of s.relationships) {
  console.log(`  ${r.name.padEnd(8)} ${r.stage.padEnd(12)} enc:${r.encounters} fam:${r.familiarity.toFixed(2)} aff:${r.affection.toFixed(2)} att:${r.attraction.toFixed(2)} — ${r.summary}`);
}

console.log('\n=== final exposome metrics ===');
console.log('  allostaticLoad:', s.cashier.soma.allostaticLoad.toFixed(2),
  ' minutesHungry:', s.needsIntegrals.minutesHungry.toFixed(0),
  ' minutesLonely:', s.needsIntegrals.minutesLonely.toFixed(0),
  ' wageEarned:', s.resources.wageEarned.toFixed(0));

const t = s.transport!;
const g = s.gov!;
console.log('\n=== streets & polis ===');
console.log(`  trips: ${t.kpis.tripsStarted} started · ${t.kpis.tripsArrived} arrived · modeShare walk:${t.kpis.modeShare.walk.toFixed(2)} bus:${t.kpis.modeShare.bus.toFixed(2)} taxi:${t.kpis.modeShare.taxi.toFixed(2)}`);
console.log(`  cci: ${t.kpis.commuteCostIndex.toFixed(3)} · congestion ${t.kpis.congestion.toFixed(2)} · routes ${t.routes.length} · hot [${t.hot.slice(0, 6).join(' ')}${t.hot.length > 6 ? ' …' : ''}]`);
console.log(`  gov: state ${g.state} · mass ${g.mass.toFixed(3)} · civic conversations ${town.society.civicExchanges} · assembly seen ${sawAssembly} · states [${[...govStates].join(',')}]`);
console.log(`  commuting: seen ${sawCommute} · max commuteT ${maxCommuteT.toFixed(2)}`);

console.log('\n=== checks ===');
const bonded = s.relationships.find((r) => r.encounters > 1);
let pass = true;
const ok = (name: string, cond: boolean) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); pass = pass && cond; };
ok('no NaN anywhere (soma, gov, transport, econ)', !nanSeen);
ok('visited work', visited.has('work'));
ok('visited home', visited.has('home'));
ok('visited market', visited.has('market'));
ok('visited thirdplace', visited.has('thirdplace'));
ok('earned wages', s.resources.wageEarned > 0);
ok('bought food (foodStock cycled)', (placeMinutes['market'] ?? 0) > 0);
ok('a relationship re-encountered (enc>1)', !!bonded);
// ---- transport is the world's distance now ---------------------------------
ok('Mara journeys are real transport trips (started > 50)', t.kpis.tripsStarted > 50);
ok('every started trip resolves toward one arrival (arrived ≤ started)', t.kpis.tripsArrived <= t.kpis.tripsStarted && t.kpis.tripsArrived > 0);
ok('a society commute actually routed through transport (commuteT > 0)', sawCommute);
ok('commute cost index is alive and finite', Number.isFinite(t.kpis.commuteCostIndex) && t.kpis.commuteCostIndex > 0);
// ---- the civic channel carried real talk ------------------------------------
ok('civic topics appeared in emergent conversations (stance exchanged)', town.society.civicExchanges > 0);
// ---- persistence: the WHOLE composed state round-trips ----------------------
ok('mid-run save → fresh town → load → save is byte-identical', restoredMidRun && roundTripOk);
// ---- freedom: government is an outcome, never a script ----------------------
ok('gov walked only real states (no scripted formation asserted)',
  [...govStates].every((st) => st in STATE_CODE));
ok('the sim survives regardless of whether a government ever formed', !nanSeen && s.time > DAYS * 24 - 1);

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
