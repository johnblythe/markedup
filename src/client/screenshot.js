// Drag-rect rasterization. Lazy: snapshots the page once per export session
// using modern-screenshot, then crops to rect bounds in an off-screen canvas.

var Screenshot = (function () {
  var cachedPagePng = null; // { dataURL, width, height, scrollX, scrollY }

  function clearCache() {
    cachedPagePng = null;
  }

  function snapshotPage() {
    // Hide overlay UI during snapshot so it doesn't end up in the PNG.
    var toolbar = document.getElementById("markup-toolbar");
    var popover = document.getElementById("markup-popover");
    var toast = document.getElementById("markup-toast");
    var hidden = [toolbar, popover, toast].filter(Boolean);
    hidden.forEach(function (el) {
      el.dataset._markupPrevVisibility = el.style.visibility || "";
      el.style.visibility = "hidden";
    });

    if (!window.modernScreenshot || typeof window.modernScreenshot.domToPng !== "function") {
      hidden.forEach(function (el) {
        el.style.visibility = el.dataset._markupPrevVisibility || "";
      });
      return Promise.reject(new Error("modern-screenshot not loaded"));
    }
    var scrollX = window.scrollX || 0;
    var scrollY = window.scrollY || 0;
    var width = document.documentElement.scrollWidth;
    var height = document.documentElement.scrollHeight;

    return window.modernScreenshot
      .domToPng(document.documentElement, {
        backgroundColor: "#ffffff",
        width: width,
        height: height,
        timeout: 30000,
      })
      .then(function (dataURL) {
        cachedPagePng = { dataURL: dataURL, width: width, height: height, scrollX: scrollX, scrollY: scrollY };
        return cachedPagePng;
      })
      .finally(function () {
        hidden.forEach(function (el) {
          el.style.visibility = el.dataset._markupPrevVisibility || "";
        });
      });
  }

  // rect: { x, y, w, h } in document coordinates (page-absolute, NOT viewport-relative).
  function cropFromCache(rect) {
    return new Promise(function (resolve, reject) {
      if (!cachedPagePng) {
        reject(new Error("no cached page snapshot"));
        return;
      }
      var img = new Image();
      img.onload = function () {
        var scale = img.width / cachedPagePng.width || 1;
        var sx = Math.max(0, Math.round(rect.x * scale));
        var sy = Math.max(0, Math.round(rect.y * scale));
        var sw = Math.max(1, Math.round(rect.w * scale));
        var sh = Math.max(1, Math.round(rect.h * scale));
        if (sx + sw > img.width) sw = img.width - sx;
        if (sy + sh > img.height) sh = img.height - sy;
        var canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        try {
          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = function () {
        reject(new Error("failed to load cached snapshot"));
      };
      img.src = cachedPagePng.dataURL;
    });
  }

  function captureRect(rect) {
    var p = cachedPagePng ? Promise.resolve(cachedPagePng) : snapshotPage();
    return p.then(function () {
      return cropFromCache(rect);
    });
  }

  return { captureRect: captureRect, clearCache: clearCache, snapshotPage: snapshotPage };
})();
