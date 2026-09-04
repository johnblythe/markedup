# Changelog

All notable changes to **markup** are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely, and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tokenless publish/pull: `markup login` signs a person into the shared
  canvas with their own SSO (via cloudflared), and `markup publish` /
  `markup pull` ride that session automatically — no minted service tokens
  per person, and attribution is the caller's real email. Service tokens
  still win when configured (agents/CI), and remain required for overlay
  asset refresh; SSO publishers skip the asset step with a notice. The
  canvas URL defaults to the shared instance, so a coworker's setup is
  `brew install cloudflared` + `markup login`, done (#3).
- Two-persona local sandbox: `markup serve <file> --multiplayer` prints two
  ready-to-open URLs (`?persona=jb`, `?persona=jb2`) so one person can review
  from two browser tabs as two identities. `?persona=` is the identity param
  (older `?as=` still works; persona wins when both are given). Stub-only —
  the Worker still ignores client-supplied identity for JWT callers (#3).
- Inline reply composer: every note in the review drawer takes threaded
  replies right on the doc (shared canvas and local multiplayer). Replies
  show the author and relative time; Cmd/Ctrl+Enter sends, Esc closes the
  composer; new replies from others arrive on the regular sync. Slack-bridged
  replies land in the same thread (#3).
- Guided review walk: the badge's "N new" pill is clickable and jumps to the
  next unseen note; j/k step through every note (drawer entry highlighted,
  page scrolled to the inline mark); the drawer orders unseen-then-others-
  then-yours so a top-to-bottom pass covers the whole review (#3).
- One export CTA: a primary "Copy for your agent" button (whole review as
  markdown, on the clipboard) with the .md download and a copyable
  `markup pull <url>` command tucked behind "⋯" (#3).
- Presence: the badge quietly shows who else has the doc open ("Corbin ·
  viewing") or how recently they looked ("Corbin · 3m ago"), fed by the
  existing poll; disappears entirely if the endpoint is unavailable (#3).
- Human status labels in the drawer and popover (display only; stored values
  unchanged): "Open", "Needs another look", "Resolved", and "Moved:
  re-attach" for a note whose anchor moved (#3).
- Shared-canvas badge in the overlay chrome (remote mode only): names the
  doc, carries a live "N new" count of other reviewers' notes arrived since
  you last opened the review drawer, and expands a help panel explaining the
  shared workflow and how to hand the review to an agent. Solo mode is
  unchanged. The "new" count is tracked per viewer in that viewer's own
  localStorage and degrades gracefully when the store is blocked (#3).
- Highlighter mode (LD-171): toolbar button + `H` shortcut. Selecting a text
  span while active creates a highlight annotation immediately, no popover.
  Renders as a translucent yellow swipe over the span; clicking an existing
  highlight reopens the popover to add a note or delete it. Exports as
  `[HIGHLIGHT] "<span text>"` in both the clipboard and disk bundles (#2).
- Red strikethrough mode (LD-172): toolbar button + `X` shortcut. Selecting a
  text span while active creates a delete annotation immediately, no
  popover. Renders as a red strikethrough; clicking an existing strike
  reopens the popover to add a reason or remove it. Exports as
  `[DELETE] "<span text>"` in both the clipboard and disk bundles (#2).
- **Shared canvas (multiplayer).** The overlay's storage layer is now a
  dual driver: localStorage by default (unchanged), or a remote driver
  syncing through the Marked Up annotations API when the wrapper injects
  `__MARKUP_REMOTE__`. Remote mode hydrates before boot, polls with
  ETag/If-None-Match every ~10 s (paused while a popover is open), stamps
  authors server-side, renders other reviewers' marks violet with author
  tooltips, and shows reply threads in the sidebar (#3).
- `markup publish <file>` — publish an artifact to the ldpub Worker
  (Cloudflare Access gated) and print the shared canvas URL; also refreshes
  the overlay assets the Worker injects. `markup pull <url>` — fetch the
  shared annotation set and write the standard feedback bundle, now with
  authors, states, and reply threads (`src/feedback.js`) (#3).
- `markup serve --multiplayer` — local shared canvas: annotations persist
  in `<source>.annotations.json` and sync across tabs; per-tab identity via
  `?as=you@example`. The contract's HTTP API (`/api/{user}/{project}/…`)
  is mounted on every serve instance (`src/annostore.js`), identity via
  `X-Markup-User`, so it doubles as the integration stub for bridge tooling (#3).
- Rect screenshots on a shared canvas upload as PNGs to the shots endpoint
  (`shotUrl`) instead of traveling inline; other reviewers' thumbnails load
  from the server (#3).
- Slack ops loop (`docs/slack-ops.md`): `markup share <url>` binds a published
  doc to a private Slack channel (creates or reuses `#markd-<slug>`, invites
  reviewers, posts a link card, reopens an archived channel for a new round);
  `markup bridge <url>` mirrors annotations into the channel as one thread per
  note and carries thread replies back to the annotations API (`via: "slack"`),
  with restart-safe on-disk state, ETag polling, and summary + auto-archive
  when every annotation is accepted. Uses the `ld slack` CLI; runs laptop-bound,
  no Slack app. Includes an in-memory stub of the multiplayer annotations API
  contract (`test/stub-api.js`) runnable standalone for local testing.
  Share/bridge accept a local `markup serve --multiplayer` root URL as
  printed (persona param included): the local project is discovered from the
  running instance, per-viewer params are stripped from anything persisted,
  and the link card carries the plain root URL.
  Owner digest: `--owner <email>` makes the bridge post one coalesced,
  debounced heads-up when others annotate (channel message by default,
  `--nudge-to dm` for a DM, `--nudge-to off` to disable), and `markup share`
  retries briefly when run straight after a fresh publish.
  Hardened after adversarial review: share/bridge refuse any API origin other
  than `LDPUB_URL` (https) or localhost and only ever send the service token
  to the configured origin; sends and reply ingests reconcile against the
  channel so a landed-but-timed-out call never double-posts; canvas-deleted
  annotations are pruned; CLI args are positional-safe; `--channel` is
  slugified; bridge registry keys derive from the channel name (#3).
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

### Changed

- "Copy for your agent" (the C shortcut and the palette command) now copies
  only unresolved annotations, with an instruction header teaching the
  receiving agent an incremental-feedback protocol: keep an append-only
  `<artifact>.feedback-ledger.md` (create it if missing, append each batch
  under a timestamp heading) and act only on the current batch. Resolved
  rounds stay in the drawer and the ledger instead of re-entering agent
  context every paste; with nothing unresolved, the copy no-ops with a toast.
  Download and disk exports remain full-record (#7).
- Ownership is checked in one place: the drawer, popover paths, and toolbar
  count all use `Persist.ownsAnnotation` instead of three hand-rolled
  derivations (#6).
- One slug implementation: `publish.js`'s `kebab` (with a
  `slugFromSourceName` layer for filename-derived URL segments that must
  never come back empty) replaces four near-identical copies across serve,
  publish, and slackops (#6).
- `relTime` is defined once (popover) and reused by the drawer (#6).
- `test/stub-api.js` mirrors the hardened annostore contract (author-only
  delete, status-only cross-author PUT, create-time number arbitration), so
  the slackops tests exercise the real rules (#6).
- Em dashes swept out of code comments, UI strings, and docs in favor of
  commas, colons, semicolons, and parentheses. Visible change: the "Moved —
  re-attach" status label is now "Moved: re-attach" (#6).
- Review drawer redesigned for at-a-glance triage: flat hairline-divided rows
  instead of bordered cards; author avatar + name in a deterministic
  per-author color with a relative timestamp; the anchored quote sits above
  the note and is the jump affordance (click it to go to the spot), replacing
  the "Where it is/was" buttons; lifecycle chips removed (the section already
  says the status; pending rows still say why, e.g. "Moved — re-attach");
  actions are quiet chips with Resolve alone tinted and Remove set apart on
  the right; reply threads render as plain lines behind a thin rule (#3).
- Strip controls share one explicit height; sizing no longer drifts with each
  control's font size and padding (#3).
- Another reviewer's note opens read-only: the popover shows their words with
  author and time, and offers exactly the actions that work — Resolve, Reply
  (jumps to the drawer composer), Close. The drawer likewise hides Remove and
  Re-attach on notes you don't own. Your own notes keep the full editor. Solo
  mode is unchanged (#3).
- Popover buttons regrouped: Remove sits alone at the far left, and the
  action group (Resolve · Cancel · Save) holds the right edge with the
  primary always rightmost (#3).
- The "⋯" export options open as a compact popup anchored to the button —
  only the two secondary items — closing on outside click or Esc (#3).
- One floating surface: the shared-canvas badge (name, N-new pill, presence,
  ?) is the palette's header instead of a box within it; the palette docks
  into the review drawer while the drawer is open and floats again when it
  closes; the badge panel, ⋯ menu, and popover are mutually exclusive; Esc
  dismisses one surface at a time (popover → re-attach → composer → popup →
  drawer), and now closes the reply composer from anywhere on the page (#3).
- Toolbar redesigned into a single compact strip: a 3-segment Text/Pin/Rect
  control replaces the stacked mode buttons, an export icon expands to
  "Copy for your agent," "Download .md," and (remote only) "Copy
  `markup pull` command," and a drawer button shows the unseen count and
  opens/closes review. The old "⋯" overflow menu is gone — its items now
  live in the export expander and the new command palette below (#3).
- ⌘K/Ctrl+K opens a command palette (guarded so it doesn't fire while
  typing in a note or reply) grouping Modes, Review & export, and Danger
  (Clear all) behind one search-and-run list, wired to the same handlers
  as the strip so nothing is duplicated. Esc closes the palette before
  falling through to the drawer. The palette module itself ships
  separately; the strip feature-detects it and degrades to a no-op ⌘K if
  it isn't present (#3).
- The strip's mode menu and the ⌘K palette include Highlight (H) and
  Strike (X), restoring the visible affordance those modes lost when the
  stacked toolbar buttons became the compact strip (#3).

### Fixed

- Cmd/Ctrl+Enter and Esc work again inside markup's own text boxes (popover
  note, reply composer, palette input). The keyboard-isolation shield stops
  propagation at window, which silently killed every key listener attached to
  the text boxes themselves; those shortcuts now live on window capture,
  where the shield can't cut them off, and the host page stays isolated (#6).
- The drawer's per-section "Remove all" is scoped to your own annotations,
  matching Clear all: the label and confirm count only yours, others' notes
  are kept and the toast says how many; a section with none of yours no-ops
  with a toast (#6).
- Presence keeps pinging while a popover is open; only the annotation poll
  pauses, so your "viewing" status no longer goes stale mid-comment (#6).
- A malformed percent-encoded request path returns 400 instead of a 500 from
  the generic handler (#6).
- Rect screenshots mirrored to Slack now carry an absolute URL resolved
  against the canvas origin instead of a dead server-relative path (#5).
- `markup share`/`bridge` read credentials through the same config chain as
  `publish`/`pull` (env vars, then `LDPUB_ENV_FILE`, then `~/code/ldpub/.env`),
  so a .env-only setup no longer works for publishing but silently fails for
  the Slack ops; with nothing configured, the documented default origin
  applies everywhere consistently (#5).
- `.env` values keep their trailing whitespace no longer: a stray space or CR
  after a client secret used to break Cloudflare Access auth with a generic
  error (#5).
- On a shared canvas, exports fall back to the uploaded screenshot URL when
  the local PNG data isn't held by this viewer, instead of printing
  "[screenshot unavailable]" for screenshots that exist (#5).
- "Disk" export probes POST /export and only falls back to a browser download
  where the route truly doesn't exist (a published canvas), so local
  `serve --multiplayer` keeps the on-disk feedback bundle with separate PNG
  assets (#5).
- `markup serve --multiplayer` re-checks the instance registry after
  registering, closing the startup race where two processes serving the same
  file could both pass the single-writer guard and interleave annotation
  writes (#5).
- `markup pull` warns when a rect screenshot fails to download instead of
  silently omitting it from the bundle (#5).
- Cross-author rules are now enforced server-side, not just in the UI: DELETE
  refuses to tombstone another author's note (403), and a cross-author PUT
  can drive only the status transition; every other field (mode, pinNum,
  shotUrl, anchor metadata) comes from the stored record (#3).
- Highlight and strike popovers honor the cross-author read-only rules the
  other modes already had, and both modes now appear in the `markup pull`
  feedback bundle instead of being silently omitted from it (#3).
- The remote poll defers while a write is in flight and keeps not-yet-acked
  local annotations, so a poll tick can no longer erase a note that was just
  created; a failed save or delete now resyncs to server truth next to its
  error toast instead of leaving phantom state behind (#3).
- Pin/rect numbers are arbitrated at create time by the annotations API, so
  two reviewers in one poll window can't both mint "Pin 3"; pulled screenshot
  filenames carry the annotation id so colliding rect numbers can't overwrite
  each other's PNGs (#3).
- Re-hydration skips text already inside highlight and strike marks (not just
  comment spans), so overlapping annotations of different kinds no longer
  nest-corrupt on reload (#3).
- A text selection crossing an element boundary (bold run, link, line wrap)
  now survives reload: re-hydration searches the anchor element's combined
  text (with a whitespace-insensitive fallback) instead of one text node at a
  time, so the highlight re-renders instead of vanishing (#3).
- Jumping to a note's spot works: smooth `window.scrollTo` is silently inert
  on some wrapped docs, so jumps scroll instantly (with the ghost flash
  marking the landing) (#3).
- Per-viewer "seen" tracking is now scoped by identity, not just the doc, so
  two personas sharing one browser's localStorage keep independent "N new"
  counts — one persona opening the drawer no longer marks notes seen for the
  other (#3).
- Text-span annotations no longer detach spuriously on a shared canvas.
  loadAnnotations now hands out deep copies, so an in-place re-anchor or
  status change on one annotation can't corrupt another through a shared
  object reference; a failed re-render in remote mode keeps the note open and
  visible instead of persisting status=pending to the shared doc (which had
  detached a reviewer's comment for everyone); and two spans in the same
  element re-anchor independently (#3).
- The review drawer quotes a span's actual selected text, not its parent
  element's text — two spans in one paragraph no longer show identical,
  mislabeled quotes (#3).
- A reviewer's own new or edited annotation appears in the review drawer
  immediately; the ~10s poll cadence is only for other reviewers' changes (#3).
- Escape closes the review drawer when it's open (after any popover or active
  re-attach, which still take Escape first) (#3).
- On a shared canvas the "Disk" export downloads a self-contained markdown
  file with inlined screenshots instead of calling a /export route the Worker
  doesn't serve; the tooltip points to `markup pull <url>` for the full
  bundle with separate PNG files. Local serve keeps its existing behavior (#3).
- Shared-canvas destructive ops are scoped to your own annotations: deleting
  someone else's note is refused (deletion tombstones the id forever), and
  "Clear all" in remote mode clears only yours and says so (#3).
- The local annotations store writes atomically (temp file + rename) and
  refuses to touch a corrupt annotations file — a parse failure is loud and
  returns 500 instead of silently reading as empty and clobbering the review
  on the next write (#3).
- `markup serve --multiplayer` refuses to start when another live process
  already serves the same file in multiplayer mode (two processes would
  interleave writes on one annotations JSON) (#3).
- The feedback bundle flattens notes, quotes, and replies before
  interpolating them into markdown, so a malicious note can't forge headings
  or code fences aimed at the agent consuming the bundle (#3).
- Keystrokes typed into MarkedUp's own text-entry surfaces (popover note
  field, sidebar drawer) leaked to the host page's own keyboard handlers —
  e.g. typing a space into an annotation note advanced a slide deck listening
  for spacebar on `document`. Capture-phase listeners on `window` now stop
  propagation for keydown/keyup/keypress originating in MarkedUp's own UI
  before the host page ever sees them, without touching `preventDefault`, so
  typing and native text-field shortcuts are unaffected (#1).
- `markup serve` could step up onto the dashboard's port (7780), so a third
  or later instance could squat the port the dashboard needs.
- `markup dash` no longer silently drifts to a fallback port when 7780 is
  taken; it binds 7780 strictly and reports the conflict instead.
- A plain `/` probe couldn't tell a dashboard from a served artifact (both
  return 200), so a served artifact on the dashboard port could masquerade
  as the dashboard. `dash` now probes `/api/instances`, a dashboard-only
  route.
- The review drawer shows author attribution only on a shared canvas: solo
  rows start at the timestamp instead of rendering "?" avatar and name
  chips. On a shared canvas, a note with no author gets a neutral
  "unattributed" look instead of a hashed identity color that dressed it
  up as a real teammate (#3).
- `markup serve` (LD-173) built the client bundle and overlay stylesheet
  once at startup and served those strings for the life of the process, so
  a long-running instance kept serving stale overlay code after the
  `markup` package was upgraded until it was manually restarted.
  `client-bundle.js` now caches the built bundle/styles keyed by the max
  mtime across `src/client/*` and `styles.css`; `serve.js` calls the fresh
  getters on every request instead of a startup-captured copy, so edits
  (or an upgrade) show up on the next request with no restart (#4).

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
