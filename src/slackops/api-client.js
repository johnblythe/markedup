// Client for the multiplayer annotations API (contract:
// tmp/multiplayer-contract.md in the repo root of the orchestration session).
// Works against the local stub (X-Markup-User header names the caller) and
// the ldpub Worker (Cloudflare Access service-token headers, taken from the
// environment and never logged).

const { slugFromSourceName } = require("../publish");

const FETCH_TIMEOUT_MS = 10_000;

// Same config seam as `markup publish`/`pull` (env vars, then LDPUB_ENV_FILE,
// then ~/code/ldpub/.env), so share/bridge never diverge from the documented
// credential chain.
const { loadConfig } = require("../publish");

// A shared doc URL looks like {origin}/{user}/{project}/[index.html]. The API
// lives on the same origin.
function parseDocUrl(docUrl) {
  let url;
  try {
    url = new URL(docUrl);
  } catch (_e) {
    throw new Error(`not a valid URL: ${docUrl}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  // Drop a trailing filename (contains a dot) so .../proj/index.html works.
  if (segments.length && segments[segments.length - 1].includes(".")) segments.pop();
  if (segments.length < 2) {
    throw new Error(
      `cannot derive {user}/{project} from ${docUrl}; expected {origin}/{user}/{project}/`,
    );
  }
  const [user, project] = segments;
  return { apiBase: url.origin, user, project };
}

// The doc URL is operator-supplied, so it controls where the bridge sends
// requests. Only two origins are ever contacted: localhost (stub / local
// serve) and the configured ldpub origin (https only). The service token is
// attached only to the latter, never to an origin that merely appeared in a
// pasted URL.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function configuredRemoteOrigin() {
  const raw = loadConfig().url;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch (_e) {
    return null;
  }
}

function isLocalOrigin(apiBase) {
  try {
    return LOCAL_HOSTS.has(new URL(apiBase).hostname);
  } catch (_e) {
    return false;
  }
}

function assertTrustedOrigin(apiBase) {
  if (isLocalOrigin(apiBase)) return;
  const remote = configuredRemoteOrigin();
  if (remote && apiBase === remote) return;
  throw new Error(
    `refusing ${apiBase}: not localhost or the configured ldpub origin` +
      (remote ? ` (${remote})` : " (LDPUB_URL is unset or not https)"),
  );
}

// Persona/identity params are per-viewer; they never belong in persisted
// state or on the link card.
function stripPersonaParams(docUrl) {
  const clean = new URL(docUrl);
  clean.searchParams.delete("persona");
  clean.searchParams.delete("as");
  clean.hash = "";
  return clean.toString();
}

// Resolve a doc URL to { apiBase, user, project, docUrl }. A URL with
// {user}/{project} path segments parses directly. A bare localhost root is
// what `markup serve --multiplayer` prints (e.g. http://127.0.0.1:7790/?persona=jb):
// the serve instance mounts /api/local/<projectSlug>/, so discover the slug
// from the running instance. Non-local roots keep the existing refusal.
async function resolveDoc(docUrl) {
  let url;
  try {
    url = new URL(docUrl);
  } catch (_e) {
    throw new Error(`not a valid URL: ${docUrl}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length && segments[segments.length - 1].includes(".")) segments.pop();
  if (segments.length >= 2) {
    return { ...parseDocUrl(docUrl), docUrl: stripPersonaParams(docUrl) };
  }
  if (!isLocalOrigin(url.origin)) {
    return parseDocUrl(docUrl); // throws the usual "cannot derive" error
  }
  const project = await discoverLocalProject(url.origin);
  return { apiBase: url.origin, user: "local", project, docUrl: `${url.origin}/` };
}

async function discoverLocalProject(origin) {
  // The served page carries the overlay's own config:
  //   window.__MARKUP_REMOTE__ = {"base":"","user":"local","project":"demo",...}
  // That project value is authoritative: it's exactly what the client talks to.
  try {
    const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const html = await res.text();
      const remote = html.match(/__MARKUP_REMOTE__\s*=\s*(\{[^\n]*?\})\s*;/);
      if (remote) {
        try {
          const cfg = JSON.parse(remote[1]);
          if (cfg && cfg.project) return cfg.project;
        } catch (_e) {
          // malformed literal, fall through to legacy signals
        }
      }
      // Legacy signals, harmless if absent.
      const match =
        html.match(/\/api\/local\/([A-Za-z0-9._~-]+)\//) ||
        html.match(/["']projectSlug["']\s*[:=]\s*["']([A-Za-z0-9._~-]+)["']/);
      if (match) return match[1];
    }
  } catch (_e) {
    // fall through to the registry
  }
  // Same-machine fallback: the serve instance's registry entry. It carries the
  // source filename, from which serve's own slug is reproducible.
  try {
    const registry = require("../registry");
    const entry = registry.find(Number(new URL(origin).port));
    if (entry) {
      if (entry.projectSlug || entry.project) return entry.projectSlug || entry.project;
      if (entry.sourceName) return slugFromSourceName(entry.sourceName);
    }
  } catch (_e) {
    // fall through to the error
  }
  throw new Error(
    `could not discover the local project behind ${origin}; is \`markup serve --multiplayer\` running there? You can also pass the full URL: ${origin}/local/<project>/`,
  );
}

function authHeaders(asUser, apiBase) {
  const headers = {};
  if (asUser) headers["X-Markup-User"] = asUser;
  const remote = configuredRemoteOrigin();
  const config = loadConfig();
  if (remote && apiBase === remote && config.clientId && config.clientSecret) {
    headers["CF-Access-Client-Id"] = config.clientId;
    headers["CF-Access-Client-Secret"] = config.clientSecret;
  }
  return headers;
}

async function fetchAnnotations({ apiBase, user, project, etag, asUser }) {
  assertTrustedOrigin(apiBase);
  const headers = authHeaders(asUser, apiBase);
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(`${apiBase}/api/${user}/${project}/annotations`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 304) return { status: 304 };
  if (!res.ok) throw new Error(`GET annotations → ${res.status}`);
  const body = await res.json();
  return {
    status: 200,
    etag: body.etag || res.headers.get("etag") || null,
    annotations: Array.isArray(body.annotations) ? body.annotations : [],
  };
}

async function postReply({ apiBase, user, project, annoId, text, via, asUser }) {
  assertTrustedOrigin(apiBase);
  const res = await fetch(
    `${apiBase}/api/${user}/${project}/annotations/${encodeURIComponent(annoId)}/replies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(asUser, apiBase) },
      body: JSON.stringify({ text, via: via || "slack" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`POST reply on ${annoId} → ${res.status}`);
  return res.json();
}

module.exports = {
  parseDocUrl,
  resolveDoc,
  stripPersonaParams,
  fetchAnnotations,
  postReply,
  authHeaders,
  assertTrustedOrigin,
};
