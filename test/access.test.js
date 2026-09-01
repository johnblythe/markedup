// SSO auth for the shared canvas: header resolution order and the
// cloudflared-backed token/login helpers, with the binary stubbed out.

const { test } = require("node:test");
const assert = require("node:assert");

const Access = require("../src/access");
const { authHeaders } = require("../src/publish");

const APP = "https://canvas.example.com";
const JWT = "eyJhbGc.eyJzdWIi.c2ln";

function runnerReturning(byCommand) {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args[0] === "access" ? args[1] : args[0];
    return byCommand[key] || { status: 1, stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

test("looksLikeJwt accepts three base64url segments only", () => {
  assert.ok(Access.looksLikeJwt(JWT));
  assert.ok(!Access.looksLikeJwt("Unable to find token for provided application."));
  assert.ok(!Access.looksLikeJwt(""));
  assert.ok(!Access.looksLikeJwt("a.b"));
});

test("accessToken returns the cached JWT, null when logged out", () => {
  const loggedIn = runnerReturning({ token: { status: 0, stdout: `${JWT}\n` } });
  assert.strictEqual(Access.accessToken(APP, { runner: loggedIn }), JWT);

  const loggedOut = runnerReturning({ token: { status: 1, stdout: "" } });
  assert.strictEqual(Access.accessToken(APP, { runner: loggedOut }), null);

  // A non-JWT success body (cloudflared error text) must not pass as a token.
  const garbage = runnerReturning({ token: { status: 0, stdout: "no token here" } });
  assert.strictEqual(Access.accessToken(APP, { runner: garbage }), null);
});

test("login demands cloudflared and returns the fresh token", () => {
  const missing = runnerReturning({});
  missing.calls.length = 0;
  assert.throws(() => Access.login(APP, { runner: missing }), /brew install cloudflared/);

  const ok = runnerReturning({
    "--version": { status: 0, stdout: "cloudflared version test" },
    login: { status: 0, stdout: "" },
    token: { status: 0, stdout: JWT },
  });
  assert.strictEqual(Access.login(APP, { runner: ok }), JWT);
});

test("authHeaders prefers a configured service token", () => {
  const headers = authHeaders(
    { clientId: "id", clientSecret: "secret" },
    APP,
    { runner: runnerReturning({}), interactive: false },
  );
  assert.deepStrictEqual(headers, {
    "CF-Access-Client-Id": "id",
    "CF-Access-Client-Secret": "secret",
  });
});

test("authHeaders falls back to the caller's SSO session", () => {
  const runner = runnerReturning({ token: { status: 0, stdout: JWT } });
  const headers = authHeaders({}, APP, { runner, interactive: false });
  assert.deepStrictEqual(headers, { "cf-access-token": JWT });
});

test("authHeaders without a session and without a TTY says how to log in", () => {
  const runner = runnerReturning({ "--version": { status: 0, stdout: "v" } });
  assert.throws(() => authHeaders({}, APP, { runner, interactive: false }), /markup login/);
});
