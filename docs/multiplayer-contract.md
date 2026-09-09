# Marked Up multiplayer: wire contract

> **Status (2026-09-09):** ratified and shipped. The v1 freeze below is kept
> verbatim as the normative baseline; everything since is in the amendments
> list. Reference implementations: `src/annostore.js` (local, authoritative
> for semantics), `test/stub-api.js` (test mirror), and the ldpub Worker
> (production, `launchdarkly-labs/ldpub` `src/annotations.ts`).

## Amendments since the v1 freeze

- `mode` on the wire is `"span" | "highlight" | "strike" | "pin" | "rect"`
  (the freeze's `"text"` was always `"span"` in practice; highlighter and
  strikethrough arrived with markedup #2 and joined the shared canvas in #3).
- `DELETE /api/{user}/{project}/annotations/{id}` exists and tombstones the
  id forever; a PUT to a tombstoned id returns 410 (no resurrection).
- Deletes are author-only (403 otherwise); a record with no stored author
  stays deletable by anyone (markedup #3 review, ldpub #5).
- A cross-author PUT that passes the note/anchor/payload match check drives
  only `status`; every other field comes from the stored record (ldpub #5).
- Pin/rect numbers are arbitrated server-side at create time: a missing or
  taken number is reassigned live-max + 1 and the corrected record returns
  to the creating client (ldpub #5).
- Presence: `POST /api/{user}/{project}/presence` records the caller's
  last-seen; `GET` reads without recording.
- Shots: `GET/PUT /api/{user}/{project}/shots/{annoId}.png`; the server
  strips inline `pngDataURL` from annotation payloads on every PUT.

---

# Marked Up multiplayer — frozen contract (2026-08-27)

Both forks build against this. Changes to this contract go through the orchestration session, not unilaterally.

## HTTP API (served by ldpub Worker; identically by the local stub)

```
GET  /api/{user}/{project}/annotations
     → 200 { etag: string, annotations: Annotation[] }
     → 304 when If-None-Match matches current etag
PUT  /api/{user}/{project}/annotations/{id}
     body: Annotation (client fields only)
     → 200 merged Annotation (server stamps author/createdAt/updatedAt)
POST /api/{user}/{project}/annotations/{id}/replies
     body: { text, via? }   → 200 Annotation (reply appended, author stamped)
GET  /api/me → 200 { email }
```

- Auth: Cloudflare Access JWT (browser) or service-token headers (CLI/bridge). The Worker stamps `author` from the verified identity; browser clients never set it. Local stub: `author` from `?as=` query param or `X-Markup-User` header, default `local@dev`.
- Service-token author hint (amendment 2026-08-27, for the Slack bridge): when the caller authenticates with a service token, the Worker honors an `X-Markup-User` header as the `author` value (falling back to the service identity when absent). A verified browser JWT always wins over any header; JWT callers can never spoof authorship. Rationale: the bridge writes replies on behalf of Slack speakers and must attribute them.
- Merge: last-write-wins per annotation `id`. Existing id format `anno-<ts36>-<rand>` stays.
- Replies are append-only. `status` transitions: open → accepted (either party; "accepted" is the terminal state and plays the resolved role), open → pending (sourceHash change triage), pending → open or accepted (triage).
- Rect screenshots: PNG stored at `shots/{user}/{project}/{annoId}.png` (R2) or tmp dir (stub); annotation carries `shotUrl`, never inline data URIs on the wire.

## Annotation record

```
{ id, mode: "text"|"pin"|"rect", note, pinNum?, rectNum?,
  anchor: { cssPath, tagName, anchorText?, ... },  // fingerprint object, verbatim as the overlay emits it
  payload?, rect?, shotUrl?, sourceHash,
  author, createdAt, updatedAt,
  status: "open"|"pending"|"accepted",
  replies: [{ author, text, at, via: "canvas"|"slack" }] }
```

Client-generated fields stay exactly as the current overlay produces them; server adds the rest.

RULING (desk, 2026-08-27, supersedes the first draft): the wire shape follows the overlay's real fields, which are a nested `anchor` fingerprint object and a `status` field (`src/client/modes.js`, `src/client/export-client.js`). The draft's flat `cssPath` and `state: resolved` never existed in the client. Consumers should read nested `anchor.cssPath` as primary (flat fallback tolerated) and treat `accepted` as the terminal state wherever this document previously said "resolved" (including Slack archive-on-resolve: archive when every annotation is `accepted`).

## Slack mapping (fork 8)

- One private channel per shared doc: `#markd-<slug>` (tests use `#markd-test-<slug>`, John only).
- One top-level channel message per annotation: author, anchored quote/element context, note, deep link to the doc URL.
- `annotation.id ↔ thread_ts` mapping persisted to disk by the bridge; survives restarts.
- Slack thread replies → `POST .../replies` with `via: "slack"`.
- Canvas replies → posted into the mapped thread.

## Definition of done

Fork 1 (canvas): Worker routes + serve-time overlay injection live; markup client persists remotely with ~10 s ETag polling and author chips; local `markup serve` exposes this same API (stub/local-multiplayer mode); `markup publish` + `markup pull` work; `npm test` green in both repos; automated E2E on the stub, API-level E2E against the live Worker via service token; CE Jira Board Audit published, URL reported. No regression to the existing local single-player flow.

Fork 8 (slack ops): `markup share` creates/reuses the channel, invites, posts the link; bridge mirrors annotations → threads and thread replies → annotations, both directions proven in a test channel with John only; mapping survives restart; unit tests for mapping/merge; runbook written. Archive-on-resolve if time remains after core DoD.

Both: adversarial code-review pass on the diff before reporting; CHANGELOG entries; branch commits only (prefix `fork/`), no pushes, no PRs, main working trees untouched; a runbook a human can follow without us.
