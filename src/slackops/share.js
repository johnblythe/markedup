// `markup share` — bind a published doc to a private Slack channel.
// Idempotent: re-running reuses the channel, re-invites are harmless, and the
// link card posts at most once (tracked in bridge state).

const os = require("node:os");
const stateStore = require("./state");
const format = require("./format");
const defaultSlack = require("./slack-cli");
const { parseDocUrl } = require("./api-client");

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
  if (channelOverride) return channelOverride.replace(/^#/, "");
  const prefix = test ? TEST_PREFIX : PREFIX;
  return `${prefix}${slugify(`${user}-${project}`)}`.slice(0, MAX_NAME);
}

async function fetchDocTitle(docUrl) {
  try {
    const res = await fetch(docUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim().slice(0, 120) || null : null;
  } catch (_e) {
    return null;
  }
}

async function shareDoc({
  docUrl,
  to = [],
  test = false,
  channelOverride,
  stateDir,
  sharedBy,
  slack = defaultSlack,
  log = console.log,
}) {
  const { apiBase, user, project } = parseDocUrl(docUrl);
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

  // Link card, once.
  if (!state.shareMsgTs) {
    const title = (await fetchDocTitle(docUrl)) || `${user}/${project}`;
    const sent = await slack.send(
      state.channelId,
      format.shareCardText({
        title,
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

module.exports = { shareDoc, channelNameFor, slugify, PREFIX, TEST_PREFIX };
