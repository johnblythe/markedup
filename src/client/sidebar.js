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

  function ensureBuilt() {
    if (panelEl) return panelEl;

    panelEl = document.createElement("aside");
    panelEl.id = "markup-sidebar";

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

  function modeBadge(mode) {
    var span = document.createElement("span");
    span.className = "markup-sidebar-mode markup-sidebar-mode-" + mode;
    span.textContent =
      mode === "span"
        ? "TEXT"
        : mode === "highlight"
          ? "HIGHLIGHT"
          : mode === "strike"
            ? "STRIKE"
            : mode === "pin"
              ? "PIN"
              : "RECT";
    return span;
  }

  function statusBadge(status, carryReason) {
    var span = document.createElement("span");
    span.className = "markup-sidebar-status markup-sidebar-status-" + status;
    var label = status.toUpperCase();
    if (status === "pending" && carryReason === "source-changed") label = "FROM V-1";
    else if (status === "pending" && carryReason === "anchor-lost") label = "DETACHED";
    span.textContent = label;
    return span;
  }

  function makeBtn(text, cls, fn) {
    var b = document.createElement("button");
    b.className = "markup-sidebar-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", fn);
    return b;
  }

  function buildEntry(anno, status) {
    var entry = document.createElement("div");
    entry.className = "markup-sidebar-entry markup-sidebar-entry-" + status;
    entry.setAttribute("data-anno-id", anno.id);

    var top = document.createElement("div");
    top.className = "markup-sidebar-entry-top";
    top.appendChild(modeBadge(anno.mode));
    top.appendChild(statusBadge(status, anno.carryReason));
    if (anno.mode === "pin" && anno.pinNum) {
      var n = document.createElement("span");
      n.className = "markup-sidebar-pin-num";
      n.textContent = "#" + anno.pinNum;
      top.appendChild(n);
    }
    if (anno.mode === "rect" && anno.rectNum) {
      var n2 = document.createElement("span");
      n2.className = "markup-sidebar-pin-num";
      n2.textContent = "rect-" + anno.rectNum;
      top.appendChild(n2);
    }
    var when = document.createElement("span");
    when.className = "markup-sidebar-when";
    try {
      when.textContent = new Date(anno.createdAt).toLocaleTimeString();
    } catch (_e) {
      when.textContent = "";
    }
    top.appendChild(when);
    entry.appendChild(top);

    // Shared canvas: say whose note this is, and surface any thread on it.
    if (anno.author) {
      var byline = document.createElement("div");
      byline.className = "markup-sidebar-author";
      var name = String(anno.author).split("@")[0];
      byline.textContent =
        name +
        (anno.replies && anno.replies.length
          ? " · " + anno.replies.length + " repl" + (anno.replies.length === 1 ? "y" : "ies")
          : "");
      byline.setAttribute("title", anno.author);
      entry.appendChild(byline);
    }
    if (anno.replies && anno.replies.length) {
      var thread = document.createElement("div");
      thread.className = "markup-sidebar-thread";
      anno.replies.forEach(function (r) {
        var line = document.createElement("div");
        line.className = "markup-sidebar-reply";
        line.textContent = String(r.author || "?").split("@")[0] + ": " + (r.text || "");
        thread.appendChild(line);
      });
      entry.appendChild(thread);
    }

    var note = document.createElement("div");
    note.className = "markup-sidebar-note";
    note.textContent = anno.note || "(no note)";
    entry.appendChild(note);

    var ctx = document.createElement("div");
    ctx.className = "markup-sidebar-context";
    if (anno.mode === "rect" && ((anno.payload && anno.payload.pngDataURL) || anno.shotUrl)) {
      var img = document.createElement("img");
      img.className = "markup-sidebar-thumb";
      // Local data URL when this browser took the shot; shotUrl for everyone else.
      img.src = (anno.payload && anno.payload.pngDataURL) || anno.shotUrl;
      img.alt = "rect screenshot";
      ctx.appendChild(img);
    } else {
      var anchorText =
        (anno.anchor && anno.anchor.anchorText) ||
        (anno.payload && anno.payload.anchorText) ||
        "";
      if (anchorText) {
        var quote = document.createElement("div");
        quote.className = "markup-sidebar-quote";
        quote.textContent = '"' + anchorText.slice(0, 140) + '"';
        ctx.appendChild(quote);
      }
    }
    entry.appendChild(ctx);

    var actions = document.createElement("div");
    actions.className = "markup-sidebar-actions";

    if (status === "pending") {
      actions.appendChild(
        makeBtn("Where it was", "", function () {
          if (handlers.onShowContext) handlers.onShowContext(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Re-attach", "", function () {
          if (handlers.onReattach) handlers.onReattach(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Accept", "markup-sidebar-btn-primary", function () {
          if (handlers.onAccept) handlers.onAccept(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Remove", "markup-sidebar-btn-danger", function () {
          if (!confirm("Remove this annotation? Cannot undo.")) return;
          if (handlers.onRemove) handlers.onRemove(anno);
        }),
      );
    } else if (status === "open") {
      actions.appendChild(
        makeBtn("Where it is", "", function () {
          if (handlers.onScrollToInline) handlers.onScrollToInline(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Accept", "markup-sidebar-btn-primary", function () {
          if (handlers.onAccept) handlers.onAccept(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Remove", "markup-sidebar-btn-danger", function () {
          if (!confirm("Remove this annotation? Cannot undo.")) return;
          if (handlers.onRemove) handlers.onRemove(anno);
        }),
      );
    } else if (status === "accepted") {
      actions.appendChild(
        makeBtn("Where it was", "", function () {
          if (handlers.onShowContext) handlers.onShowContext(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Re-open", "", function () {
          if (handlers.onReopen) handlers.onReopen(anno);
        }),
      );
      actions.appendChild(
        makeBtn("Remove", "markup-sidebar-btn-danger", function () {
          if (!confirm("Remove this annotation? Cannot undo.")) return;
          if (handlers.onRemove) handlers.onRemove(anno);
        }),
      );
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
            "Accept all (" + items.length + ")",
            "markup-sidebar-btn-primary",
            function () {
              if (!confirm("Accept all " + items.length + " " + status + " annotations?")) return;
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
            if (!confirm("Re-open all " + items.length + " accepted annotations?")) return;
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
          ? "No pending annotations."
          : status === "open"
          ? "No open annotations."
          : "Nothing accepted yet.";
      body.appendChild(empty);
    } else {
      items.forEach(function (a) {
        body.appendChild(buildEntry(a, status));
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

  function render() {
    ensureBuilt();
    listEl.textContent = "";
    listEl.appendChild(section("Pending", state.pending, "pending", false));
    listEl.appendChild(section("Open", state.open, "open", false));
    listEl.appendChild(section("Accepted", state.accepted, "accepted", true));

    // Top count badge = pending count (the one that actually needs action).
    headerCountEl.textContent = state.pending.length > 0 ? String(state.pending.length) : "";
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

  function open() {
    ensureBuilt();
    panelEl.classList.add("markup-sidebar-open");
  }
  function close() {
    if (!panelEl) return;
    panelEl.classList.remove("markup-sidebar-open");
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
  };
})();
