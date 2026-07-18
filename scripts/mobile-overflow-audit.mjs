/**
 * Mobile overflow audit — visits every primary hash route at a phone viewport
 * and reports elements that extend past the layout viewport without a scrollport.
 *
 * Usage: node scripts/mobile-overflow-audit.mjs [baseUrl]
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:4827";
const VIEWPORT = { width: 390, height: 844 };
const OUT_DIR = path.join(process.cwd(), "tmp/mobile-audit");

const ROUTES = [
  "#/home",
  "#/tasks",
  "#/connectors",
  "#/skills",
  "#/workflows",
  "#/maintenance",
  "#/settings",
  "#/settings?section=agents",
  "#/settings?section=monitoring",
  "#/settings?section=projects",
  "#/settings?section=workspace",
  "#/settings?section=connectors",
  "#/settings?section=skills",
  "#/settings?section=workflows",
  "#/settings?section=maintenance",
  "#/settings?section=appearance",
  "#/settings?section=about"
];

async function collectOverflow(page) {
  return page.evaluate(() => {
    const docRight = document.documentElement.clientWidth;
    const hits = [];
    const seen = new Set();

    function scrollportX(el) {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const s = getComputedStyle(p);
        const ox = s.overflowX;
        if (ox === "auto" || ox === "scroll") return true;
        if (
          p.classList?.contains("wf-canvas-viewport") ||
          p.classList?.contains("wf-canvas-wrap") ||
          p.classList?.contains("connector-map-scroll")
        ) {
          return true;
        }
        p = p.parentElement;
      }
      return false;
    }

    for (const el of document.querySelectorAll("body *")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.right <= docRight + 1) continue;
      if (scrollportX(el)) continue;

      const key = `${el.tagName}.${String(el.className).slice(0, 60)}|${Math.round(rect.right)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || "").slice(0, 120),
        text: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80),
        right: Math.round(rect.right),
        overflowPx: Math.round(rect.right - docRight)
      });
    }

    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = document.documentElement.clientWidth;
    return {
      pageScrollOverflow: scrollWidth > clientWidth + 1,
      scrollWidth,
      clientWidth,
      hits: hits.sort((a, b) => b.overflowPx - a.overflowPx).slice(0, 25)
    };
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  const report = [];

  for (const hash of ROUTES) {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
    await page.waitForTimeout(900);

    const provider = page.locator("[data-provider-id]").first();
    if (await provider.count()) {
      await provider.click({ timeout: 2000 }).catch(() => null);
      await page.waitForTimeout(350);
    }

    const result = await collectOverflow(page);
    const shot = path.join(OUT_DIR, `${hash.replace(/[/#?=]/g, "_") || "root"}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    report.push({ hash, ...result, screenshot: shot });
    const mark = result.pageScrollOverflow || result.hits.length ? "FAIL" : "ok";
    console.log(`${mark.padEnd(4)} ${hash.padEnd(40)} hits=${result.hits.length}`);
    if (result.hits[0]) {
      console.log(`     .${result.hits[0].className} +${result.hits[0].overflowPx}px`);
    }
  }

  const outFile = path.join(OUT_DIR, "report.json");
  await writeFile(outFile, JSON.stringify({ viewport: VIEWPORT, base: BASE, report }, null, 2));
  await browser.close();
  const failing = report.filter((r) => r.pageScrollOverflow || r.hits.length > 0);
  console.log(`\nWrote ${outFile}`);
  console.log(`Failing routes: ${failing.length}/${report.length}`);
  process.exit(failing.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
