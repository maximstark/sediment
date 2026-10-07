#!/usr/bin/env node
// SEDIMENT — behaviour harness for the Section 3 spec.
//
// Loads the instrumented build in headless Chromium, then drives the simulation
// by calling step() directly instead of waiting on requestAnimationFrame, so a
// few thousand ticks cost milliseconds rather than a minute of wall clock.
//
//   node qa/harness.mjs            run every check
//   node qa/harness.mjs water fire run only matching checks
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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

// ---------------------------------------------------------------- test plumbing
const only = process.argv.slice(2);
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const results = [];
function assert(cond, label, detail) {
  results.push({ ok: !!cond, label, detail });
  return !!cond;
}

// TICKS_PER_DAY in the sim. "A few in-game days at Time x8" is the yardstick the
// spec uses for the slow-erosion rules.
const DAY = 900;

// ---------------------------------------------------------------- checks
check("sand: falls, slides down diagonals", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(78, 10, 82, 40, s.SAND); // a 5-wide, 31-tall column in mid-air
    const before = s.count()[s.SAND];
    s.run(600);
    const top = s.surface(s.SAND);
    const cols = top.map((y, x) => [x, y]).filter(([, y]) => y >= 0);
    return {
      before,
      after: s.count()[s.SAND],
      width: cols.length,
      highest: Math.min(...cols.map(([, y]) => y)),
      restsOnFloor: top[80] >= 0 && top[80] < 95,
    };
  });
  assert(r.after === r.before, "sand is conserved while falling", `${r.before} -> ${r.after}`);
  assert(r.restsOnFloor, "sand settles on the floor");
  assert(r.width > 5, "pile spreads wider than the column it fell from (diagonal slide)", `${r.width} columns wide`);
  assert(r.highest > 40, "pile is shorter than the original column (it slumped)", `top at y=${r.highest}`);
});

check("sand: sinks through water", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(60, 80, 100, 94, s.WATER);
    s.fill(78, 60, 82, 62, s.SAND); // dropped in above the pool
    s.run(800);
    // Only look at the slug's own columns, above the bedrock: stone eroding under
    // the pool also makes sand, and would otherwise be counted as the slug.
    let lowest = -1, highest = -1;
    for (let y = 0; y < 95; y++) for (let x = 76; x <= 84; x++) {
      if (s.cells[s.idx(x, y)] === s.SAND) { if (highest < 0) highest = y; lowest = y; }
    }
    return { lowest, highest };
  });
  assert(r.lowest >= 93, "sand reaches the floor of the pool", `lowest sand at y=${r.lowest}`);
  assert(r.highest >= 90, "the whole slug sank rather than floating", `topmost sand at y=${r.highest}`);
});

check("water: spreads laterally and finds its level", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(40, 70, 40, 94, s.STONE);   // left wall
    s.fill(120, 70, 120, 94, s.STONE); // right wall
    s.fill(42, 70, 56, 94, s.WATER);   // poured against the left wall
    // Draining is quick; evening out the last partial layer is a random creep,
    // which diffuses across 79 columns far more slowly. Give it room to settle.
    s.run(12000);

    const top = s.surface(s.WATER);
    const basin = [];
    for (let x = 41; x <= 119; x++) basin.push(top[x]);
    const wet = basin.filter((y) => y >= 0);

    // churn: how many cells actually move in one tick once it has settled
    const snap = Uint8Array.from(s.cells);
    s.run(1);
    let moved = 0;
    for (let i = 0; i < s.N; i++) if (snap[i] !== s.cells[i]) moved++;

    // Levelness judged by how tightly the surface clusters, not by max spread:
    // one transient cell riding a cell high should not read as "not level".
    const sorted = [...wet].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const flat = wet.filter((y) => Math.abs(y - median) <= 1).length;

    return {
      filled: wet.length,
      span: basin.length,
      spread: Math.max(...wet) - Math.min(...wet),
      flatPct: (flat / wet.length) * 100,
      churnPct: (moved / s.count()[s.WATER]) * 100,
    };
  });
  assert(r.filled / r.span > 0.95, "water reaches across the whole basin", `${r.filled}/${r.span} columns wet`);
  assert(r.flatPct >= 92, "surface is level", `${r.flatPct.toFixed(0)}% of columns within 1 cell of the median, max spread ${r.spread}`);
  assert(r.churnPct < 12, "settled water is not jittering", `${r.churnPct.toFixed(1)}% of cells move per tick`);
});

check("water: quenches adjacent fire", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(59, 85, 59, 94, s.STONE);  // walls, so the pool cannot drain away
    s.fill(91, 85, 91, 94, s.STONE);  // and drop out from under the flame
    s.fill(60, 90, 90, 94, s.WATER);
    s.fill(60, 89, 90, 89, s.FIRE);   // a sheet of flame sitting right on the water
    const lit = s.count()[s.FIRE];
    s.run(3);
    return { lit, left: s.count()[s.FIRE] };
  });
  assert(r.lit > 0 && r.left === 0, "fire touching water is put out within a few ticks", `${r.lit} -> ${r.left}`);
});

check("seed: germinates near water, expires when dry", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 93, s.W - 1, 94, s.SAND);   // sand bed across the world
    // A wall, or the pool creeps west along the flat bed and reaches the seeds
    // that are supposed to be dry — water levels much further now than it used to.
    s.fill(70, 84, 70, 94, s.STONE);
    // ...and a basin, or it creeps anyway and thins to a film as it goes. Only a
    // body of water feeds the ground now, so 93 cells of pool spread one deep
    // across sixty columns is nothing any seed can drink from, and the check
    // read as "seeds near water do not germinate".
    s.fill(99, 88, 99, 94, s.STONE);
    s.fill(131, 88, 131, 94, s.STONE);
    s.fill(100, 90, 130, 92, s.WATER);    // a pool in the east
    // fill() rather than a bare cells[] write, so the seed carries a genome —
    // the wild type these numbers were tuned against
    s.fill(90, 92, 98, 92, s.SEED);  // near the water
    s.fill(20, 92, 28, 92, s.SEED);  // far from any water
    // Well past SEED_LIFESPAN. Seed is deliberately long-lived now — the dormant
    // bank is what carries a forest through a population crash — so "expires
    // eventually" takes tens of thousands of ticks, not a couple of thousand.
    s.run(45000);
    // Count the dry band exactly as sown (x 20-28). The stand by the pool now
    // sows itself, and wind-thrown seed drifts west, so a looser window counts
    // brand-new seed as though the originals had never expired.
    let nearPlants = 0, farPlants = 0, farSeeds = 0;
    for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++) {
      const t = s.cells[s.idx(x, y)];
      if (t === s.PLANT) { if (x >= 80) nearPlants++; else if (x <= 40) farPlants++; }
      if (t === s.SEED && x >= 20 && x <= 28) farSeeds++;
    }
    return { nearPlants, farPlants, farSeeds };
  });
  assert(r.nearPlants > 0, "seeds bedded on sand near water germinate", `${r.nearPlants} plant cells`);
  assert(r.farPlants === 0, "seeds with no water nearby never germinate", `${r.farPlants} plant cells`);
  assert(r.farSeeds <= 2, "dry seeds do eventually expire", `${r.farSeeds}/9 left after 50 in-game days`);
});

check("plant: grows upward, branches, caps height, withers to ash", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    // Groundwater, sealed under the floor where it cannot move and cannot touch
    // anything the check is about. Plants die of thirst now, so a scene with no
    // water in it is a scene about drought — this one is about growth, and left
    // dry it measured a stalk reaching 6 cells before it withered back.
    s.fill(0, 97, s.W - 1, 98, s.WATER);
    s.fill(0, 93, s.W - 1, 94, s.SAND);
    s.fill(60, 90, 70, 92, s.WATER);
    s.fill(80, 92, 80, 92, s.PLANT);
    s.fill(20, 92, 20, 92, s.PLANT);

    let tallest = 0, widest = 0;
    for (let k = 0; k < 60; k++) {
      s.run(100);
      const top = s.surface(s.PLANT);
      const cols = top.map((y, x) => [x, y]).filter(([, y]) => y >= 0);
      if (cols.length) {
        tallest = Math.max(tallest, 93 - Math.min(...cols.map(([, y]) => y)));
        widest = Math.max(widest, cols.length);
      }
    }
    const midAsh = s.count()[s.ASH];
    s.run(12000);
    // The cap is the genome's now, not a constant, and the descendants of these
    // two plants carry their own. Checking against a fixed 24 read as a failure
    // the moment a taller strain appeared, which is the feature working. What
    // must still hold — and what the old staircase bug broke — is that no cell
    // is taller above its root than its own genome allows.
    let over = 0, worst = 0;
    for (let i = 0; i < s.N; i++) {
      const t = s.cells[i];
      if (t !== s.PLANT && t !== s.FLOWER) continue;
      const cap = s.LUT_MAXH[s.gene[i]];
      if (s.stalk[i] > cap){ over++; worst = Math.max(worst, s.stalk[i] - cap); }
    }
    return { tallest, widest, midAsh, over, worst, ash: s.count()[s.ASH], plants: s.count()[s.PLANT] };
  });
  assert(r.tallest >= 12, "plants grow appreciably tall", `${r.tallest} cells`);
  assert(r.over === 0, "no stalk climbs past the height its own genome allows",
    r.over ? `${r.over} cells, worst ${r.worst} over` : "every cell within its cap");
  assert(r.tallest <= 40, "and nothing exceeds the tallest genome there is", `${r.tallest} cells`);
  assert(r.widest > 3, "side branches appear", `${r.widest} columns occupied`);
  assert(r.ash > 0, "plants wither to ash with age", `${r.ash} ash cells`);
});

check("fire: spreads aggressively on plants, moderately on timber", async (run) => {
  // Flame spread is a stochastic chain — a single run says very little, so each
  // scenario is repeated and judged on the average.
  const r = await run(({ s }) => {
    const TRIALS = 8, LIMIT = 3000;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

    // Burn a body of material and watch the whole window: note when half is gone,
    // but keep going to the end so the final figure is not biased by stopping.
    // Sealed groundwater under the floor. Without it a horizontal row of plants
    // is a row of *tips*, every one of them in drought, and half of it is gone
    // in ~23 ticks whether or not anything is burning — this check would then
    // pass with the fire switched off entirely.
    const groundwater = () => s.fill(0, 97, s.W - 1, 98, s.WATER);

    const burn = (mat, y0, y1, lightAt) => {
      s.clear();
      s.fill(0, 95, s.W - 1, 99, s.STONE);
      groundwater();
      s.fill(40, y0, 80, y1, mat);
      // count only the body under test: plants keep growing upward while they
      // burn, so a world-wide tally of PLANT rises even as the stand is consumed
      const left = () => {
        let n = 0;
        for (let y = y0; y <= y1; y++) for (let x = 40; x <= 80; x++)
          if (s.cells[s.idx(x, y)] === mat) n++;
        return n;
      };
      const n0 = left();
      s.fill(40, lightAt, 44, lightAt, s.FIRE);
      let half = LIMIT;
      for (let t = 10; t <= LIMIT; t += 10) {
        s.run(10);
        if (half === LIMIT && left() <= n0 / 2) half = t;
      }
      return { half, burnt: 1 - left() / n0 };
    };

    // How far the fire front travels along an identical long, thin row in a fixed
    // window. Same geometry for both materials, so the numbers are comparable —
    // half-life is not, since a wall and a plank burn on different fronts.
    const front = (mat, row, lightAt, ticks) => {
      s.clear();
      s.fill(0, 95, s.W - 1, 99, s.STONE);
      groundwater();
      s.fill(20, row, 140, row, mat);
      s.fill(20, lightAt, 24, lightAt, s.FIRE);
      s.run(ticks);
      let far = 24;
      for (let x = 25; x <= 140; x++) if (s.cells[s.idx(x, row)] !== mat) far = x;
      return far - 24; // cells advanced beyond the ignition patch
    };

    const plant = [], timber = [], thin = [], pFront = [], tFront = [];
    for (let n = 0; n < TRIALS; n++) {
      plant.push(burn(s.PLANT, 80, 80, 80));
      timber.push(burn(s.TIMBER, 91, 94, 90)); // a wall someone would actually build
      thin.push(burn(s.TIMBER, 94, 94, 93));   // a one-cell plank, the worst case
      pFront.push(front(s.PLANT, 80, 80, 300));
      tFront.push(front(s.TIMBER, 94, 93, 300));
    }
    return {
      plantTicks: mean(plant.map((r) => r.half)),
      timberTicks: mean(timber.map((r) => r.half)),
      timberBurnt: mean(timber.map((r) => r.burnt)),
      thinBurnt: mean(thin.map((r) => r.burnt)),
      pFront: mean(pFront),
      tFront: mean(tFront),
      trials: TRIALS,
    };
  });
  assert(r.plantTicks < 200, "fire tears through a stand of plants", `half consumed in ${r.plantTicks.toFixed(0)} ticks (mean of ${r.trials})`);
  assert(r.timberBurnt > 0.8, "fire takes a timber wall down", `${(r.timberBurnt * 100).toFixed(0)}% consumed in 3000 ticks (mean of ${r.trials})`);
  assert(r.thinBurnt > 0.15, "…and still eats into a single plank before going out", `${(r.thinBurnt * 100).toFixed(0)}% consumed`);
  assert(r.pFront > r.tFront * 3, "flame front moves markedly slower through timber", `${r.pFront.toFixed(0)} vs ${r.tFront.toFixed(0)} cells in 300 ticks`);
});

check("fire: dies to ember, ember cools to ash", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 97, s.W - 1, 98, s.WATER); // sealed groundwater — see the check above
    s.fill(40, 80, 80, 80, s.PLANT);
    s.cells[s.idx(40, 80)] = s.FIRE;
    let sawEmber = 0;
    for (let k = 0; k < 60; k++) { s.run(10); sawEmber = Math.max(sawEmber, s.count()[s.EMBER]); }
    s.run(400);
    return { sawEmber, ash: s.count()[s.ASH], fire: s.count()[s.FIRE], ember: s.count()[s.EMBER] };
  });
  assert(r.sawEmber > 0, "burnt cells pass through an ember stage", `peak ${r.sawEmber} embers`);
  assert(r.fire === 0 && r.ember === 0, "the burn ends");
  assert(r.ash > 0, "ash is left behind", `${r.ash} cells`);
});

check("ash: falls slowly, settles, beds seeds", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(78, 40, 82, 44, s.ASH);
    s.fill(88, 40, 92, 44, s.SAND);
    // how far has each fallen after a short spell?
    s.run(40);
    const ashTop = s.surface(s.ASH)[80], sandTop = s.surface(s.SAND)[90];
    s.run(1200);
    const settledAsh = s.surface(s.ASH)[80];

    // ash as fertile substrate
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 93, s.W - 1, 94, s.ASH);
    s.fill(99, 88, 99, 94, s.STONE);   // a basin, so the pool stays a pool
    s.fill(131, 88, 131, 94, s.STONE);
    s.fill(100, 90, 130, 92, s.WATER);
    s.fill(90, 92, 98, 92, s.SEED);
    s.run(900);
    return { ashTop, sandTop, settledAsh, plantsOnAsh: s.count()[s.PLANT] };
  });
  assert(r.ashTop < r.sandTop, "ash falls more slowly than sand", `ash y=${r.ashTop} vs sand y=${r.sandTop} after 40 ticks`);
  assert(r.settledAsh >= 90, "ash settles onto the floor", `top of pile at y=${r.settledAsh}`);
  assert(r.plantsOnAsh > 0, "seeds germinate on ash as well as sand", `${r.plantsOnAsh} plant cells`);
});

check("ash: sinks through water rather than piling on the surface", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(60, 80, 100, 94, s.WATER);
    s.fill(78, 60, 82, 62, s.ASH);
    s.run(1500);
    let lowest = -1;
    for (let y = 0; y < s.H; y++) for (let x = 0; x < s.W; x++)
      if (s.cells[s.idx(x, y)] === s.ASH) lowest = y;
    return { lowest };
  });
  assert(r.lowest >= 93, "ash works its way down to the pool floor", `lowest ash at y=${r.lowest}`);
});

check("stone: erodes to sand where water touches it", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 90, s.W - 1, 99, s.STONE);
    s.fill(40, 85, 120, 89, s.WATER);
    const sand0 = s.count()[s.SAND];
    s.run(4 * 900); // four in-game days
    return { sand0, sand: s.count()[s.SAND] };
  });
  assert(r.sand > 8, "stone under water visibly turns to sand within a few in-game days", `${r.sand - r.sand0} grains after 4 days`);
});

check("stone: does not erode away from water", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 90, s.W - 1, 99, s.STONE);
    const stone0 = s.count()[s.STONE];
    s.run(20 * 900);
    return { stone0, stone: s.count()[s.STONE] };
  });
  assert(r.stone === r.stone0, "dry stone is untouched after 20 in-game days", `${r.stone0} -> ${r.stone}`);
});

check("timber rots and brick weathers in water, brick slower", async (run) => {
  const r = await run(({ s }) => {
    const soak = (mat) => {
      s.clear();
      s.fill(0, 95, s.W - 1, 99, s.STONE);
      s.fill(40, 93, 120, 94, mat);
      s.fill(40, 90, 120, 92, s.WATER);
      const before = s.count()[mat];
      s.run(4 * 900);
      return 1 - s.count()[mat] / before;
    };
    return { timber: soak(s.TIMBER), brick: soak(s.BRICK) };
  });
  assert(r.timber > 0.1, "timber rots where water touches it", `${(r.timber * 100).toFixed(0)}% gone in 4 days`);
  assert(r.brick > 0.02, "brick weathers where water touches it", `${(r.brick * 100).toFixed(0)}% gone in 4 days`);
  assert(r.brick < r.timber, "brick outlasts timber", `${(r.brick * 100).toFixed(0)}% vs ${(r.timber * 100).toFixed(0)}%`);
});

check("gold: immutable, and capped at 400 grains", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(40, 90, 60, 92, s.GOLD);
    s.fill(40, 88, 60, 89, s.WATER);   // sitting in water
    s.fill(62, 90, 62, 92, s.FIRE);    // and next to fire
    s.fill(70, 90, 90, 92, s.GOLD);
    s.fill(70, 88, 90, 89, s.PLANT);
    const before = s.count()[s.GOLD];
    s.run(10 * 900);
    const after = s.count()[s.GOLD];

    // budget: scribble gold everywhere and see where it stops
    s.genesis();
    s.setEl(s.GOLD);
    s.setBrush(6);
    for (let x = 5; x < s.W; x += 3) for (let y = 5; y < 60; y += 3) s.paint(x, y);
    return { before, after, placed: s.count()[s.GOLD], left: s.goldLeft };
  });
  assert(r.after === r.before, "gold survives fire, water and time unchanged", `${r.before} -> ${r.after} after 10 days`);
  assert(r.placed === 400, "exactly 400 grains can be placed", `${r.placed} placed`);
  assert(r.left === 0, "the budget reads empty once spent", `${r.left} left`);
});

check("support: grounded builds hold, unanchored spans collapse", async (run) => {
  const r = await run(({ s }) => {
    const settle = (build) => {
      s.clear();
      s.fill(0, 95, s.W - 1, 99, s.STONE);
      build();
      const before = s.surface(s.TIMBER).filter((y) => y >= 0).length;
      s.run(200);
      const top = s.surface(s.TIMBER);
      const cols = top.filter((y) => y >= 0);
      return { before, after: cols.length, highest: cols.length ? Math.min(...cols) : -1 };
    };

    // a wall standing on the floor
    const wall = settle(() => s.fill(60, 80, 62, 94, s.TIMBER));

    // a span cantilevered off a stone pillar
    const braced = settle(() => {
      s.fill(50, 80, 50, 94, s.STONE);
      s.fill(51, 80, 70, 80, s.TIMBER);
    });

    // the same span with its pillar knocked out
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(50, 80, 50, 94, s.STONE);
    s.fill(51, 80, 70, 80, s.TIMBER);
    s.run(50);
    const heldBefore = Math.min(...s.surface(s.TIMBER).filter((y) => y >= 0));
    s.fill(50, 80, 50, 94, s.EMPTY); // remove the anchor
    s.run(200);
    const cutTop = s.surface(s.TIMBER).filter((y) => y >= 0);

    // a slab floating in mid-air, touching nothing
    const floating = settle(() => s.fill(80, 40, 100, 41, s.TIMBER));

    return {
      wallTop: wall.highest, wallCols: wall.after,
      bracedTop: braced.highest, bracedCols: braced.after,
      heldBefore, cutTop: Math.min(...cutTop),
      floatTop: floating.highest,
    };
  });
  assert(r.wallTop === 80 && r.wallCols === 3, "a wall on the ground stays put", `top y=${r.wallTop}, ${r.wallCols} columns`);
  assert(r.bracedTop === 80, "a span anchored to a pillar holds as a lintel", `top y=${r.bracedTop}`);
  assert(r.heldBefore === 80, "…and was genuinely held, not mid-fall", `top y=${r.heldBefore}`);
  assert(r.cutTop >= 93, "pulling the anchor collapses the span", `top y=${r.cutTop} after the pillar went`);
  assert(r.floatTop >= 93, "a slab touching nothing falls immediately", `top y=${r.floatTop}`);
});

// The checks above build tidy synthetic terrain. These use the world a visitor
// actually lands on, which is the only one that matters for "observable in ~2
// minutes of play".
check("genesis world: erosion is witnessed at Time x8 within a few days", async (run) => {
  const r = await run(({ s }) => {
    s.genesis();
    const sand0 = s.count()[s.SAND];
    s.run(4 * 900); // four in-game days ~ 7.5s of watching at Time x8
    const noted = s.chron.some((e) => /wore the first stone/.test(e.m));
    return { gained: s.count()[s.SAND] - sand0, noted };
  });
  assert(r.gained > 5, "the starting pond visibly eats into its bed", `+${r.gained} grains of sand in 4 days`);
  assert(r.noted, "the chronicle records the first erosion");
});

check("genesis world: seeds sown on the shoreline take root", async (run) => {
  // Sown seed carries a genome now, and how far a given seed will bed in from
  // water is part of it, so what a handful does on the shoreline is a roll.
  // Three trials rather than one.
  //
  // The stroke matters as much as the trials. Painting a solid block the way
  // this check used to buries its own seedbed — measured, 163 of 187 seeds came
  // to rest on *other seed*, which is not soil and will not take, and the check
  // swung between 20 and 137 plants. One pass along the lip, which is what the
  // gesture actually is, gives a third of the seed and four times the plants.
  const r = await run(({ s }) => {
    const trials = [];
    for (let t = 0; t < 3; t++) {
      s.genesis();
      s.setEl(s.SEED);
      s.setBrush(3);
      // sow along the western lip of the starting pond, the way a visitor would
      for (let x = 96; x <= 118; x++) s.paint(x, 84);
      s.run(2 * 900);
      trials.push({
        plants: s.count()[s.PLANT],
        sprouted: s.chron.some((e) => /first green thing/.test(e.m)),
      });
    }
    return trials;
  });
  assert(r.every((t) => t.plants > 20), "painting seed near the pond produces plants",
    `${r.map((t) => t.plants).join(", ")} plant cells across ${r.length} sowings`);
  assert(r.every((t) => t.sprouted), "the chronicle records the first sprout");
});

check("ecology: a sown world sustains itself and never dies out", async (run) => {
  // The population booms and busts hard — a cohort sown together flowers and
  // dies together. What must never happen is losing the plants AND the seed
  // bank at once, because nothing can come back from that.
  const r = await run(({ s }) => {
    const trials = [];
    for (let t = 0; t < 2; t++) {
      s.genesis(); s.setPaused(true);
      s.setEl(s.SEED); s.setBrush(4);
      for (let x = 30; x <= 140; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
      let barren = 0, minGreen = 1e9, maxGreen = 0;
      for (let k = 0; k < 25; k++) {          // 100 in-game days
        s.run(4 * 900);
        const c = s.count();
        const green = c[s.PLANT] + c[s.FLOWER];
        if (green === 0 && c[s.SEED] === 0) barren++;
        if (k > 3) { minGreen = Math.min(minGreen, green); maxGreen = Math.max(maxGreen, green); }
      }
      const c = s.count();
      trials.push({ barren, minGreen, maxGreen, endGreen: c[s.PLANT] + c[s.FLOWER], endSeed: c[s.SEED] });
    }
    return trials;
  });
  const barren = r.reduce((n, t) => n + t.barren, 0);
  assert(barren === 0, "never loses both the plants and the seed bank", `${barren} barren samples across ${r.length} runs`);
  assert(r.every((t) => t.endGreen + t.endSeed > 0), "still living after 100 in-game days",
    r.map((t) => `${t.endGreen} green / ${t.endSeed} seed`).join(", "));
  assert(r.every((t) => t.maxGreen > 60), "the world actually greens up", r.map((t) => `peak ${t.maxGreen}`).join(", "));
});

check("ecology: flowers open, set seed, and old growth hardens", async (run) => {
  const r = await run(({ s }) => {
    s.genesis(); s.setPaused(true);
    s.setEl(s.SEED); s.setBrush(4);
    for (let x = 30; x <= 140; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
    let sawFlower = 0, sawHeart = 0;
    for (let k = 0; k < 20; k++) {
      s.run(3 * 900);
      const c = s.count();
      sawFlower = Math.max(sawFlower, c[s.FLOWER]);
      let h = 0;
      for (let i = 0; i < s.N; i++) if (s.cells[i] === s.TIMBER && s.stalk[i] === s.HEARTWOOD) h++;
      sawHeart = Math.max(sawHeart, h);
    }
    let built = 0;
    for (let i = 0; i < s.N; i++) if (s.cells[i] === s.TIMBER && s.stalk[i] !== s.HEARTWOOD) built++;
    return {
      sawFlower, sawHeart, built,
      flowered: s.chron.some((e) => /flower opened/.test(e.m)),
      sown: s.chron.some((e) => /sowed itself/.test(e.m)),
      hardened: s.chron.some((e) => /hardened into timber/.test(e.m)),
      greatWork: s.chron.some((e) => /great work/.test(e.m)),
    };
  });
  assert(r.sawFlower > 0 && r.flowered, "flowers open on mature growth", `peak ${r.sawFlower} in bloom`);
  assert(r.sown, "the world sows itself without being replanted");
  assert(r.sawHeart > 0 && r.hardened, "old growth hardens into heartwood", `peak ${r.sawHeart} cells`);
  assert(r.built === 0, "grown wood is not counted as built", `${r.built} cells mislabelled`);
  assert(!r.greatWork, "a forest does not announce itself as a great work");
});

check("ecology: growth stays rooted, and its leavings stay bounded", async (run) => {
  const r = await run(({ s }) => {
    s.genesis(); s.setPaused(true);
    s.setEl(s.SEED); s.setBrush(4);
    for (let x = 30; x <= 140; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
    let peakAsh = 0, peakTimber = 0;
    for (let k = 0; k < 25; k++) {
      s.run(4 * 900);
      const c = s.count();
      peakAsh = Math.max(peakAsh, c[s.ASH]);
      peakTimber = Math.max(peakTimber, c[s.TIMBER]);
    }
    // anything green hanging over a gap with no green beside it is floating
    let floating = 0;
    for (let y = 0; y < s.H - 1; y++) for (let x = 0; x < s.W; x++) {
      const t = s.cells[s.idx(x, y)];
      if (t !== s.PLANT && s.cells[s.idx(x, y)] !== s.FLOWER) continue;
      const u = s.cells[s.idx(x, y + 1)];
      if (u !== s.EMPTY && u !== s.WATER) continue;
      const l = x > 0 ? s.cells[s.idx(x - 1, y)] : s.STONE;
      const rr = x < s.W - 1 ? s.cells[s.idx(x + 1, y)] : s.STONE;
      const green = (m) => m === s.PLANT || m === s.FLOWER;
      if (!green(l) && !green(rr)) floating++;
    }
    return { floating, peakAsh, peakTimber, pct: (peakAsh / s.N) * 100 };
  });
  assert(r.floating <= 2, "no stalks left hanging in the air", `${r.floating} floating cells`);
  assert(r.pct < 25, "ash does not silt up the world", `peak ${r.peakAsh} cells, ${r.pct.toFixed(0)}% of the grid`);
  assert(r.peakTimber < 400, "heartwood does not accumulate for ever", `peak ${r.peakTimber} cells`);
});

check("genesis world: runs a long while without going haywire", async (run) => {
  const r = await run(({ s }) => {
    s.genesis();
    s.run(60 * 900); // sixty in-game days, unattended
    const c = s.count();
    let stray = 0; // anything airborne above the terrain that should have settled
    for (let y = 0; y < 60; y++) for (let x = 0; x < s.W; x++) {
      const t = s.cells[s.idx(x, y)];
      if (t === s.SAND || t === s.WATER || t === s.ASH) stray++;
    }
    return { day: s.day, stray, gold: c[s.GOLD], chron: s.chron.length };
  });
  assert(r.day >= 60, "the calendar advances", `day ${r.day}`);
  assert(r.stray === 0, "nothing is left hanging in the air", `${r.stray} floating cells`);
  assert(r.chron > 1, "the chronicle accumulates entries", `${r.chron} entries`);
});

// ---------------------------------------------------------------- the genome
check("genome: a lineage carries its own inheritance", async (run) => {
  const r = await run(({ s }) => {
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 92, s.W - 1, 94, s.SAND);
    s.fill(40, 86, 60, 91, s.WATER);       // a pool for them to live on
    s.fill(38, 86, 38, 94, s.STONE);       // walls, so it stays a pool
    s.fill(62, 86, 62, 94, s.STONE);
    // One strain, unmistakable: tallest, branchiest, longest-reaching, pine.
    // Not the thirstiest — size is paid for in reach, so tall and branchy on top
    // of a short reach clamps to a drink of 1 and the founder dies where it
    // stands, which reads as "inheritance is broken" and is nothing of the kind.
    const mark = s.gmk(3, 3, 3, 3);
    s.fill(64, 91, 64, 91, s.PLANT, mark);
    s.fill(36, 91, 36, 91, s.PLANT, mark);
    s.run(30 * 900);

    // every living thing in the world descends from those two cells
    let living = 0, strayHue = 0, mutated = 0, kinds = {};
    for (let i = 0; i < s.N; i++) {
      const t = s.cells[i];
      if (t !== s.PLANT && t !== s.FLOWER && t !== s.SEED && t !== s.ROOT) continue;
      living++;
      const g = s.gene[i];
      kinds[t] = (kinds[t] || 0) + 1;
      if (g !== mark) mutated++;
      // tint only moves by mutation, so most of the line still shows the mark's
      if (s.gtr(g, s.G_HUE) !== 3) strayHue++;
    }
    return {
      living, mutated, strayHue,
      seed: kinds[s.SEED] || 0, plant: kinds[s.PLANT] || 0,
      flower: kinds[s.FLOWER] || 0, root: kinds[s.ROOT] || 0,
    };
  });
  assert(r.living > 50, "the marked strain established itself", `${r.living} living cells`);
  assert(r.plant > 0 && r.seed > 0 && r.root > 0,
    "it went all the way round — stalk, seed and root all carry a genome",
    `${r.plant} plant, ${r.seed} seed, ${r.root} root, ${r.flower} flower`);
  assert(r.mutated < r.living * 0.8, "inheritance is mostly faithful",
    `${r.mutated}/${r.living} differ from the founding genome`);
  assert(r.strayHue < r.living * 0.5, "the founder's tint still marks most of the line",
    `${r.strayHue}/${r.living} have drifted off it`);
  assert(r.mutated > 0, "…but not perfectly — some seed came out different", `${r.mutated} changed`);
});

check("genome: mutation moves one trait one notch, at about the stated rate", async (run) => {
  const r = await run(({ s }) => {
    const start = s.gmk(1, 1, 1, 1);
    const TRIALS = 40000;
    let changed = 0, multi = 0, bigStep = 0;
    const shifts = [s.G_HEIGHT, s.G_BRANCH, s.G_REACH, s.G_HUE];
    const touched = [0, 0, 0, 0];
    for (let n = 0; n < TRIALS; n++) {
      const out = s.mutate(start);
      if (out === start) continue;
      changed++;
      let moved = 0;
      shifts.forEach((sh, k) => {
        const a = s.gtr(start, sh), b = s.gtr(out, sh);
        if (a === b) return;
        moved++; touched[k]++;
        // tint has no order, so it is allowed to jump; the rest must step
        if (sh !== s.G_HUE && Math.abs(a - b) !== 1) bigStep++;
      });
      if (moved > 1) multi++;
    }
    return { changed, multi, bigStep, touched, rate: changed / TRIALS, trials: TRIALS };
  });
  // a step off either end of a scale goes nowhere, so the observed rate sits
  // below P_MUTATE — the middle notches can move both ways, the ends cannot
  assert(r.rate > 0.05 && r.rate < 0.20, "mutation happens about as often as it is meant to",
    `${(r.rate * 100).toFixed(1)}% of ${r.trials} seed set`);
  assert(r.multi === 0, "only ever one trait at a time", `${r.multi} seed changed two`);
  assert(r.bigStep === 0, "and only ever by one notch", `${r.bigStep} jumped further`);
  assert(r.touched.every((n) => n > 0), "every trait is reachable", r.touched.join("/"));
});

check("genome: the traits actually do something", async (run) => {
  const r = await run(({ s }) => {
    // one strain per bench, each on its own pool, measured against each other
    const grow = (g, ticks) => {
      s.clear();
      s.fill(0, 95, s.W - 1, 99, s.STONE);
      s.fill(0, 97, s.W - 1, 98, s.WATER); // sealed groundwater: this is not a drought check
      s.fill(0, 92, s.W - 1, 94, s.SAND);
      for (let x = 20; x <= 140; x += 20) s.fill(x, 91, x, 91, s.PLANT, g);
      s.run(ticks);
      // only the strain that was planted — by 6000 ticks it has seeded and some
      // of its descendants carry a different cap, and counting those measures
      // mutation rather than the trait
      let tallest = 0, cells = 0, cols = new Set();
      for (let i = 0; i < s.N; i++) {
        const t = s.cells[i];
        if ((t !== s.PLANT && t !== s.FLOWER) || s.gene[i] !== g) continue;
        cells++; cols.add(i % s.W);
        tallest = Math.max(tallest, s.stalk[i]);
      }
      return { tallest, cells, cols: cols.size };
    };
    // Vary one trait at a time off the wild type. Branching is judged on mass
    // rather than on how many columns are occupied, and before the stand starts
    // seeding itself: seven plants left for 6000 ticks spread over most of the
    // world either way, so the column count saturated and told the two strains
    // apart about as often as a coin would.
    const short = grow(s.gmk(0, 1, 1, 0), 6000), tall = grow(s.gmk(3, 1, 1, 0), 6000);
    const sparse = grow(s.gmk(1, 0, 1, 0), 2500), thicket = grow(s.gmk(1, 3, 1, 0), 2500);
    return { short, tall, sparse, thicket, caps: s.TRAIT_MAX_H };
  });
  assert(r.tall.tallest > r.short.tallest + 6, "a tall genome grows taller than a short one",
    `${r.tall.tallest} vs ${r.short.tallest} cells (caps ${r.caps[3]} and ${r.caps[0]})`);
  assert(r.short.tallest <= r.caps[0] + 1, "the short genome respects its own cap",
    `${r.short.tallest} against a cap of ${r.caps[0]}`);
  assert(r.thicket.cells > r.sparse.cells * 1.3, "a branchy genome makes a great deal more plant",
    `${r.thicket.cells} cells across ${r.thicket.cols} columns vs ` +
    `${r.sparse.cells} across ${r.sparse.cols}, from seven stalks apiece`);
});

check("selection: the dry ground is held by a different strain than the shore", async (run) => {
  // The whole point of the trait. Sow one long shore with an even mix of every
  // reach there is and let the ground decide: near the water the fast thirsty
  // strain should win on turnover, and further out it should not be able to live
  // at all. Stochastic, so it is judged on the mean of several sowings.
  const r = await run(({ s }) => {
    const add = (a, b) => a.map((v, k) => v + b[k]);
    const trials = [];
    for (let t = 0; t < 3; t++) {
      // A pool sunk in thick bedrock mid-world — a bowl rather than a stretch of
      // the sand bed walled off, because a wall tall enough to hold water also
      // cuts the soil in two and stops the gradient existing at all. Mid-world
      // rather than at one end so every sowing samples two shores: a single
      // gradient is a few dozen plants and wanders far too much to assert on.
      s.clear();
      s.fill(0, 90, s.W - 1, 99, s.STONE);
      s.fill(70, 91, 90, 97, s.WATER);
      s.fill(0, 88, 68, 89, s.SAND);
      s.fill(92, 88, s.W - 1, 89, s.SAND);
      // an even mix of all four reaches, right along both dry shores
      for (let x = 0; x < s.W; x++) {
        if (x >= 69 && x <= 91) continue;
        s.sow(x, 87, x, 87, s.gmk(1, 1, (Math.random() * 4) | 0, 0));
      }
      s.run(60 * 900);
      // Bucketed by how dry the ground each stalk stands on actually is, not by
      // how far along the shore it is. A stand's own roots carry water out into
      // the dry, so a column ten cells from the pool can be wetter than one at
      // four, and reading position as dryness put short-reach growth in what
      // this check called the dry band and made it fail for the wrong reason.
      trials.push({
        near: s.dryHist(s.G_REACH, 0, 3),
        far: s.dryHist(s.G_REACH, 7, 254),
        // Nothing can drink out here: the furthest reach is 10 cells and the
        // longest root network 14, so 35 cells from the lip is out of the
        // question however the stand engineers its way outward. (45 was not —
        // the lid of the bowl erodes, roots find the water through the gap and
        // the whole halo shifts another dozen cells out.)
        beyond: s.greenIn(0, 35) + s.greenIn(125, s.W - 1),
        overDry: s.overDry(),
      });
    }
    return trials;
  });
  // Everything is read off one pooled histogram of reach notches per band, so a
  // sowing that happens to establish little out on the dry dilutes the figure
  // instead of throwing the check away.
  const pool = (b) => r.reduce((a, t) => a.map((v, k) => v + t[b][k]), [0, 0, 0, 0]);
  const near = pool("near"), far = pool("far");
  const total = (h) => h.reduce((a, b) => a + b, 0);
  const mean = (h) => h.reduce((a, v, k) => a + v * k, 0) / (total(h) || 1);
  const nearAll = total(near), farAll = total(far);

  assert(nearAll > 200 && farAll > 20, "both the wet ground and the dry are living in",
    `${nearAll} stalks on ground within 3 cells of water, ${farAll} on ground 7 or more out, ` +
    `across ${r.length} sowings`);
  // The pair that says what the trait is for. A drink of 4 or 6 cells cannot
  // hold ground 7 out — bar a straggler on ground that has only just dried under
  // it, which dies back from the tip over the next few hundred ticks rather than
  // vanishing the moment its root network fails, so this is a share and not a
  // zero. On the wet, the same short-reach growth is the majority: it grows
  // fastest, and where thirst costs nothing that is the whole of the argument.
  const share = (h) => (h[0] + h[1]) / (h.reduce((a, b) => a + b, 0) || 1);
  assert(share(far) < 0.15, "short-reaching growth barely holds any of the dry ground",
    `${(share(far) * 100).toFixed(0)}% of ${farAll} — far ${far.join("/")} by reach notch`);
  // How much of the wet a short reach takes swings between a fifth and three
  // fifths run to run — it is a real contest there, which is the point — so what
  // is asserted is that it does markedly better on the wet than on the dry.
  assert(share(near) > share(far), "…and does markedly better back on the wet",
    `${(share(near) * 100).toFixed(0)}% of ${nearAll} on the wet vs ` +
    `${(share(far) * 100).toFixed(0)}% on the dry — near ${near.join("/")}`);
  // the drought rule, end to end
  const over = r.reduce((a, t) => a + t.overDry.over, 0), all = r.reduce((a, t) => a + t.overDry.all, 0);
  assert(over < all * 0.1, "almost nothing is standing on ground it cannot drink from",
    `${over} of ${all} stalks, ${((over / all) * 100).toFixed(1)}%`);
  assert(mean(far) >= 2, "the dry is held by the strains that reach 8 cells and further",
    `mean reach notch ${mean(far).toFixed(2)} out there`);
  assert(mean(far) > mean(near), "…which is not the mixture back on the wet",
    `${mean(far).toFixed(2)} on the dry vs ${mean(near).toFixed(2)} on the wet — near ${near.join("/")}`);
  assert(near.filter((n) => n > 0).length >= 2, "and the wet keeps more than one strain on it",
    `near ${near.join("/")} by reach notch`);
  assert(r.every((t) => t.beyond === 0), "and no strain lives where no strain can drink",
    r.map((t) => t.beyond).join(", "));
});

check("water: a film left over from a pool is not something to live on", async (run) => {
  const r = await run(({ s }) => {
    // a proper pool, and the same amount of water spread one cell deep
    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 92, s.W - 1, 94, s.SAND);
    s.fill(38, 86, 38, 94, s.STONE);
    s.fill(62, 86, 62, 94, s.STONE);
    s.fill(39, 87, 61, 91, s.WATER);
    s.recomputeWaterField();
    const pool = { dry: s.colWater[50] === 255, at: s.colWater[50] };

    s.clear();
    s.fill(0, 95, s.W - 1, 99, s.STONE);
    s.fill(0, 92, s.W - 1, 94, s.SAND);
    s.fill(20, 91, 130, 91, s.WATER); // one cell deep, right across
    s.recomputeWaterField();
    const film = { dry: s.colWater[75] === 255, at: s.colWater[75] };
    return { pool, film };
  });
  assert(!r.pool.dry, "a body of water feeds the ground around it", `colWater ${r.pool.at}`);
  assert(r.film.dry, "a one-cell film does not", `colWater ${r.film.at}`);
});

check("matter: a forest does not turn its own leavings into permanent ground", async (run) => {
  // Plants are a matter source and ash is the only way any of it leaves again.
  // Roots grew through ash and died as sand, which quietly promoted ash into
  // terrain that can never weather — measured at 447 -> 2803 cells of sand over
  // 200 sown days with stone flat, on course to bury the pools the world runs on.
  const r = await run(({ s }) => {
    s.genesis(); s.setPaused(true);
    s.setEl(s.SEED); s.setBrush(4);
    for (let x = 30; x <= 140; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
    const c0 = s.count();
    const start = { sand: c0[s.SAND], stone: c0[s.STONE] };
    let peakTerrain = 0;
    for (let k = 0; k < 10; k++) {
      s.run(30 * 900); // 300 in-game days
      const c = s.count();
      peakTerrain = Math.max(peakTerrain, c[s.SAND] + c[s.ASH] + c[s.ROOT]);
    }
    const c = s.count();
    return {
      start, peakTerrain,
      sand: c[s.SAND], stone: c[s.STONE], ash: c[s.ASH], root: c[s.ROOT],
      water: c[s.WATER], green: c[s.PLANT] + c[s.FLOWER], seed: c[s.SEED],
    };
  });
  const madeSand = r.sand - r.start.sand, lostStone = r.start.stone - r.stone;
  assert(madeSand <= lostStone + 250, "sand only comes from stone, not from the forest",
    `sand ${r.start.sand} -> ${r.sand} (+${madeSand}) against ${lostStone} stone eroded, over 300 days`);
  assert(r.water > 100, "the pools are still there at the end of it", `${r.water} cells of water`);
  assert(r.green + r.seed > 0, "and something is still alive", `${r.green} green, ${r.seed} seed`);
});

check("save: the genome survives the vault, and older worlds still open", async (run) => {
  const r = await run(({ s }) => {
    s.genesis(); s.setPaused(true);
    s.setEl(s.SEED); s.setBrush(3);
    for (let x = 96; x <= 118; x++) s.paint(x, 84);
    s.run(40 * 900); // long enough for heartwood and a spread of genomes

    // Whether a stand happens to lignify inside forty days is a roll, and the
    // heartwood channel is worth testing every run, so a stump is laid on by
    // hand alongside whatever grew. Built timber goes next to it: the whole
    // point of the channel is telling the two apart across a reload.
    s.fill(10, 40, 14, 40, s.TIMBER);
    for (let x = 10; x <= 14; x++) s.stalk[s.idx(x, 40)] = s.HEARTWOOD;
    s.fill(20, 40, 24, 40, s.TIMBER); // built, stalk left at 0
    // likewise a root that came up through ash — whether the stand happens to
    // have one after forty days is another roll, and the channel carries it
    s.fill(30, 40, 34, 40, s.ROOT);
    for (let x = 30; x <= 34; x++) s.stalk[s.idx(x, 40)] = s.ROOT_IN_ASH;

    const alive = (t) => t === s.PLANT || t === s.FLOWER || t === s.SEED || t === s.ROOT;
    const before = [];
    for (let i = 0; i < s.N; i++) if (alive(s.cells[i])) before.push([i, s.cells[i], s.gene[i]]);
    const heart = [], builtWood = [];
    for (let i = 0; i < s.N; i++) {
      if (s.cells[i] !== s.TIMBER) continue;
      (s.stalk[i] === s.HEARTWOOD ? heart : builtWood).push(i);
    }
    // roots that came up through ash owe the world an ash cell back when they die
    const ashRoots = [];
    for (let i = 0; i < s.N; i++) if (s.cells[i] === s.ROOT && (s.stalk[i] & s.ROOT_IN_ASH)) ashRoots.push(i);
    const kinds = new Set(before.map(([, , g]) => g));

    s.saveWorld(true);
    const raw = localStorage.getItem("sediment-world-v1");
    const parsed = JSON.parse(raw);

    s.clear();
    const reopened = s.loadWorld();
    let kept = 0, lost = 0;
    for (const [i, t, g] of before) (s.cells[i] === t && s.gene[i] === g) ? kept++ : lost++;
    let heartKept = 0, builtKept = 0, ashRootsKept = 0;
    for (const i of heart) if (s.cells[i] === s.TIMBER && s.stalk[i] === s.HEARTWOOD) heartKept++;
    for (const i of builtWood) if (s.cells[i] === s.TIMBER && s.stalk[i] !== s.HEARTWOOD) builtKept++;
    for (const i of ashRoots) if (s.cells[i] === s.ROOT && (s.stalk[i] & s.ROOT_IN_ASH)) ashRootsKept++;

    // the same world as it would have been written before the genome existed
    const older = (v) => {
      const o = { ...parsed, v };
      delete o.gene; delete o.wood;
      localStorage.setItem("sediment-world-v1", JSON.stringify(o));
      s.clear();
      const ok = s.loadWorld();
      let living = 0, wild = 0;
      for (let i = 0; i < s.N; i++) {
        if (!alive(s.cells[i])) continue;
        living++; if (s.gene[i] === s.WILD_GENE) wild++;
      }
      return { ok, living, wild };
    };
    const v2 = older(2), v1 = older(1);

    return {
      reopened, kept, lost, kinds: kinds.size,
      heart: heart.length, heartKept, built: builtWood.length, builtKept,
      ashRoots: ashRoots.length, ashRootsKept,
      bytes: raw.length, keys: Object.keys(parsed).sort().join(","), v: parsed.v,
      v2, v1,
    };
  });
  assert(r.v === 3 && /(^|,)gene(,|$)/.test(r.keys), "the vault holds a genome channel", `v${r.v}: ${r.keys}`);
  assert(r.kinds > 3, "the world had a spread of genomes worth saving", `${r.kinds} distinct`);
  assert(r.reopened && r.lost === 0, "every living cell comes back with the genome it had",
    `${r.kept} kept, ${r.lost} lost`);
  assert(r.heart > 0 && r.heartKept === r.heart, "grown timber comes back grown, not built",
    `${r.heartKept}/${r.heart} heartwood cells`);
  assert(r.built > 0 && r.builtKept === r.built, "…and built timber comes back built",
    `${r.builtKept}/${r.built} built cells`);
  assert(r.ashRoots > 0 && r.ashRootsKept === r.ashRoots,
    "roots still remember they came up through ash, so they give ash back",
    `${r.ashRootsKept}/${r.ashRoots} roots`);
  assert(r.v2.ok && r.v2.living > 0 && r.v2.wild === r.v2.living,
    "a v2 world still opens, and its growth is wild type",
    `${r.v2.wild}/${r.v2.living} living cells wild`);
  assert(r.v1.ok && r.v1.living > 0 && r.v1.wild === r.v1.living,
    "so does a v1 world", `${r.v1.wild}/${r.v1.living} living cells wild`);
  assert(r.bytes < 400000, "the payload stays a sensible size", `${(r.bytes / 1024).toFixed(0)} kB`);
});

check("performance: a mature forest stays real-time at Time x8", async (run) => {
  // The grown-in world is the real worst case now — hundreds of stalks, a root
  // network, and a support flood-fill running most ticks.
  const r = await run(({ s }) => {
    s.genesis(); s.setPaused(true);
    s.setEl(s.SEED); s.setBrush(4);
    for (let x = 30; x <= 140; x += 6) for (let y = 74; y <= 84; y += 4) s.paint(x, y);
    s.run(60 * 900); // grow it in
    const c = s.count();
    const t0 = performance.now();
    s.run(480);      // one second of Time x8
    const ms = performance.now() - t0;
    return { ms, green: c[s.PLANT] + c[s.FLOWER], roots: c[s.ROOT] };
  });
  assert(r.ms < 1000, "480 ticks of a grown-in world computes in under a second",
    `${r.ms.toFixed(0)} ms with ${r.green} green and ${r.roots} root cells`);
});

check("performance: heavy world stays real-time at Time x8", async (run) => {
  const r = await run(({ s }) => {
    s.genesis();
    // a fussy world: arches over gaps, water, fire, growth
    for (let x = 20; x < 140; x += 12) {
      s.fill(x, 70, x, 88, s.BRICK);
      s.fill(x, 69, x + 10, 69, s.TIMBER);
    }
    s.fill(30, 40, 130, 50, s.WATER);
    for (let x = 25; x < 135; x += 5) s.fill(x, 68, x, 68, s.PLANT);
    s.run(200); // let it churn
    const t0 = performance.now();
    s.run(480); // one second of Time x8
    const ms = performance.now() - t0;
    return { ms, built: s.count()[s.BRICK] + s.count()[s.TIMBER] };
  });
  assert(r.ms < 1000, "480 ticks (1s at Time x8) computes in under a second", `${r.ms.toFixed(0)} ms for ${r.built} built cells`);
});

// ---------------------------------------------------------------- runner
const server = createServer((req, res) => {
  const file = join(BUILD, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

await page.goto(`${base}/test-build.html`, { waitUntil: "load" });
await page.evaluate(() => window.__sediment.setPaused(true)); // we drive step() ourselves

const run = (fn) => page.evaluate(fn, {}).catch((e) => { throw e; });
const runWith = (fn) => page.evaluate(new Function("__a", `const s=window.__sediment; return (${fn.toString()})({s});`));

let failed = 0;
for (const c of checks) {
  if (only.length && !only.some((o) => c.name.includes(o))) continue;
  results.length = 0;
  try {
    await c.fn(runWith);
  } catch (e) {
    results.push({ ok: false, label: "threw: " + e.message });
  }
  const bad = results.filter((r) => !r.ok).length;
  failed += bad;
  console.log(`${bad ? "FAIL" : "ok  "}  ${c.name}`);
  for (const r of results) {
    console.log(`      ${r.ok ? "·" : "✗"} ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
  }
}

if (consoleErrors.length) {
  failed += consoleErrors.length;
  console.log("\nconsole errors:");
  consoleErrors.forEach((e) => console.log("  ✗ " + e));
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} assertion(s) failed` : "\nall assertions passed");
process.exit(failed ? 1 : 0);
