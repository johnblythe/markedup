# Changelog

All notable changes to **markup** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely, and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Shared-canvas destructive ops are scoped to your own annotations: deleting
  someone else's note is refused (deletion tombstones the id forever), and
  "Clear all" in remote mode clears only yours and says so.
- The local annotations store writes atomically (temp file + rename) and
  refuses to touch a corrupt annotations file — a parse failure is loud and
  returns 500 instead of silently reading as empty and clobbering the review
  on the next write.
- `markup serve --multiplayer` refuses to start when another live process
  already serves the same file in multiplayer mode (two processes would
  interleave writes on one annotations JSON).
- The feedback bundle flattens notes, quotes, and replies before
  interpolating them into markdown, so a malicious note can't forge headings
  or code fences aimed at the agent consuming the bundle.

### Added

- Highlighter mode (LD-171): toolbar button + `H` shortcut. Selecting a text
  span while active creates a highlight annotation immediately, no popover.
  Renders as a translucent yellow swipe over the span; clicking an existing
  highlight reopens the popover to add a note or delete it. Exports as
  `[HIGHLIGHT] "<span text>"` in both the clipboard and disk bundles.
- Red strikethrough mode (LD-172): toolbar button + `X` shortcut. Selecting a
  text span while active creates a delete annotation immediately, no
  popover. Renders as a red strikethrough; clicking an existing strike
  reopens the popover to add a reason or remove it. Exports as
  `[DELETE] "<span text>"` in both the clipboard and disk bundles.
- **Shared canvas (multiplayer).** The overlay's storage layer is now a
  dual driver: localStorage by default (unchanged), or a remote driver
  syncing through the Marked Up annotations API when the wrapper injects
  `__MARKUP_REMOTE__`. Remote mode hydrates before boot, polls with
  ETag/If-None-Match every ~10 s (paused while a popover is open), stamps
  authors server-side, renders other reviewers' marks violet with author
  tooltips, and shows reply threads in the sidebar.
- `markup publish <file>` — publish an artifact to the ldpub Worker
  (Cloudflare Access gated) and print the shared canvas URL; also refreshes
  the overlay assets the Worker injects. `markup pull <url>` — fetch the
  shared annotation set and write the standard feedback bundle, now with
  authors, states, and reply threads (`src/feedback.js`).
- `markup serve --multiplayer` — local shared canvas: annotations persist
  in `<source>.annotations.json` and sync across tabs; per-tab identity via
  `?as=you@example`. The contract's HTTP API (`/api/{user}/{project}/…`)
  is mounted on every serve instance (`src/annostore.js`), identity via
  `X-Markup-User`, so it doubles as the integration stub for bridge tooling.
- Rect screenshots on a shared canvas upload as PNGs to the shots endpoint
  (`shotUrl`) instead of traveling inline; other reviewers' thumbnails load
  from the server.
- `markup <file.html>` as shorthand for `markup serve <file.html>`, flags
  included (`markup brief.html --port 9000`). The `serve` word is implied only
  when the first argument is not a known subcommand and an `.html` argument is
  present, so a mistyped subcommand still gets commander's "unknown command"
  rather than a confusing "file not found".
- `src/ports.js` as the single source of port policy: `SERVE_PORT` (7778),
  `DASH_PORT` (7780), `RESERVED_PORTS`, and a shared `listenWithFallback`
  used by both `serve` and `dash` (their duplicated fallback logic is gone).
- `markup dash --detach` (`-d`) starts the dashboard in the background,
  waits until it answers, prints the URL, and returns.
- `markup dash --reclaim` stops a squatting markup instance holding the
  dashboard port and takes it.
- `markup dash` reuses a live dashboard instead of starting a second one,
  including one running on a non-standard port from a previous `--port`
  invocation.
- `registry.find(port)` and `registry.findDash()` for locating a specific
  instance or the singleton dashboard.

### Fixed

- Keystrokes typed into MarkedUp's own text-entry surfaces (popover note
  field, sidebar drawer) leaked to the host page's own keyboard handlers —
  e.g. typing a space into an annotation note advanced a slide deck listening
  for spacebar on `document`. Capture-phase listeners on `window` now stop
  propagation for keydown/keyup/keypress originating in MarkedUp's own UI
  before the host page ever sees them, without touching `preventDefault`, so
  typing and native text-field shortcuts are unaffected.
- `markup serve` could step up onto the dashboard's port (7780), so a third
  or later instance could squat the port the dashboard needs.
- `markup dash` no longer silently drifts to a fallback port when 7780 is
  taken; it binds 7780 strictly and reports the conflict instead.
- A plain `/` probe couldn't tell a dashboard from a served artifact (both
  return 200), so a served artifact on the dashboard port could masquerade
  as the dashboard. `dash` now probes `/api/instances`, a dashboard-only
  route.

## [0.1.2] - 2026-06-22

### Changed

- Dashboard cards now show full local start date+time plus a relative age
  (`Xm`/`Xh`/`Xd ago`) so stale instances are easier to spot.
- Dashboard now includes a per-instance **Stop** button that sends `SIGTERM` to
  the registered PID and removes the registry entry.

## [0.1.1] - 2026-06-22

### Changed

- Export-to-disk now auto-copies the written feedback markdown path to the
  clipboard on success.
- The export success toast is now actionable: click (or press Enter/Space) to
  copy the feedback path again.

## [0.1.0] - 2026-05-20

First public-shareable cut. MVP plus the round-trip review surface and the
multi-instance dashboard. Stable enough to dogfood across artifacts.

### Added

#### Core annotation engine
- `markup serve <file.html>` wraps a rendered HTML artifact with a localhost
  annotation overlay. Source HTML is never modified — all state lives in
  `localStorage` and the export bundle.
- Three annotation modes:
  - **Text-span**: select any prose, leave a note. Selection wraps in a
    highlighted `<mark>` immediately on save (pending-preview while popover
    open, finalized on Save).
  - **Element-pin**: click any element, drop a numbered badge (`①②③…`) with
    a note. Anchored by CSS-path; repositions on scroll/resize.
  - **Drag-rectangle**: shift-drag (or toggle Rect mode) anywhere on the page,
    auto-screenshot the region via `modern-screenshot`, attach a note. Rect
    outline lingers as a visual reminder after save.
- Inline `<mark>`, pin badge, and rect outline are click-targets that reopen
  their popover for edit / accept / remove.
- Popover keyboard support: `Esc` cancels, `Cmd/Ctrl+Enter` saves.
- Power keys for mode toggling and exports: `T`, `P`, `R`, `C`, `D`, `Esc`.

#### Export
- **`→ Clipboard`** copies a markdown payload to the clipboard. Rect
  screenshots inline as base64 `data:image/png;…` URIs so a paste into Claude
  Code chat preserves both text and images.
- **`→ Disk`** writes a timestamped feedback bundle next to the source:
  `<stem>.feedback-YYYYMMDD-HHMMSS.md` plus `<stem>.feedback-YYYYMMDD-HHMMSS.assets/`.
  Every export is additive — re-running produces a new breadcrumb, never
  clobbers a prior one. Sub-second double-exports gain a `-2`, `-3` suffix.
- Markdown payload structured by mode (Span / Pin / Rect) with CSS-path,
  tag name, anchor text quote, and note. Rect screenshots embedded inline
  (clipboard) or referenced by relative path (disk).

#### Review panel
- Sidebar lists every annotation grouped by lifecycle state:
  - **Pending** — anchor lost OR carried over from a previous source version.
    Actions: *Where it was* (scrolls to last-known coords + pulsing ghost
    outline), *Re-attach* (next click sets a new anchor), *Accept*, *Remove*.
  - **Open** — still attached to the current DOM. Actions: *Where it is*,
    *Accept*, *Remove*.
  - **Accepted** — kept for the record, collapsed by default. Actions:
    *Where it was*, *Re-open*, *Remove*.
- Bulk actions per section: Accept all / Re-open all / Remove all.
- Toolbar `Review (N)` button surfaces pending count.

#### Source-version awareness
- Server stamps a SHA-1 content hash of the source HTML into each page load.
- Client compares against the last-seen hash in `localStorage`. When the
  hash changes, every open annotation is migrated to Pending with a
  `FROM V-1` badge plus `carryReason: "source-changed"`, and the review
  banner reads *"Source changed since your last review. N annotations
  carried over — triage each."*
- Annotations whose anchor cannot be re-resolved after reload bump to
  Pending with `carryReason: "anchor-lost"`, regardless of source change.

#### Schema
- Every annotation now stores a `viewportRect: {x, y, w, h}` in document
  coordinates at save time, so the "Where it was" affordance can fly back
  to the original location even after the anchor breaks.

#### Multi-instance support
- `markup list` prints a table of currently-running instances: port, pid,
  source filename, started timestamp.
- `markup dash` opens a browser dashboard listing all running instances
  with iframe live previews and Open / Copy-path buttons. Auto-refreshes
  every 5 seconds. The dashboard hides itself from its own list.
- `markup stop` stops a running instance by source path, by `--port <n>`,
  or by `--all`. Cleans the registry whether the process was killed or
  already dead.
- Registry lives at `~/.markup/instances/<port>.json`. Lifecycle hooks
  remove the file on graceful shutdown, on SIGINT/SIGTERM, and on
  uncaught exception. `markup list` lazily cleans entries whose pids are
  no longer alive.
- Server and dashboard both auto-fall-back to the next free port when
  their preferred port is busy (default `serve` 7778, default `dash` 7780;
  up to 32 retries). No more `EADDRINUSE` failures when running multiple
  instances side by side.

#### CLI ergonomics
- `--no-open` to skip launching the browser.
- `--port <n>` to pin a specific port (overrides auto-fallback).
- Browser auto-launch via the `open` npm package (safe `execFile`-backed
  cross-platform launch).

#### Documentation
- Brainstorm document at `docs/brainstorms/2026-05-19-markup-requirements.md`
  capturing the original problem frame, scope, and key decisions.
- Implementation plan at `docs/plans/2026-05-19-001-feat-markup-mvp-plan.md`
  with U-IDs U1-U6 and a "Deferred to Follow-Up Work" section.


#### Tests
- 36 passing tests across CLI parsing, HTML wrapping idempotence, server
  routing, path-traversal guards, byte-identical source preservation,
  stamped export bundles, registry lifecycle (including stale-pid cleanup),
  and the dashboard API.

### Changed

- "Delete" → "Remove" everywhere in the popover and sidebar copy. Softer
  verb, accurate semantics.

### Design decisions worth noting

- **Two export paths, not one.** Clipboard for live-session paste; disk for
  fresh-session or file-reading agents. Both share the same markdown shape
  modulo inline-vs-referenced screenshots.
- **`modern-screenshot` over `html2canvas`** for drag-rect rasterization.
  Better SVG handling, the common case for rendered artifacts (charts).
- **Inline client bundle, no separate `script.js`.** Avoids `file://`
  cross-origin headaches and keeps wrapping self-contained.
- **`localStorage` keyed by absolute source path.** Same artifact opened on
  two different ports sees the same annotations. Two different artifacts
  stay isolated automatically.
- **Default ports: serve 7778, dash 7780.** Inkwell uses 7777, so we
  deliberately step around it.

### Out of scope (deferred to future versions)

- Hosted / remote URL annotation (Notion, Confluence, GitHub PR pages).
  That's a bookmarklet-shaped sibling product, not part of this CLI.
- Multi-reviewer / collaborative annotation. Single-user, local-only by
  design.
- Inline source editing from the overlay. Mutation belongs to the
  producing agent.
- Markdown ingestion. Use `render` or `inkwell` to produce HTML first.
- Code or PR review. GitHub native.
- Mac menu-bar widget for system-wide annotation. Logged as a V3 dream in
  the plan's `Deferred to Follow-Up Work` section.

### Companion artifacts

- A Claude Code skill at `~/.claude/skills/markup/SKILL.md` (not part of
  this repo, but shipped alongside) bridges agent sessions to the
  Markup CLI. The skill is session-scoped by design and will not read
  feedback files for artifacts outside the current conversation without
  explicit user direction.

[Unreleased]: https://github.com/USER/markup/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/USER/markup/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/USER/markup/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/USER/markup/releases/tag/v0.1.0
