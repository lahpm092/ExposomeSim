// Headless proof that the market ECONOMY emerges (no scripting) and that the
// memory embedding tier works offline. Run: npx tsx scripts/econ-smoke.ts
import { Town } from '../src/sim/town';
import { getEmbedder, cosine } from '../src/llm/embed';

const town = new Town({ llm: null, seed: 7, startHour: 7, speed: 0.05 });
const DT_SIM = 0.05;
const dtReal = DT_SIM / town.speed;
const DAYS = 40;
const STEPS = Math.round((DAYS * 24) / DT_SIM);

const seenKinds = new Set<string>();
let maxRevenue = 0, maxUnemp = 0, minUnemp = 1, maxHomeless = 0, cpiMoved = 0, anyBankrupt = false;
let headcountChanged = false;
let nan = false;
const startHead: Record<string, number> = {};
let sampled = false;
// monetary tracking
let maxCredit = 0, maxConsErr = 0, minRate = 1, maxRate = 0, banksSolvent = true;

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
  }
  for (const ev of e.labor.recentEvents) seenKinds.add(ev.kind);
  const mon = e.monetary;
  if (mon) {
    maxCredit = Math.max(maxCredit, mon.banks.reduce((s, b) => s + b.loans, 0));
    maxConsErr = Math.max(maxConsErr, Math.abs(mon.conservationError));
    minRate = Math.min(minRate, mon.fed.policyRate);
    maxRate = Math.max(maxRate, mon.fed.policyRate);
    if (mon.banks.some((b) => !b.solvent)) banksSolvent = false;
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
pass = ok('Fed sets a positive policy rate', (mon?.fed.policyRate ?? 0) > 0) && pass;
pass = ok('base money + broad money exist', (mon?.baseMoney ?? 0) > 0 && (mon?.broadMoney ?? 0) > 0) && pass;
pass = ok('banks created credit (loans)', maxCredit > 0) && pass;
pass = ok('money conserved (double-entry ~0)', maxConsErr < (mon?.broadMoney ?? 1) * 1e-3) && pass;
pass = ok('policy rate responded (moved over run)', maxRate - minRate > 1e-4) && pass;
pass = ok('banks stayed solvent', banksSolvent) && pass;
pass = ok('supermarket served shopping trips', (sm?.trips ?? 0) > 0) && pass;
pass = ok('supermarket inventory depleted + restocked', (sm?.totalSold ?? 0) > 0 && (sm?.fillLevel ?? 0) > 0.2) && pass;
pass = ok('housing stock grew (a block completed)', e.housing.units > 320) && pass;
console.log(`\n${pass ? 'ALL PASS' : 'SOME FAILED'}`);
process.exit(pass ? 0 : 1);
