// Visual capture of the ECONOMY OBSERVATORY (render/econviz.ts). Loads the app,
// fast-forwards ~45 sim-days through the __dbg.tick hook so the history strips
// have a real story to tell (credit boom, easing cycle, entries/exits), toggles
// the ECON overlay, and screenshots it at two moments (day ~20 and day ~45).
// Usage: node scripts/econviz-capture.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots-econviz');
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

// each __dbg.tick(90) advances dt = 90 × speed(0.02) = 1.8 sim-h.
async function forward(hours) {
  const ticks = Math.round(hours / 1.8);
  const CHUNK = 40;
  for (let done = 0; done < ticks; done += CHUNK) {
    await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__dbg.tick(90); }, Math.min(CHUNK, ticks - done));
    await sleep(20);
  }
  const t = await page.evaluate(() => window.__dbg.town.snapshot().time);
  console.log(`  at sim day ${(t / 24) | 0}`);
}

await forward(20 * 24);
await page.evaluate(() => window.__dbg.econViz.toggle());
await sleep(400);
await page.evaluate(() => window.__dbg.tick(90));   // one tick to trigger a redraw
await sleep(300);
await page.screenshot({ path: `${outDir}/observatory-day20.png` });
console.log('  wrote observatory-day20.png');

await forward(25 * 24);
await sleep(400);
await page.screenshot({ path: `${outDir}/observatory-day45.png` });
console.log('  wrote observatory-day45.png');

// read back the history the strips drew, for a numbers-behind-pixels check
const stats = await page.evaluate(() => {
  const e = window.__dbg.town.snapshot().economy;
  const h = e.history;
  return {
    samples: h.n, stride: h.stride, events: h.events.length,
    firms: e.macro.firmsAlive, births: e.macro.firmBirths, deaths: e.macro.firmDeaths,
    cpi: e.macro.cpi, u: e.macro.unemployment, policy: e.monetary.fed.policyRate,
    gini: e.macro.gini,
  };
});
console.log('  history:', JSON.stringify(stats));
if (errors.length) { console.log('\nPAGE ERRORS:'); for (const e of errors.slice(0, 10)) console.log('  ' + e); }
await browser.close();
process.exit(errors.length ? 1 : 0);
