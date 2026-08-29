// Concatenates browser client modules into a single IIFE for inline serving.
// U3 fills in client/* files; this module is what serve.js calls to produce
// the bundled string.

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

function readIfExists(name) {
  const p = path.join(CLIENT_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

function buildClientBundle() {
  const parts = FILES.map((f) => `// ====== ${f} ======\n${readIfExists(f)}`);
  return `(function() {\n"use strict";\n${parts.join("\n\n")}\n})();\n`;
}

function getStylesCSS() {
  const p = path.join(CLIENT_DIR, "styles.css");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
}

module.exports = { buildClientBundle, getStylesCSS };
