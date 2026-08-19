const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");

const CLI = path.resolve(__dirname, "..", "bin", "markup.js");

function runCLI(args, env) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf-8", env: env || process.env });
}

// Bind then immediately release, handing back a port that was free a moment
// ago. Used instead of a literal port number so tests never risk colliding
// with the user's real markup instances.
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

test("--help prints usage including serve subcommand", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-help-"));
  try {
    const result = runCLI(["--help"], { ...process.env, HOME: tmpHome });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /serve/);
    assert.match(result.stdout, /markup/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("serve with nonexistent path exits non-zero with clear error", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-nopath-"));
  try {
    const result = runCLI(
      ["serve", "/tmp/markup-does-not-exist-12345.html"],
      { ...process.env, HOME: tmpHome },
    );
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /file not found/);
    assert.match(result.stderr, /markup-does-not-exist-12345/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("serve with non-html file exits non-zero", () => {
  const tmpFile = path.join(os.tmpdir(), `markup-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "hello");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-nonhtml-"));
  try {
    const result = runCLI(["serve", tmpFile], { ...process.env, HOME: tmpHome });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /expected an \.html file/);
  } finally {
    fs.unlinkSync(tmpFile);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("serve with invalid port exits non-zero", () => {
  const tmpFile = path.join(os.tmpdir(), `markup-test-${Date.now()}.html`);
  fs.writeFileSync(tmpFile, "<html></html>");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-badport-"));
  try {
    const result = runCLI(["serve", "--port", "99999", tmpFile], { ...process.env, HOME: tmpHome });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /invalid port/);
  } finally {
    fs.unlinkSync(tmpFile);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("serve --port 7780 exits non-zero mentioning reserved", () => {
  const tmpFile = path.join(os.tmpdir(), `markup-test-reserved-${Date.now()}.html`);
  fs.writeFileSync(tmpFile, "<html></html>");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-reserved-"));
  try {
    // This is rejected before any bind is attempted, so it never actually
    // touches the real dashboard port the user may have running.
    const result = runCLI(["serve", "--port", "7780", tmpFile], { ...process.env, HOME: tmpHome });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /reserved/);
  } finally {
    fs.unlinkSync(tmpFile);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("bare path implies serve: non-html file is rejected by serve's own check", () => {
  const tmpFile = path.join(os.tmpdir(), `markup-implied-${Date.now()}.html`);
  fs.writeFileSync(tmpFile, "<html></html>");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-implied-"));
  try {
    // Reaches the serve action (rejected on the reserved port) without the
    // `serve` word, proving the shorthand routed there.
    const result = runCLI(["--port", "7780", tmpFile], { ...process.env, HOME: tmpHome });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /reserved/);
  } finally {
    fs.unlinkSync(tmpFile);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("bare path implies serve: nonexistent .html reports file not found", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-implied-missing-"));
  try {
    const result = runCLI(["/tmp/markup-does-not-exist-67890.html"], {
      ...process.env,
      HOME: tmpHome,
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /file not found/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("a mistyped subcommand is not treated as a file path", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-typo-"));
  try {
    const result = runCLI(["lst"], { ...process.env, HOME: tmpHome });
    assert.notStrictEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /file not found/);
    assert.match(result.stderr, /unknown command/i);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("dash --detach starts a background dashboard; a second dash reports it as already running", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "markup-cli-dash-"));
  const env = { ...process.env, HOME: tmpHome };
  const port = await getFreePort();
  let childPid;
  try {
    const first = runCLI(["dash", "--port", String(port), "--detach", "--no-open"], env);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, new RegExp(`:${port}`));
    const m = first.stdout.match(/background, pid (\d+)/);
    assert.ok(m, `expected background pid in stdout, got: ${first.stdout}`);
    childPid = Number(m[1]);

    const second = runCLI(["dash", "--port", String(port), "--no-open"], env);
    assert.strictEqual(second.status, 0, second.stderr);
    assert.match(second.stdout, /already running/);
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch (_err) {}
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
