---
name: markup
description: Bridge between any HTML-producing agent flow and the Markup annotation tool. Serves an HTML artifact at a localhost port the user can click + annotate + export feedback from. Invoke when the user says "serve this in markup", "markup it", "open in markup", "markup serve", "/markup", "show me in markup", or asks to list/stop running markup instances or open the markup dashboard.
---

# Markup Skill

Bridge between HTML-producing sessions and the Markup annotation tool installed at `~/code/markup/`.

## What Markup is

Markup is a local CLI tool. It wraps any rendered HTML artifact in a browser annotation overlay served on localhost. Three annotation modes (text-span highlight, element-pin, drag-rectangle screenshot). User reviews, exports a feedback bundle (markdown + cropped PNGs), pastes back to the agent. Source HTML never modified. See the repo README for details.

The Markup CLI is installed globally as `markup` (via `npm link` from `~/code/markup/`).

## When to invoke this skill

- User explicitly types `/markup` or `/markup <subcommand>`
- User says natural-language triggers: "serve this in markup", "markup it", "open this in markup", "markup serve", "show me in markup"
- User asks to "list markup instances", "stop markup", "open markup dashboard"
- User asks to "apply markup feedback", "pick up markup feedback", "pull in feedback from markup"

Do NOT proactively suggest running this skill after writing an HTML file. The user wants this to be user-driven only; do not push it.

## CRITICAL: Session-scoped operation

**Default scope is THIS session only.** Markup is a fleet tool — the user may have many instances running, serving artifacts from other Claude sessions, other projects, totally unrelated work. **Never sweep across all running instances.** Never read or modify HTML files that this session did not produce or explicitly reference.

When the user says "apply feedback" or "pick up the markup feedback":

1. **Default target = the HTML file(s) THIS session wrote or directly referenced.** Scan recent assistant Write/Edit tool calls for `*.html` file_paths produced or modified in the current conversation.
2. **If exactly one HTML artifact was produced in this session:** apply feedback to that one only. Do not look at other running markup instances. Do not read feedback files for other artifacts.
3. **If multiple HTML artifacts were produced in this session:** ask the user which one. Never assume.
4. **If zero HTML artifacts were produced in this session:** ask for the explicit path. Do NOT fall back to scanning `markup list` for currently-running instances and picking one — those belong to other sessions.
5. **Never read `.feedback-*.md` files for HTML files outside this session's scope without express user direction.** Other sessions' artifacts are out of bounds by default. The user must name the specific path or explicitly say "yes, that one too" before any cross-session feedback file is read, parsed, or applied. Existence on disk is not permission. Currently-running markup instance is not permission. Only an explicit user instruction is permission.

The presumption nine times out of ten is the most recent HTML written in this conversation. Other running markup instances are explicitly other people's (other sessions') problem. Do not boil the ocean.

If unsure between two candidates, ask:
```
Which artifact's feedback should I apply?
1. <session-produced-path>          ← this session
2. <session-produced-other-path>    ← this session
3. Other (specify path)
```
Never include other-session paths in those options unless the user explicitly names one.

## Subcommands

### `/markup` or `/markup <path>` — serve

Start (or reuse) a Markup server for an HTML artifact.

**Path resolution priority:**
1. Explicit argument (`/markup foo.html`) — use as given. Resolve to absolute path.
2. No argument — auto-detect by scanning the recent conversation for HTML files this assistant has written or edited. Look back through the assistant's tool-use history for Write or Edit calls whose `file_path` ends in `.html` or `.htm`. Pick the most recent. If multiple in the last few turns, pick the one most recently written.
3. Nothing detected — fail with: `markup: pass a path; no recent .html artifact found in this session`.

**Idempotence — always check first:**

```bash
markup list
```

Parse the output. If a running instance's FILE column matches the basename of the target path (or matches the absolute path via a more thorough check), do NOT restart. Report the existing URL with `(already running — pid N)`.

If no match, start a fresh server in background:

```bash
markup serve <absolute-path> --no-open &
```

Wait briefly (1–2 seconds) for the server to bind and print its `serving at http://127.0.0.1:<port>/` line, then capture the port. Verify it bound by hitting `curl -sI http://127.0.0.1:<port>/`. If 200, return:

```
✓ Serving <basename> at http://localhost:<port>/
  Open + annotate. → Clipboard pastes back here. → Disk writes timestamped feedback bundle next to source.
```

**Auto-fallback:** Markup already auto-increments ports on collision (7778 → 7779 → ...), skipping 7780 since that port is reserved for `markup dash`. Do not pass `--port` unless the user explicitly asked for a specific port.

### `/markup list` — show running

Run `markup list` and pass the output through verbatim to the user. Add nothing.

### `/markup dash` — open dashboard

```bash
markup dash --detach --no-open
```

This handles reuse, contention, and backgrounding itself: it reuses a live dashboard if one is already running, and prints a line with the URL either way (`dashboard already running at ...` or `dashboard at ... (background, pid N)`). Parse the URL out of that line and return it with a short reminder that auto-refresh polls every 5s.

If it instead errors that port 7780 is held by something other than the dashboard, surface the error verbatim — it already suggests `markup dash --reclaim` (stop the squatting markup instance and take the port) or `markup dash --port <n>` (run the dashboard elsewhere).

### `/markup stop [target]` — kill instance(s)

Translate to the CLI:
- `/markup stop` (no arg) — stop the instance matching the most recent target from this session (the file you'd resolve with auto-detect). If ambiguous, list candidates and ask.
- `/markup stop <path>` — `markup stop <path>`
- `/markup stop --port <n>` — `markup stop --port <n>`
- `/markup stop all` or `/markup stop --all` — `markup stop --all`

Pass output through verbatim.

## Failure modes

| Situation | What to do |
|-----------|------------|
| `markup` command not on PATH | Tell user: "Markup CLI not installed. `cd ~/code/markup && npm link` first." |
| Path doesn't exist | Fail with `markup: file not found: <path>` |
| Path isn't an HTML file | Fail with `markup: expected an .html file, got <path>`. (The CLI enforces this itself, surface its error.) |
| All ports busy (32+ tries failed) | Surface the CLI error verbatim. User can kill instances via `/markup stop --all` then retry. |
| Dashboard port (7780) held by a serve instance | `markup dash --detach --no-open` will error naming the squatter. Surface it verbatim; it suggests `markup dash --reclaim` or `markup dash --port <n>`. |
| Auto-detect found nothing | `markup: pass a path; no recent .html artifact found in this session` |
| Auto-detect ambiguous (multiple recent .html files) | Pick the single most recent. Tell user which and offer to re-run with explicit path if wrong. |

## Output style

Terse. URL is the headline. One-line reminder of clipboard vs disk export only on fresh start (skip for `(already running)` case).

Bad:
```
I have successfully started a Markup server for your file. You can now open
your browser to the URL below and annotate the document. When you are done,
click the Export to Clipboard button to copy the feedback as markdown...
```

Good:
```
✓ Serving incident-report-2026-05-18.html at http://localhost:7778/
  Annotate, then → Clipboard pastes back here.
```

## Source code reference

The CLI lives wherever you cloned it (`~/code/markup/` by default). If the user asks to modify Markup itself (add a feature, fix a bug, build a different mode), navigate there and treat it as a normal coding task — this skill is just the bridge.
