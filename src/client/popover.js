// Shared popover element for annotation note entry.
// One DOM node, reused across all annotations.

var Popover = (function () {
  var el = null;
  var textarea = null;
  var viewEl = null;
  var noteEl = null;
  var metaEl = null;
  var btnRow = null;
  var spacerEl = null;
  var saveBtn = null;
  var cancelBtn = null;
  var deleteBtn = null;
  var acceptBtn = null;
  var replyBtn = null;
  var currentHandlers = null;

  function relTime(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return new Date(t).toLocaleDateString();
  }

  function ensureBuilt() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "markup-popover";

    textarea = document.createElement("textarea");
    textarea.setAttribute("placeholder", "Leave a note...");
    el.appendChild(textarea);

    // Read-only view for another reviewer's note: their words aren't yours
    // to edit, so the popover shows them with attribution instead of a form.
    viewEl = document.createElement("div");
    viewEl.className = "markup-popover-view";
    viewEl.style.display = "none";
    metaEl = document.createElement("div");
    metaEl.className = "markup-popover-meta";
    viewEl.appendChild(metaEl);
    noteEl = document.createElement("div");
    noteEl.className = "markup-popover-note";
    viewEl.appendChild(noteEl);
    el.appendChild(viewEl);

    btnRow = document.createElement("div");
    btnRow.className = "markup-popover-buttons";

    // Destructive action isolated far left; a flexible spacer pushes the
    // action group (Resolve · Cancel · Save, or Resolve … Close · Reply) to
    // the right edge so the primary is always the rightmost button.
    deleteBtn = document.createElement("button");
    deleteBtn.className = "markup-popover-delete markup-popover-danger";
    deleteBtn.style.display = "none";
    deleteBtn.textContent = "Remove";
    btnRow.appendChild(deleteBtn);

    spacerEl = document.createElement("span");
    spacerEl.className = "markup-popover-spacer";
    btnRow.appendChild(spacerEl);

    acceptBtn = document.createElement("button");
    acceptBtn.className = "markup-popover-accept";
    acceptBtn.style.display = "none";
    acceptBtn.textContent = "Resolve";
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

    replyBtn = document.createElement("button");
    replyBtn.className = "markup-popover-reply markup-popover-primary";
    replyBtn.style.display = "none";
    replyBtn.textContent = "Reply";
    btnRow.appendChild(replyBtn);

    el.appendChild(btnRow);

    acceptBtn.addEventListener("click", function () {
      if (currentHandlers && currentHandlers.onAccept) {
        currentHandlers.onAccept();
      }
      hide();
    });
    replyBtn.addEventListener("click", function () {
      var onReply = currentHandlers && currentHandlers.onReply;
      hide();
      if (onReply) onReply();
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

  // opts.readOnly renders another reviewer's note: text + attribution, no
  // editing — the actions offered are exactly the ones that work (Resolve,
  // Reply). Own notes get the full editor.
  function show(opts) {
    ensureBuilt();
    currentHandlers = {
      onSave: opts.onSave,
      onCancel: opts.onCancel,
      onDelete: opts.onDelete,
      onAccept: opts.onAccept,
      onReply: opts.onReply,
    };

    var readOnly = opts.readOnly === true;
    textarea.style.display = readOnly ? "none" : "";
    viewEl.style.display = readOnly ? "" : "none";
    saveBtn.style.display = readOnly ? "none" : "inline-block";
    replyBtn.style.display = readOnly && opts.onReply ? "inline-block" : "none";
    deleteBtn.style.display = !readOnly && opts.canDelete ? "inline-block" : "none";
    acceptBtn.style.display = opts.canAccept ? "inline-block" : "none";
    cancelBtn.textContent = readOnly ? "Close" : "Cancel";

    if (readOnly) {
      noteEl.textContent = opts.initialText || "(no note)";
      var who = String(opts.author || "").split("@")[0];
      metaEl.textContent = who + (opts.createdAt ? " · " + relTime(opts.createdAt) : "");
      metaEl.setAttribute("title", opts.author || "");
      // Resolve reads as this note's status action: left slot, before the spacer.
      btnRow.insertBefore(acceptBtn, spacerEl);
    } else {
      textarea.value = opts.initialText || "";
      // Resolve joins the right-edge action group, never splitting Cancel/Save.
      btnRow.insertBefore(acceptBtn, cancelBtn);
    }

    el.classList.add("markup-popover-visible");
    positionAt(opts.anchorRect);
    setTimeout(function () {
      if (readOnly) {
        (opts.onReply ? replyBtn : cancelBtn).focus();
        return;
      }
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
