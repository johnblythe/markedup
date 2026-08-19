const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");

// Use a tmp HOME so registry doesn't conflict with the user's real instances.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "markup-dash-"));
process.env.HOME = tmpRoot;
delete require.cache[require.resolve("../src/registry")];
delete require.cache[require.resolve("../src/dash")];
const { startDashServer } = require("../src/dash");
const registry = require("../src/registry");

test("dash server serves dashboard HTML on /", async () => {
  const h = await startDashServer({ port: 0 });
  try {
    const res = await fetch(h.url);
    const body = await res.text();
    assert.strictEqual(res.status, 200);
    assert.match(body, /Markup Dashboard/);
    assert.match(body, /\/api\/instances/);
  } finally {
    h.server.close();
  }
});

test("/api/instances returns JSON listing of serve entries, hides dash itself", async () => {
  registry.register({
    port: 7895,
    sourcePath: "/tmp/foo.html",
    sourceName: "foo.html",
    kind: "serve",
  });
  const h = await startDashServer({ port: 0 });
  try {
    const res = await fetch(`${h.url}api/instances`);
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j.instances));
    const fake = j.instances.find((it) => it.port === 7895);
    assert.ok(fake, "serve entry should appear");
    assert.strictEqual(fake.sourceName, "foo.html");
    // dash should NOT appear in its own listing
    const selfInList = j.instances.find((it) => it.port === h.port);
    assert.strictEqual(selfInList, undefined, "dash should hide itself from list");
    // every entry returned should be a serve, not a dash
    j.instances.forEach((it) => assert.notStrictEqual(it.kind, "dash"));
  } finally {
    registry.unregister(7895);
    h.server.close();
  }
});

test("dash server returns 404 for unknown path", async () => {
  const h = await startDashServer({ port: 0 });
  try {
    const res = await fetch(`${h.url}nope`);
    assert.strictEqual(res.status, 404);
  } finally {
    h.server.close();
  }
});

test("POST /api/stop stops a serve pid by port", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });

  const port = 7897;
  fs.mkdirSync(registry.REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(registry.REGISTRY_DIR, `${port}.json`),
    JSON.stringify(
      {
        port,
        sourcePath: "/tmp/kill-me.html",
        sourceName: "kill-me.html",
        pid: child.pid,
        startedAt: new Date().toISOString(),
        kind: "serve",
      },
      null,
      2,
    ),
  );

  const h = await startDashServer({ port: 0 });
  try {
    const res = await fetch(`${h.url}api/stop?port=${port}`, { method: "POST" });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.port, port);
    assert.ok(!fs.existsSync(path.join(registry.REGISTRY_DIR, `${port}.json`)));
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 1500)),
    ]);
  } finally {
    h.server.close();
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (_err) {}
    registry.unregister(port);
  }
});

test("startDashServer rejects with EADDRINUSE on a busy port (strict bind)", async () => {
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port));
  });
  try {
    await assert.rejects(
      startDashServer({ port: busyPort }),
      (err) => err.code === "EADDRINUSE",
    );
  } finally {
    squatter.close();
  }
});

test("startDashServer with portFallback: true steps up past a busy port", async () => {
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port));
  });
  let h;
  try {
    h = await startDashServer({ port: busyPort, portFallback: true });
    assert.notStrictEqual(h.port, busyPort);
    assert.ok(h.port > busyPort);
  } finally {
    if (h) h.server.close();
    squatter.close();
  }
});
