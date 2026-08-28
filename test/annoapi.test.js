const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Same HOME shim as serve.test.js: keep registry writes out of the real home.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "markup-annoapi-"));
process.env.HOME = tmpRoot;
delete require.cache[require.resolve("../src/registry")];
delete require.cache[require.resolve("../src/serve")];
const { startServer } = require("../src/serve");

const PIN = {
  mode: "pin",
  note: "first note",
  pinNum: 1,
  anchor: { cssPath: "body > p", tagName: "p" },
  status: "open",
};

function withServer(opts, callback) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "markup-anno-"));
    const sourcePath = path.join(dir, "report.html");
    fs.writeFileSync(
      sourcePath,
      `<!doctype html><html><head><title>r</title></head><body><p>report body</p></body></html>`,
    );
    let handle;
    try {
      handle = await startServer(sourcePath, { port: 0, autoOpen: false, ...opts });
      await callback({ dir, sourcePath, base: handle.url.replace(/\/$/, "") });
    } finally {
      if (handle) handle.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function api(base, method, apiPath, { body, headers } = {}) {
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    /* non-JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

test(
  "annotations API: identity, stamping, etag polling, LWW",
  withServer({}, async ({ base }) => {
    // /api/me honors the identity header, then ?as=, then the default.
    const me1 = await api(base, "GET", "/api/me", { headers: { "X-Markup-User": "john@ld.com" } });
    assert.strictEqual(me1.json.email, "john@ld.com");
    const me2 = await api(base, "GET", "/api/me?as=eng@ld.com");
    assert.strictEqual(me2.json.email, "eng@ld.com");
    const me3 = await api(base, "GET", "/api/me");
    assert.strictEqual(me3.json.email, "local@dev");

    // PUT stamps author/createdAt/updatedAt/state and ignores client author.
    const put = await api(base, "PUT", "/api/local/report/annotations/anno-a1", {
      body: { ...PIN, author: "spoof@nope" },
      headers: { "X-Markup-User": "john@ld.com" },
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.json.author, "john@ld.com");
    assert.strictEqual(put.json.state, "open");
    assert.ok(put.json.createdAt && put.json.updatedAt);
    assert.strictEqual(put.json.cssPath, "body > p", "flat contract mirror of anchor.cssPath");

    // GET returns it with an etag; If-None-Match gives 304 until a write.
    const list1 = await api(base, "GET", "/api/local/report/annotations");
    assert.strictEqual(list1.json.annotations.length, 1);
    const etag = list1.json.etag;
    assert.ok(etag);
    const cached = await api(base, "GET", "/api/local/report/annotations", {
      headers: { "If-None-Match": etag },
    });
    assert.strictEqual(cached.status, 304);

    // Another identity edits: LWW, creator preserved, editor recorded.
    const edit = await api(base, "PUT", "/api/local/report/annotations/anno-a1", {
      body: { ...PIN, note: "edited" },
      headers: { "X-Markup-User": "eng@ld.com" },
    });
    assert.strictEqual(edit.json.note, "edited");
    assert.strictEqual(edit.json.author, "john@ld.com");
    assert.strictEqual(edit.json.lastEditedBy, "eng@ld.com");

    const list2 = await api(base, "GET", "/api/local/report/annotations", {
      headers: { "If-None-Match": etag },
    });
    assert.strictEqual(list2.status, 200);
    assert.notStrictEqual(list2.json.etag, etag);
  }),
);

test(
  "annotations API: replies, tombstones, resurrection refusal",
  withServer({}, async ({ base }) => {
    await api(base, "PUT", "/api/local/report/annotations/anno-b1", {
      body: PIN,
      headers: { "X-Markup-User": "john@ld.com" },
    });

    // Replies append with server-stamped author/via; PUT can't rewrite them.
    const r1 = await api(base, "POST", "/api/local/report/annotations/anno-b1/replies", {
      body: { text: "fixed in rev 3" },
      headers: { "X-Markup-User": "eng@ld.com" },
    });
    assert.strictEqual(r1.status, 200);
    assert.deepStrictEqual(
      r1.json.replies.map((r) => [r.author, r.text, r.via]),
      [["eng@ld.com", "fixed in rev 3", "canvas"]],
    );
    const overwrite = await api(base, "PUT", "/api/local/report/annotations/anno-b1", {
      body: { ...PIN, replies: [] },
      headers: { "X-Markup-User": "john@ld.com" },
    });
    assert.strictEqual(overwrite.json.replies.length, 1);

    // Reply via slack is tagged as such.
    const r2 = await api(base, "POST", "/api/local/report/annotations/anno-b1/replies", {
      body: { text: "seen", via: "slack" },
      headers: { "X-Markup-User": "bridge" },
    });
    assert.strictEqual(r2.json.replies[1].via, "slack");

    // DELETE tombstones: gone from GET, PUT refuses resurrection (410),
    // replies to it 404.
    const del = await api(base, "DELETE", "/api/local/report/annotations/anno-b1");
    assert.strictEqual(del.status, 200);
    const list = await api(base, "GET", "/api/local/report/annotations");
    assert.strictEqual(list.json.annotations.length, 0);
    const zombie = await api(base, "PUT", "/api/local/report/annotations/anno-b1", {
      body: PIN,
    });
    assert.strictEqual(zombie.status, 410);
    const deadReply = await api(base, "POST", "/api/local/report/annotations/anno-b1/replies", {
      body: { text: "hello?" },
    });
    assert.strictEqual(deadReply.status, 404);
  }),
);

test(
  "annotations API: persistence file survives a server restart",
  withServer({}, async ({ base, sourcePath, dir }) => {
    await api(base, "PUT", "/api/local/report/annotations/anno-c1", { body: PIN });
    assert.ok(fs.existsSync(path.join(dir, "report.annotations.json")));

    const again = await startServer(sourcePath, { port: 0, autoOpen: false });
    try {
      const list = await api(again.url.replace(/\/$/, ""), "GET", "/api/local/report/annotations");
      assert.strictEqual(list.json.annotations.length, 1);
      assert.strictEqual(list.json.annotations[0].note, "first note");
    } finally {
      again.server.close();
    }
  }),
);

test(
  "annotations API: shots roundtrip and pngDataURL stripping",
  withServer({}, async ({ base }) => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]);
    const putShot = await fetch(`${base}/api/local/report/shots/anno-d1`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    assert.strictEqual(putShot.status, 200);
    const { shotUrl } = await putShot.json();
    assert.strictEqual(shotUrl, "/api/local/report/shots/anno-d1.png");

    const getShot = await fetch(`${base}${shotUrl}`);
    assert.strictEqual(getShot.status, 200);
    assert.deepStrictEqual(Buffer.from(await getShot.arrayBuffer()), png);

    const put = await api(base, "PUT", "/api/local/report/annotations/anno-d1", {
      body: {
        mode: "rect",
        rectNum: 1,
        status: "open",
        shotUrl,
        payload: { x: 1, y: 2, w: 3, h: 4, pngDataURL: "data:image/png;base64,AAAA" },
      },
    });
    assert.strictEqual(put.json.payload.pngDataURL, undefined);
    assert.strictEqual(put.json.shotUrl, shotUrl);
  }),
);

test(
  "presence API: POST records the viewer, GET reads without recording",
  withServer({}, async ({ base }) => {
    const p1 = await api(base, "POST", "/api/local/report/presence", {
      headers: { "X-Markup-User": "john@ld.com" },
    });
    assert.strictEqual(p1.status, 200);
    assert.deepStrictEqual(
      p1.json.viewers.map((v) => v.email),
      ["john@ld.com"],
    );

    const p2 = await api(base, "POST", "/api/local/report/presence", {
      headers: { "X-Markup-User": "eng@ld.com" },
    });
    assert.deepStrictEqual(p2.json.viewers.map((v) => v.email).sort(), [
      "eng@ld.com",
      "john@ld.com",
    ]);

    // GET as a third identity reads the list without joining it.
    const g = await api(base, "GET", "/api/local/report/presence", {
      headers: { "X-Markup-User": "lurker@ld.com" },
    });
    assert.deepStrictEqual(g.json.viewers.map((v) => v.email).sort(), [
      "eng@ld.com",
      "john@ld.com",
    ]);
    assert.ok(g.json.viewers.every((v) => Number.isFinite(Date.parse(v.at))));
  }),
);

test(
  "annotations API: a corrupt file is refused loudly, never clobbered",
  withServer({}, async ({ base, dir }) => {
    await api(base, "PUT", "/api/local/report/annotations/anno-e1", { body: PIN });
    const docPath = path.join(dir, "report.annotations.json");
    const corrupt = "{definitely not json";
    fs.writeFileSync(docPath, corrupt);

    const list = await api(base, "GET", "/api/local/report/annotations");
    assert.strictEqual(list.status, 500);
    assert.match(list.json.error, /corrupt/);

    const put = await api(base, "PUT", "/api/local/report/annotations/anno-e2", { body: PIN });
    assert.strictEqual(put.status, 500);

    // The bad bytes are untouched — nothing silently rewrote the review.
    assert.strictEqual(fs.readFileSync(docPath, "utf-8"), corrupt);

    // Repairing the file brings the API back.
    fs.writeFileSync(docPath, JSON.stringify({ annotations: [] }));
    const after = await api(base, "PUT", "/api/local/report/annotations/anno-e2", { body: PIN });
    assert.strictEqual(after.status, 200);
  }),
);

test(
  "serve --multiplayer refuses a second process on the same file",
  withServer({}, async ({ sourcePath }) => {
    // Simulate another live process (the test runner's parent) holding the
    // file in multiplayer mode; registry entries are one JSON file per port.
    const instancesDir = path.join(tmpRoot, ".markup", "instances");
    fs.mkdirSync(instancesDir, { recursive: true });
    const fakeEntry = path.join(instancesDir, "9999.json");
    fs.writeFileSync(
      fakeEntry,
      JSON.stringify({
        port: 9999,
        sourcePath,
        sourceName: path.basename(sourcePath),
        pid: process.ppid,
        startedAt: new Date().toISOString(),
        kind: "serve",
        multiplayer: true,
      }),
    );
    try {
      await assert.rejects(
        () => startServer(sourcePath, { port: 0, autoOpen: false, multiplayer: true }),
        /already served in multiplayer/,
      );
    } finally {
      fs.unlinkSync(fakeEntry);
    }
  }),
);

test(
  "identity: ?persona= is honored and preferred over ?as=",
  withServer({}, async ({ base }) => {
    const persona = await api(base, "GET", "/api/me?persona=jb2");
    assert.strictEqual(persona.json.email, "jb2");

    const as = await api(base, "GET", "/api/me?as=jb");
    assert.strictEqual(as.json.email, "jb");

    // Both present: persona wins.
    const both = await api(base, "GET", "/api/me?as=jb&persona=jb2");
    assert.strictEqual(both.json.email, "jb2");
  }),
);

test(
  "multiplayer wrap: ?persona= bakes into the injected remote identity",
  withServer({ multiplayer: true }, async ({ base }) => {
    const page = await fetch(`${base}/?persona=jb2`);
    const html = await page.text();
    assert.ok(html.includes('"identity":"jb2"'));
  }),
);

test(
  "multiplayer wrap: remote config injected only with --multiplayer, identity from ?as=",
  withServer({ multiplayer: true }, async ({ base }) => {
    const page = await fetch(`${base}/?as=eng@ld.com`);
    const html = await page.text();
    assert.ok(html.includes("__MARKUP_REMOTE__"));
    assert.ok(html.includes('"user":"local"'));
    assert.ok(html.includes('"project":"report"'));
    assert.ok(html.includes('"identity":"eng@ld.com"'));
  }),
);

test(
  "single-player wrap: no remote config by default",
  withServer({}, async ({ base }) => {
    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.ok(!html.includes("__MARKUP_REMOTE__"));
  }),
);
