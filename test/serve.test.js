const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const net = require("node:net");

// startServer() calls registry.register() unconditionally, so this file must
// point HOME at a tmp dir before requiring src/serve — otherwise every test
// here writes into the user's real ~/.markup/instances.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "markup-serve-"));
process.env.HOME = tmpRoot;
delete require.cache[require.resolve("../src/registry")];
delete require.cache[require.resolve("../src/serve")];
const { startServer } = require("../src/serve");
const { DASH_PORT, RESERVED_PORTS } = require("../src/ports");

// Bind then immediately release, handing back a port that was free a moment
// ago. Used to stand in for "the reserved port" without ever touching the
// real DASH_PORT (7780), which the user may have a live dashboard on.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), headers: res.headers };
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

function withTempArtifact(callback) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-test-"));
    const sourcePath = path.join(dir, "artifact.html");
    fs.writeFileSync(
      sourcePath,
      `<!doctype html><html><head><title>t</title></head><body><p id="hello">hello</p></body></html>`,
    );
    fs.writeFileSync(path.join(dir, "neighbor.txt"), "neighborly");
    let handle;
    try {
      handle = await startServer(sourcePath, { port: 0, autoOpen: false });
      await callback({ dir, sourcePath, handle });
    } finally {
      if (handle) handle.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "GET / returns wrapped HTML with overlay injections",
  withTempArtifact(async ({ handle }) => {
    const { status, body } = await fetchText(`${handle.url}`);
    assert.strictEqual(status, 200);
    assert.match(body, /<style id="markup-overlay-styles"/);
    assert.match(body, /<script id="markup-bootstrap"/);
    assert.match(body, /<p id="hello">hello<\/p>/);
  }),
);

test(
  "GET /__markup/client.js returns the client bundle",
  withTempArtifact(async ({ handle }) => {
    const { status, body, headers } = await fetchText(`${handle.url}__markup/client.js`);
    assert.strictEqual(status, 200);
    assert.match(headers.get("content-type") || "", /javascript/);
    assert.match(body, /\(function/); // IIFE wrapper from buildClientBundle
  }),
);

test(
  "GET /__markup/modern-screenshot.js returns the lib",
  withTempArtifact(async ({ handle }) => {
    const { status, body, headers } = await fetchText(`${handle.url}__markup/modern-screenshot.js`);
    assert.strictEqual(status, 200);
    assert.match(headers.get("content-type") || "", /javascript/);
    assert.match(body, /modernScreenshot/);
  }),
);

test(
  "GET /neighbor.txt serves files from source's parent dir",
  withTempArtifact(async ({ handle }) => {
    const { status, body } = await fetchText(`${handle.url}neighbor.txt`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body, "neighborly");
  }),
);

test(
  "GET with path traversal is rejected",
  withTempArtifact(async ({ handle }) => {
    const { status } = await fetchText(`${handle.url}../etc/passwd`);
    // Node sometimes normalizes the URL; ensure result is 403 or 404, never 200.
    assert.ok(status === 403 || status === 404, `expected 403/404, got ${status}`);
  }),
);

test(
  "source HTML file on disk is byte-identical after serve session",
  withTempArtifact(async ({ sourcePath, handle }) => {
    const before = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    // Hit the server a few times.
    await fetchText(`${handle.url}`);
    await fetchText(`${handle.url}neighbor.txt`);
    const after = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    assert.strictEqual(before, after);
  }),
);

test(
  "concurrent GET / requests return consistent wrapped HTML",
  withTempArtifact(async ({ handle }) => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => fetchText(`${handle.url}`)),
    );
    const bodies = results.map((r) => r.body);
    for (const b of bodies) {
      assert.strictEqual(bodies[0], b);
    }
  }),
);

test(
  "POST to a non-export path returns 405",
  withTempArtifact(async ({ handle }) => {
    const res = await fetch(`${handle.url}foo`, { method: "POST", body: "x" });
    assert.strictEqual(res.status, 405);
  }),
);

test(
  "POST /export rejects oversized payload",
  withTempArtifact(async ({ handle }) => {
    const big = Buffer.alloc(60 * 1024 * 1024).toString("utf-8"); // > 50MB cap
    const res = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    assert.strictEqual(res.status, 413);
  }),
);

test(
  "POST /export with valid payload writes stamped feedback bundle",
  withTempArtifact(async ({ sourcePath, dir, handle }) => {
    const payload = {
      markdown: "# feedback test\n",
      stamp: "test-stamp-1",
      assets: [
        {
          filename: "rect-1.png",
          dataURL:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        },
      ],
    };
    const res = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.stamp, "test-stamp-1");
    assert.ok(fs.existsSync(path.join(dir, "artifact.feedback-test-stamp-1.md")));
    assert.ok(
      fs.existsSync(path.join(dir, "artifact.feedback-test-stamp-1.assets", "rect-1.png")),
    );
    assert.strictEqual(
      fs.readFileSync(path.join(dir, "artifact.feedback-test-stamp-1.md"), "utf-8"),
      "# feedback test\n",
    );
  }),
);

test(
  "Two consecutive POST /export calls produce two distinct stamped bundles",
  withTempArtifact(async ({ dir, handle }) => {
    const mk = (stamp) => ({
      markdown: `# export ${stamp}\n`,
      stamp,
      assets: [],
    });
    const r1 = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mk("first")),
    });
    const r2 = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mk("second")),
    });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.ok(fs.existsSync(path.join(dir, "artifact.feedback-first.md")));
    assert.ok(fs.existsSync(path.join(dir, "artifact.feedback-second.md")));
  }),
);

test("startServer falls back to the next free port when preferred is busy", async () => {
  const { startServer } = require("../src/serve");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-portfb-"));
  const sourcePath = path.join(dir, "a.html");
  fs.writeFileSync(sourcePath, "<html><body>a</body></html>");
  // Squat a port first.
  const net = require("node:net");
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const busyPort = squatter.address().port;
  let h;
  try {
    h = await startServer(sourcePath, { port: busyPort, autoOpen: false });
    assert.notStrictEqual(h.port, busyPort, "should pick a different port");
    assert.ok(h.port > busyPort, "should step up from preferred port");
    const res = await fetch(h.url);
    assert.strictEqual(res.status, 200);
  } finally {
    if (h) h.server.close();
    squatter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startServer throws when explicitly asked for the reserved dashboard port", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-reserved-"));
  const sourcePath = path.join(dir, "a.html");
  fs.writeFileSync(sourcePath, "<html><body>a</body></html>");
  try {
    // The reserved-port check runs before any bind attempt, so this never
    // actually touches the real dashboard port the user may have running.
    await assert.rejects(
      startServer(sourcePath, { port: DASH_PORT, autoOpen: false }),
      /reserved for the markup dashboard/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("allowReserved lets startServer bind a port that is otherwise reserved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-allowreserved-"));
  const sourcePath = path.join(dir, "a.html");
  fs.writeFileSync(sourcePath, "<html><body>a</body></html>");

  // Can't exercise this against the real DASH_PORT (7780) without risking a
  // collision with a live dashboard. RESERVED_PORTS is the exact Set
  // instance src/serve.js reads from, so mutating it in place exercises the
  // real reserved-port logic against a throwaway port instead.
  const fakeReserved = await getFreePort();
  RESERVED_PORTS.add(fakeReserved);
  let h;
  try {
    await assert.rejects(
      startServer(sourcePath, { port: fakeReserved, autoOpen: false }),
      /reserved for the markup dashboard/,
    );
    h = await startServer(sourcePath, {
      port: fakeReserved,
      autoOpen: false,
      allowReserved: true,
    });
    assert.strictEqual(h.port, fakeReserved);
  } finally {
    RESERVED_PORTS.delete(fakeReserved);
    if (h) h.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startServer steps over a reserved port while falling back from a busy one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-reserved-fallback-"));
  const sourcePath = path.join(dir, "a.html");
  fs.writeFileSync(sourcePath, "<html><body>a</body></html>");

  // Squat a port, then mark the port just above it "reserved" via the same
  // shared Set (again, never touching the real 7780). Falling back from the
  // squatted port must skip straight over the fake-reserved one.
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port));
  });
  const fakeReserved = busyPort + 1;
  RESERVED_PORTS.add(fakeReserved);
  let h;
  try {
    h = await startServer(sourcePath, { port: busyPort, autoOpen: false });
    assert.notStrictEqual(h.port, busyPort, "should step away from the busy port");
    assert.notStrictEqual(h.port, fakeReserved, "should skip the reserved port while stepping up");
    assert.notStrictEqual(h.port, DASH_PORT);
    assert.ok(h.port > busyPort);
  } finally {
    RESERVED_PORTS.delete(fakeReserved);
    if (h) h.server.close();
    squatter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Same stamp twice produces -2 suffix without clobbering the original",
  withTempArtifact(async ({ dir, handle }) => {
    const body = JSON.stringify({ markdown: "# dup\n", stamp: "dup-stamp", assets: [] });
    const r1 = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const r2 = await fetch(`${handle.url}export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    const j1 = await r1.json();
    const j2 = await r2.json();
    assert.strictEqual(j1.stamp, "dup-stamp");
    assert.strictEqual(j2.stamp, "dup-stamp-2");
    assert.ok(fs.existsSync(path.join(dir, "artifact.feedback-dup-stamp.md")));
    assert.ok(fs.existsSync(path.join(dir, "artifact.feedback-dup-stamp-2.md")));
  }),
);
