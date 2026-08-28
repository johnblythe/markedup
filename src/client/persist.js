// Storage driver for annotations. Two modes behind one synchronous surface:
//
//   Local (default): localStorage, exactly the original behavior.
//     Key shape: markup:annotations:<absolute-source-path>
//
//   Remote (multiplayer): in-memory cache synced over the Marked Up
//     annotations API. Activated when the wrapper injects
//     window.__MARKUP_REMOTE__ = { base, user, project, identity? }.
//     Reads are served from the cache; writes update the cache immediately
//     and sync in the background (a failed sync toasts, it never blocks the
//     UI). The server stamps author/updatedAt; clients never set author.
//
// Rect screenshots never travel inline: in remote mode the PNG uploads to the
// shots endpoint and the annotation carries shotUrl. The local data URL stays
// cached in-memory so the annotating browser keeps its thumbnail.

var Persist = (function () {
  var remote = null; // __MARKUP_REMOTE__ config once init() runs
  var cache = []; // remote working set (live annotations, server-shaped)
  var lastEtag = "";
  var selfEmail = "local@dev";
  var pollTimer = null;

  // ---- shared ---------------------------------------------------------------

  function makeId() {
    return (
      "anno-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function warnSync(err) {
    console.warn("[markup] sync failed:", err);
    if (typeof Toast !== "undefined") {
      Toast.show("Sync failed: " + (err && err.message ? err.message : "network error"), 3000);
    }
  }

  function nextNumber(list, mode, field) {
    var max = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].mode === mode && typeof list[i][field] === "number") {
        if (list[i][field] > max) max = list[i][field];
      }
    }
    return max + 1;
  }

  // ---- local driver (original behavior) --------------------------------------

  function lsKey(sourceKey) {
    return "markup:annotations:" + sourceKey;
  }

  function localLoad(sourceKey) {
    try {
      var raw = localStorage.getItem(lsKey(sourceKey));
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn("[markup] failed to load annotations:", e);
      return [];
    }
  }

  function localSaveAll(sourceKey, annotations) {
    try {
      localStorage.setItem(lsKey(sourceKey), JSON.stringify(annotations));
      return true;
    } catch (e) {
      console.warn("[markup] failed to save annotations:", e);
      return false;
    }
  }

  // ---- remote driver ----------------------------------------------------------

  function apiBase() {
    return (remote.base || "") + "/api/" + encodeURIComponent(remote.user) + "/" + encodeURIComponent(remote.project);
  }

  function apiHeaders(json) {
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    // Stub identity for local multiplayer; the real Worker uses the Access JWT.
    if (remote.identity) h["X-Markup-User"] = remote.identity;
    return h;
  }

  function cacheIndex(id) {
    for (var i = 0; i < cache.length; i++) if (cache[i].id === id) return i;
    return -1;
  }

  // Adopt a server-shaped record into the cache, keeping any local-only
  // screenshot data URL so this browser's thumbnails survive.
  function adoptRecord(record) {
    var idx = cacheIndex(record.id);
    var prev = idx === -1 ? null : cache[idx];
    if (prev && prev.payload && prev.payload.pngDataURL) {
      record.payload = record.payload || {};
      if (!record.payload.pngDataURL) record.payload.pngDataURL = prev.payload.pngDataURL;
    }
    if (idx === -1) cache.push(record);
    else cache[idx] = record;
  }

  function wireCopy(anno) {
    var body = {};
    for (var k in anno) {
      if (Object.prototype.hasOwnProperty.call(anno, k)) body[k] = anno[k];
    }
    if (body.payload && body.payload.pngDataURL) {
      var payload = {};
      for (var pk in body.payload) {
        if (pk !== "pngDataURL" && Object.prototype.hasOwnProperty.call(body.payload, pk)) {
          payload[pk] = body.payload[pk];
        }
      }
      body.payload = payload;
    }
    return body;
  }

  function dataURLToBlob(dataURL) {
    var parts = String(dataURL).split(",");
    var byteString = atob(parts[1]);
    var bytes = new Uint8Array(byteString.length);
    for (var i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  }

  function uploadShotIfNeeded(anno) {
    if (anno.mode !== "rect" || anno.shotUrl) return Promise.resolve(anno);
    var dataURL = anno.payload && anno.payload.pngDataURL;
    if (!dataURL) return Promise.resolve(anno);
    return fetch(apiBase() + "/shots/" + encodeURIComponent(anno.id), {
      method: "PUT",
      headers: (function () {
        var h = apiHeaders(false);
        h["Content-Type"] = "image/png";
        return h;
      })(),
      body: dataURLToBlob(dataURL),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("screenshot upload failed (" + res.status + ")");
        return res.json();
      })
      .then(function (body) {
        anno.shotUrl = body.shotUrl;
        return anno;
      })
      .catch(function (err) {
        // Annotation still syncs without the image.
        warnSync(err);
        return anno;
      });
  }

  function remotePut(anno) {
    return uploadShotIfNeeded(anno)
      .then(function (ready) {
        return fetch(apiBase() + "/annotations/" + encodeURIComponent(ready.id), {
          method: "PUT",
          headers: apiHeaders(true),
          body: JSON.stringify(wireCopy(ready)),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("save failed (" + res.status + ")");
        return res.json();
      })
      .then(function (saved) {
        adoptRecord(saved);
        return saved;
      })
      .catch(function (err) {
        warnSync(err);
        return null;
      });
  }

  function remoteDelete(id) {
    return fetch(apiBase() + "/annotations/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: apiHeaders(false),
    })
      .then(function (res) {
        if (!res.ok && res.status !== 404) throw new Error("delete failed (" + res.status + ")");
      })
      .catch(function (err) {
        warnSync(err);
      });
  }

  // Pull the shared set. Resolves true when the cache changed.
  function fetchAll(force) {
    var h = apiHeaders(false);
    if (lastEtag && !force) h["If-None-Match"] = lastEtag;
    return fetch(apiBase() + "/annotations", { headers: h }).then(function (res) {
      if (res.status === 304) return false;
      if (!res.ok) throw new Error("load failed (" + res.status + ")");
      return res.json().then(function (body) {
        lastEtag = body.etag || "";
        var incoming = Array.isArray(body.annotations) ? body.annotations : [];
        var byId = {};
        cache.forEach(function (a) {
          byId[a.id] = a;
        });
        cache = incoming.map(function (a) {
          var prev = byId[a.id];
          if (prev && prev.payload && prev.payload.pngDataURL) {
            a.payload = a.payload || {};
            if (!a.payload.pngDataURL) a.payload.pngDataURL = prev.payload.pngDataURL;
          }
          return a;
        });
        return true;
      });
    });
  }

  // ---- lifecycle ----------------------------------------------------------------

  // Must run before the overlay boots. Local mode: immediate. Remote mode:
  // resolves identity + first annotation fetch, then calls done().
  function init(sourceKey, done) {
    remote = window.__MARKUP_REMOTE__ || null;
    if (!remote || !remote.user || !remote.project) {
      remote = null;
      done();
      return;
    }
    var meFetch = fetch((remote.base || "") + "/api/me", { headers: apiHeaders(false) })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
    var listFetch = fetchAll(true).catch(function (err) {
      warnSync(err);
      return false;
    });
    Promise.all([meFetch, listFetch]).then(function (results) {
      if (results[0] && results[0].email) selfEmail = results[0].email;
      done();
    });
  }

  // Remote mode only: poll for other players' changes. onChange fires only
  // when the shared set actually changed (etag moved). opts.isPaused defers
  // the whole fetch — pausing BEFORE the etag advances, so a change that
  // lands mid-edit still renders on the next unpaused tick.
  function startPolling(sourceKey, onChange, opts) {
    if (!remote || pollTimer) return;
    opts = opts || {};
    pollTimer = setInterval(function () {
      if (opts.isPaused && opts.isPaused()) return;
      fetchAll(false)
        .then(function (changed) {
          if (changed) onChange();
        })
        .catch(function () {
          /* transient poll failures are silent; next tick retries */
        });
    }, opts.intervalMs || 10000);
  }

  function isRemote() {
    return !!remote;
  }

  function self() {
    return selfEmail;
  }

  // ---- public surface (original nine functions, driver-routed) -------------------

  function loadAnnotations(sourceKey) {
    if (remote) return cache.slice();
    return localLoad(sourceKey);
  }

  function saveAll(sourceKey, annotations) {
    if (!remote) return localSaveAll(sourceKey, annotations);
    // Diff against the cache and sync what changed (hydrate's status bumps).
    var byId = {};
    cache.forEach(function (a) {
      byId[a.id] = JSON.stringify(a);
    });
    annotations.forEach(function (a) {
      if (byId[a.id] !== JSON.stringify(a)) {
        var idx = cacheIndex(a.id);
        if (idx === -1) cache.push(a);
        else cache[idx] = a;
        remotePut(a);
      }
    });
    return true;
  }

  function upsertAnnotation(sourceKey, anno) {
    if (!remote) {
      var list = localLoad(sourceKey);
      var idx = list.findIndex(function (a) {
        return a.id === anno.id;
      });
      if (idx === -1) list.push(anno);
      else list[idx] = anno;
      localSaveAll(sourceKey, list);
      return anno;
    }
    var cIdx = cacheIndex(anno.id);
    if (cIdx === -1) cache.push(anno);
    else cache[cIdx] = anno;
    remotePut(anno);
    return anno;
  }

  // Deletion is irreversible on the shared canvas (the server tombstones the
  // id forever), so destructive ops are scoped to your own annotations. An
  // annotation with no author yet is a local creation still syncing — yours.
  function ownsAnnotation(anno) {
    return !anno.author || anno.author === selfEmail;
  }

  function deleteAnnotation(sourceKey, id) {
    if (!remote) {
      var list = localLoad(sourceKey).filter(function (a) {
        return a.id !== id;
      });
      localSaveAll(sourceKey, list);
      return true;
    }
    var idx = cacheIndex(id);
    if (idx !== -1 && !ownsAnnotation(cache[idx])) {
      if (typeof Toast !== "undefined") {
        Toast.show("Only " + cache[idx].author + " can remove this note", 3000);
      }
      return false;
    }
    if (idx !== -1) cache.splice(idx, 1);
    remoteDelete(id);
    return true;
  }

  function clearAll(sourceKey) {
    if (!remote) {
      localSaveAll(sourceKey, []);
      return;
    }
    var mine = [];
    var theirs = [];
    cache.forEach(function (a) {
      (ownsAnnotation(a) ? mine : theirs).push(a);
    });
    cache = theirs;
    mine.forEach(function (a) {
      remoteDelete(a.id);
    });
    if (theirs.length && typeof Toast !== "undefined") {
      Toast.show("Cleared your annotations; " + theirs.length + " from others kept", 3000);
    }
  }

  function nextPinNumber(sourceKey) {
    return nextNumber(loadAnnotations(sourceKey), "pin", "pinNum");
  }

  function nextRectNumber(sourceKey) {
    return nextNumber(loadAnnotations(sourceKey), "rect", "rectNum");
  }

  // Source-hash stash: per-source last-known content hash. Used to detect
  // "source changed since last review" so existing open annotations can be
  // bumped to pending state for triage. Local mode only — in remote mode the
  // server's copy is shared, so per-browser triage would fight across players.
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
    init: init,
    startPolling: startPolling,
    isRemote: isRemote,
    self: self,
  };
})();
