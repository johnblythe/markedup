const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildClientBundle, getStylesCSS } = require("../src/client-bundle");

test("buildClientBundle includes all client modules", () => {
  const src = buildClientBundle();
  // Every named IIFE / var declaration we expect:
  for (const name of [
    "Fingerprint",
    "Persist",
    "Screenshot",
    "Popover",
    "Sidebar",
    "Modes",
    "Toast",
    "ExportClient",
  ]) {
    assert.ok(src.includes("var " + name), `bundle missing var ${name}`);
  }
});

test("buildClientBundle is a single self-invoking function with no top-level require/import", () => {
  const src = buildClientBundle();
  assert.match(src, /^\(function\(\)/);
  assert.match(src, /\}\)\(\);\s*$/);
  // Should not have CommonJS / ESM at module top level.
  assert.ok(!/^require\s*\(/m.test(src));
  assert.ok(!/^import\s+/m.test(src));
  assert.ok(!/^export\s+/m.test(src));
});

test("buildClientBundle parses as valid JavaScript", () => {
  const src = buildClientBundle();
  // vm.Script throws on syntax error.
  assert.doesNotThrow(() => new vm.Script(src));
});

test("getStylesCSS returns the overlay stylesheet", () => {
  const css = getStylesCSS();
  assert.match(css, /#markup-toolbar/);
  assert.match(css, /\.markup-pin/);
  assert.match(css, /\.markup-rect/);
  assert.match(css, /mark\.markup-span/);
});

// buildClientBundle()/getStylesCSS() take an optional clientDir override
// purely so tests can point them at a throwaway fixture instead of touching
// the real src/client sources.
function withFixtureClientDir(callback) {
  return () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-bundle-"));
    fs.writeFileSync(path.join(dir, "fingerprint.js"), "var Fingerprint = 1;\n");
    fs.writeFileSync(path.join(dir, "styles.css"), ".markup-fixture { color: red; }\n");
    try {
      return callback(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "buildClientBundle rebuilds when a source file's mtime changes",
  withFixtureClientDir((dir) => {
    const first = buildClientBundle(dir);
    assert.match(first, /var Fingerprint = 1;/);

    // Unchanged tree: cache hit, same string instance back.
    const second = buildClientBundle(dir);
    assert.strictEqual(first, second);

    // Bump mtime forward and change content: cache must be invalidated.
    const target = path.join(dir, "fingerprint.js");
    fs.writeFileSync(target, "var Fingerprint = 2;\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);

    const third = buildClientBundle(dir);
    assert.notStrictEqual(third, second);
    assert.match(third, /var Fingerprint = 2;/);
    assert.ok(!third.includes("var Fingerprint = 1;"));
  }),
);

test(
  "getStylesCSS rebuilds when styles.css mtime changes, and shares the cache with buildClientBundle",
  withFixtureClientDir((dir) => {
    buildClientBundle(dir); // populate the cache via the sibling export
    const first = getStylesCSS(dir);
    assert.match(first, /\.markup-fixture \{ color: red; \}/);

    const second = getStylesCSS(dir);
    assert.strictEqual(first, second);

    const target = path.join(dir, "styles.css");
    fs.writeFileSync(target, ".markup-fixture { color: blue; }\n");
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);

    const third = getStylesCSS(dir);
    assert.notStrictEqual(third, second);
    assert.match(third, /\.markup-fixture \{ color: blue; \}/);
  }),
);

test(
  "buildClientBundle tolerates a missing file the same way readIfExists does",
  withFixtureClientDir((dir) => {
    fs.rmSync(path.join(dir, "styles.css"));
    assert.doesNotThrow(() => buildClientBundle(dir));
    assert.strictEqual(getStylesCSS(dir), "");
  }),
);
