// Visual + data capture of the ECONOMY HUD and memory viz. Loads the app,
// fast-forwards ~30 sim-days through the __dbg.tick hook (no wall-clock wait),
// then screenshots the economy panel + full page and reads back the live economy
// snapshot so we can verify the numbers behind the pixels.
// Usage: node scripts/econ-capture.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots-econ');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let loaded = false;
for (let i = 0; i < 12 && !loaded; i++) {
  try { await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 8000 }); loaded = true; }
  catch { await sleep(1500); }
}
if (!loaded) { console.log('could not load'); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!(window.__dbg), null, { timeout: 15000 }).catch(() => {});

// fast-forward ~30 sim-days: each __dbg.tick(90) advances dt = 90*speed(0.02) = 1.8 sim-h.
// (400 ticks × 1.8h ≈ 720h ≈ 30 days.) Chunked so the page stays responsive.
const TICKS = 400;
for (let b = 0; b < 10; b++) {
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__dbg.tick(90); }, TICKS / 10);
  const t = await page.evaluate(() => window.__dbg.town.snapshot().time);
  process.stdout.write(`  fast-forward day ${(t / 24) | 0}\r`);
  await sleep(30);
}
console.log('');

// let a normal frame render the panels with the evolved state.
await sleep(600);

// read the live economy snapshot (the data behind the HUD).
const econ = await page.evaluate(() => {
  const e = window.__dbg.town.snapshot().economy;
  if (!e) return null;
  return {
    macro: e.macro,
    businesses: e.businesses.map((b) => ({ name: b.name, sector: b.sector, cash: Math.round(b.cash), price: +b.price.toFixed(2), wage: Math.round(b.wage), head: b.headcount, want: b.desiredHeadcount, profit: Math.round(b.profit), bankrupt: b.bankrupt, hiring: b.hiring })),
    labor: { unemployment: e.labor.unemployment, vacancies: e.labor.vacancies, events: e.labor.recentEvents.slice(0, 6).map((x) => `${x.kind}: ${x.detail ?? ''}`) },
    shadow: e.shadow,
    agentsSample: e.agents.slice(0, 5).map((a) => ({ id: a.id, money: Math.round(a.money), status: a.status, homeless: a.homeless })),
  };
});
console.log('=== live economy snapshot ===');
console.log(JSON.stringify(econ, null, 2));

// full page (shows the whole dashboard column + 3D world)
await page.screenshot({ path: `${outDir}/00-fullpage.png` });

// the economy panel element on its own (Playwright scrolls it into view)
for (const sel of ['.econ-panel', '.panel.econ-panel', '#dashboard']) {
  const el = page.locator(sel).first();
  if (await el.count()) {
    try { await el.screenshot({ path: `${outDir}/01-econ-panel.png` }); console.log('shot econ panel via', sel); break; }
    catch (e) { console.log('  (could not shoot', sel, ')'); }
  }
}

// scroll the dashboard so the econ panel is visible in a full-column shot too
await page.evaluate(() => { const p = document.querySelector('.econ-panel'); if (p) p.scrollIntoView({ block: 'center' }); });
await sleep(300);
await page.screenshot({ path: `${outDir}/02-dashboard-scrolled.png` });

console.log('\nconsole errors:', errors.length);
errors.slice(0, 20).forEach((e) => console.log('  -', e));
await browser.close();
