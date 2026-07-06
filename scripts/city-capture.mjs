// Visual capture of the EXPANDED city: overview, the supermarket, and a
// construction-firm building. Fast-forwards via __dbg.tick, then parks the free
// camera (window.__stage.debugCam) at each landmark. Usage: node scripts/city-capture.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots-city');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
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
await page.waitForFunction(() => !!(window.__stage && window.__dbg), null, { timeout: 15000 }).catch(() => {});

// fast-forward ~32 sim-days so the construction firm has raised some buildings.
for (let b = 0; b < 8; b++) {
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__dbg.tick(90); }, 50);
  await sleep(20);
}
await sleep(400);

const econ = await page.evaluate(() => {
  const e = window.__dbg.town.snapshot().economy;
  const c = e?.construction;
  return { built: c?.completedBuildings, active: c?.activeProjects,
    buildings: (c?.buildings ?? []).map((b) => ({ id: b.id, x: b.x, z: b.z, kind: b.kind, floors: b.floors, progress: b.progress, complete: b.complete })) };
});
console.log('construction:', econ.built, 'built,', econ.active, 'active');
console.log('buildings:', JSON.stringify(econ.buildings.slice(0, 6)));

async function shootAt(name, tx, ty, tz, dx, dy, dz) {
  await page.evaluate(({ tx, ty, tz, dx, dy, dz }) => {
    const s = window.__stage;
    const cx = tx + dx, cy = ty + dy, cz = tz + dz;
    const yaw = Math.atan2(tx - cx, tz - cz);
    const horiz = Math.hypot(tx - cx, tz - cz);
    const pitch = Math.atan2(ty - cy, horiz);
    s.debugCam(cx, cy, cz, yaw, pitch);
  }, { tx, ty, tz, dx, dy, dz });
  await sleep(1200);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('  shot', name);
}

// 1) aerial overview of the expanded district
await shootAt('01-overview', 0, 4, 0, 30, 135, 150);
// 2) the supermarket
await shootAt('02-supermarket', 0, 3, -78, 22, 12, 26);
// 3) a construction building (pick the first with the most progress)
const b = (econ.buildings || []).slice().sort((a, z) => z.progress - a.progress)[0];
if (b) { await shootAt('03-building', b.x, b.floors * 1.5, b.z, 26, 16, 28); console.log('  building:', b.kind, b.floors + 'f', (b.progress * 100 | 0) + '%'); }
// 4) mid overview of the core + skyline
await shootAt('04-core', 0, 6, 10, 20, 70, 80);
// 5) the Federal Reserve (camera near enough to spawn the proximity crowd)
await shootAt('05-fed', 0, 6, 112, 15, 9, 21);
// 6) the commercial bank
await shootAt('06-bank', -50, 4, 110, 16, 9, 20);

console.log('console errors:', errors.length);
errors.slice(0, 12).forEach((e) => console.log('  -', e));
await browser.close();
