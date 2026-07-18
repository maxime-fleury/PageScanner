const socket = io();

let chart = null;
let isRunning = false;
let ssRunning = false;
let refreshTimer = null;

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

function debounceRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    loadDomains();
    loadStats();
  }, 1000);
}

async function loadStatus() {
  try {
    const status = await fetchJSON("/api/crawler/status");
    const btn = document.getElementById("btn-toggle");
    const icon = document.getElementById("crawler-icon");
    const details = document.getElementById("status-details");

    isRunning = status.running;

    if (isRunning) {
      btn.className = "btn btn-danger btn-lg px-4 toggle-btn";
      btn.innerHTML = '<i class="bi bi-stop-fill me-1"></i>Stop';
      icon.className = "mb-2 text-success live-pulse";
      icon.innerHTML = '<i class="bi bi-radar fs-1"></i>';
      details.textContent = `${status.logsMonitoring || 0} CT logs | ${status.totalFound || 0} found`;
    } else {
      btn.className = "btn btn-outline-success btn-lg px-4 toggle-btn";
      btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Start';
      icon.className = "mb-2 text-secondary";
      icon.innerHTML = '<i class="bi bi-radar fs-1"></i>';
      details.textContent = "4 CT logs ready";
    }
  } catch (e) {
    console.error("Failed to load status:", e);
  }
}

async function loadScreenshotterStatus() {
  try {
    const ss = await fetchJSON("/api/screenshotter/status");
    const btn = document.getElementById("btn-ss-toggle");
    const icon = document.getElementById("ss-icon");
    const details = document.getElementById("ss-details");
    const threadsSelect = document.getElementById("ss-threads");

    ssRunning = ss.enabled;

    if (ss.enabled) {
      btn.className = "btn btn-danger btn-lg px-4 toggle-btn";
      btn.innerHTML = '<i class="bi bi-stop-fill me-1"></i>Stop';
      icon.className = "mb-2 text-info live-pulse";
      icon.innerHTML = '<i class="bi bi-camera fs-1"></i>';
    } else {
      btn.className = "btn btn-outline-info btn-lg px-4 toggle-btn";
      btn.innerHTML = '<i class="bi bi-play-fill me-1"></i>Start';
      icon.className = "mb-2 text-secondary";
      icon.innerHTML = '<i class="bi bi-camera fs-1"></i>';
    }

    details.textContent = `${ss.queueLength} in queue | ${ss.concurrent} threads | ${ss.browsers} browsers | ${ss.pagesBusy}/${ss.pages} pages`;
    threadsSelect.value = ss.concurrent;
  } catch (e) {
    console.error("Failed to load screenshotter status:", e);
  }
}

async function loadDomains() {
  try {
    const data = await fetchJSON("/api/domains?limit=30&offset=0");
    const tbody = document.getElementById("recent-domains");
    const noDomains = document.getElementById("no-domains");

    if (data.domains.length === 0) {
      tbody.innerHTML = "";
      noDomains.style.display = "block";
      return;
    }

    noDomains.style.display = "none";
    tbody.innerHTML = data.domains.map(d => `
      <tr>
        <td class="font-mono">${escHtml(d.domain)}</td>
        <td><span class="badge bg-secondary" style="font-size:0.7rem">${escHtml(d.source)}</span></td>
        <td>${statusBadge(d)}</td>
        <td class="text-muted small">${timeAgo(d.discovered_at)}</td>
        <td>
          <a href="/gallery.html?domain=${encodeURIComponent(d.domain)}" class="btn btn-sm btn-outline-secondary" title="View in gallery">
            <i class="bi bi-image"></i>
          </a>
          <button class="btn btn-sm btn-outline-secondary" onclick="reScreenshot(${d.id})" title="Re-screenshot">
            <i class="bi bi-camera"></i>
          </button>
        </td>
      </tr>
    `).join("");
  } catch (e) {
    console.error("Failed to load domains:", e);
  }
}

async function loadStats() {
  try {
    const counts = await fetchJSON("/api/status-counts");
    document.getElementById("stat-total").textContent = counts.total;
    document.getElementById("stat-screenshotted").textContent = counts.screenshotted;
    document.getElementById("stat-pending").textContent = counts.pending + counts.failed;
    document.getElementById("stat-blacklisted").textContent = counts.blacklisted;
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

async function loadChart() {
  try {
    const stats = await fetchJSON("/api/stats");
    const reversed = stats.reverse();
    const labels = reversed.map(s => s.hour.includes("T") ? s.hour.split("T")[1]?.slice(0,5) : s.hour.slice(-5));
    const found = reversed.map(s => s.domains_found);
    const screenshots = reversed.map(s => s.screenshots_taken);

    if (chart) chart.destroy();

    const ctx = document.getElementById("chart-discoveries").getContext("2d");
    chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Domains",
            data: found,
            borderColor: "#8b5cf6",
            backgroundColor: "rgba(139, 92, 246, 0.12)",
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
          {
            label: "Screenshots",
            data: screenshots,
            borderColor: "#06b6d4",
            backgroundColor: "rgba(6, 182, 212, 0.08)",
            fill: true,
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: "top",
            align: "end",
            labels: { color: "#6b6394", font: { size: 10 }, boxWidth: 12, padding: 8 },
          },
        },
        scales: {
          x: { grid: { color: "#2a1f5e" }, ticks: { color: "#6b6394", font: { size: 9 }, maxRotation: 0 } },
          y: { grid: { color: "#2a1f5e" }, ticks: { color: "#6b6394", font: { size: 9 } }, beginAtZero: true },
        },
        interaction: { intersect: false, mode: "index" },
      },
    });
  } catch (e) {
    console.error("Failed to load chart:", e);
  }
}

function statusBadge(d) {
  if (d.blacklisted) return '<span class="badge bg-danger" style="font-size:0.7rem">Blacklisted</span>';
  if (d.status === "screenshot") return '<span class="badge bg-success" style="font-size:0.7rem">Ready</span>';
  if (d.status === "pending") return '<span class="badge bg-warning text-dark" style="font-size:0.7rem">Pending</span>';
  if (d.status === "failed") return '<span class="badge bg-secondary" style="font-size:0.7rem">Failed</span>';
  return `<span class="badge bg-secondary" style="font-size:0.7rem">${escHtml(d.status)}</span>`;
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

async function reScreenshot(id) {
  await fetchJSON(`/api/domains/${id}/screenshot`, { method: "POST" });
}

async function refreshAll() {
  await Promise.all([loadStatus(), loadScreenshotterStatus(), loadDomains(), loadStats(), loadChart()]);
}

// Crawler toggle
document.getElementById("btn-toggle").addEventListener("click", async () => {
  if (isRunning) {
    await fetchJSON("/api/crawler/stop", { method: "POST" });
    document.getElementById("live-counter").style.display = "none";
  } else {
    await fetchJSON("/api/crawler/start", { method: "POST" });
    document.getElementById("live-counter").style.display = "inline";
  }
  refreshAll();
});

// Screenshotter toggle
document.getElementById("btn-ss-toggle").addEventListener("click", async () => {
  if (ssRunning) {
    await fetchJSON("/api/screenshotter/stop", { method: "POST" });
  } else {
    await fetchJSON("/api/screenshotter/start", { method: "POST" });
  }
  refreshAll();
});

// Thread count
document.getElementById("ss-threads").addEventListener("change", async (e) => {
  await fetchJSON("/api/screenshotter/threads", {
    method: "POST",
    body: JSON.stringify({ threads: parseInt(e.target.value) }),
  });
  loadScreenshotterStatus();
});

// WebSocket events — debounced
socket.on("domain:new", () => {
  document.getElementById("live-counter").style.display = "inline";
  debounceRefresh();
});

socket.on("screenshot:done", () => {
  debounceRefresh();
});

// Reset
document.getElementById("btn-reset").addEventListener("click", async () => {
  if (!confirm("Reset entire database? All domains, screenshots, and stats will be permanently deleted.")) return;
  await fetchJSON("/api/reset", { method: "POST" });
  refreshAll();
});

// Initial load
refreshAll();
setInterval(() => {
  loadStatus();
  loadScreenshotterStatus();
  loadChart();
}, 10000);
setInterval(() => {
  loadDomains();
  loadStats();
}, 5000);
