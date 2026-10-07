#!/usr/bin/env node
// Composes assets/showcase-sediment.webp (1200x750) for the Studios portfolio
// card — a real playthrough, not a mockup, same as every other thumb on that page.
//
// This lives here because this repo is the thing that knows how to render the
// world; the asset itself belongs to the portfolio and has to be copied into the
// portfolio's showcase-thumbs/ directory by hand. deploy.sh only ever writes
// inside its own target directory and that should stay true.
//
// Framing: the featured card is 16/9 and fills it with object-fit:cover, so the
// thumb is composed at 16/9 and nothing gets cropped a second time on the page.
//
// How much sky to keep is the whole question. The card darkens what it shows
// (brightness .82, saturate .88) and lays a scrim over it for the title — a
// treatment built for the other three games, which are all dark. SEDIMENT is
// drawn on cream vellum, and a frame with the full sky in it turns that top half
// into a muddy olive field on the page. So the crop keeps the band the growth
// actually occupies and lets the stands fill the card. Going further the other
// way is worse again: at 96 cells across the cells read as abstract blocks
// rather than a landscape.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
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
// Which tints a world ends up wearing is a roll — a run can come out all moss
// and pine, both dark greens, and read as one strain rather than several. The
// script prints the tint census; run it a few times over a spread of --days and
// keep the one where the stands are visibly different colours, which is the
// whole thing the card is meant to show.
const DAYS = +(process.argv[process.argv.indexOf("--days") + 1] || 130);

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
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(`${base}/test-build.html`, { waitUntil: "networkidle" });

const stats = await page.evaluate((days) => {
  const s = window.__sediment;
  s.setPaused(true);
  s.genesis();
  // Sown by the strokeful along both shores, and generously — a single visitor's
  // pass leaves one end of the world green and the other bare, which is honest
  // but makes a lopsided picture.
  s.setEl(s.SEED); s.setBrush(3);
  for (const y of [82, 86]) for (let x = 14; x <= 148; x++) s.paint(x, y);
  s.run(days * 900);
  const c = s.count();
  const third = Math.floor(s.W / 3);
  return {
    day: s.day,
    green: c[s.PLANT] + c[s.FLOWER],
    tints: [0, 1, 2, 3].map((k) => s.traitHist(s.G_HUE)[k]),
    reach: [[0, third - 1], [third, 2 * third - 1], [2 * third, s.W - 1]]
      .map(([a, b]) => +s.meanTrait(s.G_REACH, a, b).toFixed(2)),
  };
}, DAYS);
await page.waitForTimeout(200); // let a render frame land

const dataUrl = await page.evaluate(() => {
  const W = 1200, H = 675;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = false;
  // world x 24-136, y 37-100 — 112x63, which is 16/9 exactly
  g.drawImage(document.getElementById("c"), 96, 148, 448, 252, 0, 0, W, H);
  return out.toDataURL("image/webp", 0.92);
});

writeFileSync(join(root, "assets/showcase-sediment.webp"), Buffer.from(dataUrl.split(",")[1], "base64"));
await browser.close();
server.close();
console.log(`wrote assets/showcase-sediment.webp — day ${stats.day}, ${stats.green} green`);
console.log(`  tints (moss/olive/verdigris/pine): ${stats.tints.join(" / ")}`);
console.log(`  mean reach notch W/H/E: ${stats.reach.join("  ")}`);
