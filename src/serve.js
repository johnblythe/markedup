const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { wrapHTML } = require("./wrap");
const { buildClientBundle, getStylesCSS } = require("./client-bundle");
const { writeExportBundle } = require("./export");
const { createAnnotationStore } = require("./annostore");
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
  // Multiplayer mode: annotations flow through the local annotations API
  // (shared JSON next to the source file) instead of each browser's
  // localStorage. The API itself is always mounted — it is the contract stub
  // other tooling (the Slack bridge) tests against — but the overlay only
  // uses it when the page was served with multiplayer on.
  const multiplayer = opts.multiplayer === true;

  // Two multiplayer processes on one file would interleave read-modify-write
  // cycles on the same annotations JSON and silently lose writes. Refuse the
  // second process (the registry is keyed by port, so check sourcePath).
  if (multiplayer) {
    const clash = registry
      .list()
      .find(
        (it) => it.multiplayer && it.sourcePath === sourcePath && it.pid !== process.pid,
      );
    if (clash) {
      throw new Error(
        `${sourceName} is already served in multiplayer mode by pid ${clash.pid} on port ${clash.port} — annotate there or stop it first`,
      );
    }
  }
  const projectSlug = sourceName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "artifact";
  const annoStore = createAnnotationStore(sourcePath);
  // Presence heartbeats, identity -> last-seen ISO. In-memory on purpose.
  const presenceViewers = new Map();

  // buildClientBundle()/getStylesCSS() re-stat client/* on every call and only
  // rebuild when something changed, so call them fresh per request below
  // rather than capturing a stale copy here at startup.
  const modernScreenshotPath = require.resolve("modern-screenshot/dist/index.js");
  const modernScreenshotSrc = fs.readFileSync(modernScreenshotPath);

  // Persona from the page URL: ?persona= is the primary name (the two-tab
  // sandbox), ?as= is the older alias. Prefer persona when both are present.
  function personaFrom(url) {
    const persona = url.searchParams.get("persona");
    if (persona && persona.trim()) return persona.trim().slice(0, 200);
    const as = url.searchParams.get("as");
    if (as && as.trim()) return as.trim().slice(0, 200);
    return null;
  }

  // Local identity: header wins (API calls carry the baked persona), then the
  // page URL's ?persona=/?as=, then a friendly default.
  function identityFor(req, url) {
    const header = req.headers["x-markup-user"];
    if (typeof header === "string" && header.trim()) return header.trim().slice(0, 200);
    return personaFrom(url) || "local@dev";
  }

  // Annotations API (contract stub). Accepts any {user}/{project} pair and
  // maps them all onto this instance's single store.
  async function handleAnnotationApi(req, res, url, pathname) {
    const me = identityFor(req, url);

    if (pathname === "/api/me" && req.method === "GET") {
      return sendJSON(res, 200, { email: me });
    }

    const m = pathname.match(
      /^\/api\/([^/]+)\/([^/]+)\/(annotations|shots|presence)(?:\/([^/]+))?(?:\/(replies))?$/,
    );
    if (!m) return null; // not an API path — fall through to static serving
    const [, user, project, section, item, repliesSeg] = m;

    // Presence heartbeat (in-memory; the stub restarts fresh, which is fine
    // for something that only says "who's looking right now").
    if (section === "presence" && !item) {
      if (req.method === "POST") presenceViewers.set(me, new Date().toISOString());
      if (req.method === "POST" || req.method === "GET") {
        const now = Date.now();
        const viewers = [];
        for (const [email, at] of presenceViewers) {
          if (now - Date.parse(at) > 24 * 60 * 60 * 1000) presenceViewers.delete(email);
          else viewers.push({ email, at });
        }
        return sendJSON(res, 200, { viewers });
      }
      return sendJSON(res, 404, { error: "not found" });
    }

    if (section === "annotations") {
      if (req.method === "GET" && !item) {
        const out = annoStore.list(req.headers["if-none-match"]);
        if (out.status === 304) {
          res.writeHead(304, { ETag: out.etag });
          return res.end();
        }
        if (out.status !== 200) return sendJSON(res, out.status, out.body);
        const body = JSON.stringify(out.body);
        res.writeHead(out.status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          ETag: out.etag,
          "Cache-Control": "no-store",
        });
        return res.end(body);
      }
      if (req.method === "PUT" && item && !repliesSeg) {
        let payload;
        try {
          payload = JSON.parse((await readBody(req, MAX_POST_BYTES)).toString("utf-8"));
        } catch (_e) {
          return sendJSON(res, 400, { error: "invalid JSON" });
        }
        const out = annoStore.put(item, payload, me);
        return sendJSON(res, out.status, out.body);
      }
      if (req.method === "DELETE" && item && !repliesSeg) {
        const out = annoStore.tombstone(item, me);
        return sendJSON(res, out.status, out.body);
      }
      if (req.method === "POST" && item && repliesSeg === "replies") {
        let payload;
        try {
          payload = JSON.parse((await readBody(req, MAX_POST_BYTES)).toString("utf-8"));
        } catch (_e) {
          return sendJSON(res, 400, { error: "invalid JSON" });
        }
        const out = annoStore.reply(item, payload, me);
        return sendJSON(res, out.status, out.body);
      }
      return sendJSON(res, 404, { error: "not found" });
    }

    // shots
    if (section === "shots" && item) {
      if (req.method === "PUT") {
        let buf;
        try {
          buf = await readBody(req, MAX_POST_BYTES);
        } catch (e) {
          return sendError(res, e.status || 400, e.message);
        }
        const out = annoStore.putShot(item, buf, user, project);
        return sendJSON(res, out.status, out.body);
      }
      if (req.method === "GET") {
        const shot = annoStore.getShot(item);
        if (!shot) return sendJSON(res, 404, { error: "not found" });
        return sendBuffer(res, 200, "image/png", shot);
      }
    }
    return sendJSON(res, 404, { error: "not found" });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      // Annotations API (multiplayer contract stub) — must dispatch before
      // the GET/HEAD method guard below since it speaks PUT/POST/DELETE.
      if (pathname === "/api/me" || pathname.startsWith("/api/")) {
        const handled = await handleAnnotationApi(req, res, url, pathname);
        if (handled !== null) return handled;
      }

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
          styles: getStylesCSS(),
          sourceHash,
          remote: multiplayer
            ? { user: "local", project: projectSlug, identity: personaFrom(url) || undefined }
            : undefined,
        });
        return sendBuffer(res, 200, "text/html; charset=utf-8", Buffer.from(wrapped, "utf-8"));
      }

      // GET /__markup/client.js
      if (pathname === "/__markup/client.js") {
        return sendBuffer(
          res,
          200,
          "application/javascript; charset=utf-8",
          Buffer.from(buildClientBundle(), "utf-8"),
        );
      }

      // GET /__markup/modern-screenshot.js
      if (pathname === "/__markup/modern-screenshot.js") {
        return sendBuffer(res, 200, "application/javascript; charset=utf-8", modernScreenshotSrc);
      }

      // GET /__markup/styles.css (alternate fetch path; styles are inlined too)
      if (pathname === "/__markup/styles.css") {
        return sendBuffer(res, 200, "text/css; charset=utf-8", Buffer.from(getStylesCSS(), "utf-8"));
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
          styles: getStylesCSS(),
          sourceHash,
          remote: multiplayer
            ? { user: "local", project: projectSlug, identity: personaFrom(url) || undefined }
            : undefined,
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
  registry.register({ port: actualPort, sourcePath, sourceName, kind: "serve", multiplayer });
  registry.installLifecycle(actualPort);
  server.once("close", () => registry.unregister(actualPort));

  // The pre-bind clash check above races: two processes can both pass it
  // before either registers, then interleave writes on one annotations JSON.
  // Re-check now that this instance is registered. Both racers see each
  // other here, and the later registrant (tie-broken by port) backs out.
  if (multiplayer) {
    const mine = registry.find(actualPort);
    const myStart = Date.parse((mine && mine.startedAt) || "") || 0;
    const winner = registry
      .list()
      .filter((it) => it.multiplayer && it.sourcePath === sourcePath && it.pid !== process.pid)
      .find((rival) => {
        const rivalStart = Date.parse(rival.startedAt || "") || 0;
        return rivalStart !== myStart ? rivalStart < myStart : rival.port < actualPort;
      });
    if (winner) {
      registry.unregister(actualPort);
      server.close();
      throw new Error(
        `${sourceName} is already served in multiplayer mode by pid ${winner.pid} on port ${winner.port} — annotate there or stop it first`,
      );
    }
  }

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
