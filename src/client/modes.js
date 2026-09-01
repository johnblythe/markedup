// Mode dispatcher + all annotation mode handlers (span, pin, rect, highlight,
// strike). Single module so they share state cleanly.

var Modes = (function () {
  var sourceKey = null;
  var activeMode = null;
  var pinClickHandler = null;
  var rectMouseDownHandler = null;
  var rectMouseMoveHandler = null;
  var rectMouseUpHandler = null;
  var rectDraft = null;
  var rectStart = null;

  function init(key) {
    sourceKey = key;
    installSelectionListener();
    installHighlightSelectionListener();
    installStrikeSelectionListener();
    installShiftDragListener();
    installPinDelegate();
    installRectDelegate();
    installSpanClickDelegate();
    installHighlightClickDelegate();
    installStrikeClickDelegate();
    window.addEventListener("scroll", refreshPositions, { passive: true });
    window.addEventListener("resize", refreshPositions, { passive: true });
  }

  function getActive() {
    return activeMode;
  }

  function setActive(mode) {
    activeMode = mode;
    document.body.classList.toggle("markup-pin-cursor", mode === "pin");
    document.body.classList.toggle("markup-rect-overlay-cursor", mode === "rect");
  }

  function refresh() {
    document.querySelectorAll(".markup-pin, .markup-rect").forEach(function (n) {
      n.remove();
    });
    document.querySelectorAll("mark.markup-span, mark.markup-highlight, mark.markup-strike").forEach(function (m) {
      var parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize && parent.normalize();
    });
    hydrate();
  }

  function hydrate() {
    var list = Persist.loadAnnotations(sourceKey);

    // Source-change detection: if the source hash changed since the last
    // review, bump every still-open annotation to pending so the user
    // explicitly triages each one against the new version.
    // Remote mode skips the per-browser triage bump: the annotation set is
    // shared, so one viewer's localStorage hash must not flip everyone's
    // annotations to pending. Server-side republish triage is a follow-up.
    var currentHash = window.__MARKUP_SOURCE_HASH__ || "";
    var lastHash = Persist.getLastHash(sourceKey);
    var sourceChanged = !Persist.isRemote() && lastHash && currentHash && lastHash !== currentHash;
    if (sourceChanged) {
      list.forEach(function (a) {
        var status = a.status || "open";
        if (status === "open") {
          a.status = "pending";
          a.carryReason = "source-changed";
        }
      });
      Persist.saveAll(sourceKey, list);
    }
    // Stash current hash for next reload.
    if (currentHash) Persist.setLastHash(sourceKey, currentHash);

    var open = [];
    var pending = [];
    var accepted = [];
    var changed = false;

    list.forEach(function (anno) {
      try {
      var status = anno.status || "open";

      if (status === "accepted") {
        accepted.push(anno);
        return;
      }
      if (status === "pending") {
        pending.push(anno);
        // Rects still render visually (lingering on purpose), but their popover
        // path treats them as pending too.
        if (anno.mode === "rect") renderRect(anno);
        return;
      }
      // status === "open"
      var rendered = false;
      if (anno.mode === "span") rendered = renderSpan(anno);
      else if (anno.mode === "highlight") rendered = renderHighlight(anno);
      else if (anno.mode === "strike") rendered = renderStrike(anno);
      else if (anno.mode === "pin") rendered = renderPin(anno);
      else if (anno.mode === "rect") {
        renderRect(anno);
        rendered = true;
      }
      if (rendered) decorateAuthored(anno);
      if (!rendered) {
        if (Persist.isRemote()) {
          // A failed re-anchor here is a per-view rendering miss (DOM timing,
          // a sibling span splitting the text node), NOT a real source change.
          // Persisting status=pending would write it to the shared doc and
          // detach a reviewer's comment for everyone. Keep it open and
          // visible; the next hydrate retries the highlight.
          open.push(anno);
        } else {
          anno.status = "pending";
          anno.carryReason = "anchor-lost";
          Persist.upsertAnnotation(sourceKey, anno);
          pending.push(anno);
          changed = true;
        }
      } else {
        open.push(anno);
      }
      } catch (err) {
        // One annotation must never abort the whole render — that would leave
        // the drawer stale and the note invisible. Keep it visible in Open.
        if (typeof console !== "undefined") {
          console.warn("[markup] render skipped for", anno && anno.id, err);
        }
        if (open.indexOf(anno) === -1) open.push(anno);
      }
    });

    Sidebar.setReview(
      { open: open, pending: pending, accepted: accepted },
      {
        onShowContext: showAnnotationContext,
        onReattach: startReattach,
        onAccept: acceptAnnotation,
        onReopen: reopenAnnotation,
        onRemove: removeAnnotation,
        onScrollToInline: scrollToInline,
        // A posted reply lands in the cache; rebuild so the thread shows now.
        onThreadChange: function () {
          refresh();
          updateCount();
        },
        sourceChanged: sourceChanged,
      },
    );

    var shouldOpen = pending.length > 0 || sourceChanged;
    if (shouldOpen && !Sidebar.isOpen()) Sidebar.open();

    if (typeof window.__MARKUP_UPDATE_SIDEBAR_COUNT__ === "function") {
      window.__MARKUP_UPDATE_SIDEBAR_COUNT__();
    }
    return changed;
  }

  // Whose note is this? On a shared canvas only the author edits or removes
  // it; anyone may resolve/re-open (contract: either party) and reply. Solo
  // mode owns everything.
  function ownsAnno(anno) {
    if (!Persist.isRemote()) return true;
    return !anno.author || anno.author === Persist.self();
  }

  // Reply from a popover: land in the drawer with this note's composer open.
  function replyVia(anno) {
    if (!Persist.isRemote()) return undefined;
    return function () {
      Sidebar.openReply(anno.id);
    };
  }

  // Shared canvas: mark inline artifacts (pin badge, span mark, rect box)
  // with their author. Someone else's annotations get a distinct look.
  function decorateAuthored(anno) {
    if (!Persist.isRemote() || !anno.author) return;
    // Scope to inline artifacts — the sidebar's entries carry the same
    // data-anno-id and would otherwise shadow the pin in document order.
    var id = anno.id.replace(/"/g, "");
    var el = document.querySelector(
      '.markup-pin[data-anno-id="' + id + '"], mark.markup-span[data-anno-id="' + id + '"], ' +
        '.markup-rect[data-anno-id="' + id + '"]',
    );
    if (!el) return;
    el.setAttribute("title", anno.author + (anno.note ? " — " + anno.note : ""));
    if (anno.author !== Persist.self()) el.classList.add("markup-authored-other");
  }

  // --- Annotation lifecycle actions (used by sidebar + inline popover) -----

  function acceptAnnotation(anno) {
    anno.status = "accepted";
    anno.acceptedAt = new Date().toISOString();
    Persist.upsertAnnotation(sourceKey, anno);
    refresh();
    updateCount();
    Toast.show("Accepted.", 1400);
  }

  function reopenAnnotation(anno) {
    anno.status = "open";
    delete anno.acceptedAt;
    delete anno.carryReason;
    Persist.upsertAnnotation(sourceKey, anno);
    refresh();
    updateCount();
    Toast.show("Re-opened.", 1400);
  }

  function removeAnnotation(anno) {
    Persist.deleteAnnotation(sourceKey, anno.id);
    refresh();
    updateCount();
  }

  function scrollToInline(anno) {
    var el = document.querySelector(
      '[data-anno-id="' + anno.id.replace(/"/g, "") + '"]',
    );
    if (!el) {
      showAnnotationContext(anno);
      return;
    }
    var rect = el.getBoundingClientRect();
    var sy = window.scrollY || 0;
    // Instant, not smooth: smooth window.scrollTo is silently inert on some
    // wrapped docs (observed in Chrome), and the ghost flash below already
    // shows where you landed.
    window.scrollTo(0, Math.max(0, rect.top + sy - window.innerHeight / 2));
    // Flash to draw attention.
    var ghost = document.createElement("div");
    ghost.className = "markup-context-ghost";
    var x = rect.left + (window.scrollX || 0);
    var y = rect.top + (window.scrollY || 0);
    ghost.style.left = x + "px";
    ghost.style.top = y + "px";
    ghost.style.width = Math.max(rect.width, 24) + "px";
    ghost.style.height = Math.max(rect.height, 18) + "px";
    document.body.appendChild(ghost);
    setTimeout(function () {
      ghost.classList.add("markup-context-ghost-fade");
    }, 1200);
    setTimeout(function () {
      ghost.remove();
    }, 2200);
  }

  function showAnnotationContext(anno) {
    var vr = anno.viewportRect;
    if (!vr) return;
    // Scroll so the original spot is centered. Instant, not smooth: smooth
    // window.scrollTo is silently inert on some wrapped docs.
    window.scrollTo(0, Math.max(0, vr.y + vr.h / 2 - window.innerHeight / 2));
    // Flash a temporary ghost outline at the original coords so the user can
    // see exactly where the annotation used to live.
    var ghost = document.createElement("div");
    ghost.className = "markup-context-ghost";
    ghost.style.left = vr.x + "px";
    ghost.style.top = vr.y + "px";
    ghost.style.width = Math.max(vr.w, 24) + "px";
    ghost.style.height = Math.max(vr.h, 18) + "px";
    document.body.appendChild(ghost);
    setTimeout(function () {
      ghost.classList.add("markup-context-ghost-fade");
    }, 1200);
    setTimeout(function () {
      ghost.remove();
    }, 2200);
  }

  var reattachTarget = null;

  function startReattach(anno) {
    reattachTarget = anno;
    document.body.classList.add("markup-pin-cursor");
    Sidebar.close();
    Toast.show("Click any element to re-attach annotation. Esc to cancel.", 8000);
  }

  function cancelReattach() {
    reattachTarget = null;
    document.body.classList.remove("markup-pin-cursor");
    Toast.hide();
  }

  function finishReattach(targetEl) {
    if (!reattachTarget) return;
    var fp = Fingerprint.elementFingerprint(targetEl);
    reattachTarget.anchor = fp;
    var rect = targetEl.getBoundingClientRect();
    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;
    reattachTarget.viewportRect = {
      x: Math.round(rect.left + scrollX),
      y: Math.round(rect.top + scrollY),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
    // For spans (and the instant-creation span variants), update anchorText to
    // the new element's text so re-hydration matches against current DOM.
    if (
      (reattachTarget.mode === "span" ||
        reattachTarget.mode === "highlight" ||
        reattachTarget.mode === "strike") &&
      reattachTarget.payload
    ) {
      reattachTarget.payload.anchorText = (targetEl.textContent || "").slice(0, 200);
    }
    Persist.upsertAnnotation(sourceKey, reattachTarget);
    Toast.show("Re-attached.", 1800);
    cancelReattach();
    refresh();
    updateCount();
  }

  // Alias retained for backward compat; new code routes through removeAnnotation.
  function deleteFromSidebar(anno) {
    removeAnnotation(anno);
  }

  function refreshPositions() {
    // Re-position pins and rects based on their stored anchors (if anchor moves, they move).
    document.querySelectorAll(".markup-pin").forEach(function (badge) {
      var id = badge.getAttribute("data-anno-id");
      var anno = findAnno(id);
      if (!anno) return;
      positionPinBadge(badge, anno);
    });
    document.querySelectorAll(".markup-rect").forEach(function (box) {
      var id = box.getAttribute("data-anno-id");
      var anno = findAnno(id);
      if (!anno) return;
      positionRectBox(box, anno);
    });
  }

  function findAnno(id) {
    var list = Persist.loadAnnotations(sourceKey);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function updateCount() {
    if (typeof window.__MARKUP_UPDATE_COUNT__ === "function") {
      window.__MARKUP_UPDATE_COUNT__();
    }
  }

  // ---- TEXT SPAN MODE -------------------------------------------------------

  function installSelectionListener() {
    document.addEventListener("mouseup", function (e) {
      if (activeMode !== "span") return;
      // Defer so the browser settles the selection.
      setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (Popover.isVisible()) return;
        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (isInsideMarkupUI(range.commonAncestorContainer)) return;

        var rangeText = sel.toString();
        // Wrap selection in a "pending" highlight so the user sees what they
        // grabbed while writing the note. Clears native selection by design —
        // pending highlight is the substitute.
        var pendingMark = wrapRangeInMark(range, "markup-span-pending");
        var anchorRect = pendingMark ? pendingMark.getBoundingClientRect() : rect;
        sel.removeAllRanges();

        Popover.show({
          anchorRect: anchorRect,
          onSave: function (note) {
            finalizePendingSpan(pendingMark, rangeText, note);
          },
          onCancel: function () {
            unwrapPendingMark(pendingMark);
          },
        });
      }, 0);
    });
  }

  function wrapRangeInMark(range, className) {
    var mark = document.createElement("mark");
    mark.className = className;
    try {
      range.surroundContents(mark);
      return mark;
    } catch (_e) {
      try {
        var frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
        return mark;
      } catch (_e2) {
        return null;
      }
    }
  }

  function unwrapPendingMark(mark) {
    if (!mark || !mark.parentNode) return;
    var parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize && parent.normalize();
  }

  function finalizePendingSpan(pendingMark, anchorText, note) {
    if (!pendingMark) return; // nothing to finalize
    var anchorEl = pendingMark.parentElement || document.body;
    var fp = Fingerprint.elementFingerprint(anchorEl);
    var anno = {
      id: Persist.makeId(),
      mode: "span",
      createdAt: new Date().toISOString(),
      note: note || "",
      anchor: fp,
      viewportRect: captureViewportRect(pendingMark),
      payload: {
        anchorText: (anchorText || "").slice(0, 200),
      },
    };
    pendingMark.className = "markup-span";
    pendingMark.setAttribute("data-anno-id", anno.id);
    Persist.upsertAnnotation(sourceKey, anno);
    // Author's own write: rebuild the review drawer now, don't wait for the
    // ~10s poll (that cadence is only for other reviewers' changes).
    refresh();
    updateCount();
  }

  // Highlight/strike modes skip the popover entirely: the mark is already in
  // its final class (set by wrapRangeInMark), so this just persists the
  // annotation and tags the DOM node with its id.
  function finalizeInstantMark(mark, anchorText, mode) {
    if (!mark) return;
    var anchorEl = mark.parentElement || document.body;
    var fp = Fingerprint.elementFingerprint(anchorEl);
    var anno = {
      id: Persist.makeId(),
      mode: mode,
      createdAt: new Date().toISOString(),
      note: "",
      anchor: fp,
      viewportRect: captureViewportRect(mark),
      payload: {
        anchorText: (anchorText || "").slice(0, 200),
      },
    };
    mark.setAttribute("data-anno-id", anno.id);
    Persist.upsertAnnotation(sourceKey, anno);
    updateCount();
  }

  function captureViewportRect(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    var sx = window.scrollX || 0;
    var sy = window.scrollY || 0;
    return {
      x: Math.round(r.left + sx),
      y: Math.round(r.top + sy),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  function isInsideMarkupUI(node) {
    while (node) {
      if (
        node.id === "markup-toolbar" ||
        node.id === "markup-popover" ||
        node.id === "markup-toast" ||
        node.id === "markup-sidebar"
      )
        return true;
      node = node.parentNode;
    }
    return false;
  }

  function renderSpan(anno) {
    var anchorEl = Fingerprint.resolveByPath(anno.anchor && anno.anchor.cssPath);
    if (!anchorEl) return false;
    var text = (anno.payload && anno.payload.anchorText) || "";
    if (!text) return false;
    return wrapFirstTextMatch(anchorEl, text, anno.id);
  }

  // Text already wrapped by an earlier span this pass must be skipped, so two
  // spans in the same element don't shadow or split-break each other on
  // re-hydrate. The walker still visits the fragments an earlier mark left
  // behind (they sit outside the mark), so a distinct second selection is
  // still found.
  function insideSpanMark(node) {
    var p = node.parentNode;
    while (p && p !== document.body) {
      if (
        p.classList &&
        (p.classList.contains("markup-span") ||
          p.classList.contains("markup-highlight") ||
          p.classList.contains("markup-strike"))
      ) {
        return true;
      }
      p = p.parentNode;
    }
    return false;
  }

  function spanTextWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return insideSpanMark(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  // A selection routinely crosses element boundaries (bold runs, links, line
  // wraps), so the needle may exist in no single text node. Search the
  // concatenation of the walker's text nodes and map hits back to per-node
  // offsets; the whitespace-insensitive pass covers newline drift between the
  // captured selection and the serialized source.
  function wrapFirstTextMatch(root, needle, annoId, className) {
    var markClassName = className || "markup-span";
    if (!needle) return false;
    var walker = spanTextWalker(root);
    var nodes = [];
    var starts = [];
    var full = "";
    var node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
      starts.push(full.length);
      full += node.nodeValue;
    }
    if (!nodes.length) return false;

    var s = full.indexOf(needle);
    var e = s === -1 ? -1 : s + needle.length;

    if (s === -1) {
      // Collapse whitespace runs on both sides, keeping a map from each
      // collapsed character back to its index in `full`.
      var map = [];
      var collapsed = "";
      var inWs = false;
      for (var i = 0; i < full.length; i++) {
        if (/\s/.test(full[i])) {
          if (!inWs) {
            collapsed += " ";
            map.push(i);
          }
          inWs = true;
        } else {
          collapsed += full[i];
          map.push(i);
          inWs = false;
        }
      }
      var needleN = needle.replace(/\s+/g, " ").trim();
      if (!needleN) return false;
      var cs = collapsed.indexOf(needleN);
      if (cs === -1) return false;
      s = map[cs];
      e = map[cs + needleN.length - 1] + 1;
    }

    var startPos = positionAt(nodes, starts, s, false);
    var endPos = positionAt(nodes, starts, e, true);
    if (!startPos || !endPos) return false;

    var range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    var mark = document.createElement("mark");
    mark.className = markClassName;
    mark.setAttribute("data-anno-id", annoId);
    try {
      // Throws whenever the range partially selects a non-text node (any
      // cross-node match); extract/insert splits the boundary elements the
      // same way the creation path does.
      range.surroundContents(mark);
      return true;
    } catch (_e) {
      try {
        var frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
        return true;
      } catch (_e2) {
        return false;
      }
    }
  }

  // Map an offset in the concatenated text back to {node, offset}. An end
  // offset landing on a node boundary belongs to the earlier node's tail, a
  // start offset to the later node's head.
  function positionAt(nodes, starts, index, isEnd) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var rel = index - starts[i];
      var len = nodes[i].nodeValue.length;
      if (rel < 0) continue;
      if (isEnd ? rel > 0 && rel <= len : rel < len) {
        return { node: nodes[i], offset: rel };
      }
    }
    return null;
  }

  function installSpanClickDelegate() {
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains("markup-span")) return;
        e.preventDefault();
        e.stopPropagation();
        var id = t.getAttribute("data-anno-id");
        var anno = findAnno(id);
        if (!anno) return;
        Popover.show({
          anchorRect: t.getBoundingClientRect(),
          initialText: anno.note,
          readOnly: !ownsAnno(anno),
          author: anno.author,
          createdAt: anno.createdAt,
          onReply: replyVia(anno),
          canDelete: ownsAnno(anno),
          canAccept: true,
          onSave: function (note) {
            anno.note = note;
            Persist.upsertAnnotation(sourceKey, anno);
            refresh();
            updateCount();
          },
          onAccept: function () {
            acceptAnnotation(anno);
          },
          onDelete: function () {
            removeAnnotation(anno);
          },
        });
      },
      true,
    );
  }

  // ---- HIGHLIGHT MODE ---------------------------------------------------------
  // Selecting text while this mode is active immediately creates a highlight
  // annotation — no popover, no note required. Clicking an existing highlight
  // reopens the popover so a note can be added or the annotation removed.

  function installHighlightSelectionListener() {
    document.addEventListener("mouseup", function (e) {
      if (activeMode !== "highlight") return;
      setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (Popover.isVisible()) return;
        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (isInsideMarkupUI(range.commonAncestorContainer)) return;

        var rangeText = sel.toString();
        var mark = wrapRangeInMark(range, "markup-highlight");
        sel.removeAllRanges();
        if (!mark) return;
        finalizeInstantMark(mark, rangeText, "highlight");
      }, 0);
    });
  }

  function renderHighlight(anno) {
    var anchorEl = Fingerprint.resolveByPath(anno.anchor && anno.anchor.cssPath);
    if (!anchorEl) return false;
    var text = (anno.payload && anno.payload.anchorText) || "";
    if (!text) return false;
    return wrapFirstTextMatch(anchorEl, text, anno.id, "markup-highlight");
  }

  function installHighlightClickDelegate() {
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains("markup-highlight")) return;
        e.preventDefault();
        e.stopPropagation();
        var id = t.getAttribute("data-anno-id");
        var anno = findAnno(id);
        if (!anno) return;
        Popover.show({
          anchorRect: t.getBoundingClientRect(),
          initialText: anno.note,
          readOnly: !ownsAnno(anno),
          author: anno.author,
          createdAt: anno.createdAt,
          onReply: replyVia(anno),
          canDelete: ownsAnno(anno),
          canAccept: true,
          onSave: function (note) {
            anno.note = note;
            Persist.upsertAnnotation(sourceKey, anno);
            refresh();
            updateCount();
          },
          onAccept: function () {
            acceptAnnotation(anno);
          },
          onDelete: function () {
            removeAnnotation(anno);
          },
        });
      },
      true,
    );
  }

  // ---- STRIKE MODE ------------------------------------------------------------
  // Same instant-creation flow as highlight mode, but marks the span for
  // deletion instead of emphasis. Clicking an existing strike reopens the
  // popover so a reason can be added or the annotation removed.

  function installStrikeSelectionListener() {
    document.addEventListener("mouseup", function (e) {
      if (activeMode !== "strike") return;
      setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        if (Popover.isVisible()) return;
        var range = sel.getRangeAt(0);
        var rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (isInsideMarkupUI(range.commonAncestorContainer)) return;

        var rangeText = sel.toString();
        var mark = wrapRangeInMark(range, "markup-strike");
        sel.removeAllRanges();
        if (!mark) return;
        finalizeInstantMark(mark, rangeText, "strike");
      }, 0);
    });
  }

  function renderStrike(anno) {
    var anchorEl = Fingerprint.resolveByPath(anno.anchor && anno.anchor.cssPath);
    if (!anchorEl) return false;
    var text = (anno.payload && anno.payload.anchorText) || "";
    if (!text) return false;
    return wrapFirstTextMatch(anchorEl, text, anno.id, "markup-strike");
  }

  function installStrikeClickDelegate() {
    document.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains("markup-strike")) return;
        e.preventDefault();
        e.stopPropagation();
        var id = t.getAttribute("data-anno-id");
        var anno = findAnno(id);
        if (!anno) return;
        Popover.show({
          anchorRect: t.getBoundingClientRect(),
          initialText: anno.note,
          readOnly: !ownsAnno(anno),
          author: anno.author,
          createdAt: anno.createdAt,
          onReply: replyVia(anno),
          canDelete: ownsAnno(anno),
          canAccept: true,
          onSave: function (note) {
            anno.note = note;
            Persist.upsertAnnotation(sourceKey, anno);
            refresh();
            updateCount();
          },
          onAccept: function () {
            acceptAnnotation(anno);
          },
          onDelete: function () {
            removeAnnotation(anno);
          },
        });
      },
      true,
    );
  }

  // ---- PIN MODE -------------------------------------------------------------

  function installPinDelegate() {
    document.addEventListener(
      "click",
      function (e) {
        // Reattach intercept beats every other click handler.
        if (reattachTarget) {
          if (isInsideMarkupUI(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          finishReattach(e.target);
          return;
        }
        // Clicking an existing pin reopens its popover; don't drop a new pin.
        var pinBadge = e.target.closest && e.target.closest(".markup-pin");
        if (pinBadge) {
          e.preventDefault();
          e.stopPropagation();
          openExistingPin(pinBadge);
          return;
        }
        if (activeMode !== "pin") return;
        if (isInsideMarkupUI(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        dropPin(e.target, e.clientX, e.clientY);
      },
      true,
    );
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && reattachTarget) {
        e.preventDefault();
        e.stopPropagation();
        cancelReattach();
      }
    });
  }

  function dropPin(targetEl, _clientX, _clientY) {
    var fp = Fingerprint.elementFingerprint(targetEl);
    var pinNum = Persist.nextPinNumber(sourceKey);
    var anno = {
      id: Persist.makeId(),
      mode: "pin",
      createdAt: new Date().toISOString(),
      note: "",
      pinNum: pinNum,
      anchor: fp,
      viewportRect: captureViewportRect(targetEl),
      payload: {},
    };
    var badge = createPinBadge(anno);
    document.body.appendChild(badge);
    positionPinBadge(badge, anno);
    Popover.show({
      anchorRect: badge.getBoundingClientRect(),
      initialText: "",
      canDelete: true,
      onSave: function (note) {
        anno.note = note;
        Persist.upsertAnnotation(sourceKey, anno);
        refresh();
        updateCount();
      },
      onCancel: function () {
        // Cancel = remove the new pin (not yet persisted).
        badge.remove();
      },
      onDelete: function () {
        badge.remove();
      },
    });
  }

  function openExistingPin(badge) {
    var id = badge.getAttribute("data-anno-id");
    var anno = findAnno(id);
    if (!anno) return;
    Popover.show({
      anchorRect: badge.getBoundingClientRect(),
      initialText: anno.note,
      readOnly: !ownsAnno(anno),
      author: anno.author,
      createdAt: anno.createdAt,
      onReply: replyVia(anno),
      canDelete: ownsAnno(anno),
      canAccept: true,
      onSave: function (note) {
        anno.note = note;
        Persist.upsertAnnotation(sourceKey, anno);
        refresh();
        updateCount();
      },
      onAccept: function () {
        acceptAnnotation(anno);
      },
      onDelete: function () {
        removeAnnotation(anno);
      },
    });
  }

  function renderPin(anno) {
    var anchor = Fingerprint.resolveByPath(anno.anchor && anno.anchor.cssPath);
    if (!anchor) return false;
    var badge = createPinBadge(anno);
    document.body.appendChild(badge);
    positionPinBadge(badge, anno);
    return true;
  }

  function createPinBadge(anno) {
    var badge = document.createElement("div");
    badge.className = "markup-pin";
    badge.setAttribute("data-anno-id", anno.id);
    badge.setAttribute("data-pin-num", String(anno.pinNum || "?"));
    badge.textContent = String(anno.pinNum || "?");
    return badge;
  }

  function positionPinBadge(badge, anno) {
    var anchor = Fingerprint.resolveByPath(anno.anchor && anno.anchor.cssPath);
    if (!anchor) {
      badge.style.display = "none";
      return;
    }
    badge.style.display = "";
    var rect = anchor.getBoundingClientRect();
    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;
    badge.style.left = Math.round(rect.left + scrollX - 8) + "px";
    badge.style.top = Math.round(rect.top + scrollY - 8) + "px";
  }

  // ---- RECT MODE ------------------------------------------------------------

  function installRectDelegate() {
    rectMouseDownHandler = function (e) {
      if (activeMode !== "rect") return;
      if (isInsideMarkupUI(e.target)) return;
      if (e.button !== 0) return;
      startRectDrag(e);
    };
    document.addEventListener("mousedown", rectMouseDownHandler, true);

    document.addEventListener(
      "click",
      function (e) {
        var rectBox = e.target.closest && e.target.closest(".markup-rect");
        if (rectBox) {
          e.preventDefault();
          e.stopPropagation();
          openExistingRect(rectBox);
        }
      },
      true,
    );
  }

  function installShiftDragListener() {
    document.addEventListener(
      "mousedown",
      function (e) {
        if (!e.shiftKey) return;
        if (activeMode === "rect") return; // rect mode handles it
        if (activeMode === "pin") return; // pin click handler owns clicks
        if (isInsideMarkupUI(e.target)) return;
        if (e.button !== 0) return;
        startRectDrag(e);
      },
      true,
    );
  }

  function startRectDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;
    rectStart = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    rectDraft = document.createElement("div");
    rectDraft.className = "markup-rect-draft";
    rectDraft.style.left = rectStart.x + "px";
    rectDraft.style.top = rectStart.y + "px";
    rectDraft.style.width = "0px";
    rectDraft.style.height = "0px";
    document.body.appendChild(rectDraft);

    rectMouseMoveHandler = function (ev) {
      var cx = ev.clientX + (window.scrollX || 0);
      var cy = ev.clientY + (window.scrollY || 0);
      var x = Math.min(rectStart.x, cx);
      var y = Math.min(rectStart.y, cy);
      var w = Math.abs(cx - rectStart.x);
      var h = Math.abs(cy - rectStart.y);
      rectDraft.style.left = x + "px";
      rectDraft.style.top = y + "px";
      rectDraft.style.width = w + "px";
      rectDraft.style.height = h + "px";
    };
    rectMouseUpHandler = function (ev) {
      document.removeEventListener("mousemove", rectMouseMoveHandler, true);
      document.removeEventListener("mouseup", rectMouseUpHandler, true);
      var cx = ev.clientX + (window.scrollX || 0);
      var cy = ev.clientY + (window.scrollY || 0);
      var x = Math.min(rectStart.x, cx);
      var y = Math.min(rectStart.y, cy);
      var w = Math.abs(cx - rectStart.x);
      var h = Math.abs(cy - rectStart.y);
      if (rectDraft) {
        rectDraft.remove();
        rectDraft = null;
      }
      if (w < 8 || h < 8) return; // treat as click
      finalizeRect({ x: x, y: y, w: w, h: h });
    };
    document.addEventListener("mousemove", rectMouseMoveHandler, true);
    document.addEventListener("mouseup", rectMouseUpHandler, true);
  }

  function finalizeRect(rect) {
    Toast.show("Capturing screenshot...");
    Screenshot.captureRect(rect)
      .then(function (pngDataURL) {
        Toast.hide();
        commitRect(rect, pngDataURL, null);
      })
      .catch(function (err) {
        console.warn("[markup] screenshot failed:", err);
        Toast.show("Screenshot failed: " + (err && err.message ? err.message : "unknown"));
        commitRect(rect, null, err && err.message ? err.message : "unknown");
      });
  }

  function commitRect(rect, pngDataURL, errorReason) {
    var centerEl = elementAtPagePoint(rect.x + rect.w / 2, rect.y + rect.h / 2);
    var fp = centerEl ? Fingerprint.elementFingerprint(centerEl) : null;
    var rectNum = Persist.nextRectNumber(sourceKey);
    var anno = {
      id: Persist.makeId(),
      mode: "rect",
      createdAt: new Date().toISOString(),
      note: "",
      rectNum: rectNum,
      anchor: fp,
      payload: {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        pngDataURL: pngDataURL || null,
        screenshotError: errorReason || null,
      },
    };
    var box = createRectBox(anno);
    document.body.appendChild(box);
    Popover.show({
      anchorRect: box.getBoundingClientRect(),
      initialText: "",
      canDelete: true,
      onSave: function (note) {
        anno.note = note;
        Persist.upsertAnnotation(sourceKey, anno);
        refresh();
        updateCount();
      },
      onCancel: function () {
        box.remove();
      },
      onDelete: function () {
        box.remove();
      },
    });
  }

  function elementAtPagePoint(px, py) {
    var vx = px - (window.scrollX || 0);
    var vy = py - (window.scrollY || 0);
    return document.elementFromPoint(vx, vy);
  }

  function openExistingRect(box) {
    var id = box.getAttribute("data-anno-id");
    var anno = findAnno(id);
    if (!anno) return;
    Popover.show({
      anchorRect: box.getBoundingClientRect(),
      initialText: anno.note,
      readOnly: !ownsAnno(anno),
      author: anno.author,
      createdAt: anno.createdAt,
      onReply: replyVia(anno),
      canDelete: ownsAnno(anno),
      canAccept: true,
      onSave: function (note) {
        anno.note = note;
        Persist.upsertAnnotation(sourceKey, anno);
        refresh();
        updateCount();
      },
      onAccept: function () {
        acceptAnnotation(anno);
      },
      onDelete: function () {
        removeAnnotation(anno);
      },
    });
  }

  function renderRect(anno) {
    var box = createRectBox(anno);
    document.body.appendChild(box);
  }

  function createRectBox(anno) {
    var box = document.createElement("div");
    box.className = "markup-rect";
    box.setAttribute("data-anno-id", anno.id);
    box.setAttribute("data-rect-num", String(anno.rectNum || "?"));
    positionRectBox(box, anno);
    return box;
  }

  function positionRectBox(box, anno) {
    var p = anno.payload || {};
    box.style.left = (p.x || 0) + "px";
    box.style.top = (p.y || 0) + "px";
    box.style.width = (p.w || 0) + "px";
    box.style.height = (p.h || 0) + "px";
  }

  function isReattaching() {
    return !!reattachTarget;
  }

  return {
    init: init,
    setActive: setActive,
    getActive: getActive,
    hydrate: hydrate,
    refresh: refresh,
    isInsideMarkupUI: isInsideMarkupUI,
    isReattaching: isReattaching,
  };
})();
