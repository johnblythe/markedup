// Shared popover element for annotation note entry.
// One DOM node, reused across all annotations.

var Popover = (function () {
  var el = null;
  var textarea = null;
  var saveBtn = null;
  var cancelBtn = null;
  var deleteBtn = null;
  var currentHandlers = null;

  function ensureBuilt() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "markup-popover";

    textarea = document.createElement("textarea");
    textarea.setAttribute("placeholder", "Leave a note...");
    el.appendChild(textarea);

    var btnRow = document.createElement("div");
    btnRow.className = "markup-popover-buttons";

    deleteBtn = document.createElement("button");
    deleteBtn.className = "markup-popover-delete markup-popover-danger";
    deleteBtn.style.display = "none";
    deleteBtn.textContent = "Remove";
    btnRow.appendChild(deleteBtn);

    var acceptBtn = document.createElement("button");
    acceptBtn.className = "markup-popover-accept";
    acceptBtn.style.display = "none";
    acceptBtn.textContent = "Accept";
    btnRow.appendChild(acceptBtn);
    el._acceptBtn = acceptBtn;

    cancelBtn = document.createElement("button");
    cancelBtn.className = "markup-popover-cancel";
    cancelBtn.textContent = "Cancel";
    btnRow.appendChild(cancelBtn);

    saveBtn = document.createElement("button");
    saveBtn.className = "markup-popover-save markup-popover-primary";
    saveBtn.textContent = "Save";
    btnRow.appendChild(saveBtn);

    el.appendChild(btnRow);

    acceptBtn.addEventListener("click", function () {
      if (currentHandlers && currentHandlers.onAccept) {
        currentHandlers.onAccept();
      }
      hide();
    });
    document.body.appendChild(el);

    saveBtn.addEventListener("click", function () {
      if (currentHandlers && currentHandlers.onSave) {
        currentHandlers.onSave(textarea.value);
      }
      hide();
    });
    textarea.addEventListener("keydown", function (e) {
      // Cmd+Enter (mac) or Ctrl+Enter saves and closes.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (currentHandlers && currentHandlers.onSave) {
          currentHandlers.onSave(textarea.value);
        }
        hide();
      }
    });
    cancelBtn.addEventListener("click", function () {
      if (currentHandlers && currentHandlers.onCancel) currentHandlers.onCancel();
      hide();
    });
    deleteBtn.addEventListener("click", function () {
      if (currentHandlers && currentHandlers.onDelete) currentHandlers.onDelete();
      hide();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el.classList.contains("markup-popover-visible")) {
        if (currentHandlers && currentHandlers.onCancel) currentHandlers.onCancel();
        hide();
      }
    });
    // Click outside the popover dismisses (treated as Cancel).
    document.addEventListener(
      "mousedown",
      function (e) {
        if (!el.classList.contains("markup-popover-visible")) return;
        var t = e.target;
        // Don't dismiss if clicking inside the popover itself.
        if (el.contains(t)) return;
        // Don't dismiss when interacting with the toolbar (toolbar buttons may open new popovers).
        var toolbar = document.getElementById("markup-toolbar");
        if (toolbar && toolbar.contains(t)) return;
        if (currentHandlers && currentHandlers.onCancel) currentHandlers.onCancel();
        hide();
      },
      true,
    );
    return el;
  }

  // Position above anchorRect (in viewport coords). Falls back to below if no room above.
  // Caller must add `.markup-popover-visible` before calling — that class controls display.
  function positionAt(anchorRect) {
    var scrollX = window.scrollX || window.pageXOffset || 0;
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var vw = document.documentElement.clientWidth;
    var pad = 8;
    var pw = 280;
    var ph = 140;
    var rect = el.getBoundingClientRect();
    pw = rect.width || pw;
    ph = rect.height || ph;

    var left = anchorRect.left + scrollX;
    if (left + pw > scrollX + vw - pad) left = scrollX + vw - pw - pad;
    if (left < scrollX + pad) left = scrollX + pad;

    var top = anchorRect.top + scrollY - ph - 8;
    if (top < scrollY + pad) {
      top = anchorRect.bottom + scrollY + 8;
    }
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
  }

  function show(opts) {
    ensureBuilt();
    currentHandlers = {
      onSave: opts.onSave,
      onCancel: opts.onCancel,
      onDelete: opts.onDelete,
      onAccept: opts.onAccept,
    };
    textarea.value = opts.initialText || "";
    deleteBtn.style.display = opts.canDelete ? "inline-block" : "none";
    el._acceptBtn.style.display = opts.canAccept ? "inline-block" : "none";
    el.classList.add("markup-popover-visible");
    positionAt(opts.anchorRect);
    setTimeout(function () {
      textarea.focus();
      var len = textarea.value.length;
      textarea.setSelectionRange(len, len);
    }, 0);
  }

  function hide() {
    if (!el) return;
    el.classList.remove("markup-popover-visible");
    // Defense-in-depth: clear any inline display override (older builds set this).
    el.style.display = "";
    currentHandlers = null;
  }

  function isVisible() {
    return el && el.classList.contains("markup-popover-visible");
  }

  return { show: show, hide: hide, isVisible: isVisible };
})();
