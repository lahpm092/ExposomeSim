// Scale-verification capture. Loads the app, boosts sim speed so agents disperse
// to work/office, then parks the FREE camera at fixed vantage points (via
// window.__stage.debugCam) to inspect each space head-on — follow-zoom would
// normalise away a scale mismatch. Saves overview + a settled body in each region.
// Usage: node scripts/scale-capture.mjs [outDir] [maxWaitMs]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots');
const maxWait = Number(process.argv[3] || 90000);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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
await page.waitForFunction(() => !!(window.__stage), null, { timeout: 15000 }).catch(() => {});

// boost sim speed so a work-day's worth of movement plays in seconds.
await page.focus('body').catch(() => {});
for (let i = 0; i < 12; i++) { await page.keyboard.press('='); await sleep(60); }

async function shootAt(name, tx, ty, tz, dx, dy, dz) {
  await page.evaluate(({ tx, ty, tz, dx, dy, dz }) => {
    const s = window.__stage;
    const cx = tx + dx, cy = ty + dy, cz = tz + dz;
    const yaw = Math.atan2(tx - cx, tz - cz);
    const horiz = Math.hypot(tx - cx, tz - cz);
    const pitch = Math.atan2(ty - cy, horiz);
    s.debugCam(cx, cy, cz, yaw, pitch);
  }, { tx, ty, tz, dx, dy, dz });
  await sleep(1400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('  shot', name);
}

const clock = async () => (await page.locator('#clock').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
const dbgNow = () => page.evaluate(() => window.__stage.agentDebug());

// a SETTLED body (holding a still pose, not mid-transit) is one that will still be
// there 1.4 s later when the shutter fires — the key fix over grabbing a walker.
const STILL = new Set(['sit_desk', 'sit_rest', 'couch_tv', 'couch_phone', 'phone_desk', 'phone_bed', 'sleep', 'kitchen', 'stand', 'toilet_pee', 'toilet_defecate', 'shower', 'ordering']);
const STANDING = new Set(['kitchen', 'shower', 'toilet_pee', 'stand', 'entry', 'ordering']);
async function pickSettled(region, wantUpper, preferStanding) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const dbg = await dbgNow();
    const settled = dbg.filter((d) => d.region === region && !d.transiting && STILL.has(d.pose));
    // a STANDING occupant reads as an unmistakable silhouette (like the office/food
    // figures); prefer one, but accept any settled body if none is on their feet.
    const ordered = preferStanding ? [...settled].sort((a, b) => (STANDING.has(b.pose) ? 1 : 0) - (STANDING.has(a.pose) ? 1 : 0)) : settled;
    for (const c of ordered) {
      const p = await page.evaluate((i) => window.__stage.debugAgentPos(i), c.idx);
      if (wantUpper && p.y < 1.0) continue;        // want a furnished upper-floor flat, not the lobby
      return { idx: c.idx, pose: c.pose, p };
    }
    await sleep(2000);                             // none settled yet — let the sim place them
  }
  return null;
}

// wait until each wanted region has at least one settled body (or timeout).
const want = { home: ['02-home-flat', true, true], food: ['03-foodcourt', false, false], office: ['04-office', false, false] };
const t0 = Date.now();
while (Date.now() - t0 < maxWait) {
  const dbg = await dbgNow();
  const counts = dbg.reduce((m, d) => (m[d.region] = (m[d.region] || 0) + 1, m), {});
  console.log(`t=${((Date.now() - t0) / 1000) | 0}s clock=${await clock()} regions=${JSON.stringify(counts)}`);
  if ((counts.home ?? 0) && (counts.food ?? 0) && (counts.office ?? 0)) break;
  await sleep(2500);
}

// slow the sim right down so dispersed agents SETTLE and hold at their stations
// (a still sitter/sleeper stays put through the 1.4 s shutter delay).
for (let i = 0; i < 14; i++) { await page.keyboard.press('-'); await sleep(50); }
await sleep(4000);

// overview first (aerial), then each space head-on around a LIVE settled body, then
// home exterior. Re-pick the body right before the shot so it hasn't walked off.
await shootAt('01-overview', 0, 2, 0, 6, 60, 62);
for (const region of Object.keys(want)) {
  const [name, upper, standing] = want[region];
  const s = await pickSettled(region, upper, standing);
  if (!s) { console.log('  MISS region', region); continue; }
  console.log(`  ${name}: agent ${s.idx} at (${s.p.x.toFixed(1)},${s.p.y.toFixed(1)},${s.p.z.toFixed(1)}) sc=${s.p.scale.toFixed(3)} pose=${s.pose}`);
  // near-eye-level 3/4 view: a seated figure reads as a silhouette against the
  // room instead of blending into furniture the way a top-down look flattens it.
  await shootAt(name, s.p.x, s.p.y + 0.85, s.p.z, 3.2, 1.1, 3.2);
}
await shootAt('05-home-exterior', -19.8, 6, 13.2, 16, 8, 16);
// far look at the whole home tower to check the far-LOD massing vs the full building.
await shootAt('06-home-far', -19.8, 9, 13.2, 30, 14, 30);

console.log('console errors:', errors.length);
errors.slice(0, 20).forEach((e) => console.log('  -', e));
await browser.close();
