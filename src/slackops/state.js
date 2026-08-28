// Bridge state: one JSON file per shared doc (keyed by channel name), atomic
// writes so a crash mid-save never corrupts the mapping. Losing this file
// means the bridge would re-post every annotation, so it is treated as
// canonical and always written before the loop moves on.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_DIR = path.join(os.homedir(), ".markup", "bridge");

function stateFile(stateDir, channelName) {
  return path.join(stateDir || DEFAULT_DIR, `${channelName}.json`);
}

function emptyState({ docUrl, apiBase, user, project, channelName }) {
  return {
    version: 1,
    docUrl,
    apiBase,
    user,
    project,
    channelId: null,
    channelName,
    shareMsgTs: null,
    summaryTs: null,
    archived: false,
    etag: null,
    // email → { id, name } for people invited via `markup share`; used to
    // attribute Slack replies back to a human-readable author.
    people: {},
    // annoId → { ts, mirroredReplyKeys: { key: slackTs }, threadCursor, status }
    annos: {},
  };
}

function load(stateDir, channelName) {
  const file = stateFile(stateDir, channelName);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (parsed.version !== 1) throw new Error(`unsupported state version in ${file}`);
  return parsed;
}

function save(stateDir, state) {
  const dir = stateDir || DEFAULT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFile(dir, state.channelName);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { DEFAULT_DIR, stateFile, emptyState, load, save };
