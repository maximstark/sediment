#!/usr/bin/env node
// Composes build/og.png (1200x630) from a real playthrough — the share card shows
// the actual simulation, not a mockup of it.
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

const server = createServer((req, res) => {
  const file = join(BUILD, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto(`${base}/test-build.html`, { waitUntil: "networkidle" });

// --- stage a world worth photographing -------------------------------------
await page.evaluate(() => {
  const s = window.__sediment;
  s.setPaused(true);
  s.genesis();

  // a gilded seam in the bedrock, directly under what gets built on top of it.
  // fill(), not paint(): gold only goes into empty cells by hand, and a vein
  // belongs inside the stone
  s.fill(60, 92, 78, 93, s.GOLD);

  // something built — posts, a lintel, a brick cap
  s.fill(58, 74, 58, 90, s.TIMBER);
  s.fill(72, 74, 72, 90, s.TIMBER);
  s.fill(58, 73, 72, 73, s.TIMBER);
  s.fill(60, 70, 70, 72, s.BRICK);

  // a basin with walls, so the water reads as water rather than a wet smear.
  // The starting pond is only a cell or two deep once it spreads.
  s.fill(85, 84, 85, 94, s.STONE);
  s.fill(103, 84, 103, 94, s.STONE);
  s.fill(86, 84, 102, 94, s.EMPTY);
  s.fill(86, 86, 102, 94, s.WATER);

  // sow its eastern shore and let it green over
  s.setEl(s.SEED); s.setBrush(4);
  for (let x = 104; x <= 124; x++) for (let y = 78; y <= 88; y++) s.paint(x, y);
  s.run(2600);
});
await page.waitForTimeout(200); // let a render frame land

// --- compose the card -------------------------------------------------------
const dataUrl = await page.evaluate(async () => {
  await document.fonts.ready;
  const W = 1200, H = 630;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const g = out.getContext("2d");
  g.imageSmoothingEnabled = false;

  g.fillStyle = "#e9dfc6";
  g.fillRect(0, 0, W, H);

  // The world is mostly sky, so a full-frame crop buries the terrain behind the
  // wordmark. Frame the band that actually has something in it: world x 48-142,
  // y 60-100 — the build, the gold seam, the pond and its green shore.
  const band = 116;
  const src = document.getElementById("c");
  g.drawImage(src, 192, 240, 376, 161, 0, 0, W, H - band);

  // a vellum plate along the bottom for the wordmark
  g.fillStyle = "#e9dfc6";
  g.fillRect(0, H - band, W, band);
  g.strokeStyle = "#3a3226";
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, H - band + 1); g.lineTo(W, H - band + 1); g.stroke();

  g.fillStyle = "#221b12";
  g.font = "44px 'IM Fell English', Georgia, serif";
  g.textBaseline = "alphabetic";
  // hand-tracked letterspacing, to match the folio's masthead
  const title = "SEDIMENT", tx = 56, ty = H - band + 60, track = 13;
  let x = tx;
  for (const ch of title) {
    g.fillStyle = ch === "M" ? "#b8941f" : "#221b12";
    g.fillText(ch, x, ty);
    x += g.measureText(ch).width + track;
  }

  g.fillStyle = "#5a4f3d";
  g.font = "italic 25px 'IM Fell English', Georgia, serif";
  g.fillText("everything settles · little survives · gold endures", tx + 2, H - band + 95);

  g.textAlign = "right";
  g.font = "italic 23px 'IM Fell English', Georgia, serif";
  g.fillText("temperaturezero.com", W - 56, H - band + 95);
  g.font = "26px 'IM Fell English', Georgia, serif";
  g.fillStyle = "#221b12";
  g.fillText("a small world that remembers", W - 56, H - band + 60);

  // outer rule, echoing the folio's double border
  g.strokeStyle = "#3a3226"; g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, W - 3, H - 3);

  return out.toDataURL("image/png");
});

// into the source tree: build/ is wiped on every build, and the card should be a
// stable committed asset rather than a fresh world on each deploy
writeFileSync(join(root, "assets/og.png"), Buffer.from(dataUrl.split(",")[1], "base64"));
await browser.close();
server.close();
console.log("wrote assets/og.png");
