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

function loadPersist({ remote, annotations, me }) {
  const fetchCalls = [];
  const sandbox = {
    window: { __MARKUP_REMOTE__: remote },
    localStorage: {
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
