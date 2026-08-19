const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Point registry at a tmp dir for tests.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "markup-reg-"));
process.env.HOME = tmpRoot;
// Force module re-resolve so REGISTRY_DIR picks up tmp HOME.
delete require.cache[require.resolve("../src/registry")];
const registry = require("../src/registry");

test("register writes file, list returns entry, unregister removes", () => {
  registry.register({ port: 9999, sourcePath: "/tmp/x.html", sourceName: "x.html" });
  const list = registry.list();
  const found = list.find((e) => e.port === 9999);
  assert.ok(found, "entry should be listed");
  assert.strictEqual(found.sourceName, "x.html");
  assert.strictEqual(found.pid, process.pid);
  registry.unregister(9999);
  assert.ok(!registry.list().find((e) => e.port === 9999));
});

test("pidAlive returns true for current process, false for a fake high pid", () => {
  assert.strictEqual(registry.pidAlive(process.pid), true);
  assert.strictEqual(registry.pidAlive(2147483647), false);
});

test("list cleans up entries for dead pids", () => {
  // Write a registry file with a definitely-dead pid.
  const REGISTRY_DIR = registry.REGISTRY_DIR;
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const stalePath = path.join(REGISTRY_DIR, "9998.json");
  fs.writeFileSync(
    stalePath,
    JSON.stringify({
      port: 9998,
      sourcePath: "/tmp/y.html",
      sourceName: "y.html",
      pid: 2147483646, // implausible
      startedAt: new Date().toISOString(),
    }),
  );
  assert.ok(fs.existsSync(stalePath));
  const list = registry.list();
  assert.ok(!list.find((e) => e.port === 9998), "stale entry should be filtered");
  assert.ok(!fs.existsSync(stalePath), "stale file should be cleaned up");
});

test("list ignores malformed JSON and removes the file", () => {
  const REGISTRY_DIR = registry.REGISTRY_DIR;
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const junkPath = path.join(REGISTRY_DIR, "9997.json");
  fs.writeFileSync(junkPath, "{not json");
  registry.list();
  assert.ok(!fs.existsSync(junkPath));
});

test("find returns the entry for a given port, undefined when absent", () => {
  registry.register({ port: 9996, sourcePath: "/tmp/z.html", sourceName: "z.html", kind: "serve" });
  try {
    const found = registry.find(9996);
    assert.ok(found, "entry should be found");
    assert.strictEqual(found.sourceName, "z.html");
    assert.strictEqual(registry.find(9111), undefined, "unregistered port should not be found");
  } finally {
    registry.unregister(9996);
  }
});

test("findDash returns the first live dash entry, ignoring serve entries and dead pids", () => {
  const REGISTRY_DIR = registry.REGISTRY_DIR;
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  // A dead dash entry: should be cleaned up and never returned.
  fs.writeFileSync(
    path.join(REGISTRY_DIR, "9994.json"),
    JSON.stringify({
      port: 9994,
      sourcePath: "(dashboard)",
      sourceName: "Markup Dashboard",
      pid: 2147483645, // implausible
      startedAt: new Date().toISOString(),
      kind: "dash",
    }),
  );
  registry.register({
    port: 9995,
    sourcePath: "/tmp/serve.html",
    sourceName: "serve.html",
    kind: "serve",
  });
  registry.register({
    port: 9993,
    sourcePath: "(dashboard)",
    sourceName: "Markup Dashboard",
    kind: "dash",
  });
  registry.register({
    port: 9992,
    sourcePath: "(dashboard)",
    sourceName: "Markup Dashboard",
    kind: "dash",
  });
  try {
    const found = registry.findDash();
    assert.ok(found, "should find a live dash entry");
    assert.strictEqual(found.kind, "dash");
    assert.strictEqual(found.port, 9992, "should return the lowest-port live dash entry");
    assert.ok(
      !fs.existsSync(path.join(REGISTRY_DIR, "9994.json")),
      "dead dash entry should be cleaned up",
    );
  } finally {
    registry.unregister(9995);
    registry.unregister(9993);
    registry.unregister(9992);
  }
});
