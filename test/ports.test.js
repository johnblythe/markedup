const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { SERVE_PORT, DASH_PORT, isReserved, listenWithFallback } = require("../src/ports");

// Bind then immediately release, handing back a port that was free a moment
// ago. Never a hardcoded literal, so it can't collide with real markup
// servers (7778-7781) or anything else on the machine.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("isReserved reflects RESERVED_PORTS", () => {
  assert.strictEqual(isReserved(DASH_PORT), true);
  assert.strictEqual(isReserved(SERVE_PORT), false);
});

test("listenWithFallback binds an OS-assigned port when preferredPort is 0", async () => {
  const server = http.createServer();
  try {
    await listenWithFallback(server, 0);
    const actual = server.address().port;
    assert.ok(Number.isInteger(actual) && actual > 0);
  } finally {
    server.close();
  }
});

test("listenWithFallback with fallback:false rejects immediately on a busy port", async () => {
  const squatter = net.createServer();
  const busyPort = await new Promise((resolve, reject) => {
    squatter.once("error", reject);
    squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port));
  });
  const server = http.createServer();
  try {
    await assert.rejects(
      () => listenWithFallback(server, busyPort, { fallback: false }),
      (err) => err.code === "EADDRINUSE",
    );
  } finally {
    server.close();
    squatter.close();
  }
});

test("listenWithFallback steps past a free port that is in the skip set", async () => {
  // freePort was just released, so if `skip` were ignored the very first
  // bind attempt would succeed there. Landing anywhere past it proves the
  // skip set was actually honored, not just incidental busy-port stepping.
  const freePort = await getFreePort();
  const server = http.createServer();
  try {
    await listenWithFallback(server, freePort, { skip: new Set([freePort]) });
    const actual = server.address().port;
    assert.notStrictEqual(actual, freePort, "should not bind the skipped port even though it was free");
    assert.ok(actual > freePort, "should step forward past the skipped port");
  } finally {
    server.close();
  }
});
