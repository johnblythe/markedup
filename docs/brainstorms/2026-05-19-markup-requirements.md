---
date: 2026-05-19
topic: markup-annotation-tool
---

# Markup: Point-and-Click Annotation Layer for Agent-Produced HTML Artifacts

## Summary

Local CLI tool that wraps an already-rendered HTML artifact in a browser annotation overlay. User clicks elements, highlights text spans, drags screenshot rectangles, and leaves notes; tool exports a feedback bundle (markdown + cropped PNGs) for handoff to the producing agent. Source artifact is never modified.

---

## Problem Frame

User reviews many HTML artifacts produced by Claude Code sessions: incident briefs, status reports, dashboards, design mockups. Current loop is painful and slow.

Today the user opens the HTML in Cursor, scans back and forth between rendered browser view and source, manually edits text in the source file, then must remember to tell the agent not to overwrite those manual edits during subsequent generations. For visual feedback on charts and layouts, the user opens a screenshot tool, crops the region, pastes into Claude, and types out a description of what is wrong.

Two structural pains:

1. **Source coupling.** Manual edits to the artifact file create merge conflicts with the agent's regeneration loop. The user has to defensively instruct the agent every time.
2. **Position translation.** Visual feedback ("this chart needs the right side filled in") requires the user to translate spatial intent into prose, plus a separate screenshot. The translation is lossy and slow.

Inkwell solves the analogous problem for markdown writing drafts via paragraph-level comments and clipboard or sidecar export, but it is scoped to markdown source and per-paragraph anchors. It does not handle arbitrary rendered HTML, click-anywhere element pinning, span-level text highlight, or drag-rectangle region screenshots.

Plans, PRDs, and Confluence-style text documents are NOT in pain. User can edit those directly in chat or ask the agent to reshape them.

---

## Actors

- A1. Reviewer (human, user): Opens an HTML artifact, leaves annotations, exports the feedback bundle, hands it to an agent.
- A2. Producing agent (Claude Code session): Generated the original artifact. Receives the feedback bundle and applies revisions.
- A3. Markup CLI: Wraps the HTML, serves the annotation overlay, captures annotations, writes the export bundle.

---

## Key Flows

- F1. Wrap and annotate
  - **Trigger:** User runs `markup serve <path-to.html>`.
  - **Actors:** A1, A3.
  - **Steps:**
    1. CLI reads HTML file, injects annotation overlay script and stylesheet, serves on localhost port.
    2. Default browser opens to the served page.
    3. User reads the artifact. When they spot something to flag, they pick one of three modes from a floating toolbar.
    4. Mode 1 (text span): User selects text in the document; an annotation popover appears anchored to the selection.
    5. Mode 2 (element pin): User clicks an element; a numbered pin lands on it; popover appears.
    6. Mode 3 (drag rectangle): User shift-drags to draw a rectangle on any region; tool auto-captures a cropped PNG of that rectangle; popover appears.
    7. User types note in popover, saves. Annotation persists in localStorage keyed by artifact path.
  - **Outcome:** Document has visible annotation markers; user has a draft bundle of notes ready to export.
  - **Covered by:** R1, R2, R3, R4, R5, R6.

- F2. Export to clipboard (live session handoff)
  - **Trigger:** User clicks "Export to clipboard" button in toolbar.
  - **Actors:** A1, A3, A2.
  - **Steps:**
    1. Tool serializes all annotations to a markdown payload with inline image references (data-URI for PNGs so paste-into-chat works without separate file uploads).
    2. Payload copies to clipboard.
    3. User pastes into the live Claude Code chat that produced the artifact.
    4. Producing agent reads the bundle and applies revisions.
  - **Outcome:** Producing agent has structured feedback (text + images) inline in the chat.
  - **Covered by:** R7, R9.

- F3. Export to disk (fresh-session / file-based handoff)
  - **Trigger:** User clicks "Export to disk" button in toolbar.
  - **Actors:** A1, A3, A2.
  - **Steps:**
    1. Tool writes `<artifact-stem>.feedback.md` next to the source HTML.
    2. Tool writes cropped PNGs into `<artifact-stem>.feedback.assets/` next to the markdown.
    3. User opens a new Claude Code session (or addresses any agent) and references both the source artifact and the feedback file.
  - **Outcome:** Feedback bundle exists as portable files; any agent reading the directory can act on it.
  - **Covered by:** R8, R9.

- F4. Re-render of source artifact
  - **Trigger:** User regenerates the underlying HTML via the producing agent (e.g., agent rewrites the incident brief).
  - **Actors:** A1, A3.
  - **Steps:**
    1. User refreshes the served page.
    2. Tool attempts to fuzzy-match prior annotations against the new DOM via element fingerprint (CSS-path + content hash).
    3. Matched annotations re-anchor. Unmatched annotations are surfaced in a sidebar as "detached" with the original note + screenshot, so the user can manually re-anchor or discard.
  - **Outcome:** No silent loss of feedback when the artifact regenerates.
  - **Covered by:** R10.

---

## Requirements

**Wrapping and serving**
- R1. Tool accepts a path to an existing rendered HTML file (any HTML, not only markdown-rendered).
- R2. Tool serves the wrapped artifact on a configurable localhost port (default 7778; 7777 reserved for Inkwell).
- R3. Tool opens the served page in the user's default browser on `serve` invocation.

**Annotation modes**
- R4. Text-span mode: user selects any text in the document and attaches a note to that exact range; selection is highlighted persistently.
- R5. Element-pin mode: user clicks any element in the document and a numbered pin lands on it with an attached note; pin remains visually anchored to the element.
- R6. Drag-rectangle mode: user shift-drags or toggles into rect mode, draws a rectangle anywhere on the page (including over charts, images, and layout regions), and the tool captures a cropped PNG of that rectangle plus an attached note. The rectangle is rendered persistently on the page after capture.

**Persistence**
- R7. Annotations persist in `localStorage` keyed by the artifact's file path. Closing the tab or reloading does not lose work.

**Export**
- R8. Export-to-disk produces two outputs side by side with the source: `<stem>.feedback.md` (structured markdown) and `<stem>.feedback.assets/` directory containing cropped PNGs referenced by the markdown.
- R9. Export-to-clipboard produces the same markdown structure but inlines screenshots as data-URI image references so a chat paste preserves both text and images without file uploads.

**Resilience**
- R10. When the source HTML changes, the tool fuzzy-matches prior annotations against the new DOM by stable element fingerprint (CSS-path plus element content hash plus role/aria attributes when present). Unmatched annotations are not silently dropped; they appear in a "detached" sidebar with their original note and any screenshot, allowing manual re-anchor or discard.

**Non-mutation**
- R11. Tool never modifies the source HTML file on disk. All state lives in the served-page overlay, in `localStorage`, and in the export bundle.

---

## Acceptance Examples

- AE1. **Covers R4.** Given the incident-brief HTML is served, when the reviewer selects the substring "p90 close clips at 30d ceiling" in the chart caption and writes "explain this ceiling inline, don't leave it in the caption", an annotation entry binds to that exact text range. On reload, the selection is still highlighted and the note is still attached.
- AE2. **Covers R6.** Given the incident-brief HTML is served, when the reviewer shift-drags a rectangle around the right edge of the bar chart (capturing the empty future weeks) and writes "fill in May 11 and May 18 weeks", the tool stores a PNG of just that rectangle, plus the note, anchored to that region. On reload, the rectangle outline is still visible.
- AE3. **Covers R10.** Given two annotations exist (text-span on a chart caption, rectangle on the chart's right edge) and the source HTML is regenerated with the caption rewritten and the chart slightly different in size, when the reviewer reloads, the text-span annotation is shown in the "detached" sidebar (caption text changed), and the rectangle annotation re-anchors to the chart region by element fingerprint.
- AE4. **Covers R8, R9.** Given the reviewer has three annotations (one of each mode), when they click "Export to clipboard", the clipboard contains a markdown payload where the rectangle annotation is referenced as `![rect-1](data:image/png;base64,...)`. When they instead click "Export to disk", the same payload is written to `<stem>.feedback.md` and the rectangle PNG is written to `<stem>.feedback.assets/rect-1.png` with the markdown referencing `<stem>.feedback.assets/rect-1.png`.
- AE5. **Covers R11.** Given the user has made twelve annotations, when the producing agent regenerates the source HTML from a fresh prompt, the source HTML on disk has zero traces of Markup's overlay, annotations, or metadata.

---

## Success Criteria

- The user can review the incident-brief HTML, leave at least one annotation of each mode (span, pin, rect), export, and hand off to an agent in a single uninterrupted pass without alt-tabbing to a separate screenshot tool or text editor.
- A downstream agent reading the exported feedback bundle (markdown plus assets) can identify the target of each annotation without needing to ask clarifying questions about location ("which chart?", "which paragraph?").
- The user no longer edits the source HTML directly to leave feedback; the "agent clobbers my manual edits" loop is eliminated.
- An MVP exists that supports F1 (wrap and annotate, all three modes) and F2 or F3 (one export path), good enough for the user to click around and validate the shape on return from errand.

---

## Scope Boundaries

### Deferred for later

- Diff view between artifact versions (V2; useful but not blocking the core review loop).
- Auto re-anchor when fingerprint match is high-confidence (V1 surfaces all changes for manual confirmation; auto-migrate is a polish iteration).
- Threading or replies on annotations (single-author, single-pass review only in V1).
- Theme customization beyond a single sensible default.
- Annotation export formats other than markdown (HTML report, JSON, PDF deferred).
- Inkwell merge or absorption: if Markup matures and Inkwell stops earning its keep, that decision is made later. V1 stays as a sibling.
- Tab/file picker UI in the served page (V1 is one-artifact-per-invocation; multi-doc browsing comes later).

### Outside this product's identity

- Hosted / remote URL annotation (Notion pages, Confluence in the browser, GitHub PRs). That is a bookmarklet-shaped product. Markup is a local-file tool.
- Multi-reviewer / collaborative annotation. Markup is single-user, local-only by design. Collaboration belongs to GitHub PR review or a hosted comment system.
- Editing the source artifact from the overlay (inline rewrites, "apply suggestion" buttons). Markup is purely an annotation layer; mutation belongs to the producing agent.
- Markdown ingestion. If user has a markdown artifact, they render it to HTML first (Inkwell for writing-flow drafts, `/render` skill for general markdown). Markup is HTML-in only.
- Code or PR review. GitHub handles that natively.
- Browser-harness / CDP coupling. Markup runs in the user's normal default-browser tab via localhost; no automation substrate.
- Sharing a package with Inkwell. Copy useful primitives where they fit; no shared npm package, no cross-imports. The two tools evolve independently.

---

## Key Decisions

- **Sibling tool, not Inkwell extension or fork.** Inkwell stays focused on writing-flow markdown drafts. Rationale: avoid breaking Inkwell's "precise contained usage" by stretching it into a general artifact-review platform. Future merge remains optional; not a V1 concern.
- **Node CLI mirroring Inkwell's `serve` pattern.** Familiar shape, low cognitive cost for the user, easy to copy useful primitives. Alternative (Python, Go, browser extension) rejected as either heavier setup or unfamiliar shape.
- **Client-side screenshot via html2canvas.** Drag-rect crops happen in the browser, no browser-harness or CDP integration required. Server stays thin.
- **DOM-element fingerprint anchoring (CSS-path + content hash + aria/role attrs).** Survives re-renders better than pure CSS-path or pure coordinate-based anchoring. Coordinates alone shift on layout changes; CSS-path alone breaks on minor structural edits.
- **Two export paths, not one.** Clipboard (for live-session paste) and file-on-disk (for fresh-session / file-reading agents). Either alone leaves one workflow worse; both add minimal cost.
- **`localStorage` persistence keyed by file path.** Same pattern as Inkwell. Survives reload, scoped per artifact, zero server-side state.
- **Default port 7778.** Avoid collision with Inkwell on 7777.
- **No source-file mutation, ever.** The annotation overlay is the source of truth for feedback. Source HTML stays pristine. This is the single most important property — it is the entire reason this tool exists, separate from manually editing artifacts.

---

## Dependencies / Assumptions

- Node.js available locally (already in user env via nvm).
- Default browser launchable via `open` on macOS (user env confirmed).
- `html2canvas` (or equivalent client-side rasterizer) handles the artifact types in use; charts rendered as inline SVG or canvas may need format-specific handling that is acceptable to defer.
- Source HTML is self-contained enough to render meaningfully when served from a different origin (localhost). If the artifact references resources via relative paths, the tool may need to serve neighboring assets too; this is expected to be the common case for `/render`-produced and CLI-produced HTML.
- User does not need to annotate the same artifact concurrently from two tabs; single-tab assumption is fine.

---

## Outstanding Questions

### Resolve Before Planning

(none — open questions resolved in dialogue or deferred below)

### Deferred to Planning

- [Affects R6][Technical] Best client-side rasterizer for the artifact mix in use (html2canvas, dom-to-image, modern-screenshot). Need to verify which handles inline SVG charts (used in the incident brief) correctly.
- [Affects R10][Technical] Exact composition of the element fingerprint (CSS-path normalization rules, content-hash strategy for elements that span children with their own annotations, fallback heuristics when fingerprint is ambiguous).
- [Affects R9][Technical] Data-URI size budget for clipboard export; large rect screenshots may bloat clipboard payloads beyond what Claude Code's chat input cleanly handles. May need to compress or downscale.
- [Affects R8][Technical] Whether to also write a JSON sidecar (`<stem>.feedback.json`) alongside the markdown so future tooling can round-trip annotations without parsing markdown. Treat as planning-time decision.
- [Affects R1][Needs research] How user's existing artifacts handle relative asset paths (e.g., does the incident brief reference local images? CSS files?). Determines whether the serve step needs to mount the artifact's parent directory as a static root.
- [Affects R5][Technical] Pin-numbering scheme and z-index handling when pins overlap dense regions.
- [Affects R6][Technical] Whether shift-drag is the right gesture or whether a toolbar "Rect mode" toggle is more discoverable for a tool the user only opens occasionally.
- [Affects all] Tool name. "Markup" is working name; collides with HTML markup semantically. Candidates: Critique, Loupe, Margins, Glossa, Redline. Final naming deferred to ce-plan or first-use feedback.
