const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stateStore = require("../src/slackops/state");
const format = require("../src/slackops/format");
const { planActions, planIngest, authorForSlackUser } = require("../src/slackops/plan");
const { runCycle } = require("../src/slackops/bridge");
const { shareDoc, channelNameFor, slugify } = require("../src/slackops/share");
const { parseDocUrl } = require("../src/slackops/api-client");
const { startStub } = require("./stub-api");

// ---------------------------------------------------------------------------
// fakes

function fakeSlack() {
  let n = 0;
  const threads = new Map();
  const slack = {
    sends: [],
    archived: false,
    async send(channelId, text, threadTs) {
      n += 1;
      const ts = `1000.${String(n).padStart(6, "0")}`;
      slack.sends.push({ channelId, text, threadTs: threadTs || null, ts });
      if (threadTs) {
        const arr = threads.get(threadTs) || [];
        arr.push({ ts, thread_ts: threadTs, text, user: "UBRIDGE" });
        threads.set(threadTs, arr);
      } else {
        threads.set(ts, [{ ts, thread_ts: ts, text, user: "UBRIDGE" }]);
      }
      return { ts, threadTs: threadTs || null };
    },
    async readThread(_channelId, threadTs) {
      return threads.get(threadTs) || [];
    },
    async archive() {
      slack.archived = true;
    },
    // test helper: a human typing in the Slack app (no marker, no suffix)
    addHuman(threadTs, text, ts, user = "UHUMAN") {
      const arr = threads.get(threadTs) || [];
      arr.push({ ts, thread_ts: threadTs, text, user });
      threads.set(threadTs, arr);
    },
  };
  return slack;
}

function fakeApi(initial = []) {
  let etagN = 1;
  const annos = new Map(initial.map((a) => [a.id, a]));
  const api = {
    annos,
    posted: [],
    bump() {
      etagN += 1;
    },
    async fetchAnnotations({ etag }) {
      const cur = `"f-${etagN}"`;
      if (etag === cur) return { status: 304 };
      return {
        status: 200,
        etag: cur,
        annotations: [...annos.values()].map((a) => JSON.parse(JSON.stringify(a))),
      };
    },
    async postReply({ annoId, text, via, asUser }) {
      api.posted.push({ annoId, text, via, asUser });
      const anno = annos.get(annoId);
      anno.replies.push({ author: asUser, text, at: new Date().toISOString(), via });
      etagN += 1;
      return anno;
    },
  };
  return api;
}

function anno(id, extra = {}) {
  return {
    id,
    mode: "pin",
    pinNum: 1,
    cssPath: "body > table > tr",
    note: `note for ${id}`,
    author: "eng@launchdarkly.com",
    createdAt: "2026-08-27T00:00:00Z",
    updatedAt: "2026-08-27T00:00:00Z",
    state: "open",
    replies: [],
    ...extra,
  };
}

function freshState(stateDir) {
  const state = stateStore.emptyState({
    docUrl: "http://127.0.0.1:9/eng/audit/",
    apiBase: "http://127.0.0.1:9",
    user: "eng",
    project: "audit",
    channelName: "markd-test-eng-audit",
  });
  state.channelId = "CTEST";
  stateStore.save(stateDir, state);
  return state;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "markup-slackops-"));
}

const quiet = { log: () => {} };

// ---------------------------------------------------------------------------
// bridge cycles

test("first cycle posts one top-level per annotation and persists mapping", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a"), anno("anno-b", { mode: "text", anchorText: "W10 dips" })]);

  const result = await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });

  assert.equal(result.posted, 2);
  assert.equal(slack.sends.length, 2);
  assert.ok(slack.sends.every((s) => s.threadTs === null));
  assert.ok(slack.sends[0].text.includes("[md:anno-a]"));

  const reloaded = stateStore.load(stateDir, state.channelName);
  assert.ok(reloaded.annos["anno-a"].ts);
  assert.ok(reloaded.annos["anno-b"].ts);
  assert.equal(reloaded.etag, `"f-1"`);
});

test("restart: cycles post nothing new on 304 and on unchanged 200", async () => {
  const stateDir = tmpDir();
  let state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.length, 1);

  // Simulated restart: reload state from disk. 304 path.
  state = stateStore.load(stateDir, state.channelName);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.length, 1);

  // Fresh etag but same content: plan must still find nothing to do.
  api.bump();
  state = stateStore.load(stateDir, state.channelName);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.length, 1);
});

test("canvas reply mirrors once and does not advance the thread cursor", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  const topTs = state.annos["anno-a"].ts;

  api.annos.get("anno-a").replies.push({
    author: "john@launchdarkly.com",
    text: "agreed, fix the caption",
    at: "2026-08-27T01:00:00Z",
    via: "canvas",
  });
  api.bump();

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  const mirrored = slack.sends.filter((s) => s.threadTs === topTs);
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0].text.includes("[md:r:anno-a:"));
  assert.equal(state.annos["anno-a"].threadCursor, topTs, "mirror must not move the cursor");

  api.bump();
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.filter((s) => s.threadTs === topTs).length, 1);
});

test("slack human reply ingests once with via slack; bridge posts skipped", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  const topTs = state.annos["anno-a"].ts;

  slack.addHuman(topTs, "can you add the denominator here?", "2000.000001");
  slack.addHuman(topTs, "bridge echo should be skipped [md:anno-a]", "2000.000002", "UBRIDGE");

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(api.posted.length, 1);
  assert.deepEqual(
    { via: api.posted[0].via, asUser: api.posted[0].asUser, text: api.posted[0].text },
    { via: "slack", asUser: "slack:UHUMAN", text: "can you add the denominator here?" },
  );
  assert.equal(state.annos["anno-a"].threadCursor, "2000.000001");

  // Next cycle re-reads the same thread: nothing new to ingest, and the
  // via:"slack" reply now in the API must not be echoed back to Slack.
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(api.posted.length, 1);
  assert.equal(slack.sends.filter((s) => s.threadTs === topTs).length, 0);
});

test("people map attributes slack replies to an email", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  state.people["eng@launchdarkly.com"] = { id: "UHUMAN", name: "The Engineer" };
  stateStore.save(stateDir, state);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  slack.addHuman(state.annos["anno-a"].ts, "shipping the fix", "2000.000001");
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });

  assert.equal(api.posted[0].asUser, "eng@launchdarkly.com");
});

test("all resolved posts summary and archives exactly once", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a"), anno("anno-b")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(state.archived, false);

  api.annos.get("anno-a").state = "resolved";
  api.annos.get("anno-b").state = "resolved";
  api.bump();

  const result = await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(result.archived, true);
  assert.equal(slack.archived, true);
  const summaries = slack.sends.filter((s) => s.text.includes("[md:summary]"));
  assert.equal(summaries.length, 1);

  api.bump();
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.filter((s) => s.text.includes("[md:summary]")).length, 1);
});

test("archiveOnResolve false leaves the channel open", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a", { state: "resolved" })]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: false, ...quiet });
  assert.equal(slack.archived, false);
  assert.equal(state.archived, false);
});

// ---------------------------------------------------------------------------
// plan / format / parse units

test("planActions: slack-origin replies are never mirrored back", () => {
  const state = { annos: { "anno-a": { ts: "1", mirroredReplyKeys: {}, threadCursor: "1" } } };
  const a = anno("anno-a", {
    replies: [{ author: "x", text: "from slack", at: "t", via: "slack" }],
  });
  const { repliesToMirror } = planActions([a], state);
  assert.equal(repliesToMirror.length, 0);
});

test("planIngest skips top-level, cursor, and marked messages", () => {
  const mapped = { ts: "10.0", threadCursor: "10.5", mirroredReplyKeys: {} };
  const messages = [
    { ts: "10.0", text: "top level [md:anno-a]", user: "U1" },
    { ts: "10.3", text: "before cursor", user: "U1" },
    { ts: "10.6", text: "bridge post [md:r:anno-a:abc]", user: "U1" },
    { ts: "10.9", text: "real human reply\n\n_via LD Research :robot_face:_", user: "U2" },
  ];
  const fresh = planIngest("anno-a", messages, mapped);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0], { ts: "10.9", user: "U2", text: "real human reply" });
});

test("unescapeSlackText unwraps mailto, links, and entities", () => {
  assert.equal(
    format.unescapeSlackText("<mailto:a@b.c|a@b.c> said <https://x.dev/p|the page> &amp; more <https://y.dev>"),
    "a@b.c said the page & more https://y.dev",
  );
});

test("tsLte compares microseconds beyond float precision", () => {
  const { tsLte } = require("../src/slackops/plan");
  assert.equal(tsLte("1787881105.402179", "1787881105.402180"), true);
  assert.equal(tsLte("1787881105.402180", "1787881105.402179"), false);
  assert.equal(tsLte("1787881105.402179", "1787881105.402179"), true);
  assert.equal(tsLte("1787881104.9", "1787881105.1"), true);
});

test("planIngest unescapes slack markup in human replies", () => {
  const mapped = { ts: "10.0", threadCursor: "10.0", mirroredReplyKeys: {} };
  const fresh = planIngest("anno-a", [{ ts: "10.5", text: "ping <mailto:e@x.co|e@x.co>", user: "U2" }], mapped);
  assert.equal(fresh[0].text, "ping e@x.co");
});

test("shareDoc reopens an archived channel for a new round", async () => {
  const stateDir = tmpDir();
  const state = stateStore.emptyState({
    docUrl: "http://127.0.0.1:1/eng/audit/",
    apiBase: "http://127.0.0.1:1",
    user: "eng",
    project: "audit",
    channelName: "markd-test-eng-audit",
  });
  state.channelId = "COLD";
  state.archived = true;
  state.summaryTs = "999.1";
  state.shareMsgTs = "998.1";
  stateStore.save(stateDir, state);

  const slack = fakeSlack();
  let unarchived = false;
  slack.unarchive = async (id) => {
    assert.equal(id, "COLD");
    unarchived = true;
  };

  await shareDoc({
    docUrl: "http://127.0.0.1:1/eng/audit/",
    test: true,
    stateDir,
    slack,
    log: () => {},
  });
  assert.equal(unarchived, true);
  const reloaded = stateStore.load(stateDir, "markd-test-eng-audit");
  assert.equal(reloaded.archived, false);
  assert.equal(reloaded.summaryTs, null);
  assert.equal(reloaded.shareMsgTs, "998.1", "existing card is not re-posted");
});

test("authorForSlackUser falls back to opaque tag", () => {
  assert.equal(authorForSlackUser("U9", { "a@b.c": { id: "U1" } }), "slack:U9");
  assert.equal(authorForSlackUser("U1", { "a@b.c": { id: "U1" } }), "a@b.c");
});

test("replyKey is stable and content-sensitive", () => {
  const r = { author: "a", at: "t", text: "x" };
  assert.equal(format.replyKey(r), format.replyKey({ ...r }));
  assert.notEqual(format.replyKey(r), format.replyKey({ ...r, text: "y" }));
});

test("parseDocUrl handles trailing files and rejects short paths", () => {
  assert.deepEqual(parseDocUrl("https://h.dev/eng/audit/"), {
    apiBase: "https://h.dev",
    user: "eng",
    project: "audit",
  });
  assert.deepEqual(parseDocUrl("https://h.dev/eng/audit/index.html").project, "audit");
  assert.throws(() => parseDocUrl("https://h.dev/only/"));
  assert.throws(() => parseDocUrl("not a url"));
});

test("channelNameFor: prefixes, override, slug hygiene", () => {
  assert.equal(channelNameFor({ user: "Eng", project: "My_Audit!", test: true }), "markd-test-eng-my-audit");
  assert.equal(channelNameFor({ user: "e", project: "p", test: false }), "markd-e-p");
  assert.equal(channelNameFor({ user: "e", project: "p", channelOverride: "#custom" }), "custom");
  assert.equal(slugify("--Weird  Name--"), "weird-name");
});

// ---------------------------------------------------------------------------
// share flow

test("shareDoc creates channel, posts card once, tolerates re-share", async () => {
  const stateDir = tmpDir();
  const slack = fakeSlack();
  slack.createChannel = async (name) => ({ channelId: "CNEW", name });
  slack.userByEmail = async (email) => ({ id: "UENG", name: email });
  slack.invite = async () => ({ ok: true });
  slack.setTopic = async () => ({ ok: true });

  const opts = {
    docUrl: "http://127.0.0.1:1/eng/audit/", // unreachable: title falls back
    to: ["eng@launchdarkly.com"],
    test: true,
    stateDir,
    sharedBy: "john",
    slack,
    log: () => {},
  };
  const first = await shareDoc(opts);
  assert.equal(first.channelName, "markd-test-eng-audit");
  const cards = slack.sends.filter((s) => s.text.includes("[md:share]"));
  assert.equal(cards.length, 1);
  assert.ok(cards[0].text.includes("eng/audit"));

  const again = await shareDoc(opts);
  assert.equal(again.channelId, "CNEW");
  assert.equal(slack.sends.filter((s) => s.text.includes("[md:share]")).length, 1);

  const state = stateStore.load(stateDir, first.channelName);
  assert.deepEqual(state.people["eng@launchdarkly.com"], { id: "UENG", name: "eng@launchdarkly.com" });
});

// ---------------------------------------------------------------------------
// stub API contract

test("stub API: author stamping, etag/304, replies, 404", async () => {
  const { server, url } = await startStub({});
  try {
    const put = await fetch(`${url}/api/eng/audit/annotations/anno-x`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "eng@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", note: "hi", author: "spoofed@evil" }),
    });
    const anno1 = await put.json();
    assert.equal(anno1.author, "eng@launchdarkly.com", "server stamps author, ignores client");
    assert.equal(anno1.state, "open");

    const get1 = await fetch(`${url}/api/eng/audit/annotations`);
    const body1 = await get1.json();
    assert.equal(body1.annotations.length, 1);

    const get2 = await fetch(`${url}/api/eng/audit/annotations`, {
      headers: { "If-None-Match": body1.etag },
    });
    assert.equal(get2.status, 304);

    const rep = await fetch(`${url}/api/eng/audit/annotations/anno-x/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ text: "looks good", via: "slack" }),
    });
    const anno2 = await rep.json();
    assert.equal(anno2.replies.length, 1);
    assert.equal(anno2.replies[0].via, "slack");
    assert.equal(anno2.replies[0].author, "john@launchdarkly.com");

    const missing = await fetch(`${url}/api/eng/audit/annotations/nope/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(missing.status, 404);

    const me = await fetch(`${url}/api/me`, { headers: { "X-Markup-User": "a@b.c" } });
    assert.deepEqual(await me.json(), { email: "a@b.c" });
  } finally {
    server.close();
  }
});
