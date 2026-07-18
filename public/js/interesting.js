const PAGE_SIZE = 25;

let csvData = [];
let excludeTags = JSON.parse(localStorage.getItem("int_tags") || "[]");
let apiKey = localStorage.getItem("int_apikey") || "";
let models = [];
let pricingMap = {};
let currentPage = 0;
let sessionSpend = parseFloat(localStorage.getItem("int_spend") || "0");

// ── Helpers ──
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function formatCost(cents) {
  if (cents == null || isNaN(cents)) return "$0.00";
  if (cents < 0.01) return "<$0.01";
  return "$" + cents.toFixed(4).replace(/\.?0+$/, "");
}

function formatCredit(n) {
  if (n == null) return "—";
  return "$" + Number(n).toFixed(4).replace(/\.?0+$/, "");
}

function formatPricePerToken(p) {
  if (p == null) return "?";
  if (p === 0) return "free";
  const per1k = p * 1000;
  if (per1k < 0.001) return "<$0.001/K";
  return "$" + per1k.toFixed(4).replace(/\.?0+$/, "") + "/K";
}

// ── CSV Parsing ──
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { result.push(current); current = ""; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

// ── Data loading ──
async function loadFromDatabase() {
  try {
    const res = await fetch("/api/domains/export/csv");
    const text = await res.text();
    csvData = parseCSV(text);
    const total = csvData.length;
    csvData = csvData.filter((r) => r.status !== "pending");
    const skipped = total - csvData.length;
    onDataLoaded();
    if (skipped > 0) {
      document.getElementById("analyze-info").textContent = `${csvData.length} rows (${skipped} pending skipped)`;
    }
  } catch (e) {
    setStatus("Failed to load from database: " + e.message, "danger");
  }
}

function loadFromFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    csvData = parseCSV(e.target.result);
    onDataLoaded();
  };
  reader.onerror = () => setStatus("Failed to read file", "danger");
  reader.readAsText(file);
}

function clearData() {
  csvData = [];
  currentPage = 0;
  document.getElementById("preview-card").style.display = "none";
  document.getElementById("data-summary").style.display = "none";
  document.getElementById("btn-clear-data").disabled = true;
  document.getElementById("btn-analyze").disabled = true;
  document.getElementById("analyze-info").textContent = "Load data to begin";
  document.getElementById("results-area").style.display = "none";
}

function onDataLoaded() {
  document.getElementById("btn-clear-data").disabled = false;
  document.getElementById("data-summary").style.display = "block";
  document.getElementById("preview-card").style.display = "block";
  enableAnalyze();
  currentPage = 0;
  renderPreview();
}

// ── Filtering ──
function getExcludedIndices() {
  if (!excludeTags.length) return new Set();
  const tags = excludeTags.map((t) => t.toLowerCase());
  const excluded = new Set();
  csvData.forEach((row, idx) => {
    const haystack = ((row.domain || "") + " " + (row.page_title || "")).toLowerCase();
    if (tags.some((tag) => haystack.includes(tag))) excluded.add(idx);
  });
  return excluded;
}

function getFilteredData() {
  const excluded = getExcludedIndices();
  return csvData.filter((_, idx) => !excluded.has(idx));
}

function updateSummary() {
  const excluded = getExcludedIndices();
  const after = csvData.length - excluded.size;
  document.getElementById("summary-loaded").textContent = csvData.length;
  document.getElementById("summary-after").textContent = after;
  document.getElementById("summary-excluded").textContent = excluded.size;
}

// ── Preview Table ──
function renderPreview() {
  const excluded = getExcludedIndices();
  const totalPages = Math.max(1, Math.ceil(csvData.length / PAGE_SIZE));
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  const start = currentPage * PAGE_SIZE;
  const pageRows = csvData.slice(start, start + PAGE_SIZE);

  const tbody = document.getElementById("preview-tbody");
  const empty = document.getElementById("preview-empty");
  const pagination = document.getElementById("preview-pagination");

  if (!csvData.length) {
    tbody.innerHTML = "";
    empty.style.display = "block";
    pagination.style.display = "none";
    updateSummary();
    return;
  }

  empty.style.display = "none";
  tbody.innerHTML = pageRows
    .map((row, i) => {
      const absIdx = start + i;
      const isExcluded = excluded.has(absIdx);
      return `<tr class="${isExcluded ? 'excluded' : ''}">
        <td class="domain-cell" title="${escHtml(row.domain || '')}">${escHtml(row.domain || '')}</td>
        <td class="title-cell" title="${escHtml(row.page_title || '')}">${escHtml((row.page_title || '').slice(0, 80))}</td>
        <td><span class="badge ${row.status === 'screenshot' ? 'bg-success' : row.status === 'pending' ? 'bg-warning text-dark' : 'bg-secondary'}">${escHtml(row.status || '')}</span></td>
        <td class="text-muted small">${escHtml((row.source || '').split(' ')[0])}</td>
        <td>${row.blacklisted === '1' ? '<span class="badge bg-danger">BL</span>' : '<span class="text-dim small">—</span>'}</td>
      </tr>`;
    })
    .join("");

  if (csvData.length > PAGE_SIZE) {
    pagination.style.display = "flex";
    document.getElementById("page-info").textContent = `Page ${currentPage + 1} of ${totalPages} (${csvData.length} rows)`;
    document.getElementById("btn-prev-page").disabled = currentPage === 0;
    document.getElementById("btn-next-page").disabled = currentPage >= totalPages - 1;
  } else {
    pagination.style.display = "none";
  }

  updateSummary();
}

// ── Tags ──
function renderTags() {
  const container = document.getElementById("tags-list");
  const noTags = document.getElementById("no-tags");
  if (!excludeTags.length) {
    container.innerHTML = "";
    noTags.style.display = "block";
    renderPreview();
    return;
  }
  noTags.style.display = "none";
  container.innerHTML = excludeTags
    .map(
      (tag, i) =>
        `<div class="keyword-tag">
          <span>${escHtml(tag)}</span>
          <button onclick="removeTag(${i})" title="Remove">&times;</button>
        </div>`
    )
    .join("");
  renderPreview();
}

function addTag(e) {
  e.preventDefault();
  const input = document.getElementById("tag-input");
  const tag = input.value.trim().toLowerCase();
  if (!tag || excludeTags.includes(tag)) return;
  excludeTags.push(tag);
  localStorage.setItem("int_tags", JSON.stringify(excludeTags));
  input.value = "";
  renderTags();
}

function removeTag(idx) {
  excludeTags.splice(idx, 1);
  localStorage.setItem("int_tags", JSON.stringify(excludeTags));
  renderTags();
}

// ── OpenRouter ──
async function fetchModels() {
  const btn = document.getElementById("btn-fetch-models");
  const select = document.getElementById("model-select");
  const status = document.getElementById("api-status");

  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1 spin"></i>Loading...';
  select.disabled = true;
  status.textContent = "Fetching models...";
  status.className = "small text-muted";

  try {
    const data = await fetchJSON(`/api/openrouter/models?key=${encodeURIComponent(apiKey)}`);
    models = (data.models || []).sort((a, b) => {
      const pa = a.pricing?.prompt ?? Infinity;
      const pb = b.pricing?.prompt ?? Infinity;
      return pa - pb;
    });
    pricingMap = {};
    select.innerHTML = models.map((m) => {
      pricingMap[m.id] = m.pricing;
      const price = m.pricing ? formatPricePerToken(m.pricing.prompt) : "?";
      return `<option value="${escHtml(m.id)}">${escHtml(m.name)} — ${price}</option>`;
    }).join("");
    select.disabled = false;
    status.textContent = `${models.length} models loaded`;
    status.className = "small text-success";
    btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Refresh';
    btn.disabled = false;
    updatePricing();
    enableAnalyze();
    fetchCredits();
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.className = "small text-danger";
    btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Retry';
    btn.disabled = false;
  }
}

async function fetchCredits() {
  const display = document.getElementById("credits-display");
  const el = document.getElementById("credits-remaining");
  try {
    const data = await fetchJSON(`/api/openrouter/credits?key=${encodeURIComponent(apiKey)}`);
    if (data.credits != null) {
      el.textContent = formatCredit(data.credits) + " remaining";
      display.style.display = "block";
    }
  } catch (e) {
    // silently fail — credits are non-critical
  }
}

function updatePricing() {
  const modelId = document.getElementById("model-select").value;
  const display = document.getElementById("pricing-display");
  const promptEl = document.getElementById("pricing-prompt");
  const completionEl = document.getElementById("pricing-completion");

  if (!modelId || !pricingMap[modelId]) {
    display.style.display = "none";
    return;
  }

  const p = pricingMap[modelId];
  promptEl.textContent = "Prompt: " + formatPricePerToken(p?.prompt);
  completionEl.textContent = "Completion: " + formatPricePerToken(p?.completion);
  display.style.display = "block";
}

function saveApiKey() {
  const input = document.getElementById("api-key-input");
  apiKey = input.value.trim();
  localStorage.setItem("int_apikey", apiKey);
  document.getElementById("btn-fetch-models").disabled = !apiKey;
  if (!apiKey) {
    document.getElementById("model-select").disabled = true;
    document.getElementById("model-select").innerHTML = '<option value="">— enter API key first —</option>';
    models = [];
    pricingMap = {};
    document.getElementById("api-status").textContent = "";
    document.getElementById("pricing-display").style.display = "none";
    document.getElementById("credits-display").style.display = "none";
  }
  enableAnalyze();
}

function enableAnalyze() {
  const hasKey = !!apiKey;
  const hasModels = models.length > 0;
  const hasModel = document.getElementById("model-select").value;
  const hasData = csvData.length > 0;
  const ready = hasKey && hasModels && hasModel && hasData;
  document.getElementById("btn-analyze").disabled = !ready;
  document.getElementById("btn-suggest-exclusions").disabled = !ready;
  const info = document.getElementById("analyze-info");
  if (!hasKey) info.textContent = "Enter API key and load models";
  else if (!hasModels) info.textContent = "Click 'Load Models' to fetch available models";
  else if (!hasModel) info.textContent = "Select a model";
  else if (!hasData) info.textContent = "Load data to begin";
  else info.textContent = `${getFilteredData().length} rows ready`;
}

function updateSessionSpend() {
  const display = document.getElementById("session-spend");
  const el = document.getElementById("session-cost");
  if (sessionSpend > 0) {
    el.textContent = formatCost(sessionSpend);
    display.style.display = "block";
  } else {
    display.style.display = "none";
  }
}

// ── AI Analysis ──
async function analyze() {
  const model = document.getElementById("model-select").value;
  const filtered = getFilteredData();
  if (!filtered.length) return;

  const btn = document.getElementById("btn-analyze");
  const spinner = document.getElementById("analyze-spinner");
  const resultsArea = document.getElementById("results-area");
  const resultsContent = document.getElementById("results-content");
  const costDisplay = document.getElementById("analyze-cost");
  const costEl = document.getElementById("request-cost");

  btn.disabled = true;
  spinner.style.display = "block";
  resultsArea.style.display = "none";
  costDisplay.style.display = "none";
  document.getElementById("analyze-info").textContent = "Analyzing...";

  const domainList = filtered
    .map((r, i) => `${i + 1}. ${r.domain || ""}${r.page_title ? " — " + r.page_title : ""}`)
    .join("\n");

  const systemPrompt = `You are a security researcher analyzing Certificate Transparency log data. You will receive a list of domains discovered in CT logs.

Your task: identify the MOST INTERESTING domains from a security research perspective. Look for:
- Potential phishing or lookalike domains (typosquatting, brand impersonation)
- Exposed internal/admin services (cPanel, webmail, VPN, RDP, etc.)
- Suspicious or unusual domain names
- Sites that appear to be test/staging environments exposed to the internet
- Services with login pages that could be interesting targets
- Unusual technology stacks or frameworks visible in page titles
- Sites that seem out of place or particularly notable
- Potential malware, scam, or gambling sites
- Any domain that tells an interesting story

For each finding, explain WHY it's interesting (1-2 sentences max).
Format your response as a markdown list with the domain name in bold. Start directly with the findings, no preamble. If nothing is interesting, say "Nothing notable found."`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Here are ${filtered.length} domains from CT log discovery:\n\n${domainList}` },
  ];

  try {
    const data = await fetchJSON("/api/openrouter/chat", {
      method: "POST",
      body: JSON.stringify({ apiKey, model, messages }),
    });

    const text = data.choices?.[0]?.message?.content || "No response";
    resultsContent.textContent = text;
    resultsArea.style.display = "block";
    document.getElementById("analyze-info").textContent = "Analysis complete";

    // Calculate cost from usage
    const usage = data.usage;
    if (usage && pricingMap[model]) {
      const p = pricingMap[model];
      const cost = (usage.prompt_tokens * p.prompt) + (usage.completion_tokens * p.completion);
      costEl.textContent = formatCost(cost) + ` (${usage.prompt_tokens} prompt · ${usage.completion_tokens} completion · ${usage.total_tokens} total)`;
      costDisplay.style.display = "block";

      // Track session spend
      sessionSpend += cost;
      localStorage.setItem("int_spend", String(sessionSpend));
      updateSessionSpend();
      fetchCredits();
    }
  } catch (e) {
    resultsContent.textContent = "Error: " + e.message;
    resultsArea.style.display = "block";
    document.getElementById("analyze-info").textContent = "Analysis failed";
  }

  spinner.style.display = "none";
  btn.disabled = false;
}

function copyResults() {
  const text = document.getElementById("results-content").textContent;
  navigator.clipboard.writeText(text).catch(() => {});
}

function resetSessionSpend() {
  sessionSpend = 0;
  localStorage.setItem("int_spend", "0");
  updateSessionSpend();
}

// ── Suggest Exclusions ──
async function suggestExclusions() {
  const model = document.getElementById("model-select").value;
  if (!csvData.length) return;

  const btn = document.getElementById("btn-suggest-exclusions");
  const analyzeBtn = document.getElementById("btn-analyze");
  const spinner = document.getElementById("analyze-spinner");
  const info = document.getElementById("analyze-info");

  btn.disabled = true;
  analyzeBtn.disabled = true;
  spinner.style.display = "block";
  info.textContent = "AI is reviewing data to suggest exclusion tags...";

  const filtered = getFilteredData();
  const domainList = filtered
    .map((r, i) => `${i + 1}. ${r.domain || ""}${r.page_title ? " — " + r.page_title : ""}`)
    .join("\n");

  const systemPrompt = `You are analyzing a list of domains discovered in Certificate Transparency logs. Your task is to identify COMMON UNINTERESTING patterns that should be filtered out before further analysis.

Look for patterns that indicate:
- Default hosting placeholder pages ("Coming Soon", "Squarespace - Website Expired", "Hosted By", "Default page", etc.)
- Server software default pages (nginx, Apache, IIS, etc.)
- Common admin panels (cPanel, webmail, roundcube, etc.)
- Error pages (404, 502 Bad Gateway, 403 Forbidden, etc.)
- Parked domains or domains for sale (HugeDomains, Aftermarket, etc.)
- Generic "it works" or default setup pages
- Any other obviously uninteresting patterns

Return ONLY a list of single-word or short keyword tags that would filter these out. The tags should match words found in the page titles or domain names.

Format your response as:
##SUGGESTED TAGS##
tag1, tag2, tag3, ...

Example: coming soon, squarespace, cpanel, webmail, nginx, apache, 404, 502, parked, hugeDomains, it works, default, hosted by, for sale, redirecting, error, login

Only return the tag list. No explanation or preamble.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Here are ${csvData.length} domains. Suggest exclusion tags:\n\n${domainList}` },
  ];

  try {
    const data = await fetchJSON("/api/openrouter/chat", {
      method: "POST",
      body: JSON.stringify({ apiKey, model, messages }),
    });

    const text = data.choices?.[0]?.message?.content || "";

    // Parse tags from response
    const tagMatch = text.match(/##SUGGESTED TAGS##\s*([\s\S]+)/i);
    const tagStr = tagMatch ? tagMatch[1].trim() : text.trim();
    const suggested = tagStr
      .split(/[,;\n]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);

    // Add new tags that aren't already in the list
    let added = 0;
    for (const tag of suggested) {
      if (!excludeTags.includes(tag)) {
        excludeTags.push(tag);
        added++;
      }
    }
    localStorage.setItem("int_tags", JSON.stringify(excludeTags));
    renderTags();

    info.textContent = `${added} exclusion tags added (${excludeTags.length} total)`;
    info.className = "small text-success";

    // Track cost
    const usage = data.usage;
    if (usage && pricingMap[model]) {
      const p = pricingMap[model];
      const cost = (usage.prompt_tokens * p.prompt) + (usage.completion_tokens * p.completion);
      sessionSpend += cost;
      localStorage.setItem("int_spend", String(sessionSpend));
      updateSessionSpend();
      fetchCredits();
    }
  } catch (e) {
    info.textContent = "Failed to suggest exclusions: " + e.message;
    info.className = "small text-danger";
  }

  spinner.style.display = "none";
  btn.disabled = false;
  enableAnalyze();
}

// ── Init ──
function init() {
  if (apiKey) {
    document.getElementById("api-key-input").value = apiKey;
    document.getElementById("btn-fetch-models").disabled = false;
  }

  renderTags();
  updateSessionSpend();

  document.getElementById("api-key-input").addEventListener("input", saveApiKey);

  document.getElementById("btn-toggle-key-vis").addEventListener("click", () => {
    const input = document.getElementById("api-key-input");
    const icon = document.querySelector("#btn-toggle-key-vis i");
    if (input.type === "password") {
      input.type = "text";
      icon.className = "bi bi-eye-slash";
    } else {
      input.type = "password";
      icon.className = "bi bi-eye";
    }
  });

  document.getElementById("btn-fetch-models").addEventListener("click", fetchModels);
  document.getElementById("model-select").addEventListener("change", () => {
    updatePricing();
    enableAnalyze();
  });

  document.getElementById("add-tag-form").addEventListener("submit", addTag);
  document.getElementById("btn-load-db").addEventListener("click", loadFromDatabase);
  document.getElementById("csv-file-input").addEventListener("change", (e) => {
    if (e.target.files[0]) loadFromFile(e.target.files[0]);
  });
  document.getElementById("btn-clear-data").addEventListener("click", clearData);
  document.getElementById("btn-prev-page").addEventListener("click", () => { currentPage--; renderPreview(); });
  document.getElementById("btn-next-page").addEventListener("click", () => { currentPage++; renderPreview(); });
  document.getElementById("btn-analyze").addEventListener("click", analyze);
  document.getElementById("btn-suggest-exclusions").addEventListener("click", suggestExclusions);
  document.getElementById("btn-copy-results").addEventListener("click", copyResults);
  document.getElementById("btn-reset-session").addEventListener("click", resetSessionSpend);

  const style = document.createElement("style");
  style.textContent = ".spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  document.head.appendChild(style);
}

function setStatus(msg, type) {
  const el = document.getElementById("analyze-info");
  el.textContent = msg;
  el.className = "small text-" + (type || "muted");
}

document.addEventListener("DOMContentLoaded", init);
