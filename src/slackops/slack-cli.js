// Thin wrapper around John's `ld slack` CLI (cookie-authed, acts as the
// logged-in user). Every call shells out via execFile — no shell, args passed
// verbatim — and asks for JSON output. Reads that must see fresh data pass
// --ttl 0 to bypass the CLI's cache.
//
// Channel IDs, not names, everywhere after creation: name resolution inside
// the CLI paginates the whole workspace and times out on large ones.

const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");

const LD_BIN =
  process.env.MARKUP_LD_BIN || path.join(os.homedir(), "code", "research", "ld");

const DEFAULT_TIMEOUT_MS = 60_000;

function run(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      LD_BIN,
      ["slack", ...args, "--output", "json"],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || "").trim().slice(0, 500);
          return reject(new Error(`ld slack ${args[0]} failed: ${detail}`));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (_e) {
          const detail = (stdout || "").trim().slice(0, 500);
          reject(new Error(`ld slack ${args[0]} returned non-JSON: ${detail}`));
        }
      },
    );
  });
}

async function createChannel(name) {
  const res = await run(["create-channel", name, "--private"]);
  if (!res.channel_id) throw new Error(`create-channel returned no channel_id for ${name}`);
  return { channelId: res.channel_id, name: res.name || name };
}

async function send(channelId, text, threadTs) {
  const args = ["send", channelId, text];
  if (threadTs) args.push("--thread", String(threadTs));
  const res = await run(args);
  if (!res.ok || !res.ts) throw new Error(`send to ${channelId} not ok`);
  return { ts: res.ts, threadTs: res.thread_ts || null };
}

// Returns the thread's messages, including the top-level message itself.
async function readThread(channelId, threadTs) {
  const res = await run(["thread", `${channelId}/${threadTs}`, "--ttl", "0"]);
  return Array.isArray(res.messages) ? res.messages : [];
}

async function history(channelId, limit = 100) {
  const res = await run(["history", channelId, "--limit", String(limit), "--ttl", "0"]);
  return Array.isArray(res.messages) ? res.messages : [];
}

async function invite(channelId, emails) {
  if (!emails.length) return null;
  return run(["invite", channelId, ...emails]);
}

async function setTopic(channelId, topic) {
  return run(["set-topic", channelId, topic]);
}

async function archive(channelId) {
  return run(["archive", channelId]);
}

async function unarchive(channelId) {
  return run(["unarchive", channelId]);
}

async function userByEmail(email) {
  const res = await run(["user", email, "--ttl", "0"]);
  return res && res.user_id ? { id: res.user_id, name: res.name || null } : null;
}

async function channelInfo(nameOrId) {
  const res = await run(["channel-info", nameOrId, "--ttl", "0"]);
  const id = res.channel_id || res.id;
  return id ? { channelId: id, name: res.name || nameOrId } : null;
}

module.exports = {
  LD_BIN,
  createChannel,
  send,
  readThread,
  history,
  invite,
  setTopic,
  archive,
  unarchive,
  userByEmail,
  channelInfo,
};
