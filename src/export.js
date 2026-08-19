// Server-side export bundle writer. Receives JSON payload from the client,
// writes <stem>.feedback-<timestamp>.md and <stem>.feedback-<timestamp>.assets/*.png
// next to the source HTML.
//
// Every export is timestamped and additive — prior exports are never clobbered.
// Each export = a fresh breadcrumb for audit / training / train-of-thought review.
//
// Payload shape (from client):
// {
//   markdown: "...",
//   assets: [ { filename: "rect-1.png", dataURL: "data:image/png;base64,..." } ],
//   stamp?: "YYYYMMDD-HHMMSS",  // optional override (mostly for tests)
// }

const fs = require("node:fs");
const path = require("node:path");

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i;

function decodeDataURL(dataURL) {
  const match = String(dataURL).match(DATA_URL_RE);
  if (!match) throw new Error("invalid data URL");
  return Buffer.from(match[2], "base64");
}

// Safe filename: kebab-case-ish, no path separators, length-capped.
function safeFilename(name) {
  const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return cleaned.slice(0, 120) || "asset";
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Resolve a unique stamp suffix. If the timestamp collides (sub-second double-export),
// append `-2`, `-3`, ... until a free slot is found.
function uniqueSlot(dir, stem, stamp) {
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? stamp : `${stamp}-${i + 1}`;
    const md = path.join(dir, `${stem}.feedback-${suffix}.md`);
    const assets = path.join(dir, `${stem}.feedback-${suffix}.assets`);
    if (!fs.existsSync(md) && !fs.existsSync(assets)) {
      return { suffix, md, assets };
    }
  }
  throw new Error("too many exports in the same second");
}

function writeExportBundle(sourcePath, payload) {
  if (!payload || typeof payload.markdown !== "string") {
    throw new Error("payload.markdown is required");
  }
  const dir = path.dirname(sourcePath);
  const stem = path.basename(sourcePath).replace(/\.[^.]+$/, "");
  const stamp = payload.stamp && /^[0-9A-Za-z._-]+$/.test(payload.stamp) ? payload.stamp : timestamp();
  const slot = uniqueSlot(dir, stem, stamp);

  const assets = Array.isArray(payload.assets) ? payload.assets : [];

  if (assets.length > 0) {
    fs.mkdirSync(slot.assets, { recursive: true });
  }

  const writtenAssets = [];
  for (const asset of assets) {
    if (!asset || typeof asset.filename !== "string" || typeof asset.dataURL !== "string") {
      continue;
    }
    const filename = safeFilename(asset.filename);
    const buf = decodeDataURL(asset.dataURL);
    const outPath = path.join(slot.assets, filename);
    fs.writeFileSync(outPath, buf);
    writtenAssets.push(filename);
  }

  fs.writeFileSync(slot.md, payload.markdown, "utf-8");

  return {
    feedbackPath: slot.md,
    assetsDir: writtenAssets.length > 0 ? slot.assets : null,
    assets: writtenAssets,
    stamp: slot.suffix,
  };
}

module.exports = { writeExportBundle, decodeDataURL, safeFilename, timestamp };
