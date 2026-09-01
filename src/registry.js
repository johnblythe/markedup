// Per-instance registry so `markup list` and `markup dash` can discover
// running servers. Each `markup serve` process writes a JSON file in
// REGISTRY_DIR keyed by port, removes it on shutdown, and stale files
// (process dead) are cleaned up lazily by list().

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REGISTRY_DIR = path.join(os.homedir(), ".markup", "instances");

function ensureDir() {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
}

function fileFor(port) {
  return path.join(REGISTRY_DIR, `${port}.json`);
}

function register(entry) {
  ensureDir();
  const data = {
    port: entry.port,
    sourcePath: entry.sourcePath,
    sourceName: entry.sourceName || path.basename(entry.sourcePath),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind: entry.kind || "serve",
    // Multiplayer instances own their annotations file exclusively; serve.js
    // uses this to refuse a second multiplayer process on the same source.
    multiplayer: entry.multiplayer === true,
  };
  fs.writeFileSync(fileFor(entry.port), JSON.stringify(data, null, 2));
  return data;
}

function unregister(port) {
  try {
    fs.unlinkSync(fileFor(port));
  } catch (_e) {
    // already gone, fine
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but we can't signal it (still alive)
    return e.code === "EPERM";
  }
}

function list({ cleanStale = true } = {}) {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  const entries = [];
  const files = fs.readdirSync(REGISTRY_DIR);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(REGISTRY_DIR, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf-8"));
    } catch (_e) {
      if (cleanStale) {
        try {
          fs.unlinkSync(full);
        } catch (_) {}
      }
      continue;
    }
    if (!pidAlive(parsed.pid)) {
      if (cleanStale) {
        try {
          fs.unlinkSync(full);
        } catch (_) {}
      }
      continue;
    }
    entries.push(parsed);
  }
  entries.sort((a, b) => a.port - b.port);
  return entries;
}

function find(port, opts) {
  return list(opts).find((it) => it.port === port);
}

// The dashboard is a singleton: `markup dash` reuses whatever this returns
// instead of starting a second one.
function findDash(opts) {
  return list(opts).find((it) => it.kind === "dash");
}

// Install lifecycle hooks so a process always cleans up its registry entry.
// Tests spin up many ports in one process, so bump the listener cap a little.
function installLifecycle(port) {
  if (process.getMaxListeners() < 64) process.setMaxListeners(64);
  const cleanup = () => unregister(port);
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.once("uncaughtException", (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  REGISTRY_DIR,
  register,
  unregister,
  list,
  find,
  findDash,
  pidAlive,
  installLifecycle,
};
