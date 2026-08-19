const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { wrapHTML } = require("./wrap");
const { buildClientBundle, getStylesCSS } = require("./client-bundle");
const { writeExportBundle } = require("./export");
const registry = require("./registry");
const { SERVE_PORT, RESERVED_PORTS, isReserved, listenWithFallback } = require("./ports");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const MAX_POST_BYTES = 50 * 1024 * 1024; // 50MB

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function sendError(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendBuffer(res, status, contentType, body) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Verify a resolved file path lives inside (or equals) the given root.
// Prevents `..` traversal escape.
function isInside(root, target) {
  const rel = path.relative(root, target);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let aborted = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        // Drain remaining data so we can respond cleanly with 413 instead of EPIPE.
        req.on("data", () => {});
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function startServer(filePath, opts = {}) {
  const sourcePath = path.resolve(filePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`file not found: ${sourcePath}`);
  }
  const sourceDir = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  const explicitPort = opts.port != null;
  const port = explicitPort ? opts.port : SERVE_PORT;
  // An artifact server must never squat the dashboard's port. Asking for it
  // outright is an error; walking into it during fallback just steps over it.
  if (explicitPort && isReserved(port) && !opts.allowReserved) {
    throw new Error(
      `port ${port} is reserved for the markup dashboard (\`markup dash\`) — pick another with --port`,
    );
  }
  const autoOpen = opts.autoOpen !== false;

  const clientBundle = buildClientBundle();
  const stylesCSS = getStylesCSS();
  const modernScreenshotPath = require.resolve("modern-screenshot/dist/index.js");
  const modernScreenshotSrc = fs.readFileSync(modernScreenshotPath);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      // POST /export
      if (req.method === "POST" && pathname === "/export") {
        let body;
        try {
          body = await readBody(req, MAX_POST_BYTES);
        } catch (err) {
          return sendError(res, err.status || 400, err.message);
        }
        let payload;
        try {
          payload = JSON.parse(body.toString("utf-8"));
        } catch (_e) {
          return sendError(res, 400, "invalid JSON");
        }
        try {
          const result = writeExportBundle(sourcePath, payload);
          return sendJSON(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJSON(res, 500, { ok: false, error: err.message });
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendError(res, 405, "method not allowed");
      }

      // GET / → wrapped source HTML
      if (pathname === "/" || pathname === `/${sourceName}`) {
        const raw = fs.readFileSync(sourcePath, "utf-8");
        const sourceHash = require("node:crypto").createHash("sha1").update(raw).digest("hex").slice(0, 16);
        const wrapped = wrapHTML(raw, {
          key: sourcePath,
          sourceName,
          styles: stylesCSS,
          sourceHash,
        });
        return sendBuffer(res, 200, "text/html; charset=utf-8", Buffer.from(wrapped, "utf-8"));
      }

      // GET /__markup/client.js
      if (pathname === "/__markup/client.js") {
        return sendBuffer(
          res,
          200,
          "application/javascript; charset=utf-8",
          Buffer.from(clientBundle, "utf-8"),
        );
      }

      // GET /__markup/modern-screenshot.js
      if (pathname === "/__markup/modern-screenshot.js") {
        return sendBuffer(res, 200, "application/javascript; charset=utf-8", modernScreenshotSrc);
      }

      // GET /__markup/styles.css (alternate fetch path; styles are inlined too)
      if (pathname === "/__markup/styles.css") {
        return sendBuffer(res, 200, "text/css; charset=utf-8", Buffer.from(stylesCSS, "utf-8"));
      }

      // Static serve from sourceDir for any other GET.
      // Path traversal guard: resolve and ensure the resolved path is inside sourceDir.
      const requested = path.normalize(pathname).replace(/^\/+/, "");
      const candidate = path.resolve(sourceDir, requested);
      if (!isInside(sourceDir, candidate)) {
        return sendError(res, 403, "forbidden");
      }
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
        return sendError(res, 404, "not found");
      }
      // If the request is for the source HTML by name, wrap it.
      if (path.resolve(candidate) === sourcePath) {
        const raw = fs.readFileSync(sourcePath, "utf-8");
        const sourceHash = require("node:crypto").createHash("sha1").update(raw).digest("hex").slice(0, 16);
        const wrapped = wrapHTML(raw, {
          key: sourcePath,
          sourceName,
          styles: stylesCSS,
          sourceHash,
        });
        return sendBuffer(res, 200, "text/html; charset=utf-8", Buffer.from(wrapped, "utf-8"));
      }
      const data = fs.readFileSync(candidate);
      return sendBuffer(res, 200, mimeFor(candidate), data);
    } catch (err) {
      sendError(res, 500, `internal error: ${err.message}`);
    }
  });

  await listenWithFallback(server, port, {
    fallback: opts.portFallback !== false,
    skip: opts.allowReserved ? undefined : RESERVED_PORTS,
  });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;

  // Advertise this instance for `markup list` / `markup dash`.
  registry.register({ port: actualPort, sourcePath, sourceName, kind: "serve" });
  registry.installLifecycle(actualPort);
  server.once("close", () => registry.unregister(actualPort));

  if (autoOpen) {
    try {
      const open = (await import("open")).default;
      await open(url);
    } catch (err) {
      // Non-fatal: log and continue.
      console.error(`markup: could not auto-open browser (${err.message})`);
    }
  }

  return { server, port: actualPort, url, sourcePath, sourceDir };
}

module.exports = { startServer };
