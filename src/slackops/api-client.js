// Client for the multiplayer annotations API (contract:
// tmp/multiplayer-contract.md in the repo root of the orchestration session).
// Works against the local stub (X-Markup-User header names the caller) and
// the ldpub Worker (Cloudflare Access service-token headers, taken from the
// environment and never logged).

const FETCH_TIMEOUT_MS = 10_000;

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
      `cannot derive {user}/{project} from ${docUrl} — expected {origin}/{user}/{project}/`,
    );
  }
  const [user, project] = segments;
  return { apiBase: url.origin, user, project };
}

// The doc URL is operator-supplied, so it controls where the bridge sends
// requests. Only two origins are ever contacted: localhost (stub / local
// serve) and the configured ldpub origin from LDPUB_URL (https only). The
// service token is attached only to the latter — never to an origin that
// merely appeared in a pasted URL.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function configuredRemoteOrigin() {
  const raw = process.env.LDPUB_URL;
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

function authHeaders(asUser, apiBase) {
  const headers = {};
  if (asUser) headers["X-Markup-User"] = asUser;
  const remote = configuredRemoteOrigin();
  if (
    remote &&
    apiBase === remote &&
    process.env.LDPUB_CLIENT_ID &&
    process.env.LDPUB_CLIENT_SECRET
  ) {
    headers["CF-Access-Client-Id"] = process.env.LDPUB_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.LDPUB_CLIENT_SECRET;
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
  fetchAnnotations,
  postReply,
  authHeaders,
  assertTrustedOrigin,
};
