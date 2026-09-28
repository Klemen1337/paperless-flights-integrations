// Minimal standalone host for the Flights Overhead integration.
// No dependencies: serves the manifest, render page and assets, and runs
// api/data.js at /api/data. Put it behind HTTPS and install
// https://<your-host>/config.json in the paperlesspaper app.
//
//   PORT=3000 node server.mjs

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dataHandler from "./api/data.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
// Only these top-level paths are public; data/, api/ and scripts/ stay private.
const PUBLIC = [/^\/config\.json$/, /^\/render\.html$/, /^\/assets\/[\w./-]+$/, /^\/languages\/[\w-]+\.json$/, /^\/screenshots\/[\w.-]+\.png$/];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  try {
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (url.pathname === "/api/data") {
      const body = JSON.stringify(await dataHandler({ query: Object.fromEntries(url.searchParams), request: req }));
      res.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" }).end(body);
      return;
    }
    const pathname = url.pathname === "/" ? "/render.html" : url.pathname;
    if (!PUBLIC.some((re) => re.test(pathname)) || pathname.includes("..")) {
      res.writeHead(404).end("Not found");
      return;
    }
    const file = path.join(root, pathname);
    const content = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": pathname.startsWith("/assets/fonts/") ? "public, max-age=604800" : "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    res.writeHead(missing ? 404 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: missing ? "Not found" : "Server error" }));
    if (!missing) console.error(error);
  }
});

server.listen(port, () => console.log(`Flights Overhead on http://localhost:${port}/ (manifest: /config.json)`));
