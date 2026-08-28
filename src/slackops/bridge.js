// The bridge daemon: annotations API ⇄ Slack threads.
//
// One cycle:
//   1. GET annotations (ETag). New annotation → one top-level channel post.
//      New canvas reply → one threaded post. Both idempotent via state.
//   2. For each live thread, read replies. Human messages (no [md:] marker,
//      newer than the cursor) → POST back to the API with via:"slack".
//   3. Everything resolved → summary post, then archive (opt-out).
//
// State is saved after every side effect, so a crash or restart never
// double-posts. The reply cursor only advances when a human message is
// ingested — advancing it on our own mirrored posts would swallow any human
// reply that raced in between.

const crypto = require("node:crypto");
const registry = require("../registry");
const stateStore = require("./state");
const format = require("./format");
const { planActions, planIngest, authorForSlackUser } = require("./plan");
const defaultSlack = require("./slack-cli");
const defaultApi = require("./api-client");
const { assertTrustedOrigin } = require("./api-client");

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function makeLog(quiet) {
  return quiet ? () => {} : (msg) => console.log(`[${ts()}] ${msg}`);
}

// Record canvas activity by someone other than the doc owner, feeding the
// debounced owner digest. The bridge's own posts never come through here and
// slack-via replies are excluded upstream, so echo suppression holds.
function addPendingNudge(state, author, kind) {
  if (!state.owner || !author) return;
  if (String(author).toLowerCase() === String(state.owner).toLowerCase()) return;
  const entry = state.nudge.pending[author] || { notes: 0, replies: 0 };
  entry[kind] += 1;
  state.nudge.pending[author] = entry;
}

// Runs one sync cycle against injected slack/api drivers. Mutates and
// persists `state`. Returns { archived, posted, ingested, cycleOk }.
async function runCycle({ state, stateDir, slack, api, archiveOnResolve, log, now = Date.now }) {
  let posted = 0;
  let ingested = 0;
  let slackWardOk = true;

  // --- canvas → slack -------------------------------------------------------
  let annotations = null;
  const res = await api.fetchAnnotations({
    apiBase: state.apiBase,
    user: state.user,
    project: state.project,
    etag: state.etag,
  });

  if (res.status === 200) {
    annotations = res.annotations;

    // Annotations deleted on the canvas: drop their mappings so their
    // threads stop being polled and dead ids can't loop on 404s.
    const fetchedIds = new Set(annotations.map((a) => a.id));
    for (const id of Object.keys(state.annos)) {
      if (!fetchedIds.has(id)) {
        delete state.annos[id];
        stateStore.save(stateDir, state);
        log(`pruned ${id}: deleted on canvas`);
      }
    }

    const { newTopLevel, repliesToMirror, allAccepted } = planActions(annotations, state);

    // Reconcile before posting: a send that landed but timed out locally, or
    // a crash between send and save, must not double-post. The channel is
    // the source of truth for which markers already stand. Recent history
    // suffices — an unsaved-but-landed post is by definition recent.
    let channelMarkers = null;
    if (newTopLevel.length) {
      try {
        channelMarkers = format.markerIndex(await slack.history(state.channelId, 200));
      } catch (err) {
        slackWardOk = false;
        log(`ERROR reading history to reconcile: ${err.message}; deferring new posts`);
      }
    }

    if (channelMarkers) {
      for (const anno of newTopLevel) {
        const standingTs = channelMarkers.get(anno.id);
        if (standingTs) {
          state.annos[anno.id] = {
            ts: standingTs,
            threadCursor: standingTs,
            mirroredReplyKeys: {},
            status: format.annoStatus(anno),
          };
          addPendingNudge(state, anno.author, "notes");
          stateStore.save(stateDir, state);
          log(`adopted standing post for ${anno.id} (${standingTs})`);
          continue;
        }
        try {
          const sent = await slack.send(state.channelId, format.topLevelText(anno, state.docUrl));
          state.annos[anno.id] = {
            ts: sent.ts,
            threadCursor: sent.ts,
            mirroredReplyKeys: {},
            status: format.annoStatus(anno),
          };
          addPendingNudge(state, anno.author, "notes");
          stateStore.save(stateDir, state);
          posted += 1;
          log(`posted ${anno.id} (${format.annoLabel(anno)} by ${anno.author}) → thread ${sent.ts}`);
        } catch (err) {
          slackWardOk = false;
          log(`ERROR posting ${anno.id}: ${err.message}`);
        }
      }
    }

    // Same reconcile discipline per thread for mirrored canvas replies.
    const mirrorsByAnno = new Map();
    for (const item of repliesToMirror) {
      const list = mirrorsByAnno.get(item.anno.id) || [];
      list.push(item);
      mirrorsByAnno.set(item.anno.id, list);
    }
    for (const [annoId, items] of mirrorsByAnno) {
      const mapped = state.annos[annoId];
      if (!mapped) continue; // top-level post failed this cycle; retry next
      let threadMarkers;
      try {
        threadMarkers = format.markerIndex(await slack.readThread(state.channelId, mapped.ts));
      } catch (err) {
        slackWardOk = false;
        log(`ERROR reading thread to reconcile ${annoId}: ${err.message}`);
        continue;
      }
      for (const { anno, reply, key } of items) {
        const standingTs = threadMarkers.get(`r:${annoId}:${key}`);
        if (standingTs) {
          mapped.mirroredReplyKeys[key] = standingTs;
          addPendingNudge(state, reply.author, "replies");
          stateStore.save(stateDir, state);
          log(`adopted standing mirror on ${annoId} (${standingTs})`);
          continue;
        }
        try {
          const sent = await slack.send(
            state.channelId,
            format.mirroredReplyText(anno, reply),
            mapped.ts,
          );
          mapped.mirroredReplyKeys[key] = sent.ts;
          addPendingNudge(state, reply.author, "replies");
          stateStore.save(stateDir, state);
          posted += 1;
          log(`mirrored canvas reply on ${annoId} → ${sent.ts}`);
        } catch (err) {
          slackWardOk = false;
          log(`ERROR mirroring reply on ${annoId}: ${err.message}`);
        }
      }
    }

    // Snapshot per-anno status so thread polling can skip accepted ones on
    // 304 cycles, and only trust the ETag once everything above landed.
    for (const anno of annotations) {
      if (state.annos[anno.id]) state.annos[anno.id].status = format.annoStatus(anno);
    }
    if (slackWardOk) state.etag = res.etag;
    state.allAccepted = allAccepted;
    stateStore.save(stateDir, state);
  }

  // --- owner nudge ------------------------------------------------------------
  // One coalesced digest per debounce window when non-owner canvas activity
  // accumulated; a failed send keeps the pending counts for the next cycle.
  const nudge = state.nudge;
  if (
    state.owner &&
    nudge.target !== "off" &&
    Object.keys(nudge.pending).length &&
    now() - (nudge.lastNudgeAt || 0) >= nudge.intervalMs
  ) {
    const dm = nudge.target === "dm" && nudge.ownerSlackId;
    const target = dm ? nudge.ownerSlackId : state.channelId;
    try {
      await slack.send(
        target,
        format.nudgeText({
          pending: nudge.pending,
          title: state.title || `${state.user}/${state.project}`,
          docUrl: state.docUrl,
          ownerSlackId: dm ? null : nudge.ownerSlackId,
        }),
      );
      nudge.pending = {};
      nudge.lastNudgeAt = now();
      stateStore.save(stateDir, state);
      log(`owner nudged (${dm ? "dm" : "channel"})`);
    } catch (err) {
      log(`ERROR nudging owner: ${err.message}`);
    }
  }

  // --- slack → canvas -------------------------------------------------------
  for (const [annoId, mapped] of Object.entries(state.annos)) {
    if (format.isTerminalStatus(mapped.status || mapped.state)) continue;
    let messages;
    try {
      messages = await slack.readThread(state.channelId, mapped.ts);
    } catch (err) {
      log(`ERROR reading thread for ${annoId}: ${err.message}`);
      continue;
    }
    const fresh = planIngest(annoId, messages, mapped);
    for (const msg of fresh) {
      // A POST that landed but timed out locally must not duplicate the
      // reply. If the previous cycle failed on exactly this message, check
      // the fresh annotation snapshot for it before re-sending.
      if (mapped.pendingIngestTs === msg.ts && annotations) {
        const current = annotations.find((a) => a.id === annoId);
        const landed =
          current &&
          (current.replies || []).some((r) => r.via === "slack" && r.text === msg.text);
        if (landed) {
          mapped.threadCursor = msg.ts;
          delete mapped.pendingIngestTs;
          stateStore.save(stateDir, state);
          log(`reply on ${annoId} (${msg.ts}) had landed; cursor advanced`);
          continue;
        }
      }
      try {
        await api.postReply({
          apiBase: state.apiBase,
          user: state.user,
          project: state.project,
          annoId,
          text: msg.text,
          via: "slack",
          asUser: authorForSlackUser(msg.user, state.people),
        });
        mapped.threadCursor = msg.ts;
        delete mapped.pendingIngestTs;
        stateStore.save(stateDir, state);
        ingested += 1;
        log(`ingested slack reply on ${annoId} (${msg.ts})`);
      } catch (err) {
        if (/→ 404$/.test(err.message)) {
          // Annotation vanished between fetch and post; drop the mapping.
          delete state.annos[annoId];
          stateStore.save(stateDir, state);
          log(`dropped ${annoId}: gone on canvas (404)`);
          break;
        }
        mapped.pendingIngestTs = msg.ts;
        stateStore.save(stateDir, state);
        log(`ERROR ingesting reply on ${annoId}: ${err.message}`);
        break; // keep cursor short of this message; retry next cycle
      }
    }
  }

  // --- lifecycle -------------------------------------------------------------
  if (state.allAccepted && archiveOnResolve && !state.archived) {
    try {
      if (!state.summaryTs) {
        const sent = await slack.send(
          state.channelId,
          format.summaryText(annotations || Object.keys(state.annos)),
        );
        state.summaryTs = sent.ts;
        stateStore.save(stateDir, state);
      }
      await slack.archive(state.channelId);
      state.archived = true;
      stateStore.save(stateDir, state);
      log(`all accepted: summary posted, #${state.channelName} archived`);
    } catch (err) {
      log(`ERROR archiving: ${err.message}`);
    }
  }

  return { archived: state.archived, posted, ingested, cycleOk: slackWardOk };
}

const MIN_INTERVAL_MS = 15_000;

function pseudoPortFor(channelName) {
  const digest = crypto.createHash("sha1").update(String(channelName)).digest();
  return 70_000 + (digest.readUInt16BE(0) % 9_999);
}

async function startBridge({
  docUrl,
  channelName,
  stateDir,
  intervalMs = 30_000,
  archiveOnResolve = true,
  once = false,
  quiet = false,
  owner,
  nudgeTo,
  nudgeIntervalMs,
  slack = defaultSlack,
  api = defaultApi,
}) {
  const log = makeLog(quiet);
  const state = stateStore.load(stateDir, channelName);
  if (!state) {
    throw new Error(
      `no bridge state for #${channelName}; run \`markup share <url>\` first`,
    );
  }
  if (!state.channelId) throw new Error(`state for #${channelName} has no channel id`);
  if (docUrl && state.docUrl !== docUrl) {
    throw new Error(
      `#${channelName} is bound to ${state.docUrl}, not ${docUrl}`,
    );
  }
  // The persisted apiBase is operator-supplied via `markup share`; re-check
  // it every start so an old state file can't point the bridge (and the
  // service token) at an untrusted origin.
  assertTrustedOrigin(state.apiBase);

  // Owner-nudge configuration: flags override and persist.
  if (owner) state.owner = owner;
  if (nudgeTo) {
    if (!["channel", "dm", "off"].includes(nudgeTo)) {
      throw new Error(`--nudge-to must be channel, dm, or off (got ${nudgeTo})`);
    }
    state.nudge.target = nudgeTo;
  }
  if (Number.isFinite(nudgeIntervalMs) && nudgeIntervalMs > 0) {
    state.nudge.intervalMs = nudgeIntervalMs;
  }
  if (state.nudge.target === "dm" && state.owner && !state.nudge.ownerSlackId) {
    const known = state.people[state.owner];
    if (known && known.id) {
      state.nudge.ownerSlackId = known.id;
    } else {
      try {
        const person = await slack.userByEmail(state.owner);
        if (person) state.nudge.ownerSlackId = person.id;
      } catch (_e) {
        // fall through to the warning below
      }
    }
    if (!state.nudge.ownerSlackId) {
      log(`warning: no Slack user found for owner ${state.owner}; nudging the channel instead`);
    }
  }
  stateStore.save(stateDir, state);

  if (once) {
    return runCycle({ state, stateDir, slack, api, archiveOnResolve, log });
  }

  const interval = Math.max(
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000,
    MIN_INTERVAL_MS,
  );
  // Registry entry so `markup list` / `markup stop` see the daemon. The
  // pseudo-port sits above the TCP range: it is a registry key, not a socket.
  // Derived from the channel name so two bridges never collide and a second
  // bridge for the same doc supersedes the first's entry.
  const pseudoPort = pseudoPortFor(state.channelName);
  registry.register({
    port: pseudoPort,
    sourcePath: state.docUrl,
    sourceName: `bridge → #${state.channelName}`,
    kind: "bridge",
  });
  registry.installLifecycle(pseudoPort);

  log(`bridge up: ${state.docUrl} ⇄ #${state.channelName} every ${interval / 1000}s`);
  let failures = 0;
  for (;;) {
    try {
      const { archived } = await runCycle({ state, stateDir, slack, api, archiveOnResolve, log });
      failures = 0;
      if (archived) {
        log("channel archived; bridge exiting");
        registry.unregister(pseudoPort);
        return;
      }
    } catch (err) {
      failures += 1;
      log(`cycle failed (${failures}): ${err.message}`);
    }
    const backoff = Math.min(failures, 5) || 1;
    await new Promise((resolve) => setTimeout(resolve, interval * backoff));
  }
}

module.exports = { runCycle, startBridge, pseudoPortFor, MIN_INTERVAL_MS };
