// ExportClient is browser code; exercise it in a vm sandbox with Persist,
// a minimal DOM, and stubbed download primitives. Under test:
//   - the clipboard/download payload includes the FULL shared set, so another
//     author's annotation reaches the exported markdown
//   - on a shared canvas, "Disk" downloads the .md client-side (no /export
//     POST, which the Worker doesn't serve)
//   - local (non-remote) serve keeps its /export POST behavior

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadExportEnv({ remote, annotations, me, exportRoute = true }) {
  const events = { downloads: [], fetches: [], clicks: 0 };

  // Minimal DOM: enough for Toast (lazy, unused here) and triggerDownload.
  function fakeEl() {
    return {
      style: {},
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      removeChild() {},
      addEventListener() {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      click() {
        events.clicks += 1;
        events.downloads.push({ href: this.href, download: this.download });
      },
    };
  }

  const sandbox = {
    window: {
      __MARKUP_REMOTE__: remote,
      __MARKUP_SOURCE_NAME__: "report.html",
      location: { origin: "https://ldpub.example", pathname: "/u/p/" },
    },
    document: {
      body: { appendChild() {}, removeChild() {} },
      createElement: () => fakeEl(),
      addEventListener() {},
      getElementById: () => null,
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Blob: function (parts) {
      this.parts = parts;
    },
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL() {} },
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    setInterval: () => 0,
    console,
    fetch: (url, opts = {}) => {
      events.fetches.push({ url, method: opts.method || "GET" });
      if (url.endsWith("/api/me")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ email: me }) });
      }
      if (url.endsWith("/annotations") && (opts.method || "GET") === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ etag: "e1", annotations }),
        });
      }
      if (url === "/export") {
        // exportRoute=false models a published canvas: the Worker serves no
        // /export route, so the probe gets a 404 (an HTML page, not JSON).
        if (!exportRoute) {
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.reject(new Error("not json")),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, feedbackPath: "report.feedback.md", assets: [] }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/client/persist.js"), "utf-8"), sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../src/client/export-client.js"), "utf-8"),
    sandbox,
  );
  return { sandbox, events };
}

const SHARED = [
  { id: "anno-mine", author: "me@ld.com", mode: "pin", pinNum: 1, note: "my note", anchor: { cssPath: "body>h1", tagName: "h1" } },
  {
    id: "anno-theirs",
    author: "corbin@ld.com",
    mode: "pin",
    pinNum: 2,
    note: "corbin's finding about the totals",
    anchor: { cssPath: "body>table", tagName: "table" },
  },
];

test("remote export payload contains another author's annotation (full shared set)", async () => {
  const { sandbox } = loadExportEnv({
    remote: { base: "", user: "u", project: "p" },
    annotations: SHARED,
    me: "me@ld.com",
  });
  await new Promise((resolve) => sandbox.Persist.init("key", resolve));

  const built = sandbox.ExportClient.buildPayload("key", { inlineImages: true });
  assert.match(built.markdown, /my note/);
  assert.match(built.markdown, /corbin's finding about the totals/);
});

test("published canvas Disk export falls back to a download when /export is missing", async () => {
  const { sandbox, events } = loadExportEnv({
    remote: { base: "", user: "u", project: "p" },
    annotations: SHARED,
    me: "me@ld.com",
    exportRoute: false,
  });
  await new Promise((resolve) => sandbox.Persist.init("key", resolve));

  sandbox.ExportClient.exportToDisk("key");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    events.fetches.some((f) => f.url === "/export" && f.method === "POST"),
    "probes the /export route first",
  );
  assert.strictEqual(events.clicks, 1, "one download triggered");
  assert.match(events.downloads[0].download, /report\.feedback-.*\.md$/);
});

test("local multiplayer Disk export still writes the on-disk bundle via /export", async () => {
  const { sandbox, events } = loadExportEnv({
    remote: { base: "", user: "u", project: "p" },
    annotations: SHARED,
    me: "me@ld.com",
  });
  await new Promise((resolve) => sandbox.Persist.init("key", resolve));

  sandbox.ExportClient.exportToDisk("key");
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(events.fetches.some((f) => f.url === "/export" && f.method === "POST"));
  assert.strictEqual(events.clicks, 0, "no client-side download when the route exists");
});

test("local Disk export still POSTs /export (unchanged)", async () => {
  const { sandbox, events } = loadExportEnv({ remote: undefined, annotations: [], me: "local@dev" });
  await new Promise((resolve) => sandbox.Persist.init("key", resolve));
  assert.strictEqual(sandbox.Persist.isRemote(), false);

  sandbox.ExportClient.exportToDisk("key");
  // Let the export fetch microtask settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(events.fetches.some((f) => f.url === "/export" && f.method === "POST"));
  assert.strictEqual(events.clicks, 0, "no client-side download in local mode");
});
