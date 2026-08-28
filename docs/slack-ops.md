# Slack ops: share a doc, review it in threads

`markup share` binds a published Marked Up doc to a private Slack channel.
`markup bridge` keeps the two in sync: every annotation becomes a thread in
the channel, and replies in those threads land back on the annotated page.

Requires the `ld` CLI (`~/code/research/ld`) with a live Slack session; the
bridge posts as the logged-in user. No Slack app or bot token involved.

For a remote doc the environment must provide `LDPUB_URL` plus
`LDPUB_CLIENT_ID` / `LDPUB_CLIENT_SECRET` (the ldpub service token), e.g. by
sourcing `~/code/ldpub/.env`. Both commands refuse any origin other than
`LDPUB_URL` (https) or localhost, and the service token is only ever sent to
the `LDPUB_URL` origin.

## Share

```bash
markup share https://<host>/eng/board-audit/ --to eng@launchdarkly.com
```

- Creates (or reuses) the private channel `#markd-eng-board-audit`, invites
  the people in `--to`, posts a link card, and sets the channel topic to the
  doc URL.
- Re-running is safe: same channel, no duplicate card, extra `--to` people
  get invited. Running right after `markup publish` is fine too: share waits
  briefly for a just-created site and proceeds either way.
- `--owner <email>` names the doc owner for the activity digest (below).
- If a previous round resolved and archived the channel, re-sharing reopens
  it for a new round.
- `--channel <name>` overrides the derived name. `--test` uses the
  `markd-test-` prefix (scratch channels).

## Bridge

```bash
markup bridge https://<host>/eng/board-audit/
```

- Polls the doc's annotations API every 30 s (`--interval <seconds>`, min 15).
- New annotation → one top-level message in the channel: author, what it
  points at, the note, a link to the doc.
- Replies typed in that Slack thread → appear under the annotation on the
  page, attributed via the invite list (`--to` emails), tagged `via slack`.
  The page displays replies; it has no reply box, so the conversation lives
  in Slack.
- Owner digest: when someone other than the owner leaves notes or replies on
  the page, the bridge posts one coalesced heads-up ("eng left 3 new notes on
  Board Audit" with the link) instead of expecting the owner to keep
  re-opening the page. A burst of notes becomes one digest; at most one
  digest per quiet window (default 10 minutes, `--nudge-interval <seconds>`).
  Set the owner with `--owner <email>` (here or on `share`); without it,
  digests are off. `--nudge-to dm` sends the digest as a DM to the owner
  instead of a channel message; `--nudge-to off` disables digests.
- When every annotation is accepted the bridge posts a summary, archives the
  channel, and exits. `--no-archive` leaves the channel open.
- `--once` runs a single sync cycle and exits (useful for cron or checks).
- Runs in the foreground like `markup serve`; stop with Ctrl-C. The running
  bridge shows up in `markup list`, and `markup stop <doc-url>` ends it.
- Restarts are safe: sync state lives in `~/.markup/bridge/<channel>.json`,
  so nothing double-posts.

## The loop, end to end

1. Publish the doc (see the multiplayer canvas docs) and `markup share` it.
2. Start `markup bridge` and leave it running.
3. Reviewers annotate the page; the channel fills with one thread per note.
4. Answer in the Slack threads; each reply shows up under its annotation on
   the page.
5. Accept annotations on the page as they are addressed; when the last one
   is accepted, the channel archives itself and the bridge exits.

## Limits (v1)

- The bridge runs on your machine and mirrors only while it is up. Nothing
  is lost while it is down; the next run catches up.
- Everything it posts comes from your Slack account (with the CLI's
  `via LD Research` suffix). Replies from people not on the invite list are
  attributed as `slack:<user-id>` on the canvas.
- One doc per channel; run one bridge per shared doc.
