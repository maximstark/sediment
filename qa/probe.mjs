#!/usr/bin/env node
// SEDIMENT — a throwaway-but-kept look at the world with its own eyes.
//
// Counts lie. The bug where every stalk hung floating in mid-air was invisible
// in the tallies and obvious the moment anyone looked at a picture, so this runs
// the simulation headless and lays the canvas out as a labelled contact sheet
// with the trait census printed under each frame.
//
//   node qa/probe.mjs                          sow the world, 200 days, 12 frames
//   node qa/probe.mjs --days 400 --frames 16
//   node qa/probe.mjs --out qa/screenshots/drift.png
//   node qa/probe.mjs --genesis                no sowing, just the starting world
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright lives in the global prefix on the VPS this was built on and in a
// local node_modules everywhere else, so try both rather than hardcoding either.
const require = (() => {
  for (const base of [import.meta.url, "/usr/local/lib/node_modules/"]) {
    try { const r = createRequire(base); r.resolve("playwright"); return r; } catch {}
  }
  throw new Error("playwright not found — `npm i playwright` here, or install it globally");
})();
const { chromium } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(root, "build");
const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".png": "image/png" };

const arg = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes("--" + name);

const DAYS = +arg("days", 200);
const FRAMES = +arg("frames", 12);
const OUT = arg("out", join(root, "qa/screenshots/probe.png"));
const SOW = !has("genesis");
mkdirSync(dirname(OUT), { recursive: true });

const server = createServer((req, res) => {
  const file = join(BUILD, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  try {
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
await page.goto(`${base}/test-build.html`, { waitUntil: "load" });

const report = await page.evaluate(async ({ DAYS, FRAMES, SOW }) => {
  const s = window.__sediment;
  const DAY = 900;
  s.setPaused(true);
  s.genesis();
  if (SOW) {
    // the way a visitor sows: broad handfuls right across the world
    s.setEl(s.SEED); s.setBrush(4);
    for (let x = 20; x <= 150; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
  }

  // the contact sheet is drawn in the page, so no image library is needed here
  const COLS = 4, ROWS = Math.ceil(FRAMES / COLS);
  const CW = s.W * 2, CH = s.H * 2, PAD = 10, CAP = 46;
  const sheet = document.createElement("canvas");
  sheet.width = COLS * (CW + PAD) + PAD;
  sheet.height = ROWS * (CH + PAD + CAP) + PAD;
  const g = sheet.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.fillStyle = "#ddd0b2";
  g.fillRect(0, 0, sheet.width, sheet.height);

  const live = document.getElementById("c");
  const frames = [];
  const per = Math.max(1, Math.round((DAYS * DAY) / FRAMES));

  // How dry the ground under each column is, in the same Chebyshev cells a
  // genome's reach is measured in. This is the sim's own field, so the probe
  // and the simulation cannot disagree about what "far from water" means.
  // (Measuring each green *cell's* distance instead reads a 30-cell stalk as
  // living 30 cells from the pool it is standing in, which is what made the
  // first pass of this probe useless.)
  const DRYNESS = [[0, 3, "0-3"], [4, 7, "4-7"], [8, 12, "8-12"], [13, 255, "13+"]];

  for (let f = 0; f < FRAMES; f++) {
    s.run(per);
    // the piece only renders on its animation frame, which is paused here
    await new Promise((r) => requestAnimationFrame(r));

    const c = s.count();
    const third = Math.floor(s.W / 3);
    const regions = [[0, third - 1], [third, 2 * third - 1], [2 * third, s.W - 1]].map(([a, b]) => ({
      green: s.greenIn(a, b),
      reach: s.meanTrait(s.G_REACH, a, b),
      height: s.meanTrait(s.G_HEIGHT, a, b),
      branch: s.meanTrait(s.G_BRANCH, a, b),
    }));
    // the cline: what strain is holding ground at each remove from water
    s.recomputeWaterField();
    const hist = [0, 0, 0, 0];
    const bands = DRYNESS.map(([lo, hi, label]) => ({ lo, hi, label, n: 0, sum: 0 }));
    for (let i = 0; i < s.N; i++) {
      const t = s.cells[i];
      if (t !== s.PLANT && t !== s.FLOWER) continue;
      const k = s.gtr(s.gene[i], s.G_REACH);
      hist[k]++;
      const dry = s.colWater[i % s.W];
      const b = bands.find((b) => dry >= b.lo && dry <= b.hi);
      if (b){ b.n++; b.sum += k; }
    }
    const row = {
      day: s.day,
      green: c[s.PLANT] + c[s.FLOWER],
      seed: c[s.SEED], root: c[s.ROOT], ash: c[s.ASH], timber: c[s.TIMBER],
      water: c[s.WATER], sand: c[s.SAND], stone: c[s.STONE],
      hist,
      bands: bands.map((b) => ({ label: b.label, n: b.n, mean: b.n ? b.sum / b.n : NaN })),
      regions,
    };
    frames.push(row);

    const cx = PAD + (f % COLS) * (CW + PAD);
    const cy = PAD + Math.floor(f / COLS) * (CH + PAD + CAP);
    g.drawImage(live, cx, cy, CW, CH);
    g.strokeStyle = "#3a3226"; g.lineWidth = 1;
    g.strokeRect(cx + 0.5, cy + 0.5, CW, CH);

    g.fillStyle = "#221b12";
    g.font = "13px Georgia, serif";
    g.fillText(`day ${row.day}  ·  ${row.green} green  ${row.seed} seed  ${row.root} root  ${row.ash} ash`, cx, cy + CH + 15);
    g.font = "12px Georgia, serif";
    g.fillStyle = "#5a4f3d";
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : " — ");
    ["W", "H", "E"].forEach((label, k) => {
      const r = regions[k];
      g.fillText(
        `${label} n=${String(r.green).padStart(4)}  reach ${fmt(r.reach)}  tall ${fmt(r.height)}  br ${fmt(r.branch)}`,
        cx + (k % 2) * 210, cy + CH + 29 + Math.floor(k / 2) * 13);
    });
  }

  return {
    frames,
    chron: s.chron.map((e) => `Day ${e.d} — ${e.m}`),
    sheet: sheet.toDataURL("image/png"),
    w: sheet.width, h: sheet.height,
  };
}, { DAYS, FRAMES, SOW });

const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, Buffer.from(report.sheet.split(",")[1], "base64"));

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "  — ");
console.log(`\n${SOW ? "sown" : "genesis"} world, ${DAYS} in-game days, ${FRAMES} frames\n`);
console.log("  day   green  seed  root   ash water  sand │      west          heartlands          east      (mean reach notch)");
for (const f of report.frames) {
  const r = f.regions.map((x) => `${String(x.green).padStart(4)} @${fmt(x.reach)}`).join("   ");
  console.log(
    `${String(f.day).padStart(5)}  ${String(f.green).padStart(6)}  ${String(f.seed).padStart(4)}  ` +
    `${String(f.root).padStart(4)}  ${String(f.ash).padStart(4)} ${String(f.water).padStart(5)} ${String(f.sand).padStart(5)} │  ${r}`);
}
console.log("\n  day │ green carrying reach notch 0/1/2/3 │ mean reach notch by how dry its ground is");
console.log("      │                                   │ " +
  report.frames[0].bands.map((b) => `${b.label.padStart(5)} cells`).join("  "));
for (const f of report.frames) {
  console.log(
    `${String(f.day).padStart(5)} │ ${f.hist.map((v) => String(v).padStart(7)).join(" ")} │ ` +
    f.bands.map((b) => `${fmt(b.mean)} n=${String(b.n).padStart(4)}`).join("  "));
}
console.log("\nchronicle:");
for (const line of [...report.chron].reverse()) console.log("  " + line);
if (errs.length) console.log("\nconsole errors:\n  " + errs.join("\n  "));
console.log(`\ncontact sheet -> ${OUT}  (${report.w}x${report.h})`);

await browser.close();
server.close();
