// Visual capture of the BUSINESS ARCHETYPE kits (src/render/archetypes/): loads
// the running dev app, imports the archetype index through Vite's module URL,
// mounts every archetype into the live stage scene on a review strip far from
// town (two rows: exterior-only + exterior-with-interior), hides the DOM
// overlays, then parks the debug camera for a per-archetype street shot, a
// through-the-front interior shot, and squint-test lineups.
// Usage: npm run dev (port 5173), then node scripts/archetype-capture.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] || 'shots-archetypes');
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
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
await page.waitForFunction(() => !!window.__stage, null, { timeout: 15000 });

// hide every DOM overlay (dashboard, titlebar, stage HUD canvases) — keep only
// the main #scene canvas; visibility (not display) so the layout doesn't shift.
await page.addStyleTag({ content: `
  #titlebar, #dashboard, #caption { visibility: hidden !important; }
  #stage > *:not(#scene) { visibility: hidden !important; }
` });
const stageBox = await page.locator('#stage').boundingBox();

// review strip: exterior row at z=EXT_Z, interior row at z=INT_Z (fresh interior
// group mounted alongside the exterior), spaced SPACING apart in x.
const SPACING = 45, EXT_Z = 210, INT_Z = 430;   // interior row far behind the lineup camera
const placed = await page.evaluate(async ({ SPACING, EXT_Z, INT_Z }) => {
  const mod = await import('/src/render/archetypes/index.ts');
  const scene = window.__stage.scene;               // TS-private, runtime-visible
  const out = [];
  const ctxFor = (i) => ({ w: 24, d: 18, floors: 2, seed: 0.137 + i * 0.618 });
  mod.ARCHETYPE_KINDS.forEach((kind, i) => {
    const x = (i - (mod.ARCHETYPE_KINDS.length - 1) / 2) * SPACING;
    const build = mod.getArchetype(kind)({ ...ctxFor(i) });
    build.group.position.set(x, 0, EXT_Z);
    scene.add(build.group);
    build.group.updateMatrixWorld(true);

    const b2 = mod.getArchetype(kind)({ ...ctxFor(i) });
    b2.group.position.set(x, 0, INT_Z);
    scene.add(b2.group);
    if (b2.buildInterior) b2.group.add(b2.buildInterior());
    b2.group.updateMatrixWorld(true);
    out.push({ kind, x });
  });
  return { count: mod.archetypeCount(), rows: out };
}, { SPACING, EXT_Z, INT_Z });
console.log('registered archetypes:', placed.count);

async function shootAt(name, tx, ty, tz, dx, dy, dz) {
  await page.evaluate(({ tx, ty, tz, dx, dy, dz }) => {
    const s = window.__stage;
    const cx = tx + dx, cy = ty + dy, cz = tz + dz;
    const yaw = Math.atan2(tx - cx, tz - cz);
    const horiz = Math.hypot(tx - cx, tz - cz);
    const pitch = Math.atan2(ty - cy, horiz);
    s.debugCam(cx, cy, cz, yaw, pitch);
  }, { tx, ty, tz, dx, dy, dz });
  await sleep(850);
  await page.screenshot({ path: `${outDir}/${name}.png`, clip: stageBox });
  console.log('  shot', name);
}

// per-kind camera tuning: exterior three-quarter offset + interior frontal
// offset (eye-height, looking straight through the shopfront).
const CAM = {
  default: { ext: [12, 4.8, 17], int: [1.5, 0.9, 14] },
  bakery: { ext: [12, 4.8, 17], int: [-2.0, 0.9, 13.5] },
  dairy: { ext: [14, 5.5, 19], int: [2.5, 0.9, 13.5] },
  market2: { ext: [17, 7, 24], int: [3.0, 1.2, 15] },
  workshop: { ext: [14, 5.5, 20], int: [5.5, 0.6, 11.5] },
  conyard: { ext: [15, 8, 22], int: [10, 6.5, 16] },
  tailor: { ext: [11, 5.5, 16], int: [1.5, 1.0, 13] },
};

for (const { kind, x } of placed.rows) {
  const cam = CAM[kind] ?? CAM.default;
  await shootAt(kind, x, 2.8, EXT_Z, ...cam.ext);
  await shootAt(`${kind}-interior`, x, 1.3, INT_Z + 2, ...cam.int);
}

// squint-test lineups: three street-elevation trios of the exterior row.
const xs = placed.rows.map((r) => r.x);
for (let t = 0; t < 3; t++) {
  const cxm = (xs[t * 3] + xs[t * 3 + 2]) / 2;
  await shootAt(`00-lineup-${t + 1}`, cxm, 3.5, EXT_Z, 5, 19, 116);
}

console.log('console errors:', errors.length);
errors.slice(0, 12).forEach((e) => console.log('  -', e));
await browser.close();
