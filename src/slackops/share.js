// `markup share` — bind a published doc to a private Slack channel.
// Idempotent: re-running reuses the channel, re-invites are harmless, and the
// link card posts at most once (tracked in bridge state).

const os = require("node:os");
const stateStore = require("./state");
const format = require("./format");
const defaultSlack = require("./slack-cli");
const { parseDocUrl, assertTrustedOrigin, authHeaders, fetchAnnotations } = require("./api-client");

const PREFIX = "markd-";
const TEST_PREFIX = "markd-test-";
// Slack channel names cap at 80 chars, lowercase.
const MAX_NAME = 76;

function slugify(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function channelNameFor({ user, project, test, channelOverride }) {
  if (channelOverride) {
    // Slugified so the name is Slack-legal and can't traverse out of the
    // state directory (the state file is named after the channel).
    const clean = slugify(channelOverride.replace(/^#/, "")).slice(0, MAX_NAME);
    if (clean) return clean;
  }
  const prefix = test ? TEST_PREFIX : PREFIX;
  return `${prefix}${slugify(`${user}-${project}`)}`.slice(0, MAX_NAME);
}

async function fetchDocTitle(docUrl) {
  try {
    const origin = new URL(docUrl).origin;
    const res = await fetch(docUrl, {
      headers: authHeaders(null, origin),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    // An auth wall redirects off-origin (e.g. Cloudflare Access login);
    // its page title must not end up on the share card.
    if (new URL(res.url).origin !== origin) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim().slice(0, 120) || null : null;
  } catch (_e) {
    return null;
  }
}

// A share run right after `markup publish` can race site propagation; a few
// short retries absorb that without failing the share (the bridge catches up
// regardless).
async function probeCanvas(target, delays, log) {
  const waits = [0, ...delays];
  for (let i = 0; i < waits.length; i++) {
    if (waits[i]) await new Promise((resolve) => setTimeout(resolve, waits[i]));
    try {
      await fetchAnnotations(target);
      return true;
    } catch (err) {
      if (i === waits.length - 1) {
        log(`warning: canvas not reachable yet (${err.message}); sharing anyway`);
      }
    }
  }
  return false;
}

async function shareDoc({
  docUrl,
  to = [],
  test = false,
  channelOverride,
  stateDir,
  sharedBy,
  owner,
  probeDelays = [2_000, 5_000],
  slack = defaultSlack,
  log = console.log,
}) {
  const { apiBase, user, project } = parseDocUrl(docUrl);
  // Refuse untrusted origins before anything is persisted or contacted.
  assertTrustedOrigin(apiBase);
  await probeCanvas({ apiBase, user, project }, probeDelays, log);
  const channelName = channelNameFor({ user, project, test, channelOverride });

  let state =
    stateStore.load(stateDir, channelName) ||
    stateStore.emptyState({ docUrl, apiBase, user, project, channelName });

  // Channel: reuse from state, adopt an existing same-name channel, or create.
  if (!state.channelId) {
    try {
      const created = await slack.createChannel(channelName);
      state.channelId = created.channelId;
      log(`created private channel #${channelName} (${created.channelId})`);
    } catch (err) {
      if (/name_taken|already/i.test(err.message)) {
        const info = await slack.channelInfo(channelName);
        if (!info) throw new Error(`#${channelName} exists but could not be resolved: ${err.message}`);
        state.channelId = info.channelId;
        log(`reusing existing channel #${channelName} (${info.channelId})`);
      } else {
        throw err;
      }
    }
    stateStore.save(stateDir, state);
  } else if (state.archived) {
    // A resolved review archived the channel; a re-share means a new round.
    await slack.unarchive(state.channelId);
    state.archived = false;
    state.summaryTs = null;
    stateStore.save(stateDir, state);
    log(`reopened archived channel #${channelName} for a new round`);
  } else {
    log(`channel #${channelName} already bound (${state.channelId})`);
  }

  // Owner (for the activity digest): persisted; Slack id looked up so DM
  // nudges and mentions work without another lookup later.
  if (owner) {
    state.owner = owner;
    if (!state.nudge.ownerSlackId) {
      try {
        const person = await slack.userByEmail(owner);
        if (person) {
          state.people[owner] = person;
          state.nudge.ownerSlackId = person.id;
        }
      } catch (err) {
        log(`warning: lookup failed for owner ${owner}: ${err.message}`);
      }
    }
    stateStore.save(stateDir, state);
  }

  // Invites: look people up first so Slack replies can be attributed to an
  // email later; the invite itself tolerates already-in-channel.
  const emails = to.map((e) => e.trim()).filter(Boolean);
  for (const email of emails) {
    if (state.people[email]) continue;
    try {
      const person = await slack.userByEmail(email);
      if (person) state.people[email] = person;
      else log(`warning: no Slack user found for ${email}`);
    } catch (err) {
      log(`warning: lookup failed for ${email}: ${err.message}`);
    }
  }
  if (emails.length) {
    try {
      await slack.invite(state.channelId, emails);
      log(`invited: ${emails.join(", ")}`);
    } catch (err) {
      log(`warning: invite failed: ${err.message}`);
    }
    stateStore.save(stateDir, state);
  }

  // Title persisted for reuse by the bridge's digest messages.
  if (!state.title) {
    state.title = (await fetchDocTitle(docUrl)) || `${user}/${project}`;
    stateStore.save(stateDir, state);
  }

  // Link card, once.
  if (!state.shareMsgTs) {
    const sent = await slack.send(
      state.channelId,
      format.shareCardText({
        title: state.title,
        docUrl,
        sharedBy: sharedBy || os.userInfo().username,
      }),
    );
    state.shareMsgTs = sent.ts;
    stateStore.save(stateDir, state);
    try {
      await slack.setTopic(state.channelId, docUrl);
    } catch (_e) {
      // Topic is a nicety; the card carries the link.
    }
    log(`link card posted`);
  }

  return { channelId: state.channelId, channelName, stateFile: stateStore.stateFile(stateDir, channelName) };
}

module.exports = { shareDoc, channelNameFor, slugify, fetchDocTitle, PREFIX, TEST_PREFIX };
