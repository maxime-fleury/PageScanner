let currentPage = 0;
const PAGE_SIZE = 30;
let currentFilter = "";
let currentDomain = null;
let lightboxBootstrap = null;
let gridCols = 4;
let loading = false;
let noMoreData = false;

function colClass() {
  const map = { 2: "col-sm-6 col-md-6 col-lg-6", 3: "col-sm-6 col-md-4 col-lg-4", 4: "col-sm-6 col-md-4 col-lg-3", 5: "col-sm-4 col-md-3 col-lg-2", 6: "col-sm-4 col-md-2 col-lg-2" };
  return map[gridCols] || map[4];
}

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  return res.json();
}

function escHtml(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "Z");
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function buildApiUrl() {
  let url = `/api/domains?limit=${PAGE_SIZE}&offset=${currentPage * PAGE_SIZE}`;
  if (currentFilter === "screenshotted") url += "&filter=screenshotted";
  else if (currentFilter === "pending") url += "&filter=pending";
  else if (currentFilter === "blacklisted") url += "&filter=blacklisted";
  else if (currentFilter === "shown") url += "&filter=shown";
  return url;
}

function renderCard(d) {
  const col = document.createElement("div");
  col.className = colClass();

  const hasShot = d.screenshot_path && d.screenshot_path !== "";
  const imgHtml = hasShot
    ? `<img src="${d.screenshot_path}" alt="${escHtml(d.domain)}" loading="lazy">`
    : `<div class="d-flex align-items-center justify-content-center" style="height:200px;background:var(--bg-card, #16102e)">
        <i class="bi bi-hourglass-split text-muted fs-2"></i>
      </div>`;

  const blBadge = d.blacklisted ? '<span class="position-absolute top-0 end-0 badge bg-danger m-2" style="font-size:0.65rem"><i class="bi bi-shield-x"></i></span>' : '';

  col.innerHTML = `
    <div class="card gallery-card ${d.blacklisted ? 'blacklisted' : ''}" data-id="${d.id}">
      <div class="position-relative">
        ${imgHtml}
        ${blBadge}
      </div>
      <div class="card-body">
        <div class="domain-name text-truncate" title="${escHtml(d.domain)}">${escHtml(d.domain)}</div>
        <div class="d-flex justify-content-between align-items-center mt-1">
          <small class="text-muted">${timeAgo(d.discovered_at)}</small>
          <span class="badge bg-secondary" style="font-size:0.6rem">${escHtml(d.source)}</span>
        </div>
      </div>
    </div>`;

  col.querySelector(".gallery-card").addEventListener("click", () => openLightbox(d));
  return col;
}

async function loadGalleryPage() {
  if (loading || noMoreData) return;
  loading = true;

  const sentinel = document.getElementById("scroll-sentinel");
  sentinel.style.display = "block";

  try {
    const data = await fetchJSON(buildApiUrl());
    const grid = document.getElementById("gallery-grid");
    const noGallery = document.getElementById("no-gallery");

    if (data.domains.length === 0 && currentPage === 0) {
      noGallery.style.display = "block";
      sentinel.style.display = "none";
      loading = false;
      noMoreData = true;
      return;
    }

    noGallery.style.display = "none";

    for (const d of data.domains) {
      grid.appendChild(renderCard(d));
    }

    if (data.domains.length < PAGE_SIZE) {
      noMoreData = true;
      sentinel.style.display = "none";
    } else {
      currentPage++;
    }
  } catch (e) {
    console.error("Failed to load gallery:", e);
  }

  loading = false;
  if (noMoreData) sentinel.style.display = "none";
}

function resetGallery() {
  currentPage = 0;
  noMoreData = false;
  loading = false;
  document.getElementById("gallery-grid").innerHTML = "";
  loadGalleryPage();
}

function openLightbox(domain) {
  currentDomain = domain;

  document.getElementById("lb-domain").textContent = domain.domain;
  document.getElementById("lb-title").textContent = domain.page_title || "No title";
  document.getElementById("lb-meta").textContent =
    `Source: ${domain.source} | Found: ${timeAgo(domain.discovered_at)} | Status: ${domain.status}`;

  const badge = document.getElementById("lb-badge");
  if (domain.blacklisted) {
    badge.className = "badge bg-danger";
    badge.textContent = `Blacklisted: ${domain.blacklist_reason}`;
    document.getElementById("lb-toggle-bl").innerHTML =
      '<i class="bi bi-shield-check me-1"></i>Un-blacklist';
  } else {
    badge.className = "badge bg-success";
    badge.textContent = "Clean";
    document.getElementById("lb-toggle-bl").innerHTML =
      '<i class="bi bi-shield-slash me-1"></i>Blacklist';
  }

  const img = document.getElementById("lb-image");
  if (domain.screenshot_path) {
    img.src = domain.screenshot_path;
    img.style.display = "block";
  } else {
    img.src = "";
    img.style.display = "none";
  }

  document.getElementById("lb-visit").href = `https://${domain.domain}`;

  if (!lightboxBootstrap) {
    lightboxBootstrap = new bootstrap.Modal(document.getElementById("lightbox"));
  }
  lightboxBootstrap.show();
}

// IntersectionObserver for infinite scroll
const observer = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !loading && !noMoreData) {
    loadGalleryPage();
  }
}, { rootMargin: "200px" });

observer.observe(document.getElementById("scroll-sentinel"));

// Event listeners
document.getElementById("filter-select").addEventListener("change", (e) => {
  currentFilter = e.target.value;
  resetGallery();
});

document.getElementById("grid-size").addEventListener("change", (e) => {
  gridCols = parseInt(e.target.value);
  resetGallery();
});

document.getElementById("btn-refresh").addEventListener("click", () => {
  resetGallery();
});

document.getElementById("lb-toggle-bl").addEventListener("click", async () => {
  if (!currentDomain) return;

  if (currentDomain.blacklisted) {
    await fetchJSON(`/api/domains/${currentDomain.id}/recheck`, { method: "POST" });
  } else {
    await fetchJSON("/api/blacklist", {
      method: "POST",
      body: JSON.stringify({ keyword: currentDomain.domain }),
    });
    await fetchJSON(`/api/domains/${currentDomain.id}/recheck`, { method: "POST" });
  }

  lightboxBootstrap.hide();
  resetGallery();
});

// Check URL params for direct domain link
const params = new URLSearchParams(window.location.search);
const directDomain = params.get("domain");
if (directDomain) {
  (async () => {
    const data = await fetchJSON(`/api/domains?domain=${encodeURIComponent(directDomain)}`);
    if (data.domains.length > 0) openLightbox(data.domains[0]);
  })();
}

loadGalleryPage();
