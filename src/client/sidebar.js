// Review panel sidebar. Lists ALL annotations grouped by lifecycle state:
//   Pending  — anchor lost, OR carried from previous source version. Needs triage.
//   Open     — active feedback, still attached to current DOM.
//   Accepted — user marked addressed. Kept for the record.
//
// Per-state actions:
//   Pending  : Where it was / Re-attach / Accept / Remove
//   Open     : Where it is  / Accept / Remove
//   Accepted : Where it was / Re-open / Remove

var Sidebar = (function () {
  var panelEl = null;
  var listEl = null;
  var bannerEl = null;
  var headerCountEl = null;
  var state = { open: [], pending: [], accepted: [] };
  var handlers = {};
  // Snapshot of unseen-other ids, taken when the drawer opens, so the review
  // order and NEW markers hold still while the badge count clears underneath.
  var sessionNewIds = {};
  // Flat, render-ordered list of annotations for the j/k + pill walk.
  var walkList = [];
  var walkIndex = -1;
  var activeComposer = null;

  function relTime(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return new Date(t).toLocaleDateString();
  }

  function shortName(email) {
    return String(email || "?").split("@")[0];
  }

  // Deterministic identity hue per author, Drive-style: same reviewer, same
  // color, everywhere. The wheel skips orange/red so identity never collides
  // with the product accent or the danger color.
  var AUTHOR_HUES = [212, 262, 174, 330, 140, 232];
  function authorHue(author) {
    var s = String(author || "?");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AUTHOR_HUES[h % AUTHOR_HUES.length];
  }
  function authorColor(author) {
    return "hsl(" + authorHue(author) + ", 45%, 38%)";
  }
  function avatarEl(author) {
    var el = document.createElement("span");
    el.className = "markup-sidebar-avatar";
    if (author) {
      el.textContent = shortName(author).slice(0, 2);
      el.style.background = "hsl(" + authorHue(author) + ", 55%, 91%)";
      el.style.color = authorColor(author);
      el.setAttribute("title", author);
    } else {
      // No author on a shared canvas: the note predates attribution or was
      // imported from a solo session. Neutral gray, never an identity hue —
      // hashing "?" into the wheel would dress it up as a real teammate.
      el.textContent = "?";
      el.classList.add("markup-sidebar-avatar-unknown");
      el.setAttribute("title", "Unattributed note");
    }
    return el;
  }

  function ensureBuilt() {
    if (panelEl) return panelEl;

    panelEl = document.createElement("aside");
    panelEl.id = "markup-sidebar";

    // While the drawer is open the floating palette docks here, so the
    // bottom-right never shows two competing surfaces.
    var dock = document.createElement("div");
    dock.className = "markup-sidebar-dock";
    panelEl.appendChild(dock);

    var header = document.createElement("div");
    header.className = "markup-sidebar-header";

    var title = document.createElement("div");
    title.className = "markup-sidebar-title";
    title.textContent = "Review";
    header.appendChild(title);

    headerCountEl = document.createElement("div");
    headerCountEl.className = "markup-sidebar-count";
    header.appendChild(headerCountEl);

    var closeBtn = document.createElement("button");
    closeBtn.className = "markup-sidebar-close";
    closeBtn.setAttribute("title", "Close sidebar");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", close);
    header.appendChild(closeBtn);
    panelEl.appendChild(header);

    bannerEl = document.createElement("div");
    bannerEl.className = "markup-sidebar-banner";
    bannerEl.style.display = "none";
    panelEl.appendChild(bannerEl);

    listEl = document.createElement("div");
    listEl.className = "markup-sidebar-list";
    panelEl.appendChild(listEl);

    document.body.appendChild(panelEl);
    return panelEl;
  }

  // Lifecycle state is carried by the section an entry sits in, so the card
  // itself only whispers the annotation kind (and its pin/rect number).
  function kindToken(anno) {
    var span = document.createElement("span");
    span.className = "markup-sidebar-kind";
    var label =
      anno.mode === "span"
        ? "text"
        : anno.mode === "highlight"
          ? "highlight"
          : anno.mode === "strike"
            ? "strike"
            : anno.mode === "pin"
              ? "pin"
              : "rect";
    if (anno.mode === "pin" && anno.pinNum) label += " " + anno.pinNum;
    if (anno.mode === "rect" && anno.rectNum) label += " " + anno.rectNum;
    span.textContent = label;
    span.setAttribute(
      "title",
      anno.mode === "span"
        ? "Text selection"
        : anno.mode === "highlight"
          ? "Highlighted text"
          : anno.mode === "strike"
            ? "Struck-through text"
            : anno.mode === "pin"
              ? "Pinned element"
              : "Rectangle",
    );
    return span;
  }

  function makeBtn(text, cls, fn) {
    var b = document.createElement("button");
    b.className = "markup-sidebar-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  // Threaded replies under an annotation, plus (on a shared canvas) a small
  // composer so the conversation stays on the doc instead of scattering.
  function buildThread(anno) {
    var wrap = document.createElement("div");
    wrap.className = "markup-sidebar-thread";

    if (anno.replies && anno.replies.length) {
      anno.replies.forEach(function (r) {
        var line = document.createElement("div");
        line.className = "markup-sidebar-reply";

        var who = document.createElement("span");
        who.className = "markup-sidebar-reply-author";
        if (r.author) {
          who.textContent = shortName(r.author);
          who.style.color = authorColor(r.author);
          who.setAttribute("title", r.author);
        } else {
          who.textContent = "unknown";
          who.classList.add("markup-sidebar-name-unknown");
          who.setAttribute("title", "Unattributed reply");
        }
        line.appendChild(who);

        var when = document.createElement("span");
        when.className = "markup-sidebar-reply-when";
        when.textContent = relTime(r.at);
        line.appendChild(when);

        var text = document.createElement("div");
        text.className = "markup-sidebar-reply-text";
        text.textContent = r.text || "";
        line.appendChild(text);

        wrap.appendChild(line);
      });
    }

    if (Persist.isRemote && Persist.isRemote()) {
      var replyBtn = document.createElement("button");
      replyBtn.className = "markup-sidebar-reply-btn";
      replyBtn.textContent = "Reply";
      replyBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openComposer(wrap, replyBtn, anno);
      });
      wrap.appendChild(replyBtn);
    }

    return wrap;
  }

  function closeComposer() {
    if (!activeComposer) return;
    var c = activeComposer;
    activeComposer = null;
    if (c.box.parentNode) c.box.parentNode.removeChild(c.box);
    c.btn.style.display = "";
  }

  function openComposer(threadEl, replyBtn, anno) {
    closeComposer();

    var box = document.createElement("div");
    box.className = "markup-sidebar-compose";

    var ta = document.createElement("textarea");
    ta.setAttribute("placeholder", "Reply to this note…");
    box.appendChild(ta);

    var row = document.createElement("div");
    row.className = "markup-sidebar-compose-buttons";

    var cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function (e) {
      e.stopPropagation();
      closeComposer();
    });
    row.appendChild(cancel);

    var send = document.createElement("button");
    send.className = "markup-sidebar-compose-send";
    send.textContent = "Send";
    row.appendChild(send);
    box.appendChild(row);

    function doSend() {
      var text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      send.textContent = "Sending…";
      Persist.postReply(anno.id, text).then(
        function () {
          closeComposer();
          if (handlers.onThreadChange) handlers.onThreadChange();
        },
        function (err) {
          send.disabled = false;
          send.textContent = "Send";
          if (typeof Toast !== "undefined") {
            Toast.show("Reply failed: " + (err && err.message ? err.message : "network error"), 3500);
          }
        },
      );
    }
    send.addEventListener("click", function (e) {
      e.stopPropagation();
      doSend();
    });
    ta.addEventListener("keydown", function (e) {
      // Cmd/Ctrl+Enter sends; Esc closes just the composer.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        doSend();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeComposer();
      }
    });

    replyBtn.style.display = "none";
    threadEl.appendChild(box);
    activeComposer = { box: box, btn: replyBtn, annoId: anno.id };
    ta.focus();
  }

  function hasActiveComposer() {
    return !!activeComposer;
  }

  // Esc pressed anywhere (not just inside the textarea) closes the composer:
  // dismissal walks outward one surface at a time.
  function closeActiveComposer() {
    closeComposer();
  }

  function buildEntry(anno, status) {
    var entry = document.createElement("div");
    entry.className = "markup-sidebar-entry markup-sidebar-entry-" + status;
    entry.setAttribute("data-anno-id", anno.id);
    if (sessionNewIds[anno.id]) entry.classList.add("markup-sidebar-entry-new");

    // Header: who + when, then (pending only) why it needs a look, then the
    // kind token. Lifecycle chips are gone — the section already says status.
    var top = document.createElement("div");
    top.className = "markup-sidebar-entry-top";
    // Attribution is a shared-canvas concept. Solo mode has exactly one
    // author (you), so who-chips would be noise — the row starts at the time.
    if (Persist.isRemote && Persist.isRemote()) {
      top.appendChild(avatarEl(anno.author));
      var name = document.createElement("span");
      name.className = "markup-sidebar-name";
      if (anno.author) {
        name.textContent = shortName(anno.author);
        name.style.color = authorColor(anno.author);
        name.setAttribute("title", anno.author);
      } else {
        name.textContent = "unknown";
        name.classList.add("markup-sidebar-name-unknown");
        name.setAttribute("title", "Unattributed note");
      }
      top.appendChild(name);
    }
    if (sessionNewIds[anno.id]) {
      var dot = document.createElement("span");
      dot.className = "markup-sidebar-new-dot";
      dot.setAttribute("title", "New since you last looked");
      top.appendChild(dot);
    }
    var when = document.createElement("span");
    when.className = "markup-sidebar-when";
    try {
      when.textContent = relTime(anno.createdAt);
      when.setAttribute("title", new Date(anno.createdAt).toLocaleString());
    } catch (_e) {
      when.textContent = "";
    }
    top.appendChild(when);
    var spacer = document.createElement("span");
    spacer.className = "markup-sidebar-top-spacer";
    top.appendChild(spacer);
    if (status === "pending") {
      var why = document.createElement("span");
      why.className = "markup-sidebar-why";
      why.textContent = Persist.displayStatus ? Persist.displayStatus(anno) : "Needs another look";
      top.appendChild(why);
    }
    top.appendChild(kindToken(anno));
    entry.appendChild(top);

    // The anchor context is the jump affordance: clicking the quote (or the
    // rect thumbnail) goes to the spot, replacing the Where-it-is/was buttons.
    function jump() {
      if (status === "open") {
        if (handlers.onScrollToInline) handlers.onScrollToInline(anno);
      } else if (handlers.onShowContext) {
        handlers.onShowContext(anno);
      }
    }
    var jumpTitle = status === "open" ? "Jump to it in the doc" : "Show where it was";
    var hasCtx = false;
    if (anno.mode === "rect" && ((anno.payload && anno.payload.pngDataURL) || anno.shotUrl)) {
      var thumbBtn = document.createElement("button");
      thumbBtn.className = "markup-sidebar-ctx";
      thumbBtn.setAttribute("title", jumpTitle);
      var img = document.createElement("img");
      img.className = "markup-sidebar-thumb";
      // Local data URL when this browser took the shot; shotUrl for everyone else.
      img.src = (anno.payload && anno.payload.pngDataURL) || anno.shotUrl;
      img.alt = "rect screenshot";
      thumbBtn.appendChild(img);
      thumbBtn.addEventListener("click", jump);
      entry.appendChild(thumbBtn);
      hasCtx = true;
    } else {
      // For a span, quote the reviewer's actual selection (payload.anchorText);
      // anchor.anchorText is the whole parent element's text, which is
      // identical for two spans in the same paragraph and reads as duplicate,
      // mislabeled context. Pins/rects have no selection, so they fall back to
      // the element text.
      var span = anno.mode === "span";
      var selText = anno.payload && anno.payload.anchorText;
      var elText = anno.anchor && anno.anchor.anchorText;
      var anchorText = (span ? selText || elText : elText || selText) || "";
      if (anchorText) {
        var quoteBtn = document.createElement("button");
        quoteBtn.className = "markup-sidebar-ctx markup-sidebar-quote";
        quoteBtn.setAttribute("title", jumpTitle);
        quoteBtn.textContent = anchorText.slice(0, 140);
        quoteBtn.addEventListener("click", jump);
        entry.appendChild(quoteBtn);
        hasCtx = true;
      }
    }

    var note = document.createElement("div");
    note.className = "markup-sidebar-note";
    note.textContent = anno.note || "(no note)";
    entry.appendChild(note);

    entry.appendChild(buildThread(anno));

    var actions = document.createElement("div");
    actions.className = "markup-sidebar-actions";

    // Only the author edits or removes a note (or re-attaches it — that
    // rewrites its anchor). Anyone may resolve, re-open, and reply, so
    // another reviewer's entry offers exactly those.
    var owns = !(Persist.isRemote && Persist.isRemote()) || !anno.author || anno.author === Persist.self();

    function removeBtn() {
      return makeBtn("Remove", "markup-sidebar-btn-danger", function () {
        if (!confirm("Remove this annotation? Cannot undo.")) return;
        if (handlers.onRemove) handlers.onRemove(anno);
      });
    }

    // An entry with no quotable context keeps a jump button so the spot is
    // still reachable.
    if (!hasCtx) {
      actions.appendChild(makeBtn(status === "open" ? "Where it is" : "Where it was", "", jump));
    }
    if (status === "pending") {
      if (owns) {
        actions.appendChild(
          makeBtn("Re-attach", "", function () {
            if (handlers.onReattach) handlers.onReattach(anno);
          }),
        );
      }
      actions.appendChild(
        makeBtn("Resolve", "markup-sidebar-btn-primary", function () {
          if (handlers.onAccept) handlers.onAccept(anno);
        }),
      );
      if (owns) actions.appendChild(removeBtn());
    } else if (status === "open") {
      actions.appendChild(
        makeBtn("Resolve", "markup-sidebar-btn-primary", function () {
          if (handlers.onAccept) handlers.onAccept(anno);
        }),
      );
      if (owns) actions.appendChild(removeBtn());
    } else if (status === "accepted") {
      actions.appendChild(
        makeBtn("Re-open", "", function () {
          if (handlers.onReopen) handlers.onReopen(anno);
        }),
      );
      if (owns) actions.appendChild(removeBtn());
    }
    entry.appendChild(actions);
    return entry;
  }

  function section(title, items, status, collapsedByDefault) {
    var wrap = document.createElement("div");
    wrap.className = "markup-sidebar-section markup-sidebar-section-" + status;

    var head = document.createElement("button");
    head.className = "markup-sidebar-section-head";
    head.setAttribute("type", "button");

    var caret = document.createElement("span");
    caret.className = "markup-sidebar-caret";
    caret.textContent = "▾";
    head.appendChild(caret);

    var label = document.createElement("span");
    label.className = "markup-sidebar-section-label";
    label.textContent = title;
    head.appendChild(label);

    var cnt = document.createElement("span");
    cnt.className = "markup-sidebar-section-count";
    cnt.textContent = String(items.length);
    head.appendChild(cnt);

    var body = document.createElement("div");
    body.className = "markup-sidebar-section-body";

    // Bulk action row (only when section has items).
    if (items.length > 0) {
      var bulk = document.createElement("div");
      bulk.className = "markup-sidebar-bulk";
      // Stop section toggle when clicking bulk buttons.
      bulk.addEventListener("click", function (e) {
        e.stopPropagation();
      });

      if (status === "pending" || status === "open") {
        bulk.appendChild(
          makeBtn(
            "Resolve all (" + items.length + ")",
            "markup-sidebar-btn-primary",
            function () {
              if (!confirm("Resolve all " + items.length + " notes in this section?")) return;
              items.slice().forEach(function (a) {
                if (handlers.onAccept) handlers.onAccept(a);
              });
            },
          ),
        );
      }
      if (status === "accepted") {
        bulk.appendChild(
          makeBtn("Re-open all (" + items.length + ")", "", function () {
            if (!confirm("Re-open all " + items.length + " resolved notes?")) return;
            items.slice().forEach(function (a) {
              if (handlers.onReopen) handlers.onReopen(a);
            });
          }),
        );
      }
      bulk.appendChild(
        makeBtn(
          "Remove all (" + items.length + ")",
          "markup-sidebar-btn-danger",
          function () {
            if (
              !confirm(
                "Remove all " +
                  items.length +
                  " " +
                  status +
                  " annotations? This cannot be undone.",
              )
            )
              return;
            items.slice().forEach(function (a) {
              if (handlers.onRemove) handlers.onRemove(a);
            });
          },
        ),
      );
      body.appendChild(bulk);
    }

    if (items.length === 0) {
      var empty = document.createElement("div");
      empty.className = "markup-sidebar-empty";
      empty.textContent =
        status === "pending"
          ? "Nothing needs another look."
          : status === "open"
          ? "No open notes. Select text, or press P and click, to leave one."
          : "Nothing resolved yet.";
      body.appendChild(empty);
    } else {
      items.forEach(function (a) {
        body.appendChild(buildEntry(a, status));
        walkList.push({ id: a.id, anno: a, status: status });
      });
    }

    var collapsed = collapsedByDefault && items.length > 0;
    if (collapsed) {
      wrap.classList.add("markup-sidebar-section-collapsed");
    }
    head.addEventListener("click", function () {
      wrap.classList.toggle("markup-sidebar-section-collapsed");
    });

    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  }

  // Review-pass order inside each section: on a shared canvas, notes you
  // haven't seen from other reviewers come first, then theirs, then yours —
  // so walking top-to-bottom covers the whole review without hunting.
  function ordered(items) {
    if (Persist.isRemote && Persist.isRemote() && Persist.reviewOrder) {
      return Persist.reviewOrder(items, sessionNewIds);
    }
    return items;
  }

  function render() {
    ensureBuilt();
    closeComposer();
    listEl.textContent = "";
    walkList = [];
    listEl.appendChild(section("Needs another look", state.pending, "pending", false));
    listEl.appendChild(section("Open", ordered(state.open), "open", false));
    listEl.appendChild(section("Resolved", state.accepted, "accepted", true));

    // Top count badge = pending count (the one that actually needs action).
    headerCountEl.textContent = state.pending.length > 0 ? String(state.pending.length) : "";
  }

  // ---- guided walk (j/k keys + the badge's "N new" pill) --------------------

  function focusAt(index) {
    if (!walkList.length) return;
    walkIndex = ((index % walkList.length) + walkList.length) % walkList.length;
    var target = walkList[walkIndex];

    open();
    var entries = listEl.querySelectorAll(".markup-sidebar-entry");
    for (var i = 0; i < entries.length; i++) {
      entries[i].classList.remove("markup-sidebar-entry-focus");
    }
    var entry = listEl.querySelector('.markup-sidebar-entry[data-anno-id="' + target.id + '"]');
    if (entry) {
      // Un-collapse the section holding it so the walk never lands on nothing.
      var sectionEl = entry.closest(".markup-sidebar-section");
      if (sectionEl) sectionEl.classList.remove("markup-sidebar-section-collapsed");
      entry.classList.add("markup-sidebar-entry-focus");
      // Instant like every other jump: smooth scrolling is silently inert on
      // some wrapped docs, and the walk should feel zippy anyway.
      entry.scrollIntoView({ block: "nearest" });
    }
    // Bring the page to the note itself when it's rendered inline.
    if (target.status === "open" && handlers.onScrollToInline) {
      handlers.onScrollToInline(target.anno);
    }
  }

  function focusNext() {
    focusAt(walkIndex + 1);
  }

  function focusPrev() {
    focusAt(walkIndex - 1);
  }

  // Open the drawer landed on one annotation with its reply composer ready.
  // The entry's own Reply button carries the wiring — click it.
  function openReply(annoId) {
    open();
    for (var i = 0; i < walkList.length; i++) {
      if (walkList[i].id === annoId) {
        focusAt(i);
        break;
      }
    }
    var entry = listEl.querySelector('.markup-sidebar-entry[data-anno-id="' + annoId + '"]');
    if (!entry) return;
    var btn = entry.querySelector(".markup-sidebar-reply-btn");
    if (btn) btn.click();
  }

  function setBanner(opts) {
    ensureBuilt();
    if (!opts || !opts.message) {
      bannerEl.style.display = "none";
      bannerEl.textContent = "";
      return;
    }
    bannerEl.style.display = "block";
    bannerEl.textContent = "";
    var text = document.createElement("span");
    text.textContent = opts.message;
    bannerEl.appendChild(text);
    if (opts.dismissible !== false) {
      var btn = document.createElement("button");
      btn.className = "markup-sidebar-banner-close";
      btn.textContent = "Dismiss";
      btn.addEventListener("click", function () {
        bannerEl.style.display = "none";
      });
      bannerEl.appendChild(btn);
    }
  }

  function setReview(buckets, h) {
    state.open = (buckets.open || []).slice();
    state.pending = (buckets.pending || []).slice();
    state.accepted = (buckets.accepted || []).slice();
    handlers = h || {};
    render();
    if (h && h.sourceChanged) {
      setBanner({
        message:
          "Source changed since your last review. " +
          state.pending.filter(function (a) { return a.carryReason === "source-changed"; }).length +
          " annotations carried over — triage each.",
      });
    } else {
      setBanner(null);
    }
  }

  // One listener (the overlay) hears open/close so it can dock the palette
  // into the drawer and dismiss floating popups.
  var visibilityListener = null;
  function setVisibilityListener(cb) {
    visibilityListener = cb;
  }

  function open() {
    ensureBuilt();
    if (!panelEl.classList.contains("markup-sidebar-open")) {
      // Freeze the "what's new to me" snapshot for this reading session so
      // the review order and NEW markers hold still while the badge clears.
      sessionNewIds = Persist.newIds ? Persist.newIds() : {};
      walkIndex = -1;
      panelEl.classList.add("markup-sidebar-open");
      render();
      if (visibilityListener) visibilityListener(true);
    }
  }
  function close() {
    if (!panelEl) return;
    if (!panelEl.classList.contains("markup-sidebar-open")) return;
    closeComposer();
    panelEl.classList.remove("markup-sidebar-open");
    if (visibilityListener) visibilityListener(false);
  }
  function toggle() {
    ensureBuilt();
    if (panelEl.classList.contains("markup-sidebar-open")) close();
    else open();
  }
  function isOpen() {
    return panelEl && panelEl.classList.contains("markup-sidebar-open");
  }
  function pendingCount() {
    return state.pending.length;
  }
  function detachedCount() {
    // Back-compat with overlay.js, which uses this for its toolbar button.
    return state.pending.length;
  }

  return {
    setReview: setReview,
    // back-compat: forward to setReview as detached-only bucket
    setDetached: function (items, h) {
      setReview({ pending: items, open: [], accepted: [] }, h);
    },
    open: open,
    close: close,
    toggle: toggle,
    isOpen: isOpen,
    detachedCount: detachedCount,
    pendingCount: pendingCount,
    focusNext: focusNext,
    focusPrev: focusPrev,
    openReply: openReply,
    hasActiveComposer: hasActiveComposer,
    closeActiveComposer: closeActiveComposer,
    setVisibilityListener: setVisibilityListener,
  };
})();
