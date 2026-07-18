import express from "express";
import { createServer } from "http";
import { join } from "path";
import apiRouter from "./routes/api.js";
import { setupWebSocket } from "./routes/ws.js";
import { closeBrowser } from "./screenshotter.js";

const app = express();
const server = createServer(app);
const io = setupWebSocket(server);

app.set("io", io);

app.use(express.json());
app.use(express.static(join(import.meta.dir, "..", "public")));
app.use("/screenshots", express.static(join(import.meta.dir, "..", "screenshots")));

app.use("/api", apiRouter);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  const pad = (s, len) => s.padEnd(len);
  const portStr = String(PORT);
  const w = 42;
  console.log(`
  ╔${"═".repeat(w)}╗
  ║${pad("       PageScanner - CT Log Discovery", w)}║
  ║${pad("", w)}║
  ║  Dashboard:  http://localhost:${portStr}${" ".repeat(Math.max(0, w - 32 - portStr.length))}║
  ║  Gallery:    http://localhost:${portStr}/gallery.html${" ".repeat(Math.max(0, w - 38 - portStr.length))}║
  ║  Blacklist:  http://localhost:${portStr}/blacklist.html${" ".repeat(Math.max(0, w - 39 - portStr.length))}║
  ║  Discoveries: http://localhost:${portStr}/interesting.html${" ".repeat(Math.max(0, w - 40 - portStr.length))}║
  ╚${"═".repeat(w)}╝
  `);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await closeBrowser();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
