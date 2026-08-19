// CSS-path generator and content fingerprint for anchoring annotations.

var Fingerprint = (function () {
  // Returns a CSS selector path from document.body to the element.
  // Uses :nth-of-type to disambiguate when no id is available.
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el === document.body) return "body";
    var parts = [];
    var node = el;
    while (node && node !== document.body && node.nodeType === 1) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        // ids are unique-ish; anchor here.
        part = "#" + cssEscape(node.id);
        parts.unshift(part);
        return parts.join(" > ");
      }
      var parent = node.parentNode;
      if (parent && parent.nodeType === 1) {
        var siblings = Array.prototype.filter.call(parent.children, function (s) {
          return s.tagName === node.tagName;
        });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(node) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift("body");
    return parts.join(" > ");
  }

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
      return "\\" + c;
    });
  }

  function textHash(s) {
    var normalized = String(s).replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
    var hash = 5381;
    for (var i = 0; i < normalized.length; i++) {
      hash = (hash * 33) ^ normalized.charCodeAt(i);
    }
    return (hash >>> 0).toString(36);
  }

  function elementFingerprint(el) {
    if (!el) return null;
    var text = (el.textContent || "").slice(0, 80);
    return {
      cssPath: cssPath(el),
      tagName: el.tagName ? el.tagName.toLowerCase() : "",
      textHash: textHash(text),
      anchorText: text,
      role: el.getAttribute ? el.getAttribute("role") || null : null,
      ariaLabel: el.getAttribute ? el.getAttribute("aria-label") || null : null,
    };
  }

  function resolveByPath(cssPathStr) {
    if (!cssPathStr) return null;
    try {
      return document.querySelector(cssPathStr);
    } catch (e) {
      return null;
    }
  }

  return {
    cssPath: cssPath,
    textHash: textHash,
    elementFingerprint: elementFingerprint,
    resolveByPath: resolveByPath,
  };
})();
