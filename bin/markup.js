#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Command } = require("commander");
const { startServer } = require("../src/serve");
const { startDashServer } = require("../src/dash");
const registry = require("../src/registry");
const { SERVE_PORT, DASH_PORT, isReserved, localUrl } = require("../src/ports");

const program = new Command();

function parsePort(raw) {
  const port = parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return port;
}

async function openBrowser(url) {
  try {
    const open = (await import("open")).default;
    await open(url);
  } catch (err) {
    // Non-fatal: log and continue.
    console.error(`markup: could not auto-open browser (${err.message})`);
  }
}

// What is answering on `port`? "dash" if it speaks the dashboard API, "other"
// if something answers but is not a dashboard, "free" if nothing answers.
// Probing `/` cannot tell these apart — every markup server returns 200 there,
// so a served artifact on the dashboard port used to masquerade as the dash.
async function probePort(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/instances`, {
      signal: AbortSignal.timeout(1000),
    });
  } catch (_err) {
    return "free";
  }
  if (!res.ok) return "other";
  try {
    const body = await res.json();
    return Array.isArray(body.instances) ? "dash" : "other";
  } catch (_err) {
    return "other";
  }
}

async function waitForPort(port, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if ((await probePort(port)) === want) return true;
    if (Date.now() >= deadline) return false;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

program
  .name("markup")
  .description("Point-and-click annotation layer for HTML review artifacts")
  .version("0.1.0");

program
  .command("serve <file>")
  .description("Wrap an HTML file with annotation overlay and serve on localhost")
  .option(
    "-p, --port <number>",
    `port to listen on (default: ${SERVE_PORT}, steps up when busy)`,
  )
  .option("--no-open", "do not auto-open the browser")
  .option(
    "--multiplayer",
    "shared annotations: store next to the source file and sync every open tab " +
      "(identity via ?as=you@example in the page URL)",
  )
  .action(async (file, opts) => {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      console.error(`markup: file not found: ${resolved}`);
      process.exit(1);
    }
    if (!resolved.toLowerCase().endsWith(".html") && !resolved.toLowerCase().endsWith(".htm")) {
      console.error(`markup: expected an .html file, got: ${resolved}`);
      process.exit(1);
    }
    let port;
    if (opts.port != null) {
      port = parsePort(opts.port);
      if (port == null) {
        console.error(`markup: invalid port: ${opts.port}`);
        process.exit(1);
      }
      if (isReserved(port)) {
        console.error(
          `markup: port ${port} is reserved for the dashboard (\`markup dash\`) — pick another`,
        );
        process.exit(1);
      }
    }
    try {
      const { url } = await startServer(resolved, {
        port,
        autoOpen: opts.open !== false,
        multiplayer: opts.multiplayer === true,
      });
      console.log(`markup: serving ${path.basename(resolved)} at ${url}`);
      console.log(`markup: press Ctrl+C to stop`);
    } catch (err) {
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("publish <file>")
  .description("Publish an HTML file to the shared canvas (ldpub) and print its URL")
  .option("--title <title>", "human title shown in listings (default: file stem)")
  .option("--user <user>", "namespace user segment (default: LDPUB_USER or $USER)")
  .option("--project <project>", "project slug (default: kebab-cased file stem)")
  .action(async (file, opts) => {
    try {
      const { publish } = require("../src/publish");
      const result = await publish(file, opts);
      console.log(`markup: published "${result.title}"`);
      console.log(`markup: shared canvas at ${result.url}`);
      console.log("markup: reviewers annotate right on that page; pull feedback with:");
      console.log(`markup:   markup pull ${result.url}`);
    } catch (err) {
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("pull <url>")
  .description("Fetch shared-canvas annotations and write the feedback bundle (md + PNGs)")
  .option("--dir <dir>", "directory to write the bundle into (default: cwd)")
  .action(async (url, opts) => {
    try {
      const { pull } = require("../src/publish");
      const result = await pull(url, opts);
      console.log(`markup: pulled ${result.count} annotation(s)`);
      console.log(`markup: wrote ${result.feedbackPath}`);
      if (result.assets && result.assets.length) {
        console.log(`markup: + ${result.assets.length} screenshot(s) in ${result.assetsDir}`);
      }
    } catch (err) {
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List running markup instances")
  .action(() => {
    const items = registry.list();
    if (!items.length) {
      console.log("(no markup instances running)");
      return;
    }
    const header = ["PORT", "PID", "FILE", "STARTED"];
    const rows = items.map((it) => [
      String(it.port),
      String(it.pid),
      it.sourceName + (it.kind === "dash" ? " [dash]" : ""),
      it.startedAt,
    ]);
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i].length)),
    );
    const fmt = (cols) =>
      cols.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log(fmt(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    rows.forEach((r) => console.log(fmt(r)));
  });

program
  .command("stop [target]")
  .description("Stop a running markup instance (by file path or port), or all of them with --all")
  .option("--port <number>", "stop by port number")
  .option("--all", "stop every running markup instance (serve + dash)")
  .action((target, opts) => {
    const items = registry.list();
    let toStop;

    if (opts.all) {
      toStop = items;
    } else if (opts.port) {
      const port = parseInt(opts.port, 10);
      toStop = items.filter((i) => i.port === port);
      if (!toStop.length) {
        console.error(`markup: no instance on port ${port}`);
        process.exit(1);
      }
    } else if (target) {
      const resolved = path.resolve(target);
      toStop = items.filter(
        (i) =>
          i.sourcePath === resolved ||
          i.sourcePath === target || // bridges register a doc URL, not a file path
          path.basename(i.sourcePath) === target,
      );
      if (!toStop.length) {
        console.error(`markup: no instance serving ${target}`);
        process.exit(1);
      }
    } else {
      console.error(`markup: pass a path, --port <n>, or --all`);
      process.exit(1);
    }

    let stopped = 0;
    for (const entry of toStop) {
      try {
        process.kill(entry.pid, "SIGTERM");
        registry.unregister(entry.port);
        console.log(`stopped :${entry.port} (${entry.sourceName})`);
        stopped += 1;
      } catch (err) {
        // Process already dead; just clean the registry entry.
        registry.unregister(entry.port);
        console.log(`stopped :${entry.port} (was already dead, cleaned registry)`);
      }
    }
    if (!stopped) {
      console.error(`markup: nothing stopped`);
      process.exit(1);
    }
  });

program
  .command("dash")
  .description("Open the markup dashboard listing all running instances")
  .option("-p, --port <number>", `dashboard port (default: ${DASH_PORT}, reserved)`)
  .option("--no-open", "do not auto-open the browser")
  .option("-d, --detach", "leave the dashboard running in the background and return")
  .option("--reclaim", "stop the markup instance holding the dashboard port and take it")
  .action(async (opts) => {
    const explicitPort = opts.port != null;
    let port = DASH_PORT;
    if (explicitPort) {
      port = parsePort(opts.port);
      if (port == null) {
        console.error(`markup: invalid port: ${opts.port}`);
        process.exit(1);
      }
    }

    const reuse = async (livePort, note) => {
      const url = localUrl(livePort);
      console.log(`markup: dashboard already running at ${url}${note}`);
      if (opts.open !== false) await openBrowser(url);
    };

    // The dashboard is a singleton. Reuse a live one before starting another.
    const state = await probePort(port);
    if (state === "dash") {
      const entry = registry.find(port);
      await reuse(port, entry ? ` (pid ${entry.pid})` : "");
      return;
    }
    if (!explicitPort) {
      const registered = registry.findDash();
      if (registered && (await probePort(registered.port)) === "dash") {
        await reuse(registered.port, ` (pid ${registered.pid}, off the reserved port)`);
        return;
      }
      // Registered but not answering: a crashed dash left its entry behind.
      if (registered) registry.unregister(registered.port);
    }

    // Something else holds the port. Name it, and only take it if asked to.
    if (state === "other") {
      const squatter = registry.find(port);
      if (!opts.reclaim) {
        const who = squatter ? `${squatter.sourceName} (pid ${squatter.pid})` : "another process";
        console.error(
          isReserved(port)
            ? `markup: port ${port} is reserved for the dashboard but held by ${who}`
            : `markup: port ${port} is held by ${who}`,
        );
        console.error(
          squatter
            ? `markup: free it with \`markup stop --port ${port}\` or \`markup dash --reclaim\`, or run \`markup dash --port <n>\``
            : `markup: stop that process, or run \`markup dash --port <n>\``,
        );
        process.exit(1);
      }
      if (!squatter) {
        console.error(
          `markup: port ${port} is held by a process markup does not own — nothing to reclaim`,
        );
        process.exit(1);
      }
      try {
        process.kill(squatter.pid, "SIGTERM");
      } catch (err) {
        if (err.code !== "ESRCH") {
          console.error(`markup: could not stop pid ${squatter.pid}: ${err.message}`);
          process.exit(1);
        }
      }
      registry.unregister(port);
      console.log(`markup: reclaimed :${port} from ${squatter.sourceName} (pid ${squatter.pid})`);
      if (!(await waitForPort(port, "free", 3000))) {
        console.error(`markup: port ${port} did not free up after stopping pid ${squatter.pid}`);
        process.exit(1);
      }
    }

    // Background start: re-exec this CLI detached, then wait for it to answer.
    if (opts.detach) {
      const child = spawn(
        process.execPath,
        [__filename, "dash", "--port", String(port), "--no-open"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      if (!(await waitForPort(port, "dash", 8000))) {
        console.error(`markup: dashboard did not come up on :${port} within 8s`);
        console.error(`markup: run \`markup dash\` in the foreground to see why`);
        process.exit(1);
      }
      const url = localUrl(port);
      console.log(`markup: dashboard at ${url} (background, pid ${child.pid})`);
      if (opts.open !== false) await openBrowser(url);
      return;
    }

    try {
      const { url } = await startDashServer({ port });
      console.log(`markup: dashboard at ${url}`);
      if (opts.open !== false) await openBrowser(url);
      console.log(`markup: press Ctrl+C to stop`);
    } catch (err) {
      if (err.code === "EADDRINUSE") {
        console.error(
          `markup: port ${port} is already in use — run \`markup dash --reclaim\` or pass --port <n>`,
        );
        process.exit(1);
      }
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("share <url>")
  .description("Share a published Marked Up doc into a private Slack channel")
  .option("--to <emails...>", "invite these people by email")
  .option("--test", "use the markd-test- channel prefix (John-only test channels)")
  .option("--channel <name>", "explicit channel name instead of markd-<slug>")
  .option("--state-dir <dir>", "bridge state directory (default ~/.markup/bridge)")
  .action(async (url, opts) => {
    const { shareDoc } = require("../src/slackops/share");
    try {
      const result = await shareDoc({
        docUrl: url,
        to: opts.to || [],
        test: opts.test === true,
        channelOverride: opts.channel,
        stateDir: opts.stateDir,
      });
      console.log(`markup: shared to #${result.channelName} (${result.channelId})`);
      console.log(`markup: start the bridge with \`markup bridge ${url}${opts.test ? " --test" : ""}\``);
    } catch (err) {
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("bridge <url>")
  .description("Mirror annotations to the doc's Slack channel and thread replies back")
  .option("--test", "use the markd-test- channel prefix")
  .option("--channel <name>", "explicit channel name instead of markd-<slug>")
  .option("--interval <seconds>", "poll interval (default 30, min 15)")
  .option("--once", "run a single sync cycle and exit")
  .option("--no-archive", "do not archive the channel when everything is resolved")
  .option("--state-dir <dir>", "bridge state directory (default ~/.markup/bridge)")
  .action(async (url, opts) => {
    const { startBridge } = require("../src/slackops/bridge");
    const { channelNameFor } = require("../src/slackops/share");
    const { parseDocUrl } = require("../src/slackops/api-client");
    try {
      const { user, project } = parseDocUrl(url);
      const channelName = channelNameFor({
        user,
        project,
        test: opts.test === true,
        channelOverride: opts.channel,
      });
      const result = await startBridge({
        docUrl: url,
        channelName,
        stateDir: opts.stateDir,
        intervalMs: opts.interval ? parseInt(opts.interval, 10) * 1000 : undefined,
        archiveOnResolve: opts.archive !== false,
        once: opts.once === true,
      });
      if (opts.once && result) {
        console.log(
          `markup: cycle done: ${result.posted} posted to Slack, ${result.ingested} ingested${result.archived ? ", channel archived" : ""}`,
        );
      }
    } catch (err) {
      console.error(`markup: ${err.message}`);
      process.exit(1);
    }
  });

// `markup foo.html` is shorthand for `markup serve foo.html`. Only the first
// argument is considered, and only when it is unambiguously a file rather than
// a subcommand or a flag — so a typo like `markup lst` still gets commander's
// "unknown command" instead of a confusing "file not found".
function withImpliedServe(argv) {
  const rest = argv.slice(2);
  const [first] = rest;
  if (!first) return argv;
  const names = program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);
  if (names.includes(first)) return argv;
  // An .html argument anywhere is the signal, so flags may lead (`markup
  // --port 9000 foo.html`). Bare existing paths count too, letting serve's own
  // check produce the "expected an .html file" error rather than commander.
  const hasFileArg = rest.some((arg) => /\.html?$/i.test(arg)) || fs.existsSync(first);
  if (!hasFileArg) return argv;
  return [...argv.slice(0, 2), "serve", ...rest];
}

program.parseAsync(withImpliedServe(process.argv)).catch((err) => {
  console.error(`markup: ${err.message}`);
  process.exit(1);
});
