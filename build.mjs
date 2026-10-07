#!/usr/bin/env node
// Assembles the deployable folder from src/, and a parallel instrumented copy
// for the QA harness. Production HTML gets no test hooks — the hook is injected
// only into build/test-build.html, which is never deployed.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const OUT = join(root, "build");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "fonts"), { recursive: true });

const src = readFileSync(join(root, "src/index.html"), "utf8");
writeFileSync(join(OUT, "index.html"), src);

for (const f of ["IMFellEnglish-Regular.woff2", "IMFellEnglish-Italic.woff2"]) {
  copyFileSync(join(root, "fonts", f), join(OUT, "fonts", f));
}
// share card, generated once by qa/make-og.mjs and kept as a source asset
copyFileSync(join(root, "assets/og.png"), join(OUT, "og.png"));

// ---- instrumented copy ----------------------------------------------------
// Everything lives inside one IIFE, so the hook has to be injected before it
// closes to see the simulation's locals.
const HOOK = `
// ---- QA instrumentation (test build only, never shipped) ----
window.__sediment = {
  W, H, N, idx,
  EMPTY, STONE, SAND, WATER, SEED, PLANT, FIRE, EMBER, ASH, GOLD, TIMBER, BRICK, FLOWER, ROOT,
  HEARTWOOD,
  get cells(){ return cells; },
  get age(){ return age; },
  get day(){ return day; },
  get goldLeft(){ return goldLeft; },
  get chron(){ return chron; },
  get storageOK(){ return storageOK; },
  get supported(){ return supported; },
  step, genesis, paint, recomputeSupport, saveWorld, loadWorld, encodeGrid,
  setPaused(v){ paused = v; },
  setEl(v){ currentEl = v; },
  setBrush(v){ brushSize = v; },
  run(n){ for (let k = 0; k < n; k++) step(); },
  get stalk(){ return stalk; },
  get gene(){ return gene; },
  G_HEIGHT, G_BRANCH, G_REACH, G_HUE,
  TRAIT_MAX_H, TRAIT_BRANCH, TRAIT_REACH, TRAIT_ROOT_W, TRAIT_GROW, THIRST_H, THIRST_B,
  get LUT_DRINK(){ return LUT_DRINK; },
  get LUT_MAXH(){ return LUT_MAXH; },
  P_MUTATE, WILD_GENE, MAX_STALK, REGIONS, REACH_MAX, P_DROUGHT_WITHER,
  ROOT_IN_ASH, ROOT_WET, POOL_MIN,
  gmk, gtr, mutate, census, encodeGene, encodeWood,
  get waterField(){ return waterField; },
  get colWater(){ return colWater; },
  recomputeWaterField, invalidateWater,
  // mean trait notch over everything alive in a window, which is how selection
  // is actually judged — a single plant proves nothing
  meanTrait(shift, x0 = 0, x1 = W - 1){
    let n = 0, sum = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++){
      const i = idx(x,y), t = cells[i];
      if (t !== PLANT && t !== FLOWER) continue;
      n++; sum += gtr(gene[i], shift);
    }
    return n ? sum / n : NaN;
  },
  // living stalks standing on ground drier than their own genome can drink from.
  // Not zero even when the rule is working — ground dries out under a stand when
  // its roots fail, and a plant dies back from the tip rather than all at once —
  // but it should stay a small share of the world.
  overDry(){
    recomputeWaterField();
    let over = 0, all = 0;
    for (let i = 0; i < N; i++){
      const t = cells[i];
      if (t !== PLANT && t !== FLOWER) continue;
      all++;
      if (colWater[i % W] > LUT_DRINK[gene[i]]) over++;
    }
    return { over, all };
  },
  // how many living stalks of each notch of a trait stand on ground of a given
  // dryness — the honest way to ask what holds the dry, since a root network
  // carries water out past where a column's distance from the pool suggests
  dryHist(shift, lo, hi){
    recomputeWaterField();
    const h = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
      const i = idx(x,y), t = cells[i];
      if (t !== PLANT && t !== FLOWER) continue;
      const d = colWater[x];
      if (d >= lo && d <= hi) h[gtr(gene[i], shift)]++;
    }
    return h;
  },
  // how many living stalks of each notch of a trait stand in a window
  traitHist(shift, x0 = 0, x1 = W - 1){
    const h = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++){
      const i = idx(x,y), t = cells[i];
      if (t !== PLANT && t !== FLOWER) continue;
      h[gtr(gene[i], shift)]++;
    }
    return h;
  },
  greenIn(x0, x1){
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x <= x1; x++){
      const t = cells[idx(x,y)];
      if (t === PLANT || t === FLOWER) n++;
    }
    return n;
  },
  sow(x0, y0, x1, y1, g, p = 1){
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++){
      const i = idx(x,y);
      if (cells[i] === EMPTY && Math.random() < p){ cells[i] = SEED; age[i] = 0; gene[i] = g; }
    }
  },
  clear(){ cells.fill(EMPTY); age.fill(0); stalk.fill(0); gene.fill(0); invalidateWater(); },
  // Anything placed by a check is wild type unless the check says otherwise —
  // that is the plant every pre-genome assertion was written against, so the
  // material rules keep testing what they were tuned for.
  fill(x0, y0, x1, y1, t, g = WILD_GENE){
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (x >= 0 && x < W && y >= 0 && y < H){
        const i = idx(x,y);
        cells[i] = t; age[i] = 0; gene[i] = g;
      }
    invalidateWater();
  },
  count(){
    const c = new Array(14).fill(0); // 0..ROOT(13) — too small and it silently NaNs
    for (let i = 0; i < N; i++) c[cells[i]]++;
    return c;
  },
  // column heights of a given material, for leveling / pile-shape assertions
  surface(t){
    const out = [];
    for (let x = 0; x < W; x++){
      let top = -1;
      for (let y = 0; y < H; y++) if (cells[idx(x,y)] === t){ top = y; break; }
      out.push(top);
    }
    return out;
  },
};
`;

// \r? so a checkout with CRLF line endings (git on Windows) still matches
const marker = /\r?\n\}\)\(\);\r?\n<\/script>/g;
const hits = src.match(marker) || [];
if (hits.length !== 1) {
  throw new Error("could not find the closing IIFE marker — build.mjs needs updating");
}
writeFileSync(join(OUT, "test-build.html"), src.replace(marker, (m) => "\n" + HOOK + m));

console.log("built ->", OUT);
