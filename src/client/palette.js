// Command palette: search-and-run surface for every doc-level action.
// Renders a scrim + modal lazily into document.body on first open, then
// reuses that DOM on every later open. Rows are grouped (first-seen group
// order), filtered by case-insensitive label substring as the user types,
// and navigable with ArrowUp/ArrowDown + Enter. Callers own the command
// list and what running one does; this module only presents and dispatches.

var Palette = (function () {
  var built = false;
  var scrimEl = null;
  var modalEl = null;
  var inputEl = null;
  var listEl = null;
  var emptyEl = null;

  var rows = []; // [{ cmd, el, groupKey, groupHeaderEl }]
  var activeRow = null;
  var isOpenFlag = false;
  var previousFocus = null;
  var onCloseCb = null;

  function visibleRows() {
    return rows.filter(function (row) {
      return !row.el.hidden;
    });
  }

  function setActive(row) {
    rows.forEach(function (r) {
      r.el.classList.remove("is-active");
    });
    activeRow = row || null;
    if (activeRow) {
      activeRow.el.classList.add("is-active");
      if (activeRow.el.scrollIntoView) {
        activeRow.el.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function setActiveToFirstVisible() {
    var vis = visibleRows();
    setActive(vis.length ? vis[0] : null);
  }

  function moveActive(delta) {
    var vis = visibleRows();
    if (!vis.length) {
      setActive(null);
      return;
    }
    var idx = activeRow ? vis.indexOf(activeRow) : -1;
    if (idx === -1) {
      idx = delta > 0 ? 0 : vis.length - 1;
    } else {
      idx = (idx + delta + vis.length) % vis.length;
    }
    setActive(vis[idx]);
  }

  function runRow(cmd) {
    close();
    if (cmd && typeof cmd.run === "function") cmd.run();
  }

  function runActive() {
    if (activeRow) runRow(activeRow.cmd);
  }

  // Groups by first-seen order of cmd.group, independent of how the
  // caller interleaves commands from different groups in the input array.
  function buildRows(commands) {
    listEl.textContent = "";
    rows = [];
    activeRow = null;

    var groups = [];
    var byKey = {};
    (commands || []).forEach(function (cmd) {
      var key = (cmd && cmd.group) || "";
      var g = byKey[key];
      if (!g) {
        g = { key: key, headerEl: null, cmds: [] };
        byKey[key] = g;
        groups.push(g);
      }
      g.cmds.push(cmd);
    });

    groups.forEach(function (g) {
      if (g.key) {
        g.headerEl = document.createElement("div");
        g.headerEl.className = "markup-palette-group";
        g.headerEl.textContent = g.key;
        listEl.appendChild(g.headerEl);
      }

      g.cmds.forEach(function (cmd) {
        var rowEl = document.createElement("div");
        rowEl.className = "markup-palette-cmd";
        rowEl.setAttribute("role", "option");
        if (cmd.variant === "primary") rowEl.classList.add("markup-palette-primary");
        if (cmd.variant === "danger") rowEl.classList.add("markup-palette-danger");

        if (cmd.icon) {
          var iconEl = document.createElement("span");
          iconEl.className = "markup-palette-cmd-icon";
          iconEl.textContent = cmd.icon;
          rowEl.appendChild(iconEl);
        }

        var labelEl = document.createElement("span");
        labelEl.className = "markup-palette-cmd-label";
        labelEl.textContent = cmd.label || "";
        rowEl.appendChild(labelEl);

        if (cmd.hint) {
          var hintEl = document.createElement("kbd");
          hintEl.className = "markup-palette-cmd-hint";
          hintEl.textContent = cmd.hint;
          rowEl.appendChild(hintEl);
        }

        var row = { cmd: cmd, el: rowEl, groupKey: g.key, groupHeaderEl: g.headerEl };
        rows.push(row);

        rowEl.addEventListener("click", function () {
          runRow(cmd);
        });
        rowEl.addEventListener("mouseenter", function () {
          setActive(row);
        });

        listEl.appendChild(rowEl);
      });
    });
  }

  function applyFilter(query) {
    var q = String(query || "").toLowerCase();
    var anyVisible = false;
    var groupVisible = {};

    rows.forEach(function (row) {
      var label = String((row.cmd && row.cmd.label) || "").toLowerCase();
      var match = !q || label.indexOf(q) !== -1;
      row.el.hidden = !match;
      if (match) {
        anyVisible = true;
        groupVisible[row.groupKey] = true;
      }
    });

    rows.forEach(function (row) {
      if (row.groupHeaderEl) {
        row.groupHeaderEl.hidden = !groupVisible[row.groupKey];
      }
    });

    emptyEl.hidden = anyVisible;
    setActiveToFirstVisible();
  }

  function ensureBuilt() {
    if (built) return;
    built = true;

    scrimEl = document.createElement("div");
    scrimEl.id = "markup-palette-scrim";
    scrimEl.className = "markup-palette-scrim";
    scrimEl.hidden = true;
    scrimEl.addEventListener("click", function () {
      close();
    });

    modalEl = document.createElement("div");
    modalEl.id = "markup-palette";
    modalEl.className = "markup-palette";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-label", "Commands");
    modalEl.hidden = true;

    var searchRow = document.createElement("div");
    searchRow.className = "markup-palette-search";

    inputEl = document.createElement("input");
    inputEl.className = "markup-palette-input";
    inputEl.type = "text";
    inputEl.setAttribute("placeholder", "Type a command…");
    inputEl.setAttribute("autocomplete", "off");
    inputEl.setAttribute("spellcheck", "false");
    inputEl.addEventListener("input", function () {
      applyFilter(inputEl.value);
    });
    searchRow.appendChild(inputEl);
    modalEl.appendChild(searchRow);

    listEl = document.createElement("div");
    listEl.className = "markup-palette-list";
    modalEl.appendChild(listEl);

    emptyEl = document.createElement("p");
    emptyEl.className = "markup-palette-empty";
    emptyEl.textContent = "No command matches that.";
    emptyEl.hidden = true;
    modalEl.appendChild(emptyEl);

    document.body.appendChild(scrimEl);
    document.body.appendChild(modalEl);

    // Capture phase + explicit consume on Escape: the palette owns these
    // keys while it's open, ahead of any other document-level handler.
    document.addEventListener(
      "keydown",
      function (e) {
        if (!isOpenFlag) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveActive(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveActive(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          runActive();
        }
      },
      true,
    );
  }

  function open(opts) {
    opts = opts || {};
    ensureBuilt();

    if (!isOpenFlag) {
      previousFocus = document.activeElement;
    }
    isOpenFlag = true;
    onCloseCb = typeof opts.onClose === "function" ? opts.onClose : null;

    buildRows(opts.commands);
    inputEl.value = "";
    applyFilter("");

    scrimEl.hidden = false;
    modalEl.hidden = false;

    setTimeout(function () {
      if (isOpenFlag) inputEl.focus();
    }, 0);
  }

  function close() {
    if (!built || !isOpenFlag) return;
    isOpenFlag = false;

    scrimEl.hidden = true;
    modalEl.hidden = true;

    var toFocus = previousFocus;
    previousFocus = null;
    var cb = onCloseCb;
    onCloseCb = null;

    if (toFocus && typeof toFocus.focus === "function" && document.contains(toFocus)) {
      toFocus.focus();
    }
    if (cb) cb();
  }

  function isOpen() {
    return isOpenFlag;
  }

  return { open: open, close: close, isOpen: isOpen };
})();

// The bundle wraps every module in one IIFE, so `var Palette` above is not a
// global. overlay.js feature-detects `window.Palette` (it's built as a separate
// module and must degrade gracefully if absent), so publish it explicitly.
if (typeof window !== "undefined") window.Palette = Palette;
