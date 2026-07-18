async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

function escHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

async function loadKeywords() {
  try {
    const keywords = await fetchJSON("/api/blacklist");
    const container = document.getElementById("keywords-list");
    const noKeywords = document.getElementById("no-keywords");

    if (keywords.length === 0) {
      container.innerHTML = "";
      noKeywords.style.display = "block";
      return;
    }

    noKeywords.style.display = "none";
    container.innerHTML = keywords.map(k => `
      <div class="keyword-tag">
        <span>${escHtml(k.keyword)}</span>
        <button onclick="removeKeyword(${k.id})" title="Remove">&times;</button>
      </div>
    `).join("");
  } catch (e) {
    console.error("Failed to load keywords:", e);
  }
}

async function loadBlacklistedDomains() {
  try {
    const data = await fetchJSON("/api/domains?limit=100&filter=blacklisted");
    const container = document.getElementById("blacklisted-domains");
    const noBlacklisted = document.getElementById("no-blacklisted");

    if (data.domains.length === 0) {
      container.innerHTML = "";
      noBlacklisted.style.display = "block";
      return;
    }

    noBlacklisted.style.display = "none";
    container.innerHTML = data.domains.map(d => `
      <div class="list-group-item d-flex justify-content-between align-items-center">
        <div class="d-flex align-items-center gap-3">
          ${d.screenshot_path
            ? `<img src="${d.screenshot_path}" style="width:60px;height:40px;object-fit:cover;border-radius:4px;">`
            : `<div style="width:60px;height:40px;background:var(--bg-card, #16102e);border-radius:4px;" class="d-flex align-items-center justify-content-center">
                <i class="bi bi-image text-muted small"></i>
              </div>`
          }
          <div>
            <div class="domain-text">${escHtml(d.domain)}</div>
            <small class="text-muted">Reason: ${escHtml(d.blacklist_reason || "unknown")}</small>
          </div>
        </div>
        <div class="d-flex gap-2">
          <a href="https://${d.domain}" target="_blank" class="btn btn-sm btn-outline-info">
            <i class="bi bi-box-arrow-up-right"></i>
          </a>
          <button onclick="removeBlacklistFromDomain(${d.id})" class="btn btn-sm btn-outline-success" title="Un-blacklist">
            <i class="bi bi-shield-check"></i>
          </button>
        </div>
      </div>
    `).join("");
  } catch (e) {
    console.error("Failed to load blacklisted domains:", e);
  }
}

async function addKeyword(e) {
  e.preventDefault();
  const input = document.getElementById("keyword-input");
  const keyword = input.value.trim();
  if (!keyword) return;

  await fetchJSON("/api/blacklist", {
    method: "POST",
    body: JSON.stringify({ keyword }),
  });

  input.value = "";
  loadKeywords();
  recheckAll();
}

async function removeKeyword(id) {
  await fetchJSON(`/api/blacklist/${id}`, { method: "DELETE" });
  loadKeywords();
}

async function removeBlacklistFromDomain(id) {
  await fetchJSON(`/api/domains/${id}/recheck`, { method: "POST" });
  loadBlacklistedDomains();
}

async function recheckAll() {
  const btn = document.getElementById("btn-recheck");
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1 spin"></i>Checking...';

  await fetchJSON("/api/blacklist/recheck-all", { method: "POST" });

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Re-check All';
  loadBlacklistedDomains();
}

// Event listeners
document.getElementById("add-keyword-form").addEventListener("submit", addKeyword);
document.getElementById("btn-recheck").addEventListener("click", recheckAll);

// Init
loadKeywords();
loadBlacklistedDomains();
