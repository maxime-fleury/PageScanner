import { X509Certificate } from "crypto";
import { addDomain, getDomainsByDomains } from "./db.js";
import { queueScreenshot } from "./screenshotter.js";

let pollInterval = null;
let running = false;
let ioRef = null;
let totalFound = 0;
let checkpoints = {};
let polling = false;

const CT_LOGS = [
  { name: "Google Argon2026h2", url: "https://ct.googleapis.com/logs/us1/argon2026h2/" },
  { name: "Google Argon2027h1", url: "https://ct.googleapis.com/logs/us1/argon2027h1/" },
  { name: "Google Xenon2026h2", url: "https://ct.googleapis.com/logs/eu1/xenon2026h2/" },
  { name: "DigiCert Wyvern2026h2", url: "https://wyvern.ct.digicert.com/2026h2/" },
];

function extractDomainsFromX509(certDER) {
  const domains = new Set();
  try {
    const cert = new X509Certificate(certDER);
    const san = cert.subjectAltName;
    if (san) {
      for (const name of san.split(",")) {
        const d = name.trim().replace(/^DNS:/, "").toLowerCase();
        if (d && !d.startsWith("*") && d.includes(".")) {
          domains.add(d);
        }
      }
    }
    const cn = cert.subject?.match(/CN\s*=\s*([^\s,/]+)/i)?.[1];
    if (cn && !cn.startsWith("*") && cn.includes(".")) {
      domains.add(cn.toLowerCase());
    }
  } catch (e) {}
  return [...domains];
}

function extractDomainsFromPrecert(tbsDER) {
  const domains = new Set();
  try {
    const str = tbsDER.toString("utf8");
    const dnsRegex = /DNS:([a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)/g;
    let match;
    while ((match = dnsRegex.exec(str)) !== null) {
      const d = match[1].toLowerCase();
      if (d && !d.startsWith("*") && d.includes(".") && !d.includes("\\")) {
        domains.add(d);
      }
    }
  } catch (e) {}
  return [...domains];
}

function parseEntries(entries) {
  const allDomains = [];
  for (const e of entries) {
    const buf = Buffer.from(e.leaf_input, "base64");
    if (buf.length < 12) continue;

    const entryType = buf.readUInt16BE(10);
    let offset = 12;
    let domains = [];

    if (entryType === 0) {
      if (buf.length < 15) continue;
      const certLen = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
      offset += 3;
      const certDER = buf.slice(offset, offset + certLen);
      domains = extractDomainsFromX509(certDER);
    } else if (entryType === 1) {
      if (buf.length < 44) continue;
      offset += 32; // skip issuer_key_hash
      if (offset + 3 > buf.length) continue;
      const tbsLen =
        (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2];
      offset += 3;
      const tbsDER = buf.slice(offset, offset + tbsLen);
      domains = extractDomainsFromPrecert(tbsDER);
    }

    for (const d of domains) {
      allDomains.push(d);
    }
  }

  const unique = [...new Set(allDomains)];
  const existing = getDomainsByDomains(unique);
  const existingSet = new Set(existing);
  return unique.filter((d) => !existingSet.has(d));
}

async function pollLog(log) {
  try {
    const sthUrl = `${log.url}ct/v1/get-sth`;
    const sthResp = await fetch(sthUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "PageScanner/1.0" },
    });
    if (!sthResp.ok) {
      console.error(`[CT] ${log.name}: get-sth failed: ${sthResp.status}`);
      return;
    }
    const sth = await sthResp.json();
    const treeSize = sth.tree_size;

    const lastSeen = checkpoints[log.url];
    const start = lastSeen !== undefined ? lastSeen : Math.max(0, treeSize - 100);
    const end = treeSize - 1;

    if (start >= end) return;

    const batchSize = Math.min(end - start + 1, 128);
    const entriesUrl = `${log.url}ct/v1/get-entries?start=${start}&end=${start + batchSize - 1}`;

    const entriesResp = await fetch(entriesUrl, {
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": "PageScanner/1.0" },
    });
    if (!entriesResp.ok) {
      console.error(`[CT] ${log.name}: get-entries failed: ${entriesResp.status}`);
      return;
    }
    const data = await entriesResp.json();

    const domains = parseEntries(data.entries);
    let newCount = 0;

    for (const domain of domains) {
      const newDomain = addDomain(domain, log.name);
      if (newDomain) {
        totalFound++;
        newCount++;
        if (ioRef) {
          ioRef.emit("domain:new", {
            id: newDomain.id,
            domain: newDomain.domain,
            source: newDomain.source,
            discovered_at: newDomain.discovered_at,
          });
        }
        queueScreenshot(newDomain, ioRef);
      }
    }

    // Update checkpoint only AFTER successful processing
    checkpoints[log.url] = start + batchSize;

    if (newCount > 0) {
      console.log(`[CT] ${log.name}: +${newCount} domains (tree: ${treeSize})`);
    }
  } catch (err) {
    console.error(`[CT] ${log.name} error:`, err.message);
  }
}

async function pollAllLogs() {
  if (polling) return;
  polling = true;
  try {
    const promises = CT_LOGS.map((log) => pollLog(log));
    await Promise.allSettled(promises);
  } finally {
    polling = false;
  }
}

export function startMonitor(io) {
  if (running) return { started: false, message: "Already running" };

  running = true;
  ioRef = io;
  totalFound = 0;
  checkpoints = {};

  console.log("[CT] Starting CT log polling across", CT_LOGS.length, "logs...");
  pollAllLogs();
  pollInterval = setInterval(pollAllLogs, 60 * 1000);

  return { started: true };
}

export function stopMonitor() {
  if (!running) return { stopped: false, message: "Not running" };

  running = false;

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  return { stopped: true };
}

export function getStatus() {
  return {
    running,
    logsMonitoring: running ? CT_LOGS.length : 0,
    crtshPolling: false,
    totalFound,
  };
}
