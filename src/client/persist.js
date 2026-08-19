// localStorage adapter for annotations.
// Key shape: markup:annotations:<absolute-source-path>
// Value: JSON array of annotation objects.

var Persist = (function () {
  function keyFor(sourceKey) {
    return "markup:annotations:" + sourceKey;
  }

  function loadAnnotations(sourceKey) {
    try {
      var raw = localStorage.getItem(keyFor(sourceKey));
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn("[markup] failed to load annotations:", e);
      return [];
    }
  }

  function saveAll(sourceKey, annotations) {
    try {
      localStorage.setItem(keyFor(sourceKey), JSON.stringify(annotations));
      return true;
    } catch (e) {
      console.warn("[markup] failed to save annotations:", e);
      return false;
    }
  }

  function upsertAnnotation(sourceKey, anno) {
    var list = loadAnnotations(sourceKey);
    var idx = list.findIndex(function (a) {
      return a.id === anno.id;
    });
    if (idx === -1) list.push(anno);
    else list[idx] = anno;
    saveAll(sourceKey, list);
    return anno;
  }

  function deleteAnnotation(sourceKey, id) {
    var list = loadAnnotations(sourceKey).filter(function (a) {
      return a.id !== id;
    });
    saveAll(sourceKey, list);
  }

  function clearAll(sourceKey) {
    saveAll(sourceKey, []);
  }

  function nextPinNumber(sourceKey) {
    var list = loadAnnotations(sourceKey);
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].mode === "pin" && typeof list[i].pinNum === "number") {
        if (list[i].pinNum > max) max = list[i].pinNum;
      }
    }
    return max + 1;
  }

  function nextRectNumber(sourceKey) {
    var list = loadAnnotations(sourceKey);
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].mode === "rect" && typeof list[i].rectNum === "number") {
        if (list[i].rectNum > max) max = list[i].rectNum;
      }
    }
    return max + 1;
  }

  function makeId() {
    return (
      "anno-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // Source-hash stash: per-source last-known content hash. Used to detect
  // "source changed since last review" so existing open annotations can be
  // bumped to pending state for triage.
  function hashKey(sourceKey) {
    return "markup:source-hash:" + sourceKey;
  }
  function getLastHash(sourceKey) {
    try {
      return localStorage.getItem(hashKey(sourceKey)) || "";
    } catch (_e) {
      return "";
    }
  }
  function setLastHash(sourceKey, hash) {
    try {
      localStorage.setItem(hashKey(sourceKey), hash || "");
    } catch (_e) {
      /* noop */
    }
  }

  return {
    loadAnnotations: loadAnnotations,
    saveAll: saveAll,
    upsertAnnotation: upsertAnnotation,
    deleteAnnotation: deleteAnnotation,
    clearAll: clearAll,
    nextPinNumber: nextPinNumber,
    nextRectNumber: nextRectNumber,
    makeId: makeId,
    getLastHash: getLastHash,
    setLastHash: setLastHash,
  };
})();
