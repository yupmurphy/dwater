// Static file server for local testing. Service workers and web push need a
// real origin, so opening index.html straight off the disk is not enough.
//
//   node tools/serve.mjs            serves the repository root on :4173
//   node tools/serve.mjs ../other   serves another directory

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(
  process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
);
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // normalize() collapses any ../ before we join, keeping the server inside ROOT.
  let file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));

  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      // Service workers are only allowed to control the scope they are served
      // from, which is the whole site here.
      "Service-Worker-Allowed": "/",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`dwater: serving ${ROOT} on http://localhost:${PORT}`);
});
