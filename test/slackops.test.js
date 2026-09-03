const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const http = require("node:http");

const stateStore = require("../src/slackops/state");
const format = require("../src/slackops/format");
const { planActions, planIngest, authorForSlackUser } = require("../src/slackops/plan");
const { runCycle, pseudoPortFor } = require("../src/slackops/bridge");
const { shareDoc, channelNameFor, slugify, fetchDocTitle } = require("../src/slackops/share");
const { parseDocUrl, resolveDoc, assertTrustedOrigin, authHeaders } = require("../src/slackops/api-client");
const { buildArgs } = require("../src/slackops/slack-cli");
const { startStub } = require("./stub-api");

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.finally === "function") return out.finally(restore);
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
  }
}

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
    async history(_channelId, _limit) {
      return [...threads.values()].map((arr) => arr[0]);
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

// Ruled wire shape (contract, 2026-08-27): nested anchor fingerprint + status.
function anno(id, extra = {}) {
  return {
    id,
    mode: "pin",
    pinNum: 1,
    anchor: { cssPath: "body > table > tr", tagName: "tr" },
    note: `note for ${id}`,
    author: "eng@launchdarkly.com",
    createdAt: "2026-08-27T00:00:00Z",
    updatedAt: "2026-08-27T00:00:00Z",
    status: "open",
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
  const api = fakeApi([
    anno("anno-a"),
    anno("anno-b", { mode: "text", anchor: { cssPath: "body > p", anchorText: "W10 dips" } }),
  ]);

  const result = await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });

  assert.equal(result.posted, 2);
  assert.equal(slack.sends.length, 2);
  assert.ok(slack.sends.every((s) => s.threadTs === null));
  assert.ok(slack.sends[0].text.includes("[md:anno-a]"));
  assert.ok(slack.sends[1].text.includes("> W10 dips"), "nested anchorText renders as quote");

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

test("all accepted posts summary and archives exactly once", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a"), anno("anno-b")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(state.archived, false);

  api.annos.get("anno-a").status = "accepted";
  api.annos.get("anno-b").status = "accepted";
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
  const api = fakeApi([anno("anno-a", { status: "accepted" })]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: false, ...quiet });
  assert.equal(slack.archived, false);
  assert.equal(state.archived, false);
});

// ---------------------------------------------------------------------------
// local serve root URLs (persona sandbox)

function fakeServe(html) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

test("resolveDoc: localhost serve root discovers the local project, strips persona", async () => {
  const { server, origin } = await fakeServe(
    '<html><head><title>Sandbox</title></head><body><script>fetch("/api/local/board-audit/annotations")</script></body></html>',
  );
  try {
    const resolved = await resolveDoc(`${origin}/?persona=jb`);
    assert.deepEqual(resolved, {
      apiBase: origin,
      user: "local",
      project: "board-audit",
      docUrl: `${origin}/`,
    });
  } finally {
    server.close();
  }
});

test("resolveDoc: path URLs resolve as before, per-viewer params stripped", async () => {
  const resolved = await resolveDoc("https://h.dev/eng/audit/?persona=jb&as=x");
  assert.deepEqual(resolved, {
    apiBase: "https://h.dev",
    user: "eng",
    project: "audit",
    docUrl: "https://h.dev/eng/audit/",
  });
});

test("resolveDoc: non-localhost root keeps the existing refusal", async () => {
  await assert.rejects(resolveDoc("https://evil.dev/"), /cannot derive/);
});

test("resolveDoc: undiscoverable local root fails with guidance", async () => {
  const { server, origin } = await fakeServe("<html><body>no overlay here</body></html>");
  try {
    await assert.rejects(resolveDoc(`${origin}/`), /could not discover the local project/);
  } finally {
    server.close();
  }
});

test("shareDoc on a serve root: local project state, plain root URL on the card", async () => {
  const { server, origin } = await fakeServe(
    '<html><head><title>Sandbox Doc</title></head><body><script src="/api/local/board-audit/client.js"></script></body></html>',
  );
  const stateDir = tmpDir();
  const slack = fakeSlack();
  slack.createChannel = async (name) => ({ channelId: "CLOCAL", name });
  slack.setTopic = async () => ({ ok: true });
  try {
    const result = await shareDoc({
      docUrl: `${origin}/?persona=jb`,
      test: true,
      stateDir,
      probeDelays: [],
      slack,
      log: () => {},
    });
    assert.equal(result.channelName, "markd-test-local-board-audit");
    const state = stateStore.load(stateDir, result.channelName);
    assert.equal(state.user, "local");
    assert.equal(state.project, "board-audit");
    assert.equal(state.docUrl, `${origin}/`, "persisted URL is the plain root");
    const card = slack.sends.find((s) => s.text.includes("[md:share]"));
    assert.ok(card.text.includes(`${origin}/`));
    assert.ok(!card.text.includes("persona"), "card carries no persona param");
    assert.ok(card.text.includes("Sandbox Doc"));
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// owner nudge digest

const OWNER = "john@launchdarkly.com";

function ownedState(stateDir) {
  const state = freshState(stateDir);
  state.owner = OWNER;
  stateStore.save(stateDir, state);
  return state;
}

function nudges(slack) {
  return slack.sends.filter((s) => s.text.includes("[md:nudge]"));
}

test("a burst of non-owner notes becomes one digest, not per-note spam", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a"), anno("anno-b"), anno("anno-c")]);
  let clock = 1_000_000;
  const now = () => clock;

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now, ...quiet });
  let digests = nudges(slack);
  assert.equal(digests.length, 1, "one digest for the whole burst");
  assert.equal(digests[0].channelId, "CTEST");
  assert.ok(digests[0].text.includes("eng@launchdarkly.com left 3 new notes"));
  assert.ok(digests[0].text.includes(state.docUrl));
  assert.deepEqual(state.nudge.pending, {});
  assert.equal(state.nudge.lastNudgeAt, clock);

  // A canvas reply by a second person, mirrored next cycle, digests too.
  api.annos.get("anno-c").replies.push({
    author: "priya@launchdarkly.com",
    text: "same here",
    at: "t",
    via: "canvas",
  });
  api.bump();
  clock += 700_000;
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now, ...quiet });
  digests = nudges(slack);
  assert.equal(digests.length, 2);
  assert.ok(digests[1].text.includes("priya@launchdarkly.com left 1 reply"));
});

test("the owner's own activity never nudges", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a", { author: OWNER })]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => 1_000_000, ...quiet });
  assert.equal(nudges(slack).length, 0);
  assert.deepEqual(state.nudge.pending, {});
});

test("digests debounce: quiet window holds, then coalesces", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  state.nudge.intervalMs = 600_000;
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);
  let clock = 1_000_000;
  const now = () => clock;

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now, ...quiet });
  assert.equal(nudges(slack).length, 1);

  // More activity inside the quiet window: accumulate, don't post.
  clock += 1_000;
  api.annos.set("anno-b", anno("anno-b"));
  api.annos.set("anno-c", anno("anno-c"));
  api.bump();
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now, ...quiet });
  assert.equal(nudges(slack).length, 1, "still one digest");
  assert.equal(state.nudge.pending["eng@launchdarkly.com"].notes, 2);

  // Window elapses: one coalesced digest for both.
  clock += 700_000;
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now, ...quiet });
  const digests = nudges(slack);
  assert.equal(digests.length, 2);
  assert.ok(digests[1].text.includes("2 new notes"));
});

test("slack-ingested replies do not feed the digest", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a", { author: OWNER })]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => 1_000_000, ...quiet });
  slack.addHuman(state.annos["anno-a"].ts, "from slack side", "2000.000001");
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => 2_000_000, ...quiet });
  assert.equal(api.posted.length, 1, "reply ingested");
  assert.deepEqual(state.nudge.pending, {}, "no digest pressure from slack replies");
  assert.equal(nudges(slack).length, 0);
});

test("a failed digest send keeps pending counts for the next cycle", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  const slack = fakeSlack();
  const realSend = slack.send;
  slack.send = async (channelId, text, threadTs) => {
    if (text.includes("[md:nudge]")) throw new Error("slack down");
    return realSend(channelId, text, threadTs);
  };
  const api = fakeApi([anno("anno-a")]);
  let clock = 1_000_000;

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => clock, ...quiet });
  assert.equal(state.nudge.pending["eng@launchdarkly.com"].notes, 1, "pending kept");
  assert.equal(state.nudge.lastNudgeAt, null);

  slack.send = realSend;
  clock += 700_000;
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => clock, ...quiet });
  assert.equal(nudges(slack).length, 1, "delivered on retry");
  assert.deepEqual(state.nudge.pending, {});
});

test("dm target sends the digest to the owner's user id", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  state.nudge.target = "dm";
  state.nudge.ownerSlackId = "UOWNER";
  stateStore.save(stateDir, state);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => 1_000_000, ...quiet });
  const digests = nudges(slack);
  assert.equal(digests.length, 1);
  assert.equal(digests[0].channelId, "UOWNER");
  assert.ok(!digests[0].text.includes("<@UOWNER>"), "no self-mention inside a DM");
});

test("nudge target off disables digests", async () => {
  const stateDir = tmpDir();
  const state = ownedState(stateDir);
  state.nudge.target = "off";
  stateStore.save(stateDir, state);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);

  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, now: () => 1_000_000, ...quiet });
  assert.equal(nudges(slack).length, 0);
});

test("nudgeText: counts, pluralization, mention, marker", () => {
  const text = format.nudgeText({
    pending: {
      "corbin@x.co": { notes: 3, replies: 0 },
      "priya@x.co": { notes: 1, replies: 2 },
    },
    title: "Board Audit",
    docUrl: "https://h.dev/e/p/",
    ownerSlackId: "U1",
  });
  assert.ok(text.includes("<@U1>"));
  assert.ok(text.includes("*Board Audit*"));
  assert.ok(text.includes("corbin@x.co left 3 new notes"));
  assert.ok(text.includes("priya@x.co left 1 new note and 2 replies"));
  assert.ok(text.includes("[md:nudge]"));
});

test("shareDoc --owner persists owner and slack id", async () => {
  const stateDir = tmpDir();
  const slack = fakeSlack();
  slack.createChannel = async (name) => ({ channelId: "CNEW", name });
  slack.userByEmail = async (email) => ({ id: "UJOHN", name: email });
  slack.setTopic = async () => ({ ok: true });

  await shareDoc({
    docUrl: "http://127.0.0.1:1/eng/audit/",
    test: true,
    owner: OWNER,
    stateDir,
    probeDelays: [],
    slack,
    log: () => {},
  });
  const state = stateStore.load(stateDir, "markd-test-eng-audit");
  assert.equal(state.owner, OWNER);
  assert.equal(state.nudge.ownerSlackId, "UJOHN");
});

test("shareDoc survives a not-yet-propagated site (probe retries then warns)", async () => {
  const stateDir = tmpDir();
  const slack = fakeSlack();
  slack.createChannel = async (name) => ({ channelId: "CNEW", name });
  slack.setTopic = async () => ({ ok: true });
  const warnings = [];

  const result = await shareDoc({
    docUrl: "http://127.0.0.1:1/eng/audit/",
    test: true,
    stateDir,
    probeDelays: [10, 20],
    slack,
    log: (m) => warnings.push(m),
  });
  assert.equal(result.channelName, "markd-test-eng-audit", "share completed anyway");
  assert.ok(warnings.some((w) => w.includes("not reachable yet")));
});

// ---------------------------------------------------------------------------
// adversarial-review fixes

test("assertTrustedOrigin: localhost and LDPUB_URL pass, everything else refuses", () => {
  withEnv({ LDPUB_URL: "https://ldpub.example.dev" }, () => {
    assertTrustedOrigin("http://127.0.0.1:7999");
    assertTrustedOrigin("http://localhost:8080");
    assertTrustedOrigin("https://ldpub.example.dev");
    assert.throws(() => assertTrustedOrigin("https://ldpub-example.dev"), /refusing/);
    assert.throws(() => assertTrustedOrigin("https://evil.dev"), /refusing/);
  });
  // An http LDPUB_URL is not a trusted remote.
  withEnv({ LDPUB_URL: "http://ldpub.example.dev" }, () => {
    assert.throws(() => assertTrustedOrigin("http://ldpub.example.dev"), /refusing/);
  });
  withEnv({ LDPUB_URL: undefined }, () => {
    assert.throws(() => assertTrustedOrigin("https://anything.dev"), /LDPUB_URL/);
  });
});

test("authHeaders: service token only ever goes to the configured origin", () => {
  withEnv(
    {
      LDPUB_URL: "https://ldpub.example.dev",
      LDPUB_CLIENT_ID: "test-id",
      LDPUB_CLIENT_SECRET: "test-secret",
    },
    () => {
      const good = authHeaders("me@x.co", "https://ldpub.example.dev");
      assert.equal(good["CF-Access-Client-Id"], "test-id");
      assert.equal(good["X-Markup-User"], "me@x.co");
      const bad = authHeaders("me@x.co", "https://evil.dev");
      assert.ok(!("CF-Access-Client-Id" in bad), "no token for a foreign origin");
      assert.ok(!("CF-Access-Client-Secret" in bad));
      assert.equal(bad["X-Markup-User"], "me@x.co");
    },
  );
});

test("shareDoc refuses a look-alike origin before persisting anything", async () => {
  const stateDir = tmpDir();
  await withEnv({ LDPUB_URL: "https://ldpub.example.dev" }, () =>
    assert.rejects(
      shareDoc({
        docUrl: "https://ldpub-example.dev/eng/audit/",
        test: true,
        stateDir,
        slack: fakeSlack(),
        log: () => {},
      }),
      /refusing/,
    ),
  );
  assert.equal(fs.readdirSync(stateDir).length, 0, "no state persisted");
});

test("reconcile adopts a standing channel post instead of re-posting", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  // A previous run posted anno-a but died before saving its state.
  const orphan = await slack.send("CTEST", "orphan\n[md:anno-a]");
  const api = fakeApi([anno("anno-a")]);

  const result = await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(result.posted, 0);
  assert.equal(slack.sends.length, 1, "no second post");
  assert.equal(state.annos["anno-a"].ts, orphan.ts);
});

test("reconcile adopts a standing mirrored reply", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  const topTs = state.annos["anno-a"].ts;

  const reply = { author: "j@x.co", text: "mirror me", at: "t1", via: "canvas" };
  const key = format.replyKey(reply);
  const standing = await slack.send("CTEST", `j@x.co (canvas):\nmirror me\n[md:r:anno-a:${key}]`, topTs);
  const before = slack.sends.length;

  api.annos.get("anno-a").replies.push(reply);
  api.bump();
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(slack.sends.length, before, "standing mirror adopted, not re-sent");
  assert.equal(state.annos["anno-a"].mirroredReplyKeys[key], standing.ts);
});

test("ingest survives a landed-but-timed-out POST without duplicating", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  slack.addHuman(state.annos["anno-a"].ts, "double-post check", "2000.000001");

  // The POST lands server-side but the call reports failure (timeout).
  const realPost = api.postReply;
  api.postReply = async (opts) => {
    await realPost(opts);
    throw new Error("fetch timeout");
  };
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(state.annos["anno-a"].pendingIngestTs, "2000.000001");
  assert.equal(api.annos.get("anno-a").replies.length, 1);

  api.postReply = realPost;
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(api.annos.get("anno-a").replies.length, 1, "not duplicated");
  assert.equal(state.annos["anno-a"].threadCursor, "2000.000001");
  assert.equal(state.annos["anno-a"].pendingIngestTs, undefined);
});

test("ingest re-posts after a POST that truly failed", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  slack.addHuman(state.annos["anno-a"].ts, "flaky network", "2000.000001");

  const realPost = api.postReply;
  api.postReply = async () => {
    throw new Error("network down");
  };
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(api.annos.get("anno-a").replies.length, 0);
  assert.equal(state.annos["anno-a"].pendingIngestTs, "2000.000001");

  api.postReply = realPost;
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(api.annos.get("anno-a").replies.length, 1, "delivered on retry");
  assert.equal(state.annos["anno-a"].threadCursor, "2000.000001");
});

test("annotations deleted on canvas are pruned from state", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a"), anno("anno-b")]);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.ok(state.annos["anno-a"]);

  api.annos.delete("anno-a");
  api.bump();
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(state.annos["anno-a"], undefined, "pruned");
  assert.ok(state.annos["anno-b"], "survivor untouched");
  const reloaded = stateStore.load(stateDir, state.channelName);
  assert.equal(reloaded.annos["anno-a"], undefined, "prune persisted");
});

test("404 on reply ingest drops the mapping instead of looping", async () => {
  const stateDir = tmpDir();
  const state = freshState(stateDir);
  const slack = fakeSlack();
  const api = fakeApi([anno("anno-a")]);
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  slack.addHuman(state.annos["anno-a"].ts, "too late", "2000.000001");

  api.postReply = async ({ annoId }) => {
    throw new Error(`POST reply on ${annoId} → 404`);
  };
  await runCycle({ state, stateDir, slack, api, archiveOnResolve: true, ...quiet });
  assert.equal(state.annos["anno-a"], undefined, "mapping dropped");
});

test("fetchDocTitle: same-origin title read, off-origin redirect rejected", async () => {
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Board Audit</title></head><body></body></html>");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = target.address().port;
  const bouncer = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/login` });
    res.end();
  });
  await new Promise((r) => bouncer.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await fetchDocTitle(`http://127.0.0.1:${targetPort}/eng/audit/`), "Board Audit");
    assert.equal(
      await fetchDocTitle(`http://127.0.0.1:${bouncer.address().port}/eng/audit/`),
      null,
      "login-wall title must not leak onto the card",
    );
  } finally {
    target.close();
    bouncer.close();
  }
});

test("buildArgs: flags precede a -- guard so text can't parse as flags", () => {
  assert.deepEqual(buildArgs("send", ["--thread", "1.2"], ["C1", "--help"]), [
    "send",
    "--output",
    "json",
    "--thread",
    "1.2",
    "--",
    "C1",
    "--help",
  ]);
});

test("channelNameFor: --channel is slugified, no path traversal", () => {
  const name = channelNameFor({ user: "e", project: "p", channelOverride: "../../../../tmp/pwn" });
  assert.equal(name, "tmp-pwn");
  assert.ok(!name.includes("/") && !name.includes(".."));
  assert.ok(!stateStore.stateFile("/x", name).includes(".."));
});

test("pseudoPortFor: deterministic, in range, distinct per channel", () => {
  const a = pseudoPortFor("markd-test-eng-audit");
  const b = pseudoPortFor("markd-test-other-doc");
  assert.equal(a, pseudoPortFor("markd-test-eng-audit"));
  assert.ok(a >= 70_000 && a < 80_000);
  assert.ok(b >= 70_000 && b < 80_000);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// plan / format / parse units

test("flat legacy fields tolerated: anchorText/cssPath/state fallbacks", () => {
  const legacy = {
    id: "anno-old",
    mode: "text",
    cssPath: "body > p",
    anchorText: "legacy quote",
    note: "n",
    author: "a@b.c",
    state: "resolved",
    replies: [],
  };
  assert.ok(format.topLevelText(legacy, "http://x").includes("> legacy quote"));
  assert.ok(format.topLevelText(legacy, "http://x").includes("· resolved"));
  assert.equal(format.isTerminal(legacy), true);
  const { allAccepted } = planActions([legacy], { annos: { "anno-old": { ts: "1", mirroredReplyKeys: {} } } });
  assert.equal(allAccepted, true);
});

test("status vocabulary: pending is not terminal, accepted is", () => {
  assert.equal(format.isTerminal(anno("a", { status: "pending" })), false);
  assert.equal(format.isTerminal(anno("a", { status: "accepted" })), true);
  assert.equal(format.annoStatus({ id: "x" }), "open");
});

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
    probeDelays: [],
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
    probeDelays: [],
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
    assert.equal(anno1.status, "open");

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

test("stub API: cross-author PUT drives only status; author's content edits are refused", async () => {
  const { server, url } = await startStub({});
  try {
    await fetch(`${url}/api/eng/audit/annotations/anno-y`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "first note", status: "open" }),
    });

    // Another identity rewriting the note's content is refused.
    const noteEdit = await fetch(`${url}/api/eng/audit/annotations/anno-y`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "eng@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "edited", status: "open" }),
    });
    assert.equal(noteEdit.status, 403);
    assert.match((await noteEdit.json()).error, /only john@launchdarkly.com can edit this note/);

    // A cross-author PUT that keeps note/anchor/payload identical but tries
    // to rewrite other fields (pinNum here) drives only status; everything
    // else comes from the stored record.
    const sneaky = await fetch(`${url}/api/eng/audit/annotations/anno-y`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "eng@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 9, note: "first note", status: "accepted" }),
    });
    assert.equal(sneaky.status, 200);
    const merged = await sneaky.json();
    assert.equal(merged.pinNum, 1, "non-author cannot renumber a pin");
    assert.equal(merged.note, "first note");
    assert.equal(merged.status, "accepted", "the status transition still applies");
    assert.equal(merged.author, "john@launchdarkly.com");
    assert.equal(merged.lastEditedBy, "eng@launchdarkly.com");
  } finally {
    server.close();
  }
});

test("stub API: DELETE is author-only, tombstones, and refuses resurrection", async () => {
  const { server, url } = await startStub({});
  try {
    await fetch(`${url}/api/eng/audit/annotations/anno-z`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "note", status: "open" }),
    });

    // Another identity's DELETE is refused and the note survives.
    const crossDel = await fetch(`${url}/api/eng/audit/annotations/anno-z`, {
      method: "DELETE",
      headers: { "X-Markup-User": "eng@launchdarkly.com" },
    });
    assert.equal(crossDel.status, 403);
    assert.match((await crossDel.json()).error, /only john@launchdarkly.com can delete this note/);
    const survived = await fetch(`${url}/api/eng/audit/annotations`);
    assert.equal((await survived.json()).annotations.length, 1);

    // The author's DELETE tombstones: gone from GET, PUT refuses
    // resurrection (410), replies to it 404.
    const del = await fetch(`${url}/api/eng/audit/annotations/anno-z`, {
      method: "DELETE",
      headers: { "X-Markup-User": "john@launchdarkly.com" },
    });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, id: "anno-z" });

    const list = await fetch(`${url}/api/eng/audit/annotations`);
    assert.equal((await list.json()).annotations.length, 0);

    const zombie = await fetch(`${url}/api/eng/audit/annotations/anno-z`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "note", status: "open" }),
    });
    assert.equal(zombie.status, 410);

    const deadReply = await fetch(`${url}/api/eng/audit/annotations/anno-z/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello?" }),
    });
    assert.equal(deadReply.status, 404);

    // A DELETE for an id that never existed is also a 404.
    const neverExisted = await fetch(`${url}/api/eng/audit/annotations/nope`, {
      method: "DELETE",
      headers: { "X-Markup-User": "john@launchdarkly.com" },
    });
    assert.equal(neverExisted.status, 404);
  } finally {
    server.close();
  }
});

test("stub API: create-time pin/rect number arbitration", async () => {
  const { server, url } = await startStub({});
  try {
    // Two viewers race inside one poll window and both propose pinNum 1;
    // the second create is reassigned live-max + 1.
    const first = await fetch(`${url}/api/eng/audit/annotations/anno-p1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "a", status: "open" }),
    });
    assert.equal((await first.json()).pinNum, 1);

    const second = await fetch(`${url}/api/eng/audit/annotations/anno-p2`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "eng@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "b", status: "open" }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.pinNum, 2, "colliding pinNum is reassigned");

    // A create with no number at all gets one minted too.
    const unnumbered = await fetch(`${url}/api/eng/audit/annotations/anno-p3`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", note: "c", status: "open" }),
    });
    assert.equal((await unnumbered.json()).pinNum, 3);

    // Updates by the author never renumber: john edits anno-p1's note and
    // pinNum 1 stays put even though it "collides" with itself.
    const edit = await fetch(`${url}/api/eng/audit/annotations/anno-p1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "pin", pinNum: 1, note: "edited", status: "open" }),
    });
    const editBody = await edit.json();
    assert.equal(editBody.pinNum, 1);
    assert.equal(editBody.note, "edited");

    // rect numbers arbitrate independently of pin numbers.
    const rect1 = await fetch(`${url}/api/eng/audit/annotations/anno-r1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Markup-User": "john@launchdarkly.com" },
      body: JSON.stringify({ mode: "rect", rectNum: 1, status: "open" }),
    });
    assert.equal((await rect1.json()).rectNum, 1);
  } finally {
    server.close();
  }
});
