# Marked Up multiplayer: state of the path

Written 2026-09-09, as the multiplayer push wound down. This is the entry
point if the path resumes cold: what shipped, how the pieces fit, how to run
them, and what was deliberately left on the table.

## What shipped

- **markedup #3**: the shared canvas. Remote persistence driver, `markup
  publish` / `pull` / `login` (tokenless SSO via cloudflared), local
  `serve --multiplayer` sandbox with two personas, Slack ops loop
  (`share`/`bridge`, see `docs/slack-ops.md`), redesigned review drawer,
  compact toolbar strip, command palette, presence, and the hardening from
  two adversarial reviews.
- **markedup #4**: serve rebuilds the client bundle per request (mtime
  cache); the restart-to-see-client-edits era is over.
- **markedup #5, #6**: the full code-review remediation: server-side
  cross-author enforcement, sync durability (poll vs. in-flight writes,
  rollback-by-resync), export fallbacks, slug/ownership/relTime dedupes,
  and the keyboard-isolation fix that had silently disabled Cmd+Enter in
  markup's own text boxes.
- **markedup #7**: "Copy for your agent" copies only unresolved annotations
  plus a ledger-protocol header (see below).
- **ldpub #5** (`launchdarkly-labs/ldpub`): the entire backend: annotations
  API on R2 with CAS writes, serve-time overlay injection, Access-verified
  identity, presence, fail-closed auth config, and the three contract guards.

## Architecture in one breath

`src/client/persist.js` is the seam: localStorage by default, remote driver
when the wrapper injects `__MARKUP_REMOTE__`. `src/annostore.js` is the local
reference implementation of the wire contract (`docs/multiplayer-contract.md`);
`test/stub-api.js` mirrors the annotations and `/api/me` routes for slackops
tests (no presence or shots); the ldpub Worker is the production
implementation. Identity: Cloudflare Access JWT in production (server stamps
authors; clients never set them). Local-sandbox precedence: `X-Markup-User`
header, then `?persona=`, then the older `?as=` alias, then `local@dev`.

## Running it

README's "Shared canvas (multiplayer)" section is the canonical how-to;
this is the operator's summary. When the CLI changes, update README first.

- **Local sandbox**: `markup serve <file> --multiplayer` prints two persona
  URLs; open both in tabs to review as two identities.
- **Publish**: reviewers just open the canvas URL behind LD SSO. Publishers:
  `brew install cloudflared` + `markup login`, then `markup publish <file>`.
  Service tokens are for agents/CI and for `markup push-overlay` (asset
  refresh is service-token-only; SSO publishers skip it with a notice).
- **Deploy the Worker**: `cd ~/code/ldpub && npm test && npm run deploy`.
  `keep_vars` preserves the live `TEAM_DOMAIN`/`POLICY_AUD`, so no var
  ritual. Verify: unauthenticated `curl` to the origin returns 302.
- **Refresh the live overlay**: `markup push-overlay` from markup main after
  client changes land.

## The incremental feedback loop (#7)

The `C` copy carries only unresolved annotations plus instructions telling
the receiving agent to maintain an append-only `<artifact>.feedback-ledger.md`
and act only on the current batch. Resolving a note in the drawer is what
retires it from the next copy. Download/disk exports stay full-record.

## Parked backlog

Tracked in Linear ("Marked Up multiplayer" project): LD-139 service-token CN
allowlist, LD-140 namespace ownership, LD-141 Access session duration,
LD-143 port off personal Cloudflare (the wire contract is the migration
seam). Known but unticketed as of this writing:

1. **Vanishing text annotation** (bug, root cause unconfirmed): `hydrate()`
   try/catches per annotation and logs `[markup] render skipped for <id>`
   (grep for "render skipped") so one bad note can't blank the drawer. Hypothesis: selection crossing a bold
   boundary, possibly fixed by the cross-element rewrite. A concrete repro
   exists locally at `tmp/vanish-repro.annotations.json` plus
   `tmp/vanish-verify/` (annotation set + the exact source doc); it stays
   out of the repo because the source doc is internal work content, so
   whoever picks this up should first distill it into a small sanitized
   fixture before `tmp/` gets cleaned.
2. **Clear-all undo**: needs a soft-delete path plus a tombstone-resurrection
   guard to be safe against the poll loop; deliberately deferred.
3. **Contract parity harness**: one suite run against annostore, the stub,
   and the Worker, so guards never have to be hand-ported again. Cheap first
   step, all in-repo: a shared request/response vector fixture run against
   both annostore and the stub (which already diverge: the stub lacks
   presence, shots, pngDataURL stripping, and the `state` mirror); Worker
   parity is the second, cross-repo step.
4. **`markup unpublish`**: ldpub's script still speaks the pre-v2 API; stale
   canvases can't be cleanly removed.
5. **Slack write-path via incoming webhook**: the no-app-approval unlock for
   the tabled two-way sync; `share`/`bridge` code in-tree is the spec.
6. Minor: full drawer re-render per changed poll tick (perf), JSON key-order
   sensitivity in the cross-author compare, no republish triage on shared
   canvases, server-corrected pin numbers render one poll late on the
   minting client.
