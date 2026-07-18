import { Database } from "bun:sqlite";
import { join, basename } from "path";
import { mkdirSync, unlinkSync, readdirSync, rmSync } from "fs";

const DATA_DIR = join(import.meta.dir, "..", "data");
const SCREENSHOTS_DIR = join(import.meta.dir, "..", "screenshots");
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "scanner.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    source TEXT DEFAULT 'certstream',
    screenshot_path TEXT,
    page_title TEXT,
    page_content TEXT,
    status TEXT DEFAULT 'pending',
    blacklisted INTEGER DEFAULT 0,
    blacklist_reason TEXT,
    discovered_at TEXT DEFAULT (datetime('now')),
    screenshot_at TEXT
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hour TEXT NOT NULL,
    domains_found INTEGER DEFAULT 0,
    screenshots_taken INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_stats_hour ON stats(hour);
  CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);
  CREATE INDEX IF NOT EXISTS idx_domains_blacklisted ON domains(blacklisted);
  CREATE INDEX IF NOT EXISTS idx_domains_discovered ON domains(discovered_at);
`);

const DEFAULT_KEYWORDS = [
  "login", "sign in", "signin", "log in",
  "apache", "nginx", "cpanel", "plesk", "webmail",
  "default page", "it works", "apache2 ubuntu",
  "welcome to nginx", "powered by",
];

const seedBlacklist = db.prepare("INSERT OR IGNORE INTO blacklist (keyword) VALUES (?)");
for (const kw of DEFAULT_KEYWORDS) {
  seedBlacklist.run(kw);
}

const stmts = {
  insertDomain: db.prepare(
    "INSERT OR IGNORE INTO domains (domain, source) VALUES (?, ?)"
  ),
  getDomain: db.prepare("SELECT * FROM domains WHERE id = ?"),
  getDomainByDomain: db.prepare("SELECT * FROM domains WHERE domain = ?"),
  listDomains: db.prepare(
    "SELECT * FROM domains ORDER BY discovered_at DESC LIMIT ? OFFSET ?"
  ),
  listDomainsFiltered: db.prepare(
    "SELECT * FROM domains WHERE blacklisted = ? ORDER BY discovered_at DESC LIMIT ? OFFSET ?"
  ),
  listDomainsByStatus: db.prepare(
    "SELECT * FROM domains WHERE status = ? ORDER BY discovered_at DESC LIMIT ? OFFSET ?"
  ),
  countDomains: db.prepare("SELECT COUNT(*) as count FROM domains"),
  countDomainsFiltered: db.prepare(
    "SELECT COUNT(*) as count FROM domains WHERE blacklisted = ?"
  ),
  countDomainsByStatus: db.prepare(
    "SELECT COUNT(*) as count FROM domains WHERE status = ?"
  ),
  updateScreenshot: db.prepare(
    "UPDATE domains SET screenshot_path = ?, page_title = ?, page_content = ?, status = 'screenshot', blacklisted = ?, blacklist_reason = ?, screenshot_at = datetime('now') WHERE id = ?"
  ),
  updateBlacklistOnly: db.prepare(
    "UPDATE domains SET blacklisted = ?, blacklist_reason = ? WHERE id = ?"
  ),
  getDomainScreenshotPath: db.prepare("SELECT screenshot_path FROM domains WHERE id = ?"),
  markFailed: db.prepare(
    "UPDATE domains SET status = 'failed' WHERE id = ?"
  ),
  markPending: db.prepare(
    "UPDATE domains SET status = 'pending' WHERE id = ?"
  ),
  deleteDomain: db.prepare("DELETE FROM domains WHERE id = ?"),

  insertBlacklist: db.prepare(
    "INSERT OR IGNORE INTO blacklist (keyword) VALUES (?)"
  ),
  deleteBlacklist: db.prepare("DELETE FROM blacklist WHERE id = ?"),
  listBlacklist: db.prepare("SELECT * FROM blacklist ORDER BY id DESC"),
  pendingDomains: db.prepare(
    "SELECT * FROM domains WHERE status = 'pending' ORDER BY discovered_at ASC LIMIT ?"
  ),

  getDomainsToRecheck: db.prepare(
    "SELECT * FROM domains WHERE blacklisted = 1"
  ),

  upsertStats: db.prepare(`
    INSERT INTO stats (hour, domains_found, screenshots_taken)
    VALUES (?, 1, 0)
    ON CONFLICT(hour) DO UPDATE SET domains_found = domains_found + 1
  `),
  upsertStatsScreenshot: db.prepare(`
    INSERT INTO stats (hour, domains_found, screenshots_taken)
    VALUES (?, 0, 1)
    ON CONFLICT(hour) DO UPDATE SET screenshots_taken = screenshots_taken + 1
  `),
  getStats: db.prepare(
    "SELECT * FROM stats ORDER BY hour DESC LIMIT 24"
  ),
};

export function getDomainsByDomains(domains) {
  if (domains.length === 0) return [];
  const placeholders = domains.map(() => "?").join(",");
  const stmt = db.prepare(`SELECT domain FROM domains WHERE domain IN (${placeholders})`);
  return stmt.all(...domains).map((r) => r.domain);
}

export function addDomain(domain, source = "certstream") {
  const bare = domain.replace(/^www\./, "");
  const existing = getDomainByDomain(bare) || getDomainByDomain("www." + bare);
  if (existing) return null;

  const result = stmts.insertDomain.run(domain, source);
  if (result.changes > 0) {
    const hour = new Date().toISOString().slice(0, 13);
    stmts.upsertStats.run(hour);
    return getDomainByDomain(domain);
  }
  return null;
}

export function getDomainById(id) {
  return stmts.getDomain.get(id);
}

export function getDomainByDomain(domain) {
  return stmts.getDomainByDomain.get(domain);
}

export function listDomains(limit = 50, offset = 0, filter = null) {
  if (filter === "blacklisted") {
    return stmts.listDomainsFiltered.all(1, limit, offset);
  } else if (filter === "shown") {
    return stmts.listDomainsFiltered.all(0, limit, offset);
  } else if (filter === "screenshotted") {
    return stmts.listDomainsByStatus.all("screenshot", limit, offset);
  } else if (filter === "pending") {
    return stmts.listDomainsByStatus.all("pending", limit, offset);
  }
  return stmts.listDomains.all(limit, offset);
}

export function countDomains(filter = null) {
  if (filter === "blacklisted") {
    return stmts.countDomainsFiltered.get(1).count;
  } else if (filter === "shown") {
    return stmts.countDomainsFiltered.get(0).count;
  } else if (filter === "screenshotted") {
    return stmts.countDomainsByStatus.get("screenshot").count;
  } else if (filter === "pending") {
    return stmts.countDomainsByStatus.get("pending").count;
  }
  return stmts.countDomains.get().count;
}

export function updateScreenshot(
  id,
  screenshotPath,
  pageTitle,
  pageContent,
  blacklisted,
  blacklistReason
) {
  stmts.updateScreenshot.run(
    screenshotPath,
    pageTitle,
    pageContent || null,
    blacklisted ? 1 : 0,
    blacklistReason || null,
    id
  );
  const hour = new Date().toISOString().slice(0, 13);
  stmts.upsertStatsScreenshot.run(hour);
}

export function updateBlacklistOnly(id, blacklisted, reason) {
  stmts.updateBlacklistOnly.run(blacklisted ? 1 : 0, reason || null, id);
}

export function markFailed(id) {
  stmts.markFailed.run(id);
}

export function markPending(id) {
  stmts.markPending.run(id);
}

export function deleteDomain(id) {
  const domain = stmts.getDomainScreenshotPath.get(id);
  return stmts.deleteDomain.run(id);
}

export function deleteDomainById(id) {
  const domain = stmts.getDomainScreenshotPath.get(id);
  if (domain?.screenshot_path) {
    const base = basename(domain.screenshot_path);
    try { unlinkSync(join(SCREENSHOTS_DIR, base)); } catch {}
    try { unlinkSync(join(SCREENSHOTS_DIR, base.replace(/\.\w+$/, ".html"))); } catch {}
  }
  return stmts.deleteDomain.run(id);
}

export function getDomainScreenshotPath(id) {
  return stmts.getDomainScreenshotPath.get(id);
}

export function addBlacklistKeyword(keyword) {
  return stmts.insertBlacklist.run(keyword.toLowerCase().trim());
}

export function removeBlacklistKeyword(id) {
  return stmts.deleteBlacklist.run(id);
}

export function listBlacklist() {
  return stmts.listBlacklist.all();
}

export function getBlacklistKeywords() {
  return stmts.listBlacklist.all().map((r) => r.keyword);
}

export function getPendingDomains(limit = 500) {
  return stmts.pendingDomains.all(limit);
}

const resetFailed = db.prepare("UPDATE domains SET status = 'pending' WHERE status = 'failed'");
export function resetFailedDomains() {
  resetFailed.run();
}

export function resetAll() {
  db.exec("DELETE FROM domains");
  db.exec("DELETE FROM stats");
  db.exec("DELETE FROM blacklist");
  for (const kw of DEFAULT_KEYWORDS) {
    seedBlacklist.run(kw);
  }
  try {
    for (const f of readdirSync(SCREENSHOTS_DIR)) {
      rmSync(join(SCREENSHOTS_DIR, f));
    }
  } catch {}
}

export function getStats() {
  return stmts.getStats.all();
}

export function getStatusCounts() {
  const total = stmts.countDomains.get().count;
  const screenshotted = stmts.countDomainsByStatus.get("screenshot").count;
  const pending = stmts.countDomainsByStatus.get("pending").count;
  const failed = stmts.countDomainsByStatus.get("failed").count;
  const blacklisted = stmts.countDomainsFiltered.get(1).count;
  return { total, screenshotted, pending, failed, blacklisted };
}

export function exportDomains() {
  return db.prepare(
    "SELECT id, domain, source, page_title, status, blacklisted, blacklist_reason, discovered_at, screenshot_at FROM domains ORDER BY discovered_at DESC"
  ).all();
}

export { db, SCREENSHOTS_DIR };
