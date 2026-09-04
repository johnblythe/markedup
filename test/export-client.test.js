const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// ExportClient.buildPayload only touches Persist and window.__MARKUP_SOURCE_NAME__ —
// no `document` calls — so it can run in a minimal vm context without a DOM shim.
// Load persist.js + export-client.js in the same order client-bundle.js uses.
function loadExportContext() {
  const persistSrc = fs.readFileSync(
    path.join(__dirname, "../src/client/persist.js"),
    "utf-8",
  );
  const exportSrc = fs.readFileSync(
    path.join(__dirname, "../src/client/export-client.js"),
    "utf-8",
  );

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    window: { __MARKUP_SOURCE_NAME__: "artifact.html" },
    localStorage,
    document: { createElement: () => ({ style: {}, addEventListener: () => {} }) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(persistSrc + "\n" + exportSrc, sandbox);
  return sandbox;
}

test("buildPayload emits [HIGHLIGHT] and [DELETE] tags with locator text and note", () => {
  const ctx = loadExportContext();
  const sourceKey = "/tmp/artifact.html";

  ctx.Persist.upsertAnnotation(sourceKey, {
    id: "anno-1",
    mode: "highlight",
    note: "emphasize this",
    payload: { anchorText: "release freeze" },
  });
  ctx.Persist.upsertAnnotation(sourceKey, {
    id: "anno-2",
    mode: "strike",
    note: "redundant sentence",
    payload: { anchorText: "as previously mentioned" },
  });
  ctx.Persist.upsertAnnotation(sourceKey, {
    id: "anno-3",
    mode: "span",
    note: "clarify",
    payload: { anchorText: "W10 dips" },
  });

  const built = ctx.ExportClient.buildPayload(sourceKey, { inlineImages: false });

  assert.match(built.markdown, /## Highlight annotations/);
  assert.match(built.markdown, /- \[HIGHLIGHT\] "release freeze": emphasize this/);
  assert.match(built.markdown, /## Strike annotations/);
  assert.match(built.markdown, /- \[DELETE\] "as previously mentioned": redundant sentence/);
  // Existing span format is untouched by the new sections.
  assert.match(built.markdown, /## Span annotations/);
  assert.match(built.markdown, /- "W10 dips": clarify/);
});

test("buildPayload falls back to (no note) for highlight/strike without a note", () => {
  const ctx = loadExportContext();
  const sourceKey = "/tmp/artifact-no-note.html";

  ctx.Persist.upsertAnnotation(sourceKey, {
    id: "anno-1",
    mode: "highlight",
    note: "",
    payload: { anchorText: "quarterly rollup" },
  });

  const built = ctx.ExportClient.buildPayload(sourceKey, { inlineImages: false });
  assert.match(built.markdown, /- \[HIGHLIGHT\] "quarterly rollup": \(no note\)/);
});

test("buildPayload omits Highlight/Strike sections when none exist", () => {
  const ctx = loadExportContext();
  const sourceKey = "/tmp/artifact2.html";
  ctx.Persist.upsertAnnotation(sourceKey, {
    id: "anno-1",
    mode: "pin",
    note: "note",
    pinNum: 1,
    payload: {},
  });
  const built = ctx.ExportClient.buildPayload(sourceKey, { inlineImages: false });
  assert.doesNotMatch(built.markdown, /## Highlight annotations/);
  assert.doesNotMatch(built.markdown, /## Strike annotations/);
});

test("buildPayload reports (no annotations) only when every mode is empty, including highlight/strike", () => {
  const ctx = loadExportContext();
  const sourceKey = "/tmp/artifact-empty.html";
  const built = ctx.ExportClient.buildPayload(sourceKey, { inlineImages: false });
  assert.match(built.markdown, /\(no annotations\)/);
});

test("unresolvedOnly omits accepted notes and carries the ledger protocol header", () => {
  const ctx = loadExportContext();
  const k = "/tmp/artifact-diff.html";
  ctx.Persist.upsertAnnotation(k, {
    id: "a1",
    mode: "span",
    note: "old and handled",
    status: "accepted",
    payload: { anchorText: "old text" },
  });
  ctx.Persist.upsertAnnotation(k, {
    id: "a2",
    mode: "span",
    note: "new round",
    payload: { anchorText: "new text" },
  });

  const built = ctx.ExportClient.buildPayload(k, { inlineImages: true, unresolvedOnly: true });

  assert.doesNotMatch(built.markdown, /old and handled/);
  assert.match(built.markdown, /new round/);
  assert.match(
    built.markdown,
    /This batch: 1 unresolved annotation\(s\); 1 resolved from earlier rounds omitted\./,
  );
  assert.match(built.markdown, /artifact\.feedback-ledger\.md/);
  assert.match(built.markdown, /act ONLY on the items in this batch/);
  assert.strictEqual(built.count, 1);
  assert.strictEqual(built.omittedResolved, 1);
});

test("full-record exports keep resolved notes and carry no ledger protocol", () => {
  const ctx = loadExportContext();
  const k = "/tmp/artifact-full.html";
  ctx.Persist.upsertAnnotation(k, {
    id: "a1",
    mode: "span",
    note: "old and handled",
    status: "accepted",
    payload: { anchorText: "old text" },
  });
  ctx.Persist.upsertAnnotation(k, {
    id: "a2",
    mode: "span",
    note: "new round",
    payload: { anchorText: "new text" },
  });

  const built = ctx.ExportClient.buildPayload(k, { inlineImages: false });

  assert.match(built.markdown, /old and handled/);
  assert.match(built.markdown, /new round/);
  assert.match(built.markdown, /Total annotations: 2/);
  assert.doesNotMatch(built.markdown, /feedback-ledger/);
});

test("unresolvedOnly with everything resolved reports an empty batch", () => {
  const ctx = loadExportContext();
  const k = "/tmp/artifact-all-done.html";
  ctx.Persist.upsertAnnotation(k, {
    id: "a1",
    mode: "pin",
    note: "done",
    status: "accepted",
    pinNum: 1,
    payload: {},
  });

  const built = ctx.ExportClient.buildPayload(k, { inlineImages: true, unresolvedOnly: true });

  assert.strictEqual(built.count, 0);
  assert.strictEqual(built.omittedResolved, 1);
  assert.match(built.markdown, /\(no unresolved annotations\)/);
});
