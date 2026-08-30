// Dashboard server. Lists running `markup serve` instances with links.
// `markup dash` starts this on the reserved dashboard port (see src/ports.js)
// and opens a browser. Binding here is deliberately strict: no silent walk to
// a neighbouring port, because a dashboard that is not at the URL you
// bookmarked is worse than a clear error. Reuse and contention handling live
// in the `dash` command in bin/markup.js.

const http = require("node:http");
const registry = require("./registry");
const { DASH_PORT, listenWithFallback } = require("./ports");

const DASH_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>markedup dashboard</title>
<style>
  :root {
    --accent: #d35400;
    --bg: #faf8f3;
    --card: #fff;
    --text: #222;
    --muted: #777;
    --border: #ddd;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 28px 28px 60px 28px;
    max-width: 1200px;
    margin-left: auto;
    margin-right: auto;
  }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0; }
  .sub { color: var(--muted); font-size: 13px; margin: 0; }
  .empty {
    background: var(--card);
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 48px;
    text-align: center;
    color: var(--muted);
  }
  .empty code {
    background: #f0eee8;
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 4 / 3;
    background: #f0eee8;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .thumb iframe {
    /* Render at large logical viewport, then scale down to fit card.
       transform-origin top-left keeps the top-left aligned. */
    width: 1280px;
    height: 960px;
    border: 0;
    transform: scale(0.234);
    transform-origin: top left;
    pointer-events: none;
    background: #fff;
  }
  .thumb .cover {
    position: absolute;
    inset: 0;
    background: transparent;
    cursor: pointer;
  }
  .thumb .fallback {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
    padding: 16px;
  }
  .card.fallback-on .thumb iframe { display: none; }
  .card.fallback-on .thumb .fallback { display: flex; }
  .body { padding: 12px 14px 14px 14px; }
  .row1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }
  .port {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--accent);
    font-weight: 600;
  }
  .name {
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--muted);
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions { margin-top: 10px; display: flex; gap: 8px; }
  .open-btn, .copy-btn, .stop-btn {
    text-decoration: none;
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border);
    background: #f5f5f5;
    color: var(--text);
    font-family: inherit;
  }
  .open-btn {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .open-btn:hover { filter: brightness(0.92); }
  .copy-btn:hover { background: #eaeaea; }
  .stop-btn {
    color: #fff;
    background: #c0392b;
    border-color: #c0392b;
  }
  .stop-btn:hover { filter: brightness(0.92); }
  .stop-btn:disabled {
    opacity: 0.7;
    cursor: default;
    filter: none;
  }
  .footer {
    margin-top: 28px;
    text-align: center;
    color: var(--muted);
    font-size: 11px;
  }
</style>
</head>
<body>
<header>
  <h1>Markup Dashboard</h1>
  <p class="sub" id="sub">auto-refresh every 5s</p>
</header>
<div id="list"><div class="empty">loading...</div></div>
<p class="footer">to start more: <code>markup serve &lt;path&gt; --port &lt;n&gt;</code></p>
<script>
(function () {
  var lastKey = "";

  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    return d.toLocaleString([], {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function fmtAge(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return "from the future";
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.floor(hours / 24);
    return days + "d ago";
  }

  function stopInstance(port) {
    return fetch("/api/stop?port=" + encodeURIComponent(String(port)), {
      method: "POST",
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: "invalid server response" };
      }).then(function (body) {
        if (!r.ok || !body || !body.ok) {
          throw new Error((body && body.error) || ("status " + r.status));
        }
        return body;
      });
    });
  }

  function buildCard(it) {
    var card = document.createElement("div");
    card.className = "card";
    card.setAttribute("data-port", String(it.port));

    var thumb = document.createElement("div");
    thumb.className = "thumb";

    var iframe = document.createElement("iframe");
    iframe.src = "http://localhost:" + it.port + "/";
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("loading", "lazy");
    // If iframe fails (CSP frame-ancestors, network), flip to fallback.
    iframe.addEventListener("error", function () { card.classList.add("fallback-on"); });
    thumb.appendChild(iframe);

    var fallback = document.createElement("div");
    fallback.className = "fallback";
    fallback.textContent = "preview unavailable (open to view)";
    thumb.appendChild(fallback);

    var cover = document.createElement("a");
    cover.className = "cover";
    cover.href = "http://localhost:" + it.port + "/";
    cover.target = "_blank";
    cover.rel = "noopener";
    cover.title = "Open " + it.sourceName;
    thumb.appendChild(cover);

    card.appendChild(thumb);

    var body = document.createElement("div");
    body.className = "body";

    var row1 = document.createElement("div");
    row1.className = "row1";
    var name = document.createElement("div");
    name.className = "name";
    name.textContent = it.sourceName;
    name.title = it.sourcePath;
    var port = document.createElement("div");
    port.className = "port";
    port.textContent = ":" + it.port;
    row1.appendChild(name);
    row1.appendChild(port);
    body.appendChild(row1);

    var meta = document.createElement("div");
    meta.className = "meta";
    var age = fmtAge(it.startedAt);
    meta.textContent = "pid " + it.pid + " · started " + fmtDateTime(it.startedAt) + (age ? " (" + age + ")" : "");
    body.appendChild(meta);

    var actions = document.createElement("div");
    actions.className = "actions";
    var openLink = document.createElement("a");
    openLink.className = "open-btn";
    openLink.href = "http://localhost:" + it.port + "/";
    openLink.target = "_blank";
    openLink.rel = "noopener";
    openLink.textContent = "Open";
    actions.appendChild(openLink);

    var copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy path";
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(it.sourcePath).then(
        function () { copyBtn.textContent = "Copied ✓"; setTimeout(function () { copyBtn.textContent = "Copy path"; }, 1400); },
        function () { copyBtn.textContent = "Failed"; }
      );
    });
    actions.appendChild(copyBtn);

    var stopBtn = document.createElement("button");
    stopBtn.className = "stop-btn";
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", function () {
      if (!confirm("Stop :" + it.port + " (" + it.sourceName + ")?")) return;
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
      stopInstance(it.port).then(
        function () {
          stopBtn.textContent = "Stopped";
          tick();
        },
        function () {
          stopBtn.disabled = false;
          stopBtn.textContent = "Stop failed";
          setTimeout(function () { stopBtn.textContent = "Stop"; }, 1400);
        },
      );
    });
    actions.appendChild(stopBtn);

    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function render(items) {
    var list = document.getElementById("list");
    // Stable key so we don't tear down iframes on every poll.
    var key = items.map(function (i) { return i.port + ":" + i.startedAt; }).sort().join("|");
    if (key === lastKey) return;
    lastKey = key;

    list.textContent = "";
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "no markup instances running. start one with ";
      var code = document.createElement("code");
      code.textContent = "markup serve <path>";
      empty.appendChild(code);
      list.appendChild(empty);
      return;
    }
    var grid = document.createElement("div");
    grid.className = "grid";
    items.forEach(function (it) { grid.appendChild(buildCard(it)); });
    list.appendChild(grid);
  }

  function tick() {
    fetch("/api/instances", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) { render(j.instances || []); })
      .catch(function (e) {
        document.getElementById("sub").textContent = "error: " + e.message;
      });
  }
  tick();
  setInterval(tick, 5000);
})();
</script>
</body>
</html>
`;

async function startDashServer(opts = {}) {
  const port = opts.port == null ? DASH_PORT : opts.port;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(DASH_PAGE);
      return;
    }
    if (req.method === "GET" && pathname === "/api/instances") {
      // Filter out dashboard processes; the dash should not list itself.
      const items = registry.list().filter((it) => it.kind !== "dash");
      const body = JSON.stringify({ instances: items });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    if (req.method === "POST" && pathname === "/api/stop") {
      const portParam = Number.parseInt(url.searchParams.get("port") || "", 10);
      if (!Number.isFinite(portParam) || portParam < 1 || portParam > 65535) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "invalid port" }));
        return;
      }

      // Query current registry without deleting unrelated stale files here.
      const item = registry
        .list({ cleanStale: false })
        .find((it) => it.port === portParam);
      if (!item) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "instance not found" }));
        return;
      }
      if (item.kind === "dash") {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "refusing to stop dashboard from dashboard" }));
        return;
      }

      let status = "stopped";
      if (!registry.pidAlive(item.pid)) {
        status = "already-dead";
      } else {
        try {
          process.kill(item.pid, "SIGTERM");
        } catch (err) {
          if (err.code !== "ESRCH") {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: `failed to stop pid ${item.pid}: ${err.message}` }));
            return;
          }
          status = "already-dead";
        }
      }
      registry.unregister(item.port);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, port: item.port, pid: item.pid, status }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // Strict by default: surface EADDRINUSE instead of drifting to another port.
  await listenWithFallback(server, port, { fallback: opts.portFallback === true });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}/`;

  registry.register({
    port: actualPort,
    sourcePath: "(dashboard)",
    sourceName: "Markup Dashboard",
    kind: "dash",
  });
  registry.installLifecycle(actualPort);
  server.once("close", () => registry.unregister(actualPort));

  return { server, port: actualPort, url };
}

module.exports = { startDashServer };
