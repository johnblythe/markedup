// Bootstraps the annotation UI on page load.
// Sets up the toolbar strip (mode segments, export expander, review drawer,
// ⌘K palette affordance), wires modes, and hydrates persisted annotations.

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

    // Who else is looking at this doc; filled by the presence poll.
    var presenceEl = document.createElement("div");
    presenceEl.className = "markup-badge-presence";
    presenceEl.setAttribute("data-badge-presence", "");
    presenceEl.style.display = "none";
    badge.appendChild(presenceEl);

    badge.appendChild(buildBadgePanel(remote));
    return badge;
  }

  function presenceLabel(viewer) {
    var name = String(viewer.email || "?").split("@")[0];
    name = name.charAt(0).toUpperCase() + name.slice(1);
    var t = Date.parse(viewer.at);
    if (!isFinite(t)) return name;
    var s = (Date.now() - t) / 1000;
    if (s < 30) return name + " · viewing";
    if (s < 3600) return name + " · " + Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return name + " · " + Math.round(s / 3600) + "h ago";
    return name + " · " + Math.round(s / 86400) + "d ago";
  }

  function renderPresence(viewers) {
    var el = document.querySelector("[data-badge-presence]");
    if (!el) return;
    if (!viewers || viewers.length === 0) {
      el.style.display = "none";
      return;
    }
    var shown = viewers.slice(0, 2).map(presenceLabel);
    if (viewers.length > 2) shown.push("+" + (viewers.length - 2) + " more");
    el.textContent = shown.join("  ·  ");
    el.setAttribute(
      "title",
      viewers
        .map(function (v) {
          return v.email;
        })
        .join(", "),
    );
    el.style.display = "";
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
      document.createTextNode(
        "To hand this review to an agent: press “Copy for your agent”, or run ",
      ),
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

  // The strip: one compact row under the badge (or title, in solo mode) --
  // a 3-segment mode control, an export expander, the review drawer button,
  // and a small ⌘K affordance. No overflow menu; every export path lives
  // behind the export icon, and Clear all lives only in the palette.
  function buildToolbar() {
    var toolbar = document.createElement("div");
    toolbar.id = "markup-toolbar";

    if (Persist.isRemote()) {
      toolbar.appendChild(buildBadge());
    } else {
      var title = document.createElement("div");
      title.className = "markup-toolbar-title";
      title.textContent = "Markup";
      toolbar.appendChild(title);
    }

    var row = document.createElement("div");
    row.className = "markup-strip-row";

    var segments = document.createElement("div");
    segments.className = "markup-strip-segments";
    segments.appendChild(
      makeButton({ text: "Text", title: "Highlight text (T)", mode: "span", className: "markup-strip-seg" }),
    );
    segments.appendChild(
      makeButton({ text: "Pin", title: "Pin an element (P)", mode: "pin", className: "markup-strip-seg" }),
    );
    segments.appendChild(
      makeButton({
        text: "Rect",
        title: "Draw a rectangle (R, or shift-drag anywhere)",
        mode: "rect",
        className: "markup-strip-seg",
      }),
    );
    row.appendChild(segments);

    // Export: one icon expands to every export path.
    var exportWrap = document.createElement("div");
    exportWrap.className = "markup-strip-export markup-toolbar-row-anchor";
    exportWrap.appendChild(
      makeButton({
        text: "⤓",
        title: "Export this review",
        action: "export-more",
        className: "markup-strip-icon-btn",
      }),
    );
    var exportMenu = document.createElement("div");
    exportMenu.className = "markup-export-menu";
    exportMenu.setAttribute("data-export-menu", "");
    var copyItem = document.createElement("button");
    copyItem.setAttribute("data-action", "export-clip");
    copyItem.textContent = "Copy for your agent · C";
    copyItem.setAttribute("title", "Copy every note in this review as markdown, then paste it to your agent");
    exportMenu.appendChild(copyItem);
    var diskItem = document.createElement("button");
    diskItem.setAttribute("data-action", "export-disk");
    diskItem.textContent = "Download .md · D";
    diskItem.setAttribute(
      "title",
      Persist.isRemote()
        ? "Download this review as one markdown file (screenshots inlined)"
        : "Write the feedback bundle next to the source file",
    );
    exportMenu.appendChild(diskItem);
    if (Persist.isRemote()) {
      var pullItem = document.createElement("button");
      pullItem.setAttribute("data-action", "copy-pull");
      pullItem.textContent = "Copy `markup pull` command";
      pullItem.setAttribute(
        "title",
        "Copies a terminal command that writes the full bundle with separate PNG files",
      );
      exportMenu.appendChild(pullItem);
    }
    exportWrap.appendChild(exportMenu);
    row.appendChild(exportWrap);

    // Drawer: opens/closes the review panel; the pill mirrors the count the
    // old "Review (N)" text carried.
    var drawerBtn = document.createElement("button");
    drawerBtn.className = "markup-strip-icon-btn markup-strip-drawer-btn";
    drawerBtn.setAttribute("data-action", "sidebar");
    drawerBtn.setAttribute("title", "Show/hide the review drawer ([ open, ] close)");
    var drawerLabel = document.createElement("span");
    drawerLabel.className = "markup-strip-drawer-label";
    drawerLabel.textContent = "Review";
    drawerBtn.appendChild(drawerLabel);
    var drawerCount = document.createElement("span");
    drawerCount.className = "markup-strip-drawer-count";
    drawerCount.setAttribute("data-drawer-count", "");
    drawerCount.style.display = "none";
    drawerBtn.appendChild(drawerCount);
    row.appendChild(drawerBtn);

    row.appendChild(
      makeButton({
        text: "⌘K",
        title: "Open the command palette (⌘K)",
        action: "open-palette",
        className: "markup-strip-icon-btn markup-strip-palette-btn",
      }),
    );

    toolbar.appendChild(row);

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
    var drawerBtn = toolbar.querySelector('[data-action="sidebar"]');
    var drawerCountEl = drawerBtn.querySelector("[data-drawer-count]");

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

    drawerBtn.addEventListener("click", function () {
      Sidebar.toggle();
      // Opening the review panel is "looking at" the notes — clear the badge's
      // "N new" so it only ever flags genuinely-unseen arrivals.
      if (Persist.isRemote() && Sidebar.isOpen()) {
        Persist.markSeen();
        updateCount();
      }
    });

    // Floating popups (badge ? panel, export menu, palette, popover) are
    // mutually exclusive: opening one closes the others, so the bottom-right
    // never stacks more than one floating surface.
    var badgePanel = toolbar.querySelector(".markup-badge-panel");
    function closeFloatingPopups() {
      if (badgePanel) badgePanel.classList.remove("markup-badge-panel-open");
      var menu = toolbar.querySelector("[data-export-menu]");
      if (menu) menu.classList.remove("markup-export-menu-open");
    }
    function anyFloatingPopupOpen() {
      var menu = toolbar.querySelector("[data-export-menu]");
      return (
        (badgePanel && badgePanel.classList.contains("markup-badge-panel-open")) ||
        (menu && menu.classList.contains("markup-export-menu-open"))
      );
    }
    function closePaletteIfOpen() {
      if (window.Palette && window.Palette.isOpen && window.Palette.isOpen()) {
        window.Palette.close();
      }
    }
    var origPopoverShow = Popover.show;
    Popover.show = function (opts) {
      closeFloatingPopups();
      closePaletteIfOpen();
      return origPopoverShow(opts);
    };

    // Shared-canvas badge: toggle the help panel; both the label and the "?"
    // open it, the "×" closes it.
    if (badgePanel) {
      toolbar.querySelectorAll('[data-action="badge-toggle"]').forEach(function (el) {
        el.addEventListener("click", function () {
          var willOpen = !badgePanel.classList.contains("markup-badge-panel-open");
          closeFloatingPopups();
          closePaletteIfOpen();
          if (Popover.isVisible()) Popover.hide();
          if (willOpen) badgePanel.classList.add("markup-badge-panel-open");
        });
      });
      toolbar
        .querySelector('[data-action="badge-close"]')
        .addEventListener("click", function () {
          badgePanel.classList.remove("markup-badge-panel-open");
        });
    }

    // Dock the strip into the drawer while it's open — one column, no
    // floating box overlapping it. Closing the drawer restores the float.
    Sidebar.setVisibilityListener(function (openNow) {
      closeFloatingPopups();
      if (openNow) {
        var dockEl = document.querySelector("#markup-sidebar .markup-sidebar-dock");
        if (dockEl) {
          dockEl.appendChild(toolbar);
          toolbar.classList.add("markup-toolbar-docked");
        }
      } else if (toolbar.classList.contains("markup-toolbar-docked")) {
        toolbar.classList.remove("markup-toolbar-docked");
        document.body.appendChild(toolbar);
      }
    });
    function updateDrawerButton() {
      var n = Sidebar.pendingCount ? Sidebar.pendingCount() : Sidebar.detachedCount();
      if (n > 0) {
        drawerCountEl.textContent = String(n);
        drawerCountEl.style.display = "";
      } else {
        drawerCountEl.style.display = "none";
      }
      drawerBtn.classList.toggle("markup-detached-has", n > 0);
    }
    window.__MARKUP_UPDATE_SIDEBAR_COUNT__ = updateDrawerButton;
    updateDrawerButton();

    function clearAllAnnotations() {
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
    }

    window.__MARKUP_UPDATE_COUNT__ = updateCount;

    function copyPullCommand() {
      var cmd = "markup pull " + window.location.origin + window.location.pathname;
      navigator.clipboard.writeText(cmd).then(
        function () {
          Toast.show("Command copied — run it in a terminal to get the full bundle", 3500);
        },
        function () {
          Toast.show(cmd, 6000);
        },
      );
    }

    // Export menu: the "⤓" icon toggles it; picking an item (or clicking
    // anywhere else) closes it.
    var moreBtn = toolbar.querySelector('[data-action="export-more"]');
    var exportMenu = toolbar.querySelector("[data-export-menu]");
    if (moreBtn && exportMenu) {
      moreBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var willOpen = !exportMenu.classList.contains("markup-export-menu-open");
        closeFloatingPopups();
        closePaletteIfOpen();
        if (Popover.isVisible()) Popover.hide();
        if (willOpen) exportMenu.classList.add("markup-export-menu-open");
      });
      document.addEventListener("click", function () {
        exportMenu.classList.remove("markup-export-menu-open");
      });
      var pullBtn = toolbar.querySelector('[data-action="copy-pull"]');
      if (pullBtn) {
        pullBtn.addEventListener("click", copyPullCommand);
      }
    }

    // The badge's "N new" pill starts a guided pass: open the drawer and jump
    // to the first unseen note; each further click advances to the next.
    function reviewOpened() {
      if (Persist.isRemote() && Sidebar.isOpen()) {
        Persist.markSeen();
        updateCount();
      }
    }
    if (badgeNew) {
      badgeNew.addEventListener("click", function (e) {
        e.stopPropagation();
        Sidebar.open();
        Sidebar.focusNext();
        reviewOpened();
      });
    }

    // Escape closes the topmost surface: an open popover cancels first, then
    // an active re-attach, then a reply composer, then the command palette,
    // then a floating popup (badge panel / export menu), then the drawer.
    // Capture phase so this check runs before their bubble-phase handlers
    // could flip the state it reads.
    document.addEventListener(
      "keydown",
      function (e) {
        if (e.key !== "Escape") return;
        if (Popover.isVisible()) return;
        if (Modes.isReattaching && Modes.isReattaching()) return;
        if (Sidebar.hasActiveComposer && Sidebar.hasActiveComposer()) {
          // Inside the textarea its own handler closes it; from anywhere
          // else, close it here — Esc always dismisses one surface.
          if (!(e.target && e.target.tagName === "TEXTAREA")) {
            e.preventDefault();
            Sidebar.closeActiveComposer();
          }
          return;
        }
        if (window.Palette && window.Palette.isOpen && window.Palette.isOpen()) {
          e.preventDefault();
          window.Palette.close();
          return;
        }
        if (anyFloatingPopupOpen()) {
          e.preventDefault();
          closeFloatingPopups();
          return;
        }
        if (Sidebar.isOpen()) {
          e.preventDefault();
          Sidebar.close();
        }
      },
      true,
    );

    // Clicking outside the open drawer closes it — but never while you're
    // placing an annotation (an active mode means a doc click is a new mark),
    // and never when the click lands on the drawer, a popover, or the toolbar
    // (which docks into the drawer while it's open).
    document.addEventListener("pointerdown", function (e) {
      if (!Sidebar.isOpen()) return;
      if (Modes.getActive && Modes.getActive()) return;
      if (Popover.isVisible && Popover.isVisible()) return;
      var t = e.target;
      if (
        t &&
        t.closest &&
        (t.closest("#markup-sidebar") ||
          t.closest(".markup-popover") ||
          t.closest("#markup-toolbar"))
      ) {
        return;
      }
      Sidebar.close();
    });

    // j/k walks the review, next/previous note, wherever you are on the page.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (Popover.isVisible()) return;
      e.preventDefault();
      if (e.key === "j") Sidebar.focusNext();
      else Sidebar.focusPrev();
      reviewOpened();
    });

    // ---- Command palette ---------------------------------------------------
    // Feature-detected against window.Palette (owned by a separate module) so
    // this strip works standalone before that module lands: with no Palette,
    // ⌘K and the strip's ⌘K button are simply no-ops.

    function buildPaletteCommands() {
      var commands = [
        {
          id: "mode-text",
          group: "Modes",
          label: "Text",
          icon: "Aa",
          hint: "T",
          run: function () {
            setActiveMode(Modes.getActive() === "span" ? null : "span");
          },
        },
        {
          id: "mode-pin",
          group: "Modes",
          label: "Pin",
          icon: "⌖",
          hint: "P",
          run: function () {
            setActiveMode(Modes.getActive() === "pin" ? null : "pin");
          },
        },
        {
          id: "mode-rect",
          group: "Modes",
          label: "Rect",
          icon: "▭",
          hint: "R",
          run: function () {
            setActiveMode(Modes.getActive() === "rect" ? null : "rect");
          },
        },
        {
          id: "review-drawer",
          group: "Review & export",
          label: "Review drawer",
          icon: "▤",
          hint: "[",
          run: function () {
            Sidebar.open();
            reviewOpened();
          },
        },
        {
          id: "export-copy",
          group: "Review & export",
          label: "Copy for your agent",
          icon: "⎘",
          hint: "C",
          run: function () {
            ExportClient.exportToClipboard(sourceKey);
          },
        },
        {
          id: "export-download",
          group: "Review & export",
          label: "Download .md",
          icon: "⤓",
          hint: "D",
          run: function () {
            ExportClient.exportToDisk(sourceKey);
          },
        },
      ];
      if (Persist.isRemote()) {
        commands.push({
          id: "export-pull",
          group: "Review & export",
          label: "Copy `markup pull` command",
          icon: "❯",
          run: copyPullCommand,
        });
      }
      commands.push({
        id: "clear-all",
        group: "Danger",
        label: "Clear all",
        icon: "⌫",
        variant: "danger",
        run: clearAllAnnotations,
      });
      return commands;
    }

    function openPalette() {
      if (!window.Palette) return;
      closeFloatingPopups();
      if (Popover.isVisible()) Popover.hide();
      window.Palette.open({ commands: buildPaletteCommands(), onClose: function () {} });
    }

    function togglePalette() {
      if (window.Palette && window.Palette.isOpen && window.Palette.isOpen()) {
        window.Palette.close();
      } else {
        openPalette();
      }
    }

    toolbar.querySelector('[data-action="open-palette"]').addEventListener("click", togglePalette);

    document.addEventListener("keydown", function (e) {
      var key = e.key ? e.key.toLowerCase() : "";
      if (key !== "k" || !(e.metaKey || e.ctrlKey)) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      togglePalette();
    });

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
        case "[":
          // Open the review drawer. Opening it is "looking at" the notes, so
          // clear the "N new" badge the same way the toggle button does.
          e.preventDefault();
          Sidebar.open();
          if (Persist.isRemote() && Sidebar.isOpen()) {
            Persist.markSeen();
            if (typeof window.__MARKUP_UPDATE_COUNT__ === "function") {
              window.__MARKUP_UPDATE_COUNT__();
            }
          }
          break;
        case "]":
          e.preventDefault();
          Sidebar.close();
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
          onPresence: renderPresence,
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
