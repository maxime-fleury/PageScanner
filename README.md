# PageScanner

Real-time Certificate Transparency log monitoring and website screenshotting tool. Discovers newly-issued SSL/TLS certificates from CT logs, screenshots the domains, and classifies them against a configurable blacklist.

## Features

- **CT Log Monitoring** — Polls Google and DigiCert CT logs for newly issued certificates
- **Automated Screenshots** — Captures full-page screenshots using headless Chrome (2 browser instances, 12 page pool)
- **HTML Archive** — Saves raw HTML alongside each screenshot for offline analysis
- **Blacklist Filtering** — Configurable keyword-based filter to flag generic/uninteresting pages (login pages, default server pages, cPanel, etc.)
- **Real-time Dashboard** — Web UI with live discovery feed, screenshot gallery, stats, and blacklist management
- **CSV Export** — Download all scanned domains as CSV for external analysis

## Requirements

- [Bun](https://bun.sh) v1.3+
- Chrome/Chromium browser (for screenshots)

## Setup

```bash
git clone <repo-url>
cd pagescanner
bun install
```

Set the `CHROME_PATH` environment variable to your Chrome executable, or update the default path in `src/screenshotter.js`.

## Usage

```bash
# Start server (auto-reload on changes)
bun run dev

# Or start in production
bun start
```

Open http://localhost:3000 in your browser.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `CHROME_PATH` | *(internal)* | Path to Chrome/Chromium executable |
| `BROWSER_COUNT` | `2` | Number of headless Chrome instances |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/crawler/start` | Start CT log monitoring |
| `POST` | `/api/crawler/stop` | Stop CT log monitoring |
| `GET` | `/api/crawler/status` | Get crawler status |
| `POST` | `/api/screenshotter/start` | Start screenshot engine |
| `POST` | `/api/screenshotter/stop` | Stop screenshot engine |
| `GET` | `/api/screenshotter/status` | Get screenshotter status |
| `POST` | `/api/screenshotter/threads` | Set concurrency (1-16) |
| `GET` | `/api/domains` | List domains (pagination, filter) |
| `GET` | `/api/domains/export/csv` | Export all domains as CSV |
| `DELETE` | `/api/domains/:id` | Delete domain + files |
| `GET` | `/api/blacklist` | List blacklist keywords |
| `POST` | `/api/blacklist` | Add keyword |
| `GET` | `/api/stats` | Hourly discovery/screenshot stats |
| `GET` | `/api/status-counts` | Aggregate counts by status |
| `POST` | `/api/reset` | Wipe database and screenshots |

## Project Structure

```
pagescanner/
├── src/
│   ├── server.js          # Express + Socket.IO server
│   ├── db.js              # SQLite database layer (bun:sqlite)
│   ├── ct-monitor.js      # CT log poller
│   ├── screenshotter.js   # Headless Chrome screenshot engine
│   └── blacklist.js       # Keyword-based content classifier
├── public/
│   ├── index.html         # Dashboard
│   ├── gallery.html       # Screenshot gallery
│   ├── blacklist.html     # Blacklist management
│   ├── css/style.css      # Dark theme
│   └── js/                # Client-side JS
├── data/                  # SQLite database (gitignored)
├── screenshots/           # Screenshot images + HTML files (gitignored)
├── package.json
└── README.md
```
