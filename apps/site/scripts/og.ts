/**
 * Draws the site's share image, `public/og.png` (1200 × 630), from the shared pixel art and the site's
 * fonts, so a link to hobbots.app says what Hobbots does before anyone clicks it.
 * Run `pnpm --filter @hobbots/site og` after changing the art or the words below. It renders the card
 * in Playwright's Chromium (`pnpm exec playwright install chromium` once, if it is missing).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHIEF, CHIEF_PALETTE } from "@hobbots/art/chief";
import { hobLook } from "@hobbots/art/look";
import { MOON, MOON_PALETTE } from "@hobbots/art/moon";
import { type PixelPalette, type PixelRows, pixelPaths } from "@hobbots/art/pixels";
import { chromium } from "@playwright/test";
import { CREW, STAGE_STARS } from "../src/data/scene.ts";

const OG_SIZE = { width: 1200, height: 630 } as const;

/** The words on the card. Keep them in step with `SHARE` and `HERO` in src/data/copy.ts. */
const OG_COPY = {
  badges: ["Free", "Open source", "Open beta"],
  /** The title, one line each; the words between asterisks are lit in Lantern. */
  title: ["A team of AI agents", "that plan and *work*", "*together* for you."],
  lede: "On the Claude or ChatGPT plan you already pay for.",
  more: "Hand them a goal. They split it up, do the work and ask you only when it matters.",
  quest: "Aldric’s Quest",
  goal: "Launch the new product",
  site: "hobbots.app",
  platforms: "Mac · Linux",
} as const;

/** What each of the lead's helpers is doing in the scene, in CREW order after Aldric. */
const LANES = [
  { task: "Writing the copy", state: "done" },
  { task: "Checking the dates", state: "busy" },
  { task: "Building the page", state: "busy" },
] as const;

const svg = (rows: PixelRows, palette: PixelPalette, width: number, className = "") => {
  const cells = Math.max(...rows.map((row) => row.length));
  const height = (width * rows.length) / cells;
  const paths = [...pixelPaths(rows, palette)].map(([fill, d]) => `<path d="${d}" fill="${fill}"/>`).join("");
  return `<svg class="${className}" viewBox="0 0 ${cells} ${rows.length}" width="${width}" height="${height}" shape-rendering="crispEdges">${paths}</svg>`;
};

const font = (pkg: string, file: string) => {
  const require = createRequire(import.meta.url);
  const path = join(require.resolve(`${pkg}/package.json`), "..", "files", file);
  return `data:font/woff2;base64,${readFileSync(path).toString("base64")}`;
};

/** The card as one self-contained HTML page. */
const ogHtml = () => {
  const helpers = CREW.slice(1, 1 + LANES.length);
  const lanes = helpers
    .map((hob, i) => {
      const look = hobLook(hob.seed, hob.color);
      const lane = LANES[i];
      return `<li class="lane"><span class="face">${svg(look.rows, look.palette, 40)}</span><span><b>${hob.name}</b><i>${lane?.task}</i></span><span class="tick ${lane?.state}">${lane?.state === "done" ? "✓" : ""}</span></li>`;
    })
    .join("");
  const team = CREW.slice(0, 1 + LANES.length)
    .map((hob, i) => {
      if (i === 0) return svg(CHIEF, CHIEF_PALETTE, 104);
      const look = hobLook(hob.seed, hob.color);
      return svg(look.rows, look.palette, 70);
    })
    .join("");
  // Only the stars over the scene, so none sits behind the words.
  const stars = STAGE_STARS.filter((star) => star.x > 56)
    .map((star) => `<span class="star" style="left:${star.x}%;top:${star.y * 1.6}%"></span>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Pixelify;src:url(${font("@fontsource-variable/pixelify-sans", "pixelify-sans-latin-wght-normal.woff2")}) format("woff2");font-weight:400 700}
@font-face{font-family:Atkinson;src:url(${font("@fontsource-variable/atkinson-hyperlegible-next", "atkinson-hyperlegible-next-latin-wght-normal.woff2")}) format("woff2");font-weight:200 800}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${OG_SIZE.width}px;height:${OG_SIZE.height}px;overflow:hidden;position:relative;font-family:Atkinson;color:#ece8ff;
 background:radial-gradient(circle at 78% 30%,#2a2560 0,#1b1835 38%,#141228 70%)}
.cut{clip-path:polygon(6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px),0 6px)}
.star{position:absolute;width:4px;height:4px;background:#cfc8ff;opacity:.55}
.moon{position:absolute;right:56px;top:40px}
.ground{position:absolute;left:0;right:0;bottom:0;height:86px;background:#0d0c1c;border-top:4px solid #2c2a5a}
.copy{position:absolute;left:64px;top:44px;width:640px}
.badges{display:flex;gap:10px;margin-bottom:26px}
.badge{font:600 22px Pixelify;letter-spacing:.02em;padding:7px 14px 8px;background:#25224a;color:#7fd1b9}
.badge:first-child{background:#f2a541;color:#141228}
h1{font:700 58px/1.08 Pixelify;letter-spacing:-.005em;color:#ece8ff}
h1 em{font-style:normal;color:#f2a541}
.lede{margin-top:22px;font-size:30px;line-height:1.3;font-weight:600;color:#dcd7f2;width:540px}
.more{margin-top:16px;font-size:22px;line-height:1.35;font-weight:500;color:#a9a2e0;width:540px}
.lede b{color:#ffc477;font-weight:700}
.brand{position:absolute;left:64px;bottom:20px;display:flex;align-items:center;gap:14px;font:700 34px Pixelify;color:#ece8ff}
.brand small{font:600 22px Atkinson;color:#a9a2e0;margin-left:10px}
.scene{position:absolute;right:56px;top:96px;width:440px}
.team{position:absolute;right:64px;bottom:82px;width:428px;display:flex;align-items:flex-end;justify-content:space-between}
.quest{background:#1f1c3e;border:0;padding:20px 22px 18px;box-shadow:inset 0 0 0 3px #3a3666}
.label{font:600 18px Pixelify;color:#a9a2e0;display:flex;align-items:center;gap:8px}
.label:before{content:"";width:10px;height:10px;background:#7fd1b9}
.goal{font:700 28px Pixelify;margin:6px 0 14px;color:#ece8ff}
.lanes{list-style:none;display:grid;gap:10px}
.lane{display:grid;grid-template-columns:48px 1fr 30px;align-items:center;gap:12px;background:#141228;padding:8px 12px}
.face{display:flex;justify-content:center}
.lane b{display:block;font:700 20px Pixelify;color:#ece8ff}
.lane i{display:block;font:600 19px Atkinson;font-style:normal;color:#c9c3e8}
.tick{width:26px;height:26px;border:3px solid #3a3666;display:grid;place-items:center;font:700 18px Atkinson;color:#141228}
.tick.done{background:#7fd1b9;border-color:#7fd1b9}
.tick.busy{border-color:#f2a541}
.tick.busy:after{content:"";width:8px;height:8px;background:#f2a541}
</style></head><body>
${stars}
${svg(MOON, MOON_PALETTE, 54, "moon")}
<div class="ground"></div>
<div class="copy">
 <div class="badges">${OG_COPY.badges.map((b) => `<span class="badge cut">${b}</span>`).join("")}</div>
 <h1>${OG_COPY.title.map((line) => line.replace(/\*(.+?)\*/g, "<em>$1</em>")).join("<br>")}</h1>
 <p class="lede">${OG_COPY.lede.replace("Claude or ChatGPT", "<b>Claude or ChatGPT</b>")}</p>
 <p class="more">${OG_COPY.more}</p>
</div>
<div class="scene">
 <div class="quest cut"><p class="label">${OG_COPY.quest}</p><p class="goal">${OG_COPY.goal}</p><ul class="lanes">${lanes}</ul></div>
</div>
<div class="team">${team}</div>
<div class="brand">${svg(CHIEF, CHIEF_PALETTE, 40)}${OG_COPY.site}<small>${OG_COPY.platforms}</small></div>
</body></html>`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: OG_SIZE, deviceScaleFactor: 1 });
  await page.setContent(ogHtml());
  await page.evaluate(() => document.fonts.ready);
  writeFileSync(join(import.meta.dirname, "../public/og.png"), await page.screenshot({ type: "png" }));
  await browser.close();
}
