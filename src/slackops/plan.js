// Pure planning logic for one bridge cycle. No I/O here — everything is
// computed from (annotations fetched from the API, persisted state) so the
// whole sync policy is unit-testable without Slack or a server.

const { replyKey, isBridgeMessage, stripCliSuffix, unescapeSlackText } = require("./format");

// Slack ts values ("1787881105.402179") carry 16 significant digits; float64
// rounds the last one, so cursor comparisons work on the integer parts.
function tsLte(a, b) {
  const [as, au = "0"] = String(a).split(".");
  const [bs, bu = "0"] = String(b).split(".");
  if (Number(as) !== Number(bs)) return Number(as) < Number(bs);
  return Number(au.padEnd(6, "0")) <= Number(bu.padEnd(6, "0"));
}

// What has to go Slack-ward this cycle.
//
// - An annotation with no mapping yet gets one top-level post (whatever its
//   state — late is better than invisible).
// - A canvas-originated reply (via !== "slack") not yet mirrored gets posted
//   into the annotation's thread. Slack-originated replies came FROM the
//   channel; echoing them back would loop.
// - resolvedAll flips when there is at least one annotation and none is open.
function planActions(annotations, state) {
  const newTopLevel = [];
  const repliesToMirror = [];

  for (const anno of annotations) {
    const mapped = state.annos[anno.id];
    if (!mapped) {
      newTopLevel.push(anno);
      continue;
    }
    for (const reply of anno.replies || []) {
      if (reply.via === "slack") continue;
      const key = replyKey(reply);
      if (!mapped.mirroredReplyKeys[key]) {
        repliesToMirror.push({ anno, reply, key });
      }
    }
  }

  const resolvedAll =
    annotations.length > 0 && annotations.every((a) => a.state === "resolved");

  return { newTopLevel, repliesToMirror, resolvedAll };
}

// Which thread messages are new human replies to ingest canvas-ward.
//
// Skips: the top-level message itself, anything the bridge wrote (marker),
// and anything at or before the stored cursor. Returns messages oldest-first
// with the CLI suffix stripped.
function planIngest(annoId, threadMessages, mapped) {
  const threadTs = mapped.ts;
  const cursor = mapped.threadCursor || mapped.ts;
  const fresh = [];

  for (const msg of threadMessages) {
    if (!msg || !msg.ts) continue;
    if (msg.ts === threadTs) continue;
    if (tsLte(msg.ts, cursor)) continue;
    if (isBridgeMessage(msg.text)) continue;
    const text = unescapeSlackText(stripCliSuffix(msg.text));
    if (!text) continue;
    fresh.push({ ts: msg.ts, user: msg.user || null, text });
  }

  fresh.sort((a, b) => (tsLte(a.ts, b.ts) ? -1 : 1));
  return fresh;
}

// Human-readable author for a Slack user id, using the people map built by
// `markup share` (email → { id, name }). Falls back to a stable opaque tag.
function authorForSlackUser(userId, people) {
  for (const [email, person] of Object.entries(people || {})) {
    if (person && person.id === userId) return email;
  }
  return userId ? `slack:${userId}` : "slack:unknown";
}

module.exports = { planActions, planIngest, authorForSlackUser, tsLte };
