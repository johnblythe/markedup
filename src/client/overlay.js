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

  function buildToolbar() {
    var toolbar = document.createElement("div");
    toolbar.id = "markup-toolbar";

    var title = document.createElement("div");
    title.className = "markup-toolbar-title";
    title.textContent = "Markup";
    toolbar.appendChild(title);

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
        title: "Write feedback bundle next to source + copy saved path (press D)",
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

    function updateCount() {
      var list = Persist.loadAnnotations(sourceKey);
      countEl.textContent = list.length + (list.length === 1 ? " annotation" : " annotations");
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
    });
    function updateSidebarBtn() {
      var n = Sidebar.pendingCount ? Sidebar.pendingCount() : Sidebar.detachedCount();
      sidebarBtn.textContent = n > 0 ? "Review (" + n + ")" : "Review";
      sidebarBtn.classList.toggle("markup-detached-has", n > 0);
    }
    window.__MARKUP_UPDATE_SIDEBAR_COUNT__ = updateSidebarBtn;
    updateSidebarBtn();

    toolbar.querySelector('[data-action="clear"]').addEventListener("click", function () {
      if (!confirm("Delete all annotations for this artifact?")) return;
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
