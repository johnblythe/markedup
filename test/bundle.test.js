const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
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
