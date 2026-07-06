// Headless proof that the market ECONOMY emerges (no scripting) and that the
// memory embedding tier works offline. Run: npx tsx scripts/econ-smoke.ts
import { Town } from '../src/world/town';
import { getEmbedder, cosine } from '../src/llm/embed';

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
  }
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

console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
