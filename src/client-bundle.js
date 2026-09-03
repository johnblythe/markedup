// Concatenates browser client modules into a single IIFE for inline serving.
// U3 fills in client/* files; this module is what serve.js calls to produce
// the bundled string.
//
// serve.js keeps a long-running process, so this module caches the built
// bundle/styles keyed by the max mtime across the source files. A stat is
// cheap enough to do on every request; a full read+rebuild is not, so we
// skip it unless a file actually changed since the last build.

const fs = require("node:fs");
const path = require("node:path");

const CLIENT_DIR = path.join(__dirname, "client");

// Order matters: dependencies first.
const FILES = [
  "fingerprint.js",
  "persist.js",
  "screenshot.js",
  "popover.js",
  "sidebar.js",
  "modes.js",
  "export-client.js",
  "palette.js",
  "overlay.js",
];

function readIfExists(dir, name) {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

// Missing files contribute nothing to the freshness key, same as they
// contribute nothing (empty string) to the built bundle.
function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_err) {
    return 0;
  }
}

function freshnessKey(dir) {
  let max = 0;
  for (const f of FILES) {
    max = Math.max(max, mtimeOf(path.join(dir, f)));
  }
  max = Math.max(max, mtimeOf(path.join(dir, "styles.css")));
  return max;
}

function rebuild(dir) {
  const parts = FILES.map((f) => `// ====== ${f} ======\n${readIfExists(dir, f)}`);
  const bundle = `(function() {\n"use strict";\n${parts.join("\n\n")}\n})();\n`;
  const styles = readIfExists(dir, "styles.css");
  return { bundle, styles };
}

// One cache entry, keyed by directory so tests can point at a fixture
// CLIENT_DIR without colliding with the real one.
let cache = null;

function ensureFresh(dir) {
  const key = freshnessKey(dir);
  if (cache && cache.dir === dir && cache.key === key) return cache;
  const { bundle, styles } = rebuild(dir);
  cache = { dir, key, bundle, styles };
  return cache;
}

function buildClientBundle(clientDir = CLIENT_DIR) {
  return ensureFresh(clientDir).bundle;
}

function getStylesCSS(clientDir = CLIENT_DIR) {
  return ensureFresh(clientDir).styles;
}

module.exports = { buildClientBundle, getStylesCSS };
