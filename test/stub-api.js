// In-memory stub of the multiplayer annotations API contract
// (tmp/multiplayer-contract.md). Used by the slackops tests and runnable
// standalone so the Slack bridge can be exercised without the ldpub Worker:
//
//   node test/stub-api.js --port 7999 --seed seed.json
//
// Identity comes from the X-Markup-User header (or ?as=), default local@dev —
// mirroring how the Worker stamps authors from the Access JWT.

const http = require("node:http");
const fs = require("node:fs");

function makeStore() {
  return new Map(); // "user/project" → { etagN, annotations: Map<id, anno> }
}

function site(store, user, project) {
  const key = `${user}/${project}`;
  if (!store.has(key)) store.set(key, { etagN: 1, annotations: new Map() });
  return store.get(key);
}

function identityFor(req, url) {
  return req.headers["x-markup-user"] || url.searchParams.get("as") || "local@dev";
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
      } catch (_e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Server-owned fields never taken from the client.
const SERVER_FIELDS = new Set(["author", "createdAt", "updatedAt", "replies"]);

function startStub({ port = 0, seedFile } = {}) {
  const store = makeStore();

  if (seedFile) {
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf-8"));
    for (const [key, annos] of Object.entries(seed)) {
      const [user, project] = key.split("/");
      const s = site(store, user, project);
      for (const anno of annos) s.annotations.set(anno.id, anno);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const identity = identityFor(req, url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] !== "api") return json(res, 404, { error: "not found" });

    if (parts[1] === "me" && req.method === "GET") {
      return json(res, 200, { email: identity });
    }

    const [, user, project, resource, annoId, sub] = parts;
    if (!user || !project || resource !== "annotations") {
      return json(res, 404, { error: "not found" });
    }
    const s = site(store, user, project);
    const etag = `"s-${s.etagN}"`;

    if (req.method === "GET" && !annoId) {
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
      }
      return json(res, 200, { etag, annotations: [...s.annotations.values()] });
    }

    if (req.method === "PUT" && annoId && !sub) {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const existing = s.annotations.get(annoId);
      const now = new Date().toISOString();
      const clientFields = {};
      for (const [k, v] of Object.entries(body)) {
        if (!SERVER_FIELDS.has(k)) clientFields[k] = v;
      }
      const merged = {
        ...(existing || {}),
        ...clientFields,
        id: annoId,
        author: existing ? existing.author : identity,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,
        replies: existing ? existing.replies : [],
        state: clientFields.state || (existing ? existing.state : "open"),
      };
      s.annotations.set(annoId, merged);
      s.etagN += 1;
      return json(res, 200, merged);
    }

    if (req.method === "POST" && annoId && sub === "replies") {
      const anno = s.annotations.get(annoId);
      if (!anno) return json(res, 404, { error: `no annotation ${annoId}` });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
      if (!body.text) return json(res, 400, { error: "text required" });
      anno.replies.push({
        author: identity,
        text: body.text,
        at: new Date().toISOString(),
        via: body.via === "slack" ? "slack" : "canvas",
      });
      anno.updatedAt = new Date().toISOString();
      s.etagN += 1;
      return json(res, 200, anno);
    }

    return json(res, 405, { error: "method not allowed" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}`, store });
    });
  });
}

module.exports = { startStub };

if (require.main === module) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf("--port");
  const seedIdx = args.indexOf("--seed");
  startStub({
    port: portIdx === -1 ? 7999 : parseInt(args[portIdx + 1], 10),
    seedFile: seedIdx === -1 ? undefined : args[seedIdx + 1],
  }).then(({ url }) => console.log(`stub annotations API at ${url}`));
}
