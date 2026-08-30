// User-SSO auth for the shared canvas (Cloudflare Access) via cloudflared.
//
// Service tokens stay first-class for agents and CI, but a human should never
// need one minted: `cloudflared access login` walks them through the org's
// SSO in a browser and caches a personal Access JWT locally; `cloudflared
// access token` reads it back until the app session expires. The JWT rides
// the documented `cf-access-token` header — Access validates it at the edge
// and forwards the usual assertion to the Worker, so the Worker sees the
// caller's real email and attribution is per-person, not per-token.

const { spawnSync } = require("node:child_process");

const INSTALL_HINT =
  "cloudflared is required for SSO login — install it with `brew install cloudflared` " +
  "(or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)";

// Access JWTs are three dot-separated base64url segments.
function looksLikeJwt(value) {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(String(value || "").trim());
}

function cloudflaredAvailable(runner = spawnSync) {
  const res = runner("cloudflared", ["--version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
}

// Returns the cached Access JWT for the app, or null when there is no live
// session (never throws for "not logged in" — callers decide how to react).
function accessToken(appUrl, { runner = spawnSync } = {}) {
  const res = runner("cloudflared", ["access", "token", `--app=${appUrl}`], {
    encoding: "utf-8",
  });
  if (res.error || res.status !== 0) return null;
  const token = String(res.stdout || "").trim();
  return looksLikeJwt(token) ? token : null;
}

// Interactive: opens the browser for SSO, then returns the fresh token.
// stdio is inherited so cloudflared's "open this URL" line reaches the user.
function login(appUrl, { runner = spawnSync } = {}) {
  if (!cloudflaredAvailable(runner)) throw new Error(INSTALL_HINT);
  const res = runner("cloudflared", ["access", "login", appUrl], { stdio: "inherit" });
  if (res.error || res.status !== 0) {
    throw new Error(`cloudflared access login failed for ${appUrl}`);
  }
  const token = accessToken(appUrl, { runner });
  if (!token) throw new Error(`login looked successful but no token came back for ${appUrl}`);
  return token;
}

module.exports = { accessToken, login, cloudflaredAvailable, looksLikeJwt, INSTALL_HINT };
