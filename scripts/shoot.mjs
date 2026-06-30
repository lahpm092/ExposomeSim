// Headless capture + runtime-error check of the running app.
// Usage: node scripts/shoot.mjs [url] [outPng] [waitMs]
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:5173/';
const out = process.argv[3] || 'shot.png';
const waitMs = Number(process.argv[4] || 13000);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000); // let ollama + vite warm up
let loaded = false;
for (let i = 0; i < 12 && !loaded; i++) {
  try { await page.goto(url, { waitUntil: 'networkidle', timeout: 8000 }); loaded = true; }
  catch { await sleep(1500); }
}
if (!loaded) { console.log('could not load', url); await browser.close(); process.exit(1); }
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });

console.log('console errors:', errors.length);
errors.slice(0, 20).forEach((e) => console.log('  -', e));
const txt = async (sel) => (await page.locator(sel).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
console.log('clock:   ', await txt('#clock'));
console.log('caption: ', await txt('#caption'));
console.log('servedish dashboard text:', (await txt('#dashboard')).slice(0, 220));
await browser.close();
