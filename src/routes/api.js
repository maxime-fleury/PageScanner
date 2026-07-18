import { Router } from "express";
import { unlinkSync } from "fs";
import { join, basename } from "path";
import {
  listDomains,
  countDomains,
  getDomainById,
  getDomainByDomain,
  deleteDomain,
  addBlacklistKeyword,
  removeBlacklistKeyword,
  listBlacklist,
  getBlacklistKeywords,
  getStats,
  getStatusCounts,
  listDomains as listAllDomains,
  updateBlacklistOnly,
  getDomainScreenshotPath,
  resetAll,
  exportDomains,
  SCREENSHOTS_DIR,
} from "../db.js";
import { startMonitor, stopMonitor, getStatus } from "../ct-monitor.js";
import { queueScreenshot, getScreenshotterStatus, startScreenshotter, stopScreenshotter, setThreads, closeBrowser } from "../screenshotter.js";
import { checkBlacklist, invalidateBlacklistCache } from "../blacklist.js";

const router = Router();

const MAX_LIMIT = 200;

function clampLimit(val) {
  return Math.min(Math.max(parseInt(val) || 50, 1), MAX_LIMIT);
}

// Crawler control
router.post("/crawler/start", (req, res) => {
  const result = startMonitor(req.app.get("io"));
  res.json(result);
});

router.post("/crawler/stop", (req, res) => {
  const result = stopMonitor();
  res.json(result);
});

router.get("/crawler/status", (req, res) => {
  res.json(getStatus());
});

// Screenshotter control
router.get("/screenshotter/status", (req, res) => {
  res.json(getScreenshotterStatus());
});

router.post("/screenshotter/start", (req, res) => {
  res.json(startScreenshotter());
});

router.post("/screenshotter/stop", (req, res) => {
  res.json(stopScreenshotter());
});

router.post("/screenshotter/threads", (req, res) => {
  const { threads } = req.body;
  if (!threads || threads < 1 || threads > 16) return res.status(400).json({ error: "threads must be 1-16" });
  res.json(setThreads(threads));
});

// Domains
router.get("/domains", (req, res) => {
  if (req.query.domain) {
    const domain = getDomainByDomain(req.query.domain);
    return res.json({ domains: domain ? [domain] : [], total: domain ? 1 : 0, limit: 1, offset: 0 });
  }
  const limit = clampLimit(req.query.limit);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);
  const filter = req.query.filter || null;
  const domains = listDomains(limit, offset, filter);
  const total = countDomains(filter);
  res.json({ domains, total, limit, offset });
});

router.get("/domains/:id", (req, res) => {
  const domain = getDomainById(parseInt(req.params.id));
  if (!domain) return res.status(404).json({ error: "Domain not found" });
  res.json(domain);
});

router.delete("/domains/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const domain = getDomainScreenshotPath(id);
  if (domain?.screenshot_path) {
    const base = basename(domain.screenshot_path);
    try { unlinkSync(join(SCREENSHOTS_DIR, base)); } catch {}
    try { unlinkSync(join(SCREENSHOTS_DIR, base.replace(/\.\w+$/, ".html"))); } catch {}
  }
  const result = deleteDomain(id);
  res.json({ deleted: result.changes > 0 });
});

router.post("/domains/:id/screenshot", async (req, res) => {
  const domain = getDomainById(parseInt(req.params.id));
  if (!domain) return res.status(404).json({ error: "Domain not found" });

  const io = req.app.get("io");
  queueScreenshot(domain, io);
  res.json({ queued: true });
});

router.post("/domains/:id/recheck", (req, res) => {
  const domain = getDomainById(parseInt(req.params.id));
  if (!domain) return res.status(404).json({ error: "Domain not found" });

  const text = (domain.page_title || "") + " " + (domain.page_content || "");
  const { blacklisted, reason } = checkBlacklist(text);

  updateBlacklistOnly(domain.id, blacklisted, reason);

  res.json({ blacklisted, reason });
});

// Blacklist
router.get("/blacklist", (req, res) => {
  res.json(listBlacklist());
});

router.post("/blacklist", (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: "Keyword required" });

  addBlacklistKeyword(keyword);
  invalidateBlacklistCache();
  res.json({ added: true });
});

router.delete("/blacklist/:id", (req, res) => {
  const result = removeBlacklistKeyword(parseInt(req.params.id));
  invalidateBlacklistCache();
  res.json({ deleted: result.changes > 0 });
});

router.post("/blacklist/recheck-all", async (req, res) => {
  let rechecked = 0;
  let offset = 0;

  while (true) {
    const domains = listAllDomains(500, offset);
    if (domains.length === 0) break;

    for (const domain of domains) {
      const text = (domain.page_title || "") + " " + (domain.page_content || "");
      const { blacklisted, reason } = checkBlacklist(text);

      if (blacklisted !== !!domain.blacklisted) {
        updateBlacklistOnly(domain.id, blacklisted, reason);
        rechecked++;
      }
    }

    offset += domains.length;
    await new Promise((r) => setImmediate(r));
  }

  res.json({ rechecked });
});

// Export
router.get("/domains/export/csv", (req, res) => {
  const domains = exportDomains();
  const header = "id,domain,source,page_title,status,blacklisted,blacklist_reason,discovered_at,screenshot_at";
  const rows = domains.map((d) =>
    [
      d.id,
      `"${(d.domain || "").replace(/"/g, '""')}"`,
      `"${(d.source || "").replace(/"/g, '""')}"`,
      `"${(d.page_title || "").replace(/"/g, '""')}"`,
      d.status,
      d.blacklisted,
      `"${(d.blacklist_reason || "").replace(/"/g, '""')}"`,
      d.discovered_at,
      d.screenshot_at || "",
    ].join(",")
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=pagescanner_export.csv");
  res.send("\uFEFF" + header + "\n" + rows.join("\n"));
});

// Stats
router.get("/stats", (req, res) => {
  res.json(getStats());
});

router.get("/status-counts", (req, res) => {
  res.json(getStatusCounts());
});

// Reset
router.post("/reset", async (req, res) => {
  stopMonitor();
  stopScreenshotter();
  await closeBrowser();
  resetAll();
  res.json({ reset: true });
});

export default router;
