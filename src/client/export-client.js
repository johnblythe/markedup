// Client-side export: builds the markdown payload and sends it to clipboard
// or POSTs to the server for disk write.

var Toast = (function () {
  var el = null;
  var hideTimer = null;
  var action = null;
  function runAction() {
    if (!action || typeof action.onClick !== "function") return;
    action.onClick();
  }
  function setAction(nextAction) {
    action = nextAction && typeof nextAction.onClick === "function" ? nextAction : null;
    if (!el) return;
    if (action) {
      el.classList.add("markup-toast-actionable");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      if (action.label) {
        el.setAttribute("aria-label", action.label);
      } else {
        el.removeAttribute("aria-label");
      }
    } else {
      el.classList.remove("markup-toast-actionable");
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      el.removeAttribute("aria-label");
    }
  }
  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "markup-toast";
    el.addEventListener("click", function () {
      runAction();
    });
    el.addEventListener("keydown", function (ev) {
      if (!action) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        runAction();
      }
    });
    document.body.appendChild(el);
    return el;
  }
  function show(msg, ms, opts) {
    ensure();
    el.textContent = msg;
    setAction(opts && opts.action);
    el.classList.add("markup-toast-visible");
    if (hideTimer) clearTimeout(hideTimer);
    if (ms !== 0) {
      hideTimer = setTimeout(hide, ms || 2200);
    }
  }
  function hide() {
    if (!el) return;
    setAction(null);
    el.classList.remove("markup-toast-visible");
  }
  return { show: show, hide: hide };
})();

var ExportClient = (function () {
  function buildStamp() {
    var d = new Date();
    var pad = function (n) {
      return n < 10 ? "0" + n : "" + n;
    };
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  function buildPayload(sourceKey, opts) {
    var list = Persist.loadAnnotations(sourceKey);
    var sourceName = window.__MARKUP_SOURCE_NAME__ || sourceKey.split("/").pop();
    var inlineImages = !!opts.inlineImages;
    var stamp = opts.stamp || buildStamp();
    var assets = [];
    var lines = [];

    lines.push("# Feedback: " + sourceName);
    lines.push("Reviewed: " + new Date().toISOString());
    lines.push("Export stamp: " + stamp);
    lines.push("");
    lines.push("Source: `" + sourceKey + "`");
    lines.push("Total annotations: " + list.length);
    lines.push("");

    var spans = list.filter(function (a) {
      return a.mode === "span";
    });
    var pins = list.filter(function (a) {
      return a.mode === "pin";
    });
    var rects = list.filter(function (a) {
      return a.mode === "rect";
    });

    if (spans.length) {
      lines.push("## Span annotations");
      spans.forEach(function (a) {
        var anchor = a.payload && a.payload.anchorText ? a.payload.anchorText : "";
        lines.push(
          '- "' + (anchor.slice(0, 80) || "") + '": ' + (a.note || "(no note)"),
        );
      });
      lines.push("");
    }

    if (pins.length) {
      lines.push("## Pin annotations");
      pins.forEach(function (a) {
        var path = a.anchor && a.anchor.cssPath ? a.anchor.cssPath : "(unknown)";
        var anchorText = a.anchor && a.anchor.anchorText ? a.anchor.anchorText.slice(0, 60) : "";
        lines.push(
          "- Pin " +
            pinSymbol(a.pinNum) +
            " on `" +
            (a.anchor && a.anchor.tagName ? a.anchor.tagName : "?") +
            "` (" +
            path +
            ")" +
            (anchorText ? ' — text: "' + anchorText + '"' : "") +
            ": " +
            (a.note || "(no note)"),
        );
      });
      lines.push("");
    }

    if (rects.length) {
      lines.push("## Rect annotations");
      rects.forEach(function (a) {
        var path = a.anchor && a.anchor.cssPath ? a.anchor.cssPath : "(unknown)";
        var num = a.rectNum || "?";
        var filename = "rect-" + num + ".png";
        var imgRef;
        if (a.payload && a.payload.pngDataURL) {
          if (inlineImages) {
            imgRef = "![rect-" + num + "](" + a.payload.pngDataURL + ")";
          } else {
            imgRef = "![rect-" + num + "](" + assetsDirName(stamp) + "/" + filename + ")";
            assets.push({ filename: filename, dataURL: a.payload.pngDataURL });
          }
        } else {
          imgRef =
            "[screenshot unavailable" +
            (a.payload && a.payload.screenshotError ? ": " + a.payload.screenshotError : "") +
            "]";
        }
        lines.push(
          "- **Rect " +
            num +
            "** on `" +
            (a.anchor && a.anchor.tagName ? a.anchor.tagName : "?") +
            "` (" +
            path +
            "):",
        );
        lines.push("");
        lines.push("  " + (a.note || "(no note)"));
        lines.push("");
        lines.push("  " + imgRef);
        lines.push("");
      });
    }

    if (!spans.length && !pins.length && !rects.length) {
      lines.push("(no annotations)");
    }

    return { markdown: lines.join("\n"), assets: assets, stamp: stamp };
  }

  function pinSymbol(n) {
    if (!n) return "?";
    var circled = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
    if (n >= 1 && n <= circled.length) return circled[n - 1];
    return "(" + n + ")";
  }

  function assetsDirName(stamp) {
    var src = window.__MARKUP_SOURCE_NAME__ || "artifact.html";
    var stem = src.replace(/\.[^.]+$/, "");
    return stem + ".feedback-" + stamp + ".assets";
  }

  function copyTextFallback(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        if (!document.execCommand("copy")) {
          throw new Error("copy command returned false");
        }
        resolve("fallback");
      } catch (err) {
        reject(err);
      } finally {
        ta.remove();
      }
    });
  }

  function copyText(text) {
    var value = String(text == null ? "" : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(value)
        .then(function () {
          return "clipboard";
        })
        .catch(function () {
          return copyTextFallback(value);
        });
    }
    return copyTextFallback(value);
  }

  function showDiskExportToast(baseMessage, feedbackPath, copiedPath) {
    var msg = copiedPath
      ? baseMessage + " (path copied; click to copy again)"
      : baseMessage + " (click to copy path)";
    Toast.show(msg, 6000, {
      action: {
        label: "Copy feedback file path",
        onClick: function () {
          copyText(feedbackPath).then(
            function () {
              showDiskExportToast(baseMessage, feedbackPath, true);
            },
            function () {
              showDiskExportToast(baseMessage, feedbackPath, false);
            },
          );
        },
      },
    });
  }

  function exportToClipboard(sourceKey) {
    var built = buildPayload(sourceKey, { inlineImages: true });
    var size = built.markdown.length;
    if (size > 5 * 1024 * 1024) {
      Toast.show("Warning: clipboard payload > 5MB, paste may fail in some apps");
    }
    copyText(built.markdown).then(
      function (method) {
        if (method === "fallback") {
          Toast.show("Copied to clipboard (fallback)");
          return;
        }
        Toast.show("Copied " + (size / 1024).toFixed(1) + " KB to clipboard");
      },
      function (err) {
        Toast.show("Clipboard write failed: " + err.message);
      },
    );
  }

  function exportToDisk(sourceKey) {
    var built = buildPayload(sourceKey, { inlineImages: false });
    Toast.show("Writing feedback bundle to disk...");
    fetch("/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(built),
    })
      .then(function (res) {
        return res.json().then(function (j) {
          return { status: res.status, body: j };
        });
      })
      .then(function (r) {
        if (r.status === 200 && r.body && r.body.ok) {
          var feedbackPath = r.body.feedbackPath || "feedback.md";
          var msg = "Wrote " + feedbackPath;
          if (r.body.assets && r.body.assets.length) {
            msg += " + " + r.body.assets.length + " asset(s)";
          }
          copyText(feedbackPath).then(
            function () {
              showDiskExportToast(msg, feedbackPath, true);
            },
            function () {
              showDiskExportToast(msg, feedbackPath, false);
            },
          );
        } else {
          Toast.show(
            "Export failed: " + ((r.body && r.body.error) || "status " + r.status),
            4000,
          );
        }
      })
      .catch(function (err) {
        Toast.show("Export error: " + err.message, 4000);
      });
  }

  return {
    buildPayload: buildPayload,
    exportToClipboard: exportToClipboard,
    exportToDisk: exportToDisk,
  };
})();
