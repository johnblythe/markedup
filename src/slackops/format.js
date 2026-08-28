// Message formatting + the bridge marker. Every message the bridge writes
// carries a `[md:...]` token so read-back can tell bridge output from human
// replies — the only reliable signal, since the CLI posts as the logged-in
// user and real humans type markerless messages in the Slack app.

const crypto = require("node:crypto");

const MARKER_RE = /\[md:[^\]]*\]/;
// `ld slack send` appends this suffix to messages it sends; strip it before
// treating text as human-authored content.
const VIA_SUFFIX_RE = /\s*_via LD Research :robot_face:_\s*$/;

function isBridgeMessage(text) {
  return MARKER_RE.test(text || "");
}

// Marker token → ts of the message carrying it, for reconciling what already
// stands in the channel before posting (a send that landed but timed out
// locally must not double-post).
const MARKER_ALL_RE = /\[md:([^\]]+)\]/g;

function markerIndex(messages) {
  const map = new Map();
  for (const msg of messages || []) {
    if (!msg || !msg.ts || !msg.text) continue;
    for (const m of msg.text.matchAll(MARKER_ALL_RE)) {
      if (!map.has(m[1])) map.set(m[1], msg.ts);
    }
  }
  return map;
}

function stripCliSuffix(text) {
  return (text || "").replace(VIA_SUFFIX_RE, "").trim();
}

// Slack wraps emails, links, and channel refs in <...> markup. Unwrap them so
// ingested replies read as plain text on the canvas.
function unescapeSlackText(text) {
  return (text || "")
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, "$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, "$2")
    .replace(/<(https?:\/\/[^|>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Stable key for one canvas reply, so mirroring is idempotent across restarts.
function replyKey(reply) {
  return crypto
    .createHash("sha1")
    .update(`${reply.author}|${reply.at}|${reply.text}`)
    .digest("hex")
    .slice(0, 12);
}

function annoLabel(anno) {
  if (anno.mode === "pin") return `pin ${anno.pinNum ?? "?"}`;
  if (anno.mode === "rect") return `rect ${anno.rectNum ?? "?"}`;
  return "highlight";
}

// Contract ruling 2026-08-27: the wire shape is a nested `anchor` fingerprint
// and a `status` field (open | pending | accepted, accepted = terminal). The
// flat fields are tolerated as fallback for older payloads.
function annoStatus(anno) {
  return anno.status || anno.state || "open";
}

function isTerminalStatus(status) {
  return status === "accepted" || status === "resolved";
}

function isTerminal(anno) {
  return isTerminalStatus(annoStatus(anno));
}

function anchorTextOf(anno) {
  return (anno.anchor && anno.anchor.anchorText) || anno.anchorText || null;
}

function anchorCssPath(anno) {
  return (anno.anchor && anno.anchor.cssPath) || anno.cssPath || null;
}

function contextLine(anno) {
  const text = anchorTextOf(anno);
  if (text) return `> ${truncate(text, 180)}`;
  const cssPath = anchorCssPath(anno);
  if (cssPath) return `> \`${truncate(cssPath, 180)}\``;
  if (anno.anchor && anno.anchor.tagName) return `> \`${anno.anchor.tagName}\``;
  return null;
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function topLevelText(anno, docUrl) {
  const lines = [
    `:memo: *${annoLabel(anno)}* · ${anno.author || "unknown"} · ${annoStatus(anno)}`,
  ];
  const ctx = contextLine(anno);
  if (ctx) lines.push(ctx);
  if (anno.note) lines.push(anno.note);
  if (anno.shotUrl) lines.push(anno.shotUrl);
  lines.push(docUrl);
  lines.push(`[md:${anno.id}]`);
  return lines.join("\n");
}

function mirroredReplyText(anno, reply) {
  return [
    `${reply.author || "unknown"} (canvas):`,
    reply.text,
    `[md:r:${anno.id}:${replyKey(reply)}]`,
  ].join("\n");
}

function shareCardText({ title, docUrl, sharedBy }) {
  return [
    `:bookmark_tabs: *${title}*`,
    `${docUrl}`,
    `Shared by ${sharedBy}. Open the link to read and annotate; every annotation lands here as its own thread, and replies in those threads show up on the page.`,
    `[md:share]`,
  ].join("\n");
}

function summaryText(annotations) {
  const total = annotations.length;
  return [
    `:white_check_mark: All ${total} annotation${total === 1 ? "" : "s"} accepted. Archiving this channel; the annotated page stays live.`,
    `[md:summary]`,
  ].join("\n");
}

module.exports = {
  MARKER_RE,
  isBridgeMessage,
  markerIndex,
  stripCliSuffix,
  unescapeSlackText,
  replyKey,
  annoLabel,
  annoStatus,
  isTerminalStatus,
  isTerminal,
  anchorTextOf,
  anchorCssPath,
  topLevelText,
  mirroredReplyText,
  shareCardText,
  summaryText,
  truncate,
};
