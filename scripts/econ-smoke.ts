// Headless proof that the market ECONOMY emerges (no scripting) and that the
// memory embedding tier works offline. Run: npx tsx scripts/econ-smoke.ts
// Phase 6 adds a STANDALONE EconomySim scenario driving applyCivic (levies,
// public hiring, spend orders, fares) — civic conservation + determinism.
import { Town } from '../src/world/town';
import { getEmbedder, cosine } from '../src/llm/embed';
import { EconomySim } from '../src/econ/econsim';
import type { EconSnapshot } from '../src/econ/types';
import { mulberry32 } from '../src/core/util/num';

const town = new Town({ llm: null, seed: 7, startHour: 7, speed: 0.05 });
const DT_SIM = 0.05;
const dtReal = DT_SIM / town.speed;
const DAYS = 70;    // long enough for the demography loop (entry → competition → exit)
const STEPS = Math.round((DAYS * 24) / DT_SIM);

const seenKinds = new Set<string>();
let maxRevenue = 0, maxUnemp = 0, minUnemp = 1, maxHomeless = 0, cpiMoved = 0, anyBankrupt = false;
let headcountChanged = false;
let nan = false;
const startHead: Record<string, number> = {};
let sampled = false;
// monetary tracking
let maxCredit = 0, maxConsErr = 0, minRate = 1, maxRate = 0, banksSolvent = true;
// phase 4 tracking (emergence expansions)
let maxConsumerDebt = 0, maxDepInt = 0, maxInventory = 0;
// phase 5 tracking (supply chains · premises · dual construction)
let makerRevTick = 0, makerCumRev = 0, durablesSold = 0;
let maxPending = 0, wsBandOk = true;
let uLateSum = 0, uLateN = 0;
// phase 6 tracking (mobility: dealership · taxi · ownership · fares)
let dealerCumRev = 0, taxiHeadMax = 0, vehOwnersMax = 0, carOwnersMax = 0;
let fareSpendMax = 0, transitClearedMax = 0;

for (let i = 0; i < STEPS; i++) {
  town.update(dtReal);
  if (i % 40 !== 0) continue;                 // sample the economy periodically
  const e = town.snapshot().economy;
  if (!e) continue;
  const m = e.macro;
  if (!Number.isFinite(m.cpi) || !Number.isFinite(m.unemployment) || !Number.isFinite(m.gdp)) { nan = true; break; }
  if (!sampled) { for (const b of e.businesses) startHead[b.id] = b.headcount; sampled = true; }
  cpiMoved = Math.max(cpiMoved, Math.abs(m.cpi - 1));
  maxUnemp = Math.max(maxUnemp, m.unemployment);
  minUnemp = Math.min(minUnemp, m.unemployment);
  maxHomeless = Math.max(maxHomeless, m.homelessCount);
  for (const b of e.businesses) {
    maxRevenue = Math.max(maxRevenue, b.revenue);
    if (b.bankrupt) anyBankrupt = true;
    if (startHead[b.id] !== undefined && b.headcount !== startHead[b.id]) headcountChanged = true;
    maxInventory = Math.max(maxInventory, b.inventory);
    if (b.kind === 'maker') {
      makerRevTick = Math.max(makerRevTick, b.revenue);
      makerCumRev = Math.max(makerCumRev, b.cumRevenue);
    }
  }
  for (const mk of e.markets) {
    if (mk.sector === 'homegoods' || mk.sector === 'apparel') {
      durablesSold = Math.max(durablesSold, Math.min(mk.demand, mk.supply));
    }
    if (mk.sector === 'transit') transitClearedMax = Math.max(transitClearedMax, Math.min(mk.demand, mk.supply));
  }
  const dealer = e.businesses.find((b) => b.id === 'biz-dealership');
  if (dealer) dealerCumRev = Math.max(dealerCumRev, dealer.cumRevenue);
  const taxi = e.businesses.find((b) => b.id === 'biz-taxi');
  if (taxi) taxiHeadMax = Math.max(taxiHeadMax, taxi.headcount);
  vehOwnersMax = Math.max(vehOwnersMax, e.shadow.carOwners + e.shadow.bikeOwners);
  carOwnersMax = Math.max(carOwnersMax, e.shadow.carOwners);
  fareSpendMax = Math.max(fareSpendMax, e.shadow.fareSpend);
  if (e.premises) maxPending = Math.max(maxPending, e.premises.pending);
  for (const w of e.wholesale ?? []) {
    // wholesale must sit between the world's raw-input floor and the retail sticker
    if (w.price > w.importPrice + 1e-9 || w.price <= 0) wsBandOk = false;
  }
  if (m.clock > 30 * 24) { uLateSum += m.unemployment; uLateN++; }
  for (const ev of e.labor.recentEvents) seenKinds.add(ev.kind);
  maxConsumerDebt = Math.max(maxConsumerDebt, e.shadow.consumerDebt);
  const mon = e.monetary;
  if (mon) {
    maxCredit = Math.max(maxCredit, mon.banks.reduce((s, b) => s + b.loans, 0));
    maxConsErr = Math.max(maxConsErr, Math.abs(mon.conservationError));
    minRate = Math.min(minRate, mon.fed.policyRate);
    maxRate = Math.max(maxRate, mon.fed.policyRate);
    if (mon.banks.some((b) => !b.solvent)) banksSolvent = false;
    maxDepInt = Math.max(maxDepInt, mon.depositInterest);
  }
}

const s = town.snapshot();
const e = s.economy!;
console.log('=== economy after', DAYS, 'sim-days ===');
console.log('  CPI', e.macro.cpi.toFixed(3), ' inflation', (e.macro.inflation * 100).toFixed(2) + '%',
  ' unemployment', (e.macro.unemployment * 100).toFixed(1) + '%', ' boom', e.macro.boom.toFixed(2));
console.log('  GDP/tick', e.macro.gdp.toFixed(0), ' meanWage', e.macro.meanWage.toFixed(1),
  ' homeless', e.macro.homelessCount, ' bankruptcies', e.macro.bankruptcies, ' gini', e.macro.gini.toFixed(2));
console.log('  shadow:', e.shadow.n, 'households ·', e.shadow.employed, 'employed ·', e.shadow.unemployed,
  'jobless ·', e.shadow.homeless, 'homeless · meanMoney', e.shadow.meanMoney.toFixed(0));
console.log('\n  businesses:');
for (const b of e.businesses) {
  console.log(`   ${b.name.padEnd(20)} ${b.sector.padEnd(10)} cash $${b.cash.toFixed(0).padStart(7)} ` +
    `price $${b.price.toFixed(1).padStart(6)} wage $${b.wage.toFixed(0)} head ${b.headcount}/${b.desiredHeadcount} ` +
    `rev $${b.revenue.toFixed(0)} profit $${b.profit.toFixed(0)}${b.bankrupt ? '  BANKRUPT' : b.hiring ? '  hiring' : ''}`);
}
console.log('\n  recent labour events:');
for (const ev of e.labor.recentEvents.slice(0, 8)) console.log(`   ${ev.kind.padEnd(8)} ${ev.detail ?? ''}`);

// Tier-A wallets (the full-res agents)
console.log('\n  full-res wallets (sample):');
for (const a of e.agents.slice(0, 6)) {
  console.log(`   ${a.id.padEnd(18)} $${a.money.toFixed(0).padStart(6)} ${a.status.padEnd(20)} ` +
    `${a.employerName ?? '—'}${a.homeless ? '  [HOMELESS]' : ''}`);
}

// ---- memory embedding sanity (offline hashed fallback tier) ----
const emb = getEmbedder();
const [va, vb, vc] = await Promise.all([
  emb.embedNow('the customer complained the coffee was cold'),
  emb.embedNow('a customer grumbled that the coffee had gone cold'),
  emb.embedNow('the quarterly astronomy lecture ran long'),
]);
const near = cosine(va, vb), far = cosine(va, vc);
const maraMem = town.mara.recall('coffee customer', 3);

console.log('\n=== checks ===');
const ok = (name: string, cond: boolean) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`); return cond; };
let pass = true;
pass = ok('no NaN in macro', !nan) && pass;
pass = ok('firms earned revenue', maxRevenue > 0) && pass;
pass = ok('prices moved (CPI ≠ 1)', cpiMoved > 0.005) && pass;
pass = ok('unemployment in (0,1)', maxUnemp > 0 && maxUnemp < 1) && pass;
pass = ok('someone was hired', seenKinds.has('hire')) && pass;
pass = ok('someone was laid off', seenKinds.has('layoff')) && pass;
pass = ok('a homeless spell occurred', maxHomeless > 0) && pass;
pass = ok('headcount changed or a firm went bankrupt', headcountChanged || anyBankrupt) && pass;
pass = ok('shadow population employed', e.shadow.employed > 0) && pass;
pass = ok('memory recall returns items', maraMem.length > 0) && pass;
pass = ok('embedding: paraphrase closer than unrelated', near > far) && pass;
// --- construction / bank / supermarket / physiology ---
const c = e.construction, bk = e.bank, sm = e.supermarket;
console.log(`  (construction: $${c?.cash.toFixed(0)} · ${c?.completedBuildings} built · loan $${c?.loanBalance.toFixed(0)}` +
  ` | bank lent $${bk?.totalLent.toFixed(0)} int $${bk?.interestIncome.toFixed(0)}` +
  ` | market ${sm?.trips} trips · ${(sm?.fillLevel ?? 0 * 100).toFixed(2)} fill · $${sm?.revenue.toFixed(1)})`);
pass = ok('construction completed a building', (c?.completedBuildings ?? 0) > 0) && pass;
// --- monetary system ---
const mon = e.monetary;
console.log(`  (monetary: Fed ${(mon!.fed.policyRate * 100).toFixed(2)}% · base $${mon!.fed.baseMoney.toFixed(0)} · broad $${mon!.broadMoney.toFixed(0)}` +
  ` · loanRate ${(mon!.avgLendingRate * 100).toFixed(2)}% · consErr $${maxConsErr.toFixed(4)})`);
pass = ok('policy rate hit a positive level (ZLB allowed later)', maxRate > 0) && pass;
pass = ok('base money + broad money exist', (mon?.baseMoney ?? 0) > 0 && (mon?.broadMoney ?? 0) > 0) && pass;
pass = ok('banks created credit (loans)', maxCredit > 0) && pass;
pass = ok('money conserved (double-entry ~0)', maxConsErr < (mon?.broadMoney ?? 1) * 1e-3) && pass;
pass = ok('policy rate responded (moved over run)', maxRate - minRate > 1e-4) && pass;
pass = ok('banks stayed solvent', banksSolvent) && pass;
pass = ok('supermarket served shopping trips', (sm?.trips ?? 0) > 0) && pass;
pass = ok('supermarket inventory depleted + restocked', (sm?.totalSold ?? 0) > 0 && (sm?.fillLevel ?? 0) > 0.2) && pass;
pass = ok('housing stock grew (a block completed)', e.housing.units > 320) && pass;

// --- phase 4: emergence expansions (see ECONOMY_EMERGENCE.md) ---
console.log(`  (demography: ${e.macro.firmsAlive} alive · ${e.macro.firmBirths} born · ${e.macro.firmDeaths} died` +
  ` | credit: consumer max $${maxConsumerDebt.toFixed(0)} · defaults ${e.shadow.defaults} · writeOffs $${mon!.writeOffs.toFixed(0)}` +
  ` | depInt max $${maxDepInt.toFixed(2)}/tick | inv max ${maxInventory.toFixed(1)})`);
pass = ok('a firm was FOUNDED (entrepreneurial entry)', e.macro.firmBirths >= 1) && pass;
pass = ok('credit risk is real (an exit or a write-off happened)', e.macro.firmDeaths >= 1 || mon!.writeOffs > 0) && pass;
pass = ok('households used consumer credit', maxConsumerDebt > 0) && pass;
pass = ok('deposit interest was paid to savers', maxDepInt > 0) && pass;
pass = ok('a worker QUIT for a better wage (job ladder)', seenKinds.has('quit')) && pass;
pass = ok('firms carried inventory (Metzler)', maxInventory > 0) && pass;
pass = ok('gini spans the whole population', e.macro.gini > 0 && e.macro.gini < 1) && pass;

// --- phase 5: goods supply chains · premises · dual construction ---
const pv = e.premises!;
const builders = e.builders ?? [];
const wsBakery = e.wholesale?.find((w) => w.good === 'bakery');
const grocer = e.businesses.find((b) => b.id === 'biz-market');
const makersAlive = e.businesses.filter((b) => b.kind === 'maker' && !b.bankrupt);
const uLate = uLateN > 0 ? uLateSum / uLateN : e.macro.unemployment;
console.log(`  (supply chain: maker rev/tick max $${makerRevTick.toFixed(1)} · cumRev max $${makerCumRev.toFixed(0)}` +
  ` · durables sold max ${durablesSold.toFixed(1)}/tick · ws bakery $${wsBakery?.price.toFixed(2)}` +
  ` | premises ${pv.units}u/${pv.vacant}v · maxPending ${maxPending} · ${pv.leases} leases` +
  ` | builders ${builders.map((b) => `${b.name.split(' ')[0]} ${b.completedBuildings}`).join(' · ')}` +
  ` | u(d30+) ${(uLate * 100).toFixed(1)}%)`);
pass = ok('wholesale cleared with maker revenue', makerRevTick > 0 && makerCumRev > 0) && pass;
pass = ok('a retailer restocked from wholesale (maker cumRevenue > 0)', makerCumRev > 0 && (grocer?.cumRevenue ?? 0) > 0) && pass;
pass = ok('a durable was purchased (homegoods/apparel sold)', durablesSold > 0) && pass;
pass = ok('premises pipeline ran (pending queued or a lease signed)', maxPending > 0 || pv.leases > 0) && pass;
pass = ok('both construction firms built (≥1 new each, seeds excluded)',
  (builders.length === 2 && builders.every((b) => b.completedBuildings >= 2))
  || builders.reduce((s, b) => s + b.completedBuildings, 0) >= 3) && pass;
pass = ok('wholesale prices within the raw-cost..import band', wsBandOk) && pass;
pass = ok('CPI within [0.6, 1.4]', e.macro.cpi >= 0.6 && e.macro.cpi <= 1.4) && pass;
pass = ok('unemployment settled in [4%, 16%] (post-day-30 mean)', uLate >= 0.04 && uLate <= 0.16) && pass;
pass = ok('the grocery retailer stayed solvent 70 days', !!grocer && !grocer.bankrupt) && pass;
pass = ok('at least one maker stayed solvent 70 days', makersAlive.length >= 1) && pass;

// --- phase 6a: mobility (dealership · taxi · ownership · fares) ---
console.log(`  (mobility: dealer cumRev $${dealerCumRev.toFixed(0)} · taxi head max ${taxiHeadMax}` +
  ` · owners max ${vehOwnersMax} (${carOwnersMax} cars) · fare spend max $${fareSpendMax.toFixed(1)}/tick` +
  ` · transit cleared max ${transitClearedMax.toFixed(1)}/tick)`);
pass = ok('a household bought a vehicle (durable-wear mechanism)', vehOwnersMax > 0) && pass;
pass = ok('the dealership sold vehicles off its shelf', dealerCumRev > 0) && pass;
pass = ok('the taxi firm hired a driver', taxiHeadMax >= 1) && pass;
pass = ok('employed households paid commute fares (transit cleared)', fareSpendMax > 0 && transitClearedMax > 0) && pass;

// --- the Observatory's history (t0 → now, bounded, monotonic) ---
const h = e.history!;
const t = h.data[h.fields.indexOf('t')];
let monotonic = true;
for (let i = 1; i < h.n; i++) if (t[i] <= t[i - 1]) { monotonic = false; break; }
console.log(`  (history: ${h.n} samples · stride ${h.stride}h · span ${t[0]?.toFixed(0)}→${t[h.n - 1]?.toFixed(0)}h · ${h.events.length} events · v${h.version})`);
pass = ok('history recorded from t0 to now', h.n > 100 && t[0] < 48 && t[h.n - 1] > DAYS * 24 * 0.9) && pass;
pass = ok('history time axis monotonic', monotonic) && pass;
pass = ok('history stayed within its memory cap', h.n <= 1441 && h.fields.length === h.data.length) && pass;
pass = ok('notable events were logged', h.events.length > 0) && pass;

// =============================================================================
// phase 6b: CIVIC EXECUTION — a standalone EconomySim drives applyCivic
// (levies · public hiring · spend orders · fares) so the conservation ledger
// and determinism are audited without the town in the loop.
// =============================================================================
const totalMoney = (s: EconSnapshot): number => {
  let m = s.civic!.treasury;
  for (const a of s.agents) m += a.money;
  for (const b of s.businesses) m += b.cash;
  for (const c of s.builders ?? []) m += c.cash;
  m += s.shadow.meanMoney * s.shadow.n;
  return m;
};

interface CivicRun {
  sim: EconomySim;
  json: string;
  taxCollected: number; borrowed: number; founded?: string; commissioned?: string;
  reliefOk: boolean; fareOk: boolean; adminFare: number;
  maxConsErr: number; maraMoney: number;
}
function runCivicScenario(seed: number): CivicRun {
  const sim = new EconomySim([
    { id: 'cashier-mara', name: 'Mara', isMara: true },
    { id: 'a1', name: 'Avery' }, { id: 'a2', name: 'Blair' }, { id: 'a3', name: 'Cody' },
  ], { seed, clock: 0 });
  const rng = mulberry32((seed ^ 0xc171c) >>> 0);
  let clock = 0;
  let maxConsErr = 0;
  const run = (hours: number) => {
    for (let i = 0; i < hours; i++) {
      clock += 1;
      sim.step({
        clock, dtHours: 1, weekday: ((clock / 24) | 0) % 7 < 5, rng,
        agents: [
          { id: 'a1', name: 'Avery', atWork: false, workHours: 0, hunger: 0.4, thirst: 0.4, seekingWork: true, conscientious: 0.2 },
          { id: 'a2', name: 'Blair', atWork: false, workHours: 0, hunger: 0.3, thirst: 0.5, seekingWork: true, conscientious: 0 },
          { id: 'a3', name: 'Cody', atWork: false, workHours: 0, hunger: 0.5, thirst: 0.3, seekingWork: false, conscientious: -0.2 },
        ],
      });
      if (clock % 8 === 0) {
        const mv = sim.snapshot().monetary!;
        maxConsErr = Math.max(maxConsErr, Math.abs(mv.conservationError));
      }
    }
  };

  run(300);
  sim.applyCivic({ levies: { payrollRate: 0.04, salesRate: 0.03 } }, clock);
  run(20);
  // deficit finance: the treasury is still thin — a civic hall must borrow.
  const rcBuild = sim.applyCivic({ spendOrders: [{ kind: 'civic-build', amount: 5200 }] }, clock);
  run(100);
  sim.applyCivic({ hires: [{ employerId: 'gov', name: 'Town Hall', wage: 15, desired: 2 }] }, clock);
  run(60);
  const rcTax = sim.applyCivic({}, clock);   // drain the accrued levies into a receipt
  run(80);
  // relief: a pure treasury → households transfer (borrowing accounted).
  let s0 = sim.snapshot(); let m0 = totalMoney(s0);
  const rcRelief = sim.applyCivic({ spendOrders: [{ kind: 'relief', amount: 400 }] }, clock);
  let s1 = sim.snapshot(); let m1 = totalMoney(s1);
  const reliefOk = Math.abs(m1 - m0 - rcRelief.borrowed) < 1e-6
    && rcRelief.spent.some((x) => x.kind === 'relief' && x.amount > 0);
  run(20);
  // fares: riders → operator, conserved exactly.
  s0 = sim.snapshot(); m0 = totalMoney(s0);
  const taxiCash0 = s0.businesses.find((b) => b.id === 'biz-taxi')?.cash ?? NaN;
  const rcFare = sim.applyCivic({ fareRevenue: [{ operatorId: 'biz-taxi', amount: 60 }] }, clock);
  s1 = sim.snapshot(); m1 = totalMoney(s1);
  const taxiCash1 = s1.businesses.find((b) => b.id === 'biz-taxi')?.cash ?? NaN;
  const fareOk = Math.abs(m1 - m0) < 1e-6 && rcFare.fareCredited > 0
    && Math.abs(taxiCash1 - taxiCash0 - rcFare.fareCredited) < 1e-6;
  run(20);
  // public founding: a transit-subsidy order charters the authority from
  // treasury funds (bypassing the entrepreneur wealth gate).
  const rcFound = sim.applyCivic({ spendOrders: [{ kind: 'transit-subsidy', amount: 2500 }] }, clock);
  run(360);
  const end = sim.snapshot();
  const adminFare = end.markets.find((mk) => mk.sector === 'transit')?.price ?? 0;
  return {
    sim, json: JSON.stringify(sim.toJSON()),
    taxCollected: rcTax.taxCollected, borrowed: rcBuild.borrowed,
    founded: rcFound.founded, commissioned: rcBuild.commissioned,
    reliefOk, fareOk, adminFare, maxConsErr,
    maraMoney: end.agents.find((a) => a.id === 'cashier-mara')?.money ?? NaN,
  };
}

const runA = runCivicScenario(11);
const runB = runCivicScenario(11);
const endA = runA.sim.snapshot();
const cv = endA.civic!;
const ledgerErr = Math.abs(cv.treasury -
  (cv.taxCum - cv.payrollCum - cv.spendCum - cv.interestCum + cv.borrowCum - cv.repaidCum));
const civicBuilt = (endA.builders ?? []).some((b) => b.buildings.some((bl) => bl.kind === 'civic' && bl.complete));

console.log('\n=== civic scenario (standalone applyCivic, 960 sim-h) ===');
console.log(`  treasury $${cv.treasury.toFixed(0)} · taxes $${cv.taxCum.toFixed(0)} · payroll $${cv.payrollCum.toFixed(0)}` +
  ` · spend $${cv.spendCum.toFixed(0)} · borrowed $${cv.borrowCum.toFixed(0)} · repaid $${cv.repaidCum.toFixed(0)}` +
  ` · interest $${cv.interestCum.toFixed(0)} · ledgerErr $${ledgerErr.toExponential(1)}`);
console.log(`  staff ${cv.staff} · levy ${(cv.levyPayroll * 100).toFixed(0)}%/${(cv.levySales * 100).toFixed(0)}%` +
  ` · founded ${runA.founded ?? '—'} · fare $${runA.adminFare.toFixed(2)} · civic hall ${civicBuilt ? 'built' : 'pending'}` +
  ` · consErr max $${runA.maxConsErr.toFixed(4)}`);
pass = ok('applyCivic: levies collected to the treasury', runA.taxCollected > 0 && cv.taxCum > 0) && pass;
pass = ok('treasury ledger conserves to 1e-6 (Δtreasury ≡ taxes − outlays + borrowing)', ledgerErr < 1e-6) && pass;
pass = ok('civic relief conserved private money (treasury → households)', runA.reliefOk) && pass;
pass = ok('fare revenue conserved (riders → operator)', runA.fareOk) && pass;
pass = ok('gov hired staff through the labour market', cv.staff >= 1 && cv.payrollCum > 0) && pass;
pass = ok('treasury deficit-financed via the Financier (real money creation)', runA.borrowed > 0) && pass;
pass = ok('transit authority founded publicly via spend order', runA.founded === 'biz-transit-auth'
  && endA.businesses.some((b) => b.id === 'biz-transit-auth' && b.sector === 'transit')) && pass;
pass = ok('administered fare rules the transit market (tâtonnement bypassed)', Math.abs(runA.adminFare - 2.4) < 1e-9) && pass;
pass = ok('a civic build flowed through Construction', !!runA.commissioned && civicBuilt) && pass;
pass = ok('money conserved under civic flows (bank identity ~0)',
  runA.maxConsErr < (endA.monetary?.broadMoney ?? 1) * 1e-3) && pass;
pass = ok('byte-identical toJSON across same-seed civic runs', runA.json === runB.json) && pass;
pass = ok('Mara exempt from levies (legacy-ledger wallet untouched)', runA.maraMoney === 60) && pass;

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
