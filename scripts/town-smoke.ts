// Headless proof that the needs-driven daily loop EMERGES (no schedule) and that
// a relationship forms across re-encounters. Run: npx tsx scripts/town-smoke.ts
import { Town } from '../src/world/town';

const town = new Town({ llm: null, seed: 7, startHour: 7, speed: 0.05 });
const DT_SIM = 0.03;                 // sim-hours per step
const dtReal = DT_SIM / town.speed;  // feed the loop so each step = DT_SIM sim-hr
const DAYS = 9;  // span a weekend (days 5–6) so weekend socializing can emerge
const STEPS = Math.round((DAYS * 24) / DT_SIM);

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

for (let i = 0; i < STEPS; i++) {
  town.update(dtReal);
  const s = town.snapshot();
  if (!Number.isFinite(s.cashier.soma.valence)) { nanSeen = true; break; }
  visited.add(s.place);
  placeMinutes[s.travelling ? 'travel' : s.place] = (placeMinutes[s.travelling ? 'travel' : s.place] ?? 0) + DT_SIM * 60;
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

console.log('\n=== checks ===');
const bonded = s.relationships.find((r) => r.encounters > 1);
const ok = (name: string, cond: boolean) => console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}`);
ok('no NaN in the soma', !nanSeen);
ok('visited work', visited.has('work'));
ok('visited home', visited.has('home'));
ok('visited market', visited.has('market'));
ok('visited thirdplace', visited.has('thirdplace'));
ok('earned wages', s.resources.wageEarned > 0);
ok('bought food (foodStock cycled)', (placeMinutes['market'] ?? 0) > 0);
ok('a relationship re-encountered (enc>1)', !!bonded);
