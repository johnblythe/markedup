// Node-side feedback bundle builder for `markup pull`. Mirrors the browser
// exporter's markdown shape (src/client/export-client.js) and extends it with
// what multiplayer adds: authors, states, and reply threads — that context is
// exactly what the artifact's agent needs to act on the feedback.

function pinSymbol(n) {
  if (!n) return "?";
  const circled = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
  if (n >= 1 && n <= circled.length) return circled[n - 1];
  return `(${n})`;
}

// Untrusted spans (notes, quotes, replies, authors) are flattened before
// interpolation: newlines collapse so a note can't forge headings or list
// structure in the agent-facing markdown, backticks are stripped so it can't
// open or close code fences, and length is capped.
const MAX_SPAN_LENGTH = 2000;
function inline(value) {
  return String(value == null ? "" : value)
    .replace(/\r?\n/g, " ")
    .replace(/`/g, "'")
    .slice(0, MAX_SPAN_LENGTH);
}

function who(author) {
  return author ? inline(String(author).split("@")[0]) : "unknown";
}

function annotationSuffix(a) {
  const bits = [];
  if (a.author) bits.push(`by ${who(a.author)}`);
  if (a.state && a.state !== "open") bits.push(a.state);
  return bits.length ? ` _[${bits.join(", ")}]_` : "";
}

function replyLines(a, indent) {
  if (!Array.isArray(a.replies) || a.replies.length === 0) return [];
  return a.replies.map(
    (r) => `${indent}- ↳ ${who(r.author)}${r.via === "slack" ? " (slack)" : ""}: ${inline(r.text)}`,
  );
}

// annotations: server-shaped records. opts: { sourceName, sourceUrl, assetsDirName }
// Returns { markdown, assets: [{ filename, annoId }] } — the caller resolves
// each asset's bytes (shotUrl download) and attaches dataURLs.
function buildFeedbackMarkdown(annotations, opts) {
  const sourceName = opts.sourceName || "artifact.html";
  const lines = [];
  const assets = [];

  lines.push(`# Feedback: ${sourceName}`);
  lines.push(`Reviewed: ${new Date().toISOString()}`);
  if (opts.sourceUrl) lines.push(`Shared canvas: ${opts.sourceUrl}`);
  lines.push(`Total annotations: ${annotations.length}`);
  lines.push("");

  const spans = annotations.filter((a) => a.mode === "span");
  const pins = annotations.filter((a) => a.mode === "pin");
  const rects = annotations.filter((a) => a.mode === "rect");

  if (spans.length) {
    lines.push("## Span annotations");
    for (const a of spans) {
      const anchor = inline(a.payload && a.payload.anchorText ? a.payload.anchorText : "").slice(0, 80);
      lines.push(`- "${anchor}": ${inline(a.note) || "(no note)"}${annotationSuffix(a)}`);
      lines.push(...replyLines(a, "  "));
    }
    lines.push("");
  }

  if (pins.length) {
    lines.push("## Pin annotations");
    for (const a of pins) {
      const cssPath = (a.anchor && a.anchor.cssPath) || "(unknown)";
      const tag = (a.anchor && a.anchor.tagName) || "?";
      const anchorText = a.anchor && a.anchor.anchorText ? inline(a.anchor.anchorText).slice(0, 60) : "";
      lines.push(
        `- Pin ${pinSymbol(a.pinNum)} on \`${inline(tag)}\` (${inline(cssPath)})` +
          (anchorText ? ` — text: "${anchorText}"` : "") +
          `: ${inline(a.note) || "(no note)"}${annotationSuffix(a)}`,
      );
      lines.push(...replyLines(a, "  "));
    }
    lines.push("");
  }

  if (rects.length) {
    lines.push("## Rect annotations");
    for (const a of rects) {
      const cssPath = (a.anchor && a.anchor.cssPath) || "(unknown)";
      const tag = (a.anchor && a.anchor.tagName) || "?";
      const num = a.rectNum || "?";
      lines.push(`- **Rect ${num}** on \`${inline(tag)}\` (${inline(cssPath)}):${annotationSuffix(a)}`);
      lines.push("");
      lines.push(`  ${inline(a.note) || "(no note)"}`);
      lines.push(...replyLines(a, "  "));
      lines.push("");
      if (a.shotUrl) {
        const filename = `rect-${num}.png`;
        lines.push(`  ![rect-${num}](${opts.assetsDirName || "assets"}/${filename})`);
        assets.push({ filename, annoId: a.id });
      } else {
        lines.push("  [screenshot unavailable]");
      }
      lines.push("");
    }
  }

  if (!spans.length && !pins.length && !rects.length) {
    lines.push("(no annotations)");
  }

  return { markdown: lines.join("\n"), assets };
}

module.exports = { buildFeedbackMarkdown, pinSymbol };
