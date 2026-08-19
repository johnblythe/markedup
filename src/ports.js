// Port policy for markup servers.
//
// Two kinds of server share localhost: one `markup serve` per artifact, which
// steps up from SERVE_PORT when a port is busy, and the single `markup dash`
// dashboard. DASH_PORT is reserved — serve instances step over it — so the one
// URL worth bookmarking always belongs to the dashboard.

const SERVE_PORT = 7778;
const DASH_PORT = 7780;
const RESERVED_PORTS = new Set([DASH_PORT]);
const MAX_PORT_TRIES = 32;

function isReserved(port) {
  return RESERVED_PORTS.has(port);
}

function localUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

// Bind `server` to `preferredPort`. With `fallback`, step up one port at a time
// (up to MAX_PORT_TRIES candidates) past anything already bound, skipping every
// port in `skip`. A preferred port of 0 always means "let the OS pick".
async function listenWithFallback(server, preferredPort, { fallback = true, skip } = {}) {
  const skipSet = skip || new Set();
  const candidates = [];
  if (!fallback || preferredPort === 0) {
    candidates.push(preferredPort);
  } else {
    for (let p = preferredPort; p <= 65535 && candidates.length < MAX_PORT_TRIES; p += 1) {
      if (!skipSet.has(p)) candidates.push(p);
    }
  }

  let lastErr = null;
  for (const tryPort of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort, "127.0.0.1");
      });
      return; // bound successfully
    } catch (err) {
      lastErr = err;
      if (err.code !== "EADDRINUSE") throw err;
      // else try the next candidate
    }
  }
  throw lastErr || new Error("could not bind any port");
}

module.exports = {
  SERVE_PORT,
  DASH_PORT,
  RESERVED_PORTS,
  MAX_PORT_TRIES,
  isReserved,
  localUrl,
  listenWithFallback,
};
