// =============================================================================
// build-brain-mesh.mjs — regenerate public/brain-mesh.json (the BrainPanel mesh).
//
// SOURCE DATA (not vendored — ~95 MB): Brainder "Brain for Blender", real MRI
//   FreeSurfer surfaces by Anderson M. Winkler, licensed CC-BY-SA 3.0.
//   https://brainder.org/research/brain-for-blender/
//
// To regenerate:
//   curl -L -o all_obj.tar.bz2 \
//     https://s3.us-east-2.amazonaws.com/brainder/software/brain4blender/all_obj.tar.bz2
//   tar xjf all_obj.tar.bz2 all_obj/pial_Full all_obj/subcortical all_obj/pial_DK
//   node scripts/build-brain-mesh.mjs ./all_obj
//
// What it does: parses the pial cortex, Desikan-Killiany cortical regions, and
// segmented subcortical OBJs; maps FreeSurfer surface-RAS (x=R, y=A, z=S) to the
// app's scene axes (x, z, y); shares one center+scale (from the pial bbox) so all
// structures stay aligned; grid-cluster-decimates each; and packs a compact JSON
// of { structures:{id:{p,i}}, centroids, roles } the panel loads at runtime.
// =============================================================================
import fs from 'fs';

const SRC = process.argv[2] || './all_obj';
const OUT = new URL('../public/brain-mesh.json', import.meta.url).pathname;
const SUB = `${SRC}/subcortical`;
const DK = `${SRC}/pial_DK`;
const dk = (r) => [`${DK}/lh.pial.DK.${r}.obj`, `${DK}/rh.pial.DK.${r}.obj`];
const lr = (n) => [`${SUB}/Left-${n}.obj`, `${SUB}/Right-${n}.obj`];

// id → { files, cell:normalizedClusterSize, role }
const GROUPS = {
  cortex:       { files: [`${SRC}/pial_Full/lh.pial.obj`, `${SRC}/pial_Full/rh.pial.obj`], cell: 0.042, role: 'cortex' },
  insula:       { files: dk('insula'), cell: 0.020, role: 'cortexRegion' },
  vmPFC:        { files: [...dk('medialorbitofrontal'), ...dk('lateralorbitofrontal')], cell: 0.020, role: 'cortexRegion' },
  dlPFC:        { files: [...dk('rostralmiddlefrontal'), ...dk('caudalmiddlefrontal')], cell: 0.020, role: 'cortexRegion' },
  dACC:         { files: [...dk('caudalanteriorcingulate'), ...dk('rostralanteriorcingulate')], cell: 0.020, role: 'cortexRegion' },
  amygdala:     { files: lr('Amygdala'), cell: 0.014, role: 'nucleus' },
  hippocampus:  { files: lr('Hippocampus'), cell: 0.016, role: 'nucleus' },
  nacc:         { files: lr('Accumbens-area'), cell: 0.013, role: 'nucleus' },
  hypothalamus: { files: lr('VentralDC'), cell: 0.016, role: 'nucleus' },
  brainstem:    { files: [`${SUB}/Brain-Stem.obj`], cell: 0.020, role: 'context' },
  cerebellum:   { files: lr('Cerebellum-Cortex'), cell: 0.032, role: 'context' },
  thalamus:     { files: lr('Thalamus-Proper'), cell: 0.018, role: 'context' },
  caudate:      { files: lr('Caudate'), cell: 0.016, role: 'context' },
  putamen:      { files: lr('Putamen'), cell: 0.016, role: 'context' },
  pallidum:     { files: lr('Pallidum'), cell: 0.014, role: 'context' },
  cc:           { files: ['CC_Anterior', 'CC_Mid_Anterior', 'CC_Central', 'CC_Mid_Posterior', 'CC_Posterior'].map((c) => `${SUB}/${c}.obj`), cell: 0.016, role: 'context' },
};

function parseOBJ(path) {
  const txt = fs.readFileSync(path, 'utf8');
  const verts = [], faces = [];
  for (const line of txt.split('\n')) {
    if (line[0] === 'v' && line[1] === ' ') { const p = line.split(/\s+/); verts.push([+p[1], +p[2], +p[3]]); }
    else if (line[0] === 'f' && line[1] === ' ') {
      const idx = line.trim().split(/\s+/).slice(1).map((s) => parseInt(s.split('/')[0], 10) - 1);
      for (let i = 2; i < idx.length; i++) faces.push([idx[0], idx[i - 1], idx[i]]);
    }
  }
  return { verts, faces };
}
function merge(files) {
  const verts = [], faces = [];
  for (const f of files) { const m = parseOBJ(f); const off = verts.length; for (const v of m.verts) verts.push(v); for (const t of m.faces) faces.push([t[0] + off, t[1] + off, t[2] + off]); }
  return { verts, faces };
}
function cluster(verts, faces, cell) {
  const map = new Map(), acc = [], vi = new Int32Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const k = `${Math.floor(v[0] / cell)}_${Math.floor(v[1] / cell)}_${Math.floor(v[2] / cell)}`;
    let id = map.get(k);
    if (id === undefined) { id = acc.length; map.set(k, id); acc.push([0, 0, 0, 0]); }
    const a = acc[id]; a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; a[3]++; vi[i] = id;
  }
  const np = acc.map((a) => [a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
  const nf = [];
  for (const f of faces) { const a = vi[f[0]], b = vi[f[1]], c = vi[f[2]]; if (a !== b && b !== c && a !== c) nf.push([a, b, c]); }
  return { verts: np, faces: nf };
}

const loaded = {};
for (const [id, g] of Object.entries(GROUPS)) {
  const m = merge(g.files);
  for (const v of m.verts) { const x = v[0], y = v[1], z = v[2]; v[0] = x; v[1] = z; v[2] = y; } // RAS→scene (x, z, y)
  loaded[id] = m;
}
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (const v of loaded.cortex.verts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
const half = Math.max((hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2);
const scale = 0.98 / half;
const norm = (v) => [(v[0] - center[0]) * scale, (v[1] - center[1]) * scale, (v[2] - center[2]) * scale];

const out = { license: 'Brain surfaces: Brainder "Brain for Blender" (A. Winkler), CC-BY-SA 3.0', structures: {}, centroids: {}, roles: {} };
const round = (x) => Math.round(x * 1000) / 1000;
for (const [id, g] of Object.entries(GROUPS)) {
  const m = loaded[id];
  for (const v of m.verts) { const n = norm(v); v[0] = n[0]; v[1] = n[1]; v[2] = n[2]; }
  const d = cluster(m.verts, m.faces, g.cell);
  const p = [], idx = [], c = [0, 0, 0];
  for (const v of d.verts) { p.push(round(v[0]), round(v[1]), round(v[2])); c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  for (const f of d.faces) idx.push(f[0], f[1], f[2]);
  out.structures[id] = { p, i: idx };
  out.roles[id] = g.role;
  const nv = d.verts.length || 1;
  out.centroids[id] = [round(c[0] / nv), round(c[1] / nv), round(c[2] / nv)];
  console.log(`${id.padEnd(13)} ${String(d.verts.length).padStart(6)} v  ${String(d.faces.length).padStart(6)} f  (${g.role})`);
}
fs.mkdirSync(new URL('../public', import.meta.url).pathname, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`\n→ ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
