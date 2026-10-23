#!/usr/bin/env node
// Dependency-free static server (keeps npx/npm caches off C:). Usage: node tools/serve.mjs <port> <dir>
import { createServer } from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, extname, normalize, resolve } from "node:path";

const port = Number(process.argv[2] || 4821);
const root = resolve(process.argv[3] || ".");
const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".webm": "video/webm",
};

createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(root, urlPath));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end("forbidden"); }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!urlPath.endsWith("/")) { res.writeHead(301, { Location: urlPath + "/" }); return res.end(); }
      file = join(file, "index.html");
    }
    if (!existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 " + urlPath); }
    res.writeHead(200, { "Content-Type": types[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
