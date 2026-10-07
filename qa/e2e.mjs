#!/usr/bin/env node
// SEDIMENT — end-to-end checks against the *production* build (no test hooks):
// persistence across reload, mobile layout and touch, the blocked-storage path,
// fonts, metadata and console cleanliness.
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
const { chromium, devices } = require("playwright");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(root, "build");
const SHOTS = join(root, "qa/screenshots");
mkdirSync(SHOTS, { recursive: true });
const TYPES = { ".html": "text/html", ".woff2": "font/woff2", ".png": "image/png" };

const results = [];
const assert = (ok, label, detail) => results.push({ ok: !!ok, label, detail });

const server = createServer((req, res) => {
  const file = join(BUILD, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
});
// SEDIMENT_URL=https://demo.temperaturezero.com/sediment runs the same checks
// against the live deploy instead of the local build
const LIVE = process.env.SEDIMENT_URL?.replace(/\/$/, "");
if (!LIVE) await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = LIVE || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// Cloudflare injects its Web Analytics beacon into HTML at the edge, so its
// requests show up in the page but are not part of what we ship. Keep them
// visible, but judge the piece on its own traffic.
const THIRD_PARTY = /cloudflareinsights\.com|\/cdn-cgi\//;
const watch = (page, sink) => {
  const add = (t) => (THIRD_PARTY.test(t) ? sink.thirdParty : sink.own).push(t);
  page.on("console", (m) => m.type() === "error" && add(m.text()));
  page.on("pageerror", (e) => add("pageerror: " + e.message));
  page.on("requestfailed", (r) => add(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
};
const sink = () => ({ own: [], thirdParty: [] });

// canvas cell -> the middle of that cell in page coordinates
const cellPoint = (box, cw, ch, cx, cy) => ({
  x: box.x + ((cx * 4 + 2) / cw) * box.width,
  y: box.y + ((cy * 4 + 2) / ch) * box.height,
});
const pixelAt = (page, cx, cy) => page.evaluate(([x, y]) => {
  const c = document.getElementById("c");
  const d = c.getContext("2d").getImageData(x * 4 + 2, y * 4 + 2, 1, 1).data;
  return [d[0], d[1], d[2]];
}, [cx, cy]);
const isGold = ([r, g, b]) => r > 175 && g > 135 && b < 115;
const isStone = ([r, g, b]) => r < 95 && g < 90 && b < 85;

// ---------------------------------------------------------------- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = sink();
  watch(page, errs);

  await page.goto(LIVE ? `${base}/` : `${base}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });

  // metadata + branding
  const meta = await page.evaluate(() => ({
    title: document.title,
    desc: document.querySelector('meta[name="description"]')?.content,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content,
    ogDesc: document.querySelector('meta[property="og:description"]')?.content,
    icon: document.querySelector('link[rel="icon"]')?.href.slice(0, 24),
    footer: document.querySelector(".colophon")?.innerText.replace(/\s+/g, " ").trim(),
    footerHref: document.querySelector(".colophon a")?.href,
    googleFonts: [...document.querySelectorAll("link,script")].some((n) => /fonts\.google|gstatic/.test(n.href || n.src || "")),
  }));
  assert(meta.desc && meta.desc.length > 30, "meta description present", meta.desc);
  assert(meta.ogTitle && meta.ogDesc, "og:title and og:description present");
  assert(meta.icon?.startsWith("data:image/svg+xml"), "favicon is an inline SVG data URI");
  assert(/Maxim Starkweather/.test(meta.footer) && /temperaturezero\.com/.test(meta.footer), "footer attribution present", meta.footer);
  assert(meta.footerHref === "https://temperaturezero.com/", "footer links to temperaturezero.com", meta.footerHref);
  assert(!meta.googleFonts, "no Google Fonts request — the face is self-hosted");

  const fontOK = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("16px 'IM Fell English'");
  });
  assert(fontOK, "IM Fell English actually loaded");

  // the piece is running
  await page.waitForTimeout(1200);
  const status = await page.textContent("#status");
  assert(/Day \d+/.test(status), "the world is ticking", status.trim());
  assert(await page.isHidden("#vaultnote"), "no vault warning when storage works");

  // The instrumented build carries a window.__sediment hook that reaches into
  // the simulation's internals. build.mjs only injects it into test-build.html
  // and deploy.sh only copies index.html, but the whole arrangement rests on
  // that, so it is worth one assertion against what is actually served.
  assert(await page.evaluate(() => typeof window.__sediment === "undefined"),
    "no QA hook in the shipped file");

  // Time control. x32 exists so inheritance is watchable in a sitting.
  const speeds = [];
  for (let k = 0; k < 4; k++) {
    await page.click("#speed");
    speeds.push((await page.textContent("#speed")).replace(/\s+/g, "").trim());
  }
  assert(speeds.includes("Time×32"), "the speed control reaches x32", speeds.join(" "));
  assert(speeds[3] === "Time×1", "and wraps back round to x1", speeds.join(" "));

  // --- persistence -----------------------------------------------------
  await page.click("#pause");
  await page.click("#goldbtn");
  const cv = await page.$("#c");
  const box = await cv.boundingBox();
  const dims = await page.evaluate(() => [document.getElementById("c").width, document.getElementById("c").height]);
  const pt = cellPoint(box, dims[0], dims[1], 80, 30); // empty sky, mid-canvas

  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + 6, pt.y + 6);
  await page.mouse.up();

  const paintedGold = isGold(await pixelAt(page, 80, 30));
  const grainsBefore = (await page.textContent("#grains")).trim();
  assert(paintedGold, "painting places gold on the canvas", grainsBefore);
  assert(/\d+ grains/.test(grainsBefore) && !/400 grains/.test(grainsBefore), "the gold budget went down", grainsBefore);

  await page.click("#save");
  const saved = (await page.textContent("#status")).trim();
  assert(/preserved/.test(saved), "Preserve reports success", saved);
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem("sediment-world-v1");
    return raw ? { len: raw.length, keys: Object.keys(JSON.parse(raw)).sort().join(",") } : null;
  });
  assert(stored && stored.len > 100, "a payload is in localStorage", `${stored?.len} bytes`);
  assert(stored?.keys === "chron,day,flags,gene,gold,grid,tick,v,wood", "payload carries the whole world", stored?.keys);

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.click("#pause");

  const after = await page.evaluate(() => ({
    // search every entry, not just the newest: an erosion or sprout event can
    // fire in the moment after load and take the top slot
    chron: [...document.querySelectorAll("#chron p")].map((n) => n.innerText.replace(/\s+/g, " ").trim()).join(" ~ "),
    grains: document.getElementById("grains").textContent.trim(),
    entries: document.querySelectorAll("#chron p").length,
  }));
  assert(/had not forgotten/.test(after.chron), "the chronicle records the reopening", after.chron);
  assert(after.grains === grainsBefore, "the gold budget survived the reload", `${grainsBefore} -> ${after.grains}`);
  assert(isGold(await pixelAt(page, 80, 30)), "the gold is still exactly where it was placed");
  assert(after.entries > 1, "the earlier chronicle survived too", `${after.entries} entries`);

  await page.click("#pause"); // let it run again for the screenshot
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, "desktop.png") });

  assert(errs.own.length === 0, "no first-party console errors on desktop", errs.own.join(" | ") || `clean${errs.thirdParty.length ? ` (${errs.thirdParty.length} Cloudflare-injected request(s) ignored)` : ""}`);
  await ctx.close();
}

// ---------------------------------------------------------------- mobile
{
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const errs = sink();
  watch(page, errs);
  await page.goto(LIVE ? `${base}/` : `${base}/index.html`, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const layout = await page.evaluate(() => {
    const c = document.getElementById("c").getBoundingClientRect();
    const chron = document.querySelector(".chronicle").getBoundingClientRect();
    const h1 = document.querySelector("h1").getBoundingClientRect();
    const motto = document.querySelector(".motto").getBoundingClientRect();
    return {
      canvasW: c.width, canvasRight: c.right,
      mottoUnderTitle: motto.top >= h1.bottom - 2,
      mottoH: motto.height,
      mottoFs: parseFloat(getComputedStyle(document.querySelector(".motto")).fontSize),
      stacked: chron.top >= c.bottom - 2,
      viewport: window.innerWidth,
      pageScrollW: document.documentElement.scrollWidth,
      folioTop: document.querySelector(".folio").getBoundingClientRect().top,
    };
  });
  assert(layout.canvasW <= layout.viewport, "canvas scales down to the viewport", `${layout.canvasW.toFixed(0)}px wide on a ${layout.viewport}px screen`);
  assert(layout.stacked, "chronicle stacks under the canvas");
  assert(layout.mottoUnderTitle, "the motto sits under the title rather than beside it");
  assert(layout.mottoH <= layout.mottoFs * 2.8, "the motto is not squeezed into a sliver", `${layout.mottoH.toFixed(0)}px tall at ${layout.mottoFs}px type`);
  assert(layout.pageScrollW <= layout.viewport + 1, "no horizontal page overflow", `scrollWidth ${layout.pageScrollW} vs ${layout.viewport}`);
  assert(layout.folioTop >= -1, "the folio is not clipped off the top of the screen", `top at ${layout.folioTop.toFixed(0)}px`);

  // touch painting
  await page.click("#pause");
  await page.click('button[data-el="1"]'); // Stone — static, so it stays where it lands
  const box = await (await page.$("#c")).boundingBox();
  const dims = await page.evaluate(() => [document.getElementById("c").width, document.getElementById("c").height]);
  const pt = cellPoint(box, dims[0], dims[1], 80, 30);
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForTimeout(120);
  assert(isStone(await pixelAt(page, 80, 30)), "touch paints onto the canvas");

  await page.click("#pause");
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOTS, "mobile.png"), fullPage: true });
  assert(errs.own.length === 0, "no first-party console errors on mobile", errs.own.join(" | ") || `clean${errs.thirdParty.length ? ` (${errs.thirdParty.length} Cloudflare-injected request(s) ignored)` : ""}`);
  await ctx.close();
}

// ---------------------------------------------------------------- storage blocked
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = sink();
  watch(page, errs);
  // stand in for private-browsing modes where touching localStorage throws
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("storage is blocked"); },
    });
  });
  await page.goto(LIVE ? `${base}/` : `${base}/index.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  assert(await page.isVisible("#vaultnote"), "the vault warning appears when storage is unavailable");
  assert(/Day \d+/.test(await page.textContent("#status")), "the piece still runs without storage");
  await page.click("#save");
  assert(/vault is unreachable/.test(await page.textContent("#status")), "Preserve fails honestly rather than silently");
  const fatal = errs.own.filter((e) => e.startsWith("pageerror"));
  assert(fatal.length === 0, "no uncaught errors with storage blocked", fatal.join(" | ") || "clean");
  await ctx.close();
}

await browser.close();
if (!LIVE) server.close();

let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? "·" : "✗"} ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(bad ? `\n${bad} check(s) failed` : `\nall ${results.length} checks passed`);
process.exit(bad ? 1 : 0);
