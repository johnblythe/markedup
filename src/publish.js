// `markup publish` / `markup pull`: the ldpub (shared canvas) integration.
//
// publish: uploads one HTML file to the ldpub Worker (v2 per-user namespace,
//   PUT /api/sites/{user}/{project}/index.html) and refreshes the overlay
//   assets the Worker injects into every served page.
// pull: fetches the shared annotation set and writes the standard feedback
//   bundle (markdown + PNGs) next to wherever you run it, the same bundle
//   the local "Export to disk" produces, so agents consume it unchanged.
//
// Auth, in order:
//   1. Cloudflare Access service token (agents/CI), LDPUB_CLIENT_ID/SECRET
//      from the environment, then LDPUB_ENV_FILE, then ~/code/ldpub/.env.
//   2. The caller's own Access SSO session via cloudflared (`markup login`);
//      no minted credentials, attribution is their real email.
// Values are consumed, never printed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Access = require("./access");
const { buildClientBundle, getStylesCSS } = require("./client-bundle");
const { buildFeedbackMarkdown } = require("./feedback");
const { writeExportBundle, timestamp } = require("./export");

const DEFAULT_LDPUB_URL = "https://ldpub.jblythe.workers.dev";
const DEFAULT_ENV_FILE = path.join(os.homedir(), "code", "ldpub", ".env");

function parseEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function loadConfig() {
  const fileEnv = parseEnvFile(process.env.LDPUB_ENV_FILE || DEFAULT_ENV_FILE);
  const get = (key) => process.env[key] || fileEnv[key] || "";
  return {
    url: (get("LDPUB_URL") || DEFAULT_LDPUB_URL).replace(/\/+$/, ""),
    clientId: get("LDPUB_CLIENT_ID"),
    clientSecret: get("LDPUB_CLIENT_SECRET"),
    user: get("LDPUB_USER"),
  };
}

// Service token when configured; otherwise the caller's own SSO session.
// With a TTY and no live session, runs the interactive login right here so
// first use is one browser hop, not an error message.
function authHeaders(config, appUrl, { runner, interactive = process.stdin.isTTY } = {}) {
  if (config.clientId && config.clientSecret) {
    return {
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret,
    };
  }
  let token = Access.accessToken(appUrl, runner ? { runner } : {});
  if (!token && interactive && Access.cloudflaredAvailable(runner || undefined)) {
    console.error("markup: no shared-canvas session, opening your browser to sign in");
    token = Access.login(appUrl, runner ? { runner } : {});
  }
  if (!token) {
    throw new Error(
      `not signed in to the shared canvas; run \`markup login\` ` +
        `(${Access.cloudflaredAvailable(runner || undefined) ? "then retry" : Access.INSTALL_HINT})`,
    );
  }
  return { "cf-access-token": token };
}

function kebab(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// serve.js's local API mount and the slackops registry fallback both derive
// a slug from a source *filename* (extension included) that must never come
// back empty, since it becomes a URL path segment. kebab() alone can't
// promise that (a bare extension like ".html" kebabs to ""), so this is the
// one place that layers the filename-specific strip and fallback on top of
// the shared transform; every other slug (user, project, channel name) uses
// kebab() directly.
function slugFromSourceName(sourceName) {
  return kebab(String(sourceName).replace(/\.[^.]+$/, "")) || "artifact";
}

async function apiFetch(config, method, apiPath, { headers, body } = {}) {
  const res = await fetch(`${config.url}${apiPath}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      ...authHeaders(config, config.url),
      ...headers,
    },
    body,
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      config.clientId
        ? "Access rejected the service token; check LDPUB_CLIENT_ID/SECRET (ldpub SETUP.md §5)"
        : "Access rejected the session; run `markup login` and retry",
    );
  }
  return res;
}

async function bailOnError(res, context) {
  const text = await res.text();
  throw new Error(`${context}: ${res.status} ${text.slice(0, 300)}`);
}

// The Worker injects <script src="/__markup/client.js"> etc. into every
// served page; those assets live in R2 and this refreshes them from the
// installed markup version so publish always ships a matching overlay.
async function ensureOverlayAssets(config) {
  const modernScreenshotPath = require.resolve("modern-screenshot/dist/index.js");
  const assets = [
    { name: "client.js", body: buildClientBundle(), type: "text/javascript" },
    { name: "styles.css", body: getStylesCSS(), type: "text/css" },
    { name: "modern-screenshot.js", body: fs.readFileSync(modernScreenshotPath), type: "text/javascript" },
  ];
  for (const asset of assets) {
    const res = await apiFetch(config, "PUT", `/api/assets/${asset.name}`, {
      headers: { "Content-Type": asset.type },
      body: asset.body,
    });
    if (!res.ok) await bailOnError(res, `overlay asset ${asset.name}`);
  }
}

async function publish(file, opts = {}) {
  const config = loadConfig();
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
  const stem = path.basename(resolved).replace(/\.[^.]+$/, "");

  const user = kebab(opts.user || config.user || os.userInfo().username);
  const project = kebab(opts.project || stem);
  const title = opts.title || stem;
  if (!user || !project) throw new Error("could not derive user/project; pass --user/--project");

  // HTTP headers are ByteStrings: anything outside Latin-1 (em dashes,
  // curly quotes) would throw in fetch, so the listing title gets flattened.
  const headerTitle = title.replace(/[^\x20-\xff]/g, "-");

  const res = await apiFetch(config, "PUT", `/api/sites/${user}/${project}/index.html`, {
    headers: { "Content-Type": "text/html", "X-Ldpub-Title": headerTitle },
    body: fs.readFileSync(resolved),
  });
  if (!res.ok) await bailOnError(res, "publish");

  // Overlay assets are shared infrastructure: the Worker only lets trusted
  // service tokens rewrite them, so SSO publishers ship the doc and leave
  // the canvas's current overlay in place.
  if (config.clientId && config.clientSecret) {
    await ensureOverlayAssets(config);
  } else {
    console.error("markup: overlay assets left as-is (refreshing them takes a service token)");
  }

  return { url: `${config.url}/${user}/${project}/`, user, project, title };
}

function parseCanvasUrl(urlStr) {
  const url = new URL(urlStr);
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`cannot parse user/project from URL path "${url.pathname}"`);
  }
  return { base: url.origin, user: segments[0], project: segments[1] };
}

async function pull(urlStr, opts = {}) {
  const config = loadConfig();
  const { user, project } = parseCanvasUrl(urlStr);

  const res = await apiFetch(config, "GET", `/api/${user}/${project}/annotations`);
  if (!res.ok) await bailOnError(res, "pull");
  const { annotations } = await res.json();

  const stamp = timestamp();
  const assetsDirName = `${project}.feedback-${stamp}.assets`;
  const { markdown, assets } = buildFeedbackMarkdown(annotations, {
    sourceName: `${project} (shared canvas)`,
    sourceUrl: `${config.url}/${user}/${project}/`,
    assetsDirName,
  });

  // Resolve rect screenshots into dataURL assets for the bundle writer.
  const resolvedAssets = [];
  for (const asset of assets) {
    const shotRes = await apiFetch(config, "GET", `/api/${user}/${project}/shots/${asset.annoId}.png`);
    if (!shotRes.ok) continue;
    const buf = Buffer.from(await shotRes.arrayBuffer());
    resolvedAssets.push({
      filename: asset.filename,
      dataURL: `data:image/png;base64,${buf.toString("base64")}`,
    });
  }

  const virtualSource = path.join(path.resolve(opts.dir || process.cwd()), `${project}.html`);
  const result = writeExportBundle(virtualSource, {
    markdown,
    assets: resolvedAssets,
    stamp,
  });
  return { ...result, count: annotations.length };
}

module.exports = {
  publish,
  pull,
  loadConfig,
  parseCanvasUrl,
  kebab,
  slugFromSourceName,
  authHeaders,
  ensureOverlayAssets,
  DEFAULT_LDPUB_URL,
};
