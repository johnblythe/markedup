// The remote persistence driver is browser code (an IIFE over window/fetch/
// localStorage), so it's exercised here in a vm sandbox with those stubbed.
// Under test: destructive ops on the shared canvas are scoped to the
// caller's own annotations — deletion tombstones an id forever server-side,
// so one reviewer must not be able to wipe another's notes.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// In-memory localStorage that actually persists (for seen-tracking tests).
// `blocked: true` throws on every access, standing in for a private-mode /
// disabled store — the driver must degrade without crashing.
function memoryStore(blocked) {
  const data = {};
  return {
    getItem(k) {
      if (blocked) throw new Error("storage blocked");
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      if (blocked) throw new Error("storage blocked");
      data[k] = String(v);
    },
  };
}

function loadPersist({ remote, annotations, me, store }) {
  const fetchCalls = [];
  const sandbox = {
    window: { __MARKUP_REMOTE__: remote },
    localStorage: store || {
      getItem: () => null,
      setItem: () => {},
    },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: (url, opts = {}) => {
      const method = opts.method || "GET";
      fetchCalls.push({ url, method });
      if (url.endsWith("/api/me")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ email: me }) });
      }
      if (url.endsWith("/annotations") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ etag: "e1", annotations }),
        });
      }
      // Replies route: behave like the server — append and return the annotation.
      const replyMatch = url.match(/\/annotations\/([^/]+)\/replies$/);
      if (replyMatch && method === "POST") {
        const target = annotations.find((a) => a.id === replyMatch[1]);
        const body = JSON.parse(opts.body);
        const updated = {
          ...target,
          replies: [
            ...((target && target.replies) || []),
            { author: me, text: body.text, at: new Date().toISOString(), via: "canvas" },
          ],
        };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(updated) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
  };
  const src = fs.readFileSync(path.join(__dirname, "../src/client/persist.js"), "utf-8");
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Persist: sandbox.Persist, fetchCalls };
}

test("remote destructive ops are scoped to the caller's own annotations", async () => {
  const annotations = [
    { id: "anno-mine", author: "me@ld.com", mode: "pin", note: "mine" },
    { id: "anno-theirs", author: "them@ld.com", mode: "pin", note: "theirs" },
  ];
  const { Persist, fetchCalls } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations,
    me: "me@ld.com",
  });

  await new Promise((resolve) => Persist.init("key", resolve));
  assert.strictEqual(Persist.isRemote(), true);
  assert.strictEqual(Persist.self(), "me@ld.com");
  assert.strictEqual(Persist.loadAnnotations("key").length, 2);

  // Deleting someone else's annotation is refused: no cache change, no wire call.
  assert.strictEqual(Persist.deleteAnnotation("key", "anno-theirs"), false);
  assert.strictEqual(Persist.loadAnnotations("key").length, 2);
  assert.ok(!fetchCalls.some((c) => c.method === "DELETE"));

  // Clear-all deletes only own annotations; others' survive.
  Persist.clearAll("key");
  const deletes = fetchCalls.filter((c) => c.method === "DELETE").map((c) => c.url);
  assert.deepStrictEqual(deletes, ["/api/u/p/annotations/anno-mine"]);
  // Array.from: vm-realm arrays fail deepStrictEqual's prototype check.
  assert.deepStrictEqual(
    Array.from(Persist.loadAnnotations("key"), (a) => a.id),
    ["anno-theirs"],
  );
});

test("loadAnnotations hands out isolated copies — a caller's in-place mutation can't corrupt the cache", async () => {
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [
      { id: "anno-1", author: "me@ld.com", mode: "span", payload: { anchorText: "first selection" }, anchor: { cssPath: "body>p", anchorText: "para" } },
      { id: "anno-2", author: "them@ld.com", mode: "span", payload: { anchorText: "second selection" }, anchor: { cssPath: "body>p", anchorText: "para" } },
    ],
    me: "me@ld.com",
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  // Simulate the re-anchor path mutating a returned annotation in place
  // (reattach writes anno.payload.anchorText, hydrate writes anno.status).
  const first = Persist.loadAnnotations("key");
  first[0].payload.anchorText = "CLOBBERED";
  first[0].status = "pending";
  first[1].anchor.cssPath = "body>div";

  // A fresh read is unaffected: the two spans keep their distinct, correct
  // anchor data. Without deep-copy-on-read these mutations would leak through
  // the shared reference and detach/duplicate the other span.
  const again = Persist.loadAnnotations("key");
  assert.strictEqual(again[0].payload.anchorText, "first selection");
  assert.strictEqual(again[0].status, undefined);
  assert.strictEqual(again[1].payload.anchorText, "second selection");
  assert.strictEqual(again[1].anchor.cssPath, "body>p");
  // And the two annotations never share a nested object.
  assert.notStrictEqual(again[0].payload, again[1].payload);
});

test("new-since-last-visit counts others' unseen notes and clears on markSeen", async () => {
  const store = memoryStore(false);
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [
      { id: "anno-mine", author: "me@ld.com", mode: "pin", note: "mine" },
      { id: "anno-t1", author: "them@ld.com", mode: "pin", note: "theirs 1" },
    ],
    me: "me@ld.com",
    store,
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  // First visit: the one other-authored note is new; my own never counts.
  assert.strictEqual(Persist.newCount(), 1);

  // Opening the review panel marks everything seen.
  Persist.markSeen();
  assert.strictEqual(Persist.newCount(), 0);

  // A later arrival from another author is new again; my own addition isn't.
  Persist.upsertAnnotation("key", { id: "anno-t2", author: "them@ld.com", mode: "pin", note: "theirs 2" });
  Persist.upsertAnnotation("key", { id: "anno-m2", author: "me@ld.com", mode: "pin", note: "mine 2" });
  assert.strictEqual(Persist.newCount(), 1);

  Persist.markSeen();
  assert.strictEqual(Persist.newCount(), 0);
});

test("a blocked localStorage degrades gracefully (no throw, all others read as new)", async () => {
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [
      { id: "anno-mine", author: "me@ld.com", mode: "pin", note: "mine" },
      { id: "anno-t1", author: "them@ld.com", mode: "pin", note: "theirs" },
    ],
    me: "me@ld.com",
    store: memoryStore(true),
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  // Nothing can be remembered, so the other-authored note always reads as new;
  // markSeen must not throw even though the store rejects writes.
  assert.strictEqual(Persist.newCount(), 1);
  assert.doesNotThrow(() => Persist.markSeen());
  assert.strictEqual(Persist.newCount(), 1);
});

test("newCount and markSeen are inert in local mode", async () => {
  const { Persist } = loadPersist2Local();
  await new Promise((resolve) => Persist.init("key", resolve));
  assert.strictEqual(Persist.isRemote(), false);
  assert.strictEqual(Persist.newCount(), 0);
  assert.doesNotThrow(() => Persist.markSeen());
});

function loadPersist2Local() {
  const stored = {};
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => stored[k] || null,
      setItem: (k, v) => {
        stored[k] = v;
      },
    },
    console,
    setInterval: () => 0,
    fetch: () => Promise.reject(new Error("no network in local mode")),
  };
  const src = fs.readFileSync(path.join(__dirname, "../src/client/persist.js"), "utf-8");
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Persist: sandbox.Persist };
}

test("postReply POSTs via:canvas and adopts the updated thread into the cache", async () => {
  const { Persist, fetchCalls } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [{ id: "anno-t1", author: "them@ld.com", mode: "pin", note: "theirs" }],
    me: "me@ld.com",
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  const saved = await Persist.postReply("anno-t1", "on it");
  const replyCall = fetchCalls.find((c) => c.url.endsWith("/annotations/anno-t1/replies"));
  assert.ok(replyCall, "reply POST was sent");
  assert.strictEqual(replyCall.method, "POST");
  assert.strictEqual(saved.replies.length, 1);
  assert.strictEqual(saved.replies[0].text, "on it");

  // The thread is in the cache immediately — the sidebar renders it without
  // waiting for the next poll.
  const fromCache = Persist.loadAnnotations("key").find((a) => a.id === "anno-t1");
  assert.strictEqual(fromCache.replies.length, 1);
  assert.strictEqual(fromCache.replies[0].author, "me@ld.com");
});

test("reviewOrder: unseen others first, then others, then mine, newest first", async () => {
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [
      { id: "anno-mine-old", author: "me@ld.com", createdAt: "2026-08-01T00:00:00Z" },
      { id: "anno-their-seen", author: "them@ld.com", createdAt: "2026-08-02T00:00:00Z" },
      { id: "anno-their-new2", author: "them@ld.com", createdAt: "2026-08-03T00:00:00Z" },
      { id: "anno-their-new1", author: "other@ld.com", createdAt: "2026-08-04T00:00:00Z" },
      { id: "anno-mine-new", author: "me@ld.com", createdAt: "2026-08-05T00:00:00Z" },
    ],
    me: "me@ld.com",
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  const sessionNew = { "anno-their-new1": true, "anno-their-new2": true };
  const ordered = Persist.reviewOrder(Persist.loadAnnotations("key"), sessionNew);
  assert.deepStrictEqual(
    Array.from(ordered, (a) => a.id),
    ["anno-their-new1", "anno-their-new2", "anno-their-seen", "anno-mine-new", "anno-mine-old"],
  );
});

test("displayStatus maps wire values to human labels without touching them", async () => {
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [],
    me: "me@ld.com",
  });
  await new Promise((resolve) => Persist.init("key", resolve));

  assert.strictEqual(Persist.displayStatus({ status: "open" }), "Open");
  assert.strictEqual(Persist.displayStatus({}), "Open");
  assert.strictEqual(Persist.displayStatus({ status: "accepted" }), "Resolved");
  assert.strictEqual(Persist.displayStatus({ status: "pending" }), "Needs another look");
  assert.strictEqual(
    Persist.displayStatus({ status: "pending", carryReason: "anchor-lost" }),
    "Moved — re-attach",
  );
  assert.strictEqual(
    Persist.displayStatus({ status: "pending", carryReason: "source-changed" }),
    "From earlier version",
  );
});

test("presence degrades silently when the endpoint is unavailable", async () => {
  const { Persist } = loadPersist({
    remote: { base: "", user: "u", project: "p" },
    annotations: [],
    me: "me@ld.com",
  });
  await new Promise((resolve) => Persist.init("key", resolve));
  // The stub fetch answers /presence with a generic {ok:true} body lacking
  // viewers — presence() must simply stay empty, never throw.
  assert.deepStrictEqual(Array.from(Persist.presence()), []);
});

test("local mode deleteAnnotation is unchanged (no author scoping)", async () => {
  const stored = {};
  const sandbox = {
    window: {},
    localStorage: {
      getItem: (k) => stored[k] || null,
      setItem: (k, v) => {
        stored[k] = v;
      },
    },
    console,
    setInterval: () => 0,
    fetch: () => Promise.reject(new Error("no network in local mode")),
  };
  const src = fs.readFileSync(path.join(__dirname, "../src/client/persist.js"), "utf-8");
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const Persist = sandbox.Persist;

  await new Promise((resolve) => Persist.init("key", resolve));
  assert.strictEqual(Persist.isRemote(), false);

  Persist.upsertAnnotation("key", { id: "anno-1", author: "someone-else@x", note: "n" });
  assert.strictEqual(Persist.deleteAnnotation("key", "anno-1"), true);
  assert.strictEqual(Persist.loadAnnotations("key").length, 0);
});
