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

function authHeaders(asUser) {
  const headers = {};
  if (asUser) headers["X-Markup-User"] = asUser;
  if (process.env.LDPUB_CLIENT_ID && process.env.LDPUB_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.LDPUB_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.LDPUB_CLIENT_SECRET;
  }
  return headers;
}

async function fetchAnnotations({ apiBase, user, project, etag, asUser }) {
  const headers = authHeaders(asUser);
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
  const res = await fetch(
    `${apiBase}/api/${user}/${project}/annotations/${encodeURIComponent(annoId)}/replies`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(asUser) },
      body: JSON.stringify({ text, via: via || "slack" }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`POST reply on ${annoId} → ${res.status}`);
  return res.json();
}

module.exports = { parseDocUrl, fetchAnnotations, postReply };
