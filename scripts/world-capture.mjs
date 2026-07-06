// Visual capture of the BUSINESS WORLD integration: archetype-fitted leased
// buildings, the two builders' conyard cranes at active sites, near-only
// interiors (hot venues), and learned cold-venue ambience. Fast-forwards ~50
// sim-days via __dbg.tick chunks (entries + leases take ~10-30 days), then
// parks the free camera (window.__stage.debugCam) at each subject.
// Usage: npm run dev (port 5173), then node scripts/world-capture.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots-world');
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
if (!loaded) { console.log('could not load http://localhost:5173'); await browser.close(); process.exit(1); }
await page.waitForFunction(() => !!(window.__stage && window.__dbg), null, { timeout: 15000 }).catch(() => {});

// hide the DOM overlays so shots read clean (visibility keeps layout stable).
await page.addStyleTag({ content: `
  #titlebar, #dashboard, #caption { visibility: hidden !important; }
  #stage > *:not(#scene) { visibility: hidden !important; }
` });

const econState = () => page.evaluate(() => {
  const s = window.__dbg.town.snapshot();
  const e = s.economy, c = e?.construction;
  return {
    day: Math.floor(s.time / 24),
    leases: e?.premises?.leases ?? 0,
    pending: e?.premises?.pending ?? 0,
    units: e?.premises?.units ?? 0,
    vacant: e?.premises?.vacant ?? 0,
    firmBirths: e?.macro?.firmBirths ?? 0,
    builders: (e?.builders ?? []).map((b) => ({ name: b.name, active: b.activeProjects, done: b.completedBuildings })),
    builderIds: (e?.builders ?? []).map((b) => (b.buildings ?? []).map((x) => x.id)),
    hot: s.causal?.hot ?? [],
    stats: (s.causal?.stats ?? []).map((v) => ({ id: v.venueId, visits: v.visits })),
    businesses: (e?.businesses ?? []).filter((b) => b.archetype).map((b) => ({ id: b.id, name: b.name, archetype: b.archetype, pending: !!b.pendingPremises })),
    buildings: (c?.buildings ?? []).map((b) => ({
      id: b.id, kind: b.kind, x: b.x, z: b.z, w: b.w, d: b.d, floors: b.floors,
      progress: Math.round(b.progress * 100) / 100, complete: b.complete, archetype: b.archetype,
    })),
  };
});

// ---- fast-forward: ~50 sim-days in chunks; stop early once the world is alive
// (a signed lease + a firm birth), keep going to 60 days otherwise.
// __dbg.tick(90) ≈ 1.8 sim-h at speed 0.02 → ~13.3 ticks/sim-day.
let st = await econState();
const tickDays = async (days) => {
  const n = Math.round(days * 13.34);
  for (let done = 0; done < n; done += 40) {
    await page.evaluate((k) => { for (let i = 0; i < k; i++) window.__dbg.tick(90); }, Math.min(40, n - done));
    await sleep(15);
  }
};
for (let round = 0; round < 12; round++) {
  await tickDays(5);
  st = await econState();
  console.log(`day ${st.day}: leases=${st.leases} pending=${st.pending} births=${st.firmBirths} ` +
    `units=${st.units} vacant=${st.vacant} builders=${JSON.stringify(st.builders)}`);
  if (st.day >= 50 && st.leases > 0 && st.firmBirths >= 1) break;
  if (st.day >= 60) break;
}
if (!(st.leases > 0 && st.firmBirths >= 1)) {
  console.log('NOTE: no emergent lease/birth after 60 days — premises state below; shooting anyway.');
  console.log(JSON.stringify({ premises: { units: st.units, vacant: st.vacant, pending: st.pending, leases: st.leases }, businesses: st.businesses }, null, 1));
}
// park the sim near midday so the learned hourShape has daytime footfall.
const hourNow = await page.evaluate(() => window.__dbg.town.snapshot().time % 24);
const toNoon = ((13 - hourNow) + 24) % 24;
if (toNoon > 0.2) { await tickDays(toNoon / 24); }
st = await econState();
console.log('archetype businesses:', JSON.stringify(st.businesses));
console.log('archetype buildings:', JSON.stringify(st.buildings.filter((b) => b.archetype)));
console.log('hot venues:', JSON.stringify(st.hot), 'visits:', JSON.stringify(st.stats));

async function shootAt(name, tx, ty, tz, dx, dy, dz) {
  await page.evaluate(({ tx, ty, tz, dx, dy, dz }) => {
    const s = window.__stage;
    const cx = tx + dx, cy = ty + dy, cz = tz + dz;
    const yaw = Math.atan2(tx - cx, tz - cz);
    const horiz = Math.hypot(tx - cx, tz - cz);
    const pitch = Math.atan2(ty - cy, horiz);
    s.debugCam(cx, cy, cz, yaw, pitch);
  }, { tx, ty, tz, dx, dy, dz });
  await sleep(1100);   // > two 4 Hz sweeps, so interiors/ambience settle
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('  shot', name);
}

// ---- (a) each leased archetype building, close up (front faces +z) ---------
const leased = st.buildings.filter((b) => b.archetype && (b.complete || b.progress >= 1));
const seenArch = new Set();
let i = 0;
for (const b of leased) {
  if (seenArch.has(b.archetype)) continue;
  seenArch.add(b.archetype);
  await shootAt(`a${++i}-${b.archetype}`, b.x, 2.6, b.z, 10, 5.5, 17);
}

// ---- (b) a wide district shot with multiple distinct businesses ------------
if (leased.length) {
  const cx = leased.reduce((s2, b) => s2 + b.x, 0) / leased.length;
  const cz = leased.reduce((s2, b) => s2 + b.z, 0) / leased.length;
  await shootAt('b1-district', cx, 2, cz, 40, 60, 95);
}
await shootAt('b2-overview', 0, 4, 0, 30, 135, 150);

// ---- (c) an under-construction site with the conyard crane -----------------
let uc = st.buildings.find((b) => !b.complete && b.progress < 1);
if (!uc) {
  // projects are recurring — tick a few more days to catch one breaking ground.
  for (let r = 0; r < 6 && !uc; r++) {
    await tickDays(2.5);
    st = await econState();
    uc = st.buildings.find((b) => !b.complete && b.progress < 1);
  }
}
if (uc) {
  console.log('under construction:', JSON.stringify(uc));
  // the yard side mirrors buildsite.buildCrane: owner 0 west / 1 east, flipped
  // toward town when the lot hugs the district edge.
  const owner = st.builderIds.findIndex((ids) => ids.includes(uc.id));
  const YARD_W = 14;
  let side = owner === 1 ? 1 : -1;
  const off = uc.w / 2 + YARD_W / 2 + 1.2;
  if (Math.abs(uc.x + side * off) + YARD_W / 2 > 130) side = -side;
  await shootAt('c1-consite', uc.x + side * 8, uc.floors * 1.4, uc.z, -side * 26, 14, 30);
  await shootAt('c2-consite-crane', uc.x + side * off, 4, uc.z, side * 10, 5, 20);
} else {
  console.log('NOTE: no active project found for the crane shot (all complete right now).');
}

// ---- (d) one venue COLD (exterior + ambience only) vs HOT (interior mounted)
st = await econState();
const venue = st.buildings.filter((b) => b.archetype && (b.complete || b.progress >= 1))[0];
if (venue) {
  const organicHot = await page.evaluate(() => (window.__dbg.town.snapshot().causal?.hot ?? []).length > 0);
  console.log('venue for hot/cold pair:', venue.id, venue.archetype, '— organic hot venues now:', organicHot);
  // cold first (no override): camera near, but the causal gate says cold.
  await page.evaluate(() => window.__stage.debugHotVenues(false));
  await shootAt(`d1-${venue.archetype}-cold`, venue.x, 1.6, venue.z, 3, 3.2, 15);
  // hot: force the render-side gate open (sim untouched) — interior mounts.
  await page.evaluate(() => window.__stage.debugHotVenues(true));
  await sleep(700);
  await shootAt(`d2-${venue.archetype}-hot`, venue.x, 1.6, venue.z, 3, 3.2, 15);
  await shootAt(`d3-${venue.archetype}-hot-inside`, venue.x, 1.2, venue.z, 0.5, 1.0, 9.5);
  await page.evaluate(() => window.__stage.debugHotVenues(false));
  if (!organicHot) console.log('NOTE: no venue was ORGANICALLY hot at shoot time (no Tier-A agent within the causal radius); the hot shot uses the dev override debugHotVenues(true).');
}

console.log('console errors:', errors.length);
errors.slice(0, 12).forEach((e) => console.log('  -', e));
await browser.close();
