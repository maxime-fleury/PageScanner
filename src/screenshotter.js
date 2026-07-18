import puppeteer from "puppeteer-core";
import { join } from "path";
import { writeFileSync } from "fs";
import {
  updateScreenshot,
  markFailed,
  deleteDomainById,
  getPendingDomains,
  resetFailedDomains,
  SCREENSHOTS_DIR,
} from "./db.js";
import { checkBlacklist } from "./blacklist.js";

const CHROME_PATH =
  process.env.CHROME_PATH ||
  "C:/Users/Max/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe";

const BROWSER_COUNT = Math.min(
  Math.max(parseInt(process.env.BROWSER_COUNT) || 2, 1),
  8
);

const PAGES_PER_BROWSER = 6;

let browsers = [];
let pagePool = [];
let browserReady = false;
let ioRef = null;
const queue = [];
let processing = false;
let concurrent = 8;
let enabled = true;
const MAX_QUEUE = 500;

function safeFilename(domain) {
  return domain.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 200);
}

async function initBrowsers() {
  if (browserReady) return;
  for (let i = 0; i < BROWSER_COUNT; i++) {
    try {
      const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-sync",
          "--dns-prefetch-disable",
          "--disable-features=InterestFeedContentSuggestions,ChromeWhatsNewUI",
        ],
      });
      browsers.push(browser);
      console.log(`[SS] Browser ${i + 1}/${BROWSER_COUNT} launched`);
      for (let j = 0; j < PAGES_PER_BROWSER; j++) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
        page.setDefaultTimeout(5000);
        pagePool.push({ page, browser, busy: false });
      }
    } catch (err) {
      console.error(`[SS] Failed to launch browser ${i + 1}:`, err.message);
    }
  }
  if (browsers.length === 0) throw new Error("No browsers could be launched");
  concurrent = Math.min(concurrent, pagePool.length);
  browserReady = true;
  if (queue.length > 0) processQueue();
}

function acquirePage() {
  for (const entry of pagePool) {
    if (!entry.busy) {
      try { entry.browser.process(); } catch {
        continue;
      }
      entry.busy = true;
      return entry;
    }
  }
  return null;
}

function releasePage(entry) {
  entry.busy = false;
}

async function replacePage(entry) {
  try {
    const page = await entry.browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultTimeout(5000);
    entry.page = page;
    entry.busy = false;
  } catch {
    const bi = browsers.indexOf(entry.browser);
    if (bi !== -1) browsers.splice(bi, 1);
    pagePool.splice(pagePool.indexOf(entry), 1);
    console.log(`[SS] Removed dead browser, ${browsers.length} remaining`);
  }
}

async function screenshotDomain(domainObj) {
  const { id, domain } = domainObj;
  let pageEntry = null;

  try {
    pageEntry = acquirePage();
    if (!pageEntry) {
      markFailed(id);
      if (ioRef) ioRef.emit("screenshot:failed", { id, domain, error: "no page available" });
      return;
    }

    const page = pageEntry.page;
    const url = `https://${domain}`;
    let loaded = false;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 4000 });
      loaded = true;
    } catch {}
    if (!loaded) {
      try {
        await page.goto(`http://${domain}`, { waitUntil: "domcontentloaded", timeout: 2000 });
        loaded = true;
      } catch {}
    }

    if (!loaded) {
      deleteDomainById(id);
      if (ioRef) ioRef.emit("screenshot:failed", { id, domain, error: "unreachable" });
      return;
    }

    const title = await page.title().catch(() => "");
    const content = await page.evaluate(() =>
      document.body?.innerText?.slice(0, 5000) || ""
    ).catch(() => "");

    const { blacklisted, reason } = checkBlacklist(title + " " + content);

    const baseName = safeFilename(domain);
    const filename = `${baseName}.jpg`;
    const screenshotPath = join(SCREENSHOTS_DIR, filename);

    await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80 });

    const html = await page.content().catch(() => "");
    if (html) {
      writeFileSync(join(SCREENSHOTS_DIR, `${baseName}.html`), html);
    }

    updateScreenshot(id, `/screenshots/${filename}`, title, content, blacklisted, reason);

    console.log(`[SS] OK: ${domain} | title: "${title.slice(0, 50)}" | bl: ${blacklisted}`);
    if (ioRef) {
      ioRef.emit("screenshot:done", {
        id, domain,
        screenshotPath: `/screenshots/${filename}`,
        title, blacklisted, reason,
      });
    }
  } catch (err) {
    console.error(`[SS] Error ${domain}:`, err.message);
    markFailed(id);
    if (ioRef) ioRef.emit("screenshot:failed", { id, domain, error: err.message });
    if (pageEntry) replacePage(pageEntry);
    pageEntry = null;
  } finally {
    if (pageEntry) releasePage(pageEntry);
  }
}

async function processQueue() {
  if (processing) return;
  if (!browserReady) return;
  processing = true;

  while (true) {
    while (queue.length > 0 && enabled) {
      const batch = queue.splice(0, Math.min(concurrent, queue.length));
      await Promise.allSettled(batch.map((item) => screenshotDomain(item)));
    }

    if (enabled && queue.length === 0) {
      backfillPending();
    }

    processing = false;
    if (queue.length === 0 || !enabled) break;
    processing = true;
  }
}

export function queueScreenshot(domainObj, io) {
  ioRef = io;
  if (!enabled) return;
  if (queue.length >= MAX_QUEUE) {
    console.log(`[SS] Queue full (${MAX_QUEUE}), skipping ${domainObj.domain}`);
    return;
  }
  queue.push(domainObj);
  processQueue();
}

export function getScreenshotterStatus() {
  return {
    enabled, concurrent, queueLength: queue.length, processing,
    browsers: browsers.length,
    pages: pagePool.length,
    pagesBusy: pagePool.filter((p) => p.busy).length,
  };
}

export function startScreenshotter() {
  enabled = true;
  resetFailedDomains();
  initBrowsers().then(() => {
    backfillPending();
    if (!processing && queue.length > 0) processQueue();
  }).catch((err) => {
    console.error("[SS] Failed to initialize browsers:", err.message);
  });
  return { enabled: true };
}

function backfillPending() {
  const pending = getPendingDomains(500);
  let added = 0;
  for (const domain of pending) {
    if (queue.length >= MAX_QUEUE) break;
    if (!queue.some((d) => d.id === domain.id)) {
      queue.push(domain);
      added++;
    }
  }
  if (added > 0) {
    console.log(`[SS] Backfilled ${added} pending domains from DB`);
  }
}

export function stopScreenshotter() {
  enabled = false;
  return { enabled: false };
}

export function setThreads(n) {
  concurrent = Math.max(1, Math.min(pagePool.length, n));
  return { concurrent };
}

export async function closeBrowser() {
  for (const b of browsers) {
    try { await b.close(); } catch {}
  }
  browsers = [];
  pagePool = [];
  browserReady = false;
}
