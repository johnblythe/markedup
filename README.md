# Markup

Point-and-click annotation layer for reviewing rendered HTML artifacts. Wraps a local HTML file with a browser-based annotation overlay served on localhost, then exports a feedback bundle (markdown + cropped PNG screenshots) ready to hand back to the agent that produced it.

Everything runs on localhost. The page is served by a local Node process, the
overlay talks only to that process, and the source HTML is never modified.
Nothing is uploaded anywhere.

![An HTML report with a rectangle drawn over a chart, a highlighted phrase, a numbered pin, and the Markup toolbar](docs/assets/annotate.png)

## The loop

```mermaid
flowchart LR
    A["agent writes<br>artifact.html"] --> B["markup artifact.html"]
    B --> C["annotate in the browser<br>text · pin · rect"]
    C --> D["export bundle<br>markdown + PNGs"]
    D --> E["paste back<br>to the agent"]
    E -->|agent revises| A
```

Markup closes the review loop for agent-produced HTML: instead of describing
what's wrong ("in the chart section, the caption says..."), you point at it.
The exported bundle carries the exact text, a CSS path to the element, and a
cropped screenshot, so the agent knows precisely what you meant.

## Install

Requires Node 18+.

```bash
git clone https://github.com/johnblythe/markup.git
cd markup
npm install
npm link
```

## Use

```bash
markup path/to/artifact.html
# shorthand for `markup serve path/to/artifact.html`
# opens default browser to localhost:7778 with annotation overlay

markup serve path/to/artifact.html --port 9000
# custom port (flags work with the shorthand too)

markup list
# table of running instances: port, pid, file, started

markup stop path/to/artifact.html
markup stop --port 9000
markup stop --all
# stop one instance (by path or port) or every running instance

markup dash
markup dash --detach
# open the dashboard listing all running instances; --detach (-d) starts it
# in the background, waits until it's up, prints the URL, and returns
```

Try it on the bundled sample report:

```bash
markup examples/demo.html
```

### Ports

`serve` instances start at 7778 and step up on collision. Port 7780 is
reserved for `markup dash` and is skipped by that step-up, so a serve
instance can never take it. `markup dash` binds 7780 strictly and reuses
a live dashboard instead of starting a second one; see `markup dash --help`
for `--reclaim` and `--port` when something else is squatting on 7780.

## Annotation modes

- **Text** (`T`) — select any text, leave a note. Persists as a highlighted span.
- **Highlight** (`H`) — select any text; it's highlighted instantly, no note required. Click an existing highlight to add a note or delete it. Tells the agent: add emphasis here, change nothing else.
- **Strike** (`X`) — select any text; it's struck through instantly, no note required. Click an existing strike to add a reason or remove it. Tells the agent: delete this exact text and repair the surrounding grammar/punctuation.
- **Pin** (`P`) — click any element, drop a numbered pin with a note.
- **Rect** (`R`) — shift-drag (or toggle Rect mode) to draw a rectangle; tool screenshots that region and attaches a note.

Shortcuts are ignored while typing in a text field or the note popover. `Esc` clears the active mode.

![A note popover open on a pinned table row, with Remove, Accept, Cancel, and Save buttons](docs/assets/popover.png)

## Export

- **Export to clipboard** — copies a markdown payload (with inline PNG data-URIs for rectangles) to clipboard. Paste into Claude Code chat.
- **Export to disk** — writes `<artifact>.feedback.md` and `<artifact>.feedback.assets/*.png` next to the source HTML, then copies the saved `.md` path to clipboard (toast stays clickable to copy again).

The source HTML is never modified.

What the agent gets back (excerpt from a real export of the sample report):

```markdown
# Feedback: demo.html
Total annotations: 5

## Span annotations
- "W10 dips on the release freeze": explain the release freeze inline — readers won't know what froze

## Highlight annotations
- [HIGHLIGHT] "conversion rate improved 12% week over week": (no note)

## Strike annotations
- [DELETE] "as previously mentioned in the earlier section": redundant, already covered above

## Pin annotations
- Pin ① on `td` (body > div:nth-of-type(1) > table > tbody > tr:nth-of-type(3) > td:nth-of-type(2)) — text: "At risk": link the rate-limit decision doc here
```

## Slack review loop

For team review, `markup share <url>` binds a published doc to a private
Slack channel and `markup bridge <url>` mirrors annotations into per-note
threads, carrying thread replies back onto the page. See
[docs/slack-ops.md](docs/slack-ops.md).

## Claude Code skill

`skill/SKILL.md` teaches a Claude Code agent to drive this tool: serve the HTML
it just wrote, hand back the URL, and pick up the exported feedback. Install it
by symlinking (so it tracks the repo) or copying:

```bash
ln -s "$PWD/skill" ~/.claude/skills/markup
# or: mkdir -p ~/.claude/skills/markup && cp skill/SKILL.md ~/.claude/skills/markup/
```

Then `/markup` in a Claude Code session serves the last HTML artifact it
produced. `/markup list`, `/markup dash`, and `/markup stop` map to the CLI.

## Shared canvas (multiplayer)

Publish an artifact once and review it together at one URL — every
reviewer sees everyone's pins, highlights, and rects, attributed, within
about ten seconds. Backed by an [ldpub](https://github.com/johnblythe/ldpub)
Worker (Cloudflare Access gated); reviewers need no setup beyond opening
the link and passing the email gate.

```bash
markup publish path/to/report.html --title "Q3 Report"
# → https://<worker>/<user>/<project>/   ← send this URL to reviewers

markup pull https://<worker>/<user>/<project>/
# → writes <project>.feedback-<stamp>.md (+ screenshot assets) with every
#   annotation, author, state, and reply thread — paste back to the agent
```

Publishing needs a one-time sign-in with your own SSO — no tokens, no
provisioning:

```bash
brew install cloudflared   # once per machine
markup login               # opens the browser; sign in with your work email
```

`markup publish` and `markup pull` then run as you (attribution is your
real email) until the session expires; run `markup login` again when it
does. Publishing even offers the sign-in automatically the first time you
run it in a terminal.

Agents and CI skip the browser with a Cloudflare Access service token:
`LDPUB_CLIENT_ID`/`LDPUB_CLIENT_SECRET` (and optionally `LDPUB_URL`) in
the environment, or a .env named by `LDPUB_ENV_FILE` (default
`~/code/ldpub/.env`). A configured token always wins over SSO, and only
token callers may run `markup push-overlay`, which refreshes the shared
overlay assets that every published doc loads. Set `LDPUB_USER` to fix
your namespace segment; `--user`/`--project` override per publish.

Annotations on a shared canvas live server-side (one JSON per doc in R2),
merged last-write-wins per annotation, authors stamped from the Access
identity. Someone else's marks render violet; yours stay orange. Replies
(from the canvas API or the Slack bridge) show under each note in the
review sidebar. Append `?raw=1` to any published page to view it without
the overlay.

Local multiplayer without any of that infrastructure:

```bash
markup serve report.html --multiplayer
# annotations persist in report.annotations.json next to the source and
# sync across every open tab; set identity per tab with ?as=you@example
```

The same HTTP API the Worker speaks is mounted on the local server
(`/api/{user}/{project}/annotations`, identity via `X-Markup-User`), so
tooling built against one works against the other.

## Contributing

Issues and pull requests welcome. Fork, branch, open a PR. Every change is
reviewed before merge. Please run `npm test` first.
