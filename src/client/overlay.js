// Bootstraps the annotation UI on page load.
// Sets up the toolbar (mode toggles + export buttons), wires modes, and
// hydrates persisted annotations.

(function () {
  if (window.__MARKUP_BOOTED__) return;
  window.__MARKUP_BOOTED__ = true;

  function makeButton(opts) {
    var b = document.createElement("button");
    if (opts.text) b.textContent = opts.text;
    if (opts.title) b.setAttribute("title", opts.title);
    if (opts.mode) b.setAttribute("data-mode", opts.mode);
    if (opts.action) b.setAttribute("data-action", opts.action);
    if (opts.className) b.className = opts.className;
    return b;
  }

  function makeRow() {
    var r = document.createElement("div");
    r.className = "markup-toolbar-row";
    return r;
  }

  // Shared-canvas badge: names the doc, carries the live "N new" count, and
  // opens a compact panel explaining the shared workflow to a reviewer.
  function buildBadge() {
    var remote = window.__MARKUP_REMOTE__ || {};
    var badge = document.createElement("div");
    badge.className = "markup-badge";

    var line = document.createElement("div");
    line.className = "markup-badge-line";

    var label = document.createElement("span");
    label.className = "markup-badge-label";
    label.textContent = "Shared canvas";
    label.setAttribute("data-action", "badge-toggle");
    line.appendChild(label);

    var newPill = document.createElement("span");
    newPill.className = "markup-badge-new";
    newPill.setAttribute("data-badge-new", "");
    newPill.style.display = "none";
    line.appendChild(newPill);

    var help = document.createElement("button");
    help.className = "markup-badge-help";
    help.setAttribute("data-action", "badge-toggle");
    help.setAttribute("title", "How the shared canvas works");
    help.textContent = "?";
    line.appendChild(help);

    badge.appendChild(line);

    var meta = document.createElement("div");
    meta.className = "markup-badge-meta";
    meta.setAttribute("data-badge-meta", "");
    meta.textContent = (remote.user || "") + " / " + (remote.project || "");
    badge.appendChild(meta);

    badge.appendChild(buildBadgePanel(remote));
    return badge;
  }

  function buildBadgePanel(remote) {
    var panel = document.createElement("div");
    panel.className = "markup-badge-panel";

    var close = document.createElement("button");
    close.className = "markup-badge-close";
    close.setAttribute("data-action", "badge-close");
    close.setAttribute("title", "Close");
    close.textContent = "×";
    panel.appendChild(close);

    function p(text) {
      var el = document.createElement("p");
      el.textContent = text;
      panel.appendChild(el);
    }

    p("Everyone who opens this URL sees the notes here, and you see theirs.");
    p("Other people's notes appear in violet with their name; yours appear in your color.");
    p("New notes from others show up on their own every few seconds.");

    var hand = document.createElement("p");
    hand.appendChild(
      document.createTextNode("To hand this review to an agent: press Clip to copy it as markdown, or run "),
    );
    var code = document.createElement("code");
    var base = "";
    try {
      base = window.location.origin + window.location.pathname;
    } catch (_e) {
      base = "<url>";
    }
    code.textContent = "markup pull " + base;
    hand.appendChild(code);
    hand.appendChild(document.createTextNode(" in a terminal for a bundle with the screenshots."));
    panel.appendChild(hand);

    var you = document.createElement("div");
    you.className = "markup-badge-you";
    you.textContent = "You: " + Persist.self();
    panel.appendChild(you);

    return panel;
  }

  function buildToolbar() {
    var toolbar = document.createElement("div");
    toolbar.id = "markup-toolbar";

    var title = document.createElement("div");
    title.className = "markup-toolbar-title";
    title.textContent = "Markup";
    toolbar.appendChild(title);

    // Shared canvas: badge with the doc name, a live "N new" count, and a
    // help panel. Solo/localStorage mode shows none of this.
    if (Persist.isRemote()) {
      toolbar.appendChild(buildBadge());
    }

    var row1 = makeRow();
    row1.appendChild(makeButton({ text: "Text · T", title: "Highlight text (press T)", mode: "span" }));
    row1.appendChild(makeButton({ text: "Pin · P", title: "Pin an element (press P)", mode: "pin" }));
    row1.appendChild(
      makeButton({
        text: "Rect · R",
        title: "Draw a rectangle (press R, or shift-drag anywhere)",
        mode: "rect",
      }),
    );
    toolbar.appendChild(row1);

    var row1b = makeRow();
    row1b.appendChild(
      makeButton({
        text: "Highlight · H",
        title: "Highlight text, no note needed (press H)",
        mode: "highlight",
      }),
    );
    row1b.appendChild(
      makeButton({
        text: "Strike · X",
        title: "Strikethrough text for removal (press X)",
        mode: "strike",
      }),
    );
    toolbar.appendChild(row1b);

    var row2 = makeRow();
    row2.appendChild(
      makeButton({
        text: "Clip · C",
        title: "Copy markdown to clipboard (press C)",
        action: "export-clip",
      }),
    );
    row2.appendChild(
      makeButton({
        text: "Disk · D",
        title: Persist.isRemote()
          ? "Download this review as markdown (press D). For a bundle with separate PNGs, run: markup pull <url>"
          : "Write feedback bundle next to source + copy saved path (press D)",
        action: "export-disk",
      }),
    );
    toolbar.appendChild(row2);

    var row3 = makeRow();
    row3.appendChild(
      makeButton({
        text: "Review",
        title: "Show/hide the review panel (Open + Pending + Accepted)",
        action: "sidebar",
      }),
    );
    row3.appendChild(
      makeButton({
        text: "Clear all",
        title: "Delete all annotations",
        action: "clear",
        className: "markup-popover-danger",
      }),
    );
    toolbar.appendChild(row3);

    var count = document.createElement("div");
    count.className = "markup-count";
    count.setAttribute("data-count", "");
    toolbar.appendChild(count);

    return toolbar;
  }

  function boot() {
    var sourceKey = window.__MARKUP_KEY__ || "unknown";
    var toolbar = buildToolbar();
    document.body.appendChild(toolbar);

    var countEl = toolbar.querySelector("[data-count]");
    var modeButtons = toolbar.querySelectorAll("button[data-mode]");
    var badgeMeta = toolbar.querySelector("[data-badge-meta]");
    var badgeNew = toolbar.querySelector("[data-badge-new]");

    function updateCount() {
      var list = Persist.loadAnnotations(sourceKey);
      var total = list.length;
      if (badgeMeta) {
        // Remote mode: the badge carries the count and the "N new" pill; the
        // plain count line would just duplicate it.
        var remote = window.__MARKUP_REMOTE__ || {};
        badgeMeta.textContent =
          (remote.user || "") +
          " / " +
          (remote.project || "") +
          " · " +
          total +
          (total === 1 ? " note" : " notes");
        var n = Persist.newCount();
        if (n > 0) {
          badgeNew.textContent = n + " new";
          badgeNew.style.display = "";
        } else {
          badgeNew.style.display = "none";
        }
        countEl.style.display = "none";
      } else {
        countEl.textContent = total + (total === 1 ? " annotation" : " annotations");
      }
    }

    function setActiveMode(mode) {
      Modes.setActive(mode);
      modeButtons.forEach(function (b) {
        b.classList.toggle("markup-mode-active", b.getAttribute("data-mode") === mode);
      });
    }

    modeButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        var current = Modes.getActive();
        var next = b.getAttribute("data-mode");
        setActiveMode(current === next ? null : next);
      });
    });

    toolbar.querySelector('[data-action="export-clip"]').addEventListener("click", function () {
      ExportClient.exportToClipboard(sourceKey);
    });
    toolbar.querySelector('[data-action="export-disk"]').addEventListener("click", function () {
      ExportClient.exportToDisk(sourceKey);
    });
    var sidebarBtn = toolbar.querySelector('[data-action="sidebar"]');
    sidebarBtn.addEventListener("click", function () {
      Sidebar.toggle();
      // Opening the review panel is "looking at" the notes — clear the badge's
      // "N new" so it only ever flags genuinely-unseen arrivals.
      if (Persist.isRemote() && Sidebar.isOpen()) {
        Persist.markSeen();
        updateCount();
      }
    });

    // Shared-canvas badge: toggle the help panel; both the label and the "?"
    // open it, the "×" closes it.
    var badgePanel = toolbar.querySelector(".markup-badge-panel");
    if (badgePanel) {
      toolbar.querySelectorAll('[data-action="badge-toggle"]').forEach(function (el) {
        el.addEventListener("click", function () {
          badgePanel.classList.toggle("markup-badge-panel-open");
        });
      });
      toolbar
        .querySelector('[data-action="badge-close"]')
        .addEventListener("click", function () {
          badgePanel.classList.remove("markup-badge-panel-open");
        });
    }
    function updateSidebarBtn() {
      var n = Sidebar.pendingCount ? Sidebar.pendingCount() : Sidebar.detachedCount();
      sidebarBtn.textContent = n > 0 ? "Review (" + n + ")" : "Review";
      sidebarBtn.classList.toggle("markup-detached-has", n > 0);
    }
    window.__MARKUP_UPDATE_SIDEBAR_COUNT__ = updateSidebarBtn;
    updateSidebarBtn();

    toolbar.querySelector('[data-action="clear"]').addEventListener("click", function () {
      var prompt = Persist.isRemote()
        ? "Delete all YOUR annotations on this artifact? (Other reviewers' notes stay.)"
        : "Delete all annotations for this artifact?";
      if (!confirm(prompt)) return;
      document.querySelectorAll(".markup-pin, .markup-rect").forEach(function (n) {
        n.remove();
      });
      document.querySelectorAll("mark.markup-span, mark.markup-highlight, mark.markup-strike").forEach(function (m) {
        var parent = m.parentNode;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize && parent.normalize();
      });
      Persist.clearAll(sourceKey);
      Modes.refresh();
      updateCount();
      Toast.show("Cleared all annotations");
    });

    window.__MARKUP_UPDATE_COUNT__ = updateCount;

    // Escape closes the review drawer, but only when nothing more specific
    // owns Escape: an open popover cancels first, then an active re-attach.
    // Capture phase so this check runs before their bubble-phase handlers
    // could flip the state it reads.
    document.addEventListener(
      "keydown",
      function (e) {
        if (e.key !== "Escape") return;
        if (Popover.isVisible()) return;
        if (Modes.isReattaching && Modes.isReattaching()) return;
        if (Sidebar.isOpen()) {
          e.preventDefault();
          Sidebar.close();
        }
      },
      true,
    );

    Modes.init(sourceKey);
    Modes.hydrate();
    updateCount();

    installKeyboardIsolation();
    installPowerKeys(setActiveMode, sourceKey);
  }

  function isTypingTarget(el) {
    if (!el) return false;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function resolveEventOrigin(e) {
    // composedPath()[0] is the true originating element even through shadow
    // DOM; e.target gets retargeted to the shadow host in that case.
    if (typeof e.composedPath === "function") {
      var path = e.composedPath();
      if (path && path.length) return path[0];
    }
    return e.target;
  }

  // Keep keystrokes typed into MarkedUp's own text-entry surfaces (popover,
  // sidebar, ...) from leaking to the host page. Without this, a host page
  // that listens for keydown on document (e.g. a slide deck advancing on
  // space) reacts to every keystroke typed into an annotation note.
  // Capture phase on window runs before the host's own (bubble-phase)
  // listeners ever see the event, so stopPropagation here keeps it from
  // reaching them. Never call preventDefault: typing, cursor movement, and
  // native shortcuts inside the text box must keep working exactly as they
  // do today.
  function installKeyboardIsolation() {
    function isolate(e) {
      var origin = resolveEventOrigin(e);
      if (isTypingTarget(origin) && Modes.isInsideMarkupUI(origin)) {
        e.stopPropagation();
      }
    }
    window.addEventListener("keydown", isolate, true);
    window.addEventListener("keyup", isolate, true);
    window.addEventListener("keypress", isolate, true);
  }

  function installPowerKeys(setActiveMode, sourceKey) {
    document.addEventListener("keydown", function (e) {
      // Ignore when typing in any input/textarea (including the popover textarea).
      if (isTypingTarget(e.target)) return;
      // Ignore modifier-laden shortcuts that aren't ours.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      var key = e.key.toLowerCase();
      switch (key) {
        case "t":
          e.preventDefault();
          setActiveMode(Modes.getActive() === "span" ? null : "span");
          break;
        case "p":
          e.preventDefault();
          setActiveMode(Modes.getActive() === "pin" ? null : "pin");
          break;
        case "r":
          e.preventDefault();
          setActiveMode(Modes.getActive() === "rect" ? null : "rect");
          break;
        case "h":
          e.preventDefault();
          setActiveMode(Modes.getActive() === "highlight" ? null : "highlight");
          break;
        case "x":
          e.preventDefault();
          setActiveMode(Modes.getActive() === "strike" ? null : "strike");
          break;
        case "c":
          e.preventDefault();
          ExportClient.exportToClipboard(sourceKey);
          break;
        case "d":
          e.preventDefault();
          ExportClient.exportToDisk(sourceKey);
          break;
        case "escape":
          // Clear active mode when no popover is open (popover Esc handled in Popover).
          if (!Popover.isVisible() && Modes.getActive()) {
            e.preventDefault();
            setActiveMode(null);
          }
          break;
      }
    });
  }

  // In remote (multiplayer) mode, identity + the shared annotation set must
  // land before the overlay renders; then a poll keeps other players' notes
  // flowing in. An open popover defers the re-render to the next tick so a
  // note being written is never clobbered.
  function start() {
    var sourceKey = window.__MARKUP_KEY__ || "unknown";
    Persist.init(sourceKey, function () {
      boot();
      Persist.startPolling(
        sourceKey,
        function () {
          Modes.refresh();
          if (typeof window.__MARKUP_UPDATE_COUNT__ === "function") {
            window.__MARKUP_UPDATE_COUNT__();
          }
        },
        {
          isPaused: function () {
            return Popover.isVisible();
          },
        },
      );
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
