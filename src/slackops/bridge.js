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

const registry = require("../registry");
const stateStore = require("./state");
const format = require("./format");
const { planActions, planIngest, authorForSlackUser } = require("./plan");
const defaultSlack = require("./slack-cli");
const defaultApi = require("./api-client");

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function makeLog(quiet) {
  return quiet ? () => {} : (msg) => console.log(`[${ts()}] ${msg}`);
}

// Runs one sync cycle against injected slack/api drivers. Mutates and
// persists `state`. Returns { archived, posted, ingested, cycleOk }.
async function runCycle({ state, stateDir, slack, api, archiveOnResolve, log }) {
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
    const { newTopLevel, repliesToMirror, allAccepted } = planActions(annotations, state);

    for (const anno of newTopLevel) {
      try {
        const sent = await slack.send(state.channelId, format.topLevelText(anno, state.docUrl));
        state.annos[anno.id] = {
          ts: sent.ts,
          threadCursor: sent.ts,
          mirroredReplyKeys: {},
          status: format.annoStatus(anno),
        };
        stateStore.save(stateDir, state);
        posted += 1;
        log(`posted ${anno.id} (${format.annoLabel(anno)} by ${anno.author}) → thread ${sent.ts}`);
      } catch (err) {
        slackWardOk = false;
        log(`ERROR posting ${anno.id}: ${err.message}`);
      }
    }

    for (const { anno, reply, key } of repliesToMirror) {
      const mapped = state.annos[anno.id];
      if (!mapped) continue; // top-level post failed this cycle; retry next
      try {
        const sent = await slack.send(
          state.channelId,
          format.mirroredReplyText(anno, reply),
          mapped.ts,
        );
        mapped.mirroredReplyKeys[key] = sent.ts;
        stateStore.save(stateDir, state);
        posted += 1;
        log(`mirrored canvas reply on ${anno.id} → ${sent.ts}`);
      } catch (err) {
        slackWardOk = false;
        log(`ERROR mirroring reply on ${anno.id}: ${err.message}`);
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
        stateStore.save(stateDir, state);
        ingested += 1;
        log(`ingested slack reply on ${annoId} (${msg.ts})`);
      } catch (err) {
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

async function startBridge({
  docUrl,
  channelName,
  stateDir,
  intervalMs = 30_000,
  archiveOnResolve = true,
  once = false,
  quiet = false,
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

  if (once) {
    return runCycle({ state, stateDir, slack, api, archiveOnResolve, log });
  }

  const interval = Math.max(
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 30_000,
    MIN_INTERVAL_MS,
  );
  // Registry entry so `markup list` / `markup stop` see the daemon. The
  // pseudo-port sits above the TCP range: it is a registry key, not a socket.
  const pseudoPort = 70_000 + (process.pid % 9_999);
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

module.exports = { runCycle, startBridge, MIN_INTERVAL_MS };
